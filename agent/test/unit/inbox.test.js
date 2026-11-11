import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { createInbox, inboxLines } from "../../src/inbox.js";
import { readInbox } from "../../src/runtime.js";
import { fixture, diskFailure, syncTrace } from "../support/thin-home.js";

const record = (seq, at = "2026-11-05T00:00:00Z") => ({ seq, from: "m_dev_1", kind: "data", type: "sync", received_at: at, inner: { type: "sync", acks: [{ command_id: "c_158", version: seq, status: "applied" }], future: { untouched: true } } });
test("continued pagination sees delayed lower relay sequences after restart, pruning and empty history", t => {
  const home = fixture(t);
  createInbox(home).append(record(2));
  const first = readInbox(home, { limit: 1 });
  assert.equal(first.has_more, false);
  createInbox(home).append(record(1, "2026-11-04T12:00:00Z"));
  const second = readInbox(home, { after_seq: first.next_after_seq, limit: 1 });
  assert.deepEqual(second.records.map(r => r.seq), [1]);
  assert.ok(second.next_after_seq > first.next_after_seq);
  assert.equal(createInbox(home).append(record(1)).inserted, false);
  createInbox(home).prune(new Date("2027-01-01T00:00:00Z"));
  createInbox(home).append(record(0, "2027-01-01T00:00:00Z"));
  const third = readInbox(home, { after_seq: second.next_after_seq });
  assert.deepEqual(third.records.map(r => r.seq), [0]);
  assert.ok(third.next_after_seq > second.next_after_seq);
});

test("cursor reservation failure leaves the append retryable without advancing a reader", t => {
  for (const operation of ["writeSync", "fsyncSync", "renameSync"]) {
    const home = fixture(t);
    createInbox(home).append(record(2));
    const first = readInbox(home);
    assert.throws(() => createInbox(home, { fs: diskFailure(operation, 1, /inbox-cursor/) }).append(record(1)), { code: "ENOSPC" });
    assert.deepEqual(readInbox(home, { after_seq: first.next_after_seq }).records, []);
    createInbox(home).append(record(1));
    assert.deepEqual(readInbox(home, { after_seq: first.next_after_seq }).records.map(r => r.seq), [1]);
  }
});
test("every c_158 version reply survives either arrival order, replay and restart with exact inner bytes", (t) => {
  for (const order of [[1, 2], [2, 1]]) {
    const home = fixture(t), inbox = createInbox(home);
    for (const seq of order) inbox.append(record(seq));
    assert.equal(inbox.append(record(1)).inserted, false);
    assert.deepEqual(createInbox(home).read().map(r => r.inner.acks[0].version), order);
    assert.deepEqual(fs.readFileSync(join(home, "inbox/2026-11-05.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line).inner.acks[0].version), order);
    const raw = '{ "type": "future_echo", "value": 1e2, "nested": {"unknown":true} }';
    inbox.append({ ...record(3), type: "future_echo", inner: undefined }, { innerText: raw });
    assert.ok(fs.readFileSync(join(home, "inbox/2026-11-05.jsonl"), "utf8").includes(raw));
  }
});
test("sequence pagination includes out-of-order replies across days and filtered pages after restart", (t) => {
  const home = fixture(t), inbox = createInbox(home);
  inbox.append(record(2));
  inbox.append(record(1, "2026-11-06T00:00:00Z"));
  inbox.append({ ...record(3), from: "m_dev_2" });
  inbox.append(record(4, "2026-11-06T00:00:00Z"));
  let afterSeq = -1;
  for (const seq of [2, 1, 3, 4]) {
    const page = createInbox(home).read({ afterSeq, limit: 1 });
    assert.deepEqual(page.map(r => r.seq), [seq]);
    afterSeq = page[0].cursor;
  }
  assert.deepEqual(inbox.read({ afterSeq, limit: 1 }), []);
  assert.deepEqual(inbox.read({ member: "m_dev_1", type: "sync", limit: 2 }).map(r => r.seq), [2, 1]);
  assert.deepEqual(inbox.read({ member: "m_dev_1", afterSeq: 3, limit: 1 }).map(r => r.seq), [4]);
  assert.deepEqual(inbox.read({ since: "2026-11-06T00:00:00Z", limit: 1 }).map(r => r.seq), [1]);
});
test("date filters compare instants across second and millisecond precision with inclusive bounds", (t) => {
  const home = fixture(t), inbox = createInbox(home);
  const times = ["2026-11-04T23:59:59.999Z", "2026-11-05T00:00:00Z", "2026-11-05T00:00:00.000Z", "2026-11-05T00:00:00.001Z", "2026-11-05T00:00:00.999Z", "2026-11-05T00:00:01Z", "2026-11-05T00:00:01.000Z", "2026-11-05T00:00:01.001Z"];
  times.forEach((at, i) => inbox.append(record(i + 1, at)));
  const restarted = createInbox(home);
  for (const bound of ["2026-11-05T00:00:00Z", "2026-11-05T00:00:00.000Z"]) {
    assert.deepEqual(restarted.read({ since: bound }).map(r => r.seq), [2, 3, 4, 5, 6, 7, 8]);
    assert.deepEqual(restarted.read({ until: bound }).map(r => r.seq), [1, 2, 3]);
    assert.deepEqual(restarted.read({ since: bound, until: bound }).map(r => r.seq), [2, 3]);
  }
  assert.deepEqual(restarted.read({ since: "2026-11-05T00:00:00.001Z", until: "2026-11-05T00:00:01Z" }).map(r => r.seq), [4, 5, 6, 7]);
});
test("replay after a hard exit between append and fsync requires file and directory durability", (t) => {
  const module = new URL("../../src/inbox.js", import.meta.url).href;
  for (const existingFile of [false, true]) {
    const home = fixture(t), path = join(home, "inbox/2026-11-05.jsonl"), dir = join(home, "inbox");
    if (existingFile) createInbox(home).append(record(0));
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import fs from "node:fs";
      import { createInbox } from ${JSON.stringify(module)};
      const paths = new Map();
      const io = new Proxy(fs, { get(target, op) {
        if (op === "openSync") return (...args) => { const fd = target.openSync(...args); paths.set(fd, String(args[0])); return fd; };
        if (op === "closeSync") return fd => { paths.delete(fd); return target.closeSync(fd); };
        if (op === "fsyncSync") return fd => { if (paths.get(fd) === process.argv[2]) process.exit(87); return target.fsyncSync(fd); };
        return target[op];
      } });
      createInbox(process.argv[1], { fs: io }).append(JSON.parse(process.argv[3]));
    `, home, path, JSON.stringify(record(1))]);
    assert.equal(child.status, 87);
    const original = fs.readFileSync(path), replay = record(1, "2026-11-06T00:00:00Z");
    for (const pattern of [/\.jsonl$/, /\/inbox$/]) {
      assert.throws(() => createInbox(home, { fs: diskFailure("fsyncSync", 1, pattern) }).append(replay), { code: "ENOSPC" });
      assert.ok(fs.readFileSync(path).equals(original));
    }
    const paths = new Map(), synced = [];
    const io = new Proxy(fs, { get(target, op) {
      if (op === "openSync") return (...args) => { const fd = target.openSync(...args); paths.set(fd, String(args[0])); return fd; };
      if (op === "closeSync") return fd => { paths.delete(fd); return target.closeSync(fd); };
      if (op === "fsyncSync") return fd => { const name = paths.get(fd); if (name === path || name === dir) synced.push(name); return target.fsyncSync(fd); };
      return target[op];
    } });
    assert.deepEqual(createInbox(home, { fs: io }).append(replay), { inserted: false, seq: 1 });
    assert.deepEqual(synced, [dir, path, dir]);
    assert.ok(fs.readFileSync(path).equals(original));
    assert.deepEqual(createInbox(home).read().map(r => r.seq), existingFile ? [0, 1] : [1]);
  }
});
test("partial JSONL tails are ignored then durably repaired; completed corrupt lines fail closed", (t) => {
  const home = fixture(t), inbox = createInbox(home);
  inbox.append(record(1));
  const path = join(home, "inbox/2026-11-05.jsonl");
  fs.appendFileSync(path, Buffer.from([0x7b, 0x22, 0xf0, 0x9f]));
  assert.equal(createInbox(home).read().length, 1);
  inbox.append(record(2));
  assert.equal(inbox.read().length, 2);
  fs.appendFileSync(path, '{"secret":"canary"}\n');
  assert.throws(() => inbox.read(), e => e.code === "corrupt_state" && !e.message.includes("canary"));
});
test("append and fsync failures leave records retryable without advancing state", (t) => {
  for (const op of ["writeSync", "fsyncSync"]) {
    const home = fixture(t);
    createInbox(home).append(record(1));
    assert.throws(() => createInbox(home, { fs: diskFailure(op, 1, /\.jsonl$/) }).append(record(2)), { code: "ENOSPC" });
    const retry = createInbox(home);
    retry.append(record(2));
    assert.deepEqual(retry.read().map(r => r.seq), [1, 2]);
  }
});
test("a failed partial append preserves its original error when rollback cannot allocate space", t => {
  const home = fixture(t), inbox = createInbox(home);
  inbox.append(record(1));
  const path = join(home, "inbox/2026-11-05.jsonl"), inode = fs.statSync(path).ino;
  const original = Object.assign(new Error("append failed"), { code: "ENOSPC" });
  let writes = 0;
  const io = new Proxy(fs, { get(target, key) {
    if (key === "openSync") return (name, ...args) => {
      if (String(name).startsWith(join(home, "inbox/.2026-11-05.jsonl."))) throw new Error("rollback failed");
      return target.openSync(name, ...args);
    };
    if (key === "writeSync") return (fd, bytes, offset, length) => {
      if (fs.fstatSync(fd).ino !== inode) return target.writeSync(fd, bytes, offset, length);
      if (++writes > 1) throw original;
      return target.writeSync(fd, bytes, offset, length - 3);
    };
    return target[key];
  } });
  assert.throws(() => createInbox(home, { fs: io }).append(record(2)), error => error === original);
  assert.equal(writes, 2);
  assert.deepEqual(readInbox(home).records.map(r => r.seq), [1]);
  assert.equal(fs.readFileSync(path).at(-1) === 10, false);
  assert.deepEqual(inbox.append(record(2)), { inserted: true, seq: 2 });
  assert.deepEqual(inbox.read().map(r => [r.seq, r.cursor]), [[1, 1], [2, 3]]);
});
for (const point of ["file", "directory"]) test(`a complete append remains visible after ${point} fsync fails and replay retains its cursor`, t => {
  const home = fixture(t), inbox = createInbox(home);
  inbox.append(record(1));
  const path = join(home, "inbox/2026-11-05.jsonl"), dir = join(home, "inbox");
  const original = Object.assign(new Error("append sync failed"), { code: "ENOSPC" });
  let observed;
  const interrupted = syncTrace(name => {
    if (name !== (point === "file" ? path : dir) || observed) return;
    const snapshot = readInbox(home);
    if (!snapshot.records.some(r => r.seq === 2)) return;
    observed = snapshot;
    throw original;
  });
  assert.throws(() => createInbox(home, interrupted).append(record(2)), error => error === original);
  assert.deepEqual(observed.records.map(r => [r.seq, r.cursor]), [[1, 1], [2, 2]]);
  assert.deepEqual(readInbox(home), observed);
  const before = fs.readFileSync(path), cursor = fs.readFileSync(join(home, ".inbox-cursor.json")), trace = syncTrace();
  assert.deepEqual(createInbox(home, trace).append(record(2)), { inserted: false, seq: 2 });
  assert.deepEqual(trace.synced.filter(name => name === path || name === dir), [dir, path, dir]);
  assert.deepEqual(fs.readFileSync(path), before);
  assert.deepEqual(fs.readFileSync(join(home, ".inbox-cursor.json")), cursor);
  assert.deepEqual(readInbox(home), observed);
});
test("multiline JSON keeps unknown fields and numeric lexemes on one durable JSONL line", (t) => {
  const home = fixture(t), inbox = createInbox(home);
  inbox.append({ ...record(1), type: "future_echo" }, { innerText: '{\n "type":"future_echo",\n "number":1e3, "text":"escaped\\nvalue"\n}' });
  assert.equal(inbox.read().length, 1);
  const bytes = fs.readFileSync(join(home, "inbox/2026-11-05.jsonl"), "utf8");
  assert.equal(bytes.split("\n").length, 2);
  assert.ok(bytes.includes("1e3"));
});
test("30-day retention uses exact UTC cutoff and keeps original boundary-day bytes", (t) => {
  const home = fixture(t), inbox = createInbox(home);
  inbox.append(record(1, "2026-10-05T23:59:59Z"));
  inbox.append(record(2, "2026-10-06T12:34:55Z"));
  const raw = '{ "type":"sync", "unknown":1e3 }';
  inbox.append({ ...record(3, "2026-10-06T12:34:56Z"), inner: undefined }, { innerText: raw });
  inbox.append(record(4, "2026-11-05T12:34:56Z"));
  const before = fs.readFileSync(join(home, "inbox/2026-10-06.jsonl"), "utf8").split("\n")[1] + "\n";
  inbox.prune(new Date("2026-11-05T12:34:56Z"));
  assert.deepEqual(inbox.read().map(r => r.seq), [3, 4]);
  assert.equal(fs.readFileSync(join(home, "inbox/2026-10-06.jsonl"), "utf8"), before);
  assert.equal(fs.statSync(join(home, "inbox")).mode & 0o777, 0o700);
  assert.equal(fs.statSync(join(home, "inbox/2026-10-06.jsonl")).mode & 0o777, 0o600);
});

test("retention and partial-tail repair failures preserve committed records for retry", (t) => {
  for (const op of ["writeSync", "fsyncSync", "renameSync"]) {
    const home = fixture(t), inbox = createInbox(home);
    inbox.append(record(1, "2026-10-06T11:00:00Z"));
    inbox.append(record(2, "2026-10-06T13:00:00Z"));
    const path = join(home, "inbox/2026-10-06.jsonl"), original = fs.readFileSync(path);
    assert.throws(() => createInbox(home, { fs: diskFailure(op, 1, /\.2026-10-06\.jsonl\./) }).prune(new Date("2026-11-05T12:00:00Z")), { code: "ENOSPC" });
    assert.ok(fs.readFileSync(path).equals(original));
    inbox.prune(new Date("2026-11-05T12:00:00Z"));
    assert.deepEqual(inbox.read().map(r => r.seq), [2]);
  }
  for (const op of ["writeSync", "fsyncSync", "renameSync"]) {
    const home = fixture(t), inbox = createInbox(home);
    inbox.append(record(1));
    const path = join(home, "inbox/2026-11-05.jsonl"), inode = fs.statSync(path).ino;
    fs.appendFileSync(path, '{"incomplete":');
    const original = fs.readFileSync(path);
    assert.throws(() => createInbox(home, { fs: diskFailure(op, 1, /\.2026-11-05\.jsonl\./) }).append(record(2)), { code: "ENOSPC" });
    assert.deepEqual(fs.readFileSync(path), original);
    assert.equal(fs.statSync(path).ino, inode);
    inbox.append(record(2));
    assert.equal(inbox.read().length, 2);
  }
});

test("retention retries sync unchanged replacements and removed daily files", (t) => {
  for (const retained of [false, true]) {
    const home = fixture(t), dir = join(home, "inbox"), path = join(dir, "2026-10-06.jsonl"), cutoff = new Date("2026-11-05T12:00:00Z");
    createInbox(home).append(record(1, "2026-10-06T11:00:00Z"));
    if (retained) createInbox(home).append(record(2, "2026-10-06T13:00:00Z"));
    const interrupted = syncTrace(name => {
      if (name === dir && (retained ? fs.readFileSync(path, "utf8").split("\n").length === 2 : !fs.existsSync(path))) throw Object.assign(new Error("fixture disk failure"), { code: "ENOSPC" });
    });
    assert.throws(() => createInbox(home, interrupted).prune(cutoff), { code: "ENOSPC" });
    const trace = syncTrace();
    createInbox(home, trace).prune(cutoff);
    if (retained) {
      const at = trace.synced.indexOf(path);
      assert.ok(at >= 0); assert.equal(trace.synced[at + 1], dir);
    } else assert.ok(trace.synced.includes(dir));
    assert.deepEqual(createInbox(home).read().map(r => r.seq), retained ? [2] : []);
  }
});

test("a fresh process reading inbox finishes an interrupted rewrite directory sync", t => {
  const module = new URL("../../src/inbox.js", import.meta.url).href;
  for (const retained of [false, true]) {
    const home = fixture(t), dir = join(home, "inbox"), path = join(dir, "2026-10-06.jsonl");
    createInbox(home).append(record(1, "2026-10-06T11:00:00Z"));
    const interrupted = syncTrace(name => {
      if (name === dir && !fs.existsSync(path)) throw Object.assign(new Error("fixture disk failure"), { code: "ENOSPC" });
    });
    if (retained) createInbox(home).append(record(3));
    assert.throws(() => createInbox(home, interrupted).prune(new Date("2026-11-05T14:00:00Z")), { code: "ENOSPC" });
    assert.equal(fs.existsSync(path), false);
    for (const reader of ["inboxLines", "read"]) {
      const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
        import assert from "node:assert/strict";
        import { createInbox, inboxLines } from ${JSON.stringify(module)};
        import { diskFailure } from ${JSON.stringify(new URL("../support/thin-home.js", import.meta.url).href)};
        const home = process.argv[1], options = { fs: diskFailure("fsyncSync", 1, /\\/inbox$/) };
        assert.throws(() => process.argv[2] === "read" ? createInbox(home, options).read() : inboxLines(home, options), { code: "ENOSPC" });
      `, home, reader]);
      assert.equal(child.status, 0, child.stderr.toString());
    }
    const trace = syncTrace();
    assert.deepEqual(createInbox(home, trace).read().map(r => r.seq), retained ? [3] : []);
    assert.ok(trace.synced.includes(dir));
    const clean = syncTrace();
    assert.deepEqual(inboxLines(home, clean).map(l => l.record.seq), retained ? [3] : []);
    createInbox(home, clean).read();
    assert.equal(clean.synced.includes(dir), false);
  }
});

test("inbox scans leave absent directories absent and existing history unsynced", t => {
  const home = fixture(t), trace = syncTrace();
  assert.deepEqual(inboxLines(home, trace), []);
  assert.equal(fs.existsSync(join(home, "inbox")), false);
  createInbox(home).append(record(1));
  assert.deepEqual(inboxLines(home, trace).map(line => line.record), createInbox(home).read());
  assert.deepEqual(trace.synced, []);
});
