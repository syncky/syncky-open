import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createRelayClient } from '../../src/relay-client.js';
import { createRelaySocket } from '../../src/relay-socket.js';
import { fakeSockets, socketClock } from '../support/relay-socket.js';

function fixture(t, options = {}) {
  const clock = socketClock(), transport = fakeSockets(), wakes = [];
  const link = createRelaySocket({ connect: transport.connect, onWake: () => wakes.push(clock.now()),
    now: clock.now, timers: clock.timers, random: () => 0.5, ...options });
  t.after(() => link.stop());
  link.start();
  return { ...clock, ...transport, link, wakes };
}

test('open and text hints wake a check while keepalive only tracks pongs', t => {
  const { link, sockets: [ws], wakes, advance, pending } = fixture(t);
  assert.equal(link.healthy, false);
  ws.open();
  assert.equal(link.healthy, true);
  ws.message('changed'); ws.message('other'); ws.message(new Uint8Array([1]));
  assert.deepEqual(wakes, [0, 0]);
  advance(29_999); assert.deepEqual(ws.sent, []);
  advance(1); assert.deepEqual(ws.sent, ['ping']);
  advance(30_000); assert.equal(link.healthy, true);
  ws.message('pong');
  advance(30_000); advance(30_000);
  assert.equal(link.healthy, true);
  advance(30_000);
  assert.equal(link.healthy, false);
  assert.deepEqual(ws.sent, Array(4).fill('ping'));
  assert.deepEqual(wakes, [0, 0, 150_000]);
  assert.equal(ws.closes, 1);
  link.stop(); assert.equal(pending.size, 0);
});

test('subscription, a healthy hint and a failure report distinct wakes', t => {
  const events = [];
  const { sockets: [ws] } = fixture(t, { onWake: event => events.push(event) });
  ws.message('changed');
  ws.open();
  ws.message('changed');
  ws.peerClose(4409);
  ws.message('changed');
  assert.deepEqual(events, ['subscribed', 'hint', 'failure']);
});

test('a handshake failure reported again during close wakes polling only once', t => {
  let reportError, closes = 0;
  const { wakes } = fixture(t, { connect: () => ({
    addEventListener(event, handler) {
      if (event === 'error') reportError = handler;
    },
    close() {
      if (++closes === 1) reportError();
    },
  }) });
  reportError();
  assert.equal(closes, 1);
  assert.deepEqual(wakes, [0]);
});

test('first-sync hold sends an immediate heartbeat and then falls back to polling when the phone leaves', t => {
  const events = [];
  const { link, sockets, advance } = fixture(t, { onWake: (...event) => events.push(event) });
  const [ws] = sockets;
  ws.open();
  ws.message('first_sync');
  assert.equal(link.firstSync, true);
  assert.deepEqual(ws.sent, ['ping']);

  ws.message('pong');
  ws.message('first_sync');
  assert.deepEqual(ws.sent, ['ping']);
  ws.peerClose(4403);
  assert.equal(link.healthy, false);
  assert.equal(link.firstSync, false);
  assert.deepEqual(events, [['subscribed'], ['failure', 'polling']]);
  advance(120_000);
  assert.equal(sockets.length, 1);
});

test('failure to send the first-sync heartbeat leaves the agent free to poll and retry', t => {
  const events = [];
  const { link, sockets, advance } = fixture(t, { onWake: event => events.push(event) });
  const [ws] = sockets;
  ws.send = () => { throw new Error('connection lost'); };
  ws.open();
  ws.message('first_sync');
  assert.equal(link.healthy, false);
  assert.equal(link.firstSync, false);
  assert.equal(ws.closes, 1);
  assert.deepEqual(events, ['subscribed', 'failure']);
  advance(500);
  assert.equal(sockets.length, 2);
  const [, retry] = sockets;
  retry.open();
  retry.message('first_sync');
  assert.equal(link.healthy, true);
  assert.equal(link.firstSync, true);
  assert.deepEqual(retry.sent, ['ping']);
});

for (const code of [4403, 4409]) test(`open followed by ${code} promptly falls back without retrying the same wait`, t => {
  const { link, sockets, wakes, advance, pending } = fixture(t), [ws] = sockets;
  ws.open(); ws.peerClose(code);
  assert.equal(link.healthy, false);
  assert.deepEqual(wakes, [0, 0]);
  link.start(); advance(120_000); link.start();
  assert.equal(sockets.length, 1);
  assert.equal(pending.size, 0);
  assert.deepEqual(ws.sent, []);
  const next = fixture(t);
  assert.equal(next.sockets.length, 1);
});

for (const code of [4401, 4408]) test(`${code} wakes HTTP and retries with full jitter within the three-attempt cap`, t => {
  const { link, sockets, wakes, advance, pending } = fixture(t), [first] = sockets;
  first.open(); first.peerClose(code);
  assert.deepEqual(wakes, [0, 0]);
  for (let i = 0; i < 4; i++) link.start();
  advance(499); assert.equal(sockets.length, 1);
  advance(1); assert.equal(sockets.length, 2);
  first.message('changed'); first.error();
  assert.deepEqual(wakes, [0, 0]);
  sockets[1].error();
  advance(999); assert.equal(sockets.length, 2);
  advance(1); assert.equal(sockets.length, 3);
  sockets[2].open(); sockets[2].peerClose(4408);
  advance(120_000); link.start();
  assert.equal(sockets.length, 3);
  assert.equal(pending.size, 0);
});

test('a receiver reclaims a replaced connection with jitter inside the same three-attempt budget', t => {
  const { sockets, wakes, advance, pending } = fixture(t, { reclaimReplaced: true });
  sockets[0].open(); sockets[0].peerClose(4409);
  assert.deepEqual(wakes, [0, 0]);
  advance(499); assert.equal(sockets.length, 1);
  advance(1); assert.equal(sockets.length, 2);
  sockets[1].open(); sockets[1].peerClose(4409);
  advance(999); assert.equal(sockets.length, 2);
  advance(1); assert.equal(sockets.length, 3);
  sockets[2].peerClose(4409);
  advance(120_000);
  assert.equal(sockets.length, 3);
  assert.equal(pending.size, 0);
});

test('a retry the gate skips stays owed and resumes on start with its attempt count and retry deadline', t => {
  let allowed = true;
  const gates = [];
  const { link, sockets, advance, pending } = fixture(t, { canConnect: retrying => { gates.push(retrying); return allowed; } });
  sockets[0].error();
  allowed = false;
  advance(500);
  assert.equal(sockets.length, 1);
  assert.equal(pending.size, 0);
  link.start();
  assert.equal(sockets.length, 1);
  allowed = true;
  link.deferRetriesUntil(2_000);
  link.start(); link.start();
  advance(1_499); assert.equal(sockets.length, 1);
  advance(1); assert.equal(sockets.length, 2);
  assert.deepEqual(gates, [false, true, true, true]);
  sockets[1].error();
  advance(999); assert.equal(sockets.length, 2);
  advance(1); assert.equal(sockets.length, 3);
  sockets[2].error();
  link.start(); advance(120_000); link.start();
  assert.equal(sockets.length, 3);
  assert.equal(pending.size, 0);
});

test('a stalled handshake times out and the reconnect honors a later HTTP retry deadline', t => {
  const { link, sockets, wakes, advance } = fixture(t);
  advance(14_999); assert.deepEqual(wakes, []);
  advance(1);
  assert.equal(sockets[0].closes, 1);
  assert.deepEqual(wakes, [15_000]);
  link.deferRetriesUntil(27_000);
  advance(11_999); assert.equal(sockets.length, 1);
  advance(1); assert.equal(sockets.length, 2);
});

for (const open of [false, true]) test(`abort closes a ${open ? 'healthy' : 'connecting'} transport and drops later events`, t => {
  const controller = new AbortController();
  const { link, sockets, wakes, advance, pending } = fixture(t, { signal: controller.signal }), [ws] = sockets;
  if (open) ws.open();
  controller.abort(); link.stop();
  ws.open(); ws.message('changed'); ws.error(); ws.peerClose(4409);
  link.start(); advance(120_000);
  assert.equal(ws.closes, 1);
  assert.equal(link.healthy, false);
  assert.equal(sockets.length, 1);
  assert.equal(pending.size, 0);
  assert.deepEqual(wakes, open ? [0] : []);
});

test('native upgrade sends Authorization, reports a private close, and refuses a rejected handshake and redirect', { timeout: 5_000 }, async t => {
  const credential = 'synthetic-fixture';
  const server = createServer(), wires = new Set(), requests = [];
  let response = 'upgrade';
  server.on('request', (request, reply) => {
    requests.push({ path: request.url });
    reply.writeHead(400).end();
  });
  server.on('connection', wire => {
    wires.add(wire);
    wire.once('close', () => wires.delete(wire));
  });
  server.on('upgrade', (request, wire) => {
    requests.push({ path: request.url, authorized: request.headers.authorization === `Bearer ${credential}` });
    if (response === 'reject') {
      wire.end('HTTP/1.1 401 Unauthorized\r\nRetry-After: 9\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      return;
    }
    if (response === 'redirect') {
      wire.end('HTTP/1.1 307 Temporary Redirect\r\nLocation: /redirected\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      return;
    }
    const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    const headers = Buffer.from(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const close = Buffer.from([0x88, 2, 0, 0]);
    close.writeUInt16BE(4403, 2);
    wire.once('data', () => wire.end());
    wire.write(Buffer.concat([headers, close]));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    const closed = new Promise(resolve => server.close(resolve));
    for (const wire of wires) wire.destroy();
    assert.equal(await closed, undefined);
  });
  const relay = createRelayClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, token: credential });
  const ws = relay.openSocket(), events = [];
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', () => events.push('open'));
    ws.addEventListener('close', ({ code }) => { events.push(code); resolve(); });
    ws.addEventListener('error', () => reject(new Error('upgrade failed')));
  });
  assert.deepEqual(events, ['open', 4403]);
  for (const mode of ['reject', 'redirect']) {
    response = mode;
    const denied = relay.openSocket();
    await new Promise((resolve, reject) => {
      denied.addEventListener('open', () => reject(new Error('upgrade unexpectedly succeeded')));
      denied.addEventListener('error', resolve, { once: true });
    });
    denied.close();
  }

  response = 'reject';
  const wake = Promise.withResolvers();
  const link = createRelaySocket({ connect: relay.openSocket, onWake: wake.resolve, timers: socketClock().timers });
  t.after(() => link.stop());
  link.start();
  assert.equal(await wake.promise, 'failure');
  assert.equal(link.healthy, false);
  assert.deepEqual(requests, Array(4).fill({ path: '/v1/socket', authorized: true }));
});
