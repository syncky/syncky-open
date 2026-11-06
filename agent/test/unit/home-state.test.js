import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { acquireHomeLock, atomicPrivateWrite, openPrivateAppend, privateDirectory, receiverLockHeld, removePrivateFile } from "../../src/protected-files.js";
import { createHomeState, readHomeState, updateHomeState, detectLegacyFiles, cipherEntries, createCipherFiles, forgetThinMember } from "../../src/home-state.js";
import { createInbox } from "../../src/inbox.js";
import { fixture, identity, keys, messageId, diskFailure, syncTrace } from "../support/thin-home.js";

test("atomic state reloads, refuses async mutations and keeps the last durable state on failure", (t) => {
  const home = fixture(t);
  createHomeState(home, identity);
  updateHomeState(home, s => { s.transport.cursor = 3; });
  assert.equal(readHomeState(home).transport.cursor, 3);
  assert.throws(() => updateHomeState(home, async () => {}), { code: "tx_async" });
  for (const op of ["writeSync", "fsyncSync", "renameSync"]) {
    assert.throws(() => updateHomeState(home, s => { s.transport.cursor = 4; }, { fs: diskFailure(op, 1, /\.state\.json\./) }), { code: "ENOSPC" });
    assert.equal(readHomeState(home).transport.cursor, 3);
  }
  assert.equal(fs.statSync(join(home, "state.json")).mode & 0o777, 0o600);
  assert.throws(() => createHomeState(home, identity), { code: "already_initialized" });
});

test("missing legacy export, corrupt state and mismatched identity fail closed", (t) => {
  const home = fixture(t);
  fs.writeFileSync(join(home, "agent.db-wal"), "fixture", { mode: 0o400 });
  assert.deepEqual(detectLegacyFiles(home), ["agent.db-wal"]);
  assert.throws(() => readHomeState(home), { code: "migration_required" });
  assert.throws(() => createHomeState(home, identity), { code: "migration_required" });
  fs.unlinkSync(join(home, "agent.db-wal"));
  createHomeState(home, identity);
  assert.throws(() => updateHomeState(home, s => { s.identity.public_key = keys.dev1.pk; }), { code: "key_mismatch" });
  for (const change of [s => { s.transport.pending_ack = { up_to_seq: 999 }; }, s => { s.members.m_dev_1 = { member_id: "m_dev_1", public_key: keys.dev1.pk, role: "device", state: "invalid" }; }]) {
    assert.throws(() => updateHomeState(home, change), { code: "corrupt_state" });
  }
  fs.writeFileSync(join(home, "state.json"), '{"private":"canary"');
  assert.throws(() => readHomeState(home), e => e.code === "corrupt_state" && !e.message.includes("canary"));
});

test("pending confirmation state validates its envelope id and timestamp before recovery", t => {
  const home = fixture(t); createHomeState(home, identity);
  updateHomeState(home, s => { s.members.m_dev_1 = { member_id: "m_dev_1", public_key: keys.dev1.pk, role: "device", state: "confirmed" }; });
  for (const confirmation of [[], { msg_id: "../state", created_at: "2026-11-05T12:00:00Z" }, { msg_id: messageId(1), created_at: "invalid" }]) {
    assert.throws(() => updateHomeState(home, s => { s.members.m_dev_1.confirmation = confirmation; }), { code: "corrupt_state" });
    assert.equal(readHomeState(home).members.m_dev_1.confirmation, undefined);
  }
  const confirmation = { msg_id: messageId(1), created_at: "2026-11-05T12:00:00Z" };
  updateHomeState(home, s => { s.members.m_dev_1.confirmation = confirmation; });
  assert.deepEqual(readHomeState(home).members.m_dev_1.confirmation, confirmation);
});

test("protected paths reject symlinks, hard links and broad or unreadable permissions without chmod", (t) => {
  const home = fixture(t), outside = fixture(t);
  createHomeState(home, identity);
  const path = join(home, "state.json"), original = fs.readFileSync(path);
  for (const mode of [0o644, 0o000]) {
    fs.chmodSync(path, mode);
    assert.throws(() => readHomeState(home), { code: "insecure_permissions" });
    assert.equal(fs.statSync(path).mode & 0o777, mode);
  }
  fs.chmodSync(path, 0o600);
  fs.renameSync(path, join(outside, "target"));
  fs.symlinkSync(join(outside, "target"), path);
  assert.throws(() => atomicPrivateWrite(path, "changed"), { code: "insecure_permissions" });
  assert.ok(fs.readFileSync(join(outside, "target")).equals(original));
  fs.unlinkSync(path);
  fs.linkSync(join(outside, "target"), path);
  assert.throws(() => readHomeState(home), { code: "insecure_permissions" });
  fs.unlinkSync(path);
  fs.symlinkSync(outside, join(home, "held"));
  assert.throws(() => createCipherFiles(home, "held").list(), { code: "insecure_permissions" });
  const link = join(outside, "home-link");
  fs.symlinkSync(home, link);
  assert.throws(() => readHomeState(link), { code: "insecure_permissions" });
});

test("receiver lease excludes another receiver while state locks serialize other writers; dead owners recover", (t) => {
  const home = fixture(t);
  const receiver = acquireHomeLock(home, "receiver");
  assert.throws(() => acquireHomeLock(home, "receiver"), { code: "home_locked" });
  const state = acquireHomeLock(home, "state");
  assert.throws(() => acquireHomeLock(home, "state"), { code: "home_locked" });
  state.release(); receiver.release(); receiver.release();
  const module = new URL("../../src/protected-files.js", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `import { acquireHomeLock } from ${JSON.stringify(module)}; acquireHomeLock(process.argv[1], 'receiver');`, home]);
  assert.equal(child.status, 0);
  acquireHomeLock(home, "receiver").release();
  const locked = acquireHomeLock(home, "state");
  const refused = spawnSync(process.execPath, ["--input-type=module", "-e", `import { acquireHomeLock } from ${JSON.stringify(module)}; try { acquireHomeLock(process.argv[1], 'state'); process.exit(9); } catch(e) { process.exit(e.code === 'home_locked' ? 0 : 8); }`, home]);
  assert.equal(refused.status, 0); locked.release();
  fs.mkdirSync(join(home, ".state.lock"), { mode: 0o700 });
  assert.throws(() => acquireHomeLock(home, "state"), { code: "home_locked" });
  fs.rmdirSync(join(home, ".state.lock"));
});

test('receiver probe observes live and dead owners without creating, deleting or taking a lease', t => {
  const home = fixture(t), directory = join(home, '.receiver.lock');
  assert.equal(receiverLockHeld(home), false); assert.equal(fs.existsSync(directory), false);
  const receiver = acquireHomeLock(home, 'receiver');
  assert.equal(receiverLockHeld(home), true); receiver.release();
  const module = new URL('../../src/protected-files.js', import.meta.url).href;
  const dead = spawnSync(process.execPath, ['--input-type=module', '-e', `import { acquireHomeLock } from ${JSON.stringify(module)}; acquireHomeLock(process.argv[1], 'receiver');`, home]);
  assert.equal(dead.status, 0);
  const files = fs.readdirSync(directory);
  assert.equal(receiverLockHeld(home), false); assert.deepEqual(fs.readdirSync(directory), files);
  const live = acquireHomeLock(home, 'receiver'); live.release();
  fs.mkdirSync(directory, { mode: 0o700 });
  assert.equal(receiverLockHeld(home), true);
  fs.rmdirSync(directory);
  fs.mkdirSync(directory, { mode: 0o700 });
  assert.equal(receiverLockHeld(home, { fs: { ...fs, readdirSync() { throw Object.assign(Error('unreadable'), { code: 'EACCES' }); } } }), true);
  fs.rmdirSync(directory);
});

test('short receiver leases remain exclusive without suppressing pair waiters, and dead owners recover', t => {
  const home = fixture(t), directory = join(home, '.receiver.lock');
  const short = acquireHomeLock(home, 'receiver', { role: 'once' });
  assert.equal(receiverLockHeld(home), false);
  assert.throws(() => acquireHomeLock(home, 'receiver'), { code: 'home_locked' });
  short.release();
  const module = new URL('../../src/protected-files.js', import.meta.url).href;
  const dead = spawnSync(process.execPath, ['--input-type=module', '-e', `import { acquireHomeLock } from ${JSON.stringify(module)}; acquireHomeLock(process.argv[1], 'receiver', { role: 'once' });`, home]);
  assert.equal(dead.status, 0);
  const files = fs.readdirSync(directory);
  assert.equal(receiverLockHeld(home), false); assert.deepEqual(fs.readdirSync(directory), files);
  const receiver = acquireHomeLock(home, 'receiver');
  assert.equal(receiverLockHeld(home), true);
  const ownerPath = join(directory, fs.readdirSync(directory)[0]);
  fs.writeFileSync(ownerPath, JSON.stringify({ pid: process.pid }));
  assert.equal(receiverLockHeld(home), true);
  receiver.release();
});

test('private append keeps existing logs and refuses symlinks, hardlinks and public files', t => {
  const home = fixture(t), path = join(home, 'pair-waiter.log');
  let fd = openPrivateAppend(path); fs.writeSync(fd, 'first\n'); fs.closeSync(fd);
  fd = openPrivateAppend(path); fs.writeSync(fd, 'second\n'); fs.closeSync(fd);
  assert.equal(fs.readFileSync(path, 'utf8'), 'first\nsecond\n'); assert.equal(fs.statSync(path).mode & 0o777, 0o600);
  fs.chmodSync(path, 0o644); assert.throws(() => openPrivateAppend(path), { code: 'insecure_permissions' }); fs.chmodSync(path, 0o600);
  const other = join(home, 'other.log');
  fs.linkSync(path, other); assert.throws(() => openPrivateAppend(path), { code: 'insecure_permissions' }); fs.unlinkSync(other);
  fs.renameSync(path, other); fs.symlinkSync(other, path);
  assert.throws(() => openPrivateAppend(path), { code: 'insecure_permissions' }); assert.equal(fs.readFileSync(other, 'utf8'), 'first\nsecond\n');
});

test('private append truncates oversized logs only after checking the opened file', t => {
  const home = fixture(t), path = join(home, 'pair-waiter.log'), maxBytes = 256 * 1024;
  fs.writeFileSync(path, Buffer.alloc(maxBytes, 120), { mode: 0o600 });
  fs.closeSync(openPrivateAppend(path, { maxBytes }));
  assert.equal(fs.statSync(path).size, maxBytes);
  fs.appendFileSync(path, 'x');
  const fd = openPrivateAppend(path, { maxBytes });
  assert.equal(fs.fstatSync(fd).size, 0); fs.writeSync(fd, 'metadata\n'); fs.closeSync(fd);
  assert.equal(fs.readFileSync(path, 'utf8'), 'metadata\n');
  assert.equal(fs.statSync(path).mode & 0o777, 0o600);
  const other = join(home, 'other.log');
  fs.renameSync(path, other); fs.symlinkSync(other, path);
  assert.throws(() => openPrivateAppend(path, { maxBytes: 0 }), { code: 'insecure_permissions' });
  assert.equal(fs.readFileSync(other, 'utf8'), 'metadata\n');
  fs.unlinkSync(path); fs.linkSync(other, path);
  assert.throws(() => openPrivateAppend(path, { maxBytes: 0 }), { code: 'insecure_permissions' });
  assert.equal(fs.readFileSync(other, 'utf8'), 'metadata\n');
  fs.unlinkSync(path); fs.renameSync(other, path); fs.chmodSync(path, 0o644);
  assert.throws(() => openPrivateAppend(path, { maxBytes: 0 }), { code: 'insecure_permissions' });
  assert.equal(fs.readFileSync(path, 'utf8'), 'metadata\n');
});

test("only held migration metadata can transition while ciphertext stays immutable", t => {
  const home = fixture(t); createHomeState(home, identity);
  const entry = { msg_id: messageId(1), seq: 1, from: "m_dev_1", kind: "data", body: "encrypted fixture", legacy_state: "new" };
  const held = createCipherFiles(home, "held"), outbox = createCipherFiles(home, "outbox");
  held.put(entry); outbox.put(entry);
  assert.throws(() => held.update(entry.msg_id, { legacy_state: "new" }), { code: "invalid_input" });
  assert.throws(() => outbox.update(entry.msg_id, { legacy_state: "held" }), { code: "invalid_input" });
  assert.throws(() => held.update(entry.msg_id, { body: "different", legacy_state: "held" }), { code: "invalid_input" });
  held.update(entry.msg_id, { legacy_state: "held" });
  assert.deepEqual(held.list(), [{ ...entry, legacy_state: "held" }]);
});

test("sealed ciphertext retries stay exact, and explicit forget retains a revocation tombstone and legacy bytes", (t) => {
  const home = fixture(t);
  createHomeState(home, identity);
  updateHomeState(home, s => { s.members.m_dev_1 = { member_id: "m_dev_1", role: "device", state: "revoked", public_key: keys.dev1.pk }; });
  const outbox = createCipherFiles(home, "outbox"), held = createCipherFiles(home, "held");
  const entry = { msg_id: messageId(1), from: "m_dev_1", to: ["m_dev_1"], kind: "control", lane: "control", body: ' {"ciphertext":"fixture"} ', state: "pending", attempts: 0 };
  outbox.put(entry); held.put({ ...entry, seq: 1 });
  outbox.update(entry.msg_id, { attempts: 2, next_attempt_at: 12345 });
  assert.ok(outbox.list()[0].body === entry.body);
  assert.throws(() => outbox.update(entry.msg_id, { body: "different" }), { code: "invalid_input" });
  const inbox = createInbox(home);
  inbox.append({ seq: 1, from: "m_dev_1", kind: "data", type: "sync", received_at: "2026-11-05T00:00:00Z", inner: { type: "sync" } });
  fs.writeFileSync(join(home, "agent.db"), "legacy", { mode: 0o400 });
  assert.equal(forgetThinMember(home, "m_dev_1").inbox, 1);
  assert.equal(inbox.read().length, 1);
  forgetThinMember(home, "m_dev_1", { yes: true });
  assert.equal(inbox.read().length + outbox.list().length + held.list().length, 0);
  assert.equal(readHomeState(home).members.m_dev_1.state, "revoked");
  assert.equal(fs.readFileSync(join(home, "agent.db"), "utf8"), "legacy");
  assert.equal(fs.statSync(join(home, "agent.db")).mode & 0o777, 0o400);
});

test("forget retries finish ciphertext deletion syncs with empty or unrelated queues", t => {
  for (const area of ["held", "outbox"]) for (const remaining of [false, true]) {
    const home = fixture(t); createHomeState(home, identity);
    updateHomeState(home, s => { s.members.m_dev_1 = { member_id: "m_dev_1", role: "device", state: "revoked", public_key: keys.dev1.pk }; });
    const queue = createCipherFiles(home, area), dir = join(home, area), path = join(dir, `${messageId(1)}.json`);
    queue.put({ msg_id: messageId(1), seq: 1, from: "m_dev_1", kind: "control", body: "sealed" });
    if (remaining) queue.put({ msg_id: messageId(2), seq: 2, from: "m_dev_2", kind: "control", body: "unrelated" });
    const failing = () => ({ yes: true, fs: diskFailure("fsyncSync", 1, new RegExp(`/${area}$`)) });
    assert.throws(() => forgetThinMember(home, "m_dev_1", failing()), { code: "ENOSPC" });
    assert.equal(fs.existsSync(path), false);
    const retained = queue.list();
    assert.throws(() => forgetThinMember(home, "m_dev_1", failing()), { code: "ENOSPC" });
    const retry = syncTrace();
    assert.deepEqual(forgetThinMember(home, "m_dev_1", { yes: true, ...retry }), { inbox: 0, held: 0, outbox: 0 });
    assert.ok(retry.synced.includes(dir));
    assert.deepEqual(queue.list(), retained);
    assert.equal(readHomeState(home).members.m_dev_1.state, "revoked");
  }
});

test("ciphertext writes and retry metadata are crash-safe under disk failure and strict paths", (t) => {
  const home = fixture(t), queue = createCipherFiles(home, "outbox");
  const entry = { msg_id: messageId(1), to: ["m_dev_1"], kind: "control", body: "sealed", state: "pending", attempts: 0 };
  queue.put(entry);
  for (const op of ["writeSync", "fsyncSync", "renameSync"]) {
    const failing = createCipherFiles(home, "outbox", { fs: diskFailure(op, 1, /\.0192e0a0-.*\.tmp$/) });
    assert.throws(() => failing.update(entry.msg_id, { attempts: 1 }), { code: "ENOSPC" });
    assert.equal(queue.list()[0].attempts, 0);
  }
  fs.chmodSync(join(home, "outbox", `${entry.msg_id}.json`), 0o644);
  assert.throws(() => queue.list(), { code: "insecure_permissions" });
  fs.chmodSync(join(home, "outbox", `${entry.msg_id}.json`), 0o600);
  assert.equal(queue.put(entry), false);
  assert.throws(() => queue.put({ ...entry, body: "changed" }), { code: "invalid_state" });
});

test("ciphertext retries after rename require file then parent sync before success", (t) => {
  for (const area of ["held", "outbox"]) {
    const home = fixture(t), dir = join(home, area), entry = { msg_id: messageId(1), seq: 1, kind: "data", body: "sealed" };
    const path = join(dir, `${entry.msg_id}.json`);
    const interrupted = syncTrace(name => {
      if (name === dir && fs.existsSync(path)) throw Object.assign(new Error("fixture disk failure"), { code: "ENOSPC" });
    });
    assert.throws(() => createCipherFiles(home, area, interrupted).put(entry), { code: "ENOSPC" });
    const original = fs.readFileSync(path);
    for (const target of [path, dir]) {
      const failing = syncTrace((name, synced) => {
        if (name === target && (target === path || synced.includes(path))) throw Object.assign(new Error("fixture disk failure"), { code: "ENOSPC" });
      });
      assert.throws(() => createCipherFiles(home, area, failing).put(entry), { code: "ENOSPC" });
      assert.ok(fs.readFileSync(path).equals(original));
    }
    const trace = syncTrace();
    assert.equal(createCipherFiles(home, area, trace).put(entry), false);
    const at = trace.synced.indexOf(path);
    assert.ok(at >= 0); assert.equal(trace.synced[at + 1], dir);
    assert.ok(fs.readFileSync(path).equals(original));
  }
});

test("directory creation and deletion retries sync their parents even when already applied", (t) => {
  const home = fixture(t), dir = join(home, "held"), path = join(dir, "fixture.json");
  assert.throws(() => privateDirectory(dir, { fs: diskFailure("fsyncSync", 1, /thin-home-[^/]+$/) }), { code: "ENOSPC" });
  const creation = syncTrace();
  privateDirectory(dir, creation);
  assert.deepEqual(creation.synced, [dir, home]);
  atomicPrivateWrite(path, "{}");
  assert.throws(() => removePrivateFile(path, { fs: diskFailure("fsyncSync", 1, /\/held$/) }), { code: "ENOSPC" });
  const deletion = syncTrace();
  assert.equal(removePrivateFile(path, deletion), false);
  assert.deepEqual(deletion.synced, [dir]);
});

test("receiver acquisition syncs its home and release retries finish failed directory sync", (t) => {
  const home = fixture(t), acquisition = syncTrace();
  const lease = acquireHomeLock(home, "receiver", acquisition);
  const owner = acquisition.synced.find(path => path.endsWith(".tmp"));
  assert.ok(owner); assert.ok(acquisition.synced.indexOf(home) > acquisition.synced.indexOf(owner));
  lease.release();
  let fail = false;
  const trace = syncTrace(name => {
    if (fail && name === home) { fail = false; throw Object.assign(new Error("fixture disk failure"), { code: "ENOSPC" }); }
  });
  const retry = acquireHomeLock(home, "receiver", trace);
  trace.synced.length = 0; fail = true;
  assert.throws(() => retry.release(), { code: "ENOSPC" });
  retry.release();
  assert.deepEqual(trace.synced, [home]);
});

test("new file primitives have no transitive SQLite or old store import", () => {
  const seen = new Set();
  function visit(url) {
    if (seen.has(url.href)) return;
    seen.add(url.href);
    const source = fs.readFileSync(url, "utf8");
    assert.ok(!/node:sqlite|["']\.\/[^"']*store\.js["']/.test(source), "file primitive imported SQLite/store");
    for (const m of source.matchAll(/(?:from\s*|import\s*)["'](\.\.?\/[^"']+)["']/g)) visit(new URL(m[1], url));
  }
  for (const name of ["protected-files", "home-state", "inbox", "thin-pairing"]) visit(new URL(`../../src/${name}.js`, import.meta.url));
});

test("a restrictive umask still creates 0700 directories and 0600 thin files", (t) => {
  const home = fixture(t), mask = process.umask(0o777);
  try {
    createHomeState(home, identity);
    createCipherFiles(home, "outbox").put({ msg_id: messageId(1), to: ["m_dev_1"], kind: "control", body: "sealed" });
    createInbox(home).append({ seq: 1, from: "m_dev_1", kind: "data", type: "sync", received_at: "2026-11-05T00:00:00Z", inner: { type: "sync" } });
    for (const file of ["state.json", `outbox/${messageId(1)}.json`, "inbox/2026-11-05.jsonl"]) assert.equal(fs.statSync(join(home, file)).mode & 0o777, 0o600);
    for (const dir of ["inbox", "outbox"]) assert.equal(fs.statSync(join(home, dir)).mode & 0o777, 0o700);
  } finally { process.umask(mask); }
});

test("a lock directory fsync failure cleans its own owner and permits retry", (t) => {
  const home = fixture(t);
  assert.throws(() => acquireHomeLock(home, "state", { fs: diskFailure("fsyncSync", 1, /\.state\.lock$/) }), { code: "ENOSPC" });
  acquireHomeLock(home, "state").release();
});

test('a lock owner disappearing between open and fstat retries without accepting unsafe files', t => {
  const home = fixture(t), owner = acquireHomeLock(home, 'state');
  const directory = join(home,'.state.lock'), path = join(directory,fs.readdirSync(directory)[0]);
  let watched, raced = false;
  const io = { ...fs,
    openSync(name,...args) { const fd = fs.openSync(name,...args); if (name === path) watched = fd; return fd; },
    fstatSync(fd) { if (fd === watched && !raced) { raced = true; owner.release(); } return fs.fstatSync(fd); },
  };
  const next = acquireHomeLock(home,'state',{ fs:io });
  assert.equal(raced,true); next.release();
  const stable = acquireHomeLock(home,'state'), unsafePath = join(directory,fs.readdirSync(directory)[0]);
  fs.chmodSync(unsafePath,0o644);
  assert.throws(() => acquireHomeLock(home,'state'),{ code:'insecure_permissions' });
  fs.chmodSync(unsafePath,0o600); stable.release();
});

test('a concurrent atomic state replacement is read coherently without bypassing protected paths', t => {
  const home = fixture(t); createHomeState(home,identity);
  const path = join(home,'state.json'); let replaced = false;
  const io = { ...fs, openSync(name,...args) {
    if (name === path && !replaced) { replaced = true; updateHomeState(home,s => { s.transport.cursor = 7; }); }
    return fs.openSync(name,...args);
  } };
  assert.equal(readHomeState(home,{fs:io}).transport.cursor,7);
  assert.equal(replaced,true);
});

test("forget refuses a confirmed phone and says it must leave the hub first", (t) => {
  const home = fixture(t);
  createHomeState(home, identity);
  updateHomeState(home, s => { s.members.m_dev_1 = { member_id: "m_dev_1", role: "device", state: "confirmed", public_key: keys.dev1.pk }; });
  assert.throws(() => forgetThinMember(home, "m_dev_1", { yes: true }), { code: "invalid_transition", message: /must have left the hub.*revoke <member_id>/ });
  assert.equal(readHomeState(home).members.m_dev_1.state, "confirmed");
});

test("ciphertext scans are read-only and tolerate a receipt removed during a scan", t => {
  const home = fixture(t), trace = syncTrace();
  assert.deepEqual(cipherEntries(home, "outbox", trace), []);
  assert.equal(fs.existsSync(join(home, "outbox")), false);
  const entry = { msg_id: messageId(1), kind: "control", body: "sealed" };
  createCipherFiles(home, "outbox").put(entry);
  assert.deepEqual(cipherEntries(home, "outbox", trace), [entry]);
  assert.deepEqual(trace.synced, []);
  const path = join(home, "outbox", `${entry.msg_id}.json`);
  const io = { ...fs, readdirSync(...args) { const names = fs.readdirSync(...args); fs.unlinkSync(path); return names; } };
  assert.deepEqual(cipherEntries(home, "outbox", { fs: io }), []);
  createCipherFiles(home, "outbox").put(entry);
  const opening = { ...fs, openSync(name, ...args) { if (name === path) fs.unlinkSync(path); return fs.openSync(name, ...args); } };
  assert.deepEqual(cipherEntries(home, "outbox", { fs: opening }), []);
});
