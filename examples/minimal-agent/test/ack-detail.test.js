import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { tempHome } from "../../../agent/test/support/helpers.js";
import { generateKeys, handleMessage, loadState, saveState, sealEnvelope, uuidv7 } from "../agent.mjs";

test("stores and shows rejection details, omitting absent, malformed and non-rejected details", async t => {
  const cases = [
    { reason: "invalid", detail: "end_in_future", expected: "end_in_future" },
    { reason: "type_not_in_scope", detail: "declined_by_user", expected: "declined_by_user" },
    { reason: "invalid", detail: "future_detail", expected: "future_detail" },
    { reason: "invalid", detail: "a".repeat(32), expected: "a".repeat(32) },
    ...[undefined, null, 123, true, {}, [], ["bad_value"], "", "BAD_VALUE", "bad-value", "bad_value1", "a".repeat(33), "bad_value\n"].map(detail => ({ reason: "invalid", detail })),
    { status: "applied", detail: "bad_value" },
    { status: "deleted_by_user", detail: "bad_value" },
  ];
  const h = tempHome(); t.after(h.cleanup);
  const agent = await generateKeys(), device = await generateKeys();
  const commands = Object.fromEntries(cases.map((_, i) => [`c_${i + 1}`, { to: "m_dev_1", version: 1, msg_id: uuidv7(), state: "sent" }]));
  saveState(h.home, { relay: "http://127.0.0.1:9", name: "agent", hub_id: "hub_AAAAAAAAAAAAAAAAAAAAAA", member_id: "m_agent_1", ...agent, last_seq: 0,
    members: { m_dev_1: { name: "phone", pk: device.pk, state: "confirmed" } }, commands });
  const acks = cases.map(({ reason, detail, status = "rejected" }, i) => ({ command_id: `c_${i + 1}`, version: 1, status, reason, detail }));
  const plaintext = JSON.stringify({ v: 1, type: "sync", device: "m_dev_1", samples: [], deleted: [], acks, more: false });
  const envelope = await sealEnvelope({ hubId: "hub_AAAAAAAAAAAAAAAAAAAAAA", from: "m_dev_1", sk: device.sk, recipients: [{ member_id: "m_agent_1", pk: agent.pk }], plaintext });
  await handleMessage(h.home, loadState(h.home), { ...envelope, seq: 1 });
  const stored = loadState(h.home).commands;
  const shown = spawnSync(process.execPath, [fileURLToPath(new URL("../agent.mjs", import.meta.url)), "status"], { env: { ...process.env, SYNCKY_HOME: h.home }, encoding: "utf8" });
  assert.equal(shown.status, 0, shown.stderr);
  cases.forEach(({ reason, expected, status = "rejected" }, i) => {
    const id = `c_${i + 1}`, c = stored[id];
    assert.equal(c.state, status, id);
    assert.equal(Object.hasOwn(c, "detail"), expected !== undefined, id);
    assert.equal(c.detail, expected, id);
    const suffix = reason ? ` (${reason}${expected ? `/${expected}` : ""})` : "";
    assert.ok(shown.stdout.split("\n").includes(`command ${id} v1 dietary_water to m_dev_1: ${status}${suffix}`), id);
  });
});

test("an applied resend clears the previous rejection reason and detail from state and status", async t => {
  const h = tempHome(); t.after(h.cleanup);
  const agent = await generateKeys(), device = await generateKeys();
  saveState(h.home, { relay: "http://127.0.0.1:9", name: "agent", hub_id: "hub_AAAAAAAAAAAAAAAAAAAAAA", member_id: "m_agent_1", ...agent, last_seq: 0,
    members: { m_dev_1: { name: "phone", pk: device.pk, state: "confirmed" } },
    commands: { c_1: { to: "m_dev_1", version: 1, msg_id: uuidv7(), state: "sent" } } });
  const receive = async (seq, ack) => {
    const plaintext = JSON.stringify({ v: 1, type: "sync", device: "m_dev_1", samples: [], deleted: [], acks: [ack], more: false });
    const envelope = await sealEnvelope({ hubId: "hub_AAAAAAAAAAAAAAAAAAAAAA", from: "m_dev_1", sk: device.sk, recipients: [{ member_id: "m_agent_1", pk: agent.pk }], plaintext });
    await handleMessage(h.home, loadState(h.home), { ...envelope, seq });
  };
  await receive(1, { command_id: "c_1", version: 1, status: "rejected", reason: "invalid", detail: "end_in_future" });
  const state = loadState(h.home);
  assert.equal(state.commands.c_1.state, "rejected");
  assert.equal(state.commands.c_1.reason, "invalid");
  assert.equal(state.commands.c_1.detail, "end_in_future");
  Object.assign(state.commands.c_1, { version: 2, msg_id: uuidv7(), state: "sent" });
  saveState(h.home, state);
  await receive(2, { command_id: "c_1", version: 2, status: "applied" });
  const command = loadState(h.home).commands.c_1;
  assert.equal(command.state, "applied");
  assert.equal(Object.hasOwn(command, "reason"), false);
  assert.equal(Object.hasOwn(command, "detail"), false);
  const shown = spawnSync(process.execPath, [fileURLToPath(new URL("../agent.mjs", import.meta.url)), "status"], { env: { ...process.env, SYNCKY_HOME: h.home }, encoding: "utf8" });
  assert.equal(shown.status, 0, shown.stderr);
  assert.ok(shown.stdout.split("\n").includes("command c_1 v2 dietary_water to m_dev_1: applied"));
  assert.doesNotMatch(shown.stdout, /invalid|end_in_future/);
});
