import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import fs from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { main } from '../../src/cli.js';
import { saveConfig } from '../../src/config.js';
import { createCipherFiles, createHomeState, readHomeState, updateHomeState } from '../../src/home-state.js';
import { createHubObserver } from '../../src/hub-state.js';
import { createInbox } from '../../src/inbox.js';
import { createOutbox } from '../../src/outbox.js';
import { saveSecrets } from '../../src/secrets.js';
import { createPairingService } from '../../src/pairing.js';
import { acquireHomeLock, atomicPrivateWrite } from '../../src/protected-files.js';
import { maintainResponseWaits } from '../../src/response-waits.js';
import { createRuntime, readSkill } from '../../src/runtime.js';
import { skillTrustForTests } from '../../src/skill-document.js';
import { createSkillUpdater } from '../../src/skill-update.js';
import { createThinInbound } from '../../src/thin-inbound.js';
import { createThinPoller } from '../../src/thin-poller.js';
import { runCli } from '../support/helpers.js';
import { fixture, identity, keys, messageId } from '../support/thin-home.js';
import { pairingId, resolvedReply, scopedRequest } from '../support/pairing-scope.js';
import { delivery, now, self, setup } from '../support/thin-transport.js';

function homeFixture(t) {
  const home = fixture(t);
  createHomeState(home, identity);
  saveSecrets(home, { private_key: keys.agent.sk, public_key: keys.agent.pk,
    token: `sk_${identity.hub_id}_${'T'.repeat(40)}`, webhook_secret: `whsec_${'W'.repeat(43)}` });
  saveConfig(home, { relay_url: 'http://127.0.0.1:8787', name: 'Test' });
  return home;
}

function replaceDuringRead(t, home, file = 'state.json') {
  let armed = false, skip = 0, writing = false, writes = 0;
  const openSync = fs.openSync;
  t.mock.method(fs, 'openSync', (...args) => {
    const fd = openSync(...args);
    if (armed && !writing && writes < 3 && args[0] === join(home, file)) {
      if (skip > 0) { skip--; return fd; }
      writing = true;
      try {
        writes++;
        if (file === 'state.json') updateHomeState(home, s => { s.transport.heartbeat_day = `receiver-${writes}`; });
        else atomicPrivateWrite(join(home, file), fs.readFileSync(join(home, file)));
      }
      finally { writing = false; }
    }
    return fd;
  });
  return { arm: (reads = 0) => { armed = true; skip = reads; }, get writes() { return writes; } };
}

test('synchronous runtime initialization retries receiver state renames', t => {
  const home = homeFixture(t), race = replaceDuringRead(t, home);
  race.arm();
  const runtime = createRuntime({ home, env: {}, fetch: () => assert.fail('unexpected network') });
  assert.equal(runtime.self.memberId, identity.member_id);
  assert.equal(race.writes, 3);
  assert.equal(readHomeState(home).transport.heartbeat_day, 'receiver-3');
});

for (const stage of ['access maintenance', 'join', 'expiry', 'join cleanup']) {
  test(`scoped receive --once retries a live state lock during pairing ${stage}`, async t => {
    const home = homeFixture(t), at = new Date('2026-11-08T00:00:00Z'), now = () => at;
    const pairingId = `p_${'A'.repeat(22)}`;
    const pairing = createPairingService({ home, publicKey: keys.agent.pk, agentName: 'Test', now, relay: {
      baseUrl: 'http://127.0.0.1:8787', createPairing: async () => ({ hub_id: identity.hub_id,
        pairing_id: pairingId, pairing_token: `pt_${'P'.repeat(43)}`, expires_at: '2026-11-08T00:05:00Z' }),
    } });
    await pairing.startPairing({ read: ['steps'] });
    updateHomeState(home, s => {
      const row = s.pairings[pairingId];
      if (stage === 'access maintenance' || stage === 'expiry') {
        row.status = 'expired';
        if (stage === 'expiry') row.access.state = 'cancelled';
      } else {
        s.members[keys.dev1.member_id] = { member_id: keys.dev1.member_id, public_key: keys.dev1.pk,
          role: 'device', state: 'joined', pairing_id: pairingId };
        Object.assign(row, { status: 'completed', member_id: keys.dev1.member_id, public_key: keys.dev1.pk });
        Object.assign(row.access, { joined_at: at.toISOString(), deadline_at: new Date(at.getTime() + 900000).toISOString() });
      }
      maintainResponseWaits(s, at.getTime());
    });
    let transaction, timer, released = false, acquisitions = 0, committed;
    const hold = () => {
      transaction = acquireHomeLock(home, 'state');
      timer = setTimeout(() => { transaction.release(); released = true; }, 40);
    };
    let polls = 0;
    const runtime = createRuntime({ home, env: {}, now, fetch: async url => {
      const path = new URL(url).pathname;
      if (path === '/v1/messages') { polls++; return Response.json({ messages: [] }); }
      if (path === '/v1/hub/state') return Response.json({ state: 'active' });
      assert.fail('unexpected relay request');
    }, createPoller: options => createThinPoller({ ...options, heartbeat: undefined, outbox: undefined,
      async watchPairing(context) {
        if (stage === 'join cleanup') {
          const mkdirSync = fs.mkdirSync;
          t.mock.method(fs, 'mkdirSync', (...args) => {
            if (args[0] === join(home, '.state.lock') && ++acquisitions === 2) {
              committed = readHomeState(home);
              hold();
            }
            return mkdirSync(...args);
          });
        } else hold();
        await options.watchPairing(context);
      } }) });
    const result = await runtime.poller.once().finally(() => { clearTimeout(timer); transaction?.release(); });
    assert.equal(released, true);
    assert.equal(result.pages, 1); assert.equal(polls, 1);
    assert.equal(fs.existsSync(join(home, 'pairing.json')), false);
    const state = readHomeState(home), row = state.pairings[pairingId];
    if (stage === 'access maintenance' || stage === 'expiry') {
      assert.equal(row.status, 'expired'); assert.equal(row.access.state, 'cancelled');
    } else {
      assert.equal(row.status, 'completed'); assert.equal(row.access.state, 'awaiting');
      assert.equal(row.access.joined_at, at.toISOString());
      assert.equal(row.access.deadline_at, new Date(at.getTime() + 900000).toISOString());
      assert.equal(state.members[keys.dev1.member_id].state, 'joined');
      assert.ok(state.members[keys.dev1.member_id].pair_proof);
      if (committed) {
        assert.ok(JSON.stringify(row) === JSON.stringify(committed.pairings[pairingId]), 'retry changed the committed pairing');
        assert.ok(JSON.stringify(state.members[keys.dev1.member_id]) === JSON.stringify(committed.members[keys.dev1.member_id]), 'retry changed the committed member');
      }
    }
  });
}

test('receive --once retries state renames after watching a scoped pairing', async t => {
  const home = homeFixture(t), race = replaceDuringRead(t, home);
  const now = () => new Date('2026-11-08T00:00:00Z');
  const pairing = createPairingService({ home, publicKey: keys.agent.pk, agentName: 'Test', now, relay: {
    baseUrl: 'http://127.0.0.1:8787', createPairing: async () => ({ hub_id: identity.hub_id,
      pairing_id: `p_${'A'.repeat(22)}`, pairing_token: `pt_${'P'.repeat(43)}`, expires_at: '2026-11-08T00:05:00Z' }),
  } });
  await pairing.startPairing({ read: ['steps'] });
  let polls = 0, refreshes = 0;
  const runtime = createRuntime({ home, env: {}, now, fetch: async url => {
    const path = new URL(url).pathname;
    if (path.startsWith('/v1/pairings/')) { refreshes++; return Response.json({ status: 'pending' }); }
    if (path === '/v1/messages') { polls++; return Response.json({ messages: [] }); }
    assert.fail('unexpected relay request');
  }, createPoller: options => createThinPoller({ ...options, heartbeat: undefined, outbox: undefined, observeHubState: undefined,
    async watchPairing(context) { await options.watchPairing(context); race.arm(); } }) });
  assert.equal((await runtime.poller.once()).pages, 1);
  assert.equal(race.writes, 3); assert.equal(refreshes, 1); assert.equal(polls, 1);
});

for (const stage of ['held access reply', 'scope sync']) test(`receive --once retries trusted-key state renames for ${stage}`, async t => {
  const held = stage === 'held access reply', { home, transport, pairing } = setup(t, { confirmed: !held });
  scopedRequest(home);
  const message = await delivery(transport, 1, held ? resolvedReply() : {
    type: 'sync', scope: { read: 'none', write: ['body_mass'] }, more: false,
  });
  if (held) {
    assert.equal((await createThinInbound({ home, transport, self, now }).receive(message)).status, 'held');
    pairing.confirmFingerprint(keys.dev1.member_id, readHomeState(home).members[keys.dev1.member_id].fingerprint);
    updateHomeState(home, s => { s.transport.cursor = 1; s.transport.acked_seq = 1; });
  }
  const race = replaceDuringRead(t, home);
  let validations = 0, decryptions = 0, polls = 0, acks = 0;
  const receiving = { ...transport,
    validateShape(...args) { validations++; race.arm(1); return transport.validateShape(...args); },
    receive(...args) { decryptions++; return transport.receive(...args); },
  };
  const result = await createThinPoller({ home, transport: receiving, self, now, relay: {
    getMessages: async () => { polls++; return { messages: held ? [] : [message], next_after: 1 }; },
    ack: async seq => { acks++; assert.equal(seq, 1); },
  } }).once();
  assert.equal(result.pages, 1); assert.equal(result.fetched, held ? 0 : 1); assert.equal(result.acked_up_to, 1);
  assert.equal(race.writes, 3); assert.equal(validations, 1); assert.equal(decryptions, 1);
  assert.equal(polls, 1); assert.equal(acks, held ? 0 : 1);
  assert.deepEqual(createInbox(home).read().map(r => r.type), [held ? 'access_reply' : 'sync']);
  assert.equal(createCipherFiles(home, 'held').list().length, 0);
  const state = readHomeState(home);
  if (held) {
    assert.equal(state.pairings[pairingId].access.state, 'resolved');
    assert.deepEqual(state.pairings[pairingId].access.outcomes, { read: resolvedReply().read, write: resolvedReply().write });
    assert.equal(state.members[keys.dev1.member_id].scope, undefined);
  } else assert.deepEqual(state.members[keys.dev1.member_id].scope, { read: 'none', write: ['body_mass'], seq: 1 });
});

for (const file of ['installed-bundle.json', 'skill-update.json']) test(`receive skill state retries ${file} renames without falling back`, async t => {
  const { home, transport } = setup(t), pair = generateKeyPairSync('ed25519');
  const bootstrap = JSON.parse(fs.readFileSync(new URL('../../skills/syncky/bootstrap.json', import.meta.url)));
  const initial = JSON.parse(Buffer.from(bootstrap.payload, 'base64'));
  const document = { ...initial, skill_version: initial.skill_version + 1, skill: '# Updated\n' };
  const payload = Buffer.from(JSON.stringify(document));
  const feed = JSON.stringify({ payload: payload.toString('base64'), signature: sign(null, payload, pair.privateKey).toString('base64') });
  const trust = skillTrustForTests(Buffer.from(pair.publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64'));
  let downloads = 0;
  const updater = createSkillUpdater({ home, trust, fetch: async () => { downloads++; return new Response(feed); } });
  updater.observeHeartbeat({ skill_update: { skill_version: document.skill_version, url: 'https://dev.syncky.app/agent-skill.json' } });
  if (file === 'installed-bundle.json') assert.equal((await updater.tick()).state, 'applied');
  const race = replaceDuringRead(t, home, file);
  let yielded = false;
  const timer = setTimeout(() => { yielded = true; }, 0);
  t.after(() => clearTimeout(timer));
  race.arm();
  if (file === 'skill-update.json') {
    let polls = 0;
    assert.equal((await createThinPoller({ home, transport, self, now,
      relay: { getMessages: async () => { polls++; return { messages: [] }; } },
      outbox: { flush: options => updater.tick(options) },
    }).once()).pages, 1);
    assert.equal(polls, 1);
  }
  const skill = await readSkill(updater);
  assert.equal(skill.skill_version, document.skill_version);
  assert.equal(skill.skill, document.skill);
  assert.equal(updater.status().code, null);
  assert.equal(race.writes, 3); assert.equal(downloads, 1);
  assert.equal(yielded, true, 'skill snapshot retries must yield to timers');
});

for (const method of ['validateShape', 'receive', 'serialize']) test(`receive retries a skill snapshot from transport ${method} without blocking`, async t => {
  const { home, transport } = setup(t, { confirmed: method !== 'serialize' });
  saveSecrets(home, { private_key: keys.agent.sk, public_key: keys.agent.pk,
    token: `sk_${identity.hub_id}_${'T'.repeat(40)}`, webhook_secret: `whsec_${'W'.repeat(43)}` });
  saveConfig(home, { relay_url: 'http://127.0.0.1:8787', name: 'Test' });
  const runtime = createRuntime({ home, env: {}, now, fetch: () => assert.fail('unexpected network') });
  const read = runtime.updater.read;
  let armed = false, yielded = false, retries = 0, timer;
  t.after(() => clearTimeout(timer));
  t.mock.method(runtime.updater, 'read', () => {
    if (armed && !yielded) {
      retries++;
      throw Object.assign(new Error('fixture skill snapshot contention'), { code: 'home_locked' });
    }
    return read();
  });
  const receiving = new Proxy(runtime.transport, { get(target, key) {
    return (...args) => {
      if (key === method && !armed) {
        armed = true;
        timer = setTimeout(() => { yielded = true; }, 0);
      }
      return target[key](...args);
    };
  } });
  const result = await createThinInbound({ home, transport: receiving, self, now }).receive(await delivery(transport, 1));
  assert.equal(result.status, method === 'serialize' ? 'held' : 'stored');
  assert.equal(retries, 1); assert.equal(yielded, true);
  assert.equal((method === 'serialize' ? createCipherFiles(home, 'held').list() : createInbox(home).read()).length, 1);
});

for (const completed of [false, true]) test(`pairing refresh retries member state renames ${completed ? 'from a durable binding' : 'after joining'}`, async t => {
  const home = homeFixture(t), race = replaceDuringRead(t, home), now = () => new Date('2026-11-08T00:00:00Z');
  const pairingId = `p_${'A'.repeat(22)}`, member = { member_id: keys.dev1.member_id,
    public_key: keys.dev1.pk, role: 'device', state: 'joined', pairing_id: pairingId };
  let refreshes = 0, listings = 0;
  const pairing = createPairingService({ home, publicKey: keys.agent.pk, agentName: 'Test', now, relay: {
    baseUrl: 'http://127.0.0.1:8787', createPairing: async () => ({ hub_id: identity.hub_id,
      pairing_id: pairingId, pairing_token: `pt_${'P'.repeat(43)}`, expires_at: '2026-11-08T00:05:00Z' }),
    getPairing: async () => { refreshes++; return { status: 'completed', member_id: member.member_id, public_key: member.public_key }; },
    listMembers: async () => { listings++; race.arm(1); return { members: [member] }; },
  } });
  await pairing.startPairing({ read: ['steps'] });
  if (completed) {
    updateHomeState(home, s => {
      s.members[member.member_id] = member;
      Object.assign(s.pairings[pairingId], { status: 'completed', member_id: member.member_id, public_key: member.public_key });
      maintainResponseWaits(s, now().getTime());
    });
    race.arm(1);
  }
  const result = await pairing.refreshPairing(pairingId);
  assert.equal(result.status, 'completed'); assert.equal(result.member.member_id, member.member_id);
  assert.equal(race.writes, 3); assert.equal(refreshes, completed ? 0 : 1); assert.equal(listings, completed ? 0 : 1);
});

test('receive --once retries the heartbeat cache write without repeating the heartbeat', async t => {
  const home = homeFixture(t), now = () => new Date('2026-11-08T00:00:00Z');
  let transaction, timer, heartbeats = 0, polls = 0;
  const runtime = createRuntime({ home, env: {}, now, fetch: async url => {
    const path = new URL(url).pathname;
    if (path === '/v1/agents/heartbeat') {
      heartbeats++; transaction = acquireHomeLock(home, 'state');
      timer = setTimeout(() => transaction.release(), 40);
      return new Response(null, { status: 204 });
    }
    if (path === '/v1/messages') { polls++; return Response.json({ messages: [] }); }
    assert.fail('unexpected relay request');
  }, createPoller: options => createThinPoller({ ...options, observeHubState: undefined, outbox: undefined }) });
  assert.equal((await runtime.poller.once().finally(() => { clearTimeout(timer); transaction?.release(); })).pages, 1);
  assert.equal(heartbeats, 1); assert.equal(polls, 1);
  assert.equal(fs.existsSync(join(home, 'skill-update.json')), true);
});

test('receive hub observation retries state renames without repeating its request', async t => {
  const home = homeFixture(t), race = replaceDuringRead(t, home);
  let requests = 0;
  const observe = createHubObserver({ home, relay: { getHubState: async () => { requests++; return { state: 'active' }; } } });
  race.arm();
  await observe();
  assert.equal(requests, 1); assert.equal(race.writes, 3);
  assert.equal(readHomeState(home).transport.hub_state.state, 'active');
});

test('receive outbox lane retries state renames without repeating its send', async t => {
  const home = homeFixture(t), race = replaceDuringRead(t, home);
  updateHomeState(home, s => {
    s.members[keys.dev1.member_id] = { member_id: keys.dev1.member_id, public_key: keys.dev1.pk, role: 'device', state: 'confirmed' };
  });
  const msgId = messageId(1);
  createCipherFiles(home, 'outbox').put({ msg_id: msgId, kind: 'control', state: 'pending', to: [keys.dev1.member_id],
    body: JSON.stringify({ v: 1, msg_id: msgId, kind: 'control' }) });
  let sends = 0;
  const outbox = createOutbox({ home, relay: { postMessage: async () => { sends++; return { seq: 1 }; } } });
  race.arm();
  await outbox.flush();
  assert.equal(sends, 1); assert.equal(race.writes, 3);
  const receipt = outbox.receipts()[0];
  assert.equal(receipt.state, 'sent'); assert.equal(receipt.attempts, 1);
});

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
