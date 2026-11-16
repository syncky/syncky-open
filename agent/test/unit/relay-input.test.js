import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createHomeState, readHomeState, validateHomeState } from '../../src/home-state.js';
import { createThinPairing } from '../../src/thin-pairing.js';
import { createPairingService } from '../../src/pairing.js';
import { createThinInbound } from '../../src/thin-inbound.js';
import { loadConfig, saveConfig } from '../../src/config.js';
import { createRuntime, localStatus } from '../../src/runtime.js';
import { saveSecrets } from '../../src/secrets.js';
import { fixture, identity, keys } from '../support/thin-home.js';
import { self } from '../support/thin-transport.js';

const id = `p_${'A'.repeat(22)}`, member = { member_id: keys.dev1.member_id, role: 'device', public_key: keys.dev1.pk };
const badIds = ['__proto__', 'constructor', 'prototype', '', 'p_bad', {}, [], 1, true];
for (const pairing_id of badIds) test(`invalid pairing id (${typeof pairing_id}) is rejected at every verified-member ingress`, async t => {
  const home = fixture(t); createHomeState(home, identity);
  const pairing = createThinPairing(home);
  assert.throws(() => pairing.join({ ...member, pairing_id }, { verified: true }), { code: 'invalid_response' });
  assert.equal(Object.keys(readHomeState(home).members).length, 1);
  const state = readHomeState(home); state.members[member.member_id] = { ...member, state: 'joined', pairing_id };
  assert.throws(() => validateHomeState(state), { code: 'corrupt_state' });
  for (const source of ['list', 'notice', 'refresh']) {
    const fields = { ...member, ...(source !== 'notice' && { pairing_id }) };
    const relay = { listMembers: async () => ({ members: [fields] }), getPairing: async () => ({ status: 'completed', member_id: member.member_id, public_key: member.public_key }) };
    const inbound = createThinInbound({ home, self, relay, transport: { hasMarker: () => false } });
    const service = createPairingService({ home, relay });
    const action = source === 'refresh' ? service.refreshPairing(id) : inbound.receive({ seq: 1, kind: 'system', event: 'member_joined', body: { ...member, ...(source === 'notice' && { pairing_id }) } });
    await assert.rejects(action, { code: 'invalid_response' });
    assert.equal(Object.keys(readHomeState(home).members).length, 1);
    assert.equal(Object.hasOwn(Object.prototype, 'member_id'), false);
  }
});

for (const field of ['name', 'device_name']) for (const name of ['  Phone  ', '😀'.repeat(64), '😀'.repeat(65), '', '  ', 7, null, 'x\u001by', 'x\u0085y', 'x\u202ey', 'x\u200by']) {
  test(`${field} uses the shared 64-code-point policy on join and old status`, t => {
    const home = fixture(t); createHomeState(home, identity);
    const expected = name === '  Phone  ' ? 'Phone' : name === '😀'.repeat(64) ? name : null;
    createThinPairing(home).join({ ...member, [field]: name }, { verified: true });
    assert.equal(readHomeState(home).members[member.member_id].name, expected);
    const state = readHomeState(home); delete state.members[member.member_id].name; state.members[member.member_id][field] = name;
    fs.writeFileSync(join(home, 'state.json'), JSON.stringify(state), { mode: 0o600 });
    assert.equal(localStatus(home, { status: () => ({}) }).members.find(m => m.member_id === member.member_id).name, expected);
  });
}
for (const pairing_id of [undefined, null, id]) test('valid optional pairing bindings and own-property lookups survive', t => {
  const home = fixture(t); createHomeState(home, identity);
  createThinPairing(home).join({ ...member, pairing_id }, { verified: true });
  assert.equal(readHomeState(home).members[member.member_id].pairing_id, pairing_id ?? null);
});

const invalidUrls = ['http://remote.test', 'http://127.0.0.1.remote.test', 'https://user:private@relay.test', 'https://@relay.test', 'https://relay.test?private', 'https://relay.test#private', 'https://relay.test/path', 'http://[bad', 'not-url'];
test('saved configuration pins canonical origin before credentials or fetch', t => {
  const home = fixture(t); createHomeState(home, identity);
  saveSecrets(home, { private_key: keys.agent.sk, public_key: keys.agent.pk, token: `sk_${identity.hub_id}_${'T'.repeat(40)}`, webhook_secret: `whsec_${'W'.repeat(43)}` });
  saveConfig(home, { relay_url: 'https://RELAY.test:443/' });
  let fetched = 0;
  for (const url of [...invalidUrls, 'https://other.test', 'https://relay.test:9443', 'http://localhost:8787']) {
    for (const options of [{ flags: { relay: url }, env: {} }, { env: { SYNCKY_RELAY_URL: url } }]) {
      assert.throws(() => createRuntime({ home, ...options, fetch: () => { fetched++; } }), e => e.code === 'invalid_config' && !e.message.includes('private'));
    }
  }
  assert.equal(fetched, 0);
  for (const url of ['https://relay.test', 'https://RELAY.test:443/']) {
    for (const env of [{}, { SYNCKY_RELAY_URL: 'https://other.test' }]) {
      assert.equal(loadConfig(home, { initialized: true, env, flags: { relay_url: url } }).relay_url, 'https://relay.test');
    }
  }
  for (const url of [...invalidUrls, null, undefined]) {
    saveConfig(home, { ...(url !== undefined && { relay_url: url }) });
    assert.throws(() => loadConfig(home, { initialized: true, env: {}, flags: { relay_url: 'https://relay.test' } }), { code: 'invalid_config' });
  }
  for (const url of ['http://localhost:8787/', 'http://127.0.0.2:8787', 'http://[::1]:8787']) {
    saveConfig(home, { relay_url: url });
    assert.equal(loadConfig(home, { initialized: true, env: {} }).relay_url, new URL(url).origin);
  }
});

test('prototype-provided pairings never participate in proof recovery', async t => {
  const { recoverPairProof } = await import('../../src/thin-pairing.js');
  const home = fixture(t); createHomeState(home, identity);
  fs.writeFileSync(join(home, 'pairing.json'), '{"invalid":true}', { mode: 0o600 });
  const state = readHomeState(home), phone = { ...member, state: 'joined', pairing_id: id };
  state.pairings = Object.create({ [id]: { pairing_id: id } });
  assert.doesNotThrow(() => recoverPairProof(home, state, phone));
  assert.equal(phone.pair_proof, undefined);
  assert.equal(createThinPairing(home).trustedKey('__proto__'), null);
});
for (const field of ['name', 'device_name']) for (const name of ['😀'.repeat(64), '😀'.repeat(65), 'Phone\u202e']) {
  for (const ingress of ['notice', 'refresh']) test(`${ingress} sanitizes ${field} with the shared display policy`, async t => {
    const home = fixture(t); createHomeState(home, identity);
    const relay = { listMembers: async () => ({ members: [{ ...member, [field]: name }] }), getPairing: async () => ({ status: 'completed', member_id: member.member_id, public_key: member.public_key }) };
    if (ingress === 'refresh') await createPairingService({ home, relay }).refreshPairing(id);
    else await createThinInbound({ home, self, relay, transport: { hasMarker: () => false } }).receive({ seq: 1, kind: 'system', event: 'member_joined', body: member });
    assert.equal(readHomeState(home).members[member.member_id].name, name === '😀'.repeat(64) ? name : null);
  });
}
