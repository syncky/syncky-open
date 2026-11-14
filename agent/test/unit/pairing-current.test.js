import assert from 'node:assert/strict';
import { test } from 'node:test';
import { main } from '../../src/cli.js';
import { saveConfig } from '../../src/config.js';
import { readHomeState, updateHomeState } from '../../src/home-state.js';
import { createPairingService, readPairingFile } from '../../src/pairing.js';
import { saveSecrets } from '../../src/secrets.js';
import { setup, identity, keys, now } from '../support/thin-transport.js';

for (const status of ['pending', 'expired', 'completed']) test(`current ${status} pairing cannot resolve to a different completed phone`, async t => {
  const { home } = setup(t), first = `p_${'A'.repeat(22)}`, second = `p_${'B'.repeat(22)}`;
  let at = now().getTime(), fetches = 0;
  const clock = () => new Date(at);
  updateHomeState(home, s => {
    s.members.m_dev_1.pairing_id = first;
    s.pairings[first] = { pairing_id: first, status: 'completed', member_id: 'm_dev_1', public_key: keys.dev1.pk, expires_at: new Date(at - 1000).toISOString(), version: 1 };
  });
  const relay = { baseUrl: 'https://relay.test', createPairing: async () => ({ pairing_id: second, pairing_token: `pt_${'T'.repeat(43)}`, expires_at: new Date(at + 1000).toISOString() }) };
  const pairing = createPairingService({ home, relay, publicKey: keys.agent.pk, agentName: 'Test', now: clock });
  assert.equal(pairing.currentPairing({ includeCompleted: true }).pairing_id, first);
  await pairing.startPairing({ v1: true });
  assert.equal(pairing.currentPairing({ includeCompleted: true }).pairing_id, second);
  at += 2000;
  assert.equal(pairing.currentPairing({ includeCompleted: true, graceMs: 60000 }).pairing_id, second);
  updateHomeState(home, s => { s.pairings[second].status = status; });
  at += 60000;
  saveConfig(home, { relay_url: relay.baseUrl });
  saveSecrets(home, { private_key: keys.agent.sk, public_key: keys.agent.pk, token: `sk_${identity.hub_id}_${'T'.repeat(40)}`, webhook_secret: `whsec_${'W'.repeat(43)}` });
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.equal(pairing.currentPairing({ includeCompleted: true, graceMs: 60000 }), null);
    let stdout = '', stderr = '';
    const code = await main(['--home', home, 'wait'], { env: {}, now: clock, fetch: () => { fetches++; throw Error('unexpected pairing fetch'); },
      stdout: { write: s => { stdout += s; } }, stderr: { write: s => { stderr += s; } } });
    assert.equal(code, 4); assert.equal(stdout, ''); assert.equal(JSON.parse(stderr).error, 'pairing_expired');
  }
  assert.equal(fetches, 0); assert.equal(readPairingFile(home).pairing_id, second);
  updateHomeState(home, s => {
    s.members.m_dev_1.pairing_id = second;
    Object.assign(s.pairings[second], { status: 'completed', member_id: 'm_dev_1', public_key: keys.dev1.pk });
  });
  assert.equal(pairing.currentPairing({ includeCompleted: true }).pairing_id, second);
  assert.equal(readHomeState(home).members.m_dev_1.state, 'confirmed');
});
