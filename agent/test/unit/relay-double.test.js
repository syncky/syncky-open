import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { generateKeyPair } from "../../src/crypto.js";
import { b64uEncode } from "../../src/encoding.js";
import { openEnvelope, sealEnvelope, serializeEnvelope } from "../support/envelope.js";
import { isHubId, isPairingId, isPairingToken, isToken, isUuidV7, isWebhookSecret } from "../../src/ids.js";
import { createRelayClient } from "../../src/relay-client.js";
import { verifyWebhook } from "../support/webhook-signature.js";
import { startRelayDouble } from "../support/relay-double.js";

const INVITE = "double-invite";
const fastClient = (url, token) => {
  let clock = 0;
  return createRelayClient({ baseUrl: url, token, now: () => clock, sleep: async (ms) => { clock += ms; }, random: () => 0 });
};

async function rawPost(url, path, body, headers = {}) {
  const res = await fetch(`${url}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function startReceiver() {
  const received = [];
  let respondWith = 200;
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      received.push({ headers: req.headers, raw: Buffer.concat(chunks) });
      res.writeHead(respondWith, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/syncky/webhook`,
    received,
    respond: (status) => {
      respondWith = status;
    },
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

describe("relay double smoke", () => {
  let relay;
  let receiver;
  let agentKeys;
  let phoneKeys;
  let agent;
  let reg;
  let phone;
  let pairResponse;

  before(async () => {
    relay = await startRelayDouble({ invite: INVITE });
    receiver = await startReceiver();
    agentKeys = await generateKeyPair();
    phoneKeys = await generateKeyPair();
  });

  after(async () => {
    await receiver.stop();
    await relay.stop();
  });

  it("serves health and rejects a wrong invite", async () => {
    const anon = fastClient(relay.url);
    assert.deepEqual(await anon.health(), { ok: true, service: "syncky-relay", api: 1 });
    await assert.rejects(anon.register({ invite: "wrong", name: "agent", publicKey: b64uEncode(agentKeys.publicKey) }), {
      status: 403,
      code: "invalid_invite",
    });
  });

  it("registers an agent with §2.2 formats", async () => {
    for (const name of ["a\u200eb", "a\u200db", "\ufeffAgent"]) {
      await assert.rejects(fastClient(relay.url).register({ invite: INVITE, name, publicKey: b64uEncode(agentKeys.publicKey) }), {
        status: 400,
        code: "invalid_request",
      });
    }
    reg = await fastClient(relay.url).register({ invite: INVITE, name: "  home server ", publicKey: b64uEncode(agentKeys.publicKey) });
    assert.ok(isHubId(reg.hub_id));
    assert.equal(reg.member_id, "m_agent_1");
    assert.ok(isToken(reg.token));
    assert.ok(reg.token.startsWith(`sk_${reg.hub_id}_`));
    assert.ok(isWebhookSecret(reg.webhook_secret));
    agent = fastClient(relay.url, reg.token);
    assert.equal(relay.state.member("m_agent_1").name, "home server");
  });

  it("creates a pairing and lets a phone pair", async () => {
    const pairing = await agent.createPairing();
    assert.ok(isPairingId(pairing.pairing_id));
    assert.ok(isPairingToken(pairing.pairing_token));
    assert.equal(pairing.hub_id, reg.hub_id);
    assert.equal((await agent.getPairing(pairing.pairing_id)).status, "pending");

    for (const device_name of ["a\u200eb", "a\u200db", "Phone\ufeff"]) {
      const invalid = await rawPost(relay.url, "/v1/pair", {
        hub_id: reg.hub_id, pairing_token: pairing.pairing_token, public_key: b64uEncode(phoneKeys.publicKey), device_name,
      });
      assert.equal(invalid.status, 400);
      assert.equal(invalid.body.error, "invalid_request");
    }

    const res = await rawPost(relay.url, "/v1/pair", {
      hub_id: reg.hub_id,
      pairing_token: pairing.pairing_token,
      public_key: b64uEncode(phoneKeys.publicKey),
      device_name: "iPhone",
    });
    assert.equal(res.status, 201);
    pairResponse = res.body;
    assert.equal(pairResponse.member_id, "m_dev_1");
    assert.deepEqual(
      pairResponse.members.map((m) => m.member_id),
      ["m_agent_1", "m_dev_1"],
    );
    phone = fastClient(relay.url, pairResponse.token);

    const status = await agent.getPairing(pairing.pairing_id);
    assert.equal(status.status, "completed");
    assert.equal(status.member_id, "m_dev_1");
    assert.equal(status.public_key, b64uEncode(phoneKeys.publicKey));

    const again = await rawPost(relay.url, "/v1/pair", {
      hub_id: reg.hub_id,
      pairing_token: pairing.pairing_token,
      public_key: b64uEncode(phoneKeys.publicKey),
      device_name: "iPhone",
    });
    assert.equal(again.status, 410);
    assert.equal(again.body.error, "pairing_expired");
    await assert.rejects(phone.createPairing(), { status: 403, code: "forbidden" });
  });

  it("records bounded agent cadence only on accepted polls and ignores the device's interval", async () => {
    const poll = (token, query) => fetch(`${relay.url}/v1/messages?${query}`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal((await poll(reg.token, "poll_interval_s=3600")).status, 200);
    assert.equal(relay.state.member(reg.member_id).pollIntervalS, 3600);
    for (const query of ["poll_interval_s=86401", "poll_interval_s=300&poll_interval_s=600", "poll_interval_s=1e3"]) {
      assert.equal((await poll(reg.token, query)).status, 400);
      assert.equal(relay.state.member(reg.member_id).pollIntervalS, 3600);
    }
    assert.equal((await poll(pairResponse.token, "poll_interval_s=invalid")).status, 200);
    assert.equal(relay.state.member(pairResponse.member_id).pollIntervalS, undefined);
    assert.equal((await poll(reg.token, "")).status, 200);
    assert.equal(relay.state.member(reg.member_id).pollIntervalS, 1800);
  });

  it("carries an envelope from the phone to the agent, with paging, idempotency and acks", async () => {
    const envelope = await sealEnvelope({
      hubId: reg.hub_id,
      from: "m_dev_1",
      recipients: [{ memberId: "m_agent_1", publicKey: agentKeys.publicKey }],
      senderPrivateKey: phoneKeys.privateKey,
      plaintext: '{"v":1,"type":"sync","device":"m_dev_1","samples":[]}',
    });
    const raw = serializeEnvelope(envelope);
    const first = await phone.postMessage(raw);
    assert.equal(first.duplicate, false);
    const dup = await phone.postMessage(raw);
    assert.deepEqual(dup, { seq: first.seq, msg_id: envelope.msg_id, duplicate: true });
    const conflict = serializeEnvelope({ ...envelope, created_at: "2026-01-01T00:00:00Z" });
    await assert.rejects(phone.postMessage(conflict), { status: 409, code: "msg_id_conflict" });
    await assert.rejects(phone.postMessage(serializeEnvelope({ ...envelope, from: "m_agent_1" })), {
      status: 400,
      code: "invalid_envelope",
      details: { field: "/from" },
    });

    const page1 = await agent.getMessages({ limit: 1 });
    assert.equal(page1.messages.length, 1);
    assert.equal(page1.has_more, true);
    const joined = page1.messages[0];
    assert.equal(joined.kind, "system");
    assert.equal(joined.event, "member_joined");
    assert.ok(isUuidV7(joined.msg_id));
    assert.deepEqual(Object.keys(joined.body).sort(), ["device_name", "member_id", "pairing_id", "public_key", "role"]);

    const page2 = await agent.getMessages({ after: page1.next_after });
    assert.equal(page2.has_more, false);
    assert.equal(page2.messages.length, 1);
    const delivered = page2.messages[0];
    assert.equal(delivered.seq, first.seq);
    const { seq, ...stored } = delivered;
    assert.deepEqual(stored, envelope);
    const plaintext = await openEnvelope({
      envelope: stored,
      hubId: reg.hub_id,
      self: { memberId: "m_agent_1", privateKey: agentKeys.privateKey },
      senderKeyOf: (id) => (id === "m_dev_1" ? phoneKeys.publicKey : null),
    });
    assert.match(new TextDecoder().decode(plaintext), /"type":"sync"/);

    assert.deepEqual(await agent.ack(page2.next_after), { acked: 2, cursor: seq });
    assert.deepEqual(await agent.getMessages(), { messages: [], next_after: seq, has_more: false });
    assert.deepEqual(await agent.ack(1), { acked: 0, cursor: seq });
    await assert.rejects(agent.ack(seq + 100), { status: 400, code: "invalid_request" });
  });

  it("pushes signed webhook batches that verifyWebhook accepts", async () => {
    assert.deepEqual((await (await fetch(`${relay.url}/v1/members/me`, { method: "PATCH", headers: { Authorization: `Bearer ${reg.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ webhook_url: receiver.url }) })).json()), { member_id: "m_agent_1", webhook_url: receiver.url });
    const envelope = await sealEnvelope({
      hubId: reg.hub_id,
      from: "m_dev_1",
      recipients: [{ memberId: "m_agent_1", publicKey: agentKeys.publicKey }],
      senderPrivateKey: phoneKeys.privateKey,
      plaintext: "{}",
    });
    const { seq } = await phone.postMessage(serializeEnvelope(envelope));

    receiver.respond(500);
    const failed = await relay.deliverWebhooks();
    assert.deepEqual(failed.map((r) => r.status), [500]);
    assert.deepEqual(relay.state.pendingSeqs("m_agent_1"), [seq]);

    receiver.respond(200);
    const ok = await relay.deliverWebhooks();
    assert.deepEqual(ok.map((r) => [r.status, r.seqs]), [[200, [seq]]]);
    assert.deepEqual(relay.state.pendingSeqs("m_agent_1"), []);

    const hit = receiver.received.at(-1);
    assert.equal(hit.headers["user-agent"], "syncky-relay/1");
    assert.ok(isUuidV7(hit.headers["x-syncky-delivery"]));
    const verdict = verifyWebhook({
      secret: reg.webhook_secret,
      timestampHeader: hit.headers["x-syncky-timestamp"],
      signatureHeader: hit.headers["x-syncky-signature"],
      rawBody: new Uint8Array(hit.raw),
    });
    assert.equal(verdict, "valid");
    const batch = JSON.parse(hit.raw.toString("utf8"));
    assert.equal(batch.hub_id, reg.hub_id);
    assert.deepEqual(batch.messages.map((m) => m.msg_id), [envelope.msg_id]);

    const { webhook_secret: rotated } = (await (await fetch(`${relay.url}/v1/members/me/webhook-secret`, { method: "POST", headers: { Authorization: `Bearer ${reg.token}` } })).json());
    assert.ok(isWebhookSecret(rotated));
    assert.notEqual(rotated, reg.webhook_secret);
    assert.equal((await fetch(`${relay.url}/v1/members/me`, { method: "PATCH", headers: { Authorization: `Bearer ${reg.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ webhook_url: null }) })).status, 200);
    assert.equal(relay.state.member("m_agent_1").webhookUrl, null);
  });

  it("injects failures and delays per route", async () => {
    relay.failNext("listMembers", 503);
    relay.failNext("E5", 429, { "Retry-After": "0" });
    const members = await agent.listMembers();
    assert.deepEqual(
      members.members.map((m) => m.member_id),
      ["m_agent_1", "m_dev_1"],
    );
    const listCalls = relay.state.requests.filter((r) => r.route === "listMembers");
    assert.equal(listCalls.length, 3);

    relay.failNext("getMessages", "reset");
    await assert.rejects(agent.getMessages(), { code: "network_error" });
    assert.equal((await agent.getMessages()).has_more, false);

    relay.setDelay("health", 30);
    const t0 = Date.now();
    await agent.health();
    assert.ok(Date.now() - t0 >= 25);
    relay.setDelay("health", 0);
    assert.throws(() => relay.failNext("nope", 500));
  });

  it("enforces route, method, content type and auth", async () => {
    const notFound = await fetch(`${relay.url}/v1/nope`);
    assert.equal(notFound.status, 404);
    const wrongMethod = await fetch(`${relay.url}/v1/acks`, { method: "GET" });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get("allow"), "POST");
    const badType = await fetch(`${relay.url}/v1/acks`, {
      method: "POST",
      headers: { "Content-Type": "text/plain", Authorization: `Bearer ${reg.token}` },
      body: '{"up_to_seq":0}',
    });
    assert.equal(badType.status, 415);
    await assert.rejects(fastClient(relay.url, `sk_${reg.hub_id}_${"x".repeat(40)}`).listMembers(), { status: 401, code: "invalid_token" });
    await assert.rejects(agent.getMessages({ limit: 0 }), { status: 400, code: "invalid_request" });
  });

  it("emits message_expired to the sender", async () => {
    const envelope = await sealEnvelope({
      hubId: reg.hub_id,
      from: "m_agent_1",
      recipients: [{ memberId: "m_dev_1", publicKey: phoneKeys.publicKey }],
      senderPrivateKey: agentKeys.privateKey,
      plaintext: "{}",
    });
    const { seq } = await agent.postMessage(serializeEnvelope(envelope));
    assert.equal(relay.expireMessage(envelope.msg_id), true);
    assert.equal(relay.expireMessage(envelope.msg_id), false);
    const page = await agent.getMessages();
    const expired = page.messages.find((m) => m.event === "message_expired");
    assert.deepEqual(expired.body, { msg_id: envelope.msg_id, seq, undelivered_to: ["m_dev_1"] });
    await agent.ack(page.next_after);
  });

  it("revokes a device with member_revoked and 401 afterwards, then wipes on the last revoke", async () => {
    const queued = {};
    for (const kind of ["data", "control"]) {
      const envelope = await sealEnvelope({
        hubId: reg.hub_id,
        from: "m_dev_1",
        recipients: [{ memberId: "m_agent_1", publicKey: agentKeys.publicKey }],
        senderPrivateKey: phoneKeys.privateKey,
        kind,
        plaintext: "{}",
      });
      queued[kind] = { envelope, ...await phone.postMessage(serializeEnvelope(envelope)) };
    }
    await assert.rejects(phone.revokeMember("m_agent_1"), { status: 403, code: "forbidden" });
    await agent.revokeMember("m_dev_1");
    await assert.rejects(agent.revokeMember("m_dev_1"), { status: 404, code: "not_found" });
    await assert.rejects(phone.listMembers(), { status: 401, code: "invalid_token" });
    const page = await agent.getMessages();
    assert.deepEqual(page.messages.map((m) => m.kind), ["control", "system"]);
    assert.equal(page.messages[0].msg_id, queued.control.envelope.msg_id);
    const hub = relay.state.hub();
    assert.equal(hub.messages.has(queued.data.seq), false);
    assert.equal(hub.msgIds.has(queued.data.envelope.msg_id), false);
    assert.equal(hub.messages.has(queued.control.seq), true);
    assert.equal(hub.msgIds.has(queued.control.envelope.msg_id), true);
    assert.deepEqual(relay.state.pendingSeqs("m_agent_1"), page.messages.map((m) => m.seq));
    const revoked = page.messages.find((m) => m.event === "member_revoked");
    assert.deepEqual(revoked.body, { member_id: "m_dev_1", revoked_by: "m_agent_1", self: false });
    await agent.deleteSelf();
    assert.equal(relay.state.hubs.size, 0);
    await assert.rejects(agent.listMembers(), { status: 401 });
  });
});
