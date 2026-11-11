import nodeFs from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { LocalStateError } from "./config.js";
import { processIdentity as nodeProcessIdentity } from "./process-identity.js";

const unsafe = () => new LocalStateError("insecure_permissions", "thin home requires private regular files and directories");
export function privateStat(path, { fs = nodeFs, directory = false, optional = false } = {}) {
  let st;
  try { st = fs.lstatSync(path); }
  catch (e) { if (optional && e.code === "ENOENT") return null; throw e; }
  if (!directory && st.isFile() && st.nlink === 0) {
    if (optional) return null;
    throw Object.assign(new Error("private file no longer exists"), { code: "ENOENT", unlinked: true });
  }
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

function readPrivateSnapshot(path, { fs = nodeFs, optional = false } = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    privateStat(dirname(path), { fs, directory: true });
    let st;
    try { st = privateStat(path, { fs }); }
    catch (error) {
      // lstat can return the inode an atomic rename just replaced; the name still resolves, so it is not absent.
      if (error.unlinked) continue;
      if (optional && error.code === "ENOENT") return null;
      throw error;
    }
    const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const opened = fs.fstatSync(fd);
      if (st.ino !== opened.ino || st.dev !== opened.dev || opened.nlink === 0) {
        privateStat(path, { fs, optional: true });
        continue;
      }
      if (!opened.isFile() || opened.nlink !== 1 || ![0o400, 0o600].includes(opened.mode & 0o7777)
        || (process.getuid && opened.uid !== process.getuid())) throw unsafe();
      return { bytes: fs.readFileSync(fd), stat: opened };
    } finally { fs.closeSync(fd); }
  }
  throw new LocalStateError("home_locked", "thin file changed during read");
}

export function readPrivateFile(path, options = {}) {
  return readPrivateSnapshot(path, options)?.bytes ?? null;
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

export function openPrivateAppend(path, { fs = nodeFs, maxBytes = Infinity } = {}) {
  privateStat(dirname(path), { fs, directory: true });
  const prior = privateStat(path, { fs, optional: true });
  const fd = fs.openSync(path, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW, 0o600);
  try {
    if (!prior) fs.fchmodSync(fd, 0o600);
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || (opened.mode & 0o7777) !== 0o600
      || (process.getuid && opened.uid !== process.getuid())
      || (prior && (prior.ino !== opened.ino || prior.dev !== opened.dev))) throw unsafe();
    if (opened.size > maxBytes) fs.ftruncateSync(fd, 0);
    return fd;
  } catch (error) { fs.closeSync(fd); throw error; }
}

function lockOwner(path, { fs = nodeFs } = {}) {
  privateStat(path, { fs, directory: true });
  const files = fs.readdirSync(path);
  if (files.length !== 1 || !/^[1-9]\d*-[a-f0-9]{24}\.json$/.test(files[0])) throw new LocalStateError("home_locked", "home lock needs operator recovery");
  const file = join(path, files[0]);
  const snapshot = readPrivateSnapshot(file, { fs });
  const old = parsePrivateJson(snapshot.bytes);
  if (!Number.isSafeInteger(old.pid) || old.pid <= 0) throw new LocalStateError("home_locked", "invalid home lock owner");
  return { ...old, file, mtimeMs: snapshot.stat.mtimeMs,
    snapshotKey: JSON.stringify([file, snapshot.stat.dev, snapshot.stat.ino, snapshot.stat.mtimeMs, snapshot.stat.ctimeMs, snapshot.bytes.toString("base64")]),
  };
}

function lockIdentity(pid, processIdentity) {
  let identity;
  try { identity = processIdentity(pid); } catch {}
  const time = value => Number.isFinite(value) && value >= 0 ? value : undefined;
  return {
    bootId: typeof identity?.bootId === "string" && identity.bootId.length ? identity.bootId : undefined,
    startTime: time(identity?.startTime), startedAtMs: time(identity?.startedAtMs),
    startTimeSource: ["linux-proc", "macos-ps"].includes(identity?.startTimeSource) ? identity.startTimeSource : undefined,
  };
}

// Cache only held decisions: PID reuse may delay recovery, never evict a live owner.
const heldOwners = new WeakMap();

function staleOwner(owner, { processIdentity, kill, now }) {
  let held = heldOwners.get(processIdentity);
  const path = dirname(owner.file);
  try { kill(owner.pid, 0); }
  catch (error) {
    if (["ESRCH", "EPERM"].includes(error.code)) { held?.delete(path); return true; }
  }
  const cached = held?.get(path), at = Number(now());
  if (cached?.snapshotKey === owner.snapshotKey && at >= cached.checkedAt && at - cached.checkedAt < 5000) return false;
  const current = lockIdentity(owner.pid, processIdentity);
  if (typeof owner.bootId === "string" && owner.bootId.length && current.bootId && owner.bootId !== current.bootId) return true;
  const comparable = Number.isFinite(owner.startTime) && owner.startTime >= 0 && current.startTime !== undefined
    && (!owner.startTimeSource || !current.startTimeSource || owner.startTimeSource === current.startTimeSource);
  if (comparable) {
    const tolerance = (current.startTimeSource ?? owner.startTimeSource) === "macos-ps" ? 1000 : 0;
    if (Math.abs(owner.startTime - current.startTime) > tolerance) return true;
  }
  const matching = comparable && owner.bootId === current.bootId && !!current.bootId;
  const sourceConflict = owner.startTimeSource && current.startTimeSource && owner.startTimeSource !== current.startTimeSource;
  if (!matching && !sourceConflict && current.startTimeSource === "macos-ps"
    && current.startedAtMs !== undefined && current.startedAtMs > owner.mtimeMs + 2000) return true;
  if (!held) heldOwners.set(processIdentity, held = new Map());
  held.set(path, { snapshotKey: owner.snapshotKey, checkedAt: at });
  return false;
}

export function receiverLockHeld(home, { fs = nodeFs, processIdentity = nodeProcessIdentity, kill = process.kill, now = Date.now } = {}) {
  try {
    privateStat(home, { fs, directory: true });
    const owner = lockOwner(join(home, ".receiver.lock"), { fs });
    return owner.role !== "once" && !staleOwner(owner, { processIdentity, kill, now });
  } catch (error) { return error.code !== "ENOENT"; }
}

export function acquireHomeLock(home, name, { fs = nodeFs, role = name, processIdentity = nodeProcessIdentity, kill = process.kill, now = Date.now } = {}) {
  if (!["state", "receiver"].includes(name)) throw new LocalStateError("invalid_input", "unknown home lock");
  privateStat(home, { fs, directory: true });
  const path = join(home, `.${name}.lock`);
  const owner = `${process.pid}-${randomBytes(12).toString("hex")}.json`;
  const { bootId, startTime, startTimeSource } = lockIdentity(process.pid, processIdentity);
  for (let attempt = 0; attempt < 3; attempt++) {
    try { fs.mkdirSync(path, { mode: 0o700 }); fs.chmodSync(path, 0o700); }
    catch (e) {
      if (e.code !== "EEXIST") throw e;
      let old;
      try { old = lockOwner(path, { fs }); }
      catch (race) { if (race.code === "ENOENT") continue; throw race; }
      if (staleOwner(old, { processIdentity, kill, now })) {
        try { fs.unlinkSync(old.file); fs.rmdirSync(path); }
        catch (race) { if (!["ENOENT", "ENOTEMPTY"].includes(race.code)) throw race; }
        continue;
      }
      throw new LocalStateError("home_locked", "home lock is held");
    }
    try {
      atomicPrivateWrite(join(path, owner), JSON.stringify({ pid: process.pid, role, bootId, startTime, startTimeSource }), { fs });
      syncDirectory(home, { fs });
    }
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
