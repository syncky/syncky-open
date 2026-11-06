import assert from "node:assert/strict";
import { test } from "node:test";
import { createGenericSender, createLocalValidator } from "../../src/send.js";
import { createCipherFiles } from "../../src/home-state.js";
import { b64uDecode } from "../../src/encoding.js";
import { loadSchemas } from "../../src/protocol-files.js";
import { setup, self, now, identity, keys } from "../support/thin-transport.js";

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
