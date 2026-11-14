import { ERROR_GUIDANCE, errorHint } from '../../src/error-guidance.js';
import { LocalStateError } from '../../src/config.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { createMcpServer, runMcp, MCP_MAX_BYTES, TOOLS } from '../../src/mcp.js';
import { setup, now } from '../support/thin-transport.js';
import { scopedRequest, requestedScope } from '../support/pairing-scope.js';
import { localStatus } from '../../src/runtime.js';

test('MCP compiles tool schemas only on the first tool call and shares them across servers', () => {
  const url = process.env.SYNCKY_AGENT_BUNDLE_FIXTURE
    ? pathToFileURL(JSON.parse(readFileSync(process.env.SYNCKY_AGENT_BUNDLE_FIXTURE, 'utf8')).release.bundlePath).href
    : new URL('../../src/mcp.js', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    let compiled = 0;
    globalThis.Function = new Proxy(Function, { construct(target, args) { compiled++; return Reflect.construct(target, args); } });
    const module = await import(${JSON.stringify(url)});
    const { createMcpServer, TOOLS } = module.modules?.['mcp.js'] ?? module;
    assert.equal(compiled, 0);
    const handlers = Object.fromEntries(TOOLS.map(tool => [tool.name, () => ({ skill: 'verified' })]));
    const server = createMcpServer({ handlers });
    const request = (method, params) => ({ jsonrpc: '2.0', id: 1, method, params });
    for (const method of ['initialize', 'ping', 'tools/list', 'resources/list']) await server.handle(request(method));
    await server.handle(request('resources/read', { uri: 'syncky://skill' }));
    assert.equal(compiled, 0);
    assert.equal((await server.handle(request('tools/call', { name: 'syncky_send', arguments: {} }))).error.code, -32602);
    assert.ok(compiled > 0);
    const count = compiled;
    for (const instance of [server, createMcpServer({ handlers })]) {
      assert.equal((await instance.handle(request('tools/call', { name: 'syncky_status' }))).result.isError, false);
      assert.equal((await instance.handle(request('tools/call', { name: 'syncky_inbox', arguments: { extra: true } }))).error.code, -32602);
      assert.equal((await instance.handle(request('tools/call', { name: 'unknown' }))).error.code, -32602);
    }
    assert.equal(compiled, count);
  `], { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, child.stdout + child.stderr);
});

test('MCP status carries safe pairing request metadata without adding a pair tool', async t => {
  const { home } = setup(t); scopedRequest(home);
  const server = createMcpServer({ handlers: { syncky_status: () => localStatus(home, { status: () => ({}) }, now().getTime()) } });
  const result = await server.handle(request('tools/call', { name: 'syncky_status', arguments: {} }));
  const member = result.result.structuredContent.members.find(m => m.member_id === 'm_dev_1');
  assert.equal(member.pairing_access.state, 'awaiting'); assert.deepEqual(member.pairing_access.requested_scope.read, ['steps']);
  assert.equal(member.scope, null);
  assert.deepEqual(member.pairing_access.requested_scope, { read: ['steps'], write: ['body_mass'] });
  assert.ok(!JSON.stringify(result).includes(requestedScope.request_ref));
  assert.ok(!TOOLS.some(t => /pair/.test(t.name)));
  assert.doesNotMatch(JSON.stringify(result), /pair_secret|pairing_token|private_key|pair_proof|ciphertext|https:/);
});

const request = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, params });
test('stdio handles chunk boundaries, notifications, CRLF, UTF-8 and trailing lines without side effects', async () => {
  let calls = 0, output = '';
  const input = Buffer.from([JSON.stringify(request('initialize')), JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), JSON.stringify(request('resources/read', { uri: 'syncky://skill' }, 2)), JSON.stringify(request('ping', {}, 3))].join('\r\n'));
  await runMcp({ version: 'test', handlers: { syncky_skill: () => { calls++; return { skill: 'Verified ü' }; } }, input: Readable.from([...input].map(b => Buffer.from([b]))), write: s => { output += s; } });
  const replies = output.trim().split('\n').map(s => JSON.parse(s));
  assert.deepEqual(replies.map(r => r.id), [1, 2, 3]); assert.equal(calls, 1);
  assert.equal(replies[1].result.contents[0].text, 'Verified ü');
  assert.match(replies[0].result.instructions, /Start receive separately/);
});

test('oversize stream frames are bounded and later valid requests still work', async () => {
  let output = ''; const oversized = 'x'.repeat(MCP_MAX_BYTES + 1);
  await runMcp({ handlers: {}, input: Readable.from([oversized.slice(0, 500000), oversized.slice(500000) + '\n' + JSON.stringify(request('ping')) + '\n']), write: s => { output += s; } });
  const replies = output.trim().split('\n').map(s => JSON.parse(s));
  assert.equal(replies[0].error.code, -32600); assert.deepEqual(replies[1].result, {});
  assert.ok(output.length < 300);
});

test('invalid RPC, retired tools, schemas, resource errors and handler failures disclose no private text', async () => {
  let calls = 0; const server = createMcpServer({ handlers: { syncky_skill: () => { throw Error('PRIVATE'); }, syncky_send: () => { calls++; throw Error('PRIVATE'); }, syncky_inbox: () => 'x'.repeat(MCP_MAX_BYTES * 3) } });
  for (const [message, code] of [[null,-32600], [[], -32600], [request('missing'), -32601], [request('tools/call', { name:'syncky_write', arguments:{} }), -32602], [request('tools/call', { name:'syncky_send', arguments:{ type:'future' } }), -32602], [request('resources/read', { uri:'other' }), -32602], [request('resources/read', { uri:'syncky://skill' }), -32002]]) {
    const reply = await server.handle(message); assert.equal(reply.error.code, code); assert.ok(!JSON.stringify(reply).includes('PRIVATE'));
  }
  assert.equal((await server.handleLine('{PRIVATE')).error.code, -32700);
  assert.equal((await server.handle(request('tools/call', { name:'syncky_send', arguments:{ type:'future', inner:{ type:'future' } } }))).result.structuredContent.code, 'tool_failed');
  assert.equal(calls, 1);
  assert.equal((await server.handle(request('tools/call', { name:'syncky_inbox', arguments:{} }))).result.structuredContent.code, 'result_too_large');
  for (const args of [{ limit:1001 }, { after_seq:-1 }, { since:'invalid' }, { since:'2026-11-05', until:'2026-11-01' }, { member:'bad' }, { extra:true }]) assert.equal((await server.handle(request('tools/call', { name:'syncky_inbox', arguments:args }))).error.code, -32602);
  assert.deepEqual((await server.handle(request('tools/list'))).result.tools, TOOLS);
});


test('MCP public tool failures cover every known code, preserve isError and redact remote guidance', async () => {
  for (const code of [...Object.keys(ERROR_GUIDANCE), 'future_error', 'constructor', 'PRIVATE_CANARY\nunsafe']) {
    for (const local of [false, true]) {
      const err = local ? new LocalStateError(code, 'PRIVATE_CANARY', { detail: 'not_writable', types: ['steps'] })
        : Object.assign(Error('PRIVATE_CANARY'), { code, detail: 'not_writable', types: ['steps'], details: 'PRIVATE_CANARY' });
      err.hint = 'PRIVATE_CANARY';
      let log;
      const server = createMcpServer({ handlers: { syncky_status: () => { throw err; } }, logger: { warn: (event, meta) => { log = { event, ...meta }; } } });
      const response = await server.handle(request('tools/call', { name: 'syncky_status' }));
      const value = response.result.structuredContent;
      assert.equal(response.result.isError, true);
      assert.equal(value.code, /^[a-z_]{1,64}$/.test(code) ? code : 'tool_failed');
      assert.equal(value.hint, errorHint(value.code));
      assert.equal(value.detail, local ? 'not_writable' : undefined);
      assert.deepEqual(value.types, local ? ['steps'] : undefined);
      assert.deepEqual(JSON.parse(response.result.content[0].text), value);
      assert.ok(!JSON.stringify({ response, log }).includes('PRIVATE_CANARY'));
    }
  }
  const server = createMcpServer({ handlers: { syncky_status: () => { throw new LocalStateError('schema_invalid', 'PRIVATE_CANARY', { detail: 'PRIVATE_CANARY', types: ['PRIVATE_CANARY'] }); } } });
  const value = (await server.handle(request('tools/call', { name: 'syncky_status' }))).result.structuredContent;
  assert.equal(value.detail, undefined); assert.equal(value.types, undefined);
});
