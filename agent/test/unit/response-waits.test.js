import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activateResponseWaits, completeResponseWaits, hasResponseWait, maintainResponseWaits, responseWaitKey, responseWaitView, validResponseCorrelation } from '../../src/response-waits.js';
import { createCipherFiles, newHomeState, readHomeState, validateHomeState } from '../../src/home-state.js';
import { createInbox } from '../../src/inbox.js';
import { setup, identity, keys, now, messageId } from '../support/thin-transport.js';

const correlation = () => ({ kind: 'command', member_id: 'm_dev_1', public_key: keys.dev1.pk, command_id: 'one', version: 1,
  opened_at: now().getTime(), expires_at: null, inbox_after: 10 });
const acknowledgement = () => ({ v: 1, type: 'sync', acks: [{ command_id: 'one', version: 1, status: 'applied' }] });
function state() {
  const s = newHomeState(identity);
  s.members.m_dev_1 = { member_id: 'm_dev_1', role: 'device', state: 'confirmed', public_key: keys.dev1.pk };
  activateResponseWaits(s, [{ state: 'sent', sent_at: now().toISOString(), response_waits: [correlation()] }], now().getTime());
  return s;
}

test('wait correlations retain readable old rows while validating the independent cursor boundary', () => {
  const w = correlation(); assert.equal(validResponseCorrelation(w), true);
  const { inbox_after, ...old } = w; assert.equal(validResponseCorrelation(old), true);
  for (const value of [-2, 0.5, '1', null, Number.MAX_SAFE_INTEGER + 1]) assert.equal(validResponseCorrelation({ ...w, inbox_after: value }), false);
  for (const value of [-1, 0, 10]) assert.equal(validResponseCorrelation({ ...w, inbox_after: value }), true);
});

for (const cursor of [9, 10]) test(`cursor ${cursor} cannot complete a wait opened after that inbox row`, () => {
  const s = state(), w = s.transport.response_waits[responseWaitKey(correlation())];
  completeResponseWaits(s, 'm_dev_1', keys.dev1.pk, acknowledgement(), now().getTime(),
    { cursor, accepted_at: now().getTime() + 86400000, public_key: keys.dev1.pk });
  assert.equal(w.completed_at, undefined); validateHomeState(s);
});

test('a later admitted reply closes its wait despite a regressed receiver clock, and only once', () => {
  const s = state(), w = s.transport.response_waits[responseWaitKey(correlation())], at = now().getTime() - 86400000;
  completeResponseWaits(s, 'm_dev_1', keys.dev1.pk, acknowledgement(), at, { cursor: 11, accepted_at: at, public_key: keys.dev1.pk });
  assert.equal(w.completed_at, at);
  completeResponseWaits(s, 'm_dev_1', keys.dev1.pk, acknowledgement(), at + 1, { cursor: 12, accepted_at: at + 1, public_key: keys.dev1.pk });
  assert.equal(w.completed_at, at); validateHomeState(s);
});

test('history recovery checks the recorded key binding before completing a current wait', () => {
  const s = state(), w = s.transport.response_waits[responseWaitKey(correlation())];
  completeResponseWaits(s, 'm_dev_1', keys.dev1.pk, acknowledgement(), now().getTime(), { cursor: 11, public_key: keys.dev2.pk });
  assert.equal(w.completed_at, undefined);
});

test('outbox admission captures the inbox boundary under its existing lock and retries preserve it', t => {
  const { home } = setup(t), inbox = createInbox(home), queue = createCipherFiles(home, 'outbox');
  const record = seq => ({ seq, from: 'm_dev_1', kind: 'data', type: 'sync', received_at: now().toISOString(), inner: acknowledgement() });
  inbox.append(record(10));
  const { inbox_after, ...w } = correlation();
  const entry = { msg_id: messageId(100), kind: 'control', body: 'sealed', to: ['m_dev_1'], response_waits: [w] };
  assert.equal(queue.put(entry), true); assert.equal(queue.list()[0].response_waits[0].inbox_after, 10);
  inbox.append(record(11)); assert.equal(queue.put(entry), false);
  assert.equal(queue.list()[0].response_waits[0].inbox_after, 10);
  assert.equal(readHomeState(home).transport.cursor, 0);
});

test('legacy wait history recovery keeps the original local receipt boundary', () => {
  const s = state(), key = responseWaitKey(correlation()), w = s.transport.response_waits[key]; delete w.inbox_after;
  completeResponseWaits(s, 'm_dev_1', keys.dev1.pk, acknowledgement(), now().getTime(), { cursor: 11, received_at: new Date(w.opened_at - 1).toISOString() });
  assert.equal(w.completed_at, undefined);
  completeResponseWaits(s, 'm_dev_1', keys.dev1.pk, acknowledgement(), now().getTime(), { cursor: 12, received_at: new Date(w.opened_at).toISOString() });
  assert.equal(w.completed_at, now().getTime());
});

test('restoring a sent receipt preserves its original time boundary and any recorded cursor', t => {
  const { home } = setup(t), queue = createCipherFiles(home, 'outbox'), inbox = createInbox(home);
  inbox.append({ seq: 11, from: 'm_dev_1', kind: 'data', type: 'sync', received_at: now().toISOString(), inner: acknowledgement() });
  const { inbox_after, ...legacy } = correlation();
  for (const [i, w] of [legacy, correlation()].entries()) {
    const entry = { msg_id: messageId(100 + i), kind: 'control', body: 'sealed', to: ['m_dev_1'], state: 'sent',
      sent_at: now().toISOString(), response_waits: [w] };
    assert.equal(queue.put(entry), true); assert.equal(queue.put(entry), false);
    assert.deepEqual(queue.list().find(e => e.msg_id === entry.msg_id).response_waits, [w]);
  }
});

test('expired access notices are bounded, member-bound and no longer affect polling', () => {
  const s = state(), at = now().getTime();
  s.transport.response_waits = {};
  const correlations = Array.from({ length: 110 }, (_, i) => ({ kind: 'access', member_id: 'm_dev_1', public_key: keys.dev1.pk,
    opened_at: at, expires_at: at + i + 1, request_ref: i.toString(16).padStart(32, '0'), msg_id: messageId(i + 1),
    large_access: true, read: ['steps'], write: [] }));
  activateResponseWaits(s, [{ state: 'sent', sent_at: now().toISOString(), response_waits: correlations }], at);
  assert.equal(hasResponseWait(s, at), true);
  maintainResponseWaits(s, at + 110);
  assert.equal(hasResponseWait(s, at + 110), false);
  const expired = Object.values(s.transport.response_waits).map(w => responseWaitView(w, at + 110));
  assert.equal(expired.length, 100);
  assert.ok(expired.every(w => w.state === 'no_reply' && w.msg_id && !w.request_ref && !w.public_key && !w.read), 'expired wait leaked private correlation');
  s.members.m_dev_1.public_key = keys.dev2.pk;
  maintainResponseWaits(s, at + 110);
  assert.equal(Object.keys(s.transport.response_waits).length, 0);
});
