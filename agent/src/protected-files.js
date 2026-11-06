import nodeFs from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { LocalStateError } from "./config.js";

const unsafe = () => new LocalStateError("insecure_permissions", "thin home requires private regular files and directories");
export function privateStat(path, { fs = nodeFs, directory = false, optional = false } = {}) {
  let st;
  try { st = fs.lstatSync(path); }
  catch (e) { if (optional && e.code === "ENOENT") return null; throw e; }
  if (st.isSymbolicLink() || (directory ? !st.isDirectory() : !st.isFile() || st.nlink !== 1)
    || (directory ? (st.mode & 0o7777) !== 0o700 : ![0o400, 0o600].includes(st.mode & 0o7777))
    || (process.getuid && st.uid !== process.getuid())) throw unsafe();
  return st;
}

export function syncDirectory(path, { fs = nodeFs } = {}) {
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

export function privateDirectory(path, { fs = nodeFs } = {}) {
  privateStat(dirname(path), { fs, directory: true });
  if (!privateStat(path, { fs, directory: true, optional: true })) {
    fs.mkdirSync(path, { mode: 0o700 });
    fs.chmodSync(path, 0o700);
  }
  privateStat(path, { fs, directory: true });
  syncDirectory(path, { fs });
  syncDirectory(dirname(path), { fs });
  return path;
}

export function readPrivateFile(path, { fs = nodeFs, optional = false } = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    privateStat(dirname(path), { fs, directory: true });
    const st = privateStat(path, { fs, optional });
    if (!st) return null;
    const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const opened = fs.fstatSync(fd);
      if (st.ino !== opened.ino || st.dev !== opened.dev || opened.nlink === 0) {
        privateStat(path, { fs, optional: true });
        continue;
      }
      if (!opened.isFile() || opened.nlink !== 1 || ![0o400, 0o600].includes(opened.mode & 0o7777)
        || (process.getuid && opened.uid !== process.getuid())) throw unsafe();
      return fs.readFileSync(fd);
    } finally { fs.closeSync(fd); }
  }
  throw new LocalStateError("home_locked", "thin file changed during read");
}

export function syncPrivateFile(path, { fs = nodeFs } = {}) {
  privateStat(dirname(path), { fs, directory: true });
  const st = privateStat(path, { fs });
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (st.ino !== opened.ino || st.dev !== opened.dev || opened.nlink !== 1) throw unsafe();
    fs.fsyncSync(fd);
    syncDirectory(dirname(path), { fs });
  } finally { fs.closeSync(fd); }
}

export function parsePrivateJson(bytes) {
  try {
    const doc = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error();
    return doc;
  } catch { throw new LocalStateError("corrupt_state", "invalid thin file state"); }
}

export function writeAll(fd, bytes, { fs = nodeFs } = {}) {
  const data = Buffer.from(bytes);
  for (let offset = 0; offset < data.length;) {
    const written = fs.writeSync(fd, data, offset, data.length - offset);
    if (!(written > 0)) throw new LocalStateError("invalid_state", "thin file write made no progress");
    offset += written;
  }
}

export function atomicPrivateWrite(path, bytes, { fs = nodeFs } = {}) {
  privateStat(dirname(path), { fs, directory: true });
  privateStat(path, { fs, optional: true });
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`);
  let fd;
  try {
    fd = fs.openSync(tmp, "wx", 0o600);
    fs.fchmodSync(fd, 0o600);
    writeAll(fd, bytes, { fs }); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    privateStat(path, { fs, optional: true });
    fs.renameSync(tmp, path);
    syncDirectory(dirname(path), { fs });
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(tmp); } catch (e) { if (e.code !== "ENOENT") throw e; }
  }
}

export function removePrivateFile(path, { fs = nodeFs } = {}) {
  privateStat(dirname(path), { fs, directory: true });
  const exists = !!privateStat(path, { fs, optional: true });
  if (exists) fs.unlinkSync(path);
  syncDirectory(dirname(path), { fs });
  return exists;
}

export function acquireHomeLock(home, name, { fs = nodeFs } = {}) {
  if (!["state", "receiver"].includes(name)) throw new LocalStateError("invalid_input", "unknown home lock");
  privateStat(home, { fs, directory: true });
  const path = join(home, `.${name}.lock`);
  const owner = `${process.pid}-${randomBytes(12).toString("hex")}.json`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { fs.mkdirSync(path, { mode: 0o700 }); fs.chmodSync(path, 0o700); }
    catch (e) {
      if (e.code !== "EEXIST") throw e;
      let files;
      try { privateStat(path, { fs, directory: true }); files = fs.readdirSync(path); }
      catch (race) { if (race.code === "ENOENT") continue; throw race; }
      if (files.length !== 1 || !/^[1-9]\d*-[a-f0-9]{24}\.json$/.test(files[0])) throw new LocalStateError("home_locked", "home lock needs operator recovery");
      let old;
      try { old = parsePrivateJson(readPrivateFile(join(path, files[0]), { fs })); }
      catch (race) { if (race.code === "ENOENT") continue; throw race; }
      if (!Number.isSafeInteger(old.pid) || old.pid <= 0) throw new LocalStateError("home_locked", "invalid home lock owner");
      try { process.kill(old.pid, 0); }
      catch (error) {
        if (error.code !== "ESRCH") throw new LocalStateError("home_locked", "home lock is held");
        try { fs.unlinkSync(join(path, files[0])); fs.rmdirSync(path); }
        catch (race) { if (!["ENOENT", "ENOTEMPTY"].includes(race.code)) throw race; }
        continue;
      }
      throw new LocalStateError("home_locked", "home lock is held");
    }
    try { atomicPrivateWrite(join(path, owner), JSON.stringify({ pid: process.pid }), { fs }); syncDirectory(home, { fs }); }
    catch (e) { try { removePrivateFile(join(path, owner), { fs }); fs.rmdirSync(path); } catch {} throw e; }
    let released = false;
    return { release() {
      if (!released) {
        privateStat(join(path, owner), { fs });
        fs.unlinkSync(join(path, owner)); fs.rmdirSync(path); released = true;
      }
      syncDirectory(home, { fs });
    } };
  }
  throw new LocalStateError("home_locked", "home lock is held");
}

export function withHomeLock(home, fn, options = {}) {
  const lock = acquireHomeLock(home, "state", options);
  try {
    const result = fn();
    if (result && typeof result.then === "function") throw new LocalStateError("tx_async", "home mutation must be synchronous");
    return result;
  } finally { lock.release(); }
}
