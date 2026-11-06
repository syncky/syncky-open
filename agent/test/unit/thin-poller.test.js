import assert from "node:assert/strict";
import { test } from "node:test";
import { createThinPoller } from "../../src/thin-poller.js";
import { createRelayClient } from "../../src/relay-client.js";
import { createInbox } from "../../src/inbox.js";
import { createCipherFiles, readHomeState, updateHomeState } from "../../src/home-state.js";
import fs from "node:fs";
import { diskFailure } from "../support/thin-home.js";
import { fixture } from "../support/thin-home.js";
import { createHomeState } from "../../src/home-state.js";
import { createThinTransport } from "../../src/thin-transport.js";
import { createThinPairing } from "../../src/thin-pairing.js";
import { createOutbox } from "../../src/outbox.js";
import { acquireHomeLock } from "../../src/protected-files.js";
import { pairProof } from "../../src/pair-code.js";
import { b64uDecode } from "../../src/encoding.js";
import { setup, delivery, self, now, identity, keys, messageId, tablePath } from "../support/thin-transport.js";

for (const [kind, size] of [["control", 10], ["data", 10], ["data", 180010]]) test(`unlisted ${kind} inner (${size} bytes) reaches the durable inbox before ACK`, async t => {
  const { home, transport } = setup(t), raw = JSON.stringify({ type: "future_data", extra: "x".repeat(size) });
  const envelope = await transport.seal({ hubId: identity.hub_id, from: keys.dev1.member_id, senderPrivateKey: b64uDecode(keys.dev1.sk),
    recipients: [{ memberId: self.memberId, publicKey: b64uDecode(keys.agent.pk) }], kind, plaintext: raw, msgId: messageId(1) });
  let acks = 0;
  const relay = { getMessages: async () => ({ messages: [{ ...envelope, seq: 1 }], next_after: 1 }), ack: async seq => {
    const record = createInbox(home).read()[0];
    assert.equal(record.kind, kind); assert.equal(record.type, "future_data");
    assert.ok(JSON.stringify(record.inner) === raw, "inner bytes changed");
    assert.equal(seq, 1); acks++;
  } };
  await createThinPoller({ home, transport, self, relay, now }).once();
  assert.equal(acks, 1); assert.equal(readHomeState(home).transport.acked_seq, 1);
});

test('one-shot receive waits for a CLI transaction before pruning', async t => {
  const { home, transport } = setup(t), transaction = acquireHomeLock(home, 'state');
  const timer = setTimeout(() => transaction.release(), 30);
  const relay = { getMessages: async () => ({ messages: [] }) };
  try { assert.equal((await createThinPoller({ home, transport, self, relay, now }).once()).pages, 1); }
  finally { clearTimeout(timer); transaction.release(); }
});

test('one-shot callers retry a short receiver lease and retain a full bounded cycle after acquisition', async t => {
  const { home, transport } = setup(t), lease = acquireHomeLock(home, 'receiver', { role: 'once' });
  const started = now().getTime(); let at = started, sleeps = 0;
  const poller = createThinPoller({ home, transport, self, relay: { getMessages: async () => ({ messages: [] }) },
    now: () => new Date(at), sleep: async ms => { at += ms; if (++sleeps === 150) lease.release(); },
    watchPairing: async ({ deadline }) => { assert.equal(deadline, at + 15000); },
  });
  try { assert.equal((await poller.once()).pages, 1); assert.equal(sleeps, 150); assert.equal(at - started, 15000); }
  finally { lease.release(); }
});

for (const abort of [false, true]) test(`one-shot lease retries respect ${abort ? 'cancellation' : 'an explicit deadline'}`, async t => {
  const { home, transport } = setup(t), lease = acquireHomeLock(home, 'receiver'), controller = new AbortController();
  let at = now().getTime(); const sleeps = [], deadline = at + 250;
  const poller = createThinPoller({ home, transport, self, relay: {}, now: () => new Date(at), sleep: async ms => {
    sleeps.push(ms); at += ms; if (abort) controller.abort();
  } });
  try {
    await assert.rejects(poller.once({ signal: controller.signal, deadline }), abort ? { name: 'AbortError' } : { code: 'home_locked' });
    assert.deepEqual(sleeps, abort ? [100] : [100, 100, 50]);
  } finally { lease.release(); }
});

test('one-shot pairing watcher receives the caller cancellation and bounded deadline', async t => {
  const { home, transport } = setup(t), controller = new AbortController();
  const deadline = now().getTime() + 500;
  const poller = createThinPoller({ home, transport, self, relay: {}, now, watchPairing: async context => {
    assert.equal(context.deadline, deadline);
    controller.abort(new Error('pairing watcher cancelled'));
    context.signal.throwIfAborted();
  } });
  await assert.rejects(poller.once({ signal: controller.signal, deadline }), /pairing watcher cancelled/);
});

for (const confirmed of [true, false]) for (const failStore of [false, true]) test(`extended relay responses reach durable ${confirmed ? "inbox" : "hold"} before ACK${failStore ? " after a storage failure and restart" : ""}`, async t => {
  const { home, transport, pairing } = setup(t, { confirmed });
  const raws = ['{ "type":"sync", "v":999, "future":{"value":1e+2} }', '{ "type":"future", "future":[true,{"extra":null}] }'];
  const messages = await Promise.all(raws.map(async (raw, i) => {
    const row = await delivery(transport, i + 1, raw);
    return { ...row, received_at: "relay extension", delivery: { attempt: 1 }, recipients: row.recipients.map(r => ({ ...r, future: true })) };
  }));
  let acks = 0;
  const relay = createRelayClient({ baseUrl: "https://relay.example", token: "fixture-token", now: () => now().getTime(), fetch: async (_url, options) => {
    if (options.method === "GET") return Response.json({ messages, next_after: 2, has_more: false, future: { page: true }, queue: { hub_bytes: 1, sender_rows: 1, max_hub_bytes: 100, max_sender_rows: 100, as_of: now().toISOString(), future: true } });
    assert.deepEqual(JSON.parse(options.body), { up_to_seq: 2 });
    assert.deepEqual((confirmed ? createInbox(home).read() : createCipherFiles(home, "held").list()).map(r => r.seq), [1, 2]);
    acks++; return Response.json({ acked: 2, cursor: 2, future: { receipt: true } });
  } });
  if (failStore) {
    const io = confirmed ? diskFailure("writeSync", 1, /\.jsonl$/) : diskFailure("renameSync", 1, /\/held\/\./);
    await assert.rejects(createThinPoller({ home, transport, self, relay, now, fs: io }).once(), { code: "ENOSPC" });
    assert.equal(acks, 0); assert.equal(readHomeState(home).transport.cursor, 0);
  }
  await createThinPoller({ home, transport, self, relay, now }).once();
  assert.equal(acks, 1); assert.equal(readHomeState(home).transport.acked_seq, 2);
  assert.deepEqual(readHomeState(home).transport.events ?? [], []);
  if (!confirmed) {
    pairing.confirmFingerprint("m_dev_1", readHomeState(home).members.m_dev_1.fingerprint);
    await createThinPoller({ home, transport, self, relay, now }).once();
    assert.equal(createCipherFiles(home, "held").list().length, 0);
  }
  assert.deepEqual(createInbox(home).read().map(r => r.inner), raws.map(raw => JSON.parse(raw)));
  const stored = fs.readFileSync(`${home}/inbox/2026-11-05.jsonl`, "utf8");
  for (const raw of raws) assert.ok(stored.includes(raw));
});

test("pair, hold, proof, confirmed reply, data and revocation preserve the whole lifecycle in one page", async t => {
  const home = fixture(t), transport = createThinTransport({ tablePath }); createHomeState(home, identity);
  const pairingId = `p_${"P".repeat(22)}`, secret = Buffer.alloc(16, 1).toString("base64url");
  fs.writeFileSync(`${home}/pairing.json`, JSON.stringify({ pairing_id: pairingId, pair_secret: secret }), { mode: 0o600 });
  updateHomeState(home, s => { s.pairings[pairingId] = { pairing_id: pairingId, status: "pending", expires_at: "2026-11-06T00:00:00Z" }; });
  const member = { member_id: "m_dev_1", role: "device", public_key: keys.dev1.pk, pairing_id: pairingId, joined_at: now().toISOString() };
  const rows = [
    { seq: 1, kind: "system", event: "member_joined", body: member },
    await delivery(transport, 2, { type: "sync", more: true, future: { keep: true } }),
    await delivery(transport, 3, { v: 1, type: "pair_proof", proof: pairProof(secret, identity.public_key, keys.dev1.pk) }),
    await delivery(transport, 4, { type: "sync", more: false }),
    await delivery(transport, 5, { v: 1, type: "unpair", reason: "user" }),
    { seq: 6, kind: "system", event: "member_revoked", body: { member_id: member.member_id } },
  ];
  let lists = 0, confirmed;
  const receive = transport.receive;
  transport.receive = async options => {
    if (options.envelope.msg_id === messageId(4)) {
      assert.deepEqual(createInbox(home).read().map(r => r.seq), [3, 2]);
      assert.equal(createCipherFiles(home, "held").list().length, 0);
      const state = readHomeState(home);
      assert.deepEqual(state.transport.fast_poll.devices, [member.member_id]);
      assert.equal(state.transport.fast_poll.until, now().getTime() + 840000);
      confirmed = createCipherFiles(home, "outbox").list().find(e => e.type === "confirmed");
      assert.equal(confirmed?.state, "pending");
      const parsed = await receive({ envelope: JSON.parse(confirmed.body), hubId: identity.hub_id,
        self: { memberId: member.member_id, privateKey: b64uDecode(keys.dev1.sk) }, senderKeyOf: () => b64uDecode(keys.agent.pk) });
      assert.deepEqual(parsed.inner, { v: 1, type: "confirmed" });
    }
    return receive(options);
  };
  const relay = { getMessages: async () => ({ messages: rows, next_after: 6 }),
    listMembers: async () => ({ members: ++lists === 1 ? [member] : [] }),
    ack: async seq => {
      assert.equal(seq, 6); assert.deepEqual(createInbox(home).read().map(r => r.seq), [3, 2, 4, 5]);
    } };
  await createThinPoller({ home, transport, self, relay, now }).once();
  assert.ok(confirmed); assert.equal(readHomeState(home).transport.acked_seq, 6);
  assert.equal(readHomeState(home).members.m_dev_1.state, "revoked");
  assert.equal(readHomeState(home).transport.fast_poll.devices.length, 0);
  assert.equal(createCipherFiles(home, "outbox").list().find(e => e.msg_id === confirmed.msg_id).code, "target_revoked");
  assert.equal(createThinPairing(home).trustedKey(member.member_id), null);
});

test("held seq1 reaches durable inbox before proof seq2 and revocation seq3 can be ACKed", async t => {
  const { home, transport } = setup(t, { confirmed: false }), proof = Buffer.alloc(32, 1).toString("base64url");
  updateHomeState(home, s => { s.members.m_dev_1.pair_proof = proof; });
  const messages = [await delivery(transport, 1), await delivery(transport, 2, { v: 1, type: "pair_proof", proof }),
    { seq: 3, kind: "system", event: "member_revoked", body: { member_id: "m_dev_1" } }];
  const relay = { getMessages: async () => ({ messages, next_after: 3 }), listMembers: async () => ({ members: [] }),
    ack: async seq => { assert.equal(seq, 3); assert.deepEqual(createInbox(home).read().map(r => r.seq), [2, 1]); } };
  await createThinPoller({ home, transport, self, relay, now }).once();
});

test("fingerprint confirmation resumes before a deferred poll and retries the exact confirmed envelope after restart", async t => {
  const { home, transport, pairing } = setup(t, { confirmed: false }); let at = now().getTime(), gets = 0;
  updateHomeState(home, s => {
    s.members.m_dev_1.join_grace_until = at + 900000;
    s.transport.last_poll_at = at; s.transport.next_poll_at = at + 300000;
  });
  pairing.confirmFingerprint("m_dev_1", readHomeState(home).members.m_dev_1.fingerprint);
  const bodies = [], relay = { getMessages: async () => { gets++; return { messages: [] }; }, postMessage: async body => {
    bodies.push(body); if (bodies.length === 1) throw { status: 0, code: "timeout" }; return { seq: 10 };
  } };
  const poller = () => createThinPoller({ home, transport, self, relay, now: () => new Date(at) });
  assert.equal((await poller().once()).deferred, true);
  const queue = createCipherFiles(home, "outbox");
  assert.equal(queue.list().length, 2); assert.deepEqual(queue.list().map(e => e.type), ["confirmed", "agent_info"]);
  assert.equal(readHomeState(home).transport.fast_poll.until, at + 840000); assert.equal(gets, 0);
  await createOutbox({ home, relay, now: () => new Date(at) }).flush();
  at = queue.list()[0].next_attempt_at;
  await poller().once();
  await createOutbox({ home, relay, now: () => new Date(at) }).flush();
  assert.equal(bodies.length, 3); assert.equal(bodies[0], bodies[1]);
  assert.equal(bodies[2], queue.list().find(e => e.type === "agent_info").body);
  assert.equal(queue.list().length, 2); assert.ok(queue.list().every(e => e.state === "sent"));
});

test("fingerprint confirmation during fetching releases held data before the revocation row", async t => {
  const { home, transport, pairing } = setup(t, { confirmed: false });
  const message = await delivery(transport, 1);
  const relay = { getMessages: async () => {
    createCipherFiles(home, "held").put({ msg_id: message.msg_id, seq: 1, from: message.from, kind: message.kind, body: transport.serialize(Object.fromEntries(Object.entries(message).filter(([key]) => key !== "seq"))), received_at: now().toISOString() });
    pairing.confirmFingerprint("m_dev_1", readHomeState(home).members.m_dev_1.fingerprint);
    return { messages: [{ seq: 2, kind: "system", event: "member_revoked", body: { member_id: "m_dev_1" } }], next_after: 2 };
  }, listMembers: async () => ({ members: [] }), ack: async () => { assert.deepEqual(createInbox(home).read().map(r => r.seq), [1]); } };
  await createThinPoller({ home, transport, self, relay, now }).once();
});

test("failed held release stops the page before revocation and recovers before ACK on restart", async t => {
  const { home, transport } = setup(t, { confirmed: false }), proof = Buffer.alloc(32, 1).toString("base64url");
  updateHomeState(home, s => { s.members.m_dev_1.pair_proof = proof; });
  const messages = [await delivery(transport, 1), await delivery(transport, 2, { v: 1, type: "pair_proof", proof }),
    { seq: 3, kind: "system", event: "member_revoked", body: { member_id: "m_dev_1" } }];
  let acks = 0, reconciliations = 0;
  const relay = { getMessages: async () => ({ messages, next_after: 3 }), listMembers: async () => { reconciliations++; return { members: [] }; },
    ack: async () => { acks++; assert.deepEqual(createInbox(home).read().map(r => r.seq), [2, 1]); } };
  await assert.rejects(createThinPoller({ home, transport, self, relay, now, fs: diskFailure("writeSync", 2, /\.jsonl$/) }).once(), { code: "ENOSPC" });
  assert.equal(acks, 0); assert.equal(reconciliations, 0); assert.equal(readHomeState(home).members.m_dev_1.state, "confirmed");
  assert.equal(createCipherFiles(home, "held").list().length, 1);
  await createThinPoller({ home, transport, self, relay, now }).once();
  assert.equal(acks, 1); assert.equal(reconciliations, 1);
});

for (const messages of [null, [null], [{ seq: 2 }, { seq: 1 }], [{ seq: 1 }]]) test(`malformed page ${JSON.stringify(messages)} persists a retry floor across restart`, async t => {
  const { home, transport } = setup(t); let at = now().getTime(), gets = 0, acks = 0;
  updateHomeState(home, s => { s.transport.next_poll_at = at - 1; });
  const relay = { getMessages: async () => { gets++; return { messages, next_after: 9 }; }, ack: async () => { acks++; } };
  const create = () => createThinPoller({ home, transport, self, relay, now: () => new Date(at) });
  await assert.rejects(create().once(), { code: "invalid_response" });
  assert.equal(readHomeState(home).transport.poll_retry_at, at + 300000);
  assert.equal((await create().once()).deferred, true); assert.equal(gets, 1); assert.equal(acks, 0);
  at += 299999; assert.equal((await create().once()).deferred, true);
  at++; await assert.rejects(create().once(), { code: "invalid_response" }); assert.equal(gets, 2);
});

test("continuous receive waits after a malformed page even with an expired next poll", async t => {
  const { home, transport } = setup(t); let gets = 0, slept;
  updateHomeState(home, s => { s.transport.next_poll_at = now().getTime() - 1; });
  let reached; const waiting = new Promise(r => { reached = r; });
  const loop = createThinPoller({ home, transport, self, now,
    relay: { getMessages: async () => { gets++; if (gets > 1) throw { code: "invalid_token" }; return { messages: null }; } },
    sleep: ms => { slept = ms; reached(); return new Promise(() => {}); } }).start();
  await Promise.race([waiting, loop.done]); await loop.stop();
  assert.equal(gets, 1); assert.equal(slept, 1000);
});

test("durable data/poison checkpoints precede ACK; restart retries ACK before polling", async t => {
  const { home, transport } = setup(t), valid = await delivery(transport, 2);
  let fail = true, at = now().getTime(); const calls = [];
  const relay = { getMessages: async () => { calls.push("get"); return { messages: [{ seq: 1, msg_id: "bad", kind: "data" }, valid], next_after: 2 }; }, ack: async seq => {
    calls.push(`ack${seq}`); assert.equal(createInbox(home).read().length, 1); assert.equal(readHomeState(home).transport.cursor, 2);
    if (fail) { fail = false; throw { status: 0, code: "timeout" }; }
  } };
  const create = () => createThinPoller({ home, transport, self, relay, now: () => new Date(at) });
  await assert.rejects(create().once()); assert.equal(readHomeState(home).transport.pending_ack.up_to_seq, 2);
  await create().once(); assert.equal(calls.length, 2);
  at += 1000; await create().once(); assert.deepEqual(calls.slice(0, 3), ["get", "ack2", "ack2"]);
  assert.equal(readHomeState(home).transport.acked_seq, 2);
  await assert.rejects(create().ack(3), { code: "unsafe_ack" });
});
for (const [operation, pattern] of [["writeSync", /\.jsonl$/], ["fsyncSync", /\.jsonl$/], ["renameSync", /\.state\.json\./]]) test(`ACK never precedes ${operation} durability`, async t => {
  const { home, transport } = setup(t), message = await delivery(transport, 1); let acked = 0;
  const relay = { getMessages: async () => ({ messages: [message], next_after: 1 }), ack: async () => { acked++; } };
  const poller = createThinPoller({ home, transport, self, now, relay, fs: diskFailure(operation, 1, pattern) });
  await assert.rejects(poller.once()); assert.equal(acked, 0);
  await createThinPoller({ home, transport, self, now, relay }).once(); assert.equal(acked, 1); assert.equal(createInbox(home).read().length, 1);
});
test("ACK Retry-After persists across restart and explicit ACK cannot bypass it", async t => {
  const { home, transport } = setup(t), message = await delivery(transport, 1); let at = now().getTime(), calls = 0;
  const relay = { getMessages: async () => ({ messages: [message], next_after: 1 }), ack: async () => { if (++calls === 1) throw { status: 429, retryAfterS: 120 }; } };
  const create = () => createThinPoller({ home, transport, self, now: () => new Date(at), relay });
  await assert.rejects(create().once()); await create().ack(1); assert.equal(calls, 1);
  at += 120000; await create().ack(1); assert.equal(calls, 2);
});

test("E11 Retry-After persists across restart and explicit ACK cannot bypass it", async t => {
  const { home, transport } = setup(t); let at = now().getTime(), acks = 0;
  updateHomeState(home, s => { s.transport.cursor = 1; });
  const relay = { getMessages: async () => { throw { status: 429, retryAfterS: 120 }; }, ack: async () => { acks++; } };
  const create = () => createThinPoller({ home, transport, self, now: () => new Date(at), relay });
  await assert.rejects(create().once(), { status: 429 });
  assert.equal((await create().ack(1)).deferred, true); assert.equal(acks, 0);
  at += 119999; assert.equal((await create().ack(1)).deferred, true); assert.equal(acks, 0);
  at++; assert.deepEqual(await create().ack(1), { acked_up_to: 1 }); assert.equal(acks, 1);
});

for (const intervalS of [300, 1800, 25]) test(`ACK timeout preserves successful fetch cadence ${intervalS} across restart`, async t => {
  const { home, transport } = setup(t), message = await delivery(transport, 1);
  let at = now().getTime(), gets = 0, acks = 0;
  const relay = { getMessages: async () => { gets++; return { messages: [message], next_after: 1 }; },
    ack: async () => { if (++acks === 1) throw { status: 0, code: "timeout" }; } };
  const create = () => createThinPoller({ home, transport, self, relay, now: () => new Date(at), intervalS: Math.max(300, intervalS) });
  if (intervalS === 25) await create().startFastPoll("m_dev_1", at + 900000);
  await assert.rejects(create().once(), { code: "timeout" });
  const fetchedAt = at, checkpoint = readHomeState(home).transport;
  assert.equal(checkpoint.last_poll_at, fetchedAt);
  assert.equal(checkpoint.next_poll_at, fetchedAt + intervalS * 1000);
  at += 1000; assert.equal((await create().once()).deferred, true);
  assert.equal(acks, 2); assert.equal(gets, 1);
  at = fetchedAt + intervalS * 1000 - 1; await create().once(); assert.equal(gets, 1);
  at++; await create().once(); assert.equal(gets, 2);
});

for (const restart of [false, true]) for (const [failure, retryMs] of [
  [{ status: 0, code: "timeout" }, 1000], [{ status: 429, retryAfterS: 120 }, 120000],
]) test(`continuous ACK ${failure.status === 429 ? "Retry-After" : "timeout"} retry wakes before the next poll${restart ? " after restart" : ""}`, async t => {
  const { home, transport } = setup(t), message = await delivery(transport, 1);
  const fetchedAt = now().getTime(), retryDue = fetchedAt + retryMs, acks = [];
  let at = fetchedAt, gets = 0, reached;
  const waiting = new Promise(resolve => { reached = resolve; });
  const relay = { getMessages: async () => { gets++; return { messages: [message], next_after: 1 }; },
    ack: async () => { acks.push(at); if (acks.length === 1) throw failure; } };
  const create = () => createThinPoller({ home, transport, self, relay, intervalS: 1800, now: () => new Date(at),
    sleep: async ms => {
      if (at < retryDue) { assert.equal(acks.length, 1); at += ms; return; }
      reached(); return new Promise(() => {});
    } });
  if (restart) await assert.rejects(create().once());
  const loop = create().start();
  try {
    await Promise.race([waiting, loop.done]);
    assert.deepEqual(acks, [fetchedAt, retryDue]);
    assert.equal(gets, 1);
    const checkpoint = readHomeState(home).transport;
    assert.equal(checkpoint.pending_ack, null); assert.equal(checkpoint.acked_seq, 1);
    assert.equal(checkpoint.next_poll_at, fetchedAt + 1800000);
  } finally { await loop.stop(); }
});

for (const held of [false, true]) for (const once of [false, true]) test(`${once ? "once deadline" : "shutdown"} cancels ${held ? "held" : "page"} member reconciliation before processing or ACK`, async t => {
  const { home, transport } = setup(t), pending = createCipherFiles(home, "held");
  const message = { seq: 1, kind: "system", event: "member_revoked", body: { member_id: "m_dev_1" } };
  if (held) {
    pending.put({ msg_id: messageId(1), seq: 1, from: "relay", kind: "system", legacy_state: "new", body: JSON.stringify(message) });
    updateHomeState(home, s => { s.transport.cursor = 1; s.transport.pending_ack = { up_to_seq: 1 }; });
  }
  const before = readHomeState(home).transport;
  let reached, finish, requestSignal, acks = 0;
  const started = new Promise(resolve => { reached = resolve; });
  const relay = createRelayClient({ baseUrl: "https://relay.example", token: "fixture-token", timeoutMs: 60000,
    now: () => now().getTime(), fetch: async (input, options) => {
      const url = new URL(input);
      if (url.pathname === "/v1/members") return new Promise((resolve, reject) => {
        requestSignal = options.signal;
        finish = () => resolve(Response.json({ members: [] }));
        requestSignal.addEventListener("abort", () => reject(requestSignal.reason), { once: true });
        reached();
      });
      if (options.method === "POST") { acks++; return Response.json({ acked: 1, cursor: 1 }); }
      return Response.json({ messages: [message], next_after: 1 });
    } });
  if (once) t.mock.timers.enable({ apis: ["setTimeout"] });
  const poller = createThinPoller({ home, transport, self, relay, now });
  const loop = once ? null : poller.start();
  const result = (once ? poller.once() : loop.done).then(value => ({ value }), error => ({ error }));
  try {
    await started;
    if (once) t.mock.timers.tick(15000);
    else loop.stop();
    assert.equal(requestSignal.aborted, true);
    const outcome = await result;
    if (once) assert.equal(outcome.error?.name, "AbortError");
    else assert.equal(outcome.value?.reason, "stopped");
    assert.equal(acks, 0);
    assert.equal(readHomeState(home).members.m_dev_1.state, "confirmed");
    assert.equal(readHomeState(home).transport.cursor, before.cursor);
    assert.deepEqual(readHomeState(home).transport.pending_ack, before.pending_ack);
    assert.equal(pending.list().length, held ? 1 : 0);
    await createThinPoller({ home, transport, self, now, relay: { getMessages: async () => ({ messages: [] }), listMembers: async () => ({ members: [{ member_id: "m_dev_1" }] }), ack: async () => {} } }).once();
  } finally {
    finish?.(); await loop?.stop(); await result;
  }
});

test("receiver lease, advertised first-sync cadence, heartbeat hook and shutdown", async t => {
  const { home, transport } = setup(t); let at = now().getTime(), advertised, beats = 0, wake;
  const relay = { getMessages: async (_, options) => { advertised = options.pollIntervalS; return { messages: [] }; }, ack: async () => {} };
  const poller = createThinPoller({ home, transport, self, relay, now: () => new Date(at), heartbeat: async () => { beats++; }, sleep: () => new Promise(r => { wake = r; }) });
  await poller.startFastPoll("m_dev_1", at + 900000);
  const loop = poller.start(); await new Promise(r => setTimeout(r, 20));
  assert.equal(advertised, 300); assert.equal(beats, 1);
  assert.equal(readHomeState(home).transport.next_poll_at, at + 25000);
  assert.throws(() => createThinPoller({ home, transport, self, relay, now }).start(), { code: "home_locked" });
  const stopped = loop.stop(); wake?.(); await stopped;
  await createThinPoller({ home, transport, self, relay, now }).once();
});

for (const [operation, count, pattern] of [["writeSync", 1, /\.state\.json\./], ["fsyncSync", 1, /\.state\.json\./], ["renameSync", 2, /\.state\.json\./], ["fsyncSync", 2, /\.state\.json\./]]) test(`checkpoint/ACK intent ${operation} ${count} failure is retryable`, async t => {
  const { home, transport } = setup(t), message = await delivery(transport, 1); let acked = 0;
  const relay = { getMessages: async () => ({ messages: [message], next_after: 1 }), ack: async () => { acked++; } };
  await assert.rejects(createThinPoller({ home, transport, self, relay, now, fs: diskFailure(operation, count, pattern) }).once());
  assert.equal(acked, 0);
  await createThinPoller({ home, transport, self, relay, now }).once();
  assert.equal(acked, 1); assert.equal(createInbox(home).read().length, 1);
});

test("successful remote ACK with failed local commit retries the same checkpoint after restart", async t => {
  const { home, transport } = setup(t), message = await delivery(transport, 1); const acks = [];
  const relay = { getMessages: async () => ({ messages: [message], next_after: 1 }), ack: async seq => { acks.push(seq); } };
  await assert.rejects(createThinPoller({ home, transport, self, relay, now, fs: diskFailure("renameSync", 3, /\.state\.json\./) }).once());
  assert.deepEqual(acks, [1]); assert.equal(readHomeState(home).transport.pending_ack.up_to_seq, 1);
  await createThinPoller({ home, transport, self, relay, now }).once();
  assert.deepEqual(acks, [1, 1]); assert.equal(createInbox(home).read().length, 1);
});

test("encrypted hold failure prevents ACK; replay keeps the first durable receive timestamp", async t => {
  const { home, transport } = setup(t, { confirmed: false }), message = await delivery(transport, 1); let acks = 0, at = now().getTime();
  const relay = { getMessages: async () => ({ messages: [message], next_after: 1 }), ack: async () => { acks++; } };
  await assert.rejects(createThinPoller({ home, transport, self, relay, now, fs: diskFailure("renameSync", 1, /\/held\/\./) }).once());
  assert.equal(acks, 0);
  await assert.rejects(createThinPoller({ home, transport, self, relay, now, fs: diskFailure("renameSync", 1, /\.state\.json\./) }).once());
  assert.equal(acks, 0); const first = createCipherFiles(home, "held").list()[0].received_at;
  at += 60000;
  await createThinPoller({ home, transport, self, relay, now: () => new Date(at) }).once();
  assert.equal(acks, 1); assert.equal(createCipherFiles(home, "held").list()[0].received_at, first);
});

test("startup pruning touches only thin inbox; poll retry and cadence survive restart", async t => {
  const { home, transport } = setup(t); let at = now().getTime(), gets = 0;
  const bytes = Buffer.from("legacy fixture"); fs.writeFileSync(`${home}/agent.db`, bytes, { mode: 0o600 });
  createInbox(home).append({ seq: 1, from: "m_dev_1", kind: "control", type: "future", received_at: "2026-10-01T00:00:00Z", inner: { type: "future" } });
  const relay = { getMessages: async () => { if (++gets === 1) throw { status: 429, retryAfterS: 400 }; return { messages: [] }; } };
  const create = () => createThinPoller({ home, transport, self, relay, now: () => new Date(at) });
  await assert.rejects(create().once()); at += 399000; await create().once(); assert.equal(gets, 1);
  at += 1000; await create().once(); assert.equal(gets, 2);
  assert.deepEqual(fs.readFileSync(`${home}/agent.db`), bytes); assert.equal(createInbox(home).read().length, 0);
  at += 1000; await create().once(); assert.equal(gets, 2);
});

test("continuous receive prunes daily during long polling backoff and preserves boundary lines", async t => {
  const { home, transport } = setup(t); let at = now().getTime(), sleeps = 0, reached;
  const waiting = new Promise(resolve => { reached = resolve; }), inbox = createInbox(home);
  const bytes = Buffer.from("legacy fixture"); fs.writeFileSync(`${home}/agent.db`, bytes, { mode: 0o600 });
  for (const [seq, received_at] of [[1, "2026-10-07T11:59:59Z"], [2, "2026-10-07T12:00:00Z"], [3, now().toISOString()]]) {
    inbox.append({ seq, from: "m_dev_1", kind: "control", type: "future", received_at, inner: { type: "future", keep: true } });
  }
  const boundary = fs.readFileSync(`${home}/inbox/2026-10-07.jsonl`, "utf8").split("\n")[1] + "\n";
  updateHomeState(home, s => { s.transport.poll_retry_at = at + 3 * 86400000; });
  const loop = createThinPoller({ home, transport, self, now: () => new Date(at), relay: { getMessages: async () => { assert.fail("backoff must prevent polling"); } },
    sleep: async () => { if (++sleeps === 1) { at += 86400000; return; } reached(); return new Promise(() => {}); } }).start();
  try {
    await Promise.race([waiting, loop.done]);
    assert.deepEqual(inbox.read().map(r => r.seq), [2, 3]);
    assert.equal(fs.readFileSync(`${home}/inbox/2026-10-07.jsonl`, "utf8"), boundary);
    assert.deepEqual(fs.readFileSync(`${home}/agent.db`), bytes);
  } finally { await loop.stop(); }
});

test("first-sync completion ends fast polling and a stalled heartbeat/outbox cannot block receipt", async t => {
  const { home, transport } = setup(t), message = await delivery(transport, 1, { type: "sync", more: false });
  let resolveBackground, stopWait, polled, gets = 0; const cadences = [];
  const completed = new Promise(r => { polled = r; });
  const stalled = new Promise(r => { resolveBackground = r; });
  const relay = { getMessages: async (_, opts) => { cadences.push(opts.pollIntervalS); gets++; return { messages: [message], next_after: 1 }; }, ack: async () => {} };
  const poller = createThinPoller({ home, transport, self, relay, now, heartbeat: () => stalled, outbox: { flush: () => stalled }, sleep: () => { polled(); return new Promise(r => { stopWait = r; }); } });
  await poller.startFastPoll("m_dev_1", now().getTime() + 900000);
  const loop = poller.start();
  try {
    await Promise.race([completed, loop.done]);
    assert.equal(gets, 1); assert.equal(createInbox(home).read().length, 1); assert.equal(cadences[0], 300);
    assert.equal(readHomeState(home).transport.poll_interval_s, 300);
    assert.deepEqual(readHomeState(home).transport.fast_poll.devices, []);
  } finally { resolveBackground(); const stopped = loop.stop(); stopWait?.(); await stopped; }
});

test("once drives heartbeat and outbox independently; shutdown cancels a stalled heartbeat", async t => {
  const { home, transport } = setup(t); let beats = 0, sends = 0;
  const relay = { getMessages: async () => ({ messages: [] }) };
  const poller = createThinPoller({ home, transport, self, relay, now, heartbeat: async () => { beats++; }, outbox: { flush: async () => { sends++; } } });
  await poller.once(); await poller.once(); assert.equal(beats, 1); assert.equal(sends, 2);
  updateHomeState(home, s => { s.transport.heartbeat_day = null; });
  let started; const reached = new Promise(r => { started = r; });
  const loop = createThinPoller({ home, transport, self, relay, now, heartbeat: () => { started(); return new Promise(() => {}); } }).start();
  await reached; await loop.stop();
});

test("member reconciliation 429 cannot ACK or lose its deadline on restart", async t => {
  const { home, transport } = setup(t); let at = now().getTime(), calls = 0, acks = 0;
  const message = { seq: 1, kind: "system", event: "member_revoked", body: { member_id: "m_dev_1" } };
  const relay = { getMessages: async () => ({ messages: [message], next_after: 1 }), listMembers: async () => { if (++calls === 1) throw { status: 429, retryAfterS: 120 }; return { members: [] }; }, ack: async () => { acks++; } };
  const poller = () => createThinPoller({ home, transport, self, relay, now: () => new Date(at) });
  await assert.rejects(poller().once()); await poller().once(); assert.equal(acks, 0); assert.equal(calls, 1);
  at += 120000; await poller().once(); assert.equal(calls, 2); assert.equal(acks, 1);
});

test("migrated system reconciliation retains its ciphertext and Retry-After across restart", async t => {
  const { home, transport } = setup(t), held = createCipherFiles(home, "held"); let at = now().getTime(), lists = 0, acks = 0;
  const message = { seq: 1, kind: "system", event: "member_revoked", body: { member_id: "m_dev_1" } };
  held.put({ msg_id: messageId(1), seq: 1, from: "relay", kind: "system", legacy_state: "new", body: JSON.stringify(message) });
  updateHomeState(home, s => { s.transport.cursor = 1; s.transport.pending_ack = { up_to_seq: 1 }; });
  const relay = { listMembers: async () => { if (++lists === 1) throw { status: 429, retryAfterS: 120 }; return { members: [] }; },
    getMessages: async () => ({ messages: [] }), ack: async () => { acks++; assert.equal(held.list().length, 0); } };
  const create = () => createThinPoller({ home, transport, self, relay, now: () => new Date(at) });
  await assert.rejects(create().once()); assert.equal(held.list().length, 1);
  assert.equal((await create().once()).deferred, true); assert.equal(lists, 1); assert.equal(acks, 0);
  at += 120000; await create().once(); assert.equal(lists, 2); assert.equal(acks, 1);
  assert.equal(readHomeState(home).members.m_dev_1.state, "revoked");
});

test("malformed envelopes make progress while an unexplained cursor jump cannot be ACKed", async t => {
  const { home, transport } = setup(t); let acks = 0;
  const valid = await delivery(transport, 2);
  const relay = { getMessages: async () => ({ messages: [null, { kind: "data" }, valid], next_after: 2 }), ack: async () => { acks++; } };
  await createThinPoller({ home, transport, self, relay, now }).once();
  assert.equal(acks, 1); assert.equal(createInbox(home).read().length, 1);
  assert.ok(readHomeState(home).transport.events.some(e => e.status === "poison" && e.code === "malformed" && e.count === 2));
  updateHomeState(home, s => { s.transport.next_poll_at = 0; });
  relay.getMessages = async () => ({ messages: [await delivery(transport, 3)], next_after: 100 });
  await assert.rejects(createThinPoller({ home, transport, self, relay, now }).once(), { code: "invalid_response" });
  assert.equal(acks, 1); assert.equal(readHomeState(home).transport.cursor, 2);
});

test("migrated retry deadlines protect explicit ACK as well as polling", async t => {
  const { home, transport } = setup(t); let at = now().getTime(), acks = 0;
  updateHomeState(home, s => {
    s.transport.cursor = 5; s.transport.pending_ack = { up_to_seq: 5 };
    s.transport.poll_progress = { retry_after_until: at + 120000 };
  });
  const relay = { ack: async () => { acks++; } };
  await createThinPoller({ home, transport, self, relay, now: () => new Date(at) }).ack(5);
  assert.equal(acks, 0); at += 120000;
  await createThinPoller({ home, transport, self, relay, now: () => new Date(at) }).ack(5);
  assert.equal(acks, 1);
});

test("migrated next poll defers E11 across restart without delaying a durable ACK or background work", async t => {
  const { home, transport } = setup(t); let at = now().getTime(), beats = 0, sends = 0;
  const due = at + 120000, calls = [];
  updateHomeState(home, s => {
    s.transport.cursor = 5; s.transport.pending_ack = { up_to_seq: 5 };
    s.transport.poll_progress = { next_poll_at: due };
  });
  const relay = { ack: async () => { calls.push("ack"); }, getMessages: async () => { calls.push("get"); return { messages: [] }; } };
  const create = () => createThinPoller({ home, transport, self, relay, now: () => new Date(at),
    heartbeat: async () => { beats++; }, outbox: { flush: async () => { sends++; } } });
  assert.equal((await create().once()).deferred, true);
  assert.deepEqual(calls, ["ack"]); assert.equal(beats, 1); assert.equal(sends, 1);
  at = due - 1; assert.equal((await create().once()).deferred, true); assert.deepEqual(calls, ["ack"]);
  at = due; await create().once(); assert.deepEqual(calls, ["ack", "get"]);
  at++; assert.equal((await create().once()).deferred, true); assert.equal(calls.length, 2);
  at = due + 300000; await create().once(); assert.equal(calls.length, 3);
});

test("continuous receive sleeps until the migrated first poll deadline", async t => {
  const { home, transport } = setup(t); let at = now().getTime(), gets = 0, reached;
  const due = at + 2000, waiting = new Promise(resolve => { reached = resolve; });
  updateHomeState(home, s => { s.transport.poll_progress = { next_poll_at: due }; });
  const loop = createThinPoller({ home, transport, self, now: () => new Date(at),
    relay: { getMessages: async () => { assert.equal(at, due); gets++; return { messages: [] }; } },
    sleep: async ms => {
      if (at < due) { assert.equal(gets, 0); at += ms; return; }
      reached(); return new Promise(() => {});
    } }).start();
  try { await Promise.race([waiting, loop.done]); assert.equal(gets, 1); }
  finally { await loop.stop(); }
});

for (const retry of ["retry_after_until", "poll_progress.retry_after_until", "poll_progress.retry_at"]) test(`migrated ${retry} defers pending ACK and fetch across restart`, async t => {
  const { home, transport } = setup(t); let at = now().getTime(); const calls = [];
  updateHomeState(home, s => {
    s.transport.cursor = 5; s.transport.pending_ack = { up_to_seq: 5 };
    if (retry.startsWith("poll_progress.")) s.transport.poll_progress = { [retry.split(".")[1]]: at + 120000 };
    else s.transport[retry] = String(at + 120000);
  });
  const relay = { ack: async seq => { calls.push(`ack${seq}`); }, getMessages: async () => { calls.push("get"); return { messages: [] }; } };
  const create = () => createThinPoller({ home, transport, self, relay, now: () => new Date(at) });
  assert.equal((await create().ack(5)).deferred, true);
  assert.equal((await create().once()).deferred, true);
  assert.deepEqual(calls, []); assert.equal(readHomeState(home).transport.pending_ack.up_to_seq, 5);
  at += 120000; await create().once();
  assert.deepEqual(calls, ["ack5", "get"]);
});

test("a page without a sequence checkpoint cannot advance or ACK", async t => {
  const { home, transport } = setup(t); let acks = 0;
  const relay = { getMessages: async () => ({ messages: [null, { kind: "data" }], next_after: 10 }), ack: async () => { acks++; } };
  await assert.rejects(createThinPoller({ home, transport, self, relay, now }).once(), { code: "invalid_response" });
  assert.equal(acks, 0); assert.equal(readHomeState(home).transport.cursor, 0);
});

for (const intervalS of [300, 1800, 86400]) test(`fast polls advertise configured E11 cadence ${intervalS} on every page and restart`, async t => {
  const { home, transport } = setup(t), message = await delivery(transport, 1);
  let at = now().getTime(); const advertised = [];
  const relay = createRelayClient({ baseUrl: "https://relay.example", token: "fixture-token", now: () => at, fetch: async (input, options) => {
    const url = new URL(input);
    if (options.method === "POST") return Response.json({ acked: 1, cursor: 1 });
    const interval = url.searchParams.get("poll_interval_s");
    assert.match(interval, /^[0-9]+$/);
    assert.ok(Number(interval) >= 300 && Number(interval) <= 86400);
    advertised.push(Number(interval));
    return Response.json(advertised.length === 1 ? { messages: [message], next_after: 1, has_more: true } : { messages: [] });
  } });
  const create = () => createThinPoller({ home, transport, self, relay, intervalS, now: () => new Date(at) });
  await create().startFastPoll("m_dev_1", at + 900000);
  await create().once();
  assert.deepEqual(advertised, [intervalS, intervalS]);
  assert.equal(readHomeState(home).transport.poll_interval_s, intervalS);
  assert.equal(readHomeState(home).transport.next_poll_at, at + 25000);
  at += 24999; assert.equal((await create().once()).deferred, true);
  at++; await create().once();
  assert.deepEqual(advertised, [intervalS, intervalS, intervalS]);
  at = readHomeState(home).transport.fast_poll.until;
  await create().once();
  assert.equal(advertised.at(-1), intervalS);
  assert.equal(readHomeState(home).transport.next_poll_at, at + intervalS * 1000);
});

test("poll cadence rejects values outside the E11 contract", t => {
  const { home, transport } = setup(t);
  for (const intervalS of [0, 25, 299, 86401, 300.5, NaN, Infinity]) {
    assert.throws(() => createThinPoller({ home, transport, self, relay: {}, intervalS }), { code: "invalid_input" });
  }
});

test("fast scheduling preserves a poll Retry-After across restart", async t => {
  const { home, transport } = setup(t); let at = now().getTime(), gets = 0;
  const relay = { getMessages: async (_, options) => {
    assert.equal(options.pollIntervalS, 1800);
    if (++gets === 1) throw { status: 429, retryAfterS: 120 };
    return { messages: [] };
  } };
  const create = () => createThinPoller({ home, transport, self, relay, intervalS: 1800, now: () => new Date(at) });
  await create().startFastPoll("m_dev_1", at + 900000);
  await assert.rejects(create().once());
  at += 119999; assert.equal((await create().once()).deferred, true); assert.equal(gets, 1);
  at++; await create().once(); assert.equal(gets, 2);
  assert.equal(readHomeState(home).transport.next_poll_at, at + 25000);
});
