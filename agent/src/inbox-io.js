import nodeFs from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join, dirname, basename } from "node:path";
import { LocalStateError } from "./config.js";
import { atomicPrivateWrite, parsePrivateJson, privateDirectory, privateStat, readPrivateFile, syncDirectory, writeAll } from "./protected-files.js";

export const INBOX_CHUNK_BYTES = 64 * 1024;
const INBOX_BLOCK_RECORDS = 128;
const INBOX_LINE_BYTES = 9 * 1024 * 1024;
export const scanLimit = () => new LocalStateError("inbox_scan_limit", "inbox page exceeds scan budget");
const corrupt = () => new LocalStateError("corrupt_state", "invalid inbox seek metadata");
export const indexPath = (home, name) => join(home, ".inbox-index", name + ".json");
function openInboxFile(path, { fs = nodeFs } = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    privateStat(dirname(path), { fs, directory: true });
    const st = privateStat(path, { fs });
    const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const opened = fs.fstatSync(fd);
      if (st.ino !== opened.ino || st.dev !== opened.dev || opened.nlink === 0) { fs.closeSync(fd); continue; }
      if (opened.nlink !== 1 || !opened.isFile() || ![0o400, 0o600].includes(opened.mode & 0o7777)
        || (process.getuid && opened.uid !== process.getuid())) throw new LocalStateError("insecure_permissions", "inbox requires private regular files");
      return { fd, stat: opened };
    } catch (e) { fs.closeSync(fd); throw e; }
  }
  throw new LocalStateError("home_locked", "inbox file changed during open");
}

export function* rawLines(path, { fs = nodeFs, start = 0, end = Infinity, budget, expected } = {}) {
  const { fd, stat } = openInboxFile(path, { fs });
  if (expected && (stat.ino !== expected.ino || stat.dev !== expected.dev)) {
    fs.closeSync(fd); throw new LocalStateError("home_locked", "inbox snapshot changed");
  }
  end = Math.min(end, stat.size);
  let position = start, offset = start, pending = Buffer.alloc(0);
  try {
    while (position < end) {
      if (budget && budget.bytes <= 0) throw scanLimit();
      const bytes = Buffer.allocUnsafe(Math.min(INBOX_CHUNK_BYTES, end - position, budget?.bytes ?? Infinity));
      const count = fs.readSync(fd, bytes, 0, bytes.length, position);
      if (!count) break;
      if (budget) budget.bytes -= count;
      position += count;
      const data = pending.length ? Buffer.concat([pending, bytes.subarray(0, count)]) : bytes.subarray(0, count);
      let from = 0, to;
      while ((to = data.indexOf(10, from)) !== -1) {
        const raw = data.subarray(from, to + 1);
        if (raw.length > INBOX_LINE_BYTES) throw corrupt();
        yield { raw, offset, end: offset + raw.length };
        offset += raw.length; from = to + 1;
      }
      pending = Buffer.from(data.subarray(from));
      if (pending.length > INBOX_LINE_BYTES) throw corrupt();
    }
  } finally { fs.closeSync(fd); }
}

export const signature = st => ({ ino: st.ino, dev: st.dev, size: st.size, mtime: st.mtimeMs, ctime: st.ctimeMs });
export const sameSignature = (file, st) => !!file && Object.entries(signature(st)).every(([k, v]) => file[k] === v);
export function saveIndex(home, name, index, options) {
  privateDirectory(join(home, ".inbox-index"), options);
  atomicPrivateWrite(indexPath(home, name), JSON.stringify(index) + "\n", options);
}
const EDGE_BYTES = 4096;
const edgeRanges = (start, end) => end - start <= 2 * EDGE_BYTES ? [[start, end]] : [[start, start + EDGE_BYTES], [end - EDGE_BYTES, end]];
const lineHash = raw => {
  const hash = createHash("sha256");
  for (const [from, to] of edgeRanges(0, raw.length)) hash.update(raw.subarray(from, to));
  return hash.digest("hex").slice(0, 32);
};
const validEdge = (edge, key, inRange) => !!edge && typeof edge === "object" && typeof edge.hash === "string" && /^[0-9a-f]{32}$/.test(edge.hash)
  && Number.isSafeInteger(edge[key]) && edge[key] >= 0 && inRange(edge[key]);
function validIndex(index) {
  const integer = n => Number.isSafeInteger(n) && n >= 0;
  return index.version === 2 && index.file && integer(index.file.ino) && integer(index.file.dev) && integer(index.file.size)
    && index.file.size >= index.end && [index.file.mtime, index.file.ctime].every(n => n === null || Number.isFinite(n)) && integer(index.end)
    && (index.head === undefined || validEdge(index.head, "end", n => n > 0 && n <= index.end))
    && (index.tail === undefined || validEdge(index.tail, "start", n => n < index.end)) && (Number.isSafeInteger(index.legacy) && index.legacy >= -1) && Array.isArray(index.blocks)
    && index.blocks.every((b, i, all) => [b.start, b.end, b.first, b.last, b.minSeq, b.maxSeq, b.count].every(integer)
      && b.count > 0 && b.count <= INBOX_BLOCK_RECORDS && b.end > b.start && (b.count === 1 || b.end - b.start <= INBOX_CHUNK_BYTES) && b.last >= b.first && b.maxSeq >= b.minSeq
      && b.start === (i ? all[i - 1].end : 0) && (!i || b.first > all[i - 1].last))
    && index.end === (index.blocks.at(-1)?.end ?? 0);
}
export function addIndexRecord(index, line) {
  const r = line.record, cursor = r.cursor ?? r.seq;
  let block = index.blocks.at(-1);
  if (block && cursor <= block.last) throw corrupt();
  if (!block || block.count === INBOX_BLOCK_RECORDS || line.end - block.start > INBOX_CHUNK_BYTES) {
    block = { start: line.offset, end: line.end, first: cursor, last: cursor, minSeq: r.seq, maxSeq: r.seq, count: 0 };
    index.blocks.push(block);
  }
  block.end = line.end; block.last = cursor; block.count++;
  if (line.offset === 0) index.head = { end: line.end, hash: lineHash(line.raw) };
  index.tail = { start: line.offset, hash: lineHash(line.raw) };
  block.minSeq = Math.min(block.minSeq, r.seq); block.maxSeq = Math.max(block.maxSeq, r.seq);
  index.end = line.end;
  if (r.msg_id === undefined) index.legacy = Math.max(index.legacy, cursor);
}

export function fileIndex(home, name, decode, { fs = nodeFs, snapshot = false, stat, lazy = false, budget } = {}) {
  const path = join(home, "inbox", name), st = stat ?? privateStat(path, { fs });
  const saved = privateStat(join(home, ".inbox-index"), { fs, directory: true, optional: true })
    ? readPrivateFile(indexPath(home, name), { fs, optional: true }) : null;
  let index = saved ? parsePrivateJson(saved) : null;
  if (index?.version === 1) index = null;
  if (index && !validIndex(index)) throw corrupt();
  const sameFile = index?.file?.ino === st.ino && index.file.dev === st.dev;
  const unchanged = sameFile && sameSignature(index.file, st);
  if (unchanged && index.end <= st.size && (lazy || !index.pending)) return index;
  const fresh = () => ({ version: 2, end: 0, legacy: -1, blocks: [] });
  if (!sameFile || index.end > st.size || (!unchanged && (index.file.size === st.size || !indexedLinesIntact(path, index, st, fs, budget)))) index = fresh();
  index.file = signature(st); index.pending = true;
  if (lazy) return index;
  const resumed = index.end > 0;
  try { for (const _ of extendIndex(home, name, index, decode, { fs, snapshot })) {} }
  catch (error) {
    // Some filesystems hand a replaced file's inode to its successor at once, so a resumed scan can land mid-line.
    if (!resumed || !["corrupt_state", "home_locked"].includes(error.code)) throw error;
    index = fresh(); index.file = signature(privateStat(path, { fs })); index.pending = true;
    for (const _ of extendIndex(home, name, index, decode, { fs, snapshot })) {}
  }
  return index;
}

function indexedLinesIntact(path, index, st, fs, budget) {
  if (index.end === 0) return true;
  if (!index.head || !index.tail) return false;
  const { fd, stat } = openInboxFile(path, { fs });
  try {
    if (stat.ino !== st.ino || stat.dev !== st.dev || stat.size < index.end) return false;
    const hashOf = (start, end) => {
      const hash = createHash("sha256"), bytes = Buffer.allocUnsafe(2 * EDGE_BYTES);
      for (const [from, to] of edgeRanges(start, end)) for (let position = from; position < to;) {
        if (budget && budget.bytes <= 0) throw scanLimit();
        const count = fs.readSync(fd, bytes, 0, Math.min(bytes.length, to - position, budget?.bytes ?? Infinity), position);
        if (!count) return null;
        if (budget) budget.bytes -= count;
        hash.update(bytes.subarray(0, count)); position += count;
      }
      return hash.digest("hex").slice(0, 32);
    };
    return hashOf(0, index.head.end) === index.head.hash && hashOf(index.tail.start, index.end) === index.tail.hash;
  } finally { fs.closeSync(fd); }
}

function seekCursor(path, name, index, decode, afterSeq, fs, budget) {
  let low = index.end, high = index.file.size;
  while (high - low > INBOX_CHUNK_BYTES) {
    const mid = Math.floor((low + high) / 2);
    let partial = true, found = false;
    for (const line of rawLines(path, { fs, start: mid, end: index.file.size, expected: index.file, budget })) {
      if (partial) { partial = false; continue; }
      if (budget && --budget.records < 0) throw scanLimit();
      const r = decode(line.raw, name);
      if ((r.cursor ?? r.seq) <= afterSeq) low = line.end; else high = mid;
      found = true; break;
    }
    if (!found) high = mid;
  }
  return low;
}
export function* extendIndex(home, name, index, decode, { fs = nodeFs, snapshot = false, budget, afterSeq = -1 } = {}) {
  const path = join(home, "inbox", name), originalEnd = index.end;
  try {
    const start = afterSeq > (index.blocks.at(-1)?.last ?? -1) ? seekCursor(path, name, index, decode, afterSeq, fs, budget) : index.end;
    for (const line of rawLines(path, { fs, start, end: index.file.size, expected: index.file, budget })) {
      if (budget && --budget.records < 0) throw scanLimit();
      if (snapshot && privateStat(path, { fs }).size < index.file.size) { delete index.pending; return; }
      const record = decode(line.raw, name);
      if (line.offset === index.end) {
        addIndexRecord(index, { ...line, record });
        if (!snapshot && index.blocks.at(-1).start === line.offset) saveIndex(home, name, index, { fs });
        if (index.end === index.file.size) delete index.pending;
      }
      yield { ...line, name, record };
    }
    if (start === originalEnd) delete index.pending;
  } catch (error) {
    const current = privateStat(path, { fs, optional: snapshot });
    if (error.code === "inbox_scan_limit" || !snapshot || !current || sameSignature(index.file, current)) throw error;
    if (error.code === "corrupt_state") throw new LocalStateError("home_locked", "inbox snapshot changed");
    delete index.pending;
  } finally {
    if (!snapshot) {
      const current = privateStat(path, { fs });
      if (sameSignature(index.file, current)) saveIndex(home, name, index, { fs });
    }
  }
}

export function replacedSince(path, verified, file, { fs = nodeFs } = {}) {
  try {
    const current = privateStat(path, { fs, optional: true });
    return !!current && !sameSignature(file, current) && !indexedLinesIntact(path, verified, current, fs);
  } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

export function changedDuringRead(error, path, file, { fs = nodeFs } = {}) {
  if (error?.code !== "corrupt_state") return error;
  let current;
  try { current = privateStat(path, { fs, optional: true }); } catch { return error; }
  return current && sameSignature(file, current) ? error : new LocalStateError("home_locked", "inbox snapshot changed");
}

export function replaceInboxFile(path, produce, { fs = nodeFs, prefixBytes } = {}) {
  privateStat(path, { fs });
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`);
  let fd;
  try {
    if (prefixBytes === undefined) fd = fs.openSync(tmp, "wx", 0o600);
    else {
      fs.copyFileSync(path, tmp, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
      privateStat(tmp, { fs });
      fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW);
      fs.ftruncateSync(fd, prefixBytes);
    }
    fs.fchmodSync(fd, 0o600);
    produce(bytes => writeAll(fd, bytes, { fs }));
    fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    privateStat(path, { fs }); fs.renameSync(tmp, path); syncDirectory(dirname(path), { fs });
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(tmp); } catch (e) { if (e.code !== "ENOENT") throw e; }
  }
}
