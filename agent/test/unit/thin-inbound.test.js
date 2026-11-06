import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { createThinInbound, THIN_HELD_LIMITS } from "../../src/thin-inbound.js";
import { createInbox } from "../../src/inbox.js";
import { createCipherFiles, readHomeState, updateHomeState } from "../../src/home-state.js";
import { pairProof } from "../../src/pair-code.js";
import { acquireHomeLock } from "../../src/protected-files.js";
import { b64uDecode } from "../../src/encoding.js";
import { readInbox } from "../../src/runtime.js";
import { loadVectors } from "../../src/protocol-files.js";
import { diskFailure, syncTrace } from "../support/thin-home.js";
import { setup, delivery, identity, self, now, keys, messageId } from "../support/thin-transport.js";

test("authenticated legacy diagnostics are stored while stripped current markers stay poison", async t => {
  const { home, transport } = setup(t), inbound = createThinInbound({ home, transport, self, now });
  let seq = 0;
  const cases = loadVectors("envelopes").cases.filter(c => c.name.startsWith("legacy_diagnostics_"));
  assert.equal(cases.length, 3);
  for (const c of cases) {
    const options = { hubId: identity.hub_id, from: keys.dev1.member_id, senderPrivateKey: b64uDecode(keys.dev1.sk),
      recipients: [{ memberId: self.memberId, publicKey: b64uDecode(keys.agent.pk) }] };
    const legacy = await transport.seal({ ...options, kind: c.envelope.kind, plaintext: c.plaintext, msgId: messageId(++seq) });
    assert.equal((await inbound.receive({ ...legacy, seq })).status, "stored");
    const current = await transport.sealMessage({ ...options, innerText: c.plaintext, msgId: messageId(++seq) });
    delete current.diagnostics;
    assert.deepEqual(await inbound.receive({ ...current, seq }), { status: "poison", code: "hpke_open_failed" });
  }
  assert.deepEqual(createInbox(home).read().map(r => r.type), cases.map(c => JSON.parse(c.plaintext).type));
});

test("held sync releases the exact emitted inner JSON after another member has been paged", async t => {
  const { home, transport, pairing } = setup(t, { confirmed: false });
  pairing.join({ member_id: keys.dev2.member_id, public_key: keys.dev2.pk, role: "device" }, { verified: true });
  pairing.confirmFingerprint(keys.dev2.member_id, readHomeState(home).members[keys.dev2.member_id].fingerprint);
  const raw = '{"v":1,"type":"sync","samples":[{"uuid":"fixture","type":"body_mass","value":72,"source":{"device":null,"app":"fixture"},"unknown":1e+2}],"deleted":[],"acks":[],"more":false}';
  assert.equal((await createThinInbound({ home, transport, self, now }).receive(await delivery(transport, 1, raw))).status, "held");
  createInbox(home).append({ seq: 2, from: keys.dev2.member_id, kind: "data", type: "sync", received_at: now().toISOString(), inner: { type: "sync" } });
  const first = readInbox(home);
  pairing.confirmFingerprint(keys.dev1.member_id, readHomeState(home).members[keys.dev1.member_id].fingerprint);
  await createThinInbound({ home, transport, self, now }).releaseHeld();
  const next = readInbox(home, { after_seq: first.next_after_seq });
  assert.deepEqual(next.records.map(r => r.seq), [1]);
  assert.equal(next.records[0].from, keys.dev1.member_id);
  const line = fs.readFileSync(`${home}/inbox/2026-11-05.jsonl`, "utf8").trimEnd().split("\n").at(-1);
  assert.equal(line.slice(line.indexOf(',"inner":') + ',"inner":'.length, -1), raw);
});

test('held release retries contention after trimming without losing raw records', async t => {
  const { home, transport, pairing } = setup(t, { confirmed: false });
  const inbound = createThinInbound({ home, transport, self, now });
  const message = await delivery(transport, 1);
  await inbound.receive(message);
  pairing.confirmFingerprint('m_dev_1', readHomeState(home).members.m_dev_1.fingerprint);
  await inbound.releaseHeld();
  const before = createInbox(home).read();
  const { seq, ...envelope } = message;
  createCipherFiles(home, "held").put({ msg_id: message.msg_id, seq, from: message.from, kind: message.kind, body: JSON.stringify(envelope), received_at: now().toISOString() });
  let acquisitions = 0, transaction, timer;
  const io = new Proxy(fs, { get(target, key) {
    if (key !== 'mkdirSync') return target[key];
    return (path, ...args) => {
      if (path === `${home}/.state.lock` && ++acquisitions === 2) {
        transaction = acquireHomeLock(home, 'state');
        timer = setTimeout(() => transaction.release(), 30);
      }
      return target.mkdirSync(path, ...args);
    };
  } });
  try { await createThinInbound({ home, transport, self, now, fs: io }).releaseHeld(); }
  finally { clearTimeout(timer); transaction?.release(); }
  assert.ok(transaction); assert.ok(acquisitions > 2);
  assert.deepEqual(createInbox(home).read(), before);
});

for (const method of ['fingerprint', 'proof']) test(`${method} confirmation automatically queues agent_info once per version across restarts`, async t => {
  const { home, transport, pairing } = setup(t, { confirmed: false });
  const inbound = version => createThinInbound({ home, transport, self, now, version });
  if (method === 'proof') {
    const proof = Buffer.alloc(32, 1).toString('base64url');
    updateHomeState(home, s => { s.members.m_dev_1.pair_proof = proof; });
    await inbound('1.0.0').receive(await delivery(transport, 1, { v: 1, type: 'pair_proof', proof }));
  } else pairing.confirmFingerprint('m_dev_1', readHomeState(home).members.m_dev_1.fingerprint);
  await inbound('1.0.0').releaseHeld();
  const queue = createCipherFiles(home, 'outbox'), before = queue.list();
  assert.deepEqual(before.map(e => e.type), ['confirmed', 'agent_info']);
  const open = async entry => (await transport.receive({ envelope: JSON.parse(entry.body), hubId: identity.hub_id,
    self: { memberId: keys.dev1.member_id, privateKey: b64uDecode(keys.dev1.sk) }, senderKeyOf: () => b64uDecode(keys.agent.pk) })).inner;
  assert.deepEqual(await open(before[1]), { v: 1, type: 'agent_info', version: '1.0.0' });
  await inbound('1.0.0').releaseHeld();
  assert.deepEqual(queue.list(), before);
  await inbound('1.0.1').releaseHeld();
  assert.equal(queue.list().length, 3);
  assert.deepEqual(await open(queue.list()[2]), { v: 1, type: 'agent_info', version: '1.0.1' });
  assert.equal(readHomeState(home).members.m_dev_1.agent_info_version, '1.0.1');
  pairing.revoke('m_dev_1');
  await inbound('1.0.2').releaseHeld();
  assert.equal(queue.list().length, 3);
});

for (const pattern of [/\/outbox\/\./, /\.state\.json\./]) test(`agent_info recovers after ${pattern} durability failure without resealing or losing receipt progress`, async t => {
  const { home, transport } = setup(t), version = '2.0.0';
  const inbound = fs => createThinInbound({ home, transport, self, now, version, fs });
  await assert.rejects(inbound(diskFailure('renameSync', 1, pattern)).releaseHeld(), { code: 'ENOSPC' });
  assert.notEqual(readHomeState(home).members.m_dev_1.agent_info_version, version);
  const queue = createCipherFiles(home, 'outbox'), prior = queue.list()[0];
  if (prior) queue.update(prior.msg_id, { state: 'sent', attempts: 1, seq: 10 });
  await inbound().releaseHeld();
  assert.equal(queue.list().length, 1);
  assert.equal(readHomeState(home).members.m_dev_1.agent_info_version, version);
  if (prior) {
    assert.equal(queue.list()[0].body, prior.body);
    assert.equal(queue.list()[0].state, 'sent');
    assert.equal(queue.list()[0].seq, 10);
  }
});

test('concurrent version observers queue one durable agent_info', async t => {
  const { home, transport } = setup(t);
  await Promise.all(Array.from({ length: 3 }, () => createThinInbound({ home, transport, self, now, version: '2.0.0' }).releaseHeld()));
  assert.equal(createCipherFiles(home, 'outbox').list().length, 1);
  assert.equal(readHomeState(home).members.m_dev_1.agent_info_version, '2.0.0');
});

for (const reason of ['joined', 'unpaired', 'revoked', 'hub_revoked', 'hub_deleted']) test(`agent_info is not queued for ${reason} targets`, async t => {
  const { home, transport } = setup(t, { confirmed: reason !== 'joined' });
  updateHomeState(home, s => {
    if (reason === 'unpaired') s.members.m_dev_1.unpair_reason = 'user';
    if (reason === 'revoked') s.members.m_dev_1.state = 'revoked';
    if (reason.startsWith('hub_')) s.transport[reason] = true;
  });
  await createThinInbound({ home, transport, self, now, version: '2.0.0' }).releaseHeld();
  assert.equal(createCipherFiles(home, 'outbox').list().length, 0);
});

test("unknown reconciliation, notice and proof fields preserve pairing and verbatim held release", async t => {
  const { home, transport } = setup(t, { confirmed: false }), proof = Buffer.alloc(32, 1).toString("base64url");
  updateHomeState(home, s => { s.members.m_dev_1.pair_proof = proof; });
  const member = { member_id: "m_dev_1", public_key: keys.dev1.pk, role: "device", future: { metadata: true } };
  const inbound = () => createThinInbound({ home, transport, self, now, relay: { listMembers: async () => ({ members: [member], future: true }) } });
  assert.equal((await inbound().receive({ seq: 1, kind: "system", event: "member_joined", body: member, future: true })).status, "metadata");
  const dataRaw = '{ "type":"sync", "future":{"extra":1e+2} }';
  assert.equal((await inbound().receive({ ...await delivery(transport, 2, dataRaw), delivery: true })).status, "held");
  const proofRaw = `{ "v":1, "type":"pair_proof", "proof":"${proof}", "future":{"extra":true} }`;
  const message = { ...await delivery(transport, 3, proofRaw), delivery: { attempt: 1 } };
  message.recipients[0].future = true;
  assert.equal((await inbound().receive(message)).status, "stored");
  assert.equal(readHomeState(home).members.m_dev_1.state, "confirmed");
  assert.equal(createCipherFiles(home, "held").list().length, 0);
  assert.deepEqual(createInbox(home).read().map(r => r.seq), [3, 2]);
  const stored = fs.readFileSync(`${home}/inbox/2026-11-05.jsonl`, "utf8");
  for (const raw of [dataRaw, proofRaw]) assert.ok(stored.includes(raw));
});

for (const [operation, count, pattern] of [["renameSync", 1, /\/outbox\/\./], ["renameSync", 2, /\.state\.json\./]]) test(`confirmation recovers its reply and fast polling after ${pattern} failure`, async t => {
  const { home, transport } = setup(t, { confirmed: false }), proof = Buffer.alloc(32, 1).toString("base64url");
  updateHomeState(home, s => { s.members.m_dev_1.pair_proof = proof; s.members.m_dev_1.join_grace_until = now().getTime() + 900000; });
  const message = await delivery(transport, 1, { v: 1, type: "pair_proof", proof });
  await assert.rejects(createThinInbound({ home, transport, self, now, fs: diskFailure(operation, count, pattern) }).receive(message), { code: "ENOSPC" });
  const state = readHomeState(home), prior = createCipherFiles(home, "outbox").list()[0];
  assert.equal(state.members.m_dev_1.state, "confirmed");
  assert.deepEqual(state.transport.fast_poll.devices, ["m_dev_1"]);
  assert.equal(state.transport.fast_poll.until, now().getTime() + 840000);
  await createThinInbound({ home, transport, self, now }).releaseHeld();
  const queued = createCipherFiles(home, "outbox").list();
  assert.equal(queued.length, 2); assert.deepEqual(queued.map(e => e.type), ["confirmed", "agent_info"]);
  if (prior) assert.equal(queued[0].body, prior.body);
  await createThinInbound({ home, transport, self, now }).receive(message);
  assert.equal(createCipherFiles(home, "outbox").list().length, 2);
});

test("confirmation recovery preserves concurrent outbox receipt progress", async t => {
  const { home, transport } = setup(t, { confirmed: false }), proof = Buffer.alloc(32, 1).toString("base64url");
  updateHomeState(home, s => { s.members.m_dev_1.pair_proof = proof; });
  await assert.rejects(createThinInbound({ home, transport, self, now, fs: diskFailure("renameSync", 2, /\.state\.json\./) }).receive(
    await delivery(transport, 1, { v: 1, type: "pair_proof", proof })), { code: "ENOSPC" });
  const queue = createCipherFiles(home, "outbox"), queued = queue.list()[0];
  const recovering = createThinInbound({ home, transport, self, now }).releaseHeld();
  queue.update(queued.msg_id, { attempts: 1, state: "sent", seq: 10 });
  await recovering;
  assert.equal(queue.list().length, 2); assert.deepEqual(queue.list().map(e => e.type).sort(), ["agent_info", "confirmed"]);
  const recovered = queue.list().find(e => e.msg_id === queued.msg_id);
  assert.equal(recovered.body, queued.body); assert.equal(recovered.state, "sent"); assert.equal(recovered.seq, 10);
});

test("unknown controls and every command version survive replay/restart in either order", async t => {
  const { home, transport } = setup(t);
  const inbound = () => createThinInbound({ home, transport, self, now });
  const raw = '{ "type":"future", "v":999, "raw": {"extra":1e+2} }';
  const rows = [await delivery(transport, 1, raw)];
  for (const [seq, version] of [[2, 159], [3, 158], [4, 159]]) rows.push(await delivery(transport, seq, { type: "sync", acks: [{ command_id: "c_158", version, status: "applied" }], extra: true }));
  for (const r of rows) { await inbound().receive(r); await inbound().receive(r); }
  const records = createInbox(home).read();
  assert.equal(records.length, 4); assert.deepEqual(records.slice(1).map(r => r.inner.acks[0].version), [159, 158, 159]);
  assert.ok(fs.readFileSync(`${home}/inbox/2026-11-05.jsonl`, "utf8").includes(raw));
});
test("joined ciphertext is durable before confirmation; proof is appended before held messages release in relay order", async t => {
  const { home, transport } = setup(t, { confirmed: false });
  const expected = pairProof(Buffer.alloc(16, 1).toString("base64url"), identity.public_key, keys.dev1.pk);
  updateHomeState(home, s => { s.members.m_dev_1.pair_proof = expected; });
  const inbound = createThinInbound({ home, transport, self, now });
  for (const seq of [2, 1]) assert.equal((await inbound.receive(await delivery(transport, seq))).status, "held");
  assert.equal(createInbox(home).read().length, 0);
  assert.equal(createCipherFiles(home, "held").list().length, 2);
  assert.equal((await inbound.receive(await delivery(transport, 3, { type: "pair_proof", v: 1, proof: expected }))).status, "stored");
  assert.equal(readHomeState(home).members.m_dev_1.state, "confirmed");
  await createThinInbound({ home, transport, self, now }).releaseHeld();
  assert.deepEqual(createInbox(home).read().map(r => r.seq), [3, 1, 2]);
  assert.equal(createCipherFiles(home, "held").list().length, 0);
});
for (const expected of [null, Buffer.alloc(32, 1).toString("base64url")]) test(`rejected proof with ${expected ? "mismatched" : "missing"} expectation never enters the inbox`, async t => {
  const { home, transport, pairing } = setup(t, { confirmed: false });
  updateHomeState(home, s => { s.members.m_dev_1.pair_proof = expected; });
  const inbound = () => createThinInbound({ home, transport, self, now });
  await inbound().receive(await delivery(transport, 1));
  const held = createCipherFiles(home, "held").list();
  const rejected = await delivery(transport, 2, { v: 1, type: "pair_proof", proof: Buffer.alloc(32, 2).toString("base64url") });
  assert.deepEqual(await inbound().receive(rejected), { status: "poison", code: "pair_proof_invalid" });
  await inbound().releaseHeld();
  assert.equal(readHomeState(home).members.m_dev_1.state, "joined");
  assert.equal(readHomeState(home).members.m_dev_1.proof_invalidated, true);
  assert.equal(createInbox(home).read().length, 0);
  assert.deepEqual(createCipherFiles(home, "held").list(), held);
  pairing.confirmFingerprint("m_dev_1", readHomeState(home).members.m_dev_1.fingerprint);
  await inbound().releaseHeld();
  assert.deepEqual(createInbox(home).read().map(r => r.seq), [1]);
});

for (const confirmed of [true, false]) test(`cancellation after decrypt prevents ${confirmed ? "inbox storage" : "proof confirmation"}`, async t => {
  const { home, transport } = setup(t, { confirmed }), controller = new AbortController();
  const proof = Buffer.alloc(32, 1).toString("base64url");
  if (!confirmed) updateHomeState(home, s => { s.members.m_dev_1.pair_proof = proof; });
  const message = await delivery(transport, 1, confirmed ? { type: "future" } : { v: 1, type: "pair_proof", proof });
  const receive = transport.receive;
  transport.receive = async options => { const parsed = await receive(options); controller.abort(); return parsed; };
  await assert.rejects(createThinInbound({ home, transport, self, now }).receive(message, { signal: controller.signal }), { name: "AbortError" });
  assert.equal(createInbox(home).read().length, 0);
  assert.equal(readHomeState(home).members.m_dev_1.state, confirmed ? "confirmed" : "joined");
  assert.equal(createCipherFiles(home, "outbox").list().length, 0);
});

test("verified proof recovers verbatim after inbox failure following confirmation", async t => {
  const { home, transport } = setup(t, { confirmed: false }), proof = Buffer.alloc(32, 1).toString("base64url");
  updateHomeState(home, s => { s.members.m_dev_1.pair_proof = proof; });
  const raw = `{ "v":1, "type":"pair_proof", "proof":"${proof}", "future":true }`, message = await delivery(transport, 1, raw);
  await assert.rejects(createThinInbound({ home, transport, self, now, fs: diskFailure("writeSync", 1, /\.jsonl$/) }).receive(message), { code: "ENOSPC" });
  assert.equal(readHomeState(home).members.m_dev_1.state, "confirmed");
  assert.equal(createInbox(home).read().length, 0);
  await createThinInbound({ home, transport, self, now }).receive(message);
  assert.deepEqual(createInbox(home).read().map(r => r.seq), [1]);
  assert.ok(fs.readFileSync(`${home}/inbox/2026-11-05.jsonl`, "utf8").includes(raw));
});

test("a reconciliation response arriving after cancellation cannot revoke trust", async t => {
  const { home, transport } = setup(t), controller = new AbortController(), deadline = now().getTime() + 15000;
  const relay = { listMembers: async options => {
    assert.equal(options.signal, controller.signal); assert.equal(options.deadline, deadline); assert.equal(options.retry, false);
    controller.abort(); return { members: [] };
  } };
  await assert.rejects(createThinInbound({ home, transport, self, now, relay }).receive(
    { seq: 1, kind: "system", event: "member_revoked", body: { member_id: "m_dev_1" } }, { signal: controller.signal, deadline }), { name: "AbortError" });
  assert.equal(readHomeState(home).members.m_dev_1.state, "confirmed");
});

test("plaintext notices require relay reconciliation and cannot insert authenticated inners", async t => {
  const { home, transport } = setup(t);
  const message = { seq: 1, msg_id: messageId(1), kind: "system", event: "member_revoked", body: { member_id: "m_dev_1" } };
  let members = [{ member_id: "m_dev_1", public_key: keys.dev1.pk, role: "device" }];
  const inbound = createThinInbound({ home, transport, self, now, relay: { listMembers: async () => ({ members }) } });
  await inbound.receive(message); assert.equal(readHomeState(home).members.m_dev_1.state, "confirmed");
  members = []; await inbound.receive(message);
  assert.equal(readHomeState(home).members.m_dev_1.state, "revoked");
  assert.equal(createInbox(home).read().length, 0);
});

for (const reason of ["user", "reset", "replaced", "delete_relay_data"]) test(`unpair ${reason} keeps the first reason and releases confirmed held data before reconciled revocation`, async t => {
  const { home, transport, pairing } = setup(t, { confirmed: false });
  const held = createCipherFiles(home, "held");
  let members = [{ member_id: "m_dev_1", public_key: keys.dev1.pk, role: "device" }], reconciliationError, calls = 0;
  const relay = { listMembers: async () => { calls++; if (reconciliationError) throw reconciliationError; return { members }; } };
  const inbound = () => createThinInbound({ home, transport, self, now, relay });
  await inbound().receive(await delivery(transport, 1));
  const heldBefore = held.list();
  pairing.confirmFingerprint("m_dev_1", readHomeState(home).members.m_dev_1.fingerprint);
  assert.equal((await inbound().receive(await delivery(transport, 2, { v: 1, type: "unpair", reason }))).status, "stored");
  assert.equal(readHomeState(home).members.m_dev_1.state, "confirmed");
  assert.equal(readHomeState(home).members.m_dev_1.unpair_reason, reason);
  assert.deepEqual(held.list(), heldBefore);
  const repeatedReason = reason === "user" ? "delete_relay_data" : "user";
  assert.equal((await inbound().receive(await delivery(transport, 3, { v: 1, type: "unpair", reason: repeatedReason }))).status, "stored");
  assert.equal(readHomeState(home).members.m_dev_1.unpair_reason, reason);
  assert.equal(calls, 0);
  const inboxBefore = fs.readFileSync(`${home}/inbox/2026-11-05.jsonl`);
  assert.deepEqual(createInbox(home).read().map(r => r.inner.reason), [reason, repeatedReason]);
  const revoked = { seq: 4, kind: "system", event: "member_revoked", body: { member_id: "m_dev_1" } };
  reconciliationError = Object.assign(new Error("fixture reconciliation failed"), { status: 503 });
  await assert.rejects(inbound().receive(revoked), reconciliationError);
  assert.equal(readHomeState(home).members.m_dev_1.state, "confirmed");
  assert.deepEqual(held.list(), heldBefore);
  reconciliationError = null;
  await inbound().receive(revoked);
  assert.equal(readHomeState(home).members.m_dev_1.state, "confirmed");
  assert.deepEqual(held.list(), heldBefore);
  members = []; await inbound().receive(revoked);
  assert.equal(readHomeState(home).members.m_dev_1.state, "revoked");
  assert.equal(readHomeState(home).members.m_dev_1.unpair_reason, reason);
  assert.equal(held.list().length, 0);
  assert.ok(fs.readFileSync(`${home}/inbox/2026-11-05.jsonl`).subarray(0, inboxBefore.length).equals(inboxBefore));
  assert.deepEqual(createInbox(home).read().map(r => r.seq), [2, 3, 1]);
  assert.equal((await inbound().receive(await delivery(transport, 5, { type: "future" }))).code, "unknown_sender");
});

test("held authentic messages reach the inbox after an unpair notice without losing their original receive time", async t => {
  const { home, transport, pairing } = setup(t, { confirmed: false });
  await createThinInbound({ home, transport, self, now }).receive(await delivery(transport, 1));
  pairing.confirmFingerprint("m_dev_1", readHomeState(home).members.m_dev_1.fingerprint);
  const inbound = createThinInbound({ home, transport, self, now: () => new Date(now().getTime() + 60000) });
  await inbound.receive(await delivery(transport, 2, { v: 1, type: "unpair", reason: "user" }));
  await inbound.releaseHeld();
  const rows = createInbox(home).read();
  assert.deepEqual(rows.map(r => r.seq), [2, 1]);
  assert.equal(rows.find(r => r.seq === 1).received_at, now().toISOString());
  assert.equal(createCipherFiles(home, "held").list().length, 0);
});

test("migrated system events reconcile before removal and retain ciphertext on failed reconciliation", async t => {
  const { home, transport } = setup(t), held = createCipherFiles(home, "held");
  const joined = { member_id: keys.dev2.member_id, public_key: keys.dev2.pk, role: "device" };
  for (const [seq, event, body] of [[1, "member_joined", joined], [2, "member_revoked", { member_id: "m_dev_1" }]]) {
    held.put({ msg_id: messageId(seq), seq, from: "relay", kind: "system", legacy_state: "new", received_at: now().toISOString(), body: JSON.stringify({ seq, kind: "system", event, body }) });
  }
  const before = held.list(); let calls = 0;
  const failing = createThinInbound({ home, transport, self, now, relay: { listMembers: async () => { throw { status: 503 }; } } });
  await assert.rejects(failing.releaseHeld()); assert.deepEqual(held.list(), before);
  const relay = { listMembers: async () => { calls++; return { members: [joined] }; } };
  await createThinInbound({ home, transport, self, now, relay }).releaseHeld();
  assert.equal(calls, 2); assert.equal(held.list().length, 0);
  const state = readHomeState(home);
  assert.equal(state.members[joined.member_id].state, "joined");
  assert.equal(state.members.m_dev_1.state, "revoked");
  assert.equal(createInbox(home).read().length, 0);
  assert.deepEqual(state.transport.events.map(e => e.seq), [1, 2]);
});

test("migrated pending proof releases earlier held data before replaying revocation", async t => {
  const { home, transport } = setup(t, { confirmed: false }), held = createCipherFiles(home, "held"), proof = Buffer.alloc(32, 1).toString("base64url");
  updateHomeState(home, s => { s.members.m_dev_1.pair_proof = proof; });
  const rows = [await delivery(transport, 1), await delivery(transport, 2, { v: 1, type: "pair_proof", proof }),
    { seq: 3, msg_id: messageId(3), kind: "system", event: "member_revoked", body: { member_id: "m_dev_1" } }];
  for (const row of rows) held.put({ msg_id: row.msg_id, seq: row.seq, from: row.from ?? "relay", kind: row.kind === "system" ? "system" : "data",
    legacy_state: row.seq === 1 ? "held" : "new", held_member: row.seq === 1 ? row.from : null, body: JSON.stringify(row), received_at: now().toISOString() });
  await createThinInbound({ home, transport, self, now, relay: { listMembers: async () => ({ members: [] }) } }).releaseHeld();
  assert.deepEqual(createInbox(home).read().map(r => r.seq), [2, 1]);
  assert.equal(readHomeState(home).members.m_dev_1.state, "revoked"); assert.equal(held.list().length, 0);
});

test("migrated pending non-proof ciphertext stays encrypted until manual confirmation", async t => {
  const { home, transport, pairing } = setup(t, { confirmed: false }), held = createCipherFiles(home, "held"), row = await delivery(transport, 1);
  held.put({ msg_id: row.msg_id, seq: row.seq, from: row.from, kind: "data", legacy_state: "new", body: JSON.stringify(row), received_at: now().toISOString() });
  const before = held.list(), inbound = () => createThinInbound({ home, transport, self, now });
  await inbound().releaseHeld(); assert.equal(held.list()[0].body, before[0].body); assert.equal(createInbox(home).read().length, 0);
  pairing.confirmFingerprint("m_dev_1", readHomeState(home).members.m_dev_1.fingerprint);
  await inbound().releaseHeld(); assert.equal(held.list().length, 0); assert.equal(createInbox(home).read()[0].seq, 1);
});

for (const limit of ["rows", "bytes"]) test(`held ${limit} cap evicts oldest per member, records overflow, and survives restart/replay`, async t => {
  assert.deepEqual(THIN_HELD_LIMITS, { rows: 2000, bytes: 64 * 1024 * 1024 });
  const { home, transport, pairing } = setup(t, { confirmed: false }), held = createCipherFiles(home, "held");
  pairing.join({ member_id: keys.dev2.member_id, public_key: keys.dev2.pk, role: "device" }, { verified: true });
  const rows = await Promise.all([1, 2, 3].map(seq => delivery(transport, seq)));
  const bytes = Buffer.byteLength(transport.serialize(rows[0]));
  const heldLimits = limit === "rows" ? { rows: 2, bytes: 1e9 } : { rows: 100, bytes: bytes * 2 };
  held.put({ msg_id: messageId(99), seq: 99, from: keys.dev2.member_id, kind: "data", body: "unrelated ciphertext" });
  const inbound = fs => createThinInbound({ home, transport, self, now, heldLimits, fs });
  for (const row of rows) await inbound().receive(row);
  assert.deepEqual(held.list().map(e => e.seq), [2, 3, 99]);
  assert.ok(readHomeState(home).transport.events.some(e => e.code === "held_overflow" && e.seq === 1 && e.member_id === "m_dev_1"));
  await inbound().receive(rows[2]); await inbound().releaseHeld();
  assert.deepEqual(held.list().map(e => e.seq), [2, 3, 99]); assert.equal(createInbox(home).read().length, 0);
  pairing.confirmFingerprint("m_dev_1", readHomeState(home).members.m_dev_1.fingerprint);
  await inbound().releaseHeld(); assert.deepEqual(createInbox(home).read().map(r => r.seq), [2, 3]);
  assert.deepEqual(held.list().map(e => e.seq), [99]);
});

test("migrated malformed ciphertext makes poison progress without removing a failed metadata checkpoint", async t => {
  const { home, transport } = setup(t), held = createCipherFiles(home, "held");
  held.put({ msg_id: messageId(1), seq: 1, from: "relay", kind: "system", legacy_state: "new", body: "{" });
  await assert.rejects(createThinInbound({ home, transport, self, now, fs: diskFailure("renameSync", 1, /\.state\.json\./) }).releaseHeld(), { code: "ENOSPC" });
  assert.equal(held.list().length, 1);
  await createThinInbound({ home, transport, self, now }).releaseHeld();
  assert.equal(held.list().length, 0); assert.equal(readHomeState(home).transport.events[0].code, "malformed");
});

for (const [operation, pattern] of [["renameSync", /\.state\.json\./], ["unlinkSync", /\/held\/[^.].*\.json$/]]) test(`held overflow ${operation} failure remains retryable before receive can succeed`, async t => {
  const { home, transport } = setup(t, { confirmed: false }), heldLimits = { rows: 1, bytes: 1e9 };
  const rows = await Promise.all([1, 2].map(seq => delivery(transport, seq)));
  await createThinInbound({ home, transport, self, now, heldLimits }).receive(rows[0]);
  await assert.rejects(createThinInbound({ home, transport, self, now, heldLimits, fs: diskFailure(operation, 1, pattern) }).receive(rows[1]), { code: "ENOSPC" });
  await createThinInbound({ home, transport, self, now, heldLimits }).releaseHeld();
  assert.deepEqual(createCipherFiles(home, "held").list().map(e => e.seq), [2]);
});

test("migrated new ciphertext acquires held bounds without rewriting its raw envelope", async t => {
  const { home, transport } = setup(t, { confirmed: false }), held = createCipherFiles(home, "held");
  const rows = await Promise.all([1, 2, 3].map(seq => delivery(transport, seq)));
  for (const row of rows) held.put({ msg_id: row.msg_id, seq: row.seq, from: row.from, kind: "data", legacy_state: "new", body: JSON.stringify(row), received_at: now().toISOString() });
  await createThinInbound({ home, transport, self, now, heldLimits: { rows: 2, bytes: 1e9 } }).releaseHeld();
  const entries = held.list();
  assert.deepEqual(entries.map(e => e.seq), [2, 3]); assert.ok(entries.every(e => e.legacy_state === "held"));
  assert.deepEqual(entries.map(e => e.body), rows.slice(1).map(row => JSON.stringify(row)));
  assert.equal(createInbox(home).read().length, 0);
});

test("held bounds do not evict an unprocessed migrated proof before authentication", async t => {
  const { home, transport } = setup(t, { confirmed: false }), held = createCipherFiles(home, "held"), proof = Buffer.alloc(32, 1).toString("base64url");
  updateHomeState(home, s => { s.members.m_dev_1.pair_proof = proof; });
  const rows = [await delivery(transport, 1, { v: 1, type: "pair_proof", proof }), await delivery(transport, 2), await delivery(transport, 3)];
  for (const row of rows) held.put({ msg_id: row.msg_id, seq: row.seq, from: row.from, kind: "data", legacy_state: "new", body: JSON.stringify(row), received_at: now().toISOString() });
  await createThinInbound({ home, transport, self, now, heldLimits: { rows: 1, bytes: 1e9 } }).releaseHeld();
  assert.equal(readHomeState(home).members.m_dev_1.state, "confirmed");
  assert.deepEqual(createInbox(home).read().map(r => r.seq), [1, 2, 3]); assert.equal(held.list().length, 0);
});

test("empty held maintenance finishes an interrupted deletion without a state transaction", async t => {
  const { home, transport } = setup(t), held = createCipherFiles(home, "held");
  const entry = { msg_id: messageId(1), seq: 1, kind: "control", body: "sealed" };
  held.put(entry);
  assert.throws(() => createCipherFiles(home, "held", { fs: diskFailure("fsyncSync", 1, /\/held$/) }).remove(entry.msg_id), { code: "ENOSPC" });
  assert.equal(fs.existsSync(`${home}/held/${entry.msg_id}.json`), false);
  const retry = syncTrace();
  await createThinInbound({ home, transport, self, now, ...retry }).releaseHeld();
  assert.deepEqual(retry.synced, [`${home}/held`]);
});

test("nonempty held maintenance finishes an interrupted overflow eviction before success", async t => {
  const { home, transport } = setup(t, { confirmed: false }), heldLimits = { rows: 1, bytes: 1e9 };
  const inbound = options => createThinInbound({ home, transport, self, now, heldLimits, ...options });
  await inbound().receive(await delivery(transport, 1));
  const dir = `${home}/held`, evicted = `${dir}/${messageId(1)}.json`;
  const interrupted = syncTrace(path => {
    if (path === dir && !fs.existsSync(evicted)) throw Object.assign(new Error("fixture disk failure"), { code: "ENOSPC" });
  });
  await assert.rejects(inbound(interrupted).receive(await delivery(transport, 2)), { code: "ENOSPC" });
  assert.equal(fs.existsSync(evicted), false);
  const retained = createCipherFiles(home, "held").list();
  assert.deepEqual(retained.map(e => e.seq), [2]);
  await assert.rejects(inbound({ fs: diskFailure("fsyncSync", 1, /\/held$/) }).releaseHeld(), { code: "ENOSPC" });
  const retry = syncTrace();
  await inbound(retry).releaseHeld();
  assert.ok(retry.synced.includes(dir));
  assert.deepEqual(createCipherFiles(home, "held").list(), retained);
  assert.equal(readHomeState(home).members.m_dev_1.state, "joined");
  assert.deepEqual(readHomeState(home).transport.events.map(e => [e.seq, e.code]), [[1, "held_overflow"]]);
  assert.deepEqual(createInbox(home).read(), []);
});
