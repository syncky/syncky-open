import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { commandNames, generalHelp } from '../../src/cli.js';
import { createPairingService, readPairingFile } from '../../src/pairing.js';
import { createRuntime } from '../../src/runtime.js';
import { readHomeState, updateHomeState } from '../../src/home-state.js';
import { acquireHomeLock } from '../../src/protected-files.js';
import { createFakePhone } from '../support/fake-phone.js';
import { startRelayDouble } from '../support/relay-double.js';
import { runCli, tempHome, waitFor } from '../support/helpers.js';

async function fixture(t) {
  const tmp = tempHome(), relay = await startRelayDouble({ invite: 'waiter-fixture' });
  t.after(async () => { await relay.stop(); tmp.cleanup(); });
  assert.equal((await runCli(['--home', tmp.home, 'init', '--name', 'Lab', '--relay', relay.url], { env: { SYNCKY_INVITE: 'waiter-fixture' } })).code, 0);
  let at = Date.now();
  const now = () => new Date(at), runtime = createRuntime({ home: tmp.home, env: {}, now });
  const pairing = createPairingService({ home: tmp.home, relay: runtime.relay, publicKey: readHomeState(tmp.home).identity.public_key, agentName: 'Lab', now });
  return { ...tmp, relay, pairing, runtime, now, advance: ms => { at += ms; } };
}

for (const json of [false, true]) test(`v2 pair spawns one detached waiter after ${json ? 'JSON' : 'terminal'} output`, async t => {
  const f = await fixture(t), calls = [], env = { ...process.env, SYNCKY_LOG_LEVEL: 'debug' };
  const result = await runCli(['--home', relative(process.cwd(), f.home), 'pair', ...(json ? ['--json'] : [])], {
    env, spawn: (command, args, options) => {
      assert.ok(readPairingFile(f.home));
      assert.equal(options.stdio[0], 'ignore'); assert.equal(options.stdio[1], 'ignore');
      fs.writeSync(options.stdio[2], 'fixture metadata\n');
      const child = new EventEmitter(); child.unref = () => { calls.push('unref'); };
      calls.push({ command, args, options }); return child;
    },
  });
  assert.equal(result.code, 0); assert.equal(calls.length, 2); assert.equal(calls[1], 'unref');
  const { command, args, options } = calls[0], doc = readPairingFile(f.home);
  assert.equal(command, process.execPath);
  assert.deepEqual(args, [process.argv[1], '--home', f.home, 'pair-waiter', doc.pairing_id]);
  assert.equal(options.detached, true); assert.equal(options.windowsHide, true); assert.equal(options.env, env);
  assert.throws(() => fs.fstatSync(options.stdio[2]), { code: 'EBADF' });
  assert.equal(fs.statSync(join(f.home, 'pair-waiter.log')).mode & 0o777, 0o600);
  assert.ok(result.stdout.includes(doc.uri));
  if (json) assert.deepEqual(Object.keys(JSON.parse(result.stdout)).sort(), ['code', 'expires_at', 'pairing_id', 'uri', 'version']);
  else assert.ok(result.stdout.startsWith(doc.uri + '\n') && result.stdout.includes('Pairing code: '));
});

for (const mode of ['v1', 'wait', 'receiver']) test(`pair does not spawn a waiter for ${mode}`, async t => {
  const f = await fixture(t), lock = mode === 'receiver' ? acquireHomeLock(f.home, 'receiver') : null;
  let calls = 0, picked = false;
  try {
    const result = await runCli(['--home', f.home, 'pair', '--json', ...(mode === 'v1' ? ['--v1'] : mode === 'wait' ? ['--wait', '--timeout', '10'] : [])], {
      now: f.now, spawn: () => { calls++; throw Error('unexpected spawn'); }, sleep: async ms => {
        f.advance(ms);
        if (!picked) {
          picked = true; const phone = createFakePhone({ relayUrl: f.relay.url });
          await phone.pair(readPairingFile(f.home).uri); await phone.sendPairProof();
        }
      },
    });
    assert.equal(result.code, 0); assert.equal(calls, 0);
    assert.equal(fs.existsSync(join(f.home, 'pair-waiter.log')), false);
    if (mode === 'wait') assert.equal(JSON.parse(result.stdout.trim().split('\n').at(-1)).member.state, 'confirmed');
  } finally { lock?.release(); }
});

test('pair forwards relay and URL scheme overrides to the detached waiter', async t => {
  const f = await fixture(t), calls = [];
  const result = await runCli(['--home', f.home, '--relay', f.relay.url, '--url-scheme', 'syncky-dev', 'pair', '--json'], {
    env: { SYNCKY_RELAY_URL: 'http://127.0.0.1:1' }, spawn: (command, args) => {
      calls.push(args); const child = new EventEmitter(); child.unref = () => {}; return child;
    },
  });
  assert.equal(result.code, 0); assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [process.argv[1], '--home', f.home, '--relay', f.relay.url, '--url-scheme', 'syncky-dev', 'pair-waiter', JSON.parse(result.stdout).pairing_id]);
  const phone = createFakePhone({ relayUrl: f.relay.url });
  await phone.pair(JSON.parse(result.stdout).uri); await phone.sendPairProof();
  const waiter = await runCli(calls[0].slice(1), { env: { SYNCKY_RELAY_URL: 'http://127.0.0.1:1' }, now: f.now, sleep: async ms => f.advance(ms) });
  assert.equal(waiter.code, 0); assert.equal(readHomeState(f.home).members[phone.memberId].state, 'confirmed');
});

for (const asyncFailure of [false, true]) test(`pair preserves success on ${asyncFailure ? 'asynchronous' : 'synchronous'} spawn failure`, async t => {
  const f = await fixture(t);
  const result = await runCli(['--home', f.home, 'pair', '--json'], { spawn: () => {
    const error = Error('private spawn failure');
    if (!asyncFailure) throw error;
    const child = new EventEmitter(); child.unref = () => queueMicrotask(() => child.emit('error', error)); return child;
  } });
  assert.equal(result.code, 0); assert.match(result.stderr, /pair_waiter_spawn_failed/);
  assert.doesNotMatch(result.stderr, /private spawn failure/); assert.equal(JSON.parse(result.stdout).version, 2);
});

test('pair-waiter stays out of public help and requires exactly one pairing id', async () => {
  assert.ok(!commandNames().includes('pair-waiter')); assert.doesNotMatch(generalHelp(), /pair-waiter/);
  for (const args of [['help', 'pair-waiter'], ['pair-waiter'], ['pair-waiter', 'bad'], ['pair-waiter', 'p_' + 'A'.repeat(22), 'extra']]) {
    assert.equal((await runCli(args)).code, 1);
  }
});

test('waiter confirms a later phone pick and exits without a further command', async t => {
  const f = await fixture(t), started = await f.pairing.startPairing(), phone = createFakePhone({ relayUrl: f.relay.url });
  let picked = false;
  const result = await runCli(['--home', f.home, 'pair-waiter', started.pairing_id], {
    now: f.now, sleep: async ms => { f.advance(ms); if (!picked) { picked = true; await phone.pair(started.uri); await phone.sendPairProof(); } },
  });
  assert.equal(result.code, 0); assert.equal(result.stdout, '');
  assert.equal(readHomeState(f.home).members[phone.memberId].state, 'confirmed');
  const polls = f.relay.state.requests.filter(r => r.route === 'getMessages').length;
  assert.equal(polls, 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.relay.state.requests.filter(r => r.route === 'getMessages').length, polls);
  await phone.fetchCommands(); assert.deepEqual(phone.controlReceived.map(r => r.type), ['confirmed', 'agent_info']);
});

test('re-pair during an older waiter cycle spawns a replacement waiter that confirms the new phone', async t => {
  const f = await fixture(t), started = await f.pairing.startPairing(), firstPhone = createFakePhone({ relayUrl: f.relay.url });
  await firstPhone.pair(started.uri); await firstPhone.sendPairProof();
  const gate = f.relay.gateNext('getMessages'), calls = [];
  const older = runCli(['--home', f.home, 'pair-waiter', started.pairing_id], { now: f.now, sleep: async ms => f.advance(ms) });
  await gate.entered;
  try {
    const parent = await runCli(['--home', f.home, 'pair', '--json'], { now: f.now, spawn: (command, args) => {
      calls.push(args); const child = new EventEmitter(); child.unref = () => {}; return child;
    } });
    assert.equal(parent.code, 0); assert.equal(calls.length, 1);
    const replacement = JSON.parse(parent.stdout), phone = createFakePhone({ relayUrl: f.relay.url });
    assert.notEqual(replacement.pairing_id, started.pairing_id);
    await phone.pair(replacement.uri); await phone.sendPairProof();
    let retries = 0;
    const waiter = await runCli(calls[0].slice(1), { now: f.now, sleep: async ms => {
      retries++; gate.release(); assert.equal((await older).code, 0); f.advance(ms);
    } });
    assert.equal(waiter.code, 0); assert.match(waiter.stderr, /pair_waiter_started/);
    assert.match(waiter.stderr, /pair_waiter_finished/); assert.ok(retries > 0);
    assert.equal(readHomeState(f.home).members[phone.memberId].state, 'confirmed');
  } finally { gate.release(); await older; }
});

for (const once of [false, true]) test(`receive${once ? ' --once' : ''} waits for an in-flight waiter cycle and takes over the receiver lease`, async t => {
  const f = await fixture(t), started = await f.pairing.startPairing(), phone = createFakePhone({ relayUrl: f.relay.url });
  await phone.pair(started.uri); await phone.sendPairProof();
  const gate = f.relay.gateNext('getMessages'), controller = new AbortController();
  const waiter = runCli(['--home', f.home, 'pair-waiter', started.pairing_id], { now: f.now, sleep: async ms => f.advance(ms) });
  await gate.entered;
  let retries = 0;
  try {
    const result = await runCli(['--home', f.home, 'receive', ...(once ? ['--once'] : [])], { now: f.now, signal: controller.signal, sleep: async ms => {
      f.advance(ms);
      if (!retries++) { gate.release(); assert.equal((await waiter).code, 0); }
      else controller.abort();
    } });
    assert.equal(result.code, 0); assert.match(result.stderr, once ? /receive_cycle/ : /receive_ready/); assert.ok(retries >= (once ? 1 : 2));
    assert.equal(readHomeState(f.home).members[phone.memberId].state, 'confirmed');
  } finally { gate.release(); controller.abort(); await waiter; }
});

for (const once of [false, true]) test(`receive${once ? ' --once' : ''} keeps lease acquisition bounded`, async t => {
  const f = await fixture(t), lock = acquireHomeLock(f.home, 'receiver'), sleeps = [];
  try {
    const result = await runCli(['--home', f.home, 'receive', ...(once ? ['--once'] : [])], { sleep: async ms => { sleeps.push(ms); } });
    assert.equal(result.code, 4); assert.match(result.stderr, /home_locked/);
    assert.deepEqual(sleeps, Array(200).fill(100));
  } finally { lock.release(); }
});

for (const bytes of [256 * 1024, 256 * 1024 + 1]) test(`pair caps its existing ${bytes}-byte waiter log before spawning`, async t => {
  const f = await fixture(t), path = join(f.home, 'pair-waiter.log');
  fs.writeFileSync(path, Buffer.alloc(bytes, 120), { mode: 0o600 });
  let spawns = 0;
  const result = await runCli(['--home', f.home, 'pair', '--json'], { spawn: (command, args, options) => {
    spawns++; assert.equal(fs.fstatSync(options.stdio[2]).size, bytes > 256 * 1024 ? 0 : bytes);
    fs.writeSync(options.stdio[2], 'metadata\n');
    const child = new EventEmitter(); child.unref = () => {}; return child;
  } });
  assert.equal(result.code, 0); assert.equal(spawns, 1);
  assert.equal(fs.statSync(path).size, (bytes > 256 * 1024 ? 0 : bytes) + 9);
  assert.equal(fs.statSync(path).mode & 0o777, 0o600);
});

for (const status of [503, 429, 'reset']) test(`waiter retries confirmation delivery after repeated ${status} failures`, async t => {
  const f = await fixture(t), started = await f.pairing.startPairing(), phone = createFakePhone({ relayUrl: f.relay.url });
  await phone.pair(started.uri); await phone.sendPairProof();
  const posts = [];
  const result = await runCli(['--home', f.home, 'pair-waiter', started.pairing_id], {
    now: f.now, sleep: async ms => f.advance(ms), fetch: (url, options) => {
      if (options.method === 'POST' && new URL(url).pathname === '/v1/messages'
        && JSON.parse(options.body).msg_id === f.runtime.outbox.receipts().find(e => e.type === 'confirmed')?.msg_id) {
        posts.push({ at: f.now().getTime(), body: options.body });
        if (posts.length <= 6) {
          if (status === 'reset') throw new TypeError('fixture network failure');
          return Promise.resolve(Response.json({ error: status === 429 ? 'rate_limited' : 'internal_error' }, { status, headers: { 'Retry-After': '17' } }));
        }
      }
      return fetch(url, options);
    },
  });
  assert.equal(result.code, 0); assert.match(result.stderr, /pair_waiter_finished/);
  const receipt = f.runtime.outbox.receipts().find(e => e.type === 'confirmed');
  assert.equal(receipt.state, 'sent'); assert.equal(receipt.attempts, 7);
  for (let n = 1; n <= 6; n++) {
    assert.ok(posts[n].at - posts[n - 1].at >= (status === 'reset' ? Math.min(60000, 1000 * 2 ** n) : 17000));
    assert.ok(posts[n].body === posts[0].body, 'confirmation ciphertext changed during retry');
  }
  await phone.fetchCommands(); assert.deepEqual(phone.controlReceived.map(r => r.type).sort(), ['agent_info', 'confirmed']);
});

test('waiter delivers a locally confirmed member with a pending confirmation receipt', async t => {
  const f = await fixture(t), started = await f.pairing.startPairing(), phone = createFakePhone({ relayUrl: f.relay.url });
  await phone.pair(started.uri); await phone.sendPairProof(); await f.runtime.poller.once();
  assert.equal(f.runtime.outbox.receipts().find(e => e.type === 'confirmed').state, 'pending');
  const result = await runCli(['--home', f.home, 'pair-waiter', started.pairing_id], { now: f.now, sleep: async ms => f.advance(ms) });
  assert.equal(result.code, 0); assert.equal(f.runtime.outbox.receipts().find(e => e.type === 'confirmed').state, 'sent');
  await phone.fetchCommands(); assert.deepEqual(phone.controlReceived.map(r => r.type), ['confirmed', 'agent_info']);
});

test('waiter retries failed confirmation delivery only until its original deadline', async t => {
  const f = await fixture(t), started = await f.pairing.startPairing(), phone = createFakePhone({ relayUrl: f.relay.url });
  await phone.pair(started.uri); await phone.sendPairProof();
  f.relay.failNext('postMessage', 503, { 'Retry-After': '1000' });
  const result = await runCli(['--home', f.home, 'pair-waiter', started.pairing_id], { now: f.now, sleep: async ms => f.advance(ms) });
  assert.equal(result.code, 0); assert.match(result.stderr, /pair_waiter_stopped/);
  assert.equal(f.now().getTime(), Date.parse(started.expires_at) + 60000);
  const receipt = f.runtime.outbox.receipts().find(e => e.type === 'confirmed');
  assert.equal(receipt.state, 'pending'); assert.equal(receipt.attempts, 1);
});

for (const status of [503, 429, 'reset']) test(`waiter recovers from a post-join ${status} polling failure`, async t => {
  const f = await fixture(t), started = await f.pairing.startPairing(), phone = createFakePhone({ relayUrl: f.relay.url });
  await phone.pair(started.uri); await phone.sendPairProof();
  f.relay.failNext('getMessages', status, { 'Retry-After': '17' });
  const polls = [];
  const result = await runCli(['--home', f.home, 'pair-waiter', started.pairing_id], {
    now: f.now, sleep: async ms => f.advance(ms), fetch: (url, options) => {
      if (options.method === 'GET' && new URL(url).pathname === '/v1/messages') {
        assert.equal(readHomeState(f.home).members[phone.memberId].state, 'joined'); polls.push(f.now().getTime());
      }
      return fetch(url, options);
    },
  });
  assert.equal(result.code, 0); assert.match(result.stderr, /pair_waiter_finished/);
  assert.equal(readHomeState(f.home).members[phone.memberId].state, 'confirmed');
  assert.equal(polls.length, 2); assert.ok(polls[1] - polls[0] >= (status === 429 ? 17000 : 25000));
  await phone.fetchCommands(); assert.deepEqual(phone.controlReceived.map(r => r.type), ['confirmed', 'agent_info']);
});

test('waiter stops early when post-join polling revokes authentication', async t => {
  const f = await fixture(t), started = await f.pairing.startPairing(), phone = createFakePhone({ relayUrl: f.relay.url });
  await phone.pair(started.uri); await phone.sendPairProof();
  f.relay.failNext('getMessages', 401);
  const result = await runCli(['--home', f.home, 'pair-waiter', started.pairing_id], { now: f.now, sleep: () => assert.fail('fatal error must not retry') });
  assert.equal(result.code, 0); assert.match(result.stderr, /pair_waiter_stopped/);
  assert.equal(readHomeState(f.home).transport.hub_revoked, true);
});

test('waiter retries after the bounded receive cycle aborts a stalled poll', async t => {
  const f = await fixture(t), started = await f.pairing.startPairing(), phone = createFakePhone({ relayUrl: f.relay.url });
  await phone.pair(started.uri); await phone.sendPairProof();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const entered = Promise.withResolvers(); let polls = 0;
  const waiter = runCli(['--home', f.home, 'pair-waiter', started.pairing_id], {
    now: f.now, sleep: async ms => f.advance(ms), fetch: (url, options) => {
      if (options.method === 'GET' && new URL(url).pathname === '/v1/messages' && !polls++) {
        entered.resolve();
        return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
      }
      return fetch(url, options);
    },
  });
  await entered.promise; f.advance(15000); t.mock.timers.tick(15000);
  const result = await waiter;
  assert.equal(result.code, 0); assert.equal(polls, 2); assert.match(result.stderr, /pair_waiter_finished/);
  assert.equal(f.runtime.outbox.receipts().find(e => e.type === 'confirmed').state, 'sent');
});

for (const command of ['wait', 'pair']) test(`foreground ${command} preserves post-join relay error behavior`, async t => {
  const f = await fixture(t), phone = createFakePhone({ relayUrl: f.relay.url });
  if (command === 'wait') await f.pairing.startPairing();
  let picked = false;
  const result = await runCli(['--home', f.home, command, ...(command === 'pair' ? ['--wait', '--json'] : [])], {
    now: f.now, sleep: async ms => {
      f.advance(ms);
      if (!picked) { picked = true; await phone.pair(readPairingFile(f.home).uri); await phone.sendPairProof(); f.relay.failNext('getMessages', 503); }
    },
  });
  assert.equal(result.code, 2); assert.equal(readHomeState(f.home).members[phone.memberId].state, 'joined');
});

test('waiter exits at the relay expiry plus 60 seconds rather than restarting the TTL', async t => {
  const f = await fixture(t), started = await f.pairing.startPairing(), sleeps = [];
  f.advance(Date.parse(started.expires_at) + 59000 - f.now().getTime());
  const result = await runCli(['--home', f.home, 'pair-waiter', started.pairing_id], { now: f.now, sleep: async ms => { sleeps.push(ms); f.advance(ms); } });
  assert.equal(result.code, 0); assert.deepEqual(sleeps, [1000]);
  assert.equal(f.now().getTime(), Date.parse(started.expires_at) + 60000);
  const requests = f.relay.state.requests.length;
  assert.equal((await runCli(['--home', f.home, 'pair-waiter', started.pairing_id], { now: f.now })).code, 0);
  assert.equal(f.relay.state.requests.length, requests);
});

test('waiter accepts proof during the short grace after a timely join', async t => {
  const f = await fixture(t), started = await f.pairing.startPairing(), phone = createFakePhone({ relayUrl: f.relay.url });
  await phone.pair(started.uri); await f.pairing.refreshPairing(started.pairing_id); await phone.sendPairProof();
  f.advance(Date.parse(started.expires_at) + 5000 - f.now().getTime());
  const result = await runCli(['--home', f.home, 'pair-waiter', started.pairing_id], { now: f.now });
  assert.equal(result.code, 0); assert.equal(readHomeState(f.home).members[phone.memberId].state, 'confirmed');
});

test('waiter exits when a newer pair replaces its id', async t => {
  const f = await fixture(t), started = await f.pairing.startPairing(); let sleeps = 0;
  const result = await runCli(['--home', f.home, 'pair-waiter', started.pairing_id], {
    now: f.now, sleep: async ms => { f.advance(ms); sleeps++; await f.pairing.startPairing(); },
  });
  assert.equal(result.code, 0); assert.equal(sleeps, 1);
  assert.notEqual(readPairingFile(f.home).pairing_id, started.pairing_id);
  const requests = f.relay.state.requests.length;
  assert.equal((await runCli(['--home', f.home, 'pair-waiter', started.pairing_id])).code, 0);
  assert.equal(f.relay.state.requests.length, requests);
});

test('waiter is an immediate no-op when a receiver owns the home', async t => {
  const f = await fixture(t), started = await f.pairing.startPairing(), lock = acquireHomeLock(f.home, 'receiver');
  const requests = f.relay.state.requests.length;
  try {
    const result = await runCli(['--home', f.home, 'pair-waiter', started.pairing_id], { sleep: () => { throw Error('unexpected sleep'); } });
    assert.equal(result.code, 0); assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
    assert.equal(f.relay.state.requests.length, requests);
  } finally { lock.release(); }
});

for (const terminal of ['confirmed', 'rejected', 'invalidated']) test(`waiter exits without relay calls when its member is already ${terminal}`, async t => {
  const f = await fixture(t), started = await f.pairing.startPairing(), phone = createFakePhone({ relayUrl: f.relay.url });
  await phone.pair(started.uri); await f.pairing.refreshPairing(started.pairing_id);
  if (terminal === 'rejected') await f.pairing.rejectMember(phone.memberId);
  else {
    await phone.sendPairProof(terminal === 'invalidated' ? { proof: Buffer.alloc(32).toString('base64url') } : {});
    await f.runtime.poller.once();
    if (terminal === 'confirmed') {
      await f.runtime.outbox.flush();
      assert.equal(f.runtime.outbox.receipts().find(e => e.type === 'confirmed').state, 'sent');
    }
  }
  let calls = 0;
  const result = await runCli(['--home', f.home, 'pair-waiter', started.pairing_id], {
    fetch: () => { calls++; throw Error('unexpected relay call'); }, sleep: () => { throw Error('unexpected sleep'); },
  });
  assert.equal(result.code, 0); assert.equal(calls, 0); assert.equal(result.stdout, '');
});

for (const invalid of [false, true]) test(`waiter exits successfully for ${invalid ? 'invalid proof' : 'expired pairing'}`, async t => {
  const f = await fixture(t), started = await f.pairing.startPairing();
  let phone;
  if (invalid) {
    phone = createFakePhone({ relayUrl: f.relay.url }); await phone.pair(started.uri); await phone.sendPairProof({ proof: Buffer.alloc(32).toString('base64url') });
  } else updateHomeState(f.home, s => { s.pairings[started.pairing_id].status = 'expired'; });
  const result = await runCli(['--home', f.home, 'pair-waiter', started.pairing_id], { now: f.now, sleep: async ms => f.advance(ms) });
  assert.equal(result.code, 0); assert.equal(result.stdout, '');
  if (invalid) assert.equal(readHomeState(f.home).members[phone.memberId].proof_invalidated, true);
});

test('real CLI leaves a detached waiter that confirms the phone and exits with a private metadata log', { timeout: 15000 }, async t => {
  const f = await fixture(t), cli = process.env.SYNCKY_AGENT_BIN ?? fileURLToPath(new URL('../../bin/syncky-agent.js', import.meta.url));
  const parent = spawn(process.execPath, [cli, '--home', f.home, 'pair', '--json'], { env: { ...process.env, SYNCKY_LOG_LEVEL: 'debug' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', waiterPid;
  parent.stdout.on('data', chunk => { stdout += chunk; }); parent.stderr.on('data', chunk => { stderr += chunk; });
  t.after(() => { parent.kill(); if (waiterPid) { try { process.kill(waiterPid); } catch {} } });
  const code = await new Promise((resolve, reject) => { parent.once('error', reject); parent.once('close', resolve); });
  assert.equal(code, 0);
  assert.ok(stderr.trim().split('\n').every(s => JSON.parse(s).event === 'relay_request'));
  const started = JSON.parse(stdout), credentials = readPairingFile(f.home), logPath = join(f.home, 'pair-waiter.log');
  await waitFor(() => {
    const entry = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(s => JSON.parse(s)).find(e => e.event === 'pair_waiter_started');
    waiterPid = entry?.pid; return waiterPid;
  });
  const phone = createFakePhone({ relayUrl: f.relay.url }); await phone.pair(started.uri); await phone.sendPairProof();
  await waitFor(() => readHomeState(f.home).members[phone.memberId]?.state === 'confirmed');
  await waitFor(() => { try { process.kill(waiterPid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } });
  waiterPid = undefined;
  const log = fs.readFileSync(logPath, 'utf8');
  assert.match(log, /pair_waiter_finished/); assert.equal(fs.statSync(logPath).mode & 0o777, 0o600);
  for (const secret of [credentials.pair_secret, credentials.pairing_token, started.uri, started.code]) assert.ok(!log.includes(secret), 'waiter log leaked a pairing credential');
  await phone.fetchCommands(); assert.deepEqual(phone.controlReceived.map(r => r.type), ['confirmed', 'agent_info']);
});
