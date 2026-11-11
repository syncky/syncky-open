import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { createRuntime } from '../../src/runtime.js';
import { createCipherFiles, readHomeState, updateHomeState, validateHomeState } from '../../src/home-state.js';
import { createThinPoller } from '../../src/thin-poller.js';
import { saveSecrets } from '../../src/secrets.js';
import { saveConfig } from '../../src/config.js';
import { activateResponseWaits, responseCorrelations, completeResponseWaits, hasResponseWait } from '../../src/response-waits.js';
import { loadVectors } from '../../src/protocol-files.js';
import { runCli } from '../support/helpers.js';
import { setup, keys, identity, now, delivery } from '../support/thin-transport.js';
import { scopedRequest, pairingId, resolvedReply } from '../support/pairing-scope.js';

const root = 'b'.repeat(32), alias = 'c'.repeat(32), at = now().getTime();
const request = (request_ref, read, expires = 600000) => ({ v: 1, type: 'access_request', request_ref,
  created_at: now().toISOString(), expires_at: new Date(at + expires).toISOString(), read, write: [] });
const reply = (request_ref, outcome, fields = {}) => ({ v: 1, type: 'access_reply', request_ref,
  decided_at: now().toISOString().replace('.000Z', 'Z'), outcome, read: [], write: [], ...fields });
const merged = () => reply(alias, 'merged', { merged_into: root });
const terminal = outcome => reply(root, outcome, { merged_refs: [alias], ...(outcome === 'resolved' && {
  read: [{ type: 'body_mass', outcome: 'allowed' }, { type: 'steps', outcome: 'needs_health_settings' }],
}) });

function fixture(t, requests = [request(root, ['steps']), request(alias, ['body_mass'], 900000)]) {
  const { home } = setup(t);
  saveSecrets(home, { private_key: keys.agent.sk, public_key: keys.agent.pk,
    token: `sk_${identity.hub_id}_${'T'.repeat(40)}`, webhook_secret: `whsec_${'W'.repeat(43)}` });
  saveConfig(home, { relay_url: 'http://127.0.0.1:8787', name: 'Test' });
  updateHomeState(home, s => activateResponseWaits(s, [{ state: 'sent', sent_at: now().toISOString(),
    response_waits: requests.flatMap(inner => responseCorrelations(inner, s.members.m_dev_1, at)) }], at));
  const runtime = () => createRuntime({ home, now, env: {}, fetch: () => assert.fail('unexpected network') });
  const receive = async (inner, seq) => {
    const current = runtime();
    assert.equal((await current.inbound.receive(await delivery(current.transport, seq, inner))).status, 'stored');
  };
  return { home, runtime, receive, waits: () => Object.values(readHomeState(home).transport.response_waits) };
}

for (const outcome of ['resolved', 'expired']) for (const first of ['alias', 'root']) {
  test(`merged access ${outcome}, ${first} first: durable root correlation survives restart and replay`, async t => {
    const f = fixture(t), messages = first === 'alias' ? [merged(), terminal(outcome)] : [terminal(outcome), merged()];
    await f.receive(messages[0], 1);
    if (first === 'alias') {
      const w = f.waits().find(w => w.request_ref === alias);
      assert.equal(w.merged_into, root); assert.equal(w.completed_at, undefined);
      assert.equal(w.expires_at, at + 600000); assert.equal(hasResponseWait(readHomeState(f.home)), true);
    } else assert.ok(f.waits().every(w => w.completed_at === at));
    await f.receive(messages[1], 2);
    await f.receive(merged(), 3);
    assert.ok(f.waits().every(w => w.completed_at === at));
    assert.equal(hasResponseWait(readHomeState(f.home)), false);
    updateHomeState(f.home, s => activateResponseWaits(s, [{ state: 'sent', sent_at: now().toISOString(),
      response_waits: [request(root, ['steps']), request(alias, ['body_mass'], 900000)]
        .flatMap(inner => responseCorrelations(inner, s.members.m_dev_1, at)) }], at));
    assert.equal(hasResponseWait(readHomeState(f.home)), false);
    assert.equal(f.runtime().status().members.find(m => m.member_id === keys.dev1.member_id).scope, null);
    const before = readHomeState(f.home), invalid = structuredClone(before);
    Object.values(invalid.transport.response_waits).find(w => w.request_ref === alias).merged_into = alias;
    assert.throws(() => validateHomeState(invalid), { code: 'corrupt_state' });
  });
}

test('ordinary resolved refusals close waits; missing positions and unrelated replies do not', async t => {
  const f = fixture(t, [request(root, ['body_mass', 'steps'])]);
  await f.receive(reply(root, 'resolved', { read: [{ type: 'steps', outcome: 'allowed' }] }), 1);
  assert.equal(hasResponseWait(readHomeState(f.home)), true);
  const read = [{ type: 'body_mass', outcome: 'refused', reason: 'declined_recently', next_available_at: '2026-11-12T12:00:00Z' },
    { type: 'steps', outcome: 'allowed' }];
  await f.receive(reply(alias, 'resolved', { read }), 2);
  assert.equal(hasResponseWait(readHomeState(f.home)), true);
  await f.receive(reply(root, 'resolved', { read }), 3);
  assert.equal(hasResponseWait(readHomeState(f.home)), false);
});

test('merged waits retain the response floor across restart until the terminal root reply', async t => {
  const f = fixture(t), transport = f.runtime().transport;
  let clock = at, polls = 0;
  const relay = { getMessages: async () => {
    const inner = ++polls === 1 ? merged() : terminal('resolved');
    return { messages: [await delivery(transport, polls, inner)], next_after: polls };
  }, ack: async () => {} };
  const poller = () => createThinPoller({ home: f.home, transport, self: f.runtime().self, relay, intervalS: 1800, now: () => new Date(clock) });
  await poller().once();
  assert.equal(readHomeState(f.home).transport.next_poll_at, at + 300000);
  clock += 299999; assert.equal((await poller().once()).reason, 'poll_floor'); assert.equal(polls, 1);
  clock++; await poller().once(); assert.equal(polls, 2);
  assert.equal(hasResponseWait(readHomeState(f.home)), false);
  assert.equal(readHomeState(f.home).transport.next_poll_at, clock + 1800000);
});

for (const first of ['alias', 'root']) test(`outbox recovery replays durable ${first}-first replies without reopening waits`, async t => {
  const f = fixture(t), messages = first === 'alias' ? [merged(), terminal('resolved')] : [terminal('resolved'), merged()];
  for (const [i, inner] of messages.entries()) await f.receive(inner, i + 1);
  const queue = createCipherFiles(f.home, 'outbox'), runtime = f.runtime();
  for (const inner of [request(root, ['steps']), request(alias, ['body_mass'], 900000)]) {
    const envelope = await runtime.transport.sealMessage({ hubId: identity.hub_id, from: keys.agent.member_id,
      senderPrivateKey: runtime.self.privateKey, recipients: [{ memberId: keys.dev1.member_id, publicKey: Buffer.from(keys.dev1.pk, 'base64url') }], innerText: JSON.stringify(inner) });
    queue.put({ msg_id: envelope.msg_id, kind: 'control', type: 'access_request', to: [keys.dev1.member_id], state: 'sent',
      sent_at: now().toISOString(), body: runtime.transport.serialize(envelope),
      response_waits: responseCorrelations(inner, readHomeState(f.home).members.m_dev_1, at) });
  }
  updateHomeState(f.home, s => { delete s.transport.response_waits; });
  await f.runtime().outbox.flush();
  assert.ok(f.waits().every(w => w.completed_at === at));
  assert.equal(hasResponseWait(readHomeState(f.home)), false);
});

test('ordinary response correlation remains bound to the authenticated phone and key', t => {
  const f = fixture(t);
  updateHomeState(f.home, s => {
    completeResponseWaits(s, keys.dev1.member_id, keys.dev2.pk, terminal('resolved'), at);
    completeResponseWaits(s, keys.dev2.member_id, keys.dev2.pk, terminal('resolved'), at);
  });
  assert.ok(f.waits().every(w => w.completed_at === undefined && w.merged_into === undefined));
});

test('merged acknowledgements cannot redirect a wait to itself, an alias chain or pairing', async t => {
  const f = fixture(t); scopedRequest(f.home);
  for (const [seq, inner] of [reply(alias, 'merged', { merged_into: alias }),
    reply(alias, 'merged', { merged_into: resolvedReply().request_ref }), merged(),
    reply(root, 'merged', { merged_into: alias })].entries()) await f.receive(inner, seq + 1);
  const waits = f.waits();
  assert.equal(waits.find(w => w.request_ref === alias).merged_into, root);
  assert.equal(waits.find(w => w.request_ref === root).merged_into, undefined);
  assert.ok(waits.every(w => w.completed_at === undefined));
  assert.equal(readHomeState(f.home).pairings[pairingId].access.state, 'awaiting');
});

test('extended ordinary replies cannot satisfy the exact pairing grant matcher or change scope', async t => {
  const f = fixture(t, []); scopedRequest(f.home);
  for (const [i, extra] of [{ merged_refs: [alias] }, { read: [...resolvedReply().read, { type: 'workout', outcome: 'allowed' }] },
    { read: [{ type: 'steps', outcome: 'refused', reason: 'requested_recently', next_available_at: '2026-11-06T12:00:00Z' }] }].entries()) {
    await f.receive({ ...resolvedReply(), ...extra }, i + 1);
    assert.equal(readHomeState(f.home).pairings[pairingId].access.state, 'awaiting');
  }
  await f.receive(resolvedReply(), 4);
  assert.equal(readHomeState(f.home).pairings[pairingId].access.state, 'resolved');
  assert.equal(f.runtime().status().members.find(m => m.member_id === keys.dev1.member_id).scope, null);
  await f.receive({ v: 1, type: 'sync', scope: { read: ['steps'], write: ['body_mass'] } }, 5);
  assert.deepEqual(f.runtime().status().members.find(m => m.member_id === keys.dev1.member_id).scope.read, ['steps']);
});

test('every generated extended reply is authenticated and retained verbatim through CLI/MCP after restart', async t => {
  const f = fixture(t, []), cases = loadVectors('envelopes').cases.filter(c => c.name.startsWith('access_reply_'));
  assert.ok(cases.length >= 11);
  for (const [i, c] of cases.entries()) await f.receive(JSON.parse(c.plaintext), i + 1);
  const options = { now, fetch: () => assert.fail('inbox must stay offline') };
  const cli = await runCli(['--home', f.home, 'inbox', '--type', 'access_reply'], options);
  const rpc = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'syncky_inbox', arguments: { type: 'access_reply' } } });
  const mcp = await runCli(['--home', f.home, 'mcp'], { ...options, stdin: Readable.from([rpc + '\n']) });
  for (const [result, records] of [[cli, JSON.parse(cli.stdout).records], [mcp, JSON.parse(mcp.stdout).result.structuredContent.records]]) {
    assert.equal(result.code, 0); assert.equal(result.stderr, '');
    assert.deepEqual(records.map(r => r.inner), cases.map(c => JSON.parse(c.plaintext)));
  }
});
