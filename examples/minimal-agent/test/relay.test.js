import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { sealEnvelope as sealMarkedEnvelope } from '../../../agent/test/support/envelope.js';
import { b64uDecode } from '../../../agent/src/encoding.js';
import { diagnosticsFixture } from "../../../agent/test/support/diagnostics.js";
import { tempHome } from "../../../agent/test/support/helpers.js";
import { b64u, generateKeys, handleMessage, loadState, openEnvelope, pairCode, pairProof, parsePairUri, saveState, sealEnvelope, unb64u, updateState, uuidv7 } from "../agent.mjs";

const AGENT = fileURLToPath(new URL("../agent.mjs", import.meta.url));
const HUB = "hub_AAAAAAAAAAAAAAAAAAAAAA";
const TOKEN = `sk_${HUB}_${"T".repeat(40)}`;
const INVITE = "invite-secret-value";
const PAIRING_ID = "p_BBBBBBBBBBBBBBBBBBBBBB";
const PAIRING_TOKEN = `pt_${"P".repeat(43)}`;
const STEPS = 81234;
const HEART = 61.75;

async function startRelay(t, handler) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = { method: req.method, url: req.url, headers: req.headers, body, at: Date.now() };
    requests.push(request);
    const reply = (await handler(request, requests)) ?? { status: 404, json: { error: "not_found", message: "no route" } };
    res.writeHead(reply.status, { ...(reply.json === undefined ? {} : { "content-type": "application/json" }), ...reply.headers });
    res.end(reply.json === undefined ? "" : JSON.stringify(reply.json));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise((done) => server.close(done)));
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

function withHome(t) {
  const h = tempHome();
  t.after(h.cleanup);
  return h;
}

const secretsSeen = [];

function run(args, { home, input = "", env = {} }) {
  return new Promise((resolve, reject) => {
    const base = { ...process.env };
    delete base.SYNCKY_INVITE;
    const child = spawn(process.execPath, [AGENT, ...args], { env: { ...base, SYNCKY_HOME: home, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input);
  }).then((r) => {
    const state = existsSync(join(home, "state.json")) ? loadState(home) : null;
    for (const secret of [TOKEN, INVITE, state?.sk, ...secretsSeen].filter(Boolean)) {
      assert.ok(!(r.stdout + r.stderr).includes(secret), `output leaks a secret: ${r.stdout}${r.stderr}`);
    }
    for (const value of [String(STEPS), String(HEART)]) assert.ok(!(r.stdout + r.stderr).includes(value), "output leaks a health value");
    return r;
  });
}

const json = (status, body, headers) => ({ status, json: body, headers });
const created = (status) => json(200, { pairing_id: PAIRING_ID, status, expires_at: "2026-10-13T08:10:00Z" });

async function seeded(t, relayUrl, { deviceState = "confirmed", commands = {} } = {}) {
  const h = withHome(t);
  const agent = await generateKeys();
  const device = await generateKeys();
  secretsSeen.push(device.sk);
  const members = { m_dev_1: { name: "Test iPhone", pk: device.pk, state: deviceState } };
  saveState(h.home, { relay: relayUrl, name: "agent", hub_id: HUB, member_id: "m_agent_1", token: TOKEN, ...agent, webhook_url: null, last_seq: 0, members, commands });
  return { home: h.home, agent, device };
}

async function syncFrom(device, agent, seq, inner, from = "m_dev_1") {
  const plaintext = JSON.stringify({ v: 1, type: "sync", device: from, samples: [], deleted: [], acks: [], more: false, ...inner });
  const envelope = await sealEnvelope({ hubId: HUB, from, sk: device.sk, recipients: [{ member_id: "m_agent_1", pk: agent.pk }], plaintext });
  return { ...envelope, seq };
}

async function controlFrom(device, agent, seq, inner, from = "m_dev_1") {
  const envelope = await sealEnvelope({ hubId: HUB, from, sk: device.sk, recipients: [{ member_id: "m_agent_1", pk: agent.pk }], plaintext: JSON.stringify(inner), kind: "control" });
  return { ...envelope, seq };
}

const system = (seq, event, body) => ({ v: 1, kind: "system", msg_id: uuidv7(), from: "relay", created_at: "2026-10-13T08:00:00Z", event, body, seq });
const sample = (type, value, unit) => ({ uuid: uuidv7().toUpperCase(), type, value, unit, start: "2026-10-13T07:00:00Z", end: "2026-10-13T07:15:00Z", source: { app: "com.apple.health", device: null } });
const page = (messages, has_more = false) => json(200, { messages, next_after: messages.at(-1)?.seq ?? 0, has_more });
const ackRequests = (requests) => requests.filter((r) => r.url === "/v1/acks").map((r) => JSON.parse(r.body).up_to_seq);

describe("init (E1)", () => {
  it("registers with the invite header, no webhook_url, and saves the state with mode 600", async (t) => {
    const relay = await startRelay(t, (r) =>
      r.url === "/v1/agents/register" ? json(201, { hub_id: HUB, member_id: "m_agent_1", token: TOKEN, webhook_secret: `whsec_${"W".repeat(43)}` }) : null,
    );
    const h = withHome(t);
    const r = await run(["init", "--relay", `${relay.url}/ignored/path`, "--invite", INVITE, "--name", "Kitchen agent"], { home: h.home });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(relay.requests.length, 1);
    const [req] = relay.requests;
    assert.equal(req.method, "POST");
    assert.equal(req.headers["x-syncky-invite"], INVITE);
    assert.equal(req.headers["content-type"], "application/json; charset=utf-8");
    assert.equal(req.headers.authorization, undefined);
    const body = JSON.parse(req.body);
    assert.deepEqual(Object.keys(body).sort(), ["name", "public_key"]);
    assert.equal(body.name, "Kitchen agent");
    const state = loadState(h.home);
    assert.equal(body.public_key, state.pk);
    assert.deepEqual(
      { relay: state.relay, hub_id: state.hub_id, member_id: state.member_id, token: state.token, last_seq: state.last_seq, webhook_url: state.webhook_url },
      { relay: relay.url, hub_id: HUB, member_id: "m_agent_1", token: TOKEN, last_seq: 0, webhook_url: null },
    );
    assert.equal(statSync(join(h.home, "state.json")).mode & 0o777, 0o600);
    assert.match(r.stdout, /Registered m_agent_1 in hub_A+/);
  });

  it("registers without an invite header when --invite is not given", async (t) => {
    const relay = await startRelay(t, () => json(201, { hub_id: HUB, member_id: "m_agent_1", token: TOKEN, webhook_secret: "x" }));
    const h = withHome(t);
    const r = await run(["init", "--relay", relay.url], { home: h.home });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(relay.requests[0].headers["x-syncky-invite"], undefined);
  });

  it("takes the invite from SYNCKY_INVITE when --invite is not given, and --invite wins over it", async (t) => {
    const relay = await startRelay(t, () => json(201, { hub_id: HUB, member_id: "m_agent_1", token: TOKEN, webhook_secret: "x" }));
    const fromEnv = withHome(t);
    assert.equal((await run(["init", "--relay", relay.url], { home: fromEnv.home, env: { SYNCKY_INVITE: INVITE } })).status, 0);
    assert.equal(relay.requests[0].headers["x-syncky-invite"], INVITE);
    const fromFlag = withHome(t);
    assert.equal((await run(["init", "--relay", relay.url, "--invite", "flag-invite"], { home: fromFlag.home, env: { SYNCKY_INVITE: INVITE } })).status, 0);
    assert.equal(relay.requests[1].headers["x-syncky-invite"], "flag-invite");
  });

  it("uses a default name", async (t) => {
    const relay = await startRelay(t, () => json(201, { hub_id: HUB, member_id: "m_agent_1", token: TOKEN, webhook_secret: "x" }));
    const h = withHome(t);
    assert.equal((await run(["init", "--relay", relay.url, "--invite", INVITE], { home: h.home })).status, 0);
    assert.equal(JSON.parse(relay.requests[0].body).name, "Syncky minimal agent");
  });

  it("a rejected invite exits 1 and saves nothing", async (t) => {
    const relay = await startRelay(t, () => json(403, { error: "invalid_invite", message: "invite is missing or wrong" }));
    const h = withHome(t);
    const r = await run(["init", "--relay", relay.url, "--invite", INVITE], { home: h.home });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /^error: relay 403 invalid_invite: invite is missing or wrong/);
    assert.equal(relay.requests.length, 1, "4xx is not retried");
    assert.equal(existsSync(h.home), false);
  });

  it("a malformed registration exits 1 and saves nothing", async (t) => {
    const relay = await startRelay(t, () => json(201, { hub_id: HUB, member_id: "m_agent_1", token: "sk_other" }));
    const h = withHome(t);
    const r = await run(["init", "--relay", relay.url, "--invite", INVITE], { home: h.home });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /malformed registration/);
    assert.equal(existsSync(h.home), false);
  });

  it("refuses to overwrite an existing registration", async (t) => {
    const relay = await startRelay(t, () => null);
    const s = await seeded(t, relay.url);
    const r = await run(["init", "--relay", relay.url, "--invite", INVITE], { home: s.home });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /already initialized/);
    assert.equal(relay.requests.length, 0);
    assert.equal(loadState(s.home).token, TOKEN);
  });

  it("an unreachable relay exits 1", async (t) => {
    const h = withHome(t);
    const r = await run(["init", "--relay", "http://127.0.0.1:9", "--invite", INVITE], { home: h.home });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /relay unreachable/);
  });
});

describe("pair (E2, E3, E9, the pair_proof check)", () => {
  const flip = (proof) => b64u(unb64u(proof).map((x, i) => (i === 0 ? x ^ 1 : x)));

  // The phone's side: while the joining phone is joined with a stored proof, every inbox page carries its pair_proof (ctx.proof maps the expected proof to the one sent; null sends none).
  async function pairingRelay(t, device, { statuses = ["completed"], revoke = 204, proof = (expected) => expected, messages, onPairing } = {}) {
    let polls = 0;
    const ctx = { home: null, agent: null, stored: null, proof, post: 201 };
    const relay = await startRelay(t, async (r) => {
      if (r.method === "POST" && r.url === "/v1/pairings") return json(201, { pairing_id: PAIRING_ID, pairing_token: PAIRING_TOKEN, expires_at: "2026-10-13T08:10:00Z", hub_id: HUB });
      if (r.method === "GET" && r.url === `/v1/pairings/${PAIRING_ID}`) {
        const status = statuses[Math.min(polls++, statuses.length - 1)];
        onPairing?.(ctx, status);
        if (status !== "completed") return created(status);
        return json(200, { ...created("completed").json, completed_at: "2026-10-13T08:01:00Z", member_id: "m_dev_1", device_name: "Test\u0007 iPhone\u202e\u2066", public_key: device.pk });
      }
      if (r.method === "GET" && r.url.startsWith("/v1/messages?")) {
        const after = Number(new URLSearchParams(r.url.split("?")[1]).get("after"));
        if (messages) return messages(after);
        const member = loadState(ctx.home).members.m_dev_1;
        if (member?.state !== "joined" || !member.proof || ctx.proof === null) return page([]);
        ctx.stored = member.proof;
        secretsSeen.push(member.proof);
        return page([await controlFrom(device, ctx.agent, after + 1, { v: 1, type: "pair_proof", proof: ctx.proof(member.proof, ctx) })]);
      }
      if (r.method === "POST" && r.url === "/v1/messages") {
        return ctx.post === 201 ? json(201, { seq: 99, msg_id: JSON.parse(r.body).msg_id }) : json(ctx.post, { error: "invalid_envelope", message: "no" });
      }
      if (r.method === "POST" && r.url === "/v1/acks") return json(200, { acked: 1, cursor: JSON.parse(r.body).up_to_seq });
      if (r.method === "GET" && r.url === "/v1/members") return json(200, { members: [] });
      if (r.method === "DELETE" && /^\/v1\/members\/m_dev_[12]$/.test(r.url)) return revoke === 204 ? { status: 204 } : json(revoke, { error: revoke === 404 ? "not_found" : "forbidden", message: "no" });
      return null;
    });
    return { ...relay, ctx };
  }

  async function agentFor(t, relay, options) {
    const s = await seeded(t, relay.url, options);
    if (!options) {
      const state = loadState(s.home);
      state.members = {};
      saveState(s.home, state);
    }
    Object.assign(relay.ctx, { home: s.home, agent: s.agent });
    return s;
  }

  const uriOf = (stdout) => stdout.match(/syncky:\/\/pair\?\S+/)[0];
  const posts = (relay) => relay.requests.filter((q) => q.method === "POST" && q.url === "/v1/messages").map((q) => JSON.parse(q.body));

  it("prints a v2 URI, the QR and the code, confirms the phone on a matching pair_proof and sends it confirmed", async (t) => {
    const device = await generateKeys();
    const relay = await pairingRelay(t, device);
    const s = await agentFor(t, relay);
    const r = await run(["pair"], { home: s.home });
    assert.equal(r.status, 0, r.stderr);
    const [create, status] = relay.requests;
    assert.equal(create.body, "{}");
    assert.equal(create.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(create.headers["content-type"], "application/json; charset=utf-8");
    assert.equal(status.method, "GET");
    assert.equal(status.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(status.headers["content-type"], undefined, "a request without a body has no content type");
    const { pair_secret: c, ...parsed } = parsePairUri(uriOf(r.stdout), true);
    assert.deepEqual(parsed, { ok: true, relay_base: relay.url, hub_id: HUB, pairing_token: PAIRING_TOKEN, agent_public_key: s.agent.pk, agent_name: "agent" });
    assert.equal(unb64u(c, 16).length, 16);
    assert.match(r.stdout, /[▀▄█]/, "a terminal QR code is printed");
    assert.ok(r.stdout.includes(`\ncode: ${pairCode(c)}\n`));
    assert.equal(r.stdout.split(c).length, 2, "c is printed only inside the URI");
    assert.equal(relay.ctx.stored, pairProof(c, s.agent.pk, device.pk), "pair expects the proof for the key the relay reported");
    assert.ok(r.stdout.includes('Device "Test? iPhone??" (m_dev_1) joined'), "control and bidi characters in the device name are neutralized");
    assert.match(r.stdout, /seq 1: m_dev_1 picked the right code; confirmed\n/);
    assert.match(r.stdout, /Confirmed m_dev_1\. Next: poll\n$/);
    assert.doesNotMatch(r.stdout, /\[y\/N\]|Fingerprint/);
    const [confirmed, ...more] = posts(relay);
    assert.deepEqual(more, []);
    assert.equal(confirmed.kind, "control");
    assert.deepEqual(confirmed.recipients.map((x) => x.member_id), ["m_dev_1"]);
    const opened = await openEnvelope(confirmed, { hubId: HUB, memberId: "m_dev_1", sk: device.sk, registry: { m_agent_1: s.agent.pk }, kind: "control" });
    assert.equal(opened, '{"v":1,"type":"confirmed"}');
    assert.deepEqual(ackRequests(relay.requests), [1]);
    assert.equal(relay.requests.some((q) => q.method === "DELETE"), false);
    assert.deepEqual(loadState(s.home).members.m_dev_1, { name: "Test? iPhone??", pk: device.pk, state: "confirmed" });
  });

  it("keeps polling E3 while the pairing is pending", async (t) => {
    const device = await generateKeys();
    const relay = await pairingRelay(t, device, { statuses: ["pending", "completed"] });
    const s = await agentFor(t, relay);
    const r = await run(["pair"], { home: s.home });
    assert.equal(r.status, 0, r.stderr);
    const polls = relay.requests.filter((q) => q.method === "GET" && q.url.startsWith("/v1/pairings/"));
    assert.equal(polls.length, 2);
    assert.ok(polls[1].at - polls[0].at >= 1500, "E3 is polled with a pause");
  });

  for (const [label, wrong] of [["a proof with one bit flipped", flip], ["a proof that is not 32 bytes", (p) => p.slice(0, 42)], ["no proof", () => undefined]]) {
    it(`${label} revokes the phone with E9, acks the message, sends nothing and exits 1`, async (t) => {
      const device = await generateKeys();
      const relay = await pairingRelay(t, device, { proof: wrong });
      const s = await agentFor(t, relay);
      const r = await run(["pair"], { home: s.home });
      assert.equal(r.status, 1);
      assert.match(r.stderr, /m_dev_1 sent a proof that does not match this link and was revoked; run pair again/);
      assert.match(r.stdout, /seq 1: m_dev_1 sent a wrong pairing proof; rejected and revoked/);
      const del = relay.requests.find((q) => q.method === "DELETE");
      assert.equal(del.url, "/v1/members/m_dev_1");
      assert.equal(del.headers.authorization, `Bearer ${TOKEN}`);
      assert.deepEqual(posts(relay), [], "no confirmed is sent");
      assert.deepEqual(ackRequests(relay.requests), [1]);
      assert.deepEqual(loadState(s.home).members.m_dev_1, { name: "Test? iPhone??", pk: device.pk, state: "rejected" });
    });
  }

  it("a phone already revoked on the relay (404) is still recorded as rejected", async (t) => {
    const device = await generateKeys();
    const relay = await pairingRelay(t, device, { revoke: 404, proof: flip });
    const s = await agentFor(t, relay);
    const r = await run(["pair"], { home: s.home });
    assert.equal(r.status, 1);
    assert.equal(loadState(s.home).members.m_dev_1.state, "rejected");
  });

  it("a failed E9 exits 1 and keeps the phone joined and its proof unacked, so poll tries again", async (t) => {
    const device = await generateKeys();
    const relay = await pairingRelay(t, device, { revoke: 403, proof: flip });
    const s = await agentFor(t, relay);
    const r = await run(["pair"], { home: s.home });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /relay 403 forbidden/);
    const member = loadState(s.home).members.m_dev_1;
    assert.equal(member.state, "joined");
    assert.equal(member.proof, relay.ctx.stored);
    assert.deepEqual(ackRequests(relay.requests), []);
  });

  it("a failed confirmed post exits 1 and keeps the proof unacked; the next poll confirms the phone and sends confirmed", async (t) => {
    const device = await generateKeys();
    const relay = await pairingRelay(t, device);
    const s = await agentFor(t, relay);
    relay.ctx.post = 400;
    const r = await run(["pair"], { home: s.home });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /relay 400 invalid_envelope/);
    assert.equal(loadState(s.home).members.m_dev_1.state, "joined");
    assert.deepEqual(ackRequests(relay.requests), []);
    relay.ctx.post = 201;
    const polled = await run(["poll", "--once"], { home: s.home });
    assert.equal(polled.status, 0, polled.stderr);
    assert.match(polled.stdout, /seq 1: m_dev_1 picked the right code; confirmed/);
    assert.equal(posts(relay).length, 2);
    assert.equal(loadState(s.home).members.m_dev_1.state, "confirmed");
    assert.deepEqual(ackRequests(relay.requests), [1]);
  });

  it("an expired pairing exits 1", async (t) => {
    const device = await generateKeys();
    const relay = await pairingRelay(t, device, { statuses: ["expired"] });
    const s = await agentFor(t, relay);
    const r = await run(["pair"], { home: s.home });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /pairing expired/);
    assert.deepEqual(loadState(s.home).members, {});
  });

  it("gives up after --wait seconds when no phone joins", async (t) => {
    const device = await generateKeys();
    const relay = await pairingRelay(t, device, { statuses: ["pending"] });
    const s = await agentFor(t, relay);
    const r = await run(["pair", "--wait", "1"], { home: s.home });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no phone joined in time/);
  });

  it("gives up after --wait seconds when the phone joined but sent no proof; a later poll confirms it", async (t) => {
    const device = await generateKeys();
    const relay = await pairingRelay(t, device, { proof: null });
    const s = await agentFor(t, relay);
    const r = await run(["pair", "--wait", "3"], { home: s.home });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /m_dev_1 has not picked the code in time; poll still confirms it when it does/);
    const joined = loadState(s.home).members.m_dev_1;
    assert.equal(joined.state, "joined");
    assert.equal(joined.proof, pairProof(parsePairUri(uriOf(r.stdout), true).pair_secret, s.agent.pk, device.pk));
    relay.ctx.proof = (expected) => expected;
    const polled = await run(["poll", "--once"], { home: s.home });
    assert.equal(polled.status, 0, polled.stderr);
    assert.equal(loadState(s.home).members.m_dev_1.state, "confirmed");
    assert.equal(posts(relay).length, 1);
    assert.deepEqual(ackRequests(relay.requests), [1]);
  });

  it("ends with exit 1 when the phone leaves while pair waits for its proof (a wrong pick on the phone)", async (t) => {
    const device = await generateKeys();
    const relay = await pairingRelay(t, device, { messages: (after) => page(after ? [] : [system(1, "member_revoked", { member_id: "m_dev_1", self: true })]) });
    const s = await agentFor(t, relay);
    const r = await run(["pair"], { home: s.home });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /m_dev_1 left \(a wrong pick on the phone cancels the pairing\); run pair again/);
    assert.equal(loadState(s.home).members.m_dev_1.state, "revoked");
    assert.deepEqual(ackRequests(relay.requests), [1]);
  });

  it("a pairing that completes with a known member id and another key is a key_conflict", async (t) => {
    const intruder = await generateKeys();
    const relay = await pairingRelay(t, intruder);
    const s = await agentFor(t, relay, {});
    const before = loadState(s.home);
    const r = await run(["pair"], { home: s.home });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /m_dev_1 is known with another key/);
    assert.deepEqual(loadState(s.home), before);
    assert.equal(relay.requests.some((q) => q.method === "DELETE"), false);
    assert.equal(existsSync(join(s.home, "state.lock")), false);
  });

  it("keeps what poll saved while pair was waiting for the phone", async (t) => {
    const device = await generateKeys();
    const relay = await pairingRelay(t, device, {
      statuses: ["pending", "completed"],
      onPairing: (ctx, status) => {
        if (status !== "pending") return;
        const state = loadState(ctx.home);
        saveState(ctx.home, { ...state, last_seq: 9, acked_seq: 9, commands: { c_1: { to: "m_dev_9", version: 1, msg_id: uuidv7(), state: "applied" } } });
      },
    });
    const s = await agentFor(t, relay);
    const r = await run(["pair"], { home: s.home });
    assert.equal(r.status, 0, r.stderr);
    const state = loadState(s.home);
    assert.equal(state.last_seq, 10);
    assert.equal(state.acked_seq, 10);
    assert.equal(state.commands.c_1.state, "applied");
    assert.equal(state.members.m_dev_1.state, "confirmed");
  });

  it("stores the proof on the row a concurrent poll created for the joining phone, without replacing it", async (t) => {
    const device = await generateKeys();
    let seen;
    const relay = await pairingRelay(t, device, {
      statuses: ["pending", "completed"],
      onPairing: (ctx, status) => {
        if (status !== "pending") return;
        const state = loadState(ctx.home);
        state.members.m_dev_1 = { name: "Seen by poll", pk: device.pk, state: "joined" };
        saveState(ctx.home, state);
      },
      proof: (expected, ctx) => ((seen = loadState(ctx.home).members.m_dev_1), expected),
    });
    const s = await agentFor(t, relay);
    const r = await run(["pair"], { home: s.home });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(seen, { name: "Seen by poll", pk: device.pk, state: "joined", proof: relay.ctx.stored });
    assert.deepEqual(loadState(s.home).members.m_dev_1, { name: "Seen by poll", pk: device.pk, state: "confirmed" });
  });

  it("revokes a phone whose join arrives during the pairing without a stored proof, so its messages do not hold the new phone's proof", async (t) => {
    const device = await generateKeys();
    const stale = await generateKeys();
    const relay = await pairingRelay(t, device, {
      messages: async (after) => {
        const { home, agent } = relay.ctx;
        const all = [
          system(1, "member_joined", { member_id: "m_dev_2", role: "device", device_name: "Old phone", public_key: stale.pk, pairing_id: "p_CCCCCCCCCCCCCCCCCCCCCC" }),
          await controlFrom(stale, agent, 2, { v: 1, type: "pair_proof", proof: b64u(new Uint8Array(32)) }, "m_dev_2"),
          await controlFrom(device, agent, 3, { v: 1, type: "pair_proof", proof: loadState(home).members.m_dev_1?.proof }),
        ];
        return page(all.filter((m) => m.seq > after));
      },
    });
    const s = await agentFor(t, relay);
    const r = await run(["pair", "--wait", "20"], { home: s.home });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(relay.requests.filter((q) => q.method === "DELETE").map((q) => q.url), ["/v1/members/m_dev_2"]);
    assert.match(r.stdout, /seq 3: m_dev_1 picked the right code; confirmed\n/);
    assert.deepEqual(ackRequests(relay.requests), [3]);
    const { members } = loadState(s.home);
    assert.deepEqual([members.m_dev_1.state, members.m_dev_2.state], ["confirmed", "rejected"]);
  });

  it("first revokes a phone that joined without a stored proof (its link's secret is gone), then opens a new pairing", async (t) => {
    const relay = await pairingRelay(t, await generateKeys(), { statuses: ["expired"] });
    const s = await agentFor(t, relay, { deviceState: "joined" });
    const r = await run(["pair"], { home: s.home });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /pairing expired/);
    assert.deepEqual(relay.requests.slice(0, 2).map((q) => `${q.method} ${q.url}`), ["DELETE /v1/members/m_dev_1", "POST /v1/pairings"]);
    assert.equal(loadState(s.home).members.m_dev_1.state, "rejected");
  });
});

describe("poll (E11, E12)", () => {
  function pagedRelay(t, pages, members = () => json(200, { members: [] })) {
    let next = 0;
    return startRelay(t, (r) => {
      if (r.method === "GET" && r.url.startsWith("/v1/messages")) return pages[Math.min(next++, pages.length - 1)];
      if (r.method === "POST" && r.url === "/v1/acks") return json(200, { acked: 1, cursor: JSON.parse(r.body).up_to_seq });
      if (r.method === "GET" && r.url === "/v1/members") return members();
      return null;
    });
  }

  it("follows has_more, prints type counts only and acks each page", async (t) => {
    const pages = [];
    const r2 = await pagedRelay(t, pages);
    const s = await seeded(t, r2.url);
    pages.push(
      page(
        [
          await syncFrom(s.device, s.agent, 3, { samples: [sample("steps", STEPS, "count"), sample("steps", 12, "count")], more: true }),
          await syncFrom(s.device, s.agent, 5, { samples: [sample("heart_rate", HEART, "count/min")], deleted: [{ uuid: "A93B", type: "steps" }] }),
        ],
        true,
      ),
      page([await syncFrom(s.device, s.agent, 6, { samples: [] })]),
    );
    const r = await run(["poll", "--once"], { home: s.home });
    assert.equal(r.status, 0, r.stderr);
    const gets = r2.requests.filter((q) => q.method === "GET").map((q) => q.url);
    assert.deepEqual(gets, ["/v1/messages?after=0&limit=100", "/v1/messages?after=5&limit=100"]);
    assert.ok(r2.requests.every((q) => q.headers.authorization === `Bearer ${TOKEN}`));
    assert.deepEqual(ackRequests(r2.requests), [5, 6]);
    assert.equal(r2.requests.find((q) => q.url === "/v1/acks").headers["content-type"], "application/json; charset=utf-8");
    assert.match(r.stdout, /seq 3: sync from m_dev_1: samples steps=2; deleted 0; acks 0/);
    assert.match(r.stdout, /seq 5: sync from m_dev_1: samples heart_rate=1; deleted 1; acks 0/);
    assert.match(r.stdout, /seq 6: sync from m_dev_1: samples none/);
    assert.equal(loadState(s.home).last_seq, 6);
  });

  it("an empty page sends no ack", async (t) => {
    const relay = await pagedRelay(t, [page([])]);
    const s = await seeded(t, relay.url);
    const r = await run(["poll", "--once"], { home: s.home });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(ackRequests(relay.requests), []);
    assert.equal(relay.requests.length, 1);
  });

  it("records member_joined, then holds that member's data unacked and stops", async (t) => {
    const pages = [];
    const relay = await pagedRelay(t, pages);
    const s = await seeded(t, relay.url);
    const other = await generateKeys();
    pages.push(
      page(
        [
          system(1, "member_joined", { member_id: "m_dev_2", role: "device", device_name: "Second phone", public_key: other.pk, pairing_id: PAIRING_ID }),
          await syncFrom(s.device, s.agent, 2, { samples: [sample("steps", STEPS, "count")] }),
          await syncFrom(other, s.agent, 3, { samples: [sample("steps", STEPS, "count")] }, "m_dev_2"),
          await syncFrom(s.device, s.agent, 4, {}),
        ],
        true,
      ),
    );
    const r = await run(["poll", "--once"], { home: s.home });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(ackRequests(relay.requests), [2], "acks stop before the unconfirmed member's data");
    assert.equal(relay.requests.filter((q) => q.method === "GET").length, 1, "no further pages are fetched");
    assert.match(r.stdout, /seq 1: m_dev_2 joined; it is confirmed when it picks the code pair shows/);
    assert.match(r.stdout, /seq 2: sync from m_dev_1/);
    assert.doesNotMatch(r.stdout, /seq [34]:/);
    assert.match(r.stdout, /Holding messages from m_dev_2 until it picks the code pair shows \(run pair again if pair has ended\)/);
    const state = loadState(s.home);
    assert.equal(state.last_seq, 2);
    assert.deepEqual(state.members.m_dev_2, { name: "Second phone", pk: other.pk, state: "joined" });
  });

  it("acks control envelopes from a confirmed phone without opening them", async (t) => {
    const pages = [];
    const relay = await pagedRelay(t, pages);
    const s = await seeded(t, relay.url, { commands: { c_kept: { to: "m_dev_1", version: 1, msg_id: uuidv7(), state: "sent" } } });
    const before = loadState(s.home);
    const control = { ...(await syncFrom(s.device, s.agent, 1, {})), kind: "control", ciphertext: "not-even-base64" };
    const proof = await controlFrom(s.device, s.agent, 2, { v: 1, type: "pair_proof", proof: b64u(new Uint8Array(32)) });
    const unpair = await controlFrom(s.device, s.agent, 3, { v: 1, type: "unpair", reason: "delete_relay_data" });
    pages.push(page([control, proof, unpair]));
    const r = await run(["poll", "--once"], { home: s.home });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(ackRequests(relay.requests), [3]);
    assert.match(r.stdout, /seq 1: skipped \(control message\)/);
    assert.match(r.stdout, /seq 2: skipped \(control message\)/);
    assert.match(r.stdout, /seq 3: skipped \(control message\)/);
    const after = loadState(s.home);
    assert.equal(after.last_seq, 3);
    assert.equal(after.acked_seq, 3);
    assert.deepEqual(after.members, before.members);
    assert.deepEqual(after.commands, before.commands);
    assert.equal(after.members.m_dev_1.state, "confirmed");
    assert.equal(relay.requests.some((q) => q.method === "DELETE" || (q.method === "POST" && q.url === "/v1/messages")), false);
  });

  it("holds a control envelope from a joined phone whose proof pair has not stored yet", async (t) => {
    const pages = [];
    const relay = await pagedRelay(t, pages);
    const s = await seeded(t, relay.url, { deviceState: "joined" });
    pages.push(page([await controlFrom(s.device, s.agent, 1, { v: 1, type: "pair_proof", proof: b64u(new Uint8Array(32)) })]));
    const r = await run(["poll", "--once"], { home: s.home });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(ackRequests(relay.requests), []);
    assert.match(r.stdout, /Holding messages from m_dev_1/);
    assert.equal(loadState(s.home).members.m_dev_1.state, "joined");
  });

  it("from a joined phone with a stored proof it opens control envelopes under the joined key and acks those that are not a pair_proof", async (t) => {
    const pages = [];
    const relay = await pagedRelay(t, pages);
    const s = await seeded(t, relay.url, { deviceState: "joined" });
    const state = loadState(s.home);
    state.members.m_dev_1.proof = b64u(new Uint8Array(32).fill(7));
    saveState(s.home, state);
    const garbage = { ...(await controlFrom(s.device, s.agent, 1, {})), ciphertext: "not-even-base64" };
    const relabelled = { ...(await syncFrom(s.device, s.agent, 2, {})), kind: "control" };
    const unpair = await controlFrom(s.device, s.agent, 3, { v: 1, type: "unpair", reason: "user" });
    const future = await controlFrom(s.device, s.agent, 4, { v: 2, type: "pair_proof", proof: state.members.m_dev_1.proof });
    pages.push(page([garbage, relabelled, unpair, future]));
    const r = await run(["poll", "--once"], { home: s.home });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /seq 1: skipped \(malformed\)/);
    assert.match(r.stdout, /seq 2: skipped \(hpke_open_failed\)/);
    assert.match(r.stdout, /seq 3: skipped \(control message\)/);
    assert.match(r.stdout, /seq 4: skipped \(control message\)/);
    assert.deepEqual(ackRequests(relay.requests), [4]);
    assert.deepEqual(loadState(s.home).members.m_dev_1, state.members.m_dev_1);
  });

  it("a pair_proof sealed by another key than the one the phone joined with does not open and confirms nothing", async (t) => {
    const pages = [];
    const relay = await pagedRelay(t, pages);
    const s = await seeded(t, relay.url, { deviceState: "joined" });
    const state = loadState(s.home);
    state.members.m_dev_1.proof = b64u(new Uint8Array(32).fill(7));
    saveState(s.home, state);
    const swapped = await generateKeys();
    pages.push(page([await controlFrom(swapped, s.agent, 1, { v: 1, type: "pair_proof", proof: state.members.m_dev_1.proof })]));
    const r = await run(["poll", "--once"], { home: s.home });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /seq 1: skipped \(hpke_open_failed\)/);
    assert.equal(loadState(s.home).members.m_dev_1.state, "joined");
    assert.equal(relay.requests.some((q) => q.method !== "GET" && q.url !== "/v1/acks"), false);
  });

  it("held data is acked nowhere when it is the first message", async (t) => {
    const pages = [];
    const relay = await pagedRelay(t, pages);
    const s = await seeded(t, relay.url, { deviceState: "joined" });
    pages.push(page([await syncFrom(s.device, s.agent, 1, {})]));
    const r = await run(["poll", "--once"], { home: s.home });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(ackRequests(relay.requests), []);
    assert.equal(loadState(s.home).last_seq, 0);
  });

  it("member_joined never downgrades a known member or replaces its key", async (t) => {
    const pages = [];
    const relay = await pagedRelay(t, pages);
    const s = await seeded(t, relay.url);
    const intruder = await generateKeys();
    pages.push(page([system(1, "member_joined", { member_id: "m_dev_1", role: "device", device_name: "x", public_key: intruder.pk, pairing_id: PAIRING_ID })]));
    const r = await run(["poll", "--once"], { home: s.home });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(loadState(s.home).members.m_dev_1, { name: "Test iPhone", pk: s.device.pk, state: "confirmed" });
    assert.deepEqual(ackRequests(relay.requests), [1]);
  });

  it("acks undecryptable, unknown-sender and invalid inner messages after reporting their codes", async (t) => {
    const pages = [];
    const relay = await pagedRelay(t, pages);
    const s = await seeded(t, relay.url);
    const stranger = await generateKeys();
    const tampered = await syncFrom(s.device, s.agent, 2, {});
    tampered.msg_id = uuidv7();
    const plain = async (seq, text) => ({
      ...(await sealEnvelope({ hubId: HUB, from: "m_dev_1", sk: s.device.sk, recipients: [{ member_id: "m_agent_1", pk: s.agent.pk }], plaintext: text })),
      seq,
    });
    pages.push(
      page([
        { seq: 1, v: 1, kind: "data", from: "m_dev_1", garbage: true },
        tampered,
        await syncFrom(stranger, s.agent, 3, {}, "m_dev_9"),
        await plain(4, JSON.stringify({ v: 2, type: "sync", device: "m_dev_1" })),
        await plain(5, JSON.stringify({ v: 1, type: "sync", device: "m_dev_2" })),
        await plain(6, "not json"),
        await plain(7, JSON.stringify({ v: 1, type: "commands", commands: [] })),
      ]),
    );
    const r = await run(["poll", "--once"], { home: s.home });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /seq 1: skipped \(malformed\)/);
    assert.match(r.stdout, /seq 2: skipped \(hpke_open_failed\)/);
    assert.match(r.stdout, /seq 3: skipped \(unknown_sender\)/);
    assert.match(r.stdout, /seq 4: skipped \(unsupported_version\)/);
    assert.match(r.stdout, /seq 5: skipped \(inner_invalid\)/);
    assert.match(r.stdout, /seq 6: skipped \(inner_invalid\)/);
    assert.match(r.stdout, /seq 7: skipped \(inner_invalid\)/);
    assert.deepEqual(ackRequests(relay.requests), [7]);
  });

  it("applies app acks to sent commands and ignores acks from the wrong sender or version", async (t) => {
    const pages = [];
    const relay = await pagedRelay(t, pages);
    const commands = {
      c_1: { to: "m_dev_1", version: 1, msg_id: uuidv7(), state: "sent" },
      c_2: { to: "m_dev_1", version: 1, msg_id: uuidv7(), state: "sent" },
      c_3: { to: "m_dev_2", version: 1, msg_id: uuidv7(), state: "sent" },
      c_4: { to: "m_dev_1", version: 1, msg_id: uuidv7(), state: "sent" },
      c_5: { to: "m_dev_1", version: 1, msg_id: uuidv7(), state: "applied" },
    };
    const s = await seeded(t, relay.url, { commands });
    const acks = [
      { command_id: "c_1", version: 1, status: "applied" },
      { command_id: "c_2", version: 1, status: "rejected", reason: "healthkit_denied" },
      { command_id: "c_3", version: 1, status: "applied" },
      { command_id: "c_4", version: 2, status: "applied" },
      { command_id: "c_5", version: 1, status: "rejected", reason: "invalid" },
      { command_id: "__proto__", status: "applied" },
    ];
    pages.push(page([await syncFrom(s.device, s.agent, 1, { acks })]));
    const r = await run(["poll", "--once"], { home: s.home });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /acks 6/);
    const state = loadState(s.home);
    assert.deepEqual(
      Object.fromEntries(Object.entries(state.commands).map(([id, c]) => [id, [c.state, c.reason ?? null]])),
      { c_1: ["applied", null], c_2: ["rejected", "healthkit_denied"], c_3: ["sent", null], c_4: ["sent", null], c_5: ["applied", null] },
    );
    const st = await run(["status"], { home: s.home });
    assert.match(st.stdout, /command c_1 v1 dietary_water to m_dev_1: applied/);
    assert.match(st.stdout, /command c_2 v1 dietary_water to m_dev_1: rejected \(healthkit_denied\)/);
  });

  it("ignores the phone's scope and records a type_not_in_scope rejection", async (t) => {
    const pages = [];
    const relay = await pagedRelay(t, pages);
    const commands = { c_1: { to: "m_dev_1", version: 1, msg_id: uuidv7(), state: "sent" } };
    const s = await seeded(t, relay.url, { commands });
    const inner = {
      samples: [sample("steps", 120, "count")],
      acks: [{ command_id: "c_1", version: 1, status: "rejected", reason: "type_not_in_scope" }],
      scope: { read: ["steps"], write: ["body_mass"] },
    };
    pages.push(page([await syncFrom(s.device, s.agent, 1, inner)]));
    const r = await run(["poll", "--once"], { home: s.home });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /samples steps=1; deleted 0; acks 1/);
    assert.deepEqual(ackRequests(relay.requests), [1]);
    const c = loadState(s.home).commands.c_1;
    assert.deepEqual([c.state, c.reason], ["rejected", "type_not_in_scope"]);
    const st = await run(["status"], { home: s.home });
    assert.match(st.stdout, /command c_1 v1 dietary_water to m_dev_1: rejected \(type_not_in_scope\)/);
  });

  it("a deleted_by_user ack moves an applied command for its version; terminal states absorb later acks", async (t) => {
    const pages = [];
    const relay = await pagedRelay(t, pages);
    const commands = {
      c_1: { to: "m_dev_1", version: 1, msg_id: uuidv7(), state: "applied" },
      c_2: { to: "m_dev_1", version: 1, msg_id: uuidv7(), state: "rejected", reason: "healthkit_denied" },
      c_3: { to: "m_dev_1", version: 1, msg_id: uuidv7(), state: "pending" },
      c_4: { to: "m_dev_1", version: 1, msg_id: uuidv7(), state: "sent" },
      c_5: { to: "m_dev_1", version: 2, msg_id: uuidv7(), state: "applied" },
      c_6: { to: "m_dev_2", version: 1, msg_id: uuidv7(), state: "applied" },
    };
    const s = await seeded(t, relay.url, { commands });
    const acks = [
      { command_id: "c_1", version: 1, status: "deleted_by_user" },
      { command_id: "c_1", version: 1, status: "applied" },
      { command_id: "c_1", version: 1, status: "rejected", reason: "invalid" },
      { command_id: "c_2", version: 1, status: "deleted_by_user" },
      { command_id: "c_2", version: 1, status: "applied" },
      { command_id: "c_3", version: 1, status: "deleted_by_user" },
      { command_id: "c_4", version: 1, status: "deleted_by_user" },
      { command_id: "c_5", version: 1, status: "deleted_by_user" },
      { command_id: "c_6", version: 1, status: "deleted_by_user" },
    ];
    pages.push(page([await syncFrom(s.device, s.agent, 1, { acks })]));
    const r = await run(["poll", "--once"], { home: s.home });
    assert.equal(r.status, 0, r.stderr);
    const state = loadState(s.home);
    assert.deepEqual(Object.fromEntries(Object.entries(state.commands).map(([id, c]) => [id, [c.state, c.reason ?? null]])), {
      c_1: ["deleted_by_user", null],
      c_2: ["rejected", "healthkit_denied"],
      c_3: ["deleted_by_user", null],
      c_4: ["deleted_by_user", null],
      c_5: ["applied", null],
      c_6: ["applied", null],
    });
    const st = await run(["status"], { home: s.home });
    assert.match(st.stdout, /command c_1 v1 dietary_water to m_dev_1: deleted_by_user/);
  });

  it("message_expired expires the sent command and member_revoked marks the member", async (t) => {
    const pages = [];
    const relay = await pagedRelay(t, pages);
    const msgId = uuidv7();
    const s = await seeded(t, relay.url, { commands: { c_1: { to: "m_dev_1", version: 1, msg_id: msgId, state: "sent" } } });
    pages.push(
      page([
        system(1, "message_expired", { msg_id: msgId, seq: 1, undelivered_to: ["m_dev_1"] }),
        system(2, "member_revoked", { member_id: "m_dev_1", revoked_by: "m_dev_1", self: true }),
        system(3, "something_new", {}),
      ]),
    );
    const r = await run(["poll", "--once"], { home: s.home });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /seq 2: member_revoked m_dev_1/);
    assert.match(r.stdout, /seq 3: something_new/);
    const state = loadState(s.home);
    assert.equal(state.commands.c_1.state, "expired");
    assert.equal(state.members.m_dev_1.state, "revoked");
    assert.deepEqual(ackRequests(relay.requests), [3]);
  });

  it("member_revoked for a member the relay still lists changes nothing", async (t) => {
    const revoked = system(1, "member_revoked", { member_id: "m_dev_1", revoked_by: "m_dev_1", self: true });
    const relay = await pagedRelay(t, [page([revoked])], () => json(200, { members: [{ member_id: "m_agent_1" }, { member_id: "m_dev_1" }] }));
    const s = await seeded(t, relay.url);
    const r = await run(["poll", "--once"], { home: s.home });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(loadState(s.home).members.m_dev_1.state, "confirmed");
    assert.deepEqual(ackRequests(relay.requests), [1]);
  });

  it("member_revoked waits while the member list is unavailable or malformed", async (t) => {
    const replies = [
      json(503, { error: "unavailable", message: "down" }, { "retry-after": "0" }),
      json(200, {}),
      json(200, { members: null }),
      json(200, { members: [{}] }),
      json(200, { members: [null] }),
    ];
    for (const reply of replies) {
      const revoked = system(1, "member_revoked", { member_id: "m_dev_1", revoked_by: "m_dev_1", self: true });
      const relay = await pagedRelay(t, [page([revoked])], () => reply);
      const s = await seeded(t, relay.url);
      const r = await run(["poll", "--once"], { home: s.home });
      assert.notEqual(r.status, 0, JSON.stringify(reply.json));
      assert.match(r.stderr, reply.status === 503 ? /relay 503 unavailable/ : /malformed member list/);
      assert.equal(loadState(s.home).members.m_dev_1.state, "confirmed");
      assert.deepEqual(ackRequests(relay.requests), []);
    }
  });

  it("the phone's ack after message_expired wins", async (t) => {
    const pages = [];
    const relay = await pagedRelay(t, pages);
    const commands = {
      c_1: { to: "m_dev_1", version: 1, msg_id: uuidv7(), state: "expired" },
      c_2: { to: "m_dev_1", version: 1, msg_id: uuidv7(), state: "expired" },
      c_3: { to: "m_dev_1", version: 1, msg_id: uuidv7(), state: "expired" },
      c_4: { to: "m_dev_1", version: 2, msg_id: uuidv7(), state: "expired" },
    };
    const s = await seeded(t, relay.url, { commands });
    const acks = [
      { command_id: "c_1", version: 1, status: "applied" },
      { command_id: "c_2", version: 1, status: "rejected", reason: "healthkit_denied" },
      { command_id: "c_3", version: 1, status: "deleted_by_user" },
      { command_id: "c_4", version: 1, status: "applied" },
    ];
    pages.push(page([await syncFrom(s.device, s.agent, 1, { acks })]));
    const r = await run(["poll", "--once"], { home: s.home });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(Object.fromEntries(Object.entries(loadState(s.home).commands).map(([id, c]) => [id, [c.state, c.reason ?? null]])), {
      c_1: ["applied", null],
      c_2: ["rejected", "healthkit_denied"],
      c_3: ["deleted_by_user", null],
      c_4: ["expired", null],
    });
  });

  it("a failed ack keeps the cursor and is resent by the next poll even with no new messages", async (t) => {
    const pages = [];
    let acksFail = true;
    const relay = await startRelay(t, (r) => {
      if (r.method === "GET") return pages.shift() ?? page([]);
      if (r.url === "/v1/acks") return acksFail ? json(500, { error: "internal_error", message: "boom" }, { "retry-after": "0" }) : json(200, { acked: 2, cursor: 2 });
      return null;
    });
    const s = await seeded(t, relay.url);
    pages.push(page([await syncFrom(s.device, s.agent, 1, {}), await syncFrom(s.device, s.agent, 2, {})]));
    const failed = await run(["poll", "--once"], { home: s.home });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /relay 500 internal_error/);
    assert.deepEqual(ackRequests(relay.requests), [2, 2]);
    assert.equal(loadState(s.home).last_seq, 2);
    assert.equal(loadState(s.home).acked_seq ?? 0, 0);
    acksFail = false;
    const resent = await run(["poll", "--once"], { home: s.home });
    assert.equal(resent.status, 0, resent.stderr);
    assert.deepEqual(ackRequests(relay.requests), [2, 2, 2]);
    assert.equal(loadState(s.home).acked_seq, 2);
    assert.equal((await run(["poll", "--once"], { home: s.home })).status, 0);
    assert.deepEqual(ackRequests(relay.requests), [2, 2, 2], "an acked cursor is not acked again");
  });

  for (const deviceState of ["rejected", "revoked"]) {
    it(`skips and acks data from a ${deviceState} member as unknown_sender`, async (t) => {
      const pages = [];
      const relay = await pagedRelay(t, pages);
      const s = await seeded(t, relay.url, { deviceState });
      pages.push(page([await syncFrom(s.device, s.agent, 1, { samples: [sample("steps", STEPS, "count")] })]));
      const r = await run(["poll", "--once"], { home: s.home });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /seq 1: skipped \(unknown_sender\)/);
      assert.deepEqual(ackRequests(relay.requests), [1]);
    });
  }

  for (const seqs of [[2, 2], [3, 1], [1, null]]) {
    it(`a page with seqs ${JSON.stringify(seqs)} exits 1 without acking`, async (t) => {
      const relay = await pagedRelay(t, [page(seqs.map((seq) => system(seq, "something_new", {})))]);
      const s = await seeded(t, relay.url);
      const r = await run(["poll", "--once"], { home: s.home });
      assert.equal(r.status, 1);
      assert.match(r.stderr, /message without an ascending seq/);
      assert.deepEqual(ackRequests(relay.requests), []);
      assert.equal(loadState(s.home).last_seq, 0);
    });
  }

  it("an empty page with has_more stops instead of looping", async (t) => {
    const relay = await pagedRelay(t, [page([], true)]);
    const s = await seeded(t, relay.url);
    const r = await run(["poll", "--once"], { home: s.home });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(relay.requests.length, 1);
  });

  it("member_joined with a malformed id or key stores nothing", async (t) => {
    const relay = await pagedRelay(t, [
      page([
        system(1, "member_joined", { member_id: "m_dev_2", device_name: "x", public_key: "x" }),
        system(2, "member_joined", { member_id: "m_dev_x", device_name: "x", public_key: (await generateKeys()).pk }),
      ]),
    ]);
    const s = await seeded(t, relay.url);
    const r = await run(["poll", "--once"], { home: s.home });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(Object.keys(loadState(s.home).members), ["m_dev_1"]);
    assert.deepEqual(ackRequests(relay.requests), [2]);
  });

  it("message_expired leaves a command the phone already answered alone", async (t) => {
    const msgId = uuidv7();
    const relay = await pagedRelay(t, [page([system(1, "message_expired", { msg_id: msgId, seq: 1, undelivered_to: ["m_dev_1"] })])]);
    const s = await seeded(t, relay.url, { commands: { c_1: { to: "m_dev_1", version: 1, msg_id: msgId, state: "applied" } } });
    assert.equal((await run(["poll", "--once"], { home: s.home })).status, 0);
    assert.equal(loadState(s.home).commands.c_1.state, "applied");
  });

  it("message_expired expires a command left pending by a failed E10 the relay had stored", async (t) => {
    const msgId = uuidv7();
    const relay = await pagedRelay(t, [page([system(1, "message_expired", { msg_id: msgId, seq: 1, undelivered_to: ["m_dev_1"] })])]);
    const s = await seeded(t, relay.url, { commands: { c_1: { to: "m_dev_1", version: 1, msg_id: msgId, state: "pending" } } });
    assert.equal((await run(["poll", "--once"], { home: s.home })).status, 0);
    assert.equal(loadState(s.home).commands.c_1.state, "expired");
  });

  it("a held pair_proof is processed by the first poll after pair stored the proof: it confirms, sends confirmed, then opens the phone's data", async (t) => {
    const pages = [];
    const posted = [];
    const relay = await startRelay(t, (r) => {
      if (r.method === "GET") return pages.shift() ?? page([]);
      if (r.url === "/v1/acks") return json(200, { acked: 1, cursor: JSON.parse(r.body).up_to_seq });
      if (r.url === "/v1/messages") return posted.push(JSON.parse(r.body)), json(201, { seq: 9, msg_id: JSON.parse(r.body).msg_id });
      return null;
    });
    const s = await seeded(t, relay.url);
    const other = await generateKeys();
    const c = b64u(new Uint8Array(16).fill(3));
    const proof = await controlFrom(other, s.agent, 2, { v: 1, type: "pair_proof", proof: pairProof(c, s.agent.pk, other.pk) }, "m_dev_2");
    const data = await syncFrom(other, s.agent, 3, { samples: [sample("steps", STEPS, "count")] }, "m_dev_2");
    pages.push(page([system(1, "member_joined", { member_id: "m_dev_2", device_name: "Second phone", public_key: other.pk }), proof]), page([proof, data]));
    assert.equal((await run(["poll", "--once"], { home: s.home })).status, 0);
    assert.deepEqual(ackRequests(relay.requests), [1]);
    updateState(s.home, (state) => (state.members.m_dev_2.proof = pairProof(c, s.agent.pk, other.pk)));
    const r = await run(["poll", "--once"], { home: s.home });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /seq 2: m_dev_2 picked the right code; confirmed\nseq 3: sync from m_dev_2: samples steps=1/);
    assert.deepEqual(ackRequests(relay.requests), [1, 3]);
    assert.equal(relay.requests.filter((q) => q.method === "GET").at(-1).url, "/v1/messages?after=1&limit=100");
    assert.deepEqual(posted.map((e) => [e.kind, e.recipients.map((x) => x.member_id)]), [["control", ["m_dev_2"]]]);
    assert.equal(await openEnvelope(posted[0], { hubId: HUB, memberId: "m_dev_2", sk: other.sk, registry: { m_agent_1: s.agent.pk }, kind: "control" }), '{"v":1,"type":"confirmed"}');
    assert.deepEqual(loadState(s.home).members.m_dev_2, { name: "Second phone", pk: other.pk, state: "confirmed" });
  });

  it("uses and keeps a confirmation that pair saved while the page was being fetched", async (t) => {
    const other = await generateKeys();
    let s;
    let pending;
    const relay = await startRelay(t, (r) => {
      if (r.url === "/v1/acks") return json(200, { acked: 1, cursor: 1 });
      const state = loadState(s.home);
      state.members.m_dev_2.state = "confirmed";
      saveState(s.home, state);
      return page([pending]);
    });
    s = await seeded(t, relay.url);
    const state = loadState(s.home);
    state.members.m_dev_2 = { name: "Second phone", pk: other.pk, state: "joined" };
    saveState(s.home, state);
    pending = await syncFrom(other, s.agent, 1, {}, "m_dev_2");
    const r = await run(["poll", "--once"], { home: s.home });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /seq 1: sync from m_dev_2/);
    assert.deepEqual(ackRequests(relay.requests), [1]);
    assert.equal(loadState(s.home).members.m_dev_2.state, "confirmed");
  });

  it("keeps what pair and send-water saved while a message was being decrypted", async (t) => {
    const commands = { c_1: { to: "m_dev_1", version: 1, msg_id: uuidv7(), state: "sent" } };
    const s = await seeded(t, "http://127.0.0.1:9", { commands });
    const other = await generateKeys();
    const msg = await syncFrom(s.device, s.agent, 1, { acks: [{ command_id: "c_1", version: 1, status: "applied" }] });
    const handled = handleMessage(s.home, loadState(s.home), msg);
    const concurrent = loadState(s.home);
    concurrent.members.m_dev_2 = { name: "Second phone", pk: other.pk, state: "confirmed" };
    concurrent.commands.c_2 = { to: "m_dev_1", version: 1, msg_id: uuidv7(), state: "pending" };
    saveState(s.home, concurrent);
    await handled;
    const state = loadState(s.home);
    assert.equal(state.commands.c_1.state, "applied");
    assert.equal(state.commands.c_2?.state, "pending");
    assert.equal(state.members.m_dev_2?.state, "confirmed");
  });

  it("a malformed page exits 1 without acking", async (t) => {
    const relay = await pagedRelay(t, [json(200, { nope: true })]);
    const s = await seeded(t, relay.url);
    const r = await run(["poll", "--once"], { home: s.home });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /malformed message page/);
    assert.deepEqual(ackRequests(relay.requests), []);
  });

  it("a revoked token exits 1 with a hint to register again", async (t) => {
    const relay = await pagedRelay(t, [json(401, { error: "invalid_token", message: "token is not valid" })]);
    const s = await seeded(t, relay.url);
    const r = await run(["poll"], { home: s.home });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /invalid_token.*\(token revoked or the hub was deleted: no plan within 7 days or 7 days after the plan ended; remove state\.json, then init and pair again\)/);
    assert.equal(relay.requests.length, 1);
  });
});

describe("retries", () => {
  function flaky(t, replies) {
    let i = 0;
    return startRelay(t, (r) => (r.url.startsWith("/v1/messages") ? (replies[i++] ?? page([])) : null));
  }

  it("retries a 429 once after Retry-After seconds", async (t) => {
    const relay = await flaky(t, [json(429, { error: "rate_limited", message: "slow down" }, { "retry-after": "1" }), page([])]);
    const s = await seeded(t, relay.url);
    const r = await run(["poll", "--once"], { home: s.home });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(relay.requests.length, 2);
    assert.ok(relay.requests[1].at - relay.requests[0].at >= 950, "waited for Retry-After");
  });

  it("Retry-After: 0 retries at once", async (t) => {
    const relay = await flaky(t, [json(503, { error: "internal_error", message: "x" }, { "retry-after": "0" }), page([])]);
    const s = await seeded(t, relay.url);
    assert.equal((await run(["poll", "--once"], { home: s.home })).status, 0);
    assert.equal(relay.requests.length, 2);
    assert.ok(relay.requests[1].at - relay.requests[0].at < 900);
  });

  it("waits 1 s when Retry-After is missing", async (t) => {
    const relay = await flaky(t, [json(429, { error: "rate_limited", message: "x", details: { retry_after_s: 0 } }), page([])]);
    const s = await seeded(t, relay.url);
    assert.equal((await run(["poll", "--once"], { home: s.home })).status, 0);
    assert.equal(relay.requests.length, 2);
    assert.ok(relay.requests[1].at - relay.requests[0].at >= 950);
  });

  it("retries only once", async (t) => {
    const busy = json(500, { error: "internal_error", message: "boom" }, { "retry-after": "0" });
    const relay = await flaky(t, [busy, busy, page([])]);
    const s = await seeded(t, relay.url);
    const r = await run(["poll", "--once"], { home: s.home });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /relay 500 internal_error: boom/);
    assert.equal(relay.requests.length, 2);
  });

  it("does not wait for a Retry-After above 60 s", async (t) => {
    const relay = await flaky(t, [json(429, { error: "rate_limited", message: "later" }, { "retry-after": "120" }), page([])]);
    const s = await seeded(t, relay.url);
    assert.equal((await run(["poll", "--once"], { home: s.home })).status, 1);
    assert.equal(relay.requests.length, 1);
  });

  for (const status of [400, 404, 409]) {
    it(`never retries a ${status}`, async (t) => {
      const relay = await flaky(t, [json(status, { error: "invalid_request", message: "no" }, { "retry-after": "0" }), page([])]);
      const s = await seeded(t, relay.url);
      assert.equal((await run(["poll", "--once"], { home: s.home })).status, 1);
      assert.equal(relay.requests.length, 1);
    });
  }

  it("a 2xx that is not JSON is an error", async (t) => {
    const relay = await startRelay(t, () => ({ status: 200, json: undefined, headers: { "content-type": "text/plain" } }));
    const s = await seeded(t, relay.url);
    const r = await run(["poll", "--once"], { home: s.home });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not JSON/);
  });
});

describe("send-water (E10)", () => {
  it("seals one dietary_water write for the phone only and records the command", async (t) => {
    const relay = await startRelay(t, (r, all) => (r.url === "/v1/messages" ? json(201, { seq: 40 + all.length, msg_id: JSON.parse(r.body).msg_id }) : null));
    const s = await seeded(t, relay.url);
    const r = await run(["send-water", "0.25", "--to", "m_dev_1"], { home: s.home });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /0\.25/);
    const [req] = relay.requests;
    assert.equal(req.method, "POST");
    assert.equal(req.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(req.headers["content-type"], "application/json; charset=utf-8");
    const envelope = JSON.parse(req.body);
    assert.deepEqual(Object.keys(envelope).sort(), ["ciphertext", "created_at", "from", "kind", "msg_id", "nonce", "recipients", "v"]);
    assert.match(envelope.msg_id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.deepEqual(envelope.recipients.map((x) => x.member_id), ["m_dev_1"]);
    const inner = JSON.parse(await openEnvelope(envelope, { hubId: HUB, memberId: "m_dev_1", sk: s.device.sk, registry: { m_agent_1: s.agent.pk } }));
    const [command] = inner.commands;
    assert.match(command.start, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.deepEqual(inner, {
      v: 1,
      type: "commands",
      commands: [{ command_id: "c_1", version: 1, op: "write", type: "dietary_water", value: 0.25, unit: "L", start: command.start, end: command.start }],
    });
    assert.deepEqual(loadState(s.home).commands.c_1, { to: "m_dev_1", version: 1, msg_id: envelope.msg_id, state: "sent", seq: 41 });
    assert.equal((await run(["send-water", "1", "--to", "m_dev_1"], { home: s.home })).status, 0);
    assert.deepEqual(Object.keys(loadState(s.home).commands), ["c_1", "c_2"]);
    const st = await run(["status"], { home: s.home });
    assert.match(st.stdout, /command c_1 v1 dietary_water to m_dev_1: sent/);
  });

  it("a retried E10 reuses the same envelope and msg_id", async (t) => {
    let calls = 0;
    const relay = await startRelay(t, () => (calls++ === 0 ? json(503, { error: "internal_error", message: "x" }, { "retry-after": "0" }) : json(201, { seq: 7 })));
    const s = await seeded(t, relay.url);
    const r = await run(["send-water", "0.5", "--to", "m_dev_1"], { home: s.home });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(relay.requests.length, 2);
    assert.equal(relay.requests[0].body, relay.requests[1].body);
  });

  it("keeps what poll saved while E10 was in flight", async (t) => {
    let s;
    const relay = await startRelay(t, () => {
      saveState(s.home, { ...loadState(s.home), last_seq: 5, acked_seq: 5 });
      return json(201, { seq: 6 });
    });
    s = await seeded(t, relay.url);
    const r = await run(["send-water", "0.5", "--to", "m_dev_1"], { home: s.home });
    assert.equal(r.status, 0, r.stderr);
    const state = loadState(s.home);
    assert.equal(state.last_seq, 5);
    assert.equal(state.acked_seq, 5);
    assert.equal(state.commands.c_1.state, "sent");
  });

  it("keeps an app ack that poll saved while E10 was in flight", async (t) => {
    let s;
    const relay = await startRelay(t, () => {
      const state = loadState(s.home);
      state.commands.c_1.state = "applied";
      saveState(s.home, state);
      return json(201, { seq: 6 });
    });
    s = await seeded(t, relay.url);
    const r = await run(["send-water", "0.5", "--to", "m_dev_1"], { home: s.home });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(loadState(s.home).commands.c_1.state, "applied");
  });

  it("a failed E10 leaves the command pending and exits 1", async (t) => {
    const relay = await startRelay(t, () => json(404, { error: "unknown_recipient", message: "recipient revoked" }));
    const s = await seeded(t, relay.url);
    const r = await run(["send-water", "0.5", "--to", "m_dev_1"], { home: s.home });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unknown_recipient/);
    assert.equal(loadState(s.home).commands.c_1.state, "pending");
  });

  for (const deviceState of ["joined", "rejected", "revoked"]) {
    it(`refuses a ${deviceState} target with exit 2 and sends nothing`, async (t) => {
      const relay = await startRelay(t, () => null);
      const s = await seeded(t, relay.url, { deviceState });
      const r = await run(["send-water", "0.5", "--to", "m_dev_1"], { home: s.home });
      assert.equal(r.status, 2);
      assert.match(r.stderr, /m_dev_1 is not a confirmed device/);
      assert.equal(relay.requests.length, 0);
    });
  }

  it("refuses an unknown target", async (t) => {
    const relay = await startRelay(t, () => null);
    const s = await seeded(t, relay.url);
    assert.equal((await run(["send-water", "0.5", "--to", "m_dev_7"], { home: s.home })).status, 2);
  });
});

describe("state lock", () => {
  const sendRelay = (t) => startRelay(t, (r, all) => (r.url === "/v1/messages" ? json(201, { seq: all.length }) : null));
  const held = (file) => {
    writeFileSync(file, String(process.pid));
    const old = new Date(Date.now() - 60_000);
    utimesSync(file, old, old);
  };
  const orphaned = (file) => writeFileSync(file, String(spawnSync(process.execPath, ["-e", ""]).pid));

  it("waits while a running process holds the lock, however old it is, and releases it afterwards", async (t) => {
    const relay = await sendRelay(t);
    const s = await seeded(t, relay.url);
    const lock = join(s.home, "state.lock");
    held(lock);
    const sent = run(["send-water", "0.5", "--to", "m_dev_1"], { home: s.home });
    await new Promise((done) => setTimeout(done, 500));
    assert.equal(relay.requests.length, 0);
    assert.deepEqual(loadState(s.home).commands, {});
    unlinkSync(lock);
    const r = await sent;
    assert.equal(r.status, 0, r.stderr);
    assert.equal(loadState(s.home).commands.c_1.state, "sent");
    assert.deepEqual(readdirSync(s.home), ["state.json"]);
  });

  it("takes over a lock left by a killed process", async (t) => {
    const relay = await sendRelay(t);
    const s = await seeded(t, relay.url);
    orphaned(join(s.home, "state.lock"));
    const r = await run(["send-water", "0.5", "--to", "m_dev_1"], { home: s.home });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(loadState(s.home).commands.c_1.state, "sent");
    assert.deepEqual(readdirSync(s.home), ["state.json"]);
  });

  it("several waiters take over one orphaned lock without deleting each other's fresh lock", async (t) => {
    const relay = await sendRelay(t);
    const s = await seeded(t, relay.url);
    orphaned(join(s.home, "state.lock"));
    const results = await Promise.all(Array.from({ length: 6 }, () => run(["send-water", "0.5", "--to", "m_dev_1"], { home: s.home })));
    for (const r of results) assert.equal(r.status, 0, r.stderr);
    const { commands } = loadState(s.home);
    assert.deepEqual(Object.keys(commands).sort(), ["c_1", "c_2", "c_3", "c_4", "c_5", "c_6"]);
    assert.equal(new Set(Object.values(commands).map((c) => c.msg_id)).size, 6);
    assert.ok(Object.values(commands).every((c) => c.state === "sent"));
    assert.deepEqual(readdirSync(s.home), ["state.json"]);
  });

  it("leaves an orphaned lock alone while another waiter holds the claim on it", async (t) => {
    const relay = await sendRelay(t);
    const s = await seeded(t, relay.url);
    orphaned(join(s.home, "state.lock"));
    held(join(s.home, "state.lock.claim"));
    const sent = run(["send-water", "0.5", "--to", "m_dev_1"], { home: s.home });
    await new Promise((done) => setTimeout(done, 500));
    assert.equal(relay.requests.length, 0);
    assert.ok(existsSync(join(s.home, "state.lock")));
    unlinkSync(join(s.home, "state.lock.claim"));
    const r = await sent;
    assert.equal(r.status, 0, r.stderr);
    assert.equal(loadState(s.home).commands.c_1.state, "sent");
    assert.deepEqual(readdirSync(s.home), ["state.json"]);
  });

  it("fails closed, removing nothing, when a killed waiter left its claim beside the orphaned lock", async (t) => {
    const relay = await sendRelay(t);
    const s = await seeded(t, relay.url);
    orphaned(join(s.home, "state.lock"));
    orphaned(join(s.home, "state.lock.claim"));
    const r = await run(["send-water", "0.5", "--to", "m_dev_1"], { home: s.home });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /state\.lock\.claim was left by a process that is no longer running; remove it and retry/);
    assert.equal(relay.requests.length, 0);
    assert.deepEqual(loadState(s.home).commands, {});
    assert.deepEqual(readdirSync(s.home).sort(), ["state.json", "state.lock", "state.lock.claim"]);
  });

  it("a holder whose lock was taken over does not delete the new holder's lock", async (t) => {
    const s = await seeded(t, "http://127.0.0.1:9");
    const lock = join(s.home, "state.lock");
    updateState(s.home, (state) => {
      unlinkSync(lock);
      writeFileSync(lock, "next-holder");
      state.last_seq = 7;
    });
    assert.equal(readFileSync(lock, "utf8"), "next-holder");
    assert.equal(loadState(s.home).last_seq, 7);
  });

  it("parallel send-water runs lose no command", async (t) => {
    const relay = await sendRelay(t);
    const s = await seeded(t, relay.url);
    const results = await Promise.all(Array.from({ length: 6 }, () => run(["send-water", "0.5", "--to", "m_dev_1"], { home: s.home })));
    for (const r of results) assert.equal(r.status, 0, r.stderr);
    const { commands } = loadState(s.home);
    assert.deepEqual(Object.keys(commands).sort(), ["c_1", "c_2", "c_3", "c_4", "c_5", "c_6"]);
    assert.equal(new Set(Object.values(commands).map((c) => c.msg_id)).size, 6);
    assert.ok(Object.values(commands).every((c) => c.state === "sent"));
    assert.deepEqual(readdirSync(s.home), ["state.json"]);
  });
});

describe("status", () => {
  it("shows hub, members with their confirmation state and last seq, without secrets", async (t) => {
    const relay = await startRelay(t, () => null);
    const s = await seeded(t, relay.url);
    const state = loadState(s.home);
    state.members.m_dev_2 = { name: "Other", pk: s.device.pk, state: "joined", proof: b64u(new Uint8Array(32).fill(9)) };
    state.last_seq = 12;
    saveState(s.home, state);
    secretsSeen.push(state.members.m_dev_2.proof);
    const r = await run(["status"], { home: s.home });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`hub ${HUB}, this agent m_agent_1`));
    assert.match(r.stdout, /member m_dev_1 "Test iPhone": confirmed/);
    assert.match(r.stdout, /member m_dev_2 "Other": not confirmed/);
    assert.match(r.stdout, /last seq 12/);
    assert.equal(relay.requests.length, 0, "status is local");
  });
});

describe('diagnostics transport tolerance', () => {
  for (const diagnostics of [undefined, 'archive']) it(`authenticates and skips ${diagnostics ?? 'legacy'} diagnostics, persists ACK/cursor, then processes sync after reopen`, async t => {
    let message;
    const relay = await startRelay(t, r => {
      if (r.url.startsWith('/v1/messages?')) return page(message ? [message] : []);
      if (r.url === '/v1/acks') return json(200, { acked: 1, cursor: JSON.parse(r.body).up_to_seq });
    });
    const s = await seeded(t, relay.url);
    const marker = 'window_start';
    const envelope = await sealMarkedEnvelope({ hubId: HUB, from: 'm_dev_1', senderPrivateKey: b64uDecode(s.device.sk),
      recipients: [{ memberId: 'm_agent_1', publicKey: b64uDecode(s.agent.pk) }],
      plaintext: JSON.stringify(diagnosticsFixture()), diagnostics });
    message = { ...envelope, seq: 1 };
    const first = await run(['poll', '--once'], { home: s.home });
    assert.equal(first.status, 0);
    assert.match(first.stdout, /seq 1: skipped \(inner_invalid\)/);
    assert.equal((first.stdout + first.stderr).includes(marker), false);
    assert.equal((first.stdout + first.stderr).includes('a'.repeat(32)), false);
    assert.equal(loadState(s.home).last_seq, 1);
    assert.equal(loadState(s.home).acked_seq, 1);
    assert.deepEqual(ackRequests(relay.requests), [1]);
    message = await syncFrom(s.device, s.agent, 2, {});
    const second = await run(['poll', '--once'], { home: s.home });
    assert.equal(second.status, 0);
    assert.match(second.stdout, /seq 2: sync from m_dev_1/);
    assert.equal(loadState(s.home).last_seq, 2);
    assert.equal(loadState(s.home).acked_seq, 2);
    assert.deepEqual(ackRequests(relay.requests), [1, 2]);
    const fetches = relay.requests.filter(r => r.url.startsWith('/v1/messages?'));
    assert.equal(new URL(fetches[1].url, relay.url).searchParams.get('after'), '1');
  });
});

for (const mode of ['added', 'stripped', 'wrong_inner', 'invalid', 'wrong_kind']) it(`diagnostics ${mode} is poison-ACKed without content output`, async t => {
  let message;
  const relay = await startRelay(t, r => {
    if (r.url.startsWith('/v1/messages?')) return page([message]);
    if (r.url === '/v1/acks') return json(200, { cursor: JSON.parse(r.body).up_to_seq });
  });
  const s = await seeded(t, relay.url);
  const body = mode === 'wrong_inner' ? { v: 1, type: 'sync', device: 'm_dev_1', samples: [], deleted: [], acks: [], more: false } : diagnosticsFixture();
  const envelope = await sealMarkedEnvelope({ hubId: HUB, from: 'm_dev_1', senderPrivateKey: b64uDecode(s.device.sk),
    recipients: [{ memberId: 'm_agent_1', publicKey: b64uDecode(s.agent.pk) }], plaintext: JSON.stringify(body), diagnostics: mode === 'added' ? undefined : 'archive' });
  if (mode === 'added') envelope.diagnostics = 'archive';
  if (mode === 'stripped') delete envelope.diagnostics;
  if (mode === 'invalid') envelope.diagnostics = null;
  if (mode === 'wrong_kind') envelope.kind = 'control';
  message = { ...envelope, seq: 1 };
  const result = await run(['poll', '--once'], { home: s.home });
  assert.equal(result.status, 0);
  const code = ['added', 'stripped'].includes(mode) ? 'hpke_open_failed' : mode === 'wrong_inner' ? 'inner_invalid' : 'malformed';
  assert.ok(result.stdout.includes(`seq 1: skipped (${code})`));
  assert.doesNotMatch(result.stdout + result.stderr, /window_start|archive_ref|sync from|aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/);
  assert.deepEqual(ackRequests(relay.requests), [1]);
  assert.equal(loadState(s.home).last_seq, 1);
  assert.equal(loadState(s.home).acked_seq, 1);
});

for (const mode of ['request', 'reply', 'added', 'stripped', 'wrong_inner', 'invalid', 'dual']) it(`access ${mode} is authenticated/skipped and ACKed; sync works after reopen`, async t => {
  let message;
  const relay = await startRelay(t, r => {
    if (r.url.startsWith('/v1/messages?')) return page([message]);
    if (r.url === '/v1/acks') return json(200, { cursor: JSON.parse(r.body).up_to_seq });
  });
  const s = await seeded(t, relay.url), access = mode === 'request' ? 'request' : 'reply';
  const inner = mode === 'wrong_inner' ? { v: 1, type: 'pair_proof', proof: 'PRIVATE' } : { v: 1, type: `access_${access}`, request_ref: 'PRIVATE', reason: 'PRIVATE reason' };
  const e = await sealMarkedEnvelope({ hubId: HUB, from: 'm_dev_1', senderPrivateKey: b64uDecode(s.device.sk), recipients: [{ memberId: 'm_agent_1', publicKey: b64uDecode(s.agent.pk) }], kind: 'control', plaintext: JSON.stringify(inner), access: mode === 'added' ? undefined : access });
  if (mode === 'added') e.access = access;
  if (mode === 'stripped') delete e.access;
  if (mode === 'invalid') e.access = null;
  if (mode === 'dual') e.diagnostics = 'reply';
  message = { ...e, seq: 1 };
  const first = await run(['poll', '--once'], { home: s.home });
  assert.equal(first.status, 0);
  assert.equal((first.stdout + first.stderr).includes('PRIVATE'), false);
  assert.equal(loadState(s.home).acked_seq, 1);
  message = await syncFrom(s.device, s.agent, 2, {});
  const next = await run(['poll', '--once'], { home: s.home });
  assert.equal(next.status, 0); assert.match(next.stdout, /seq 2: sync from m_dev_1/);
  assert.equal(loadState(s.home).last_seq, 2); assert.deepEqual(ackRequests(relay.requests), [1, 2]);
});
