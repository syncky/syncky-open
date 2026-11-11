import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { saveConfig } from '../../src/config.js';
import { saveSecrets } from '../../src/secrets.js';
import { createInbox } from '../../src/inbox.js';
import { readHomeState } from '../../src/home-state.js';
import { createFixtureRuntime } from '../support/receive-fixture.js';
import { createRuntime } from '../../src/runtime.js';
import { waitFor } from '../support/helpers.js';
import { setup, keys, identity, now, delivery } from '../support/thin-transport.js';

const agentBin = fileURLToPath(new URL('../../bin/syncky-agent.js', import.meta.url));
function homeFixture(t) {
  const fixture = setup(t);
  saveConfig(fixture.home, { relay_url: 'http://127.0.0.1:8787', name: 'Fixture' });
  saveSecrets(fixture.home, { private_key: keys.agent.sk, public_key: keys.agent.pk,
    token: `sk_${identity.hub_id}_${'T'.repeat(40)}`, webhook_secret: `whsec_${'W'.repeat(43)}` });
  return fixture;
}

test('verified join scheduling observes short plan transitions and post-sync traffic without bypassing Retry-After or the later floor', async t => {
  const { home, transport } = homeFixture(t);
  let at = now().getTime(), hub = 'unpaid', gets = 0, limited = false;
  const joinedAt = at, member = { member_id: keys.dev1.member_id, role: 'device', public_key: keys.dev1.pk, joined_at: new Date(at).toISOString() };
  let messages = [{ seq: 1, kind: 'system', event: 'member_joined', body: member }];
  const options = { home, agentBin, env: {}, now: () => new Date(at), fetch: async url => {
    const path = new URL(url).pathname;
    if (path === '/v1/hub/state') return Response.json({ state: hub });
    if (path === '/v1/members') return Response.json({ members: [member] });
    if (path === '/v1/messages') {
      gets++;
      if (limited) { limited = false; return Response.json({ error: 'rate_limited' }, { status: 429, headers: { 'retry-after': '7' } }); }
      const rows = messages; messages = [];
      return Response.json({ messages: rows, next_after: rows.at(-1)?.seq ?? 0, has_more: false });
    }
    return new Response(null, { status: 204 });
  } };
  const runtime = await createFixtureRuntime(options);
  await runtime.poller.once();
  assert.equal(runtime.status().transport.hub_state.state, 'unpaid');
  await runtime.poller.startFastPoll(member.member_id, readHomeState(home).members[member.member_id].join_grace_until);
  const production = () => createRuntime({ ...options, flags: { 'poll-interval': '300' } });
  at += 1000;
  assert.equal((await production().poller.once()).next_poll_at, joinedAt + 25000);
  for (const [state, event, seq] of [['active', 'hub_resumed', 2], ['suspended', 'hub_suspended', 3]]) {
    hub = state;
    messages = [{ seq, kind: 'system', event, body: {} }];
    await runtime.poller.once();
    at += 1000; await runtime.poller.once();
    assert.equal(runtime.status().transport.hub_state.state, state);
    at += 15000;
  }
  messages = [await delivery(transport, 4, { v: 1, type: 'sync', more: false })];
  await runtime.poller.once();
  assert.deepEqual(readHomeState(home).transport.fast_poll.devices, []);
  at += 1000;
  assert.equal((await production().poller.once()).next_poll_at, at - 1000 + 300000);
  hub = 'active'; messages = [{ seq: 5, kind: 'system', event: 'hub_resumed', body: {} }];
  await runtime.poller.once();
  at += 1000; await runtime.poller.once();
  assert.equal(runtime.status().transport.hub_state.state, 'active');
  assert.equal(readHomeState(home).transport.acked_seq, 5);

  at += 1000; limited = true;
  await assert.rejects(runtime.poller.once(), { status: 429 });
  const retry = at + 7000, before = gets;
  at = retry - 1;
  assert.deepEqual(await (await createFixtureRuntime(options)).poller.once(), { deferred: true, reason: 'retry_after', next_poll_at: retry });
  assert.equal(gets, before);
  at++; await (await createFixtureRuntime(options)).poller.once();
  assert.equal(gets, before + 1);

  at = joinedAt + 840000 - 1000;
  await runtime.poller.once();
  const last = at;
  at += 1000;
  assert.deepEqual(await production().poller.once(), { deferred: true, reason: 'poll_floor', next_poll_at: last + 300000 });
  assert.equal(readHomeState(home).transport.next_poll_at, last + 300000);
  at = last + 300000;
  assert.equal((await production().poller.once()).pages, 1);
  assert.equal(readHomeState(home).transport.next_poll_at, at + 300000);
  at += 1000;
  assert.equal((await (await createFixtureRuntime(options)).poller.once()).pages, 1);
  assert.equal(readHomeState(home).transport.next_poll_at, at + 1000);
});

test('receiver pause acknowledges only between fully committed poll cycles and resumes without losing traffic', async t => {
  const { home, transport } = homeFixture(t), message = await delivery(transport, 1);
  let at = now().getTime(), gets = 0, acks = 0, release;
  const requested = join(home, '.e2e-receive-pause'), paused = join(home, '.e2e-receive-paused');
  const runtime = await createFixtureRuntime({ home, agentBin, env: {}, now: () => new Date(at), fetch: async (url, options) => {
    if (new URL(url).pathname === '/v1/messages') {
      if (++gets === 1) return new Promise(resolve => { release = () => resolve(Response.json({ messages: [message], next_after: 1 })); });
      return Response.json({ messages: [], next_after: 1 });
    }
    if (new URL(url).pathname === '/v1/acks') { acks++; assert.equal(createInbox(home).read().length, 1); }
    return new Response(null, { status: 204 });
  } });
  const first = runtime.poller.once();
  await waitFor(() => release);
  fs.writeFileSync(requested, 'pause-1', { mode: 0o600 });
  assert.equal(fs.existsSync(paused), false, 'in-flight data was not committed yet');
  release(); await first;
  assert.equal(readHomeState(home).transport.acked_seq, 1);
  at += 300000;
  const second = runtime.poller.once();
  try {
    await waitFor(() => fs.existsSync(paused) && fs.readFileSync(paused, 'utf8') === 'pause-1');
    assert.equal(fs.statSync(paused).mode & 0o777, 0o600);
    assert.equal(gets, 1); assert.equal(acks, 1);
  } finally { fs.rmSync(requested, { force: true }); await second; }
  assert.equal(gets, 2); assert.equal(fs.existsSync(paused), false);
});

test('aborting a paused receiver clears the acknowledgement and releases its lease', async t => {
  const { home } = homeFixture(t), controller = new AbortController();
  const requested = join(home, '.e2e-receive-pause'), paused = join(home, '.e2e-receive-paused');
  let at = now().getTime(), gets = 0;
  const runtime = await createFixtureRuntime({ home, agentBin, env: {}, now: () => new Date(at), fetch: async url => {
    if (new URL(url).pathname === '/v1/messages') { gets++; return Response.json({ messages: [], next_after: 0 }); }
    return new Response(null, { status: 204 });
  } });
  fs.writeFileSync(requested, 'pause-2', { mode: 0o600 });
  const stopped = assert.rejects(runtime.poller.once({ signal: controller.signal }));
  try { await waitFor(() => fs.existsSync(paused)); }
  finally { controller.abort(); await stopped; fs.rmSync(requested, { force: true }); }
  assert.equal(gets, 0); assert.equal(fs.existsSync(paused), false);
  at = readHomeState(home).transport.poll_retry_at;
  await runtime.poller.once(); assert.equal(gets, 1);
});
