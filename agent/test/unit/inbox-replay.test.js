import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { createThinInbound } from '../../src/thin-inbound.js';
import { createThinPoller } from '../../src/thin-poller.js';
import { createInbox, inboxLines, INBOX_SEEN_RETENTION_MS, INBOX_SEEN_CLOCK_SKEW_MS, INBOX_SEEN_MAX_IDS, INBOX_SEEN_PROTECTED_MS, INBOX_SEEN_MAX_RECENT_IDS } from '../../src/inbox.js';
import { createCipherFiles, forgetThinMember, readHomeState, updateHomeState, validateHomeState } from '../../src/home-state.js';
import { createGenericSender } from '../../src/send.js';
import { createOutbox } from '../../src/outbox.js';
import { createUuidV7Generator } from '../../src/ids.js';
import { b64uDecode } from '../../src/encoding.js';
import { readInbox } from '../../src/runtime.js';
import { diskFailure, syncTrace } from '../support/thin-home.js';
import { setup, delivery, self, now, keys, messageId } from '../support/thin-transport.js';
import { pairingId, resolvedReply, scopedRequest } from '../support/pairing-scope.js';

const seenCount = home => Object.values(readHomeState(home).transport.inbox_seen ?? {}).reduce((n, ids) => n + Object.keys(ids).length, 0);
const sync = read => ({ v: 1, type: 'sync', scope: { read, write: 'none' }, more: false, acks: [{ command_id: 'one', version: 1, status: 'applied' }] });
const mintedId = (at, n = 0) => createUuidV7Generator()({ now: () => at, random: size => new Uint8Array(size).fill(n) });
const horizon = INBOX_SEEN_RETENTION_MS + INBOX_SEEN_CLOCK_SKEW_MS;
const binding = `m_dev_1:${keys.dev1.pk}`;
const seenFloor = home => readHomeState(home).transport.inbox_seen_floor?.[binding];
const command = { v: 1, type: 'commands', commands: [{ command_id: 'one', version: 1 }] };
const seedSeen = (home, at, count = INBOX_SEEN_MAX_IDS) => updateHomeState(home, s => {
  s.transport.inbox_seen = {};
  for (let i = 0; i < count; i++) {
    (s.transport.inbox_seen[binding] ??= {})[mintedId(at + i)] = now().getTime() - i;
  }
});

test('a replay after the UUID horizon cannot restore scope after restart and seen pruning', async t => {
  const { home, transport } = setup(t); let at = now().getTime(), emitted = 0;
  const inbound = () => createThinInbound({ home, transport, self, now: () => new Date(at), onRecord: () => emitted++ });
  const old = await delivery(transport, 1, sync('all'));
  await inbound().receive(old); at += horizon;
  await inbound().receive(await delivery(transport, 2, sync('none'), { msgId: mintedId(at) }));
  assert.equal(seenCount(home), 1);
  const before = JSON.stringify(readHomeState(home).members.m_dev_1);
  assert.equal((await inbound().receive({ ...old, seq: 3, created_at: new Date(at).toISOString() })).code, 'expired');
  assert.ok(JSON.stringify(readHomeState(home).members.m_dev_1) === before);
  assert.equal(emitted, 2); assert.equal(createInbox(home).read().length, 2);
  at -= 86400000;
  assert.equal((await inbound().receive({ ...old, seq: 4 })).code, 'expired');
  assert.ok(JSON.stringify(readHomeState(home).members.m_dev_1) === before);
});

test('stale authenticated proof cannot confirm a joined member or release held effects', async t => {
  const { home, transport } = setup(t, { confirmed: false }), proof = Buffer.alloc(32, 1).toString('base64url');
  updateHomeState(home, s => { s.members.m_dev_1.pair_proof = proof; });
  const inbound = createThinInbound({ home, transport, self, now });
  await inbound.receive(await delivery(transport, 1, sync('all')));
  const message = await delivery(transport, 2, { v: 1, type: 'pair_proof', proof }, { msgId: mintedId(now().getTime() - horizon) });
  assert.equal((await inbound.receive(message)).code, 'expired');
  assert.equal(readHomeState(home).members.m_dev_1.state, 'joined');
  assert.equal(readHomeState(home).members.m_dev_1.confirmation, undefined);
  assert.equal(createCipherFiles(home, 'held').list().length, 1); assert.equal(createInbox(home).read().length, 0);
});

test('seen capacity evicts unprotected oldest mint times per binding and continues admission and ACK after restart', async t => {
  const { home, transport } = setup(t); let at = now().getTime(), acked = 0, emitted = 0;
  const firstMint = at - INBOX_SEEN_PROTECTED_MS - INBOX_SEEN_MAX_IDS;
  const inbound = () => createThinInbound({ home, transport, self, now: () => new Date(at) });
  const old = await delivery(transport, 1, sync('all'), { msgId: mintedId(firstMint) });
  await inbound().receive(old); seedSeen(home, firstMint);
  assert.equal((await inbound().receive(old)).status, 'duplicate');
  let messages;
  const relay = { getMessages: async () => ({ messages, next_after: messages.at(-1).seq }), ack: async seq => { acked = seq; } };
  const poller = () => createThinPoller({ home, transport, self, relay, now: () => new Date(at), onRecord: () => emitted++ });
  for (let seq = 2; seq <= 4; seq++) {
    messages = [await delivery(transport, seq, sync('none'), { msgId: mintedId(at) })];
    await poller().once();
    const state = readHomeState(home);
    assert.equal(acked, seq); assert.equal(state.transport.cursor, seq); assert.equal(state.transport.acked_seq, seq);
    assert.equal(seenFloor(home), firstMint + seq - 2);
    assert.equal(seenCount(home), INBOX_SEEN_MAX_IDS);
    assert.ok(Object.values(state.transport.inbox_seen).every(ids => ids[mintedId(firstMint + seq - 2)] === undefined));
    at += 300000;
  }
  const before = JSON.stringify(readHomeState(home).members.m_dev_1);
  assert.equal((await inbound().receive({ ...old, seq: 5 })).code, 'expired');
  messages = [{ ...old, seq: 5 }]; await poller().once();
  assert.equal(acked, 5); assert.equal(readHomeState(home).transport.cursor, 5); assert.equal(readHomeState(home).transport.acked_seq, 5);
  assert.ok(JSON.stringify(readHomeState(home).members.m_dev_1) === before);
  assert.deepEqual(readHomeState(home).transport.events.at(-1), { seq: 5, status: 'poison', code: 'expired' });
  assert.equal(createInbox(home).read().length, 4); assert.equal(emitted, 3);
  at += horizon;
  assert.equal((await inbound().receive(await delivery(transport, 6, sync('none'), { msgId: mintedId(at) }))).status, 'stored');
  assert.equal(seenCount(home), 1); assert.equal(seenFloor(home), firstMint + 2);
  at -= horizon + 86400000;
  assert.equal((await inbound().receive({ ...old, seq: 7 })).code, 'expired');
});

test('eviction rejects every timestamp tie at the floor, including unseen IDs, and admits the next millisecond', async t => {
  const { home, transport } = setup(t), at = now().getTime(), floor = at - INBOX_SEEN_PROTECTED_MS - 1000;
  seedSeen(home, at);
  updateHomeState(home, s => {
    delete s.transport.inbox_seen[`m_dev_1:${keys.dev1.pk}`][mintedId(at)];
    delete s.transport.inbox_seen[binding][mintedId(at + 1)];
    s.transport.inbox_seen[`m_dev_1:${keys.dev1.pk}`][mintedId(floor)] = at;
    s.transport.inbox_seen[binding][mintedId(floor, 1)] = at;
  });
  const inbound = () => createThinInbound({ home, transport, self, now });
  await inbound().receive(await delivery(transport, 1, sync('none'), { msgId: mintedId(at + INBOX_SEEN_MAX_IDS) }));
  assert.equal(seenFloor(home), floor);
  assert.equal(seenCount(home), INBOX_SEEN_MAX_IDS - 1);
  const before = JSON.stringify(readHomeState(home).members.m_dev_1);
  for (const [i, [mint, n]] of [[floor - 1, 2], [floor, 0], [floor, 1], [floor, 2]].entries()) {
    assert.equal((await inbound().receive(await delivery(transport, i + 2, sync('all'), { msgId: mintedId(mint, n) }))).code, 'expired');
  }
  assert.ok(JSON.stringify(readHomeState(home).members.m_dev_1) === before);
  assert.equal(createInbox(home).read().length, 1);
  assert.equal((await inbound().receive(await delivery(transport, 6, sync('none'), { msgId: mintedId(floor + 1) }))).status, 'stored');
  assert.equal(seenFloor(home), floor);
  assert.equal(seenCount(home), INBOX_SEEN_MAX_IDS);
});

for (const operation of ['renameSync', 'fsyncSync']) test(`eviction floor and admission recover together after ${operation} state failure`, async t => {
  const { home, transport } = setup(t), firstMint = now().getTime() - INBOX_SEEN_PROTECTED_MS - INBOX_SEEN_MAX_IDS, emitted = [];
  seedSeen(home, firstMint);
  const message = await delivery(transport, 1, sync('all'), { msgId: mintedId(now().getTime()) });
  const inbound = fs => createThinInbound({ home, transport, self, now, fs, onRecord: r => emitted.push(r.cursor) });
  await assert.rejects(inbound(diskFailure(operation, 1, /\.state\.json\./)).receive(message), { code: 'ENOSPC' });
  assert.equal(readHomeState(home).transport.inbox_seen_floor, undefined); assert.equal(seenCount(home), INBOX_SEEN_MAX_IDS);
  assert.equal(readHomeState(home).members.m_dev_1.scope, undefined);
  assert.equal(readInbox(home).records.length, 0); assert.equal(emitted.length, 0);
  const original = inboxLines(home)[0].record;
  await inbound().reconcile();
  assert.equal(seenFloor(home), firstMint); assert.equal(seenCount(home), INBOX_SEEN_MAX_IDS);
  assert.equal(readHomeState(home).transport.inbox_committed_cursor, original.cursor);
  assert.equal(readHomeState(home).members.m_dev_1.scope.seq, 1); assert.deepEqual(emitted, [original.cursor]);
  assert.equal(createInbox(home).read()[0].cursor, original.cursor);
  updateHomeState(home, s => { s.members.m_dev_1.scope = { read: 'none', write: 'none', seq: 2 }; });
  assert.equal((await inbound().receive(await delivery(transport, 2, sync('all'), { msgId: mintedId(firstMint) }))).code, 'expired');
  assert.equal((await inbound().receive({ ...message, seq: 3 })).status, 'duplicate');
  await inbound().reconcile();
  assert.equal(readHomeState(home).members.m_dev_1.scope.seq, 2);
  assert.equal(createInbox(home).read().length, 1); assert.equal(emitted.length, 1);
});

for (const skew of [-600000, 0, 600000]) test(`a 24-hour pre-minted pairing reply survives capacity and phone clock skew ${skew}`, async t => {
  const { home, transport } = setup(t); scopedRequest(home);
  seedSeen(home, now().getTime(), 11000);
  const retained = Object.keys(readHomeState(home).transport.inbox_seen[binding]);
  const msgId = mintedId(now().getTime() - 86400000 + skew);
  const message = await delivery(transport, 1, resolvedReply(), { msgId });
  const inbound = fs => createThinInbound({ home, transport, self, now, fs });
  await assert.rejects(inbound(diskFailure('renameSync', 1, /\.state\.json\./)).receive(message), { code: 'ENOSPC' });
  assert.equal(readHomeState(home).pairings[pairingId].access.state, 'awaiting');
  assert.equal(readInbox(home).records.length, 0); assert.equal(seenCount(home), 11000);
  await inbound().reconcile();
  assert.equal(readHomeState(home).pairings[pairingId].access.state, 'resolved');
  assert.equal(seenCount(home), 11001); assert.equal(seenFloor(home), undefined);
  const ids = readHomeState(home).transport.inbox_seen[binding];
  assert.ok(retained.every(id => ids[id] !== undefined));
  assert.equal((await inbound().receive({ ...message, seq: 2 })).status, 'duplicate');
  assert.equal(createInbox(home).read().length, 1);
});

test('an eviction floor never rejects an unseen delivery from another sender', async t => {
  const { home, transport, pairing } = setup(t), firstMint = now().getTime() - INBOX_SEEN_PROTECTED_MS - INBOX_SEEN_MAX_IDS;
  seedSeen(home, firstMint);
  pairing.join({ member_id: 'm_dev_2', role: 'device', public_key: keys.dev2.pk }, { verified: true });
  pairing.confirmFingerprint('m_dev_2', readHomeState(home).members.m_dev_2.fingerprint);
  await createThinInbound({ home, transport, self, now }).receive(await delivery(transport, 1));
  assert.equal(seenFloor(home), firstMint);
  const message = await delivery(transport, 2, sync('none'), { msgId: mintedId(firstMint), from: 'm_dev_2', senderPrivateKey: b64uDecode(keys.dev2.sk) });
  assert.equal((await createThinInbound({ home, transport, self, now }).receive(message)).status, 'stored');
  assert.equal(readHomeState(home).members.m_dev_2.scope.seq, 2);
  assert.equal(seenCount(home), INBOX_SEEN_MAX_IDS + 1);
});

test('pathological sender capacity leaves the page unACKed while admitting another sender and recovers after protected expiry', async t => {
  const { home, transport, pairing } = setup(t); let at = now().getTime(), acks = 0, emitted = 0;
  seedSeen(home, at - INBOX_SEEN_MAX_RECENT_IDS, INBOX_SEEN_MAX_RECENT_IDS);
  pairing.join({ member_id: 'm_dev_2', role: 'device', public_key: keys.dev2.pk }, { verified: true });
  pairing.confirmFingerprint('m_dev_2', readHomeState(home).members.m_dev_2.fingerprint);
  const blocked = await delivery(transport, 1, sync('all'));
  const other = await delivery(transport, 2, sync('none'), { from: 'm_dev_2', senderPrivateKey: b64uDecode(keys.dev2.sk) });
  const relay = { getMessages: async () => ({ messages: [blocked, other], next_after: 2 }), ack: async () => acks++ };
  const poller = () => createThinPoller({ home, transport, self, now: () => new Date(at), relay, onRecord: () => emitted++ });
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(poller().once(), { code: 'inbox_seen_limit' });
    assert.equal(acks, 0); assert.equal(readHomeState(home).transport.cursor, 0);
    assert.equal(readHomeState(home).members.m_dev_1.scope, undefined);
    assert.equal(readHomeState(home).members.m_dev_2.scope.seq, 2);
    assert.equal(seenCount(home), INBOX_SEEN_MAX_RECENT_IDS + 1);
    assert.equal(createInbox(home).read().length, 1); assert.equal(emitted, 1);
    at += 300000;
  }
  const duplicate = await delivery(transport, 3, sync('all'), { msgId: mintedId(now().getTime() - INBOX_SEEN_MAX_RECENT_IDS) });
  assert.equal((await createThinInbound({ home, transport, self, now }).receive(duplicate)).status, 'duplicate');
  at += INBOX_SEEN_PROTECTED_MS + 1;
  await poller().once();
  assert.equal(acks, 1); assert.equal(readHomeState(home).transport.acked_seq, 2);
  assert.equal(readHomeState(home).members.m_dev_1.scope.seq, 1);
  assert.equal(createInbox(home).read().length, 2); assert.equal(emitted, 2);
  assert.equal(seenCount(home), INBOX_SEEN_MAX_IDS + 1);
});

test('resequenced replay cannot append, emit, roll scope back, settle a release or complete a newer wait', async t => {
  const { home, transport } = setup(t), emitted = [];
  let at = now().getTime();
  const clock = () => new Date(at), inbound = () => createThinInbound({ home, transport, self, now: clock, onRecord: r => emitted.push(r.cursor) });
  const old = await delivery(transport, 1, sync('all'));
  await inbound().receive(old);
  await inbound().receive(await delivery(transport, 2, sync('none')));
  at++;
  await createGenericSender({ home, transport, self, now: clock })({ type: 'commands', innerText: JSON.stringify(command) });
  await createOutbox({ home, now: clock, relay: { postMessage: async () => ({ seq: 3 }) } }).flush();
  updateHomeState(home, s => {
    s.transport.fast_poll = { devices: ['m_dev_1'], until: at + 1000 };
    s.members.m_dev_1.scope_release = { msg_id: messageId(99), read: ['steps'], write: [], requested_at: at, state: 'pending', sent_seq: 3 };
  });
  const before = JSON.stringify(readHomeState(home).members.m_dev_1);
  assert.equal((await inbound().receive({ ...old, seq: 4 })).status, 'duplicate');
  const state = readHomeState(home);
  assert.ok(JSON.stringify(state.members.m_dev_1) === before);
  assert.equal(Object.values(state.transport.response_waits).filter(w => w.completed_at === undefined).length, 1);
  assert.equal(state.transport.fast_poll.devices.length, 1);
  assert.equal(createInbox(home).read().length, 2); assert.equal(emitted.length, 2);
  assert.equal(seenCount(home), 2);
});

test('pairing reply replay cannot resolve a later awaiting decision', async t => {
  const { home, transport } = setup(t); scopedRequest(home);
  const inbound = () => createThinInbound({ home, transport, self, now });
  const message = await delivery(transport, 1, resolvedReply());
  await inbound().receive(message);
  updateHomeState(home, s => { const access = s.pairings[pairingId].access; access.state = 'awaiting'; delete access.outcomes; delete access.decided_at; });
  assert.equal((await inbound().receive({ ...message, seq: 9 })).status, 'duplicate');
  assert.equal(readHomeState(home).pairings[pairingId].access.state, 'awaiting');
  assert.equal(createInbox(home).read().length, 1);
});

test('seen identities survive history pruning, forget and restart within receipt retention', async t => {
  const { home, transport, pairing } = setup(t);
  let at = now().getTime(); const clock = () => new Date(at);
  const inbound = () => createThinInbound({ home, transport, self, now: clock });
  const message = await delivery(transport, 1, sync('all'));
  await inbound().receive(message);
  at += 30 * 86400000 + 1;
  createInbox(home).prune(clock()); assert.equal(createInbox(home).read().length, 0);
  assert.equal((await inbound().receive({ ...message, seq: 2 })).status, 'duplicate');
  pairing.revoke('m_dev_1'); forgetThinMember(home, 'm_dev_1', { yes: true });
  assert.equal(seenCount(home), 1);
  assert.equal((await inbound().receive({ ...message, seq: 3 })).code, 'unknown_sender');
  assert.equal(seenCount(home), 1); assert.equal(createInbox(home).read().length, 0);
  updateHomeState(home, s => { s.members.m_dev_1.state = 'confirmed'; });
  assert.equal((await inbound().receive({ ...message, seq: 4 })).status, 'duplicate');
  assert.equal(createInbox(home).read().length, 0);
});

for (const age of [INBOX_SEEN_RETENTION_MS - 1, INBOX_SEEN_RETENTION_MS, horizon - 1, horizon, horizon + 1]) test(`authenticated UUID mint age boundary ${age}`, async t => {
  const { home, transport } = setup(t); let at = now().getTime();
  const inbound = () => createThinInbound({ home, transport, self, now: () => new Date(at) });
  const message = await delivery(transport, 1);
  await inbound().receive(message); at += age; createInbox(home).prune(new Date(at));
  const result = await inbound().receive({ ...message, seq: 2 });
  assert.equal(result.status, age < horizon ? 'duplicate' : 'poison');
  if (age >= horizon) assert.equal(result.code, 'expired');
  assert.equal(createInbox(home).read().length, 0);
});

for (const age of [horizon, horizon + 1]) for (const operation of ['renameSync', 'fsyncSync']) test(`fresh delivery recovers once after pruning an expired seen ID and ${operation} state failure at receipt age ${age}`, async t => {
  const { home, transport } = setup(t), start = now().getTime(), emitted = [];
  let at = start;
  const clock = () => new Date(at), inbound = fs => createThinInbound({ home, transport, self, now: clock, fs, onRecord: r => emitted.push(r.cursor) });
  const message = await delivery(transport, 1, sync('all'));
  await inbound().receive(message); emitted.length = 0;
  at += age; createInbox(home).prune(clock());
  updateHomeState(home, s => {
    s.members.m_dev_1.scope = { read: 'none', write: 'none', seq: 2 };
    s.transport.fast_poll = { devices: ['m_dev_1'], until: at + 1000 };
  });
  await createGenericSender({ home, transport, self, now: clock })({ type: 'commands', innerText: JSON.stringify(command) });
  await createOutbox({ home, now: clock, relay: { postMessage: async () => ({ seq: 2 }) } }).flush();
  const active = () => Object.values(readHomeState(home).transport.response_waits).filter(w => w.completed_at === undefined).length;
  const fresh = await delivery(transport, 3, sync('all'), { msgId: mintedId(at) });
  assert.equal((await inbound().receive({ ...message, seq: 3 })).code, 'expired');
  await assert.rejects(inbound(diskFailure(operation, 1, /\.state\.json\./)).receive(fresh), { code: 'ENOSPC' });
  assert.equal(active(), 1); assert.equal(emitted.length, 0); assert.equal(readInbox(home).records.length, 0);
  assert.equal(readHomeState(home).members.m_dev_1.scope.seq, 2);
  assert.equal(readHomeState(home).transport.inbox_seen[`m_dev_1:${keys.dev1.pk}`][message.msg_id], undefined);
  const original = inboxLines(home)[0].record;
  at += age === horizon ? -86400000 : 1000;
  await inbound().reconcile();
  assert.equal(active(), 0); assert.deepEqual(emitted, [original.cursor]); assert.equal(seenCount(home), 1);
  assert.equal(readHomeState(home).members.m_dev_1.scope.seq, 3);
  assert.equal(readHomeState(home).transport.fast_poll.devices.length, 0);
  assert.equal(readHomeState(home).transport.inbox_seen[`m_dev_1:${keys.dev1.pk}`][fresh.msg_id], Math.max(at, original.accepted_at));
  assert.equal(createInbox(home).read()[0].cursor, original.cursor);
  updateHomeState(home, s => { s.members.m_dev_1.scope.seq = 4; });
  assert.equal((await inbound().receive({ ...fresh, seq: 4 })).status, 'duplicate');
  assert.equal(readHomeState(home).members.m_dev_1.scope.seq, 4);
  assert.equal(createInbox(home).read().length, 1); assert.equal(emitted.length, 1);
});

for (const operation of ['renameSync', 'fsyncSync']) test(`fresh delivery recovers when the old UUID horizon passes before ${operation} state failure`, async t => {
  const { home, transport } = setup(t), start = now().getTime(), boundary = start + horizon, emitted = [];
  let at = start, authenticated = false, crossed = false;
  const clock = () => new Date(at), inbound = fs => createThinInbound({ home, transport, self, now: clock, fs, onRecord: r => emitted.push(r.cursor) });
  const message = await delivery(transport, 1, sync('all'));
  await inbound().receive(message); emitted.length = 0;
  at = boundary - 1; createInbox(home).prune(clock());
  updateHomeState(home, s => {
    s.members.m_dev_1.scope = { read: 'none', write: 'none', seq: 2 };
    s.transport.fast_poll = { devices: ['m_dev_1'], until: boundary + 1000 };
  });
  await createGenericSender({ home, transport, self, now: clock })({ type: 'commands', innerText: JSON.stringify(command) });
  await createOutbox({ home, now: clock, relay: { postMessage: async () => ({ seq: 2 }) } }).flush();
  const fresh = await delivery(transport, 3, sync('all'), { msgId: mintedId(boundary) });
  const receive = transport.receive;
  transport.receive = async options => { const parsed = await receive(options); authenticated = true; return parsed; };
  const io = new Proxy(diskFailure(operation, 1, /\.state\.json\./), { get(target, key) {
    if (key !== 'readdirSync') return target[key];
    return (...args) => {
      if (authenticated && args[0] === `${home}/inbox`) { at = boundary; authenticated = false; crossed = true; }
      return target.readdirSync(...args);
    };
  } });
  const active = () => Object.values(readHomeState(home).transport.response_waits).filter(w => w.completed_at === undefined).length;
  await assert.rejects(inbound(io).receive(fresh), { code: 'ENOSPC' });
  assert.equal(crossed, true); assert.equal(active(), 1); assert.equal(emitted.length, 0);
  assert.equal(readInbox(home).records.length, 0); assert.equal(readHomeState(home).members.m_dev_1.scope.seq, 2);
  assert.equal(readHomeState(home).transport.inbox_seen[`m_dev_1:${keys.dev1.pk}`][message.msg_id], start);
  const original = inboxLines(home)[0].record;
  at = boundary + 1; await inbound().reconcile();
  assert.equal(original.accepted_at, boundary); assert.equal(active(), 0); assert.deepEqual(emitted, [original.cursor]);
  const state = readHomeState(home);
  assert.equal(state.members.m_dev_1.scope.seq, 3); assert.equal(state.transport.fast_poll.devices.length, 0);
  assert.equal(state.transport.inbox_seen[`m_dev_1:${keys.dev1.pk}`][fresh.msg_id], boundary + 1);
  assert.equal(state.transport.inbox_committed_cursor, original.cursor);
  assert.equal(Object.values(state.transport.response_waits)[0].completed_at, boundary);
  updateHomeState(home, s => { s.members.m_dev_1.scope.seq = 4; });
  assert.equal((await inbound().receive({ ...fresh, seq: 4 })).status, 'duplicate');
  assert.equal(readHomeState(home).members.m_dev_1.scope.seq, 4);
  assert.equal(createInbox(home).read().length, 1); assert.equal(emitted.length, 1);
});

test('authenticated redelivery refreshes retention and a regressed receiver clock cannot shorten it', async t => {
  const { home, transport } = setup(t); const start = now().getTime(); let at = start;
  const inbound = () => createThinInbound({ home, transport, self, now: () => new Date(at) });
  const message = await delivery(transport, 1);
  await inbound().receive(message);
  at += 30 * 86400000; await inbound().receive({ ...message, seq: 2 });
  at = start - 86400000; await inbound().receive({ ...message, seq: 3 });
  const receipts = Object.values(readHomeState(home).transport.inbox_seen).flatMap(ids => Object.values(ids));
  assert.equal(receipts[0], start + 30 * 86400000);
  at = start + 60 * 86400000; createInbox(home).prune(new Date(at));
  assert.equal((await inbound().receive({ ...message, seq: 4 })).code, 'expired');
  assert.equal(seenCount(home), 0);
  assert.equal(createInbox(home).read().length, 0);
});

test('out-of-order unseen IDs remain eligible within the horizon while stale UUIDs are rejected', async t => {
  const { home, transport } = setup(t), inbound = createThinInbound({ home, transport, self, now });
  const early = await delivery(transport, 1003, { type: 'future' }, { msgId: mintedId(now().getTime() - horizon + 1), createdAt: '2024-01-01T00:00:00Z' });
  for (let seq = 1; seq <= 1001; seq++) assert.equal((await inbound.receive(await delivery(transport, seq, { type: 'future' }))).status, 'stored');
  assert.equal((await inbound.receive(early)).status, 'stored');
  assert.equal((await inbound.receive(await delivery(transport, 1004, { type: 'future' }, { msgId: mintedId(now().getTime() - horizon), createdAt: '2022-01-01T00:00:00Z' }))).code, 'expired');
  assert.equal((await inbound.receive(await delivery(transport, 1005, { type: 'future' }, { msgId: mintedId(now().getTime() - horizon - 1), createdAt: '2021-01-01T00:00:00Z' }))).code, 'expired');
  assert.equal(seenCount(home), 1002);
  assert.equal(createInbox(home).read({ limit: 2000 }).length, 1002);
});

test('identical IDs are independent across sender and public-key bindings; equal bodies with new IDs remain new', async t => {
  const { home, transport, pairing } = setup(t), inbound = () => createThinInbound({ home, transport, self, now });
  pairing.join({ member_id: 'm_dev_2', role: 'device', public_key: keys.dev2.pk }, { verified: true });
  pairing.confirmFingerprint('m_dev_2', readHomeState(home).members.m_dev_2.fingerprint);
  await inbound().receive(await delivery(transport, 1));
  await inbound().receive(await delivery(transport, 2, undefined, { msgId: messageId(1), from: 'm_dev_2', senderPrivateKey: b64uDecode(keys.dev2.sk) }));
  updateHomeState(home, s => { s.members.m_dev_1.public_key = keys.dev2.pk; });
  await inbound().receive(await delivery(transport, 3, undefined, { msgId: messageId(1), senderPrivateKey: b64uDecode(keys.dev2.sk) }));
  await inbound().receive(await delivery(transport, 4, undefined, { senderPrivateKey: b64uDecode(keys.dev2.sk) }));
  assert.equal(seenCount(home), 4); assert.equal(createInbox(home).read().length, 4);
});

test('held out-of-order IDs become seen only on authenticated release and are replay safe afterwards', async t => {
  const { home, transport, pairing } = setup(t, { confirmed: false });
  const inbound = () => createThinInbound({ home, transport, self, now }), rows = [await delivery(transport, 3), await delivery(transport, 1)];
  for (const row of rows) assert.equal((await inbound().receive(row)).status, 'held');
  assert.equal(seenCount(home), 0);
  pairing.confirmFingerprint('m_dev_1', readHomeState(home).members.m_dev_1.fingerprint);
  await inbound().releaseHeld(); assert.equal(seenCount(home), 2);
  const records = createInbox(home).read();
  assert.ok(records.every(r => r.msg_id && r.public_key && Number.isSafeInteger(r.accepted_at)));
  for (const row of rows) assert.equal((await inbound().receive({ ...row, seq: row.seq + 10 })).status, 'duplicate');
  assert.equal(createInbox(home).read().length, 2); assert.equal(createCipherFiles(home, 'held').list().length, 0);
});

test('concurrent authenticated deliveries commit and emit once across restarted observers', async t => {
  const { home, transport } = setup(t); let emitted = 0;
  const message = await delivery(transport, 1, sync('all'));
  const results = await Promise.all(Array.from({ length: 4 }, (_, i) => createThinInbound({ home, transport, self, now, onRecord: () => emitted++ }).receive({ ...message, seq: i + 1 })));
  assert.equal(results.filter(r => r.status === 'stored').length, 1);
  assert.equal(emitted, 1); assert.equal(createInbox(home).read().length, 1); assert.equal(seenCount(home), 1);
});

for (const [operation, pattern] of [['writeSync', /\.jsonl$/], ['fsyncSync', /\.jsonl$/], ['renameSync', /\.state\.json\./], ['fsyncSync', /\.state\.json\./]]) test(`${operation} ${pattern} failure leaves ciphertext unACKed and effects recover once`, async t => {
  const { home, transport } = setup(t); const message = await delivery(transport, 1, sync('all')); let acks = 0, emitted = 0;
  const relay = { getMessages: async () => ({ messages: [message], next_after: 1 }), ack: async () => acks++ };
  // State faults are armed only after a complete inbox row exists.
  const failing = diskFailure(operation, 1, pattern);
  const io = new Proxy(fs, { get(target, key) {
    if (key === 'openSync' || key === 'closeSync') return failing[key];
    if (key !== operation) return target[key];
    return (...args) => {
      if (!String(pattern).includes('state') || inboxLines(home, { snapshot: true }).length) return failing[key](...args);
      return target[key](...args);
    };
  } });
  await assert.rejects(createThinPoller({ home, transport, self, now, relay, fs: io, onRecord: () => emitted++ }).once(), { code: 'ENOSPC' });
  assert.equal(acks, 0); assert.equal(readHomeState(home).transport.cursor, 0); assert.equal(seenCount(home), 0);
  assert.equal(readHomeState(home).members.m_dev_1.scope, undefined);
  assert.equal(readInbox(home).records.length, 0);
  const inbound = () => createThinInbound({ home, transport, self, now, onRecord: () => emitted++ });
  await inbound().receive(message);
  assert.equal(emitted, 1); assert.equal(seenCount(home), 1); assert.equal(createInbox(home).read().length, 1);
  updateHomeState(home, s => { s.members.m_dev_1.scope = { read: 'none', write: 'none', seq: 2 }; });
  assert.equal((await inbound().receive({ ...message, seq: 3 })).status, 'duplicate');
  assert.equal(emitted, 1); assert.equal(readHomeState(home).members.m_dev_1.scope.seq, 2);
});

test('an interrupted tail recovers before later scope effects, and retains original receipt, cursor and wait correlation', async t => {
  const { home, transport } = setup(t); let at = now().getTime(), emitted = 0;
  const message = await delivery(transport, 1, sync('all'));
  await assert.rejects(createThinInbound({ home, transport, self, now, fs: diskFailure('renameSync', 1, /\.state\.json\./) }).receive(message), { code: 'ENOSPC' });
  const original = inboxLines(home)[0].record;
  assert.equal(readInbox(home).records.length, 0);
  at++;
  await createGenericSender({ home, transport, self, now: () => new Date(at) })({ type: 'commands', innerText: JSON.stringify(command) });
  await createOutbox({ home, now: () => new Date(at), relay: { postMessage: async () => ({ seq: 2 }) } }).flush();
  assert.equal(Object.values(readHomeState(home).transport.response_waits).filter(w => w.completed_at === undefined).length, 1);
  at++;
  await createThinInbound({ home, transport, self, now: () => new Date(at), onRecord: () => emitted++ }).receive(await delivery(transport, 3, sync('none')));
  const state = readHomeState(home), rows = createInbox(home).read();
  assert.equal(state.members.m_dev_1.scope.seq, 3); assert.equal(rows[0].cursor, original.cursor);
  assert.equal(rows[0].accepted_at, original.accepted_at); assert.equal(rows[0].received_at, original.received_at);
  assert.equal(emitted, 2); assert.equal(seenCount(home), 2);
});

for (const invalidation of ['revoked', 'rejected', 'proof_invalidated']) test(`an interrupted tail invalidated by ${invalidation} cannot restore trust or block another sender`, async t => {
  const { home, transport, pairing } = setup(t, { confirmed: invalidation === 'revoked' }), emitted = [];
  const proof = Buffer.alloc(32, 1).toString('base64url');
  if (invalidation !== 'revoked') updateHomeState(home, s => { s.members.m_dev_1.pair_proof = proof; });
  const message = await delivery(transport, 1, invalidation === 'revoked' ? sync('all') : { v: 1, type: 'pair_proof', proof });
  const inbound = fs => createThinInbound({ home, transport, self, now, fs, onRecord: r => emitted.push(r.cursor) });
  await assert.rejects(inbound(diskFailure('renameSync', 1, /\.state\.json\./)).receive(message), { code: 'ENOSPC' });
  const original = inboxLines(home)[0].record;
  if (invalidation === 'proof_invalidated') assert.throws(() => pairing.confirmProof('m_dev_1', Buffer.alloc(32, 2).toString('base64url')), { code: 'pair_proof_invalid' });
  else pairing.revoke('m_dev_1', { rejected: invalidation === 'rejected' });
  const before = JSON.stringify(readHomeState(home).members.m_dev_1);
  await assert.rejects(inbound(diskFailure('renameSync', 1, /\.state\.json\./)).reconcile(), { code: 'ENOSPC' });
  assert.ok(original.cursor > (readHomeState(home).transport.inbox_committed_cursor ?? -1));
  assert.equal(seenCount(home), 0); assert.equal(emitted.length, 0);
  pairing.join({ member_id: 'm_dev_2', role: 'device', public_key: keys.dev2.pk }, { verified: true });
  pairing.confirmFingerprint('m_dev_2', readHomeState(home).members.m_dev_2.fingerprint);
  const next = await delivery(transport, 2, sync('none'), { from: 'm_dev_2', senderPrivateKey: b64uDecode(keys.dev2.sk) });
  let acked = 0;
  const relay = { getMessages: async () => ({ messages: [message, next], next_after: 2 }), ack: async seq => { acked = seq; } };
  await createThinPoller({ home, transport, self, now, relay, onRecord: r => emitted.push(r.cursor) }).once();
  assert.ok(JSON.stringify(readHomeState(home).members.m_dev_1) === before);
  assert.equal(seenCount(home), 1); assert.equal(emitted.length, 1);
  assert.equal(readHomeState(home).members.m_dev_2.scope.seq, 2);
  assert.ok(readHomeState(home).transport.inbox_seen[`m_dev_1:${keys.dev1.pk}`] === undefined);
  assert.equal(acked, 2); assert.equal(readHomeState(home).transport.cursor, 2); assert.equal(readHomeState(home).transport.acked_seq, 2);
  await inbound().reconcile(); assert.equal(emitted.length, 1);
});

test('state directory durability failure after commit suppresses effects and still requires durable retry before ACK', async t => {
  const { home, transport } = setup(t), message = await delivery(transport, 1, sync('all'));
  let fired = false;
  const trace = syncTrace(path => {
    if (path === home && readHomeState(home).transport.inbox_committed_cursor !== undefined && !fired) {
      fired = true; throw Object.assign(new Error('fixture disk failure'), { code: 'ENOSPC' });
    }
  });
  await assert.rejects(createThinInbound({ home, transport, self, now, ...trace }).receive(message), { code: 'ENOSPC' });
  assert.equal(fired, true); assert.equal(seenCount(home), 1);
  updateHomeState(home, s => { s.members.m_dev_1.scope.seq = 2; });
  assert.equal((await createThinInbound({ home, transport, self, now }).receive({ ...message, seq: 3 })).status, 'duplicate');
  assert.equal(readHomeState(home).members.m_dev_1.scope.seq, 2); assert.equal(createInbox(home).read().length, 1);
});

test('same-seq conflicts remain failures even when the incoming ID was already seen', async t => {
  const { home, transport } = setup(t), inbound = createThinInbound({ home, transport, self, now });
  const first = await delivery(transport, 1), second = await delivery(transport, 2);
  await inbound.receive(first); await inbound.receive(second);
  await assert.rejects(inbound.receive({ ...first, seq: 2 }), { code: 'invalid_state' });
  await assert.rejects(inbound.receive(await delivery(transport, 1, { type: 'different' })), { code: 'invalid_state' });
  assert.equal(createInbox(home).read().length, 2);
});

test('0.1.4 rows remain readable and seed the committed cursor without reapplying scope', async t => {
  const { home, transport } = setup(t);
  createInbox(home).append({ seq: 10, from: 'm_dev_1', kind: 'data', type: 'sync', received_at: now().toISOString(), inner: sync('all') });
  await createThinInbound({ home, transport, self, now }).receive(await delivery(transport, 1, sync('none')));
  const records = readInbox(home).records;
  assert.equal(records.length, 2); assert.equal(records[0].msg_id, undefined);
  assert.equal(readHomeState(home).members.m_dev_1.scope.seq, 1); assert.equal(seenCount(home), 1);
});

test('replay metadata and authenticated record identity corruption fail closed', async t => {
  const { home, transport } = setup(t);
  await createThinInbound({ home, transport, self, now }).receive(await delivery(transport, 1));
  for (const mutation of [s => { s.transport.inbox_seen = []; }, s => { s.transport.inbox_seen = { invalid: {} }; }, s => { s.transport.inbox_committed_cursor = -2; }, s => { s.transport.inbox_seen_at = -1; },
    ...[-1, 1.5, '1', null, Number.MAX_SAFE_INTEGER + 1].map(floor => s => { s.transport.inbox_seen_floor = { [binding]: floor }; }),
    s => { s.transport.inbox_seen_floor = 1; }, s => { s.transport.inbox_seen_floor = { invalid: 1 }; },
    s => { Object.values(s.transport.inbox_seen)[0][messageId(1)] = -1; }]) {
    const state = readHomeState(home); mutation(state); assert.throws(() => validateHomeState(state), { code: 'corrupt_state' });
  }
  const path = `${home}/inbox/2026-11-05.jsonl`, bytes = fs.readFileSync(path, 'utf8');
  for (const patch of [{ msg_id: 'bad' }, { public_key: 'bad' }, { accepted_at: -1 }, { cursor: undefined }]) {
    const row = { ...JSON.parse(bytes), ...patch }; fs.writeFileSync(path, JSON.stringify(row) + '\n');
    assert.throws(() => createInbox(home).read(), { code: 'corrupt_state' });
  }
});

for (const fault of [['writeSync', /\.jsonl$/], ['fsyncSync', /\.jsonl$/], ['renameSync', /\.state\.json\./]]) test(`pair proof and held effects recover atomically after ${fault[0]} ${fault[1]}`, async t => {
  const { home, transport } = setup(t, { confirmed: false }), proof = Buffer.alloc(32, 1).toString('base64url');
  updateHomeState(home, s => { s.members.m_dev_1.pair_proof = proof; });
  const held = await delivery(transport, 1, sync('none')), message = await delivery(transport, 2, { v: 1, type: 'pair_proof', proof });
  await createThinInbound({ home, transport, self, now }).receive(held);
  await assert.rejects(createThinInbound({ home, transport, self, now, fs: diskFailure(fault[0], 1, fault[1]) }).receive(message), { code: 'ENOSPC' });
  assert.equal(readHomeState(home).members.m_dev_1.state, 'joined');
  assert.equal(readHomeState(home).members.m_dev_1.confirmation, undefined); assert.equal(seenCount(home), 0);
  assert.equal(createCipherFiles(home, 'held').list().length, 1);
  const inbound = () => createThinInbound({ home, transport, self, now });
  await inbound().receive(message); await inbound().releaseHeld();
  const rows = createInbox(home).read(), queue = createCipherFiles(home, 'outbox').list();
  assert.equal(readHomeState(home).members.m_dev_1.state, 'confirmed');
  assert.equal(rows.length, 2); assert.equal(rows.filter(r => r.msg_id === message.msg_id).length, 1);
  assert.equal(queue.filter(e => e.type === 'confirmed').length, 1); assert.equal(createCipherFiles(home, 'held').list().length, 0);
  assert.equal((await inbound().receive({ ...message, seq: 3 })).status, 'duplicate');
  assert.equal((await inbound().receive({ ...held, seq: 4 })).status, 'duplicate');
  assert.equal(createInbox(home).read().length, 2); assert.equal(seenCount(home), 2);
});

test('uncommitted tail fsync failure remains unACKed on recovery and is retained by pruning', async t => {
  const { home, transport } = setup(t), message = await delivery(transport, 1, sync('all'));
  await assert.rejects(createThinInbound({ home, transport, self, now, fs: diskFailure('renameSync', 1, /\.state\.json\./) }).receive(message), { code: 'ENOSPC' });
  createInbox(home).prune(new Date(now().getTime() + 40 * 86400000));
  assert.equal(inboxLines(home).length, 1); assert.equal(readInbox(home).records.length, 0);
  let acks = 0;
  const relay = { getMessages: async () => ({ messages: [message], next_after: 1 }), ack: async () => acks++ };
  await assert.rejects(createThinPoller({ home, transport, self, relay, now, fs: diskFailure('fsyncSync', 1, /\.jsonl$/) }).once(), { code: 'ENOSPC' });
  assert.equal(acks, 0); assert.equal(seenCount(home), 0); assert.equal(readHomeState(home).transport.cursor, 0);
  await createThinPoller({ home, transport, self, relay, now }).once();
  assert.equal(acks, 1); assert.equal(seenCount(home), 1); assert.equal(createInbox(home).read().length, 1);
});

test('resequenced duplicates permit durable poll/ACK progress without any additional record or emission', async t => {
  const { home, transport } = setup(t), message = await delivery(transport, 1, sync('none'));
  let at = now().getTime(), seq = 1, emissions = 0, acks = 0;
  const relay = { getMessages: async () => ({ messages: [{ ...message, seq }], next_after: seq }), ack: async n => { acks = n; } };
  const poller = () => createThinPoller({ home, transport, self, relay, now: () => new Date(at), onRecord: () => emissions++ });
  await poller().once(); seq = 2; at += 300000; await poller().once();
  assert.equal(acks, 2); assert.equal(readHomeState(home).transport.cursor, 2);
  assert.equal(readHomeState(home).transport.acked_seq, 2); assert.equal(emissions, 1); assert.equal(createInbox(home).read().length, 1);
});

for (const delta of [0, -86400000]) test(`outbox recovery cannot use old replies after receiver clock delta ${delta}`, async t => {
  const { home, transport } = setup(t); let at = now().getTime(); const clock = () => new Date(at);
  const message = await delivery(transport, 1, sync('none'));
  await createThinInbound({ home, transport, self, now: clock }).receive(message);
  at += delta;
  await createGenericSender({ home, transport, self, now: clock })({ type: 'commands', innerText: JSON.stringify(command) });
  await createOutbox({ home, now: clock, relay: { postMessage: async () => ({ seq: 2 }) } }).flush();
  const active = () => Object.values(readHomeState(home).transport.response_waits).filter(w => w.completed_at === undefined).length;
  assert.equal(active(), 1);
  assert.equal((await createThinInbound({ home, transport, self, now: clock }).receive({ ...message, seq: 3 })).status, 'duplicate');
  await createOutbox({ home, now: clock }).flush(); assert.equal(active(), 1);
  await createThinInbound({ home, transport, self, now: clock }).receive(await delivery(transport, 4, sync('none')));
  assert.equal(active(), 0);
});

test('unauthenticated replay cannot reserve seen identity and a raced trust change cannot admit effects', async t => {
  const { home, transport, pairing } = setup(t), message = await delivery(transport, 1, sync('all'));
  const forged = { ...message, ciphertext: message.ciphertext.slice(0, -2) + 'AA' };
  assert.equal((await createThinInbound({ home, transport, self, now }).receive(forged)).status, 'poison');
  assert.equal(seenCount(home), 0);
  const receive = transport.receive;
  transport.receive = async options => { const parsed = await receive(options); pairing.revoke('m_dev_1'); return parsed; };
  assert.equal((await createThinInbound({ home, transport, self, now }).receive(message)).code, 'unknown_sender');
  assert.equal(seenCount(home), 0); assert.equal(createInbox(home).read().length, 0);
});


for (const full of [false, true]) test(`a hard exit after authenticated append recovers the original row and effects before later delivery${full ? ' at seen capacity' : ''}`, async t => {
  const { home, transport } = setup(t), message = await delivery(transport, 1, sync('all'));
  const firstMint = now().getTime() - INBOX_SEEN_PROTECTED_MS - INBOX_SEEN_MAX_IDS;
  if (full) seedSeen(home, firstMint);
  const inboundModule = new URL('../../src/thin-inbound.js', import.meta.url).href;
  const transportModule = new URL('../support/thin-transport.js', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    import { createThinInbound } from ${JSON.stringify(inboundModule)};
    import { tablePath, self, now } from ${JSON.stringify(transportModule)};
    import { createThinTransport } from ${JSON.stringify(new URL('../../src/thin-transport.js', import.meta.url).href)};
    const io = new Proxy(fs, { get(target, key) {
      if (key !== 'renameSync') return target[key];
      return (path, ...args) => { if (/\\.state\\.json\\./.test(path)) process.exit(87); return target.renameSync(path, ...args); };
    } });
    await createThinInbound({ home: process.argv[1], transport: createThinTransport({ tablePath }), self, now, fs: io }).receive(JSON.parse(process.argv[2]));
  `, home, JSON.stringify(message)]);
  assert.equal(child.status, 87); assert.equal(seenCount(home), full ? INBOX_SEEN_MAX_IDS : 0); assert.equal(readInbox(home).records.length, 0);
  assert.equal(readHomeState(home).transport.inbox_seen_floor, undefined);
  const original = inboxLines(home)[0].record;
  await createThinInbound({ home, transport, self, now }).receive(await delivery(transport, 2, sync('none')));
  assert.equal(seenCount(home), full ? INBOX_SEEN_MAX_IDS : 2); assert.equal(createInbox(home).read()[0].cursor, original.cursor);
  assert.equal(seenFloor(home), full ? firstMint + 1 : undefined);
  assert.equal(readHomeState(home).members.m_dev_1.scope.seq, 2);
});


test('a new delivery during receiver clock regression retains a full receipt-age window after restart', async t => {
  const { home, transport } = setup(t); const start = now().getTime(); let at = start;
  const inbound = fs => createThinInbound({ home, transport, self, now: () => new Date(at), fs });
  await inbound().receive(await delivery(transport, 1));
  at -= 60 * 86400000;
  const message = await delivery(transport, 2);
  await inbound().receive(message);
  assert.equal(createInbox(home).read().find(r => r.seq === 2).accepted_at, at);
  at = start + INBOX_SEEN_RETENTION_MS - 1;
  assert.equal((await inbound().receive({ ...message, seq: 3 })).status, 'duplicate');
  assert.equal(seenCount(home), 2);
});

test('pairing decision and response wait share seen admission across an interrupted commit', async t => {
  const { home, transport } = setup(t); scopedRequest(home);
  const reply = { ...resolvedReply(), decided_at: now().toISOString().replace('.000Z', 'Z') };
  await createGenericSender({ home, transport, self, now })({ type: 'access_request', innerText: JSON.stringify({ v: 1, type: 'access_request',
    request_ref: reply.request_ref, read: ['steps'], write: ['body_mass'], created_at: now().toISOString(), expires_at: new Date(now().getTime() + 86400000).toISOString() }) });
  await createOutbox({ home, now, relay: { postMessage: async () => ({ seq: 1 }) } }).flush();
  const message = await delivery(transport, 2, reply);
  const active = () => Object.values(readHomeState(home).transport.response_waits).filter(w => w.kind === 'access' && w.completed_at === undefined).length;
  await assert.rejects(createThinInbound({ home, transport, self, now, fs: diskFailure('renameSync', 1, /\.state\.json\./) }).receive(message), { code: 'ENOSPC' });
  assert.equal(active(), 1); assert.equal(readHomeState(home).pairings[pairingId].access.state, 'awaiting'); assert.equal(seenCount(home), 0);
  await createThinInbound({ home, transport, self, now }).releaseHeld();
  assert.equal(active(), 0); assert.equal(readHomeState(home).pairings[pairingId].access.state, 'resolved'); assert.equal(seenCount(home), 1);
  updateHomeState(home, s => {
    const access = s.pairings[pairingId].access; access.state = 'awaiting'; delete access.outcomes; delete access.decided_at;
    for (const w of Object.values(s.transport.response_waits)) if (w.kind === 'access') delete w.completed_at;
  });
  assert.equal((await createThinInbound({ home, transport, self, now }).receive({ ...message, seq: 3 })).status, 'duplicate');
  assert.equal(active(), 1); assert.equal(readHomeState(home).pairings[pairingId].access.state, 'awaiting');
});
