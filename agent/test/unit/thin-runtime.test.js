import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
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
      if (missing) assert.match(member.pairing_access.notice, /older app.*send --type access_request/);
      assert.doesNotMatch(output.stdout + output.stderr, /pair_secret|pairing_token|pair_proof|private_key|ciphertext|uri/);
    }
  }
  const later = () => new Date(now().getTime() + 900000);
  const before = fs.readFileSync(join(home, 'state.json')), transaction = acquireHomeLock(home, 'state');
  try {
    const status = createRuntime({ home, now: later, env: {} }).status();
    const expired = status.members.find(m => m.member_id === 'm_dev_1').pairing_access;
    assert.equal(expired.state, 'no_reply'); assert.match(expired.notice, /access reply not received/);
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

function homeFixture(t) {
  const fixture = setup(t);
  saveSecrets(fixture.home, { private_key: keys.agent.sk, public_key: keys.agent.pk,
    token: `sk_${identity.hub_id}_${'T'.repeat(40)}`, webhook_secret: `whsec_${'W'.repeat(43)}` });
  saveConfig(fixture.home, { relay_url: 'http://127.0.0.1:8787', name: 'Test' });
  return fixture;
}
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
  const record = { seq: 1, from: keys.dev1.member_id, kind: message.kind, type: inner.type, received_at: now().toISOString(), inner };
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
  assert.equal(result.stdout, emit ? JSON.stringify(record) + '\n' : '');
  assert.doesNotMatch(result.stderr, /PRIVATE_RECORD_CANARY/);
  const cycle = result.stderr.trim().split('\n').map(line => JSON.parse(line)).find(line => line.event === 'receive_cycle');
  assert.equal(cycle.fetched, 1); assert.equal(cycle.acked_up_to, 1);
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
  queue.put({ msg_id: messageId(1), kind: 'data', type: 'commands', state: 'pending', code: 'rate_limited',
    next_attempt_at: retryAt, retry_after_until: retryAt, body: 'PRIVATE_CIPHERTEXT_CANARY' });
  const before = fs.readFileSync(join(home, 'state.json'));
  const status = await cli(home, ['status','--json']);
  const request = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'syncky_status', arguments: {} } };
  const mcp = await cli(home, ['mcp'], JSON.stringify(request) + '\n');
  for (const [output, result] of [[status, status.json], [mcp, mcp.json.result.structuredContent]]) {
    assert.equal(output.code, 0, output.stderr);
    assert.deepEqual(result.transport.send_lanes, { data: Math.max(retryAt, legacyAt), control: retryAt + 2000 });
    assert.deepEqual(result.sends, [{ msg_id: messageId(1), kind: 'data', type: 'commands', state: 'pending', code: 'rate_limited',
      next_attempt_at: retryAt, retry_after_until: retryAt }]);
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

test('receive once exposes the authoritative floor reason and deadline to the operator', async t => {
  const { home } = homeFixture(t), at = now().getTime();
  updateHomeState(home, s => { s.transport.last_poll_at = at; s.transport.next_poll_at = at + 1800000; s.transport.poll_interval_s = 1800; });
  const result = await cli(home, ['receive', '--once']);
  assert.equal(result.code, 0);
  const cycle = result.stderr.trim().split('\n').map(s => JSON.parse(s)).find(s => s.event === 'receive_cycle');
  assert.equal(cycle.deferred, true); assert.equal(cycle.reason, 'poll_floor'); assert.equal(cycle.next_poll_at, at + 300000);
});
