import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { createRuntime } from '../../src/runtime.js';
import { createThinPoller } from '../../src/thin-poller.js';
import { createGenericSender } from '../../src/send.js';
import { runCli, tempHome } from '../support/helpers.js';
import { createFakePhone } from '../support/fake-phone.js';
import { startRelayDouble } from '../support/relay-double.js';
import { waitForSend } from '../support/send-receipt.js';

for (const mcp of [false, true]) test(`${mcp ? 'MCP' : 'CLI'} pending receipt waits for delayed receiver delivery of the same ciphertext`, { timeout: 10000 }, async t => {
  const tmp = tempHome(), relay = await startRelayDouble({ invite: 'delayed-send' });
  let receiver;
  t.after(async () => { await receiver?.stop(); await relay.stop(); tmp.cleanup(); });
  const cli = async (args, input = '') => {
    const result = await runCli(['--home', tmp.home, ...args], { env: {}, stdin: Readable.from([input]) });
    assert.equal(result.code, 0);
    return JSON.parse(result.stdout);
  };
  await cli(['init', '--name', 'Delayed send', '--relay', relay.url, '--invite', 'delayed-send']);
  const pairing = await cli(['pair', '--v1', '--json']);
  const phone = createFakePhone({ relayUrl: relay.url });
  await phone.pair(pairing.uri);
  const runtime = createRuntime({ home: tmp.home, env: {},
    createPoller: options => createThinPoller({ ...options, sleep: () => new Promise(() => {}) }) });
  await cli(['wait', '--json']);
  await cli(['confirm', phone.memberId, phone.fingerprint()]);
  relay.failNext('postMessage', 429, { 'Retry-After': '0' });
  const inner = { type: 'future_echo', private: 'DELAYED_SEND_CANARY' };
  const result = mcp
    ? await cli(['mcp'], JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'syncky_send', arguments: { type: inner.type, inner, to: phone.memberId } } }) + '\n')
    : await cli(['send', '--type', inner.type, '--to', phone.memberId, '--json', '-'], JSON.stringify(inner));
  if (mcp) assert.equal(result.result.isError, false);
  const receipt = mcp ? result.result.structuredContent : result;
  assert.equal(receipt.state, 'pending');
  const delivery = relay.gateNext('postMessage');
  receiver = runtime.poller.start();
  await delivery.entered;
  let pendingReads = 0;
  const delivered = await waitForSend(receipt, () => {
    const status = runtime.status();
    if (status.sends.find(row => row.msg_id === receipt.msg_id)?.state === 'pending') pendingReads++;
    return status;
  }, { sleep: async () => { delivery.release(); await runtime.outbox.flush(); } });
  assert.ok(pendingReads > 0, 'wait observes pending while relay delivery is delayed');
  assert.equal(delivered.msg_id, receipt.msg_id);
  assert.equal(delivered.state, 'sent');
  await phone.fetchCommands();
  assert.ok(phone.controlReceived.some(row => row.msg_id === receipt.msg_id), 'phone authenticated the waited-for message');
  const posts = relay.state.requests.filter(row => row.route === 'postMessage' && JSON.parse(row.body).msg_id === receipt.msg_id);
  assert.equal(posts.length, 2);
  assert.equal(posts[0].body, posts[1].body);

  const queued = await createGenericSender({ home: tmp.home, transport: runtime.transport, self: runtime.self })({ type: inner.type, innerText: JSON.stringify(inner), to: phone.memberId });
  const queuedDelivery = relay.gateNext('postMessage');
  let firstRead = true;
  const posting = runtime.outbox.flush();
  await queuedDelivery.entered;
  await waitForSend(queued, () => {
    const status = runtime.status();
    if (firstRead) {
      assert.equal(status.sends.find(row => row.msg_id === queued.msg_id).state, 'pending');
      firstRead = false;
    }
    return status;
  }, { sleep: async () => { queuedDelivery.release(); await posting; } });
  await posting;
});

test('send receipt waits for its message and reports timeout or terminal failure without private data', async () => {
  const receipt = { msg_id: 'target', state: 'pending' };
  let reads = 0;
  const sent = await waitForSend(receipt, () => ({ sends: [
    { msg_id: 'unrelated', state: 'sent' }, { msg_id: 'target', state: ++reads === 3 ? 'sent' : 'pending' },
  ] }));
  assert.equal(sent.msg_id, 'target'); assert.equal(reads, 3);
  await assert.rejects(waitForSend(receipt, () => ({ sends: [{ ...receipt, private: 'PRIVATE' }] }), { timeoutMs: 0 }),
    { message: 'timed out waiting for queued message to reach sent in status.sends' });
  await assert.rejects(waitForSend(receipt, () => ({ sends: [{ ...receipt, state: 'failed', code: 'PRIVATE' }] })),
    { message: 'queued send failed before relay delivery' });
  await assert.rejects(waitForSend({ ...receipt, state: 'failed', code: 'PRIVATE' }, () => { throw Error(); }),
    { message: 'send did not queue a message' });
});
