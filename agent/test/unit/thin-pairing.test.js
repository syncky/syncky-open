import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createHomeState, readHomeState, updateHomeState, createCipherFiles } from "../../src/home-state.js";
import { createThinPairing } from "../../src/thin-pairing.js";
import { createInbox } from "../../src/inbox.js";
import { forgetThinMember } from "../../src/home-state.js";
import { pairProof } from "../../src/pair-code.js";
import { diskFailure, fixture, identity, keys, messageId, syncTrace } from "../support/thin-home.js";
import { scopedRequest, pairingId, requestedScope } from '../support/pairing-scope.js';
import { setup, now } from '../support/thin-transport.js';

test('scoped confirmation fixes a restart-safe reply deadline; reject and revoke cancel it', t => {
  const { home, pairing } = setup(t, { confirmed: false }); scopedRequest(home);
  pairing.confirmFingerprint('m_dev_1', readHomeState(home).members.m_dev_1.fingerprint);
  const access = readHomeState(home).pairings[pairingId].access;
  assert.equal(access.confirmed_at, now().toISOString());
  assert.equal(Date.parse(access.deadline_at), now().getTime() + 900000);
  createThinPairing(home, { now: () => new Date(now().getTime() + 600000) }).confirmFingerprint('m_dev_1', readHomeState(home).members.m_dev_1.fingerprint);
  assert.deepEqual(readHomeState(home).pairings[pairingId].access, access);
  pairing.revoke('m_dev_1');
  assert.equal(readHomeState(home).pairings[pairingId].access.state, 'cancelled');
});

test('rejected scoped member cancels the request and cannot inherit a later join', t => {
  const { home, pairing } = setup(t, { confirmed: false }); scopedRequest(home);
  pairing.revoke('m_dev_1', { rejected: true });
  assert.equal(readHomeState(home).pairings[pairingId].access.state, 'cancelled');
  pairing.join({ member_id: 'm_dev_2', role: 'device', public_key: keys.dev2.pk, pairing_id: pairingId }, { verified: true });
  assert.equal(readHomeState(home).pairings[pairingId].member_id, 'm_dev_1');
});

test('late confirmation does not reopen the bounded joined request wait', t => {
  const { home } = setup(t, { confirmed: false }); scopedRequest(home);
  const pairing = createThinPairing(home, { now: () => new Date(now().getTime() + 900000) });
  pairing.confirmFingerprint('m_dev_1', readHomeState(home).members.m_dev_1.fingerprint);
  assert.equal(readHomeState(home).members.m_dev_1.state, 'confirmed');
  assert.equal(readHomeState(home).pairings[pairingId].access.state, 'cancelled');
});

test('scoped join recovers a file-first write and retains the ref when state persistence fails', t => {
  const home = fixture(t); createHomeState(home, identity);
  const expires_at = new Date(now().getTime() + 600000).toISOString();
  fs.writeFileSync(join(home, 'pairing.json'), JSON.stringify({ pairing_id: pairingId, expires_at, requested_scope: requestedScope }), { mode: 0o600 });
  const fields = { member_id: 'm_dev_1', role: 'device', public_key: keys.dev1.pk, pairing_id: pairingId };
  assert.throws(() => createThinPairing(home, { now, fs: diskFailure('renameSync', 1, /state\.json/) }).join(fields, { verified: true }), { code: 'ENOSPC' });
  assert.ok(fs.existsSync(join(home, 'pairing.json'))); assert.equal(readHomeState(home).members.m_dev_1, undefined);
  createThinPairing(home, { now }).join(fields, { verified: true });
  assert.equal(fs.existsSync(join(home, 'pairing.json')), false);
  const row = readHomeState(home).pairings[pairingId];
  assert.deepEqual(row.requested_scope, requestedScope); assert.equal(row.expires_at, expires_at); assert.equal(row.public_key, keys.dev1.pk);
});

test("fingerprint confirmation durably schedules one reply and join-bounded fast polling; revocation ends it", t => {
  const home = fixture(t), at = new Date("2026-11-05T12:00:00Z"); createHomeState(home, identity);
  const pairing = createThinPairing(home, { now: () => at });
  const member = { member_id: "m_dev_1", public_key: keys.dev1.pk, role: "device", joined_at: at.toISOString() };
  pairing.join(member, { verified: true });
  updateHomeState(home, s => { s.transport.next_poll_at = at.getTime() + 1800000; s.transport.last_poll_at = at.getTime(); });
  pairing.confirmFingerprint(member.member_id, readHomeState(home).members.m_dev_1.fingerprint);
  const confirmed = readHomeState(home);
  assert.ok(confirmed.members.m_dev_1.confirmation);
  assert.deepEqual(confirmed.transport.fast_poll.devices, [member.member_id]);
  assert.equal(confirmed.transport.fast_poll.until, at.getTime() + 840000);
  assert.equal(confirmed.transport.next_poll_at, at.getTime() + 25000);
  pairing.confirmFingerprint(member.member_id, confirmed.members.m_dev_1.fingerprint);
  assert.deepEqual(readHomeState(home).members.m_dev_1.confirmation, confirmed.members.m_dev_1.confirmation);
  pairing.revoke(member.member_id);
  assert.equal(readHomeState(home).members.m_dev_1.confirmation, undefined);
  assert.deepEqual(readHomeState(home).transport.fast_poll.devices, []);
});

for (const joinedAt of [undefined, "invalid", "2026-11-05T11:00:00Z"]) test(`confirmation cannot create a new grace window from ${joinedAt}`, t => {
  const home = fixture(t), at = new Date("2026-11-05T12:00:00Z"); createHomeState(home, identity);
  const pairing = createThinPairing(home, { now: () => at });
  pairing.join({ member_id: "m_dev_1", public_key: keys.dev1.pk, role: "device", joined_at: joinedAt }, { verified: true });
  pairing.confirmFingerprint("m_dev_1", readHomeState(home).members.m_dev_1.fingerprint);
  assert.equal(readHomeState(home).transport.fast_poll, undefined);
});

test("reconciled duplicate joins recover missing grace, ignore missing timestamps and never extend the window", t => {
  const home = fixture(t), at = new Date("2026-11-05T12:00:00Z"); createHomeState(home, identity);
  const pairing = createThinPairing(home, { now: () => at }), member = { member_id: "m_dev_1", public_key: keys.dev1.pk, role: "device" };
  pairing.join(member, { verified: true });
  pairing.join({ ...member, joined_at: at.toISOString() }, { verified: true });
  assert.equal(readHomeState(home).members.m_dev_1.join_grace_until, at.getTime() + 900000);
  pairing.join(member, { verified: true });
  assert.equal(readHomeState(home).members.m_dev_1.join_grace_until, at.getTime() + 900000);
  pairing.join({ ...member, joined_at: new Date(at.getTime() - 60000).toISOString() }, { verified: true });
  pairing.join({ ...member, joined_at: at.toISOString() }, { verified: true });
  pairing.confirmFingerprint(member.member_id, readHomeState(home).members.m_dev_1.fingerprint);
  assert.equal(readHomeState(home).transport.fast_poll.until, at.getTime() + 780000);
});

test("pending v2 proof survives credential cleanup and restart; held data waits for trust", (t) => {
  const home = fixture(t), pairingId = `p_${"P".repeat(22)}`, secret = Buffer.alloc(16, 1).toString("base64url");
  createHomeState(home, identity);
  const bytes = JSON.stringify({ pairing_id: pairingId, pair_secret: secret, expires_at: "2026-11-06T00:00:00Z", extra: true }, null, 4);
  fs.writeFileSync(join(home, "pairing.json"), bytes, { mode: 0o600 });
  updateHomeState(home, s => { s.pairings[pairingId] = { pairing_id: pairingId, status: "pending", expires_at: "2026-11-06T00:00:00Z" }; });
  const pairing = createThinPairing(home);
  const member = { member_id: "m_dev_1", public_key: keys.dev1.pk, role: "device", pairing_id: pairingId };
  assert.throws(() => pairing.join(member), { code: "invalid_state" });
  pairing.join(member, { verified: true });
  const held = createCipherFiles(home, "held");
  held.put({ msg_id: messageId(1), seq: 1, from: "m_dev_1", body: "ciphertext", kind: "data" });
  assert.equal(pairing.trustedKey("m_dev_1"), null);
  assert.throws(() => pairing.confirmFingerprint("m_dev_1", "0000 0000 0000 0000"), { code: "fingerprint_mismatch" });
  assert.throws(() => pairing.join({ ...member, public_key: keys.dev2.pk }, { verified: true }), { code: "key_conflict" });
  const restarted = createThinPairing(home);
  restarted.confirmProof("m_dev_1", pairProof(secret, identity.public_key, keys.dev1.pk));
  assert.ok(restarted.trustedKey("m_dev_1") === keys.dev1.pk);
  assert.equal(held.list().length, 1);
  assert.equal(fs.existsSync(join(home, "pairing.json")), false);
  restarted.revoke("m_dev_1");
  assert.equal(restarted.trustedKey("m_dev_1"), null);
  assert.equal(readHomeState(home).members.m_dev_1.pair_proof, null);
  assert.throws(() => restarted.confirmProof("m_dev_1", pairProof(secret, identity.public_key, keys.dev1.pk)), { code: "invalid_transition" });
});

for (const failure of ['renameSync', 'unlinkSync']) test(`pairing credentials survive ${failure} failure until the derived proof commits and cleanup retries`, t => {
  const home = fixture(t); createHomeState(home, identity);
  const pairingId = `p_${'P'.repeat(22)}`, secret = Buffer.alloc(16, 1).toString('base64url');
  const path = join(home, 'pairing.json');
  const bytes = JSON.stringify({ pairing_id: pairingId, pair_secret: secret });
  fs.writeFileSync(path, bytes, { mode: 0o600 });
  updateHomeState(home, s => { s.pairings[pairingId] = { pairing_id: pairingId, status: 'pending', expires_at: '2026-11-06T00:00:00Z' }; });
  const member = { member_id: 'm_dev_1', public_key: keys.dev1.pk, role: 'device', pairing_id: pairingId };
  const pairing = createThinPairing(home, { fs: diskFailure(failure, 1, failure === 'unlinkSync' ? /pairing\.json$/ : /state\.json/) });
  assert.throws(() => pairing.join(member, { verified: true }), { code: 'ENOSPC' });
  assert.ok(fs.readFileSync(path, 'utf8') === bytes, 'uncommitted credentials changed');
  const stored = readHomeState(home).members.m_dev_1;
  if (failure === 'unlinkSync') assert.equal(stored.pair_proof, pairProof(secret, identity.public_key, keys.dev1.pk));
  else assert.equal(stored, undefined);
  createThinPairing(home).join(member, { verified: true });
  assert.equal(fs.existsSync(path), false);
  assert.equal(readHomeState(home).members.m_dev_1.pair_proof, pairProof(secret, identity.public_key, keys.dev1.pk));
});

test('an older completed join cannot erase a newer pairing credential file', t => {
  const home = fixture(t); createHomeState(home, identity);
  const path = join(home, 'pairing.json'), bytes = JSON.stringify({ pairing_id: `p_${'N'.repeat(22)}`, pair_secret: Buffer.alloc(16, 2).toString('base64url') });
  fs.writeFileSync(path, bytes, { mode: 0o600 });
  createThinPairing(home).join({ member_id: 'm_dev_1', public_key: keys.dev1.pk, role: 'device', pairing_id: `p_${'O'.repeat(22)}` }, { verified: true });
  assert.ok(fs.readFileSync(path, 'utf8') === bytes, 'newer credentials changed');
});

test("a failed v2 proof stays invalidated across restart and requires the fingerprint", (t) => {
  const home = fixture(t); createHomeState(home, identity);
  const pairingId = `p_${"P".repeat(22)}`, secret = Buffer.alloc(16, 1).toString("base64url");
  fs.writeFileSync(join(home, "pairing.json"), JSON.stringify({ pairing_id: pairingId, pair_secret: secret }), { mode: 0o600 });
  updateHomeState(home, s => { s.pairings[pairingId] = { pairing_id: pairingId, status: "pending", expires_at: "2026-11-06T00:00:00Z" }; });
  const pairing = createThinPairing(home);
  pairing.join({ member_id: "m_dev_1", public_key: keys.dev1.pk, role: "device", pairing_id: pairingId }, { verified: true });
  assert.throws(() => pairing.confirmProof("m_dev_1", "wrong"), { code: "pair_proof_invalid" });
  const restarted = createThinPairing(home);
  assert.throws(() => restarted.confirmProof("m_dev_1", pairProof(secret, identity.public_key, keys.dev1.pk)), { code: "pair_proof_invalid" });
  assert.equal(restarted.trustedKey("m_dev_1"), null);
  restarted.confirmFingerprint("m_dev_1", readHomeState(home).members.m_dev_1.fingerprint);
  assert.ok(restarted.trustedKey("m_dev_1") === keys.dev1.pk);
});

test("fingerprint confirmation works for v1; duplicate relay joins cannot revive revoked trust", (t) => {
  const home = fixture(t); createHomeState(home, identity);
  const pairing = createThinPairing(home);
  pairing.join({ member_id: "m_dev_1", public_key: keys.dev1.pk, role: "device" }, { verified: true });
  pairing.confirmFingerprint("m_dev_1", readHomeState(home).members.m_dev_1.fingerprint);
  assert.ok(pairing.trustedKey("m_dev_1") === keys.dev1.pk);
  pairing.revoke("m_dev_1");
  pairing.join({ member_id: "m_dev_1", public_key: keys.dev1.pk, role: "device" }, { verified: true });
  assert.equal(pairing.trustedKey("m_dev_1"), null);
});

test("revocation and rejection retries finish interrupted ciphertext directory syncs", t => {
  for (const rejected of [false, true]) for (const area of ["held", "outbox"]) {
    const home = fixture(t); createHomeState(home, identity);
    createThinPairing(home).join({ member_id: "m_dev_1", public_key: keys.dev1.pk, role: "device" }, { verified: true });
    const queue = createCipherFiles(home, area), dir = join(home, area);
    for (const n of [1, 2]) queue.put({ msg_id: messageId(n), seq: n, from: `m_dev_${n}`, to: [`m_dev_${n}`], kind: "control", body: "sealed", state: "pending" });
    const failing = () => createThinPairing(home, { fs: diskFailure("fsyncSync", 1, new RegExp(`/${area}$`)) });
    assert.throws(() => failing().revoke("m_dev_1", { rejected }), { code: "ENOSPC" });
    const retained = queue.list();
    assert.deepEqual(retained.map(e => [e.msg_id, e.state]), area === "held"
      ? [[messageId(2), "pending"]] : [[messageId(1), "failed"], [messageId(2), "pending"]]);
    assert.throws(() => failing().revoke("m_dev_1", { rejected }), { code: "ENOSPC" });
    const retry = syncTrace();
    createThinPairing(home, retry).revoke("m_dev_1", { rejected });
    assert.ok(retry.synced.includes(dir));
    assert.deepEqual(queue.list(), retained);
    assert.equal(readHomeState(home).members.m_dev_1.state, rejected ? "rejected" : "revoked");
  }
});

test("revocation and re-pair keep original history, while forget removes only the selected member", (t) => {
  const home = fixture(t); createHomeState(home, identity);
  const pairing = createThinPairing(home), inbox = createInbox(home), held = createCipherFiles(home, "held"), outbox = createCipherFiles(home, "outbox");
  for (const [id, key, seq] of [["m_dev_1", keys.dev1.pk, 1], ["m_dev_2", keys.dev2.pk, 2]]) {
    pairing.join({ member_id: id, public_key: key, role: "device" }, { verified: true });
    pairing.confirmFingerprint(id, readHomeState(home).members[id].fingerprint);
    inbox.append({ seq, from: id, kind: "data", type: "sync", received_at: "2026-11-05T00:00:00Z", inner: { type: "sync", unknown: seq } });
    held.put({ msg_id: messageId(seq), seq, from: id, kind: "data", body: "ciphertext" });
    outbox.put({ msg_id: messageId(seq), to: [id], kind: "control", body: "sealed", state: "pending" });
  }
  const before = fs.readFileSync(join(home, "inbox/2026-11-05.jsonl"));
  pairing.revoke("m_dev_1");
  pairing.join({ member_id: "m_dev_3", public_key: keys.dev1.pk, role: "device" }, { verified: true });
  assert.equal(pairing.trustedKey("m_dev_3"), null);
  assert.ok(fs.readFileSync(join(home, "inbox/2026-11-05.jsonl")).equals(before));
  forgetThinMember(home, "m_dev_1", { yes: true });
  assert.deepEqual(inbox.read().map(r => r.from), ["m_dev_2"]);
  assert.deepEqual(held.list().map(r => r.from), ["m_dev_2"]);
  assert.deepEqual(outbox.list().map(r => r.to[0]), ["m_dev_2"]);
  assert.equal(readHomeState(home).members.m_dev_1.state, "revoked");
});

test('scoped response waits bind at verified join, retain a fixed confirmation deadline and close on cancellation', t => {
  const { home } = setup(t, { confirmed: false });
  scopedRequest(home);
  const pairing = createThinPairing(home, { now });
  pairing.join({ member_id: 'm_dev_1', role: 'device', public_key: keys.dev1.pk, pairing_id: pairingId }, { verified: true });
  const waits = () => Object.values(readHomeState(home).transport.response_waits);
  assert.equal(waits().length, 1); assert.equal(waits()[0].member_id, 'm_dev_1');
  assert.equal(waits()[0].expires_at, now().getTime() + 900000);
  const later = createThinPairing(home, { now: () => new Date(now().getTime() + 300000) });
  later.confirmFingerprint('m_dev_1', readHomeState(home).members.m_dev_1.fingerprint);
  assert.equal(waits()[0].expires_at, now().getTime() + 1200000);
  later.confirmFingerprint('m_dev_1', readHomeState(home).members.m_dev_1.fingerprint);
  assert.equal(waits()[0].expires_at, now().getTime() + 1200000);
  later.revoke('m_dev_1'); assert.equal(waits().length, 0);
});

test('scoped pair starts a pre-join response window and replacement closes it without activating legacy pairing', async t => {
  const { createPairingService } = await import('../../src/pairing.js');
  const { home } = setup(t); let n = 0;
  const service = createPairingService({ home, publicKey: identity.public_key, agentName: 'Test', now,
    relay: { baseUrl: 'https://relay.example', createPairing: async () => ({ pairing_id: 'p_' + String(++n).repeat(22), pairing_token: 'pt_' + 'T'.repeat(43), expires_at: new Date(now().getTime() + 600000).toISOString() }) } });
  const first = await service.startPairing({ read: ['steps'] });
  let waits = Object.values(readHomeState(home).transport.response_waits);
  assert.equal(waits.length, 1); assert.equal(waits[0].member_id, null); assert.equal(waits[0].state, 'queued');
  assert.equal(waits[0].opened_at, now().getTime()); assert.equal(waits[0].expires_at, Date.parse(first.expires_at));
  const second = await service.startPairing({ write: ['body_mass'] });
  waits = Object.values(readHomeState(home).transport.response_waits);
  assert.equal(waits.length, 1); assert.equal(waits[0].pairing_id, second.pairing_id);
  await service.startPairing(); assert.equal(Object.keys(readHomeState(home).transport.response_waits).length, 0);
});
