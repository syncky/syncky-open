import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHubObserver } from '../../src/hub-state.js';
import { readHomeState, updateHomeState } from '../../src/home-state.js';
import { setup, now } from '../support/thin-transport.js';

for (const state of ['unpaid', 'active', 'suspended']) test(`receive caches ${state} metadata; failed refresh retains history`, async t => {
  const { home } = setup(t); let at = now().getTime(), calls = 0;
  const observe = createHubObserver({ home, now: () => new Date(at), relay: { getHubState: async () => {
    calls++; if (calls > 1) throw { code: 'timeout', status: 0 };
    return { state, reason: 'subscription_expired', deleting_at: '2026-12-05T00:00:00Z', extra: 'PRIVATE' };
  } } });
  await observe(); await observe(); assert.equal(calls, 1);
  const saved = readHomeState(home).transport.hub_state;
  assert.equal(saved.state, state); assert.equal(saved.reason, 'subscription_expired');
  assert.ok(!JSON.stringify(saved).includes('PRIVATE'));
  at += 300000; await observe(); assert.equal(calls, 2);
  assert.deepEqual(readHomeState(home).transport.hub_state, saved);
});

test('a newer relay event invalidates an in-flight hub response and requests fresh state', async t => {
  const { home } = setup(t); let finish;
  const observe = createHubObserver({ home, now, relay: { getHubState: () => new Promise(r => { finish = r; }) } });
  const task = observe();
  while (!finish) await new Promise(r => setImmediate(r));
  updateHomeState(home, s => { s.transport.hub_state_revision = 1; s.transport.hub_state_refresh = true; });
  finish({ state: 'active' }); await task;
  assert.equal(readHomeState(home).transport.hub_state, undefined);
  assert.equal(readHomeState(home).transport.hub_state_refresh, true);
});

test('invalid token stops refreshing without erasing trust or history', async t => {
  const { home } = setup(t); let calls = 0;
  const observe = createHubObserver({ home, now, relay: { getHubState: async () => { calls++; throw { code: 'invalid_token' }; } } });
  await observe(); await observe();
  assert.equal(calls, 1); assert.equal(readHomeState(home).transport.hub_revoked, true);
  assert.equal(readHomeState(home).members.m_dev_1.state, 'confirmed');
});
