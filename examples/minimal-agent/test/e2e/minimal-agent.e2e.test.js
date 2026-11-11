import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { pairCode as fullAgentPairCode } from "../../../../agent/src/pair-code.js";
import { FakePhoneError, createFakePhone, sevenDaysOfStepsAndHeartRate } from "../../../../agent/test/support/fake-phone.js";
import { tempHome, waitFor } from "../../../../agent/test/support/helpers.js";
import { generateKeys, loadState } from "../../agent.mjs";

const RELAY = process.env.SYNCKY_E2E_RELAY;
const AGENT = fileURLToPath(new URL("../../agent.mjs", import.meta.url));
const TEST_TIMEOUT_MS = 120_000;
const WAIT = { timeoutMs: 60_000, intervalMs: 200 };
const DAY_END = new Date("2026-10-12T10:00:00Z");
const MARKER_VALUE = 73.123457;

const SKIP = RELAY ? false : "SYNCKY_E2E_RELAY is not set; point it at a relay to run these tests";

describe("minimal agent against the real relay (wrangler dev)", { skip: SKIP }, () => {
  const homes = [];
  const outputs = [];
  const secrets = [];

  function start(home, args) {
    const env = { ...process.env, SYNCKY_HOME: home };
    for (const key of ["SYNCKY_E2E_RELAY", "SYNCKY_E2E_INVITE"]) delete env[key];
    const child = spawn(process.execPath, [AGENT, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    const proc = { child, stdout: "", stderr: "" };
    child.stdout.on("data", (c) => (proc.stdout += c));
    child.stderr.on("data", (c) => (proc.stderr += c));
    proc.exited = new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (status) => {
        outputs.push({ what: `minimal agent ${args[0]}`, stdout: proc.stdout, stderr: proc.stderr, pairing: args[0] === "pair" });
        resolve({ status, stdout: proc.stdout, stderr: proc.stderr });
      });
    });
    proc.waitFor = (re, what) => waitFor(() => re.exec(proc.stdout), { ...WAIT, what: `${what} in the output of ${args[0]}` });
    return proc;
  }

  async function run(home, args) {
    const proc = start(home, args);
    proc.child.stdin.end();
    const res = await proc.exited;
    assert.equal(res.status, 0, `${args.join(" ")} exited ${res.status}: ${res.stderr}`);
    return res.stdout;
  }

  async function initAgent(name) {
    const h = tempHome();
    homes.push(h);
    const out = await run(h.home, ["init", "--relay", RELAY, "--name", name]);
    const state = loadState(h.home);
    assert.match(out, new RegExp(`^Registered ${state.member_id} in ${state.hub_id}\\.`));
    secrets.push(["agent token", state.token], ["agent private key", state.sk]);
    return { home: h.home, state };
  }

  async function pairWithPhone(home, phoneName, proofFor = (phone) => phone.pairProof()) {
    const proc = start(home, ["pair", "--wait", "60"]);
    const [, uri] = await proc.waitFor(/^(https:\/\/syncky\.app\/pair#v=2&\S+)\n/m, "the pairing URI");
    const params = new URLSearchParams(new URL(uri).hash.slice(1));
    for (const key of ["t", "c"]) assert.ok(params.get(key), `pairing URI lacks ${key} credential`);
    secrets.push(["pairing token", params.get("t")], ["pairing secret", params.get("c")]);
    const [, code] = await proc.waitFor(/^code: (\d{3} \d{3} \d{3})\n/m, "the pairing code");
    assert.equal(code, fullAgentPairCode(params.get("c")));
    const phone = createFakePhone({ relayUrl: RELAY, name: phoneName });
    await phone.pair(uri);
    assert.equal(phone.pairSecret, params.get("c"));
    secrets.push(["phone token", phone.token], ["pair proof", phone.pairProof()]);
    await proc.waitFor(new RegExp(`\\(${phone.memberId}\\) joined\\. Waiting for it to pick the code`), "the join");
    await phone.sendPairProof({ proof: await proofFor(phone) });
    proc.child.stdin.end();
    return { paired: await proc.exited, phone };
  }

  const agentPending = async (state) => {
    const res = await fetch(`${RELAY}/v1/messages`, { headers: { Authorization: `Bearer ${state.token}`, Accept: "application/json" } });
    assert.equal(res.status, 200);
    return (await res.json()).messages;
  };

  before(async () => {
    const health = await fetch(`${RELAY}/v1/health`);
    assert.equal(health.status, 200, "the relay under SYNCKY_E2E_RELAY is not healthy");
  });

  after(() => homes.forEach((h) => h.cleanup()));

  it("pairs by the phone's proof without a prompt, receives a day of steps and heart rate, sends water and sees the phone's app ack", { timeout: TEST_TIMEOUT_MS }, async () => {
    const { home, state } = await initAgent("E2E minimal agent");
    const { paired, phone } = await pairWithPhone(home, "E2E iPhone");
    assert.equal(paired.status, 0, paired.stderr);
    assert.equal(phone.agentMemberId, state.member_id);
    assert.match(paired.stdout, new RegExp(`seq \\d+: member_joined ${phone.memberId}$`, "m"));
    assert.match(paired.stdout, new RegExp(`seq \\d+: ${phone.memberId} picked the right code; confirmed$`, "m"));
    assert.match(paired.stdout, new RegExp(`Confirmed ${phone.memberId}\\.`));
    assert.doesNotMatch(paired.stdout, /\[y\/N\]|Fingerprint/);
    assert.equal(loadState(home).members[phone.memberId].state, "confirmed");
    assert.deepEqual(await phone.fetchCommands(), []);
    assert.deepEqual(phone.openFailures, []);
    assert.deepEqual(phone.controlReceived.map((m) => m.type), ["confirmed"]);
    assert.deepEqual(await agentPending(state), []);

    const marker = { uuid: randomUUID().toUpperCase(), type: "heart_rate", value: MARKER_VALUE, unit: "count/min", start: "2026-10-12T08:00:00Z", end: "2026-10-12T08:00:00Z", source: { app: "com.apple.Health", device: null } };
    secrets.push(["marker sample value", String(MARKER_VALUE)], ["marker sample uuid", marker.uuid]);
    const day = [...sevenDaysOfStepsAndHeartRate({ now: DAY_END, days: 1 }), marker];
    const chunks = await phone.sendSync({ samples: day });
    assert.equal(chunks.length, 1);

    const polled = await run(home, ["poll", "--once"]);
    assert.match(polled, new RegExp(`seq ${chunks[0].seq}: sync from ${phone.memberId}: samples steps=24 heart_rate=145; deleted 0; acks 0`));
    assert.equal(loadState(home).last_seq, chunks[0].seq);
    assert.deepEqual(await agentPending(state), []);

    const sent = await run(home, ["send-water", "0.25", "--to", phone.memberId]);
    assert.match(sent, new RegExp(`^Sent c_1 to ${phone.memberId}\\.`));
    const command = loadState(home).commands.c_1;
    assert.equal(command.state, "sent");
    assert.ok(Number.isSafeInteger(command.seq));

    const commands = await phone.fetchCommands();
    assert.deepEqual(phone.openFailures, []);
    assert.deepEqual(commands.map((c) => [c.command_id, c.version, c.op, c.type, c.value, c.unit]), [["c_1", 1, "write", "dietary_water", 0.25, "L"]]);
    const [ack] = await phone.answer(commands);
    assert.deepEqual(ack, { command_id: "c_1", version: 1, status: "applied" });
    assert.equal(phone.applyCount, 1);

    const acked = await run(home, ["poll", "--once"]);
    assert.match(acked, new RegExp(`sync from ${phone.memberId}: samples none; deleted 0; acks 1`));
    assert.deepEqual(await agentPending(state), []);
    const status = await run(home, ["status"]);
    assert.match(status, new RegExp(`^member ${phone.memberId} "E2E iPhone": confirmed$`, "m"));
    assert.match(status, new RegExp(`^command c_1 v1 dietary_water to ${phone.memberId}: applied$`, "m"));
  });

  it("revokes the phone when its proof is for another device key", { timeout: TEST_TIMEOUT_MS }, async () => {
    const { home } = await initAgent("E2E minimal agent (reject)");
    const swapped = (await generateKeys()).pk;
    const { paired: rejected, phone } = await pairWithPhone(home, "E2E rejected iPhone", (p) => p.pairProof({ devicePublicKey: swapped }));
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, new RegExp(`${phone.memberId} sent a proof that does not match this link and was revoked`));
    assert.match(rejected.stdout, new RegExp(`${phone.memberId} sent a wrong pairing proof; rejected and revoked`));
    assert.equal(loadState(home).members[phone.memberId].state, "rejected");

    await assert.rejects(phone.fetchCommands(), (err) => err instanceof FakePhoneError && err.status === 401 && err.code === "invalid_token");
    await assert.rejects(phone.sendSync({ samples: [] }), (err) => err instanceof FakePhoneError && err.status === 401);

    const refused = start(home, ["send-water", "0.25", "--to", phone.memberId]);
    refused.child.stdin.end();
    const res = await refused.exited;
    assert.equal(res.status, 2);
    assert.match(res.stderr, /is not a confirmed device/);

    const polled = await run(home, ["poll", "--once"]);
    assert.match(polled, new RegExp(`member_revoked ${phone.memberId}$`, "m"));
    const status = await run(home, ["status"]);
    assert.match(status, new RegExp(`^member ${phone.memberId} "E2E rejected iPhone": revoked$`, "m"));
  });

  it("never prints tokens, private keys or sample values", { timeout: TEST_TIMEOUT_MS }, () => {
    assert.ok(outputs.length >= 10);
    for (const { what, stdout, stderr, pairing } of outputs) {
      for (const [label, needle] of secrets) {
        assert.ok(!stderr.includes(needle), `stderr of ${what} contains the ${label}`);
        if (pairing && (label === "pairing token" || label === "pairing secret")) continue;
        assert.ok(!stdout.includes(needle), `stdout of ${what} contains the ${label}`);
      }
      assert.ok(!(stdout + stderr).includes('"type":"sync"'), `${what} prints inner JSON`);
    }
  });
});
