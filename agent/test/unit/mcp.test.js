import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { createMcpServer, runMcp, MCP_MAX_BYTES, TOOLS } from '../../src/mcp.js';
import { setup, now } from '../support/thin-transport.js';
import { scopedRequest, requestedScope } from '../support/pairing-scope.js';
import { localStatus } from '../../src/runtime.js';

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
