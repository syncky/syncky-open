import assert from "node:assert/strict";
import { test } from "node:test";
import { createGenericSender, createLocalValidator } from "../../src/send.js";
import { createCipherFiles } from "../../src/home-state.js";
import { b64uDecode } from "../../src/encoding.js";
import { loadJson, loadSchemas, loadVectors } from "../../src/protocol-files.js";
import { validateAccessScope, accessEnvelopeSizes } from '../../src/access-scope.js';
import { setup, self, now, identity, keys } from "../support/thin-transport.js";

test('shared access validation normalizes lists, enforces catalog/writability/size and stays opt-in for send', async t => {
  const { home, transport } = setup(t), validate = createLocalValidator(loadSchemas());
  const base = { v: 1, type: 'access_request', request_ref: 'a'.repeat(32), created_at: now().toISOString().replace('.000Z', 'Z'),
    expires_at: new Date(now().getTime() + 86400000).toISOString().replace('.000Z', 'Z'), read: ['steps', 'body_mass', 'steps'], write: ['body_mass'] };
  validate(base); assert.deepEqual(base.read, ['body_mass', 'steps']);
  for (const patch of [{ read: ['PRIVATE_CANARY'] }, { write: ['workout'] }, { read: [], write: [] }]) {
    assert.throws(() => validate({ ...base, ...patch }), e => e.code === 'schema_invalid' && !e.message.includes('PRIVATE_CANARY'));
  }
  assert.throws(() => validate({ ...base, write: ['walking_speed', 'body_mass', 'vo2_max'] }),
    { code: 'schema_invalid', message: 'invalid access request: not_writable', detail: 'not_writable', types: ['vo2_max', 'walking_speed'] });
  assert.doesNotThrow(() => validate({ ...base, read: ['walking_speed', 'vo2_max'], write: [] }));
  assert.throws(() => validate({ ...base, read: ['PRIVATE_CANARY'], write: ['walking_speed'] }), e => e.detail === 'unknown_type' && e.types === undefined);
  const vector = loadVectors('pair-uris').cases.find(c => c.name === 'scope_v1_envelope_3_reply_4097');
  const params = new URLSearchParams(new URL(vector.uri).hash.slice(1));
  assert.throws(() => validate({ ...base, read: JSON.parse(params.get('read')), write: JSON.parse(params.get('write')) }), { code: 'schema_invalid' });
  const send = createGenericSender({ home, transport, self, now });
  const innerText = JSON.stringify({ ...base, read: ['future_type'], write: [] });
  assert.equal((await send({ type: 'access_request', innerText })).state, 'pending');
  await assert.rejects(send({ type: 'access_request', innerText, validate: true }), { code: 'schema_invalid' });
});

test('ordinary request validation budgets extended refusals and aliases without changing pairing limits', () => {
  const names = loadJson('types.json').types.map(t => t.name).sort(), validate = createLocalValidator(loadSchemas());
  const base = { v: 1, type: 'access_request', request_ref: 'a'.repeat(32), created_at: now().toISOString().replace('.000Z', 'Z'),
    expires_at: new Date(now().getTime() + 86400000).toISOString().replace('.000Z', 'Z'), write: [] };
  let prior;
  for (let count = 1; count <= names.length; count++) {
    const inner = { ...base, read: names.slice(0, count) }, sizes = accessEnvelopeSizes(inner, { request: inner });
    if (Math.max(...Object.values(sizes)) <= 4096) { prior = inner; continue; }
    assert.ok(prior); assert.doesNotThrow(() => validate(prior));
    assert.equal(validateAccessScope(inner).ok, true);
    assert.throws(() => validate(inner), { code: 'schema_invalid', message: 'invalid access request: too_large' });
    return;
  }
  assert.fail('expected an extended-reply size boundary within the catalog');
});

test("generic send queues one sealed unknown control and returns only metadata", async t => {
  const { home, transport } = setup(t);
  const send = createGenericSender({ home, transport, self, now });
  const raw = '{ "type":"future", "v":999, "extra":true }';
  const receipt = await send({ type: "future", innerText: raw, validate: true });
  assert.deepEqual(Object.keys(receipt).sort(), ["kind", "msg_id", "state", "to", "type"].sort());
  const [entry] = createCipherFiles(home, "outbox").list();
  assert.equal(entry.kind, "control"); assert.equal(entry.state, "pending");
  const opened = await transport.receive({ envelope: JSON.parse(entry.body), hubId: identity.hub_id,
    self: { memberId: keys.dev1.member_id, privateKey: b64uDecode(keys.dev1.sk) }, senderKeyOf: () => b64uDecode(keys.agent.pk) });
  assert.equal(opened.innerText, raw);
  await assert.rejects(send({ type: "other", innerText: raw }), { code: "invalid_input" });
});
test("local schemas discover type consts in defs; missing schemas pass; refs never fetch", () => {
  const validate = createLocalValidator(loadSchemas());
  validate({ type: "future", v: 999 });
  validate({ type: "resumed", v: 1 });
  assert.throws(() => validate({ type: "resumed", v: 999 }), { code: "schema_invalid" });
  const hostile = createLocalValidator([{ $id: "https://example.invalid/local", $defs: { future: { properties: { type: { const: "future" } }, $ref: "https://example.invalid/remote" } } }]);
  assert.throws(() => hostile({ type: "future" }), { code: "schema_invalid" });
  hostile({ type: "absent" });
});
test("unconfirmed and ambiguous recipients cannot be sent to", async t => {
  const { home, transport } = setup(t, { confirmed: false });
  await assert.rejects(createGenericSender({ home, transport, self, now })({ type: "future", innerText: '{"type":"future"}', to: "m_dev_1" }), { code: "target_not_confirmed" });
});
