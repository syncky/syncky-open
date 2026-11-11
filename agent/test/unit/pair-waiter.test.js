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
import { createThinPoller } from '../../src/thin-poller.js';
import { readHomeState, updateHomeState } from '../../src/home-state.js';
import { acquireHomeLock } from '../../src/protected-files.js';
import { maintainResponseWaits } from '../../src/response-waits.js';
import { keys } from '../support/thin-home.js';
import { createFakePhone } from '../support/fake-phone.js';
import { startRelayDouble } from '../support/relay-double.js';
import { runCli, tempHome, waitFor } from '../support/helpers.js';
import { b64uDecode } from '../../src/encoding.js';

test('waiter startup retries state renames before its first current pairing snapshot', async t => {
  const f = await fixture(t), started = await f.pairing.startPairing();
  let armed = false, writing = false, writes = 0;
  const openSync = fs.openSync;
  t.mock.method(fs, 'openSync', (...args) => {
    const fd = openSync(...args);
    if (armed && !writing && writes < 3 && args[0] === join(f.home, 'state.json')) {
      writing = true;
      try { updateHomeState(f.home, s => { s.transport.heartbeat_day = `receiver-${++writes}`; }); }
      finally { writing = false; }
    }
    return fd;
  });
  const result = await runCli(['--home', f.home, 'pair-waiter', started.pairing_id], {
    now: f.now, createPoller: options => { armed = true; return createThinPoller(options); },
    sleep: async () => { updateHomeState(f.home, s => { s.pairings[started.pairing_id].status = 'expired'; }); },
  });
  assert.equal(result.code, 0, result.stderr.trim());
  assert.match(result.stderr, /pair_waiter_started/); assert.match(result.stderr, /pair_waiter_finished/);
  assert.equal(writes, 3);
});

for (const stage of ['access maintenance', 'join', 'expiry']) test(`waiter startup retries a live state lock during ${stage}`, async t => {
  const f = await fixture(t), started = await f.pairing.startPairing({ read: ['steps'] });
  updateHomeState(f.home, s => {
    const row = s.pairings[started.pairing_id];
    if (stage === 'join') {
      s.members[keys.dev1.member_id] = { member_id: keys.dev1.member_id, public_key: keys.dev1.pk,
        role: 'device', state: 'joined', pairing_id: started.pairing_id };
      Object.assign(row, { status: 'completed', member_id: keys.dev1.member_id, public_key: keys.dev1.pk });
      Object.assign(row.access, { joined_at: f.now().toISOString(), deadline_at: new Date(f.now().getTime() + 900000).toISOString() });
    } else {
      row.status = 'expired';
      if (stage === 'expiry') row.access.state = 'cancelled';
    }
    maintainResponseWaits(s, f.now().getTime());
  });
  let lock, timer, receiver, stderr = '', released = false;
  const result = await runCli(['--home', f.home, 'pair-waiter', started.pairing_id], {
    now: f.now, createPoller: options => {
      lock = acquireHomeLock(f.home, 'state');
      timer = setTimeout(() => { lock.release(); released = true; }, 30);
      return createThinPoller(options);
    },
    stderr: { write(line) {
      stderr += line;
      if (JSON.parse(line).event === 'pair_waiter_started') receiver = acquireHomeLock(f.home, 'receiver');
    } },
    sleep: async ms => f.advance(ms),
  }).finally(() => { clearTimeout(timer); lock?.release(); receiver?.release(); });
  assert.equal(result.code, 0, stderr.trim()); assert.equal(released, true);
  assert.equal(readPairingFile(f.home), null);
  const state = readHomeState(f.home), row = state.pairings[started.pairing_id];
  if (stage === 'join') {
    assert.equal(row.status, 'completed'); assert.equal(row.access.state, 'awaiting');
    assert.ok(state.members[keys.dev1.member_id].pair_proof);
  } else { assert.equal(row.status, 'expired'); assert.equal(row.access.state, 'cancelled'); }
});

for (const command of ['pair', 'wait']) test(`scoped foreground ${command} returns confirmed with an awaiting notice at its timeout`, { timeout: 10000 }, async t => {
  const f = await fixture(t), phone = createFakePhone({ relayUrl: f.relay.url });
  if (command === 'wait') await f.pairing.startPairing({ read: ['steps'] });
  const at = f.now().getTime();
  let picked = false, sleeps = 0;
  const result = await runCli(['--home', f.home, command, '--timeout', '10',
    ...(command === 'pair' ? ['--read', 'steps', '--wait', '--json'] : [])], {
    now: f.now, sleep: async ms => {
      assert.ok(++sleeps <= 6, 'foreground wait must be bounded');
      f.advance(ms);
      if (!picked) {
        picked = true;
        await phone.pair(readPairingFile(f.home).uri); await phone.sendPairProof();
      }
    },
  });
  assert.equal(result.code, 0);
  const completed = JSON.parse(result.stdout.trim().split('\n').at(-1));
  assert.equal(completed.status, 'completed'); assert.equal(completed.member.state, 'confirmed');
  assert.equal(completed.member.pairing_access.state, 'awaiting');
  assert.match(completed.member.pairing_access.notice, /Pairing confirmed.*send --type access_request/);
  assert.ok(Date.parse(completed.member.pairing_access.deadline_at) > f.now().getTime());
  assert.equal(f.now().getTime(), at + 10000);
  assert.doesNotMatch(JSON.stringify(completed) + result.stderr, /"request_ref":|syncky:\/\/|https:\/\//);
  await phone.fetchCommands(); assert.ok(!phone.controlReceived.some(r => r.type === 'access_request'));
});

test('scoped waiter continues after proof until the held reply resolves without requesting access', async t => {
  const f = await fixture(t), started = await f.pairing.startPairing({ read: ['steps'], write: ['body_mass'] });
  const scope = readPairingFile(f.home).requested_scope, phone = createFakePhone({ relayUrl: f.relay.url });
  await phone.pair(started.uri); await phone.sendPairProof();
  let replied = false;
  const result = await runCli(['--home', f.home, 'pair-waiter', started.pairing_id], {
    now: f.now, sleep: async ms => {
      f.advance(ms);
      if (!replied && readHomeState(f.home).members[phone.memberId]?.state === 'confirmed') {
        replied = true;
        await phone.postEnvelope(await f.runtime.transport.sealMessage({ hubId: phone.hubId, from: phone.memberId,
          senderPrivateKey: phone.keys.privateKey, recipients: [{ memberId: phone.agentMemberId, publicKey: b64uDecode(phone.agentPublicKey) }],
          innerText: JSON.stringify({ v: 1, type: 'access_reply', request_ref: scope.request_ref, decided_at: f.now().toISOString(),
            outcome: 'resolved', read: [{ type: 'steps', outcome: 'declined' }], write: [{ type: 'body_mass', outcome: 'needs_health_settings' }] }) }));
      }
    },
  });
  assert.equal(result.code, 0); assert.equal(replied, true);
  assert.equal(readHomeState(f.home).pairings[started.pairing_id].access.state, 'resolved');
  await phone.fetchCommands(); assert.ok(!phone.controlReceived.some(r => r.type === 'access_request'));
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(scope.request_ref));
});

test('scoped waiter reconciles a timely join first observed after link expiry and restart', async t => {
  const f = await fixture(t), started = await f.pairing.startPairing({ read: ['steps'] });
  const scope = readPairingFile(f.home).requested_scope, phone = createFakePhone({ relayUrl: f.relay.url });
  await phone.pair(started.uri);
  await phone.postEnvelope(await f.runtime.transport.sealMessage({ hubId: phone.hubId, from: phone.memberId,
    senderPrivateKey: phone.keys.privateKey, recipients: [{ memberId: phone.agentMemberId, publicKey: b64uDecode(phone.agentPublicKey) }],
    innerText: JSON.stringify({ v: 1, type: 'access_reply', request_ref: scope.request_ref, decided_at: f.now().toISOString(),
      outcome: 'resolved', read: [{ type: 'steps', outcome: 'declined' }], write: [] }) }));
  await phone.sendPairProof();
  f.advance(Date.parse(started.expires_at) + 5000 - f.now().getTime());
  const result = await runCli(['--home', f.home, 'pair-waiter', started.pairing_id], { now: f.now, sleep: async ms => f.advance(ms) });
  assert.equal(result.code, 0); assert.match(result.stderr, /pair_waiter_finished/);
  const row = readHomeState(f.home).pairings[started.pairing_id];
  assert.equal(row.status, 'completed'); assert.equal(row.access.state, 'resolved');
  assert.equal(readHomeState(f.home).members[phone.memberId].state, 'confirmed');
  assert.equal(readPairingFile(f.home), null);
});

test('old phone leaves a durable no-reply notice at the post-confirmation deadline across waiter restarts', async t => {
  const f = await fixture(t), started = await f.pairing.startPairing({ read: ['steps'] });
  const phone = createFakePhone({ relayUrl: f.relay.url }); await phone.pair(started.uri); await phone.sendPairProof();
  await f.pairing.refreshPairing(started.pairing_id); await f.runtime.poller.once(); await f.runtime.outbox.flush();
  const access = readHomeState(f.home).pairings[started.pairing_id].access;
  f.advance(Date.parse(started.expires_at) + 61000 - f.now().getTime());
  const result = await runCli(['--home', f.home, 'pair-waiter', started.pairing_id], { now: f.now, sleep: async ms => f.advance(ms) });
  assert.equal(result.code, 0); assert.equal(f.now().getTime(), Date.parse(access.deadline_at));
  const member = f.runtime.status().members.find(m => m.member_id === phone.memberId);
  assert.equal(member.pairing_access.state, 'no_reply'); assert.equal(member.scope, null);
  assert.match(member.pairing_access.notice, /older app.*send --type access_request/);
  await phone.fetchCommands(); assert.deepEqual(phone.controlReceived.map(r => r.type), ['confirmed', 'agent_info']);
});

test('scoped waiter hands off to a continuous receiver without losing the expected reply', async t => {
  const f = await fixture(t), started = await f.pairing.startPairing({ read: ['steps'] });
  const phone = createFakePhone({ relayUrl: f.relay.url }); await phone.pair(started.uri); await phone.sendPairProof();
  let receiver, sleeps = 0;
  try {
    const result = await runCli(['--home', f.home, 'pair-waiter', started.pairing_id], { now: f.now, sleep: async ms => {
      if (++sleeps > 1) throw Error('waiter did not yield');
      f.advance(ms); receiver = acquireHomeLock(f.home, 'receiver');
    } });
    assert.equal(result.code, 0); assert.equal(sleeps, 1);
    assert.equal(readHomeState(f.home).pairings[started.pairing_id].access.state, 'awaiting');
    assert.equal(readHomeState(f.home).members[phone.memberId].state, 'confirmed');
  } finally { receiver?.release(); }
});

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
  const posts = [], pendingTimers = new Map(), timers = {
    setTimeout(callback, ms) {
      const timer = Symbol();
      pendingTimers.set(timer, { callback, at: f.now().getTime() + ms });
      return timer;
    },
    clearTimeout: timer => pendingTimers.delete(timer),
  };
  const result = await runCli(['--home', f.home, 'pair-waiter', started.pairing_id], {
    now: f.now, timers, sleep: async ms => {
      f.advance(ms);
      for (const [timer, { callback, at }] of pendingTimers) if (at <= f.now().getTime()) { pendingTimers.delete(timer); callback(); }
    }, fetch: (url, options) => {
      if (options.method === 'POST' && new URL(url).pathname === '/v1/messages'
        && JSON.parse(options.body).msg_id === f.runtime.outbox.receipts().find(e => e.type === 'confirmed')?.msg_id) {
        posts.push({ at: f.now().getTime(), body: options.body });
        if (posts.length <= 6) {
          // Synthetic replies starve real socket timers while the fake clock advances.
          f.relay.failNext('postMessage', status, { 'Retry-After': '17' });
        }
      }
      return fetch(url, options);
    },
  });
  assert.equal(result.code, 0); assert.match(result.stderr, /pair_waiter_finished/);
  const receipt = f.runtime.outbox.receipts().find(e => e.type === 'confirmed');
  assert.equal(receipt.state, 'sent'); assert.equal(receipt.attempts, 7, JSON.stringify({ posts: posts.map(p => p.at), receipt }));
  assert.equal(posts.length, 7); assert.equal(pendingTimers.size, 0);
  assert.equal(f.relay.state.requests.filter(r => r.route === 'postMessage' && JSON.parse(r.body).msg_id === receipt.msg_id).length, 7);
  for (let n = 1; n <= 6; n++) {
    assert.equal(posts[n].at - posts[n - 1].at, status === 'reset' ? Math.min(60000, 1000 * 2 ** n) : 17000);
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
  const entered = Promise.withResolvers(), cycleTimers = []; let polls = 0;
  const setCycleTimer = (abort, ms) => { cycleTimers.push({ abort, ms }); };
  const waiter = runCli(['--home', f.home, 'pair-waiter', started.pairing_id], {
    now: f.now, sleep: async ms => f.advance(ms), createPoller: options => createThinPoller({ ...options, setCycleTimer }), fetch: (url, options) => {
      if (options.method === 'GET' && new URL(url).pathname === '/v1/messages' && !polls++) {
        entered.resolve();
        return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
      }
      return fetch(url, options);
    },
  });
  await entered.promise; assert.equal(cycleTimers.at(-1).ms, 15000); f.advance(15000); cycleTimers.at(-1).abort();
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

for (const scoped of [false, true]) test(`${scoped ? 'scoped' : 'legacy'} waiter exits at the relay expiry plus 60 seconds rather than restarting the TTL`, async t => {
  const f = await fixture(t), started = await f.pairing.startPairing(scoped ? { read: ['steps'] } : {}), sleeps = [];
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
