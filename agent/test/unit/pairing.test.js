import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { AGENT_VERSION, createRuntime } from '../../src/runtime.js';
import { createPairingService, readPairingFile } from '../../src/pairing.js';
import { readHomeState } from '../../src/home-state.js';
import { createInbox } from '../../src/inbox.js';
import { createFakePhone } from '../support/fake-phone.js';
import { startRelayDouble } from '../support/relay-double.js';
import { runCli, tempHome } from '../support/helpers.js';
import { main } from '../../src/cli.js';
import { acquireHomeLock } from '../../src/protected-files.js';
import { RETRY_POLICY } from '../../src/relay-client.js';

async function fixture(t) {
  const tmp = tempHome(), relay = await startRelayDouble({ invite: 'pair-fixture' });
  t.after(async () => { await relay.stop(); tmp.cleanup(); });
  assert.equal((await runCli(['--home', tmp.home, 'init', '--name', 'Lab', '--relay', relay.url], { env: { SYNCKY_INVITE: 'pair-fixture' } })).code, 0);
  let at = Date.now(); const now = () => new Date(at);
  const runtime = createRuntime({ home: tmp.home, env: {}, now, flags: { "poll-interval": "300" } });
  const pairing = createPairingService({ home: tmp.home, relay: runtime.relay, publicKey: readHomeState(tmp.home).identity.public_key, agentName: 'Lab', now });
  return { ...tmp, relay, runtime, pairing, now, advance: (ms = 300000) => { at += ms; } };
}

for (const v1 of [true, false]) test(`registration, pair, hold, ${v1 ? 'fingerprint' : 'proof'}, confirmation and revocation keep raw history`, async t => {
  const f = await fixture(t), started = await f.pairing.startPairing({ v1 });
  assert.equal(fs.statSync(join(f.home, 'pairing.json')).mode & 0o777, 0o600);
  const phone = createFakePhone({ relayUrl: f.relay.url }); await phone.pair(started.uri);
  const completed = await f.pairing.refreshPairing(started.pairing_id); assert.equal(completed.status, 'completed');
  assert.ok(readPairingFile(f.home) === null, 'completed pairing credentials retained');
  assert.equal(f.pairing.currentPairing({ includeCompleted: true }).version, v1 ? 1 : 2);
  await phone.sendSync({ acks: [{ command_id: 'c_158', version: 1, status: 'applied' }] });
  await f.runtime.poller.once(); assert.equal(f.runtime.status().held, 1);
  assert.deepEqual(createInbox(f.home).read(), []);
  if (v1) {
    assert.throws(() => f.pairing.confirmWithFingerprint(phone.memberId, '0000'), { code: 'fingerprint_mismatch' });
    f.pairing.confirmWithFingerprint(phone.memberId, phone.fingerprint());
  } else { await phone.sendPairProof(); f.advance(); }
  await f.runtime.poller.once(); await f.runtime.outbox.flush();
  assert.equal(readHomeState(f.home).members[phone.memberId].state, 'confirmed');
  assert.ok(createInbox(f.home).read().some(r => r.type === 'sync'));
  await phone.fetchCommands(); assert.ok(phone.controlReceived.some(r => r.type === 'confirmed'));
  const agentInfo = phone.controlReceived.find(r => r.type === 'agent_info');
  assert.equal(agentInfo?.v, 1); assert.equal(agentInfo?.version, AGENT_VERSION);
  const before = createInbox(f.home).read(); await phone.revokeSelf(); f.advance(); await f.runtime.poller.once();
  assert.equal(readHomeState(f.home).members[phone.memberId].state, 'revoked');
  assert.deepEqual(createInbox(f.home).read(), before);
  assert.equal(f.pairing.forgetMember(phone.memberId).dry_run, true);
  f.pairing.forgetMember(phone.memberId, { yes: true }); assert.deepEqual(createInbox(f.home).read(), []);
  assert.equal(readHomeState(f.home).members[phone.memberId].state, 'revoked');
});

test('reject revokes only the untrusted member and discards held data without releasing it', async t => {
  const f = await fixture(t), started = await f.pairing.startPairing();
  const phone = createFakePhone({ relayUrl: f.relay.url }); await phone.pair(started.uri);
  await f.pairing.refreshPairing(started.pairing_id); await phone.sendSync({}); await f.runtime.poller.once();
  assert.equal(f.runtime.status().held, 1); await f.pairing.rejectMember(phone.memberId);
  assert.equal(f.runtime.status().held, 0); assert.deepEqual(createInbox(f.home).read(), []);
  await assert.rejects(phone.sendSync({}), { code: 'invalid_token' });
});

async function confirmedPhone(f) {
  const started = await f.pairing.startPairing({ v1: true });
  const phone = createFakePhone({ relayUrl: f.relay.url }); await phone.pair(started.uri);
  await f.pairing.refreshPairing(started.pairing_id);
  f.pairing.confirmWithFingerprint(phone.memberId, phone.fingerprint());
  return phone;
}

test('CLI revoke revokes a confirmed phone on the relay first, retains history, repeats and permits forget', async t => {
  const f = await fixture(t), phone = await confirmedPhone(f);
  await phone.sendControl({ type: 'future_echo' }); await f.runtime.poller.once();
  const history = createInbox(f.home).read(); assert.equal(history.length, 1);
  assert.throws(() => f.pairing.forgetMember(phone.memberId), { code: 'invalid_transition', message: /revoke <member_id>/ });
  let calls = 0;
  const result = await runCli(['--home', f.home, 'revoke', phone.memberId, '--json'], { fetch: (url, options) => {
    calls++;
    assert.equal(options.method, 'DELETE');
    assert.equal(new URL(url).pathname, `/v1/members/${phone.memberId}`);
    assert.equal(readHomeState(f.home).members[phone.memberId].state, 'confirmed');
    return fetch(url, options);
  } });
  assert.equal(result.code, 0, result.stderr); assert.equal(calls, 1);
  const revoked = JSON.parse(result.stdout);
  assert.equal(revoked.member.member_id, phone.memberId); assert.equal(revoked.member.state, 'revoked');
  assert.equal(revoked.state, 'revoked'); assert.equal(revoked.revoked_on_relay, true);
  assert.notEqual(f.relay.state.member(phone.memberId).revokedAt, null);
  assert.equal(readHomeState(f.home).members[phone.memberId].state, 'revoked');
  await assert.rejects(phone.sendControl({ type: 'future_echo' }), { code: 'invalid_token' });
  assert.deepEqual(createInbox(f.home).read(), history);
  const revokedAt = readHomeState(f.home).members[phone.memberId].revoked_at;
  const repeated = await runCli(['--home', f.home, 'revoke', phone.memberId]);
  assert.equal(repeated.code, 0, repeated.stderr);
  assert.equal(JSON.parse(repeated.stdout).revoked_on_relay, false);
  assert.equal(readHomeState(f.home).members[phone.memberId].revoked_at, revokedAt);
  const preview = await runCli(['--home', f.home, 'forget', phone.memberId]);
  assert.equal(preview.code, 0); assert.equal(JSON.parse(preview.stdout).dry_run, true);
  assert.equal(JSON.parse(preview.stdout).counts.inbox, 1); assert.deepEqual(createInbox(f.home).read(), history);
  const forgotten = await runCli(['--home', f.home, 'forget', phone.memberId, '--yes']);
  assert.equal(forgotten.code, 0); assert.equal(JSON.parse(forgotten.stdout).dry_run, false);
  assert.deepEqual(createInbox(f.home).read(), []);
  assert.equal(readHomeState(f.home).members[phone.memberId].state, 'revoked');
});

test('revoke reconciles a relay 404 while the phone is still confirmed locally', async t => {
  const f = await fixture(t), phone = await confirmedPhone(f);
  await phone.revokeSelf();
  assert.equal(readHomeState(f.home).members[phone.memberId].state, 'confirmed');
  const result = await f.pairing.revokeMember(phone.memberId);
  assert.equal(result.revoked_on_relay, false); assert.equal(result.member.state, 'revoked');
  assert.equal(readHomeState(f.home).members[phone.memberId].state, 'revoked');
});

for (const [status, code, exit] of [['reset', 'network_error', 2], [500, 'internal_error', 2], [401, 'invalid_token', 3]]) {
  test(`CLI revoke propagates relay ${status} without changing local state and can be retried`, async t => {
    const f = await fixture(t), phone = await confirmedPhone(f);
    const before = readHomeState(f.home);
    for (let i = 0; i < (status === 401 ? 1 : RETRY_POLICY.maxAttempts); i++) f.relay.failNext('revokeMember', status);
    const result = await runCli(['--home', f.home, 'revoke', phone.memberId]);
    assert.equal(result.code, exit); assert.equal(result.stdout, '');
    assert.equal(JSON.parse(result.stderr.trim().split('\n').at(-1)).error, code);
    assert.deepEqual(readHomeState(f.home), before);
    assert.equal(f.relay.state.member(phone.memberId).revokedAt, null);
    const retried = await runCli(['--home', f.home, 'revoke', phone.memberId]);
    assert.equal(retried.code, 0); assert.equal(JSON.parse(retried.stdout).revoked_on_relay, true);
    assert.equal(readHomeState(f.home).members[phone.memberId].state, 'revoked');
  });
}

for (const rejected of [false, true]) test(`revoke accepts a ${rejected ? 'rejected' : 'joined'} phone and discards held ciphertext`, async t => {
  const f = await fixture(t), started = await f.pairing.startPairing();
  const phone = createFakePhone({ relayUrl: f.relay.url }); await phone.pair(started.uri);
  await f.pairing.refreshPairing(started.pairing_id);
  await phone.sendControl({ type: 'future_echo' }); await f.runtime.poller.once();
  assert.equal(f.runtime.status().held, 1);
  if (rejected) await f.pairing.rejectMember(phone.memberId);
  const requests = f.relay.state.requests.length;
  const result = await f.pairing.revokeMember(phone.memberId);
  assert.deepEqual(f.relay.state.requests.slice(requests).map(r => r.route), ['revokeMember']);
  const state = rejected ? 'rejected' : 'revoked';
  assert.equal(result.state, state); assert.equal(result.member.state, state);
  assert.equal(result.revoked_on_relay, !rejected);
  assert.equal(readHomeState(f.home).members[phone.memberId].state, state);
  assert.equal(f.runtime.status().held, 0); assert.deepEqual(createInbox(f.home).read(), []);
  const forgotten = await runCli(['--home', f.home, 'forget', phone.memberId, '--yes']);
  assert.equal(forgotten.code, 0, forgotten.stderr); assert.equal(JSON.parse(forgotten.stdout).dry_run, false);
});

test('revoke retries a local home lock after relay success', async t => {
  const f = await fixture(t), phone = await confirmedPhone(f);
  const revoke = f.runtime.relay.revokeMember;
  let transaction, timer;
  f.runtime.relay.revokeMember = async id => {
    await revoke(id);
    transaction = acquireHomeLock(f.home, 'state');
    timer = setTimeout(() => transaction.release(), 30);
  };
  try {
    const result = await f.pairing.revokeMember(phone.memberId);
    assert.equal(result.revoked_on_relay, true); assert.equal(result.member.state, 'revoked');
  } finally { clearTimeout(timer); transaction?.release(); }
});

test('CLI revoke refuses unknown phones, agents and invalid arguments before contacting the relay', async t => {
  const f = await fixture(t), before = readHomeState(f.home), requests = f.relay.state.requests.length;
  for (const id of ['m_dev_999999', before.identity.member_id]) {
    const result = await runCli(['--home', f.home, 'revoke', id]);
    assert.equal(result.code, 4); assert.deepEqual(JSON.parse(result.stderr), { error: 'unknown_member' });
  }
  for (const args of [[], ['not-a-member'], ['m_dev_999999', 'extra']]) {
    const result = await runCli(['--home', f.home, 'revoke', ...args]);
    assert.equal(result.code, 1); assert.equal(JSON.parse(result.stderr).error, 'invalid_arguments');
    assert.match(JSON.parse(result.stderr).usage, /revoke <member_id>/);
  }
  const unsupported = await runCli(['--home', f.home, 'revoke', 'm_dev_999999', '--replaced-by', 'm_dev_999998']);
  assert.equal(unsupported.code, 1); assert.equal(JSON.parse(unsupported.stderr).error, 'invalid_arguments');
  assert.equal(f.relay.state.requests.length, requests); assert.deepEqual(readHomeState(f.home), before);
});

test('CLI pairing operations survive repeated receiver transactions during a pending relay poll', { timeout: 15000 }, async t => {
  const f = await fixture(t), started = await f.pairing.startPairing({ v1: true });
  const phone = createFakePhone({ relayUrl: f.relay.url }); await phone.pair(started.uri);
  await f.pairing.refreshPairing(started.pairing_id);
  await phone.sendControl({ type: 'future_echo', nested: { retained: true } });
  await f.runtime.poller.once();
  assert.equal(f.runtime.status().held, 1);
  f.advance();
  const poll = f.relay.gateNext('getMessages');
  const receiver = f.runtime.poller.start();
  async function contended(operation) {
    const transaction = acquireHomeLock(f.home, 'state');
    let blocked = false, released = false;
    const release = () => { if (!released) { released = true; transaction.release(); } };
    const mkdirSync = fs.mkdirSync;
    const mkdir = t.mock.method(fs, 'mkdirSync', (...args) => {
      try { return mkdirSync(...args); }
      catch (error) {
        if (args[0] === join(f.home, '.state.lock') && error.code === 'EEXIST') {
          blocked = true; queueMicrotask(release);
        }
        throw error;
      }
    });
    try { const result = await operation(); assert.equal(blocked, true); return result; }
    finally { mkdir.mock.restore(); release(); }
  }
  async function cli(args) {
    let stdout = '', stderr = '';
    const code = await main(['--home', f.home, ...args], { env: {}, now: f.now,
      stdout: { write: s => { stdout += s; } }, stderr: { write: s => { stderr += s; } } });
    assert.equal(code, 0, `${args[0]}: ${stderr}`);
    return JSON.parse(stdout);
  }
  try {
    await Promise.race([poll.entered, receiver.done.then(() => { throw Error('receiver stopped before polling'); })]);
    for (let iteration = 0; iteration < 20; iteration++) {
      assert.equal((await contended(() => cli(['confirm', phone.memberId, phone.fingerprint()]))).state, 'confirmed');
      assert.throws(() => acquireHomeLock(f.home, 'receiver'), { code: 'home_locked' });
    }
    const history = createInbox(f.home).read();
    assert.equal(history.length, 1); assert.equal(history[0].inner.nested.retained, true);
    assert.equal(f.runtime.status().held, 0);
    await phone.fetchCommands();
    assert.equal(phone.controlReceived.filter(r => r.type === 'confirmed').length, 1);
    const next = await contended(() => cli(['pair', '--v1', '--json']));
    const untrusted = createFakePhone({ relayUrl: f.relay.url }); await untrusted.pair(next.uri);
    assert.equal((await contended(() => f.pairing.refreshPairing(next.pairing_id))).status, 'completed');
    assert.equal((await contended(() => cli(['reject', untrusted.memberId]))).state, 'rejected');
    await assert.rejects(untrusted.sendControl({ type: 'future_echo' }), { code: 'invalid_token' });
    assert.equal((await contended(() => cli(['forget', untrusted.memberId]))).dry_run, true);
    assert.equal((await contended(() => cli(['forget', untrusted.memberId, '--yes']))).dry_run, false);
    assert.deepEqual(createInbox(f.home).read(), history);
    assert.equal(readHomeState(f.home).members[untrusted.memberId].state, 'revoked');
  } finally { const done = receiver.stop(); poll.release(); await done; }
});

test('pair wait receives authenticated code proof without a background service', async t => {
  const f = await fixture(t), started = await f.pairing.startPairing();
  const phone = createFakePhone({ relayUrl: f.relay.url }); await phone.pair(started.uri); await phone.sendPairProof();
  const result = await runCli(['--home', f.home, 'wait', '--timeout', '10']);
  assert.equal(result.code, 0); assert.equal(JSON.parse(result.stdout).member.state, 'confirmed');
  await phone.fetchCommands();
  assert.deepEqual(phone.controlReceived.map(r => r.type), ['confirmed', 'agent_info']);
  assert.equal(phone.controlReceived.find(r => r.type === 'agent_info').version, AGENT_VERSION);
});

for (const [route, path, method] of [
  ['getPairing', /^\/v1\/pairings\//, 'GET'],
  ['listMembers', /^\/v1\/members$/, 'GET'],
  ['getMessages', /^\/v1\/messages$/, 'GET'],
  ['ack', /^\/v1\/acks$/, 'POST'],
]) test(`wait honors a 120-second Retry-After from ${route} and tells the phone`, async t => {
  const f = await fixture(t), started = await f.pairing.startPairing();
  const phone = createFakePhone({ relayUrl: f.relay.url }); await phone.pair(started.uri); await phone.sendPairProof();
  f.relay.failNext(route, 429, { 'Retry-After': '120' });
  const at = f.now().getTime(), attempts = [], sleeps = [];
  const result = await runCli(['--home', f.home, 'wait', '--timeout', '180'], {
    now: f.now, sleep: async ms => { sleeps.push(ms); f.advance(ms); },
    fetch: (url, options) => {
      if (path.test(new URL(url).pathname) && options.method === method) attempts.push(f.now().getTime());
      return fetch(url, options);
    },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).member.state, 'confirmed');
  assert.deepEqual(sleeps, [120000]);
  assert.equal(attempts[0], at);
  assert.ok(attempts.slice(1).every(time => time >= at + 120000));
  await phone.fetchCommands();
  assert.deepEqual(phone.controlReceived.map(r => r.type), ['confirmed', 'agent_info']);
});

test('wait bounds Retry-After by its remaining timeout', async t => {
  const f = await fixture(t), started = await f.pairing.startPairing();
  const phone = createFakePhone({ relayUrl: f.relay.url }); await phone.pair(started.uri); await phone.sendPairProof();
  f.relay.failNext('getMessages', 429, { 'Retry-After': '120' });
  const sleeps = [];
  const result = await runCli(['--home', f.home, 'wait', '--timeout', '10'], {
    now: f.now, sleep: async ms => { sleeps.push(ms); f.advance(ms); },
  });
  assert.equal(result.code, 4);
  assert.deepEqual(JSON.parse(result.stderr.split('\n').filter(Boolean).at(-1)), { error: 'timeout' });
  assert.deepEqual(sleeps, [10000]);
  assert.equal(readHomeState(f.home).members[phone.memberId].state, 'joined');
});

test('wait can be cancelled during Retry-After without polling early', async t => {
  const f = await fixture(t), started = await f.pairing.startPairing();
  const phone = createFakePhone({ relayUrl: f.relay.url }); await phone.pair(started.uri); await phone.sendPairProof();
  f.relay.failNext('getMessages', 429, { 'Retry-After': '120' });
  const controller = new AbortController(), sleeps = [];
  const result = await runCli(['--home', f.home, 'wait', '--timeout', '180'], {
    now: f.now, signal: controller.signal, sleep: async ms => {
      sleeps.push(ms); controller.abort();
    },
  });
  assert.equal(result.code, 4);
  assert.deepEqual(sleeps, [120000]);
  assert.equal(f.relay.state.requests.filter(r => r.route === 'getMessages').length, 1);
  assert.equal(readHomeState(f.home).members[phone.memberId].state, 'joined');
});

for (const confirmed of [false, true]) test(`wait observes an active receiver with ${confirmed ? 'completed' : 'pending'} proof confirmation`, async t => {
  const f = await fixture(t), started = await f.pairing.startPairing();
  const phone = createFakePhone({ relayUrl: f.relay.url }); await phone.pair(started.uri);
  await f.pairing.refreshPairing(started.pairing_id);
  await phone.sendPairProof();
  if (confirmed) await f.runtime.poller.once();
  const receiver = acquireHomeLock(f.home, 'receiver');
  let stdout = '', stderr = '', sleeps = 0;
  try {
    const code = await main(['--home', f.home, 'wait', '--timeout', '10'], {
      env: {}, sleep: async () => {
        sleeps++;
        receiver.release();
        await f.runtime.poller.once();
      },
      stdout: { write: s => { stdout += s; } }, stderr: { write: s => { stderr += s; } },
    });
    assert.equal(code, 0, stderr);
    assert.equal(JSON.parse(stdout).member.state, 'confirmed');
    assert.equal(sleeps, confirmed ? 0 : 1);
    await phone.fetchCommands();
    assert.deepEqual(phone.controlReceived.map(r => r.type), ['confirmed', 'agent_info']);
  } finally { receiver.release(); }
});

for (const route of ['getPairing', 'listMembers']) test(`pairing refresh forwards cancellation and deadline through ${route}`, async t => {
  const f = await fixture(t), started = await f.pairing.startPairing();
  const phone = createFakePhone({ relayUrl: f.relay.url }); await phone.pair(started.uri);
  const controller = new AbortController(), deadline = Date.now() + 1000;
  const relay = { ...f.runtime.relay, [route]: (...args) => {
    const context = args.at(-1);
    assert.equal(context.signal, controller.signal);
    assert.equal(context.deadline, deadline);
    controller.abort(new Error('cancelled pairing fixture'));
    return f.runtime.relay[route](...args);
  } };
  const service = createPairingService({ home: f.home, relay, publicKey: readHomeState(f.home).identity.public_key, agentName: 'Lab' });
  await assert.rejects(service.refreshPairing(started.pairing_id, { signal: controller.signal, deadline }), /cancelled pairing fixture/);
  assert.ok(readPairingFile(f.home));
  assert.equal(readHomeState(f.home).pairings[started.pairing_id].status, 'pending');
});

test('receiver completion erases credentials after durable proof derivation and wait resumes offline metadata', async t => {
  const f = await fixture(t), started = await f.pairing.startPairing();
  const phone = createFakePhone({ relayUrl: f.relay.url }); await phone.pair(started.uri);
  await f.runtime.poller.once();
  assert.ok(readPairingFile(f.home) === null, 'completed pairing credentials retained');
  assert.ok(readHomeState(f.home).members[phone.memberId].pair_proof);
  await phone.sendPairProof(); f.advance(); await f.runtime.poller.once();
  const result = await runCli(['--home', f.home, 'wait', '--timeout', '10']);
  assert.equal(result.code, 0);
  assert.equal(JSON.parse(result.stdout).member.state, 'confirmed');
  await phone.fetchCommands();
  assert.deepEqual(phone.controlReceived.map(r => r.type), ['confirmed', 'agent_info']);
});
