import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { main } from '../../src/cli.js';
import { saveConfig } from '../../src/config.js';
import { readHomeState, updateHomeState } from '../../src/home-state.js';
import { createPairingService, readPairingFile } from '../../src/pairing.js';
import { saveSecrets } from '../../src/secrets.js';
import { setup, identity, keys, now } from '../support/thin-transport.js';
import { buildPairUri, parsePairUri } from '../../src/pair-uri.js';
import { loadJson } from '../../src/protocol-files.js';
import { openPairingScope } from '../../src/pairing-scope-blob.js';
import { createRelayClient } from '../../src/relay-client.js';

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

test('scoped pairing retries identical E2 bytes, encrypts the complete catalog and displays a marked link', async t => {
  const { home } = setup(t), bodies = [];
  let attempts = 0, serial = 0;
  const relay = createRelayClient({ baseUrl: 'https://relay.example', token: `sk_${identity.hub_id}_${'T'.repeat(40)}`,
    sleep: async () => {}, fetch: async (_url, options) => {
      bodies.push(options.body);
      if (++attempts === 1) return Response.json({ error: 'internal_error' }, { status: 503 });
      const scoped = Object.hasOwn(JSON.parse(options.body), 'pairing_scope_blob');
      const stored = attempts !== 4;
      return Response.json({ pairing_id: `p_${String(++serial).padStart(22, 'A')}`, pairing_token: `pt_${'T'.repeat(43)}`,
        expires_at: new Date(now().getTime() + 600000).toISOString(), hub_id: identity.hub_id,
        ...(scoped && stored && { pairing_scope_stored: true }) }, { status: 201 });
    } });
  const service = createPairingService({ home, relay, publicKey: keys.agent.pk, agentName: 'Test', now });
  const { types, characteristics } = loadJson('types.json');
  const catalog = [...types, ...characteristics, { name: 'workout' }];
  const scope = { read: catalog.map(t => t.name), write: catalog.filter(t => t.write).map(t => t.name) };
  const first = await service.startPairing(scope), firstParsed = parsePairUri(first.uri).value;
  const blob = JSON.parse(bodies[0]).pairing_scope_blob;
  assert.ok(bodies[0] === bodies[1], 'E2 retry changed its body');
  assert.equal(firstParsed.requestedScope, undefined);
  assert.equal(firstParsed.scopeOnRelay, true);
  assert.deepEqual([...new URLSearchParams(new URL(first.uri).hash.slice(1)).keys()], ['v', 'r', 'h', 't', 'k', 'n', 'c', 'a']);
  const opened = await openPairingScope(blob, firstParsed);
  assert.ok(opened.read.length === scope.read.length && opened.write.length === scope.write.length, 'scope lost catalog types');
  assert.ok(JSON.stringify(opened) === JSON.stringify(readPairingFile(home).requested_scope), 'scope did not round trip');
  assert.ok(service.showPairing().uri === first.uri, 'saved marked link changed');
  const second = await service.startPairing(scope), secondParsed = parsePairUri(second.uri).value;
  assert.ok(firstParsed.pairSecret !== secondParsed.pairSecret, 'pairing reused its secret');
  await assert.rejects(openPairingScope(blob, secondParsed), { code: 'pairing_scope_auth_failed' });
  await assert.rejects(service.startPairing(scope), {
    code: 'pairing_scope_relay_unsupported',
    message: 'This relay does not support encrypted pairing requests. Try again later or contact Syncky support.',
  });
  assert.equal(readPairingFile(home).pairing_id, second.pairing_id);
  assert.ok(!fs.readFileSync(join(home, 'state.json'), 'utf8').includes(blob), 'blob persisted in state');
  assert.ok(!fs.readFileSync(join(home, 'pairing.json'), 'utf8').includes(blob), 'blob persisted with the link');
  const bare = await service.startPairing();
  assert.deepEqual(Object.keys(JSON.parse(bodies.at(-1))), []);
  assert.equal(parsePairUri(bare.uri).value.scopeOnRelay, undefined);
});

test('saved links that lack the marker for a scoped v2 pairing cannot be redisplayed', async t => {
  const { home } = setup(t);
  const relay = { baseUrl: 'https://relay.test', createPairing: async () => ({ pairing_id: `p_${'B'.repeat(22)}`,
    pairing_token: `pt_${'T'.repeat(43)}`, expires_at: new Date(now().getTime() + 600000).toISOString() }) };
  const pairing = createPairingService({ home, relay, publicKey: keys.agent.pk, agentName: 'Test', now });
  const started = await pairing.startPairing(), doc = readPairingFile(home);
  const scope = { request_ref: 'a'.repeat(32), read: ['steps'], write: [] };
  const inline = buildPairUri({ ...parsePairUri(started.uri).value, requestedScope: scope });
  for (const uri of [inline, started.uri]) {
    fs.writeFileSync(join(home, 'pairing.json'), JSON.stringify({ ...doc, uri, requested_scope: scope }), { mode: 0o600 });
    assert.throws(() => pairing.showPairing({ qrSvg: true }), { code: 'pairing_previous_access_format',
      message: 'This saved pairing link uses the previous access format. Run syncky pair to create a new link.' });
    assert.ok(readPairingFile(home).uri === uri, 'cached legacy link changed');
    assert.ok(!fs.existsSync(join(home, 'pairing-qr')), 'legacy link generated a QR file');
  }
});
