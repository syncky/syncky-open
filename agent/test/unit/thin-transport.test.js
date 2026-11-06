import assert from "node:assert/strict";
import { test } from "node:test";
import { createThinTransport, parseRawInner } from "../../src/thin-transport.js";
import { b64uDecode, utf8 } from "../../src/encoding.js";
import { loadVectors } from "../../src/protocol-files.js";
import { table, tablePath, keys } from "../support/thin-transport.js";

const transport = createThinTransport({ tablePath });
const keyOf = id => Object.values(keys).find(k => k.member_id === id);
for (const c of loadVectors("envelopes").cases) test(`thin unchanged vector: ${c.name}`, async () => {
  const sender = keys[c.sender];
  assert.equal(transport.aad(c.hub_id, c.envelope), c.aad);
  for (const r of c.recipients) {
    const options = { envelope: c.envelope, hubId: c.hub_id,
      self: { memberId: r.member_id, privateKey: b64uDecode(keys[r.key].sk) }, senderKeyOf: id => b64uDecode(keyOf(id).pk) };
    assert.deepEqual(await transport.open(options), utf8(c.plaintext));
    assert.equal((await transport.receive(options)).innerText, c.plaintext);
  }
  const sealed = await transport.seal({ hubId: c.hub_id, from: sender.member_id, senderPrivateKey: b64uDecode(sender.sk),
    recipients: c.recipients.map(r => ({ memberId: r.member_id, publicKey: b64uDecode(keyOf(r.member_id).pk) })),
    plaintext: c.plaintext, kind: c.envelope.kind, diagnostics: c.envelope.diagnostics, access: c.envelope.access,
    msgId: c.envelope.msg_id, createdAt: c.envelope.created_at,
    random: n => b64uDecode(n === 32 ? c.cek : c.nonce), ekmFor: id => b64uDecode(c.recipients.find(r => r.member_id === id).ikm_e) });
  assert.equal(transport.serialize(sealed), JSON.stringify(c.envelope));
});
for (const c of loadVectors("envelopes-negative").cases) test(`thin negative: ${c.name}`, async () => {
  await assert.rejects(transport.receive({ envelope: c.envelope, hubId: c.hub_id,
    self: { memberId: keys[c.receiver].member_id, privateKey: b64uDecode(keys[c.receiver].sk) },
    senderKeyOf: id => c.registry[id] ? b64uDecode(c.registry[id]) : null }), { code: c.expect });
});
for (const c of loadVectors("envelope-shape").cases) test(`thin shape: ${c.name}`, () => {
  const options = { caller: c.caller, activeMembers: c.members };
  assert.deepEqual(c.raw === undefined ? transport.validateShape(c.envelope, options) : transport.validateText(c.raw, options), c.expect);
});
test("raw parsing is bounded, strict UTF-8, object/string type only; fields and versions stay raw", () => {
  for (const x of ["null", "[]", "{}", '{"type":1}', new Uint8Array([0xff]), '{"type":"x",']) assert.throws(() => parseRawInner(x), { code: "inner_invalid" });
  assert.throws(() => parseRawInner('{"type":"x","x":' + '['.repeat(129) + '0' + ']'.repeat(129) + '}'), { code: "inner_invalid" });
  const text = '{ "type":"future", "v":99, "unknown":1e+2 }';
  assert.equal(parseRawInner(text).innerText, text);
  assert.throws(() => parseRawInner(text, { maxBytes: 10 }), { code: "inner_invalid" });
});
test("receive ignores unknown envelope and recipient fields while upload validation stays strict", async () => {
  const c = loadVectors("envelopes").cases[0];
  const options = { hubId: c.hub_id, from: keys.dev1.member_id, senderPrivateKey: b64uDecode(keys.dev1.sk), recipients: [{ memberId: keys.agent.member_id, publicKey: b64uDecode(keys.agent.pk) }] };
  const receive = envelope => transport.receive({ envelope, hubId: c.hub_id, self: { memberId: keys.agent.member_id, privateKey: b64uDecode(keys.agent.sk) }, senderKeyOf: () => b64uDecode(keys.dev1.pk) });
  const deep = JSON.parse('['.repeat(130) + '0' + ']'.repeat(130));
  for (const type of ["sync", "future", "access_request", "diagnostics_request"]) {
    const raw = `{ "type":"${type}", "v":999, "future":{"value":1e+2} }`;
    const envelope = await transport.sealMessage({ ...options, innerText: raw });
    const extended = { ...envelope, delivery: { attempt: 1, deep }, received_at: "future" };
    extended.recipients = envelope.recipients.map(r => ({ ...r, future: deep }));
    assert.equal(transport.validateShape(extended, { caller: envelope.from }).status, 400);
    assert.equal((await receive(extended)).innerText, raw);
    assert.equal(transport.serialize(extended), transport.serialize(envelope));
    const malformed = structuredClone(extended); delete malformed.recipients[0].enc;
    await assert.rejects(receive(malformed), { code: "malformed" });
    const tampered = structuredClone(extended); tampered.access = envelope.access === "request" ? "reply" : "request";
    await assert.rejects(receive(tampered));
  }
});
test("table injection supports new data marker families with no transport edit", async () => {
  const next = table(); next.markers.future = ["payload"];
  next.aad.marker_order.push("future"); next.canonical.envelope_fields.splice(3, 0, "future");
  next.messages.extension = { kind: "data", marker: { field: "future", value: "payload" }, max_envelope_bytes: 262144 };
  const tx = createThinTransport({ table: next }), c = loadVectors("envelopes").cases[0];
  const env = await tx.sealMessage({ hubId: c.hub_id, from: keys.dev1.member_id, senderPrivateKey: b64uDecode(keys.dev1.sk),
    recipients: [{ memberId: keys.agent.member_id, publicKey: b64uDecode(keys.agent.pk) }], innerText: '{"type":"extension","raw":true}' });
  assert.equal(env.future, "payload"); assert.equal(env.kind, "data");
  assert.equal((await tx.receive({ envelope: env, hubId: c.hub_id, self: { memberId: keys.agent.member_id, privateKey: b64uDecode(keys.agent.sk) }, senderKeyOf: () => b64uDecode(keys.dev1.pk) })).inner.type, "extension");
  for (const mutate of [e => delete e.future, e => e.future = "bad", e => e.kind = "control", e => e.access = "request"]) {
    const altered = structuredClone(env); mutate(altered);
    await assert.rejects(tx.receive({ envelope: altered, hubId: c.hub_id, self: { memberId: keys.agent.member_id, privateKey: b64uDecode(keys.agent.sk) }, senderKeyOf: () => b64uDecode(keys.dev1.pk) }));
  }
  assert.equal(transport.rule("extension").kind, "control");
});
test("unsupported table capabilities fail closed and leave the caller's table intact", () => {
  for (const alter of [t => t.schema_version++, t => t.aad.base = "other", t => t.aad.uses.pop(), t => t.limits.cek_bytes = 16, t => t.canonical.envelope_fields.pop()]) {
    const t = table(); alter(t); assert.throws(() => createThinTransport({ table: t }), { code: "protocol_incompatible" });
  }
  assert.equal(transport.rule("sync").kind, "data");
});

test("authenticated type/kind/marker mismatches fail before dispatch; target size is not a receive cap", async () => {
  const c = loadVectors("envelopes").cases[0];
  const options = { hubId: c.hub_id, from: keys.dev1.member_id, senderPrivateKey: b64uDecode(keys.dev1.sk), recipients: [{ memberId: keys.agent.member_id, publicKey: b64uDecode(keys.agent.pk) }] };
  const receive = envelope => transport.receive({ envelope, hubId: c.hub_id, self: { memberId: keys.agent.member_id, privateKey: b64uDecode(keys.agent.sk) }, senderKeyOf: () => b64uDecode(keys.dev1.pk) });
  const future = await transport.seal({ ...options, kind: "data", plaintext: '{"type":"future"}' });
  assert.equal((await receive(future)).inner.type, "future");
  await assert.rejects(receive({ ...future, kind: "control" }), { code: "hpke_open_failed" });
  for (const fields of [{ kind: "control", plaintext: '{"type":"sync"}' }, { kind: "control", diagnostics: "reply", plaintext: '{"type":"future"}' }, { kind: "control", plaintext: '{"type":"access_request"}' }]) {
    await assert.rejects(receive(await transport.seal({ ...options, ...fields })), { code: "inner_invalid" });
  }
  const raw = JSON.stringify({ type: "sync", extra: "x".repeat(180010) });
  assert.equal((await receive(await transport.sealMessage({ ...options, innerText: raw }))).innerText, raw);
  await assert.rejects(transport.sealMessage({ ...options, innerText: JSON.stringify({ type: "diagnostics", extra: "x".repeat(180010) }) }), { code: "inner_invalid" });
});
