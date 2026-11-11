import assert from "node:assert/strict";
import { test } from "node:test";
import { Readable } from "node:stream";
import { runCli } from "../support/helpers.js";
import { saveSecrets } from "../../src/secrets.js";
import { saveConfig } from "../../src/config.js";
import { createThinTransport, parseRawInner } from "../../src/thin-transport.js";
import { b64uDecode, utf8 } from "../../src/encoding.js";
import { loadJson, loadVectors } from "../../src/protocol-files.js";
import { createGenericSender, createLocalValidator } from "../../src/send.js";
import { createCipherFiles } from "../../src/home-state.js";
import { createInbox } from "../../src/inbox.js";
import { loadSchemas } from "../../src/protocol-files.js";
import { setup, self, now, identity, delivery } from "../support/thin-transport.js";
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

const accessRequest = () => ({ v: 1, type: "access_request", request_ref: "a".repeat(32),
  created_at: "2026-11-05T12:00:00Z", expires_at: "2026-11-06T12:00:00Z", read: ["workout", "dietary_water", "workout"], write: ["dietary_water"] });
test("access validation normalizes lists and requires exactly 24 hours for older phones", () => {
  const validate = createLocalValidator(loadSchemas());
  const request = accessRequest(); validate(request);
  assert.deepEqual(request.read, ["dietary_water", "workout"]);
  for (const mutate of [r => r.expires_at = r.created_at, r => r.expires_at = "2026-11-06T13:00:00Z",
    r => r.expires_at = "2026-11-06T00:00:00Z", r => r.expires_at = "2026-11-06T11:59:59.999Z",
    r => r.expires_at = "2026-11-05T11:00:00Z", r => r.read = ["unknown_type"], r => r.write = ["biological_sex"],
    r => { r.read = []; r.write = []; }, r => r.reason = "x".repeat(201), r => delete r.read]) {
    const r = accessRequest(); mutate(r);
    assert.throws(() => validate(r), { code: "schema_invalid" });
  }
});
test("generic access send seals sorted unique lists for older phones even without validation", async t => {
  const { home, transport } = setup(t);
  await createGenericSender({ home, transport, self, now, schemas: loadSchemas() })({ type: "access_request", innerText: JSON.stringify(accessRequest()) });
  const entry = createCipherFiles(home, "outbox").list()[0];
  const opened = await transport.receive({ envelope: JSON.parse(entry.body), hubId: identity.hub_id,
    self: { memberId: keys.dev1.member_id, privateKey: b64uDecode(keys.dev1.sk) }, senderKeyOf: () => b64uDecode(keys.agent.pk) });
  assert.deepEqual(opened.inner.read, ["dietary_water", "workout"]);
});
test("agent validation requires exactly 24 hours even for phone-accepted short TTL vectors", () => {
  const vector = loadVectors("inner-messages").cases.find(c => c.name === "system_access_short_ttl");
  assert.equal(vector.expect, "ok");
  const request = JSON.parse(vector.json), validate = createLocalValidator(loadSchemas());
  const created = Date.parse(request.created_at);
  const expires = ttl => new Date(created + ttl).toISOString().replace(".000Z", "Z");
  for (const ttl of [1, 1800000, 86400000 - 1, 86400000 + 1]) {
    assert.throws(() => validate({ ...request, expires_at: expires(ttl) }),
      { code: "schema_invalid", message: "invalid access request: ttl" });
  }
  assert.doesNotThrow(() => validate({ ...request, expires_at: expires(86400000) }));
});
test("invalid access replies preserve outcome and detail through authenticated receive and raw inbox", async t => {
  const { home, transport } = setup(t);
  const inner = { v: 1, type: "access_reply", request_ref: "a".repeat(32), decided_at: "2026-11-05T12:00:00Z",
    outcome: "invalid", detail: "not_writable", read: [], write: [] };
  createLocalValidator(loadSchemas())(inner);
  const delivered = await delivery(transport, 1, inner);
  const opened = await transport.receive({ envelope: delivered, hubId: identity.hub_id, self, senderKeyOf: () => b64uDecode(keys.dev1.pk) });
  const inbox = createInbox(home);
  inbox.append({ seq: 1, from: keys.dev1.member_id, kind: "control", type: "access_reply", received_at: now().toISOString(), inner: opened.inner });
  assert.deepEqual(createInbox(home).read({ type: "access_reply" })[0].inner, inner);
});

test("CLI and MCP expose invalid access replies and MCP validates access requests by default", async t => {
  const { home } = setup(t);
  saveSecrets(home, { private_key: keys.agent.sk, public_key: keys.agent.pk, token: `sk_${identity.hub_id}_${"T".repeat(40)}`, webhook_secret: `whsec_${"W".repeat(43)}` });
  saveConfig(home, { relay_url: "http://127.0.0.1:8787", name: "Test" });
  const inner = { v: 1, type: "access_reply", request_ref: "a".repeat(32), decided_at: "2026-11-05T12:00:00Z",
    outcome: "invalid", detail: "ttl", read: [], write: [] };
  createInbox(home).append({ seq: 1, from: keys.dev1.member_id, kind: "control", type: "access_reply", received_at: now().toISOString(), inner });
  const options = { now, fetch: () => { assert.fail("local inbox and validation must stay offline"); } };
  const rejected = await runCli(["--home", home, "send", "--type", "access_request", "--json", "-", "--validate"], {
    ...options, stdin: Readable.from([JSON.stringify({ ...accessRequest(), expires_at: "2026-11-06T00:00:00Z" })]) });
  assert.equal(rejected.code, 4);
  assert.equal(JSON.parse(rejected.stderr.trim().split("\n").at(-1)).error, "schema_invalid");
  const cli = await runCli(["--home", home, "inbox", "--type", "access_reply"], options);
  assert.equal(cli.code, 0);
  assert.deepEqual(JSON.parse(cli.stdout).records[0].inner, inner);
  const rpc = (name, args, id) => JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const input = [rpc("syncky_inbox", { type: "access_reply" }, 1),
    rpc("syncky_send", { type: "access_request", inner: { ...accessRequest(), write: ["biological_sex"] }, validate: false }, 2),
    rpc("syncky_send", { type: "access_request", inner: { ...accessRequest(), expires_at: "2026-11-06T00:00:00Z" }, validate: false }, 3)].join("\n") + "\n";
  const mcp = await runCli(["--home", home, "mcp"], { ...options, stdin: Readable.from([input]) });
  assert.equal(mcp.code, 0);
  const replies = mcp.stdout.trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(replies[0].result.structuredContent.records[0].inner, inner);
  assert.equal(replies[1].result.structuredContent.code, "schema_invalid");
  assert.equal(replies[2].result.structuredContent.code, "schema_invalid");
  assert.equal(replies[2].result.isError, true);
  assert.deepEqual(createCipherFiles(home, "outbox").list(), []);
});

test("CLI and MCP refuse a write request for types computed by Apple before sending and still queue the same types for reading", async t => {
  const { home } = setup(t);
  saveSecrets(home, { private_key: keys.agent.sk, public_key: keys.agent.pk, token: `sk_${identity.hub_id}_${"T".repeat(40)}`, webhook_secret: `whsec_${"W".repeat(43)}` });
  saveConfig(home, { relay_url: "http://127.0.0.1:8787", name: "Test" });
  const computed = ["walking_step_length", "walking_speed"], sorted = [...computed].sort();
  const catalog = loadJson("types.json").types;
  for (const name of computed) assert.deepEqual([name, catalog.find(type => type.name === name).computed_by_apple], [name, true]);
  const options = { now, fetch: () => { assert.fail("local validation must stay offline"); } };
  const send = inner => runCli(["--home", home, "send", "--type", "access_request", "--json", "-", "--validate"], { ...options, stdin: Readable.from([JSON.stringify(inner)]) });
  const refused = await send({ ...accessRequest(), read: [], write: computed });
  assert.equal(refused.code, 4);
  assert.deepEqual(JSON.parse(refused.stderr.trim().split("\n").at(-1)), { error: "schema_invalid", detail: "not_writable", types: sorted });
  const mixed = await send({ ...accessRequest(), write: ["dietary_water", "walking_speed"] });
  assert.deepEqual(JSON.parse(mixed.stderr.trim().split("\n").at(-1)), { error: "schema_invalid", detail: "not_writable", types: ["walking_speed"] });
  const rpc = (inner, id) => JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "syncky_send", arguments: { type: "access_request", inner } } });
  const input = [rpc({ ...accessRequest(), read: [], write: computed }, 1),
    rpc({ ...accessRequest(), request_ref: "b".repeat(32), read: computed, write: [] }, 2)].join("\n") + "\n";
  const mcp = await runCli(["--home", home, "mcp"], { ...options, stdin: Readable.from([input]) });
  assert.equal(mcp.code, 0);
  const replies = mcp.stdout.trim().split("\n").map(line => JSON.parse(line));
  assert.equal(replies[0].result.isError, true);
  assert.deepEqual(replies[0].result.structuredContent, { code: "schema_invalid", detail: "not_writable", types: sorted });
  assert.equal(replies[1].result.isError, false);
  assert.equal(replies[1].result.structuredContent.state, "pending");
  assert.deepEqual(createCipherFiles(home, "outbox").list().map(entry => entry.type), ["access_request"]);
  const read = await send({ ...accessRequest(), request_ref: "c".repeat(32), read: computed, write: [] });
  assert.equal(read.code, 0);
  assert.equal(JSON.parse(read.stdout).state, "pending");
  assert.equal(createCipherFiles(home, "outbox").list().length, 2);
});
