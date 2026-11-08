import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { main } from '../../src/cli.js';
import { saveConfig } from '../../src/config.js';
import { createHomeState, readHomeState, updateHomeState } from '../../src/home-state.js';
import { saveSecrets } from '../../src/secrets.js';
import { createPairingService } from '../../src/pairing.js';
import { runCli } from '../support/helpers.js';
import { fixture, identity, keys } from '../support/thin-home.js';

function homeFixture(t) {
  const home = fixture(t);
  createHomeState(home, identity);
  saveSecrets(home, { private_key: keys.agent.sk, public_key: keys.agent.pk,
    token: `sk_${identity.hub_id}_${'T'.repeat(40)}`, webhook_secret: `whsec_${'W'.repeat(43)}` });
  saveConfig(home, { relay_url: 'http://127.0.0.1:8787', name: 'Test' });
  return home;
}

function replaceDuringRead(t, home) {
  let armed = false, skip = 0, writing = false, writes = 0;
  const openSync = fs.openSync;
  t.mock.method(fs, 'openSync', (...args) => {
    const fd = openSync(...args);
    if (armed && !writing && writes < 3 && args[0] === join(home, 'state.json')) {
      if (skip > 0) { skip--; return fd; }
      writing = true;
      try { updateHomeState(home, s => { s.transport.heartbeat_day = `receiver-${++writes}`; }); }
      finally { writing = false; }
    }
    return fd;
  });
  return { arm: (reads = 0) => { armed = true; skip = reads; }, get writes() { return writes; } };
}

for (const stage of ['runtime initialization', 'pairing response', 'pairing response without hub_id']) {
  test(`pair --v1 survives receiver renames during ${stage}`, async t => {
    const home = fixture(t);
    createHomeState(home, identity);
    saveSecrets(home, { private_key: keys.agent.sk, public_key: keys.agent.pk,
      token: `sk_${identity.hub_id}_${'T'.repeat(40)}`, webhook_secret: `whsec_${'W'.repeat(43)}` });
    saveConfig(home, { relay_url: 'http://127.0.0.1:8787', name: 'Test' });
    let armed = stage === 'runtime initialization', writing = false, writes = 0, requests = 0;
    const openSync = fs.openSync;
    t.mock.method(fs, 'openSync', (...args) => {
      const fd = openSync(...args);
      if (armed && !writing && writes < 3 && args[0] === join(home, 'state.json')) {
        writing = true;
        try {
          updateHomeState(home, s => { s.transport.heartbeat_day = `receiver-${++writes}`; });
        } finally { writing = false; }
      }
      return fd;
    });
    let stdout = '', stderr = '';
    const code = await main(['--home', home, 'pair', '--v1', '--json'], {
      env: {},
      fetch: async (url, options) => {
        assert.equal(new URL(url).pathname, '/v1/pairings');
        assert.equal(options.method, 'POST');
        requests++;
        armed = true;
        return Response.json({ ...(stage.endsWith('without hub_id') ? {} : { hub_id: identity.hub_id }),
          pairing_id: `p_${'A'.repeat(22)}`, pairing_token: `pt_${'P'.repeat(43)}`, expires_at: '2099-01-01T00:00:00Z' });
      },
      stdout: { write: s => { stdout += s; } }, stderr: { write: s => { stderr += s; } },
    });
    assert.equal(code, 0, `pair exited ${code}: ${stderr.trim()}`);
    assert.equal(writes, 3);
    assert.equal(requests, 1);
    assert.equal(JSON.parse(stdout).version, 1);
    const state = readHomeState(home);
    assert.equal(state.transport.heartbeat_day, 'receiver-3');
    assert.equal(state.pairings[JSON.parse(stdout).pairing_id].status, 'pending');
  });
}

test('receive survives state renames after poller.start before receive_ready', async t => {
  const home = homeFixture(t), race = replaceDuringRead(t, home);
  let starts = 0;
  const result = await runCli(['--home', home, 'receive'], {
    fetch: () => assert.fail('unexpected network'),
    createPoller: () => ({ start() {
      starts++; race.arm();
      return { done: Promise.resolve({ reason: 'stopped' }), stop() {} };
    } }),
  });
  assert.equal(result.code, 0, result.stderr.trim());
  assert.equal(starts, 1); assert.equal(race.writes, 3);
  const ready = result.stderr.trim().split('\n').map(s => JSON.parse(s)).find(e => e.event === 'receive_ready');
  assert.equal(ready.hub_id, identity.hub_id);
  assert.equal(ready.member_id, identity.member_id);
});

for (const name of ['syncky_send', 'syncky_ack']) test(`MCP ${name} survives state renames during runtime initialization`, async t => {
  const home = homeFixture(t);
  updateHomeState(home, s => {
    s.members[keys.dev1.member_id] = { member_id: keys.dev1.member_id, public_key: keys.dev1.pk, role: 'device', state: 'confirmed' };
    s.transport.cursor = 1;
  });
  const race = replaceDuringRead(t, home);
  race.arm();
  let requests = 0;
  const args = name === 'syncky_send' ? { type: 'future', inner: { type: 'future' } } : { up_to_seq: 1 };
  const result = await runCli(['--home', home, 'mcp'], {
    stdin: Readable.from([JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) + '\n']),
    fetch: async (url, options) => {
      assert.equal(new URL(url).pathname, name === 'syncky_send' ? '/v1/messages' : '/v1/acks');
      assert.equal(options.method, 'POST'); requests++;
      return name === 'syncky_send' ? Response.json({ seq: 2 }, { status: 201 }) : new Response(null, { status: 204 });
    },
  });
  assert.equal(result.code, 0, result.stderr.trim());
  const reply = JSON.parse(result.stdout);
  assert.equal(reply.result.isError, false, JSON.stringify(reply.result.structuredContent));
  assert.equal(race.writes, 3); assert.equal(requests, 1);
  if (name === 'syncky_send') assert.equal(reply.result.structuredContent.state, 'sent');
  else assert.equal(reply.result.structuredContent.acked_up_to, 1);
});

for (const stage of ['current pairing', 'member state']) test(`pair-waiter survives state renames in isCurrent ${stage}`, async t => {
  const home = homeFixture(t), now = () => new Date('2026-11-08T00:00:00Z');
  const pairing = createPairingService({ home, publicKey: keys.agent.pk, agentName: 'Test', now, relay: {
    baseUrl: 'http://127.0.0.1:8787', createPairing: async () => ({ hub_id: identity.hub_id,
      pairing_id: `p_${'A'.repeat(22)}`, pairing_token: `pt_${'P'.repeat(43)}`, expires_at: '2026-11-08T00:05:00Z' }),
  } });
  const started = await pairing.startPairing(), race = replaceDuringRead(t, home), timers = new Set();
  let stderr = '', requests = 0, sleeps = 0;
  const code = await main(['--home', home, 'pair-waiter', started.pairing_id], {
    env: {}, now, stdout: { write: () => assert.fail('unexpected stdout') },
    stderr: { write: line => {
      stderr += line;
      if (JSON.parse(line).event === 'pair_waiter_started') race.arm(stage === 'member state' ? 1 : 0);
    } },
    timers: { setTimeout: () => { const timer = Symbol(); timers.add(timer); return timer; }, clearTimeout: timer => timers.delete(timer) },
    fetch: async (url, options) => {
      assert.equal(new URL(url).pathname, `/v1/pairings/${started.pairing_id}`);
      assert.equal(options.method, 'GET'); requests++;
      return Response.json({ status: 'pending' });
    },
    sleep: async () => {
      assert.equal(sleeps++, 0);
      updateHomeState(home, s => { s.pairings[started.pairing_id].status = 'expired'; });
    },
  });
  assert.equal(code, 0, stderr.trim());
  assert.match(stderr, /pair_waiter_finished/); assert.doesNotMatch(stderr, /pair_waiter_stopped/);
  assert.equal(race.writes, 3); assert.equal(requests, 1); assert.equal(sleeps, 1); assert.equal(timers.size, 0);
});
