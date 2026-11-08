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
import { setup, keys, identity, now, delivery, messageId } from '../support/thin-transport.js';

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
