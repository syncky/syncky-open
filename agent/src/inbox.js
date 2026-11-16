import nodeFs from "node:fs";
import { join } from "node:path";
import { addIndexRecord, changedDuringRead, extendIndex, fileIndex, indexPath, rawLines, replacedSince, replaceInboxFile, sameSignature, saveIndex, scanLimit, signature } from "./inbox-io.js";
import { LocalStateError } from "./config.js";
import { isB64u } from "./encoding.js";
import { isMemberId, isUuidV7 } from "./ids.js";
import { atomicPrivateWrite, parsePrivateJson, privateDirectory, privateStat, readPrivateFile, removePrivateFile, syncDirectory, syncPrivateFile, withHomeLock, writeAll } from "./protected-files.js";

export const INBOX_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const INBOX_SEEN_RETENTION_MS = 31 * 24 * 60 * 60 * 1000;
export const INBOX_SEEN_CLOCK_SKEW_MS = 5 * 60 * 1000;
export const INBOX_SEEN_MAX_IDS = 10000;
export const INBOX_SEEN_PROTECTED_MS = (24 * 60 + 10) * 60 * 1000;
export const INBOX_SEEN_MAX_RECENT_IDS = 90000;
const REWRITE_PENDING = ".rewrite-pending";
const corrupt = () => new LocalStateError("corrupt_state", "invalid thin inbox record");
function metadata(record) {
  if (!Number.isSafeInteger(record.seq) || record.seq < 0 || !isMemberId(record.from)
    || (record.cursor !== undefined && (!Number.isSafeInteger(record.cursor) || record.cursor < 0))
    || (record.msg_id !== undefined && (!isUuidV7(record.msg_id) || !isB64u(record.public_key, { length: 32 })
      || !Number.isSafeInteger(record.accepted_at) || record.accepted_at < 0))
    || !["data", "control"].includes(record.kind) || typeof record.type !== "string"
    || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(record.received_at) || !Number.isFinite(Date.parse(record.received_at))
    || new Date(record.received_at).toISOString() !== record.received_at.replace(/(?<!\.\d{3})Z$/, ".000Z")) throw corrupt();
  return record;
}

export function inboxCursor(home, options = {}) {
  const saved = readPrivateFile(join(home, ".inbox-cursor.json"), { ...options, optional: true });
  const cursor = saved ? parsePrivateJson(saved).cursor : -1;
  if (!Number.isSafeInteger(cursor) || cursor < -1) throw corrupt();
  return cursor;
}

export const INBOX_PAGE_BUDGET = Object.freeze({ bytes: 64 * 1024 * 1024, records: 10000 });
function decode(raw, name) {
  const record = metadata(parsePrivateJson(raw));
  if ((record.msg_id !== undefined && record.cursor === undefined) || record.received_at.slice(0, 10) !== name.slice(0, 10)
    || !record.inner || typeof record.inner !== "object" || Array.isArray(record.inner) || record.inner.type !== record.type) throw corrupt();
  return record;
}
function files(home, { fs = nodeFs, snapshot = false } = {}) {
  const dir = join(home, "inbox");
  privateStat(home, { fs, directory: true });
  if (!privateStat(dir, { fs, directory: true, optional: true })) return [];
  const pending = join(dir, REWRITE_PENDING);
  if (!snapshot && privateStat(pending, { fs, optional: true })) { syncDirectory(dir, { fs }); removePrivateFile(pending, { fs }); }
  return fs.readdirSync(dir).filter(name => {
    if (name.startsWith(".")) return false;
    if (!/^\d{4}-\d\d-\d\d\.jsonl$/.test(name)) throw corrupt();
    return true;
  }).sort();
}
export function inboxMetadata(home, options = {}) {
  const out = [];
  for (const name of files(home, options)) {
    try { out.push({ name, index: fileIndex(home, name, decode, options) }); }
    catch (error) { if (!options.snapshot || error.code !== "ENOENT") throw error; }
  }
  return out;
}
export function createInboxAdmission({ legacy = false } = {}) {
  return { indexes: null, legacyOrder: legacy, high: -1, legacy: -1, searched: false };
}
function collectAdmissionIndexes(home, view, names, stats, { fs = nodeFs } = {}) {
  const indexes = new Map();
  let high = -1, legacy = -1;
  for (const name of names) {
    const stat = stats.get(name) ?? privateStat(join(home, "inbox", name), { fs });
    const prior = view.indexes?.get(name);
    const index = sameSignature(prior?.file, stat) ? prior : fileIndex(home, name, decode, { fs, stat });
    indexes.set(name, index);
    high = Math.max(high, index.blocks.at(-1)?.last ?? -1);
    legacy = Math.max(legacy, index.legacy);
  }
  view.indexes = indexes; view.legacyOrder = false; view.high = high; view.legacy = legacy; view.searched = false;
}
export function refreshInboxAdmission(home, view, { fs = nodeFs, sequential = view.legacyOrder, target } = {}) {
  if (target) {
    if (target.stat) view.indexes.set(target.name, fileIndex(home, target.name, decode, { fs }));
    else view.indexes.delete(target.name);
  }
  const names = files(home, { fs }), stats = new Map();
  if (!sequential) for (const name of names) stats.set(name, privateStat(join(home, "inbox", name), { fs }));
  if (view.indexes && !target) {
    let unchanged = names.length === view.indexes.size;
    for (const name of names) {
      const stat = stats.get(name) ?? privateStat(join(home, "inbox", name), { fs });
      stats.set(name, stat);
      if (!sameSignature(view.indexes.get(name)?.file, stat)) { unchanged = false; break; }
    }
    if (unchanged) return;
  }
  collectAdmissionIndexes(home, view, names, stats, { fs });
}
export function admissionInboxSequence(home, record, { view, ...options }) {
  const refreshed = view.searched;
  if (refreshed) refreshInboxAdmission(home, view, options);
  if (!view.searched) {
    view.match = findInboxSequence(home, record, { ...options, view, refresh: !refreshed });
    view.searched = true;
  }
  return checkInboxSequence(record, view.match ? [view.match] : []);
}
function* fileLines(home, name, index, options = {}) {
  const file = index.file;
  try { yield* indexedFileLines(home, name, index, options); }
  catch (error) { throw changedDuringRead(error, join(home, "inbox", name), file, options); }
}
function* indexedFileLines(home, name, index, { fs = nodeFs, afterSeq = -1, seq, budget, snapshot = false } = {}) {
  for (const block of index.blocks) {
    if (block.last <= afterSeq || (seq !== undefined && (seq < block.minSeq || seq > block.maxSeq))) continue;
    for (const line of rawLines(join(home, "inbox", name), { fs, start: block.start, end: block.end, budget, expected: index.file })) {
      if (budget && --budget.records < 0) throw scanLimit();
      const record = decode(line.raw, name);
      if ((record.cursor ?? record.seq) > afterSeq && (seq === undefined || record.seq === seq)) yield { ...line, name, record };
    }
  }
  if (index.pending) for (const line of extendIndex(home, name, index, decode, { fs, budget, snapshot, afterSeq })) {
    if ((line.record.cursor ?? line.record.seq) > afterSeq && (seq === undefined || line.record.seq === seq)) yield line;
  }
}
export function* iterateInbox(home, { fs = nodeFs, afterSeq = -1, since, until, budget, snapshot = false, seq, view, refresh = true } = {}) {
  const startDay = since ? new Date(Date.parse(since)).toISOString().slice(0, 10) : "", endDay = until ? new Date(Date.parse(until)).toISOString().slice(0, 10) : "9999";
  const streams = [], checks = [];
  let failed = false;
  try {
    if (view && refresh) refreshInboxAdmission(home, view, { fs });
    const names = view ? [...view.indexes].map(([name, index]) => ({ name, index }))
      : files(home, { fs, snapshot }).map(name => ({ name, stat: privateStat(join(home, "inbox", name), { fs, optional: snapshot }) }));
    for (const { name, stat, index: saved } of names) {
      if (!view && !stat) continue;
      if (name.slice(0, 10) < startDay || name.slice(0, 10) > endDay) continue;
      let index;
      try { index = saved ?? fileIndex(home, name, decode, { fs, snapshot, stat, lazy: !!budget, budget }); }
      catch (error) { if (snapshot && error.code === "ENOENT") continue; throw error; }
      if (!index.pending && !index.blocks.some(b => b.last > afterSeq && (seq === undefined || seq >= b.minSeq && seq <= b.maxSeq))) continue;
      if (snapshot) checks.push({ path: join(home, "inbox", name), file: index.file, verified: { end: index.end, head: index.head, tail: index.tail } });
      const iterator = fileLines(home, name, index, { fs, afterSeq, seq, budget, snapshot });
      streams.push({ iterator, lower: index.blocks.find(b => b.last > afterSeq)?.first ?? afterSeq + 1 });
    }
    while (streams.length) {
      streams.sort((a, b) => (a.head?.record.cursor ?? a.head?.record.seq ?? a.lower) - (b.head?.record.cursor ?? b.head?.record.seq ?? b.lower));
      const stream = streams[0];
      if (stream.head) { yield stream.head; stream.head = null; }
      let next;
      try { next = stream.iterator.next(); }
      catch (error) { if (snapshot && error.code === "ENOENT") { streams.shift(); continue; } throw error; }
      if (next.done) streams.shift(); else stream.head = next.value;
    }
  } catch (error) { failed = true; throw error; }
  finally {
    for (const s of streams) s.iterator.return();
    // An unlocked reader can meet a day file replaced under the same inode after its edge check.
    if (!failed && checks.some(c => replacedSince(c.path, c.verified, c.file, { fs }))) throw new LocalStateError("home_locked", "inbox snapshot changed");
  }
}
export function inboxLines(home, options = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return [...iterateInbox(home, options)]; }
    catch (e) { if (!options.snapshot || e.code !== "home_locked" || attempt >= 2) throw e; }
  }
}

export function rewriteInbox(home, keep, { fs = nodeFs, dropFile = () => false } = {}) {
  const dir = privateDirectory(join(home, "inbox"), { fs }), pending = join(dir, REWRITE_PENDING);
  let rewriting = false;
  const mark = () => { if (!rewriting) { atomicPrivateWrite(pending, "{}\n", { fs }); rewriting = true; } };
  const removeDay = (path, name) => {
    removePrivateFile(path, { fs });
    if (privateStat(join(home, ".inbox-index"), { fs, directory: true, optional: true })) removePrivateFile(indexPath(home, name), { fs });
  };
  for (const name of files(home, { fs })) {
    const path = join(dir, name);
    if (dropFile(name)) { mark(); removeDay(path, name); continue; }
    const index = fileIndex(home, name, decode, { fs });
    let changed = privateStat(path, { fs }).size !== index.end;
    for (const line of fileLines(home, name, index, { fs })) if (!keep(line)) { changed = true; break; }
    if (!changed) { syncPrivateFile(path, { fs }); continue; }
    mark();
    let retained = 0;
    replaceInboxFile(path, write => {
      for (const line of fileLines(home, name, index, { fs })) if (keep(line)) { write(line.raw); retained++; }
    }, { fs });
    if (!retained) removeDay(path, name);
  }
  if (rewriting) removePrivateFile(pending, { fs });
}

export function validInboxReplay(transport) {
  if (transport.inbox_committed_cursor !== undefined && (!Number.isSafeInteger(transport.inbox_committed_cursor) || transport.inbox_committed_cursor < -1)) return false;
  if (transport.inbox_seen_at !== undefined && (!Number.isSafeInteger(transport.inbox_seen_at) || transport.inbox_seen_at < 0)) return false;
  const object = v => v !== null && typeof v === "object" && !Array.isArray(v);
  const bindingValid = binding => {
    const [from, key, extra] = binding.split(":");
    return extra === undefined && isMemberId(from) && isB64u(key, { length: 32 });
  };
  if (transport.inbox_seen_floor !== undefined && (!object(transport.inbox_seen_floor)
    || !Object.entries(transport.inbox_seen_floor).every(([binding, floor]) => bindingValid(binding) && Number.isSafeInteger(floor) && floor >= 0))) return false;
  if (transport.inbox_seen === undefined) return true;
  return object(transport.inbox_seen) && Object.entries(transport.inbox_seen).every(([binding, ids]) => {
    return bindingValid(binding) && object(ids)
      && Object.entries(ids).every(([id, at]) => isUuidV7(id) && Number.isSafeInteger(at) && at >= 0);
  });
}

export function checkInboxSequence(record, lines) {
  const existing = lines.find(l => l.record.seq === record.seq);
  if (existing) {
    const old = existing.record;
    if ((old.msg_id !== undefined && (old.msg_id !== record.msg_id || old.public_key !== record.public_key))
      || old.from !== record.from || old.kind !== record.kind || old.type !== record.type || JSON.stringify(old.inner) !== JSON.stringify(record.inner)) {
      throw new LocalStateError("invalid_state", "inbox sequence conflict");
    }
  }
  return existing;
}

export function findInboxSequence(home, record, options = {}) {
  for (const line of iterateInbox(home, { ...options, seq: record.seq })) {
    checkInboxSequence(record, [line]); return line;
  }
}

export function committedInboxRecord(record, state) {
  return record.msg_id === undefined || !state || (record.cursor ?? record.seq) <= (state.transport.inbox_committed_cursor ?? -1);
}

export function appendInboxLocked(home, record, { fs = nodeFs, innerText, view } = {}) {
  const options = { fs };
  metadata(record);
  const text = innerText ?? JSON.stringify(record.inner);
  if (typeof text !== "string") throw corrupt();
  const inner = parsePrivateJson(Buffer.from(text));
  if (inner.type !== record.type) throw corrupt();
  const { seq, from, kind, type, received_at, msg_id, public_key, accepted_at } = record;
  privateDirectory(join(home, "inbox"), options);
  view ??= createInboxAdmission();
  const lookup = refresh => admissionInboxSequence(home, { ...record, inner }, { ...options, view, ...refresh });
  const duplicate = existing => {
    syncPrivateFile(join(home, "inbox", existing.name), options);
    return { inserted: false, seq, record: existing.record };
  };
  const existing = lookup();
  if (existing) return duplicate(existing);
  const cursorPath = join(home, ".inbox-cursor.json");
  const reserved = inboxCursor(home, options);
  const refreshed = lookup({ sequential: true });
  if (refreshed) return duplicate(refreshed);
  let cursor = Math.max(seq, Math.max(reserved, view.high) + 1);
  if (!Number.isSafeInteger(cursor)) throw corrupt();
  // Reserve before appending so pruning, forgetting and interrupted writes cannot reuse a cursor.
  atomicPrivateWrite(cursorPath, JSON.stringify({ cursor }) + "\n", options);
  const name = `${received_at.slice(0, 10)}.jsonl`, path = join(home, "inbox", name);
  let prior = privateStat(path, { fs, optional: true });
  while (prior ? !sameSignature(view.indexes.get(name)?.file, prior) : view.indexes.has(name)) {
    const changed = lookup({ target: { name, stat: prior } });
    if (changed) return duplicate(changed);
    const next = Math.max(cursor, seq, Math.max(reserved, view.high) + 1);
    if (!Number.isSafeInteger(next)) throw corrupt();
    if (next !== cursor) {
      cursor = next; atomicPrivateWrite(cursorPath, JSON.stringify({ cursor }) + "\n", options);
    }
    prior = privateStat(path, { fs, optional: true });
  }
  const index = prior ? view.indexes.get(name) : { version: 2, end: 0, legacy: -1, blocks: [] };
  const prefix = JSON.stringify({ seq, cursor, from, kind, type, received_at, msg_id, public_key, accepted_at });
  const bytes = Buffer.from(prefix.slice(0, -1) + ',"inner":' + text.replace(/[\r\n]/g, " ") + "}\n");
  if (prior && prior.size !== index.end) {
    replaceInboxFile(path, write => write(bytes), { fs, prefixBytes: index.end });
  } else {
    const appendFd = fs.openSync(path, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW, 0o600);
    try {
      if (!prior) fs.fchmodSync(appendFd, 0o600);
      const opened = fs.fstatSync(appendFd), st = privateStat(path, { fs });
      if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== st.ino || opened.dev !== st.dev || (opened.mode & 0o7777) !== 0o600
        || (process.getuid && opened.uid !== process.getuid())) throw new LocalStateError("insecure_permissions", "invalid inbox append file");
      writeAll(appendFd, bytes, options); fs.fsyncSync(appendFd); syncDirectory(join(home, "inbox"), options);
    } finally { fs.closeSync(appendFd); }
  }
  addIndexRecord(index, { raw: bytes, offset: index.end, end: index.end + bytes.length, record: { ...record, cursor } });
  const st = privateStat(path, { fs });
  index.file = signature(st);
  saveIndex(home, name, index, options);
  view.indexes.set(name, index); view.high = Math.max(view.high, cursor); view.legacy = Math.max(view.legacy, index.legacy); view.searched = false;
  return { inserted: true, seq, record: { ...record, cursor, inner } };
}

export function createInbox(home, { fs = nodeFs, pageBudget = INBOX_PAGE_BUDGET } = {}) {
  const options = { fs };
  function readPage({ member, type, afterSeq = -1, since, until, limit = 1000 } = {}, { snapshot = false } = {}) {
    const start = since ? Date.parse(since) : -Infinity, end = until ? Date.parse(until) : Infinity;
    const ceiling = snapshot ? inboxCursor(home, options) : Infinity;
    const scan = () => {
      const saved = readPrivateFile(join(home, "state.json"), { ...options, optional: true });
      const state = saved ? parsePrivateJson(saved) : null;
      const budget = { ...pageBudget }, out = [];
      let scanned = afterSeq, hasMore = false;
      try { for (const { record: r } of iterateInbox(home, { ...options, snapshot, afterSeq, since, until, budget })) {
        const at = Date.parse(r.received_at), cursor = r.cursor ?? r.seq;
        if (!committedInboxRecord(r, state) || (ceiling !== -1 && cursor > ceiling)) continue;
        scanned = cursor;
        if ((!member || r.from === member) && (!type || r.type === type) && at >= start && at <= end) {
          out.push(r); if (out.length >= limit) break;
        }
      } } catch (error) {
        if (error.code !== "inbox_scan_limit" || scanned === afterSeq) throw error;
        hasMore = true;
      }
      return { records: out, next_after_seq: scanned, has_more: hasMore };
    };
    if (!snapshot) return withHomeLock(home, scan, options);
    for (let attempt = 0; ; attempt++) {
      try { return scan(); }
      catch (e) { if (e.code !== "home_locked" || attempt >= 2) throw e; }
    }
  }
  return {
    readPage,
    read: (...args) => readPage(...args).records,
    append(record, { innerText } = {}) {
      return withHomeLock(home, () => {
        const { inserted, seq } = appendInboxLocked(home, record, { ...options, innerText });
        return { inserted, seq };
      }, options);
    },
    prune(now = new Date()) {
      const cutoff = now.getTime() - INBOX_RETENTION_MS;
      if (!Number.isFinite(cutoff)) throw new LocalStateError("invalid_input", "invalid retention clock");
      return withHomeLock(home, () => {
        const saved = readPrivateFile(join(home, "state.json"), { ...options, optional: true }), state = saved ? parsePrivateJson(saved) : null;
        return rewriteInbox(home, l => !committedInboxRecord(l.record, state) || Date.parse(l.record.received_at) >= cutoff, { ...options, dropFile: name => {
          if (name.slice(0, 10) >= new Date(cutoff).toISOString().slice(0, 10)) return false;
          if (!state) return true;
          const index = fileIndex(home, name, decode, options);
          return index.blocks.every(b => b.last <= (state.transport.inbox_committed_cursor ?? -1));
        } });
      }, options);
    },
  };
}
