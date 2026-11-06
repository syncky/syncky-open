import nodeFs from "node:fs";
import { join } from "node:path";
import { LocalStateError } from "./config.js";
import { isMemberId } from "./ids.js";
import { atomicPrivateWrite, parsePrivateJson, privateDirectory, privateStat, readPrivateFile, removePrivateFile, syncDirectory, syncPrivateFile, withHomeLock, writeAll } from "./protected-files.js";

export const INBOX_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const REWRITE_PENDING = ".rewrite-pending";
const corrupt = () => new LocalStateError("corrupt_state", "invalid thin inbox record");
function metadata(record) {
  if (!Number.isSafeInteger(record.seq) || record.seq < 0 || !isMemberId(record.from)
    || (record.cursor !== undefined && (!Number.isSafeInteger(record.cursor) || record.cursor < 0))
    || !["data", "control"].includes(record.kind) || typeof record.type !== "string"
    || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(record.received_at) || !Number.isFinite(Date.parse(record.received_at))
    || new Date(record.received_at).toISOString() !== record.received_at.replace(/(?<!\.\d{3})Z$/, ".000Z")) throw corrupt();
  return record;
}

export function inboxLines(home, { fs = nodeFs } = {}) {
  const dir = join(home, "inbox");
  privateStat(home, { fs, directory: true });
  if (!privateStat(dir, { fs, directory: true, optional: true })) return [];
  const pending = join(dir, REWRITE_PENDING);
  if (privateStat(pending, { fs, optional: true })) {
    syncDirectory(dir, { fs });
    removePrivateFile(pending, { fs });
  }
  const out = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (name.startsWith(".")) continue;
    if (!/^\d{4}-\d\d-\d\d\.jsonl$/.test(name)) throw corrupt();
    const bytes = readPrivateFile(join(dir, name), { fs });
    let start = 0, end;
    while ((end = bytes.indexOf(10, start)) !== -1) {
      const raw = bytes.subarray(start, end + 1), record = metadata(parsePrivateJson(raw));
      if (record.received_at.slice(0, 10) !== name.slice(0, 10) || !record.inner || typeof record.inner !== "object" || Array.isArray(record.inner) || record.inner.type !== record.type) throw corrupt();
      out.push({ name, raw, record }); start = end + 1;
    }
  }
  return out;
}

export function rewriteInbox(home, keep, { fs = nodeFs } = {}) {
  const dir = privateDirectory(join(home, "inbox"), { fs }), lines = inboxLines(home, { fs });
  const pending = join(dir, REWRITE_PENDING);
  let rewriting = false;
  for (const name of fs.readdirSync(dir).filter(n => /^\d{4}-\d\d-\d\d\.jsonl$/.test(n))) {
    const original = lines.filter(l => l.name === name), retained = original.filter(keep);
    if (retained.length === original.length && Buffer.concat(original.map(l => l.raw)).equals(readPrivateFile(join(dir, name), { fs }))) {
      syncPrivateFile(join(dir, name), { fs });
      continue;
    }
    if (!rewriting) { atomicPrivateWrite(pending, "{}\n", { fs }); rewriting = true; }
    if (retained.length) atomicPrivateWrite(join(dir, name), Buffer.concat(retained.map(l => l.raw)), { fs });
    else removePrivateFile(join(dir, name), { fs });
  }
  if (rewriting) removePrivateFile(pending, { fs });
}

export function createInbox(home, { fs = nodeFs } = {}) {
  const options = { fs };
  return {
    read({ member, type, afterSeq = -1, since, until, limit = 1000 } = {}) {
      const start = since ? Date.parse(since) : -Infinity, end = until ? Date.parse(until) : Infinity;
      return withHomeLock(home, () => inboxLines(home, options).map(l => l.record).filter(r => {
        const at = Date.parse(r.received_at);
        return (!member || r.from === member) && (!type || r.type === type) && (r.cursor ?? r.seq) > afterSeq && at >= start && at <= end;
      }).sort((a, b) => (a.cursor ?? a.seq) - (b.cursor ?? b.seq)).slice(0, limit), options);
    },
    append(record, { innerText } = {}) {
      metadata(record);
      const text = innerText ?? JSON.stringify(record.inner);
      if (typeof text !== "string") throw corrupt();
      const inner = parsePrivateJson(Buffer.from(text));
      if (inner.type !== record.type) throw corrupt();
      const { seq, from, kind, type, received_at } = record;
      return withHomeLock(home, () => {
        privateDirectory(join(home, "inbox"), options);
        const lines = inboxLines(home, options), existing = lines.find(l => l.record.seq === seq);
        if (existing) {
          const old = existing.record;
          if (old.from !== from || old.kind !== kind || old.type !== type || JSON.stringify(old.inner) !== JSON.stringify(inner)) throw new LocalStateError("invalid_state", "inbox sequence conflict");
          syncPrivateFile(join(home, "inbox", existing.name), options);
          return { inserted: false, seq };
        }
        const cursorPath = join(home, ".inbox-cursor.json"), saved = readPrivateFile(cursorPath, { fs, optional: true });
        let high = saved ? parsePrivateJson(saved).cursor : -1;
        if (!Number.isSafeInteger(high) || high < -1) throw corrupt();
        for (const line of lines) high = Math.max(high, line.record.cursor ?? line.record.seq);
        const cursor = Math.max(seq, high + 1);
        if (!Number.isSafeInteger(cursor)) throw corrupt();
        // Reserve before appending so pruning, forgetting and interrupted writes cannot reuse a cursor.
        atomicPrivateWrite(cursorPath, JSON.stringify({ cursor }) + "\n", options);
        const prefix = JSON.stringify({ seq, cursor, from, kind, type, received_at });
        const bytes = Buffer.from(prefix.slice(0, -1) + ',"inner":' + text.replace(/[\r\n]/g, " ") + "}\n");
        const path = join(home, "inbox", `${received_at.slice(0, 10)}.jsonl`), prior = readPrivateFile(path, { fs, optional: true });
        const length = prior ? prior.lastIndexOf(10) + 1 : 0;
        const appendFd = fs.openSync(path, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW, 0o600);
        try {
          if (!prior) fs.fchmodSync(appendFd, 0o600);
          if (prior && prior.length !== length) { fs.ftruncateSync(appendFd, length); fs.fsyncSync(appendFd); }
          writeAll(appendFd, bytes, options); fs.fsyncSync(appendFd); syncDirectory(join(home, "inbox"), options);
        }
        catch (e) { fs.ftruncateSync(appendFd, length); fs.fsyncSync(appendFd); throw e; }
        finally { fs.closeSync(appendFd); }
        return { inserted: true, seq };
      }, options);
    },
    prune(now = new Date()) {
      const cutoff = now.getTime() - INBOX_RETENTION_MS;
      if (!Number.isFinite(cutoff)) throw new LocalStateError("invalid_input", "invalid retention clock");
      return withHomeLock(home, () => rewriteInbox(home, l => Date.parse(l.record.received_at) >= cutoff, options), options);
    },
  };
}
