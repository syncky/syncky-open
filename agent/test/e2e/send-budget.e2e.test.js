import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { b64uDecode } from "../../src/encoding.js";
import { sealEnvelope, serializeEnvelope } from "../support/envelope.js";
import { loadSecrets } from "../../src/secrets.js";
import { agentBin } from "../support/agent-bin.js";
import { createFakePhone } from "../support/fake-phone.js";
import { tempHome, waitFor } from "../support/helpers.js";
import { waitForSend } from "../support/send-receipt.js";

const RELAY = process.env.SYNCKY_E2E_RELAY;
const INVITE = process.env.SYNCKY_E2E_INVITE || "dev-invite";
const INTERVAL_S = Number(process.env.SYNCKY_E2E_SEND_INTERVAL_S);
const BURST = 3;
const BIN = process.env.SYNCKY_E2E_AGENT_BIN || agentBin();
const agentSpawn = (args) => (/\.m?js$/.test(BIN) ? [process.execPath, [BIN, ...args]] : [BIN, args]);
const RECEIVE_FIXTURE = fileURLToPath(new URL('../support/receive-fixture.js', import.meta.url));
const TEST_TIMEOUT_MS = 60_000 + INTERVAL_S * 5000;
const WAIT = { timeoutMs: 30_000, intervalMs: 250 };

const SKIP = RELAY && INTERVAL_S > 0 ? false : "SYNCKY_E2E_RELAY and SYNCKY_E2E_SEND_INTERVAL_S (the relay's AGENT_SEND_INTERVAL_S) are not set";

describe("the relay's agent send budget and the thin agent's ciphertext retries (wrangler dev)", { skip: SKIP }, () => {
  const homes = [];

  after(() => {
    for (const home of homes) home.cleanup();
  });

  function run(home, args, input) {
    const env = { ...process.env, SYNCKY_INVITE: INVITE, SYNCKY_LOG_LEVEL: "info" };
    for (const key of ["SYNCKY_AGENT_HOME", "SYNCKY_E2E_RELAY", "SYNCKY_E2E_INVITE", "SYNCKY_RELAY_URL", "SYNCKY_LOG_LEVEL"]) delete env[key];
    return new Promise((resolve, reject) => {
      const command = args[0] === "receive"
        ? [process.execPath, [RECEIVE_FIXTURE, "--agent-bin", BIN, "--home", home, "--once"]]
        : agentSpawn(["--home", home, ...args, ...(args[0] === "send" ? [] : ["--json"])]);
      const child = spawn(...command, { env, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
      if (input !== undefined) { child.stdin.on("error", () => {}); child.stdin.end(input); }
      const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c) => (stdout += c));
      child.stderr.on("data", (c) => (stderr += c));
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) return reject(new Error(`agent ${args[0]} exited ${code}`));
        resolve(args[0] === "receive" ? {} : JSON.parse(stdout));
      });
    });
  }

  async function pairedAgent(name) {
    const t = tempHome();
    homes.push(t);
    await run(t.home, ["init", "--relay", RELAY, "--name", name]);
    const pairing = await run(t.home, ["pair", "--no-qr"]);
    assert.equal(pairing.version, 2);
    const phone = createFakePhone({ relayUrl: RELAY, name: `${name} iPhone` });
    await phone.pair(pairing.uri);
    return { home: t.home, phone };
  }

  async function confirmByProof(home, phone) {
    await phone.sendPairProof();
    await run(home, ["receive", "--once"]);
    await waitFor(async () => {
      await run(home, ["receive", "--once"]);
      return (await run(home, ["status"])).members.some(m => m.member_id === phone.memberId && m.state === "confirmed");
    }, { ...WAIT, what: "phone proof confirmation" });
    await waitFor(async () => {
      await run(home, ["receive", "--once"]);
      await phone.fetchCommands();
      return phone.controlReceived.some(m => m.type === "confirmed");
    }, { ...WAIT, what: "phone confirmation delivery" });
  }

  async function rawAgentSend(home, phone) {
    const secrets = loadSecrets(home);
    const envelope = await sealEnvelope({
      hubId: phone.hubId,
      from: phone.agentMemberId,
      recipients: [{ memberId: phone.memberId, publicKey: b64uDecode(phone.publicKey, { length: 32 }) }],
      senderPrivateKey: secrets.privateKeyBytes,
      plaintext: JSON.stringify({ v: 1, type: "commands", commands: [] }),
    });
    const res = await fetch(`${RELAY}/v1/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secrets.token}`, "Content-Type": "application/json; charset=utf-8" },
      body: serializeEnvelope(envelope),
    });
    const body = await res.json();
    return { status: res.status, retryAfter: res.headers.get("retry-after"), body };
  }

  it("an agent sending every second gets 429 after the burst, the phone does not, and pairing still confirms", { timeout: TEST_TIMEOUT_MS }, async () => {
    const { home, phone } = await pairedAgent("Budget agent");
    const sends = [];
    for (let i = 0; i < BURST + 2; i++) {
      sends.push(await rawAgentSend(home, phone));
      await delay(1000);
    }
    assert.deepEqual(sends.map((s) => s.status), [201, 201, 201, 429, 429]);
    for (const refused of sends.slice(BURST)) {
      assert.equal(refused.body.error, "rate_limited");
      const wait = Number(refused.retryAfter);
      assert.ok(Number.isInteger(wait) && wait >= 1 && wait <= INTERVAL_S, `Retry-After ${refused.retryAfter}`);
      assert.equal(refused.body.details.retry_after_s, wait);
    }

    const phoneSends = await phone.sendSync({ samples: [] });
    for (let i = 0; i < BURST + 2; i++) phoneSends.push(...(await phone.sendSync({ samples: [] })));
    assert.equal(phoneSends.length, BURST + 3);

    await confirmByProof(home, phone);
    await phone.fetchCommands();
    assert.ok(phone.controlReceived.some(m => m.type === "confirmed"));
    assert.equal((await run(home, ["status"])).members.find(m => m.member_id === phone.memberId).confirmation_method, "proof");
  });

  it("caller batches stay explicit and rate-limited ciphertext is retried without changing command versions", { timeout: TEST_TIMEOUT_MS }, async () => {
    const { home, phone } = await pairedAgent("Ciphertext retry agent");
    await confirmByProof(home, phone);
    const commands = [0.25, 0.5, 0.75, 1].map((value, i) => ({ command_id: `budget_${i}`, version: 1, op: "write", type: "dietary_water", value, unit: "L", start: "2026-11-05T12:00:00Z", end: "2026-11-05T12:00:00Z" }));
    const receipts = [];
    for (const command of commands) receipts.push(await run(home, ["send", "--type", "commands", "--to", phone.memberId, "--json", "-"], JSON.stringify({ v: 1, type: "commands", commands: [command] })));
    assert.ok(receipts.some(r => r.state === "pending"));
    assert.equal(new Set(receipts.map(r => r.msg_id)).size, commands.length);
    const deadline = Date.now() + INTERVAL_S * 5000;
    for (const receipt of receipts) await waitForSend(receipt, async () => {
      await run(home, ["receive", "--once"]);
      return run(home, ["status"]);
    }, { ...WAIT, timeoutMs: Math.max(0, deadline - Date.now()) });
    const delivered = await phone.fetchCommands();
    assert.deepEqual(delivered.map(c => [c.command_id, c.version, c.value]), commands.map(c => [c.command_id, c.version, c.value]));
    await phone.answer(delivered);
    await waitFor(async () => {
      await run(home, ["receive", "--once"]);
      const records = (await run(home, ["inbox", "--type", "sync", "--limit", "1000"])).records;
      const acks = records.flatMap(r => r.inner.acks ?? []);
      return commands.every(c => acks.some(a => a.command_id === c.command_id && a.version === 1 && a.status === "applied"));
    }, { ...WAIT, timeoutMs: 60_000, what: "raw phone outcomes" });
    assert.equal(phone.applyCount, commands.length);
  });
});
