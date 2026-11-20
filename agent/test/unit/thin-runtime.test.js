import { errorHint } from '../../src/error-guidance.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import Ajv from 'ajv/dist/2020.js';
import { main, commandNames, parseArgs } from '../../src/cli.js';
import { createMcpServer, TOOLS } from '../../src/mcp.js';
import { createInbox } from '../../src/inbox.js';
import { readHomeState, updateHomeState, createCipherFiles } from '../../src/home-state.js';
import { saveSecrets } from '../../src/secrets.js';
import { saveConfig } from '../../src/config.js';
import { acquireHomeLock } from '../../src/protected-files.js';
import { createRuntime } from '../../src/runtime.js';
import { activateResponseWaits, responseCorrelations } from '../../src/response-waits.js';
import { setup, keys, identity, now, delivery, messageId } from '../support/thin-transport.js';
import { scopedRequest, pairingId, requestedScope, resolvedReply } from '../support/pairing-scope.js';
import { PAIRING_ACCESS_NOTICE } from '../../src/pairing-access.js';
import { runCli } from '../support/helpers.js';
import { createPairingService } from '../../src/pairing.js';
import { b64uDecode, formatTimestamp } from '../../src/encoding.js';
import { parsePairUri } from '../../src/pair-uri.js';
import { LARGE_ACCESS_ACCEPTED_NOTICE, LARGE_ACCESS_EXPIRED_NOTICE, V1_ACCESS_EXPIRED_NOTICE } from '../../src/error-guidance.js';
import { loadJson } from '../../src/protocol-files.js';
import { createRelayClient } from '../../src/relay-client.js';

const sendOutputSchema = TOOLS.find(tool => tool.name === 'syncky_send').outputSchema;
const validateSendReceipt = new Ajv({ strict: false, validateFormats: false }).compile(sendOutputSchema);
function assertSendReceipt(receipt) {
  assert.equal(validateSendReceipt(receipt), true, JSON.stringify(validateSendReceipt.errors));
}

for (const version of [1, 2]) for (const scoped of [false, true]) test(`wait rejects an expired ${scoped ? 'scoped' : 'bare'} v${version} binding after restart releases a held unpair`, async t => {
  const { home, pairing } = homeFixture(t, { confirmed: false }); scopedRequest(home);
  updateHomeState(home, s => {
    const row = s.pairings[pairingId]; row.version = version;
    if (!scoped) { delete row.requested_scope; delete row.access; }
  });
  let fetches = 0;
  const fetch = () => { fetches++; throw Error('unexpected network'); };
  const runtime = createRuntime({ home, now, env: {}, fetch });
  const held = await runtime.inbound.receive(await delivery(runtime.transport, 1, { v: 1, type: 'unpair', reason: 'user' }));
  assert.equal(held.status, 'held'); assert.equal(runtime.status().held, 1);
  pairing.confirmFingerprint(keys.dev1.member_id, readHomeState(home).members[keys.dev1.member_id].fingerprint);
  const later = () => new Date(now().getTime() + 3600000);
  const result = await runCli(['--home', home, 'wait', '--timeout', '10'], { now: later, fetch });
  assert.equal(result.code, 4); assert.ok(result.stdout === '');
  assert.equal(JSON.parse(result.stderr.trim().split('\n').at(-1)).error, 'invalid_transition');
  assert.equal(fetches, 0); assert.equal(runtime.status().held, 0);
  assert.equal(readHomeState(home).members[keys.dev1.member_id].unpair_reason, 'user');
});

test('wait rechecks trust before returning cached confirmation at its timeout', async t => {
  const { home } = homeFixture(t); scopedRequest(home);
  const fetch = () => { throw Error('unexpected network'); };
  const runtime = createRuntime({ home, now, env: {}, fetch });
  const unpair = await delivery(runtime.transport, 1, { v: 1, type: 'unpair', reason: 'user' });
  let at = now().getTime(); const sleeps = [];
  const result = await runCli(['--home', home, 'wait', '--timeout', '1'], {
    now: () => new Date(at), fetch, createPoller: () => ({ once: async () => {} }),
    sleep: async ms => { sleeps.push(ms); at += ms; await runtime.inbound.receive(unpair); },
  });
  assert.deepEqual(sleeps, [1000]);
  assert.equal(at, now().getTime() + 1000);
  assert.equal(result.code, 4); assert.ok(result.stdout === '');
  assert.equal(JSON.parse(result.stderr.trim().split('\n').at(-1)).error, 'invalid_transition');
});

for (const code of ['home_locked', 'unsafe_home']) test(`runtime initialization synchronously propagates ${code} within its retry budget`, t => {
  const { home } = homeFixture(t), openSync = fs.openSync, waits = [];
  const error = Object.assign(new Error('fixture read failure'), { code });
  let reads = 0;
  t.mock.method(fs, 'openSync', (file, ...args) => {
    if (file === join(home, 'state.json')) { reads++; throw error; }
    return openSync(file, ...args);
  });
  t.mock.method(Atomics, 'wait', (array, index, value, timeout) => { waits.push(timeout); return 'timed-out'; });
  assert.throws(() => createRuntime({ home, env: {} }), e => e === error);
  assert.equal(reads, code === 'home_locked' ? 201 : 1);
  assert.deepEqual(waits, code === 'home_locked' ? Array.from({ length: 200 }, (_, n) => 5 + n % 13) : []);
});

test('CLI and MCP project awaiting, missing and late resolved pairing access independently of scope', async t => {
  const { home } = homeFixture(t); scopedRequest(home);
  const runtime = createRuntime({ home, now, env: {}, fetch: () => { throw Error('unexpected network'); } });
  const request = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'syncky_status', arguments: {} } };
  for (const missing of [false, true]) {
    if (missing) updateHomeState(home, s => { s.pairings[pairingId].access.notice_at = now().toISOString(); });
    for (const output of [await cli(home, ['status']), await cli(home, ['status', '--json']), await cli(home, ['mcp'], JSON.stringify(request) + '\n')]) {
      assert.equal(output.code, 0);
      const status = output.json.result?.structuredContent ?? output.json;
      const member = status.members.find(m => m.member_id === 'm_dev_1');
      assert.equal(member.pairing_access.state, 'awaiting'); assert.equal(member.scope, null);
      assert.deepEqual(member.pairing_access.requested_scope, { read: ['steps'], write: ['body_mass'] });
      assert.ok(!(output.stdout + output.stderr).includes(requestedScope.request_ref));
      assert.equal(Boolean(member.pairing_access.notice), missing);
      if (missing) {
        assert.equal(member.pairing_access.notice, PAIRING_ACCESS_NOTICE);
        assert.match(member.pairing_access.follow_up, /renewed explicit owner approval and phone availability/);
        assert.match(member.pairing_access.follow_up, /finite positive TTL <= 24 hours/);
        assert.doesNotMatch(member.pairing_access.notice, /older app|exactly 24/);
      }
      assert.doesNotMatch(output.stdout + output.stderr, /pair_secret|pairing_token|pair_proof|private_key|ciphertext|uri/);
    }
  }
  const later = () => new Date(now().getTime() + 900000);
  const before = fs.readFileSync(join(home, 'state.json')), transaction = acquireHomeLock(home, 'state');
  try {
    const status = createRuntime({ home, now: later, env: {} }).status();
    const expired = status.members.find(m => m.member_id === 'm_dev_1').pairing_access;
    assert.equal(expired.state, 'no_reply'); assert.equal(expired.notice, PAIRING_ACCESS_NOTICE);
    assert.equal(status.pairings.find(p => p.pairing_id === pairingId).state, 'no_reply');
    assert.deepEqual(fs.readFileSync(join(home, 'state.json')), before);
    assert.equal(readHomeState(home).pairings[pairingId].access.state, 'awaiting');
  } finally { transaction.release(); }
  await createRuntime({ home, now: later, env: {} }).inbound.receive(await delivery(runtime.transport, 1, resolvedReply()));
  const result = runtime.status().members.find(m => m.member_id === 'm_dev_1');
  assert.equal(result.pairing_access.state, 'resolved'); assert.equal(result.pairing_access.notice, null);
  assert.deepEqual(result.pairing_access.outcomes.read, resolvedReply().read); assert.equal(result.scope, null);
  assert.ok(!JSON.stringify(runtime.status()).includes(requestedScope.request_ref));
});

test('status and MCP omit pairing, access and diagnostics refs and wait keys while replies still match', async t => {
  const { home } = homeFixture(t); scopedRequest(home);
  const accessRef = 'b'.repeat(32), diagnosticsRef = 'c'.repeat(32), at = now().getTime();
  updateHomeState(home, s => {
    const base = { v: 1, created_at: now().toISOString(), expires_at: new Date(at + 600000).toISOString() };
    const response_waits = [
      { ...base, type: 'access_request', request_ref: accessRef, read: ['steps'], write: [] },
      { ...base, type: 'diagnostics_request', request_ref: diagnosticsRef },
      { v: 1, type: 'commands', commands: [{ command_id: 'private-command', version: 2 }] },
    ].flatMap(inner => responseCorrelations(inner, s.members.m_dev_1, at));
    activateResponseWaits(s, [{ state: 'sent', sent_at: now().toISOString(), response_waits }], at);
  });
  const runtime = createRuntime({ home, now, env: {}, fetch: () => { throw Error('unexpected network'); } });
  const request = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'syncky_status', arguments: {} } };
  async function check(completed) {
    for (const output of [await cli(home, ['status']), await cli(home, ['status', '--json']), await cli(home, ['mcp'], JSON.stringify(request) + '\n')]) {
      assert.equal(output.code, 0);
      const status = output.json.result?.structuredContent ?? output.json;
      assert.deepEqual(status.transport.response_waits.map(w => w.kind).sort(), ['access', 'command', 'diagnostics', ...(completed ? [] : ['pairing'])]);
      for (const ref of [requestedScope.request_ref, accessRef, diagnosticsRef]) assert.ok(!(output.stdout + output.stderr).includes(ref));
      assert.doesNotMatch(output.stdout + output.stderr, /"request_ref"\s*:|private-command/);
      assert.deepEqual(status.transport.response_waits.filter(w => w.completed_at !== undefined).map(w => w.kind).sort(), completed ? ['access', 'diagnostics'] : []);
    }
  }
  await check(false);
  const stored = readHomeState(home);
  assert.equal(stored.pairings[pairingId].requested_scope.request_ref, requestedScope.request_ref);
  for (const ref of [accessRef, diagnosticsRef]) assert.ok(Object.keys(stored.transport.response_waits).some(k => k.includes(ref)));
  await runtime.inbound.receive(await delivery(runtime.transport, 1, { ...resolvedReply(), request_ref: accessRef, write: [],
    decided_at: now().toISOString().replace('.000Z', 'Z') }));
  await runtime.inbound.receive(await delivery(runtime.transport, 2, { v: 1, type: 'diagnostics_reply', request_ref: diagnosticsRef, outcome: 'declined', reason: 'user' }));
  await runtime.inbound.receive(await delivery(runtime.transport, 3, resolvedReply()));
  await check(true);
  assert.equal(runtime.status().members.find(m => m.member_id === 'm_dev_1').pairing_access.state, 'resolved');
});

function homeFixture(t, options) {
  const fixture = setup(t, options);
  saveSecrets(fixture.home, { private_key: keys.agent.sk, public_key: keys.agent.pk,
    token: `sk_${identity.hub_id}_${'T'.repeat(40)}`, webhook_secret: `whsec_${'W'.repeat(43)}` });
  saveConfig(fixture.home, { relay_url: 'http://127.0.0.1:8787', name: 'Test' });
  return fixture;
}

for (const finish of ['retry', 'superseded', 'revoked', 'mismatched']) test(`v1 scoped intent survives confirmation and restart with ${finish}`, async t => {
  const { home, pairing } = homeFixture(t, { confirmed: false }), id = keys.dev1.member_id;
  let at = now().getTime(), serial = 0, seq = 0, refuseConfirm = true, refuseAccess = true;
  const clock = () => new Date(at), sent = [];
  const fetch = async (url, options) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/pairings')) {
      assert.ok(options.body === '{}', 'v1 E2 carried access data');
      return Response.json({ pairing_id: `p_${String(++serial).padStart(22, 'A')}`, pairing_token: `pt_${'T'.repeat(43)}`,
        expires_at: new Date(at + 600000).toISOString() }, { status: 201 });
    }
    assert.ok(path.endsWith('/messages') && options.method === 'POST', 'unexpected relay call');
    const envelope = JSON.parse(options.body);
    const { inner } = await runtime.transport.receive({ envelope, hubId: identity.hub_id,
      self: { memberId: id, privateKey: b64uDecode(keys.dev1.sk) }, senderKeyOf: () => b64uDecode(keys.agent.pk) });
    sent.push({ type: inner.type, envelope, body: options.body, inner });
    if ((inner.type === 'confirmed' && refuseConfirm) || (inner.type === 'access_request' && refuseAccess)) {
      return Response.json({ error: 'internal_error' }, { status: 503 });
    }
    return Response.json({ seq: ++seq }, { status: 201 });
  };
  let runtime = createRuntime({ home, env: {}, now: clock, fetch });
  const service = createPairingService({ home, relay: runtime.relay, publicKey: keys.agent.pk, agentName: 'Test', now: clock });
  const started = await service.startPairing({ v1: true, read: ['steps', 'steps'], write: ['body_mass'] });
  assert.equal(parsePairUri(started.uri, { allowInsecureRelay: true }).value.requestedScope, undefined);
  updateHomeState(home, s => { s.members[id].pairing_id = started.pairing_id; });
  pairing.join({ member_id: id, public_key: keys.dev1.pk, role: 'device', pairing_id: started.pairing_id }, { verified: true });
  await runtime.outbox.flush();
  assert.equal(sent.length, 0);
  const fingerprint = readHomeState(home).members[id].fingerprint;
  assert.throws(() => service.confirmWithFingerprint(id, '0000'), { code: 'fingerprint_mismatch' });
  service.confirmWithFingerprint(id, fingerprint);
  await runtime.inbound.releaseHeld();
  await runtime.outbox.flush();
  assert.deepEqual(sent.map(x => x.type), ['confirmed']);
  assert.equal(readHomeState(home).pairings[started.pairing_id].v1_request, undefined);
  at += 2000; refuseConfirm = false;
  runtime = createRuntime({ home, env: {}, now: clock, fetch });
  await runtime.outbox.flush();
  const first = sent.filter(x => x.type === 'access_request');
  assert.equal(first.length, 1);
  assert.equal(Date.parse(first[0].inner.expires_at) - Date.parse(first[0].inner.created_at), 86400000);
  assert.ok(first[0].inner.read.length === 1 && first[0].inner.write.length === 1, 'wrong access scope counts');
  assert.equal(runtime.status().transport.response_waits?.length ?? 0, 0);
  service.confirmWithFingerprint(id, fingerprint);
  if (finish === 'superseded') await service.startPairing();
  if (finish === 'revoked') pairing.revoke(id);
  if (finish === 'mismatched') updateHomeState(home, s => { s.members[id].pairing_id = null; });
  at += 2000; refuseAccess = false;
  runtime = createRuntime({ home, env: {}, now: clock, fetch });
  await runtime.outbox.flush();
  await runtime.outbox.flush();
  const delivered = sent.filter(x => x.type === 'access_request');
  assert.equal(delivered.length, finish === 'retry' ? 2 : 1);
  if (finish !== 'retry') return;
  assert.ok(delivered[0].body === delivered[1].body, 'delivery retry changed the sealed request');
  assert.ok(delivered[0].inner.request_ref === delivered[1].inner.request_ref, 'delivery retry changed the request reference');
  assert.equal(runtime.status().transport.response_waits.filter(w => w.kind === 'access').length, 1);
  assert.equal(runtime.status().transport.response_waits.filter(w => w.kind === 'pairing').length, 0);
  const duplicate = await runCli(['--home', home, 'confirm', id, fingerprint], { env: {}, now: clock, fetch });
  assert.equal(duplicate.code, 0);
  assert.equal(JSON.parse(duplicate.stdout).access_request.state, 'sent');
  assert.equal(sent.filter(x => x.type === 'access_request').length, 2);
  at += 86400000;
  const [expired] = runtime.status().transport.response_waits;
  assert.equal(expired.state, 'no_reply'); assert.equal(expired.notice, V1_ACCESS_EXPIRED_NOTICE);
});

test('large E10 acceptance and a legacy phone ACK do not establish access; a matching reply completes only its own wait', async t => {
  const { home } = homeFixture(t), id = keys.dev1.member_id;
  let at = now().getTime(), seq = 0, ack = 0, oldRelay = true, delivered;
  const clock = () => new Date(at);
  const fetch = async (url, options) => {
    const path = new URL(url).pathname;
    if (path === '/v1/acks') {
      ack = JSON.parse(options.body).up_to_seq;
      return Response.json({ acked_up_to: ack });
    }
    if (options.method === 'GET') return Response.json({ messages: [delivered], next_after: delivered.seq });
    const bytes = Buffer.byteLength(options.body);
    if (oldRelay && bytes > 4096) return Response.json({ error: 'payload_too_large' }, { status: 413 });
    delivered = { ...JSON.parse(options.body), seq: ++seq };
    return Response.json({ seq }, { status: 201 });
  };
  const runtime = createRuntime({ home, env: {}, now: clock, fetch });
  const { types, characteristics } = loadJson('types.json'), catalog = [...types, ...characteristics, { name: 'workout' }];
  const ttl = 600000;
  const request = n => ({ v: 1, type: 'access_request', request_ref: String(n).repeat(32), created_at: clock().toISOString(),
    expires_at: new Date(at + ttl).toISOString(), read: catalog.map(t => t.name), write: catalog.filter(t => t.write).map(t => t.name) });
  const send = inner => runtime.send({ type: inner.type, inner });
  const rejected = await send(request(1));
  assert.equal(rejected.state, 'failed'); assert.equal(rejected.relay_status, 413);
  assert.equal(rejected.relay_code, 'payload_too_large');
  assert.ok(rejected.hint.endsWith('This relay rejected the larger access request. Reduce the requested types so the encrypted request fits 4096 bytes, or contact Syncky support.'));
  oldRelay = false;
  const lost = await send(request(2));
  assert.equal(lost.state, 'sent'); assert.equal(lost.notice, LARGE_ACCESS_ACCEPTED_NOTICE);
  const phone = createRelayClient({ baseUrl: 'http://127.0.0.1:8787', token: `sk_${identity.hub_id}_${'P'.repeat(40)}`, fetch });
  const page = await phone.getMessages({ after: 0 }), [{ seq: receivedSeq, ...envelope }] = page.messages;
  assert.equal(Buffer.byteLength(JSON.stringify(envelope)), lost.envelope_bytes);
  assert.ok(envelope.kind === 'control' && lost.envelope_bytes > 4096, 'legacy phone would not drop this delivery');
  await phone.ack(page.next_after);
  assert.equal(ack, receivedSeq);
  assert.equal(runtime.status().transport.response_waits.find(w => w.msg_id === lost.msg_id).state, 'sent');
  assert.equal(createInbox(home).read({ type: 'access_reply' }).length, 0);
  const next = request(3), accepted = await send(next);
  const reply = { v: 1, type: 'access_reply', request_ref: next.request_ref, decided_at: formatTimestamp(clock()), outcome: 'resolved',
    read: next.read.map(type => ({ type, outcome: 'allowed' })), write: next.write.map(type => ({ type, outcome: 'allowed' })) };
  assert.equal((await runtime.inbound.receive(await delivery(runtime.transport, 1, reply))).status, 'stored');
  let waits = runtime.status().transport.response_waits;
  assert.equal(waits.find(w => w.msg_id === accepted.msg_id).completed_at, at);
  assert.equal(waits.find(w => w.msg_id === lost.msg_id).completed_at, undefined);
  at += ttl;
  const restarted = createRuntime({ home, env: {}, now: clock, fetch }), status = restarted.status();
  waits = status.transport.response_waits;
  const expired = waits.find(w => w.msg_id === lost.msg_id);
  assert.equal(expired.member_id, id); assert.equal(expired.state, 'no_reply'); assert.equal(expired.notice, LARGE_ACCESS_EXPIRED_NOTICE);
  assert.equal(waits.find(w => w.msg_id === accepted.msg_id).notice, undefined);
  assert.equal(status.members.find(m => m.member_id === id).scope, null);
  assert.doesNotMatch(JSON.stringify(waits), /request_ref|public_key|"read"|"write"/);
});

for (const surface of ['cli', 'mcp']) test(`${surface} validates access TTL boundaries and malformed dates before any send`, async t => {
  const { home } = homeFixture(t), created_at = now().toISOString().replace('.000Z', 'Z');
  const base = { v: 1, type: 'access_request', request_ref: 'b'.repeat(32), created_at, read: ['steps'], write: [] };
  for (const [patch, valid] of [
    ...[1, 3600000, 86400000, 0, -1, 86400001].map(ttl => [{ expires_at: new Date(now().getTime() + ttl).toISOString().replace('.000Z', 'Z') }, ttl > 0 && ttl <= 86400000]),
    [{}, false], [{ expires_at: 'invalid' }, false], [{ expires_at: 'Infinity' }, false],
    [{ created_at: undefined, expires_at: created_at }, false], [{ expires_at: '2026-02-30T12:00:00Z' }, false],
  ]) {
    let sends = 0;
    const fetch = async () => { sends++; return Response.json({ seq: sends }, { status: 201 }); };
    const inner = { ...base, ...patch };
    const request = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'syncky_send', arguments: { type: 'access_request', inner } } };
    const result = surface === 'cli' ? await cli(home, ['send', '--type', 'access_request', '--validate', '--json', '-'], JSON.stringify(inner), fetch)
      : await cli(home, ['mcp'], JSON.stringify(request) + '\n', fetch);
    assert.equal(result.code, surface === 'cli' && !valid ? 4 : 0);
    const value = surface === 'cli' ? valid ? result.json : JSON.parse(result.stderr) : result.json.result.structuredContent;
    if (valid) {
      assertSendReceipt(value);
      assert.equal(value.state, 'sent'); assert.equal(value.kind, 'control'); assert.equal(value.type, 'access_request');
      assert.equal(sends, 1);
      assert.ok(!(result.stdout + result.stderr).includes(base.request_ref));
      assert.doesNotMatch(result.stdout + result.stderr, /"inner"|"ciphertext"|"created_at"|"expires_at"/);
    }
    else { assert.equal(value.code ?? value.error, 'schema_invalid'); assert.equal(value.detail, 'ttl'); assert.equal(sends, 0); }
    if (surface === 'mcp') {
      assert.equal(result.json.result.isError, !valid);
      assert.deepEqual(JSON.parse(result.json.result.content[0].text), value);
      if (!valid) {
        assertSendReceipt(value);
        assert.equal(result.json.result.structuredContent.code, 'schema_invalid');
      }
    }
  }
});
async function cli(home, args, input = '', fetch = () => { throw Error('unexpected network'); }) {
  let stdout = '', stderr = '';
  const code = await main(['--home', home, ...args], { env: {}, now, fetch, stdin: Readable.from([input]),
    stdout: { write: s => { stdout += s; } }, stderr: { write: s => { stderr += s; } } });
  return { code, stdout, stderr, json: (() => { try { return JSON.parse(stdout); } catch { return null; } })() };
}

test('thin command surface and send input-path flag are unambiguous', () => {
  assert.deepEqual(commandNames().sort(), ['init','pair','wait','confirm','reject','revoke','forget','status','send','inbox','receive','ack','skill','mcp','selftest','help'].sort());
  assert.equal(parseArgs(['send','--type','future','--json','-']).flags.json, '-');
});

for (const emit of [false, true]) test(`CLI receive --once ${emit ? '--emit-records emits JSONL' : 'keeps stdout quiet'} while retaining records`, async t => {
  const { home, transport } = homeFixture(t), inner = { type: 'future', extra: 'PRIVATE_RECORD_CANARY' };
  const message = await delivery(transport, 1, inner), requests = [];
  const record = { seq: 1, msg_id: message.msg_id, public_key: keys.dev1.pk, from: keys.dev1.member_id,
    kind: message.kind, type: inner.type, received_at: now().toISOString(), inner, accepted_at: now().getTime() };
  const stored = { ...record, cursor: 1 };
  const result = await cli(home, ['receive', '--once', ...(emit ? ['--emit-records'] : [])], '', async (url, options) => {
    const path = new URL(url).pathname; requests.push([path, options.method]);
    if (path === '/v1/messages' && options.method === 'GET') return Response.json({ messages: [message], next_after: 1 });
    if (path === '/v1/acks' && options.method === 'POST') {
      assert.deepEqual(JSON.parse(options.body), { up_to_seq: 1 });
      assert.deepEqual(createInbox(home).read(), [stored]);
      return new Response(null, { status: 204 });
    }
    if (path === '/v1/heartbeat' && options.method === 'POST') return new Response(null, { status: 204 });
    if (path === '/v1/hub/state' && options.method === 'GET') return Response.json({ state: 'active' });
    assert.fail('unexpected relay request');
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, emit ? JSON.stringify(stored) + '\n' : '');
  assert.doesNotMatch(result.stderr, /PRIVATE_RECORD_CANARY/);
  const cycle = result.stderr.trim().split('\n').map(line => JSON.parse(line)).find(line => line.event === 'receive_cycle');
  assert.equal(cycle.fetched, 1); assert.equal(cycle.acked_up_to, 1);
  assert.deepEqual(cycle.limits, { poll_floor_s: 300 });
  assert.equal(requests.filter(([path, method]) => path === '/v1/messages' && method === 'GET').length, 1);
  assert.equal(requests.filter(([path]) => path === '/v1/acks').length, 1);
  assert.equal(readHomeState(home).transport.acked_seq, 1);
  const inbox = await cli(home, ['inbox']);
  assert.equal(inbox.code, 0, inbox.stderr); assert.deepEqual(inbox.json.records, [stored]);
  const request = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'syncky_inbox', arguments: {} } };
  const mcp = await cli(home, ['mcp'], JSON.stringify(request) + '\n');
  assert.equal(mcp.code, 0, mcp.stderr); assert.deepEqual(mcp.json.result.structuredContent.records, [stored]);
});

test('local status/inbox/skill are offline; initialized init cannot change legacy files', async t => {
  const { home } = homeFixture(t);
  const old = Buffer.from('legacy bytes'); fs.writeFileSync(join(home, 'agent.db'), old, { mode: 0o600 });
  const status = await cli(home, ['status','--json']);
  assert.equal(status.code, 0, status.stderr); assert.deepEqual(status.json.legacy_files, ['agent.db']);
  assert.equal(status.json.members.find(m => m.member_id === 'm_dev_1').state, 'confirmed');
  assert.equal((await cli(home, ['inbox'])).code, 0);
  assert.match((await cli(home, ['skill'])).stdout, /Health JSON in/);
  assert.equal((await cli(home, ['init','--name','No'])).code, 4);
  assert.deepEqual(fs.readFileSync(join(home, 'agent.db')), old);
});

for (const file of ['installed-bundle.json', 'skill-update.json']) test(`corrupt ${file} reports skill fallback while status, send, receive and ACK remain usable`, async t => {
  const { home, transport } = homeFixture(t);
  fs.writeFileSync(join(home, file), '{BROKEN_PRIVATE_CANARY', { mode: 0o600 });
  const status = await cli(home, ['status', '--json']);
  assert.equal(status.code, 0); assert.equal(status.json.skill.code, 'skill_state_invalid');
  assert.ok(!JSON.stringify(status.json).includes('BROKEN_PRIVATE_CANARY'));
  assert.equal((await cli(home, ['inbox'])).code, 0);
  const message = await delivery(transport, 1), calls = [];
  const runtime = createRuntime({ home, now, env: {}, fetch: async (url, options) => {
    const path = new URL(url).pathname; calls.push([path, options.method]);
    if (path.endsWith('/messages') && options.method === 'GET') return Response.json({ messages: [message], next_after: 1 });
    if (path.endsWith('/messages')) return Response.json({ seq: 2 }, { status: 201 });
    if (path.endsWith('/acks') || path.endsWith('/heartbeat')) return new Response(null, { status: 204 });
    throw Error('unexpected request');
  } });
  assert.equal((await runtime.send({ type: 'future', inner: { type: 'future' } })).state, 'sent');
  await runtime.poller.once();
  assert.equal(runtime.inbox().records.length, 1);
  assert.equal(runtime.status().transport.acked_seq, 1);
  assert.ok(calls.some(([path]) => path.endsWith('/acks')));
});

test('CLI and MCP status expose the durable ACK retry deadline offline', async t => {
  const { home } = homeFixture(t), retryAt = now().getTime() + 120000;
  updateHomeState(home, s => {
    s.transport.cursor = 5; s.transport.acked_seq = 4;
    s.transport.pending_ack = { up_to_seq: 5 }; s.transport.ack_retry_at = retryAt;
  });
  const before = fs.readFileSync(join(home, 'state.json'));
  const status = await cli(home, ['status','--json']);
  assert.equal(status.code, 0, status.stderr);
  assert.equal(status.json.transport.ack_retry_at, retryAt);
  const request = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'syncky_status', arguments: {} } };
  const mcp = await cli(home, ['mcp'], JSON.stringify(request) + '\n');
  assert.equal(mcp.code, 0, mcp.stderr);
  assert.equal(mcp.json.result.structuredContent.transport.ack_retry_at, retryAt);
  assert.deepEqual(fs.readFileSync(join(home, 'state.json')), before);
});

for (const legacyLater of [false, true]) test(`CLI and MCP expose pending send deadlines and effective lanes (legacy later: ${legacyLater}) offline`, async t => {
  const { home } = homeFixture(t), retryAt = now().getTime() + 120000;
  const legacyAt = retryAt + (legacyLater ? 1000 : -1000);
  updateHomeState(home, s => {
    s.transport.send_lanes = { data: retryAt, control: retryAt + 2000 };
    s.transport.commands_retry_at = String(legacyAt);
  });
  const queue = createCipherFiles(home, 'outbox');
  queue.put({ msg_id: messageId(1), kind: 'data', type: 'commands', state: 'pending', code: 'rate_limited', relay_code: 'rate_limited', relay_status: 429,
    next_attempt_at: retryAt, retry_after_until: retryAt, body: 'PRIVATE_CIPHERTEXT_CANARY' });
  const before = fs.readFileSync(join(home, 'state.json'));
  const status = await cli(home, ['status','--json']);
  const request = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'syncky_status', arguments: {} } };
  const mcp = await cli(home, ['mcp'], JSON.stringify(request) + '\n');
  for (const [output, result] of [[status, status.json], [mcp, mcp.json.result.structuredContent]]) {
    assert.equal(output.code, 0, output.stderr);
    assert.deepEqual(result.transport.send_lanes, { data: Math.max(retryAt, legacyAt), control: retryAt + 2000 });
    assert.deepEqual(result.sends, [{ msg_id: messageId(1), kind: 'data', type: 'commands', state: 'pending', code: 'rate_limited', relay_code: 'rate_limited', relay_status: 429,
      hint: 'Queued; the receiver retries after the receipt deadline. ' + errorHint('rate_limited'), next_attempt_at: retryAt, retry_after_until: retryAt }]);
    assert.doesNotMatch(output.stdout + output.stderr, /PRIVATE_CIPHERTEXT_CANARY/);
  }
  assert.deepEqual(fs.readFileSync(join(home, 'state.json')), before);
});

test('status keeps pending sends visible beyond the last 100 entries', async t => {
  const { home } = homeFixture(t), queue = createCipherFiles(home, 'outbox');
  for (let i = 1; i <= 101; i++) queue.put({ msg_id: messageId(i), kind: 'data', body: 'PRIVATE_CIPHERTEXT_CANARY',
    state: 'pending', code: 'rate_limited', next_attempt_at: now().getTime() + 60000, retry_after_until: now().getTime() + 60000 });
  const status = await cli(home, ['status', '--json']);
  assert.equal(status.code, 0, status.stderr);
  assert.equal(status.json.outbox.pending, 101);
  assert.equal(status.json.sends.length, 101);
  assert.equal(status.json.sends[0].msg_id, messageId(1));
  assert.equal(status.json.sends[0].code, 'rate_limited');
  assert.doesNotMatch(status.stdout, /PRIVATE_CIPHERTEXT_CANARY/);
});

test('status includes a legacy-only data lane deadline', async t => {
  const { home } = homeFixture(t), retryAt = now().getTime() + 120000;
  updateHomeState(home, s => { s.transport.commands_retry_at = String(retryAt); });
  const status = await cli(home, ['status','--json']);
  assert.equal(status.code, 0, status.stderr);
  assert.deepEqual(status.json.transport.send_lanes, { data: retryAt });
});

for (const surface of ['cli', 'mcp']) for (const command of ['status', 'inbox']) {
  test(`${surface} ${command} waits for a receiver state transaction without starting network work`, async t => {
    const { home } = homeFixture(t), before = fs.readFileSync(join(home, 'state.json'));
    const receiver = acquireHomeLock(home, 'receiver'), transaction = acquireHomeLock(home, 'state');
    const timer = setTimeout(() => transaction.release(), 40);
    try {
      const request = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: `syncky_${command}`, arguments: {} } };
      const output = surface === 'cli' ? await cli(home, [command, '--json']) : await cli(home, ['mcp'], JSON.stringify(request) + '\n');
      assert.equal(output.code, 0, output.stderr);
      const result = surface === 'cli' ? output.json : output.json.result.structuredContent;
      if (surface === 'mcp') assert.equal(output.json.result.isError, false);
      if (command === 'status') assert.equal(result.member_id, identity.member_id);
      else assert.deepEqual(result.records, []);
      assert.deepEqual(fs.readFileSync(join(home, 'state.json')), before);
      assert.throws(() => acquireHomeLock(home, 'receiver'), { code: 'home_locked' });
    } finally { clearTimeout(timer); transaction.release(); receiver.release(); }
  });
}

test('generic send accepts private stdin/file JSON and rejects invalid input without echoing it', async t => {
  const { home } = homeFixture(t);
  const raw = '{"type":"future","private":"INNER_CANARY"}';
  const fetch = async () => new Response('{"seq":1}', { status: 201 });
  for (const source of ['-', join(home,'input.json')]) {
    if (source !== '-') fs.writeFileSync(source, raw, { mode: 0o600 });
    const result = await cli(home, ['send','--type','future','--json',source], raw, fetch);
    assert.equal(result.code, 0, result.stderr); assert.equal(result.json.state, 'sent');
    assert.doesNotMatch(result.stdout + result.stderr, /INNER_CANARY/);
  }
  assert.equal(createCipherFiles(home,'outbox').list().length, 2);
  for (const raw of ['{"type":"future",INNER_CANARY', '[]', '{"type":"other"}', 'x'.repeat(262145)]) {
    const result = await cli(home, ['send','--type','future','--json','-'], raw, fetch);
    assert.equal(result.code, 4); assert.doesNotMatch(result.stderr, /INNER_CANARY/);
  }
});

test('send waits for a receiver transaction while reading its receipt without resending', async t => {
  const { home } = homeFixture(t);
  let posts = 0, transaction, timer;
  const runtime = createRuntime({ home, env: {}, now, fetch: async () => {
    posts++;
    return new Response('{"seq":1}', { status: 201 });
  } });
  const receipts = runtime.outbox.receipts;
  runtime.outbox.receipts = () => {
    if (!transaction) {
      transaction = acquireHomeLock(home, 'state');
      timer = setTimeout(() => transaction.release(), 40);
    }
    return receipts();
  };
  const receiver = acquireHomeLock(home, 'receiver');
  try {
    const receipt = await runtime.send({ type: 'future', inner: { type: 'future', private: 'INNER_CANARY' } });
    assert.equal(receipt.state, 'sent'); assert.equal(posts, 1);
    const entries = createCipherFiles(home, 'outbox').list();
    assert.equal(entries.length, 1); assert.equal(entries[0].msg_id, receipt.msg_id);
    assert.equal(entries[0].attempts, 1);
    assert.throws(() => acquireHomeLock(home, 'receiver'), { code: 'home_locked' });
  } finally { clearTimeout(timer); transaction?.release(); receiver.release(); }
});

test('MCP send returns a conforming queued receipt when flush prunes its completed entry', async t => {
  const { home } = homeFixture(t), queue = createCipherFiles(home, 'outbox');
  for (let i = 1; i <= 100; i++) queue.put({ msg_id: `ffffffff-ffff-7000-8000-${String(i).padStart(12, '0')}`,
    kind: 'control', type: 'future', to: ['m_dev_1'], state: 'sent', seq: i, body: 'RETAINED_CIPHERTEXT_CANARY' });
  let posts = 0, msgId;
  const runtime = createRuntime({ home, env: {}, now, fetch: async (_url, options) => {
    posts++; msgId = JSON.parse(options.body).msg_id;
    return Response.json({ seq: 101 }, { status: 201 });
  } });
  const server = createMcpServer({ handlers: { syncky_send: args => runtime.send(args) } });
  const { result } = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'syncky_send', arguments: { type: 'future', inner: { type: 'future', private: 'INNER_CANARY' } } } });
  assert.equal(posts, 1); assert.equal(result.isError, false);
  assertSendReceipt(result.structuredContent);
  assert.deepEqual(result.structuredContent, { msg_id: msgId, kind: 'control', type: 'future', to: ['m_dev_1'], state: 'pending' });
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  assert.equal(queue.list().length, 100);
  assert.equal(queue.list().some(entry => entry.msg_id === msgId), false);
  assert.doesNotMatch(JSON.stringify(result), /INNER_CANARY|ciphertext|RETAINED_CIPHERTEXT_CANARY/);
});

test('inbox pagination is bounded and all version replies remain distinct', async t => {
  const { home } = homeFixture(t), inbox = createInbox(home);
  for (let seq = 1; seq <= 3; seq++) inbox.append({ seq, from: 'm_dev_1', kind: 'data', type: 'sync', received_at: now().toISOString(), inner: { type: 'sync', acks: [{ command_id: 'c_158', version: seq }] } });
  const first = await cli(home, ['inbox','--type','sync','--member','m_dev_1','--limit','2']);
  assert.equal(first.code, 0, first.stderr); assert.equal(first.json.records.length, 2); assert.equal(first.json.next_after_seq, 2);
  assert.deepEqual((await cli(home, ['inbox','--after-seq','2'])).json.records.map(r => r.inner.acks[0].version), [3]);
  assert.equal((await cli(home, ['inbox','--limit','1001'])).code, 1);
  assert.equal((await cli(home, ['ack','--up-to-seq','4'])).code, 4);
});

for (const command of ['serve','poll','samples','summary','cmd','journal','access','diagnostics','resync','webhook','members']) test(`removed ${command} fails without opening legacy files`, async t => {
  const { home } = homeFixture(t); fs.writeFileSync(join(home,'agent.db'),'retained', { mode: 0o600 });
  const result = await cli(home, [command]);
  assert.equal(result.code, 1); assert.equal(JSON.parse(result.stderr).error, 'invalid_arguments');
  assert.equal(fs.readFileSync(join(home,'agent.db'),'utf8'), 'retained');
});

test('MCP exact tools, annotations, verified resource and bounded error channels', async () => {
  assert.deepEqual(TOOLS.map(t => t.name).sort(), ['syncky_status','syncky_inbox','syncky_send','syncky_ack','syncky_skill'].sort());
  for (const tool of TOOLS) assert.equal(tool.annotations.readOnlyHint, !['syncky_send','syncky_ack'].includes(tool.name));
  assert.equal(TOOLS.find(t => t.name === 'syncky_send').annotations.idempotentHint, false);
  const server = createMcpServer({ version: 'test', handlers: { syncky_skill: async () => ({ skill: 'VERIFIED' }), syncky_send: async () => { throw Error('INNER_CANARY'); } } });
  const call = (method, params) => server.handle({ jsonrpc: '2.0', id: 1, method, params });
  assert.equal((await call('resources/list')).result.resources[0].uri, 'syncky://skill');
  assert.equal((await call('resources/read', { uri: 'syncky://skill' })).result.contents[0].text, 'VERIFIED');
  assert.equal((await call('resources/read', { uri: 'file:///secret' })).error.code, -32602);
  const error = await call('tools/call', { name: 'syncky_send', arguments: { type: 'future', inner: { type: 'future' } } });
  assert.equal(error.result.isError, true); assert.doesNotMatch(JSON.stringify(error), /INNER_CANARY/);
  assert.equal(error.result.structuredContent.code, 'tool_failed');
  assert.deepEqual(JSON.parse(error.result.content[0].text), error.result.structuredContent);
  assertSendReceipt(error.result.structuredContent);
});

test('MCP starts no receiver, heartbeat, retry or update network work', async t => {
  const { home } = homeFixture(t), before = fs.readFileSync(join(home,'state.json'));
  const input = ['syncky_status','syncky_inbox','syncky_skill'].map((name,id) => JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {} } })).join('\n') + '\n';
  const result = await cli(home, ['mcp'], input);
  assert.equal(result.code, 0, result.stderr); assert.equal(result.stdout.trim().split('\n').length, 3);
  assert.deepEqual(fs.readFileSync(join(home,'state.json')), before);
  assert.equal(fs.existsSync(join(home,'.receiver.lock')), false);
  assert.equal(readHomeState(home).transport.heartbeat_day, undefined);
});

for (const [reason, delay, interval] of [['poll_floor', 300000, 86400], ['retry_after', 500000, 300]]) test(`receive once reports the exact ${reason} deadline and polls at eligibility`, async t => {
  const { home } = homeFixture(t), last = now().getTime(), due = last + delay;
  updateHomeState(home, s => {
    s.transport.last_poll_at = last;
    s.transport.next_poll_at = last + interval * 1000;
    s.transport.poll_interval_s = interval;
    if (reason === 'retry_after') s.transport.poll_retry_after_until = due;
  });
  let at = due - 1;
  const polls = [];
  const fetch = async input => {
    const url = new URL(input);
    if (url.pathname === '/v1/heartbeat') return new Response(null, { status: 204 });
    if (url.pathname === '/v1/hub/state') return Response.json({ state: 'active' });
    assert.equal(url.pathname, '/v1/messages');
    polls.push(url.searchParams.get('poll_interval_s'));
    return Response.json({ messages: [] });
  };
  const run = (...args) => runCli(['--home', home, 'receive', '--once', '--poll-interval', String(interval), ...args], { now: () => new Date(at), fetch });
  const receiveCycle = ({ stderr }) => stderr.trim().split('\n').map(line => JSON.parse(line)).find(line => line.event === 'receive_cycle');

  const result = await run();
  assert.equal(result.code, 0);
  assert.equal(result.stdout, '');
  const cycle = receiveCycle(result);
  assert.equal(cycle.deferred, true);
  assert.equal(cycle.reason, reason);
  assert.equal(cycle.next_poll_at, due);
  assert.deepEqual(cycle.limits, { poll_floor_s: 300 });
  const quiet = await run('--log-level', 'silent');
  assert.deepEqual([quiet.code, quiet.stdout, quiet.stderr], [0, '', '']);
  assert.deepEqual(polls, []);

  at = due;
  const eligible = await run();
  assert.equal(eligible.code, 0);
  assert.equal(eligible.stdout, '');
  assert.equal(receiveCycle(eligible).pages, 1);
  assert.deepEqual(polls, [String(interval)]);
});


for (const surface of ['cli', 'mcp']) for (const [status, cause, state, queueCode] of [
  [201, null, 'sent', null], [429, 'rate_limited', 'pending', 'rate_limited'], [503, 'internal_error', 'pending', 'send_retry'],
  [401, 'invalid_token', 'failed', 'send_failed'], [413, 'payload_too_large', 'failed', 'send_failed'], [403, 'PRIVATE_CAUSE', 'failed', 'send_failed'],
]) test(`${surface} real send returns ${state} metadata for HTTP ${status} without changing exit/isError`, async t => {
  const { home } = homeFixture(t); let posts = 0;
  const fetch = async () => {
    posts++;
    return Response.json(status === 201 ? { seq: 8 } : { error: cause, message: 'PRIVATE_CAUSE', hint: 'PRIVATE_CAUSE', details: 'PRIVATE_CAUSE' }, { status, headers: status === 429 ? { 'Retry-After': '120' } : {} });
  };
  const inner = { type: 'future', private: 'PRIVATE_INNER' };
  const request = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'syncky_send', arguments: { type: 'future', inner } } };
  const output = surface === 'cli' ? await cli(home, ['send', '--type', 'future', '--json', '-'], JSON.stringify(inner), fetch)
    : await cli(home, ['mcp'], JSON.stringify(request) + '\n', fetch);
  assert.equal(output.code, 0); assert.equal(posts, 1);
  if (surface === 'mcp') {
    assert.equal(output.json.result.isError, false);
    assert.deepEqual(JSON.parse(output.json.result.content[0].text), output.json.result.structuredContent);
  }
  const receipt = surface === 'cli' ? output.json : output.json.result.structuredContent;
  assertSendReceipt(receipt);
  assert.equal(receipt.state, state); assert.equal(receipt.code, queueCode); assert.equal(receipt.attempts, 1);
  assert.equal(receipt.relay_code, cause ? cause === 'PRIVATE_CAUSE' ? 'relay_error' : cause : undefined);
  assert.equal(receipt.relay_status, cause ? status : undefined);
  if (cause) assert.equal(typeof receipt.hint, 'string'); else assert.equal(receipt.hint, undefined);
  if (status === 429) assert.equal(receipt.retry_after_until, now().getTime() + 120000);
  if (state === 'failed') assert.match(receipt.hint, /will not retry/);
  assert.ok(!output.stdout.includes('PRIVATE_CAUSE')); assert.ok(!(output.stdout + output.stderr).includes('PRIVATE_INNER'));
  const offline = await cli(home, ['status']);
  assert.deepEqual(offline.json.sends, [receipt]);
  assert.equal((await cli(home, ['inbox'])).json.records.length, 0);
});

test('real MCP adapter returns a conforming scope-release receipt without exposing its inner data', async t => {
  const { home } = homeFixture(t); let posts = 0;
  const inner = { v: 1, type: 'scope_release', read: ['steps'], write: ['body_mass'] };
  const request = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'syncky_send', arguments: { type: 'scope_release', inner, validate: false } } };
  const output = await cli(home, ['mcp'], JSON.stringify(request) + '\n', async () => {
    posts++; return Response.json({ seq: 8 }, { status: 201 });
  });
  assert.equal(output.code, 0); assert.equal(posts, 1); assert.equal(output.json.result.isError, false);
  const receipt = output.json.result.structuredContent;
  assertSendReceipt(receipt);
  assert.equal(receipt.state, 'sent'); assert.equal(receipt.kind, 'control'); assert.equal(receipt.type, 'scope_release');
  assert.equal(receipt.seq, 8); assert.equal(receipt.code, null);
  assert.deepEqual(JSON.parse(output.json.result.content[0].text), receipt);
  assert.deepEqual((await cli(home, ['status'])).json.sends, [receipt]);
  assert.doesNotMatch(output.stdout + output.stderr, /"inner"|"ciphertext"|"read"|"write"|steps|body_mass/);
});

for (const surface of ['cli', 'mcp']) test(`${surface} real scope-release validation keeps safe detail and thrown local failure behavior`, async t => {
  const { home } = homeFixture(t);
  for (const [read, detail] of [[[], 'empty'], [['PRIVATE_CANARY'], 'unknown_type'], [null, 'malformed']]) {
    const inner = { v: 1, type: 'scope_release', read, write: [] };
    const request = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'syncky_send', arguments: { type: 'scope_release', inner } } };
    const output = surface === 'cli' ? await cli(home, ['send', '--type', 'scope_release', '--json', '-'], JSON.stringify(inner)) : await cli(home, ['mcp'], JSON.stringify(request) + '\n');
    assert.equal(output.code, surface === 'cli' ? 4 : 0);
    if (surface === 'mcp') {
      assert.equal(output.json.result.isError, true);
      assert.equal(output.json.result.structuredContent.code, 'schema_invalid');
      assertSendReceipt(output.json.result.structuredContent);
      assert.deepEqual(JSON.parse(output.json.result.content[0].text), output.json.result.structuredContent);
    }
    const error = surface === 'cli' ? JSON.parse(output.stderr) : output.json.result.structuredContent;
    assert.equal(error.error ?? error.code, 'schema_invalid'); assert.equal(error.detail, detail);
    assert.equal(error.hint, errorHint('schema_invalid'));
    assert.ok(!(output.stdout + output.stderr).includes('PRIVATE_CANARY'));
  }
  assert.equal(createCipherFiles(home, 'outbox').list().length, 0);
});
