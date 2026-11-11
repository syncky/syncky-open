import assert from "node:assert/strict";
import { test } from "node:test";
import { createGenericSender, createLocalValidator } from "../../src/send.js";
import { createCipherFiles, readHomeState, updateHomeState } from "../../src/home-state.js";
import { createThinInbound } from "../../src/thin-inbound.js";
import { localStatus } from "../../src/runtime.js";
import { b64uDecode } from "../../src/encoding.js";
import { loadSchemas } from "../../src/protocol-files.js";
import { setup, self, now, identity, keys, delivery } from "../support/thin-transport.js";

const phone = keys.dev1.member_id;
const release = (read, write = []) => JSON.stringify({ v: 1, type: "scope_release", read, write });
const sender = (home, transport) => createGenericSender({ home, transport, self, now, schemas: loadSchemas() });
const sent = (home, msgId, seq) => createCipherFiles(home, "outbox").update(msgId, { state: "sent", seq, sent_at: now().toISOString() });
const status = home => localStatus(home, { status: () => ({}) }, now().getTime()).members.find(m => m.member_id === phone);
const sync = (transport, seq, scope) => delivery(transport, seq, { v: 1, type: "sync", samples: [], deleted: [], acks: [], more: false, scope });

test("a release is validated without the flag, normalized, sealed as a plain control and tracked as pending", async t => {
  const { home, transport } = setup(t), send = sender(home, transport);
  for (const [inner, detail] of [[release([], []), "empty"], [release(["PRIVATE_CANARY"]), "unknown_type"], [release([], ["workout"]), "not_writable"],
    [JSON.stringify({ v: 1, type: "scope_release", read: "all", write: [] }), "malformed"], [JSON.stringify({ v: 1, type: "scope_release", read: ["steps"] }), "malformed"]]) {
    await assert.rejects(send({ type: "scope_release", innerText: inner }), e => e.code === "schema_invalid" && e.message === `invalid scope release: ${detail}`);
  }
  await assert.rejects(send({ type: "scope_release", innerText: JSON.stringify({ v: 1, type: "scope_release", read: ["steps"], write: [], reason: "x" }) }), { code: "schema_invalid" });
  assert.equal(createCipherFiles(home, "outbox").list().length, 0);
  assert.equal(readHomeState(home).members[phone].scope_release, undefined);

  const receipt = await send({ type: "scope_release", innerText: release(["steps", "sleep_analysis", "steps"], ["body_mass"]) });
  const [entry] = createCipherFiles(home, "outbox").list(), envelope = JSON.parse(entry.body);
  assert.equal(entry.kind, "control");
  assert.deepEqual(Object.keys(envelope).filter(k => ["access", "diagnostics"].includes(k)), []);
  const opened = await transport.receive({ envelope, hubId: identity.hub_id,
    self: { memberId: phone, privateKey: b64uDecode(keys.dev1.sk) }, senderKeyOf: () => b64uDecode(keys.agent.pk) });
  assert.deepEqual(opened.inner, { v: 1, type: "scope_release", read: ["sleep_analysis", "steps"], write: ["body_mass"] });
  assert.deepEqual(readHomeState(home).members[phone].scope_release,
    { msg_id: receipt.msg_id, read: ["sleep_analysis", "steps"], write: ["body_mass"], requested_at: now().getTime(), state: "pending" });
  assert.deepEqual(status(home).scope_release, { read: ["sleep_analysis", "steps"], write: ["body_mass"], requested_at: now().getTime(), state: "pending" });
});

test("the local validator sorts and deduplicates a release in place", () => {
  const validate = createLocalValidator(loadSchemas());
  const inner = { v: 1, type: "scope_release", read: ["steps", "body_mass", "steps"], write: [] };
  validate(inner);
  assert.deepEqual(inner.read, ["body_mass", "steps"]);
});

test("the first sync the relay accepted after the release settles it as applied", async t => {
  const { home, transport } = setup(t), inbound = createThinInbound({ home, transport, self, now });
  await inbound.receive(await sync(transport, 1, { read: ["sleep_analysis", "steps"], write: "all" }));
  const receipt = await sender(home, transport)({ type: "scope_release", innerText: release(["sleep_analysis"], ["body_mass"]) });

  await inbound.receive(await sync(transport, 2, { read: ["sleep_analysis", "steps"], write: "all" }));
  assert.equal(status(home).scope_release.state, "pending", "an unsent release is never judged");

  sent(home, receipt.msg_id, 5);
  await inbound.receive(await sync(transport, 4, { read: ["sleep_analysis", "steps"], write: "all" }));
  assert.equal(status(home).scope_release.state, "pending", "a sync the relay accepted before the release proves nothing");

  await inbound.receive(await sync(transport, 6, { read: ["steps"], write: ["dietary_water"] }));
  assert.equal(status(home).scope_release.state, "applied");
  assert.deepEqual(status(home).scope, { read: ["steps"], write: ["dietary_water"], seq: 6 });

  await inbound.receive(await sync(transport, 7, { read: "all", write: "all" }));
  assert.equal(status(home).scope_release.state, "applied", "a later owner change does not reopen an applied release");
});

test("a phone that still announces the released types is reported as not supporting the release until it narrows", async t => {
  const { home, transport } = setup(t), inbound = createThinInbound({ home, transport, self, now });
  const receipt = await sender(home, transport)({ type: "scope_release", innerText: release(["sleep_analysis"]) });
  sent(home, receipt.msg_id, 3);

  await inbound.receive(await sync(transport, 4, { read: "all", write: "none" }));
  assert.equal(status(home).scope_release.state, "not_supported");

  await inbound.receive(await sync(transport, 5, { read: ["sleep_analysis", "steps"], write: "none" }));
  assert.equal(status(home).scope_release.state, "not_supported");

  await inbound.receive(await sync(transport, 6, { read: "none", write: "none" }));
  assert.equal(status(home).scope_release.state, "applied");
});

test("a second release before the first settles tracks both sets of names; one after it starts over", async t => {
  const { home, transport } = setup(t), inbound = createThinInbound({ home, transport, self, now }), send = sender(home, transport);
  await send({ type: "scope_release", innerText: release(["steps"]) });
  const second = await send({ type: "scope_release", innerText: release(["sleep_analysis"], ["body_mass"]) });
  assert.deepEqual(status(home).scope_release, { read: ["sleep_analysis", "steps"], write: ["body_mass"], requested_at: now().getTime(), state: "pending" });

  sent(home, second.msg_id, 2);
  await inbound.receive(await sync(transport, 3, { read: ["heart_rate"], write: "none" }));
  assert.equal(status(home).scope_release.state, "applied");

  await send({ type: "scope_release", innerText: release(["heart_rate"]) });
  assert.deepEqual(status(home).scope_release, { read: ["heart_rate"], write: [], requested_at: now().getTime(), state: "pending" });
});

test("a release that could not be sent is reported as failed, and a pruned receipt never turns into a verdict", async t => {
  const { home, transport } = setup(t), inbound = createThinInbound({ home, transport, self, now }), send = sender(home, transport);
  const failed = await send({ type: "scope_release", innerText: release(["steps"]) });
  createCipherFiles(home, "outbox").update(failed.msg_id, { state: "failed", code: "send_failed" });
  assert.equal(status(home).scope_release.state, "failed", "status says so before any sync arrives");
  assert.equal(readHomeState(home).members[phone].scope_release.state, "pending");
  await inbound.receive(await sync(transport, 2, { read: "all", write: "none" }));
  assert.equal(status(home).scope_release.state, "failed");
  await inbound.receive(await sync(transport, 3, { read: "none", write: "none" }));
  assert.equal(status(home).scope_release.state, "failed", "a failed release is not re-judged");

  const lost = await send({ type: "scope_release", innerText: release(["heart_rate"]) });
  assert.deepEqual(status(home).scope_release.read, ["heart_rate"], "a new release after a failed one starts over");
  createCipherFiles(home, "outbox").remove(lost.msg_id);
  await inbound.receive(await sync(transport, 4, { read: "all", write: "none" }));
  assert.equal(status(home).scope_release.state, "pending");

  const kept = await send({ type: "scope_release", innerText: release(["heart_rate"]) });
  sent(home, kept.msg_id, 5);
  await inbound.receive(await sync(transport, 5, { read: "all", write: "none" }));
  createCipherFiles(home, "outbox").remove(kept.msg_id);
  await inbound.receive(await sync(transport, 6, { read: "all", write: "none" }));
  assert.equal(status(home).scope_release.state, "not_supported", "the recorded send still orders later syncs after the receipt is pruned");
});

test("a release sent after a failed one does not inherit the failed names, even before any sync", async t => {
  const { home, transport } = setup(t), inbound = createThinInbound({ home, transport, self, now }), send = sender(home, transport);
  const failed = await send({ type: "scope_release", innerText: release(["steps"]) });
  createCipherFiles(home, "outbox").update(failed.msg_id, { state: "failed", code: "send_failed" });

  const next = await send({ type: "scope_release", innerText: release(["sleep_analysis"]) });
  assert.deepEqual(status(home).scope_release.read, ["sleep_analysis"]);
  sent(home, next.msg_id, 2);
  await inbound.receive(await sync(transport, 3, { read: ["steps"], write: "none" }));
  assert.equal(status(home).scope_release.state, "applied");
});

test("a malformed stored release is a corrupt home", t => {
  const { home } = setup(t);
  for (const bad of [{ msg_id: "x", read: ["steps"], write: [], requested_at: 1, state: "pending" },
    { msg_id: "01900000-0000-7000-8000-000000000001", read: ["steps", "steps"], write: [], requested_at: 1, state: "pending" },
    { msg_id: "01900000-0000-7000-8000-000000000001", read: [], write: [], requested_at: 1, state: "pending" },
    { msg_id: "01900000-0000-7000-8000-000000000001", read: ["steps"], write: [], requested_at: 1, state: "done" },
    { msg_id: "01900000-0000-7000-8000-000000000001", read: ["steps"], write: [], requested_at: 1, state: "pending", sent_seq: -1 }]) {
    assert.throws(() => updateHomeState(home, s => { s.members[phone].scope_release = bad; }), { code: "corrupt_state" });
  }
});
