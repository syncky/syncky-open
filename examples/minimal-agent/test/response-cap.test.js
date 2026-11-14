import assert from 'node:assert/strict';
import { test } from 'node:test';
import { relayCall } from '../agent.mjs';

const MiB = 1024 * 1024;
function stream(body, { status = 200, endless = false, readError = false } = {}) {
  let offset = 0, cancelled = false, pulled = 0;
  const bytes = Buffer.from(body);
  const response = new Response(new ReadableStream({
    pull(c) {
      pulled++;
      if (readError) return c.error(new Error('private-canary'));
      if (!endless && offset === bytes.length) return c.close();
      const chunk = endless ? Buffer.alloc(64 * 1024, 32) : bytes.subarray(offset, offset + 8191);
      offset += chunk.length; c.enqueue(chunk);
    },
    cancel() { cancelled = true; },
  }), { status, headers: { 'Content-Length': '1', 'Retry-After': '0' } });
  return { response, stats: () => ({ cancelled, pulled }) };
}
for (const [method, path, cap] of [['GET', '/v1/members', MiB], ['GET', '/v1/messages?after=0', 9 * MiB], ['POST', '/v1/messages', MiB], ['GET', '/v1/messages-other', MiB]]) {
  test(`${method} ${path} caps actual UTF-8 bytes and cancels every oversized status`, async t => {
    for (const status of [200, 429, 503]) {
      const s = stream('', { status, endless: true }); let calls = 0;
      t.mock.method(globalThis, 'fetch', async (_, init) => { calls++; assert.equal(init.redirect, 'error'); return s.response; });
      await assert.rejects(relayCall({ relay: 'https://relay.test' }, method, path), { code: 'invalid_response' });
      assert.equal(s.stats().cancelled, true); assert.equal(calls, 1);
      assert.ok(s.stats().pulled * 65536 <= cap + 2 * 65536);
    }
    const json = JSON.stringify({ text: '€'.repeat(Math.floor((cap - 11) / 3)) });
    const body = json + ' '.repeat(cap - Buffer.byteLength(json));
    const good = stream(body);
    t.mock.method(globalThis, 'fetch', async () => good.response);
    assert.equal((await relayCall({ relay: 'https://relay.test' }, method, path)).text.length, Math.floor((cap - 11) / 3));
    const excess = stream(body + ' ');
    t.mock.method(globalThis, 'fetch', async () => excess.response);
    await assert.rejects(relayCall({ relay: 'https://relay.test' }, method, path), { code: 'invalid_response' });
  });
}
test('204, malformed JSON, stream errors and retry behavior retain bounded response handling', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 204 }));
  assert.equal(await relayCall({}, 'POST', '/v1/acks'), null);
  const bad = stream('not JSON'); t.mock.method(globalThis, 'fetch', async () => bad.response);
  await assert.rejects(relayCall({}, 'GET', '/v1/members'), { code: 'invalid_response' });
  const broken = stream('', { readError: true }); t.mock.method(globalThis, 'fetch', async () => broken.response);
  await assert.rejects(relayCall({}, 'GET', '/v1/members'), e => !e.message.includes('private-canary'));
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => ++calls === 1 ? new Response('{"error":"internal_error"}', { status: 503, headers: { 'Retry-After': '0' } }) : Response.json({ ok: true }));
  assert.equal((await relayCall({}, 'GET', '/v1/members')).ok, true); assert.equal(calls, 2);
});
for (const status of [301, 302, 307, 308]) test(`invite registration refuses redirect ${status} without destination delivery`, async t => {
  const { createServer } = await import('node:http');
  let delivered = 0;
  const target = createServer((req, res) => { delivered++; res.end('{}'); });
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
  const source = createServer((req, res) => { req.resume(); res.writeHead(status, { Location: `http://127.0.0.1:${target.address().port}/register` }); res.end(); });
  await new Promise(resolve => source.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await Promise.all([source, target].map(server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }))); });
  await assert.rejects(relayCall({ relay: `http://127.0.0.1:${source.address().port}` }, 'POST', '/v1/agents/register', { body: '{}', headers: { 'X-Syncky-Invite': 'private-canary' } }), { code: 'network_error' });
  assert.equal(delivered, 0);
});
