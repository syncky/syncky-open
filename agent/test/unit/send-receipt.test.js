import assert from 'node:assert/strict';
import { cpSync } from 'node:fs';
import { Readable } from 'node:stream';
import { after, before, describe, test } from 'node:test';
import { createRuntime } from '../../src/runtime.js';
import { createThinPoller } from '../../src/thin-poller.js';
import { createGenericSender } from '../../src/send.js';
import { runCli, tempHome } from '../support/helpers.js';
import { createFakePhone } from '../support/fake-phone.js';
import { startRelayDouble } from '../support/relay-double.js';
import { waitForSend } from '../support/send-receipt.js';

function receiptClock() {
  let at = Date.parse('2026-01-01T00:00:00Z'), scheduled = 0;
  const pending = new Map();
  const advance = ms => {
    at += ms;
    for (const [id, timer] of pending) if (timer.at <= at) { pending.delete(id); timer.callback(); }
  };
  return {
    now: () => new Date(at), nowMs: () => at, advance, sleep: async ms => advance(ms),
    get pending() { return pending.size; },
    get scheduled() { return scheduled; },
    timers: {
      setTimeout(callback, ms) { const id = ++scheduled; pending.set(id, { callback, at: at + ms }); return id; },
      clearTimeout: id => pending.delete(id),
    },
  };
}

describe('pending send receipts', () => {
  let prepared, relay, phone, pairedHub, relayNow;
  const cli = async (clock, home, args, input = '') => {
    const scheduled = clock.scheduled;
    const result = await runCli(['--home', home, ...args], {
      env: {}, stdin: Readable.from([input]), now: clock.now, sleep: clock.sleep, timers: clock.timers,
    });
    assert.equal(result.code, 0);
    assert.ok(clock.scheduled > scheduled, 'CLI requests use the injected timers');
    assert.equal(clock.pending, 0);
    return JSON.parse(result.stdout);
  };
  before(async () => {
    const clock = receiptClock();
    relayNow = clock.nowMs;
    prepared = tempHome();
    relay = await startRelayDouble({ invite: 'delayed-send', now: () => relayNow() });
    await cli(clock, prepared.home, ['init', '--name', 'Delayed send', '--relay', relay.url, '--invite', 'delayed-send']);
    const pairing = await cli(clock, prepared.home, ['pair', '--v1', '--json']);
    phone = createFakePhone({ relayUrl: relay.url });
    await phone.pair(pairing.uri);
    await cli(clock, prepared.home, ['wait', '--json']);
    await cli(clock, prepared.home, ['confirm', phone.memberId, phone.fingerprint()]);
    pairedHub = structuredClone(relay.state.hub());
  }, { timeout: 10000 });
  after(async () => { await relay?.stop(); prepared?.cleanup(); });

  for (const mcp of [false, true]) test(`${mcp ? 'MCP' : 'CLI'} pending receipt waits for delayed receiver delivery of the same ciphertext`, { timeout: 10000 }, async t => {
    const clock = receiptClock();
    relayNow = clock.nowMs;
    relay.state.hubs.set(pairedHub.hubId, structuredClone(pairedHub));
    relay.state.requests.length = 0;
    phone.controlReceived.length = 0;
    phone.openFailures.length = 0;
    const tmp = tempHome();
    cpSync(prepared.home, tmp.home, { recursive: true });
    let receiver, delivery, queuedDelivery, posting;
    t.after(async () => {
      delivery?.release(); queuedDelivery?.release();
      await posting; await receiver?.stop(); tmp.cleanup(); assert.equal(clock.pending, 0);
    });
    const runtime = createRuntime({ home: tmp.home, env: {}, now: clock.now, sleep: clock.sleep, timers: clock.timers,
      createPoller: options => createThinPoller({ ...options, sleep: () => new Promise(() => {}) }) });
    relay.failNext('postMessage', 429, { 'Retry-After': '17' });
    const inner = { type: 'future_echo', private: 'DELAYED_SEND_CANARY' };
    const result = mcp
      ? await cli(clock, tmp.home, ['mcp'], JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'syncky_send', arguments: { type: inner.type, inner, to: phone.memberId } } }) + '\n')
      : await cli(clock, tmp.home, ['send', '--type', inner.type, '--to', phone.memberId, '--json', '-'], JSON.stringify(inner));
    if (mcp) assert.equal(result.result.isError, false);
    const receipt = mcp ? result.result.structuredContent : result;
    assert.equal(receipt.state, 'pending');
    assert.equal(receipt.retry_after_until, clock.nowMs() + 17000);
    await runtime.outbox.flush();
    assert.equal(relay.state.requests.filter(row => row.route === 'postMessage' && JSON.parse(row.body).msg_id === receipt.msg_id).length, 1);
    clock.advance(17000);
    delivery = relay.gateNext('postMessage');
    receiver = runtime.poller.start();
    await delivery.entered;
    let pendingReads = 0;
    const delivered = await waitForSend(receipt, () => {
      const status = runtime.status();
      if (status.sends.find(row => row.msg_id === receipt.msg_id)?.state === 'pending') pendingReads++;
      return status;
    }, { now: clock.nowMs, sleep: async () => { assert.equal(pendingReads, 1); delivery.release(); await runtime.outbox.flush(); } });
    assert.ok(pendingReads > 0, 'wait observes pending while relay delivery is delayed');
    assert.equal(delivered.msg_id, receipt.msg_id);
    assert.equal(delivered.state, 'sent');
    await phone.fetchCommands();
    assert.ok(phone.controlReceived.some(row => row.msg_id === receipt.msg_id), 'phone authenticated the waited-for message');
    const posts = relay.state.requests.filter(row => row.route === 'postMessage' && JSON.parse(row.body).msg_id === receipt.msg_id);
    assert.equal(posts.length, 2);
    assert.equal(posts[0].body, posts[1].body);
    await receiver.stop();

    const queued = await createGenericSender({ home: tmp.home, transport: runtime.transport, self: runtime.self, now: clock.now })({ type: inner.type, innerText: JSON.stringify(inner), to: phone.memberId });
    queuedDelivery = relay.gateNext('postMessage');
    let firstRead = true, queuedSleeps = 0;
    posting = runtime.outbox.flush();
    await queuedDelivery.entered;
    await waitForSend(queued, () => {
      const status = runtime.status();
      if (firstRead) {
        assert.equal(status.sends.find(row => row.msg_id === queued.msg_id).state, 'pending');
        firstRead = false;
      }
      return status;
    }, { now: clock.nowMs, sleep: async () => { assert.equal(queuedSleeps++, 0); queuedDelivery.release(); await posting; } });
    await posting;
  });
});

test('send receipt waits for its message and reports timeout or terminal failure without private data', async () => {
  const receipt = { msg_id: 'target', state: 'pending' };
  const clock = receiptClock(), options = { now: clock.nowMs, sleep: clock.sleep };
  let reads = 0;
  const sent = await waitForSend(receipt, () => ({ sends: [
    { msg_id: 'unrelated', state: 'sent' }, { msg_id: 'target', state: ++reads === 3 ? 'sent' : 'pending' },
  ] }), options);
  assert.equal(sent.msg_id, 'target'); assert.equal(reads, 3);
  const at = clock.nowMs();
  await assert.rejects(waitForSend(receipt, () => ({ sends: [{ ...receipt, private: 'PRIVATE' }] }), { ...options, timeoutMs: 0 }),
    { message: 'timed out waiting for queued message to reach sent in status.sends' });
  assert.equal(clock.nowMs(), at + 10);
  await assert.rejects(waitForSend(receipt, () => ({ sends: [{ ...receipt, state: 'failed', code: 'PRIVATE' }] }), options),
    { message: 'queued send failed before relay delivery' });
  await assert.rejects(waitForSend({ ...receipt, state: 'failed', code: 'PRIVATE' }, () => { throw Error(); }, options),
    { message: 'send did not queue a message' });
});
