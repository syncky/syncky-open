import { b64u, generateKeys, openEnvelope, pairProof, randomBytes, sealEnvelope } from "../../src/protocol.mjs";

export const RELAY = "https://relay.example";
const HUB = "hub_AAAAAAAAAAAAAAAAAAAAAA";
const TOKEN = `sk_${HUB}_${"a".repeat(43)}`;
const PHONE_TOKEN = `sk_${HUB}_${"p".repeat(43)}`;
const json = (status, body, headers = {}) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

// An in-memory relay with one scripted phone that joins on the first pairing check and proves the code it reads from the link.
export async function stubRelay({ wrongProof = false, autoProof = true, demoEndsAt = new Date(Date.now() + 3_600_000).toISOString(), demoRemainingS = 3600, hubState = { state: "active", reason: "launch", expires_at: null, deleting_at: null }, failOn = {} } = {}) {
  const phoneKeys = await generateKeys();
  const r = { calls: [], queue: [], seq: 0, acked: 0, agentPk: null, pairing: null, joined: false, agentGone: false, phoneMessages: [], phoneKeys, failNext: [], failOn, hubState };
  const push = (msg) => r.queue.push({ ...msg, seq: ++r.seq });
  const phoneSeal = (plaintext, kind = "data", extra = {}) => sealEnvelope({ hubId: HUB, from: "m_dev_1", sk: phoneKeys.sk, recipients: [{ member_id: "m_agent_1", pk: r.agentPk }], plaintext, kind, ...extra });
  r.phoneSends = async (inner, kind, extra) => push(await phoneSeal(JSON.stringify(inner), kind, extra));
  r.join = async (secret) => {
    r.joined = true;
    push({ v: 1, kind: "system", msg_id: "0192f000-0000-7000-8000-000000000001", from: "relay", created_at: "2026-10-28T00:00:00Z", event: "member_joined", body: { member_id: "m_dev_1", role: "device", device_name: "iPhone", public_key: phoneKeys.pk } });
    if (!autoProof) return;
    const proof = wrongProof ? b64u(randomBytes(32)) : await pairProof(secret, r.agentPk, phoneKeys.pk);
    await r.phoneSends({ v: 1, type: "pair_proof", proof }, "control");
  };
  r.fetch = async (url, init) => {
    const { pathname, search } = new URL(url);
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    r.calls.push({ method: init.method, path: pathname + search, body, headers: init.headers, keepalive: init.keepalive });
    const route = `${init.method} ${pathname}`;
    if (r.failOn[route]?.length > 0) return r.failOn[route].shift()();
    if (r.failNext.length > 0) return r.failNext.shift()();
    if (route !== "POST /v1/agents/register" && init.headers.Authorization !== `Bearer ${TOKEN}`) return json(401, { error: "invalid_token", message: "x" });
    if (r.agentGone) return json(401, { error: "invalid_token", message: "x" });
    switch (route) {
      case "POST /v1/agents/register":
        r.agentPk = body.public_key;
        return json(201, { hub_id: HUB, member_id: "m_agent_1", token: TOKEN, webhook_secret: "whsec_x", demo_ends_at: demoEndsAt, demo_remaining_s: demoRemainingS });
      case "POST /v1/pairings":
        r.pairing = { id: `p_${"B".repeat(22)}`, token: `pt_${"C".repeat(43)}`, checks: 0 };
        return json(201, { pairing_id: r.pairing.id, pairing_token: r.pairing.token, expires_at: "2026-10-28T00:10:00Z", hub_id: HUB });
      case `GET /v1/pairings/${r.pairing?.id}`: {
        if (++r.pairing.checks === 1) return json(200, { pairing_id: r.pairing.id, status: "pending", expires_at: "x" });
        if (!r.joined) {
          const uri = new URL(r.lastUri), params = new URLSearchParams(uri.hash.slice(1) || uri.search.slice(1));
          if (!params.get("c")) throw new Error("pairing URI lacks proof credential");
          await r.join(params.get("c"));
        }
        return json(200, { pairing_id: r.pairing.id, status: "completed", expires_at: "x", member_id: "m_dev_1", device_name: "iPhone", public_key: phoneKeys.pk });
      }
      case "GET /v1/members":
        return json(200, { members: [{ member_id: "m_agent_1" }, ...(r.joined ? [{ member_id: "m_dev_1" }] : [])] });
      case "GET /v1/hub/state":
        return json(200, r.hubState);
      case "GET /v1/messages": {
        const after = Number(new URLSearchParams(search).get("after"));
        const messages = r.queue.filter((m) => m.seq > after);
        return json(200, { messages, next_after: messages.at(-1)?.seq ?? after, has_more: false });
      }
      case "POST /v1/acks":
        r.acked = body.up_to_seq;
        r.queue = r.queue.filter((m) => m.seq > body.up_to_seq);
        return json(200, { acked: 1, cursor: body.up_to_seq });
      case "POST /v1/messages": {
        const inner = JSON.parse(await openEnvelope(body, { hubId: HUB, memberId: "m_dev_1", sk: phoneKeys.sk, registry: { m_agent_1: r.agentPk }, kind: body.kind }));
        r.phoneMessages.push({ kind: body.kind, inner });
        return json(201, { seq: ++r.seq, msg_id: body.msg_id });
      }
      case "DELETE /v1/members/me":
        r.agentGone = true;
        return new Response(null, { status: 204 });
      case "DELETE /v1/members/m_dev_1":
        r.joined = false;
        return new Response(null, { status: 204 });
      default:
        return json(404, { error: "not_found", message: "x" });
    }
  };
  return r;
}

export async function until(check, what, timeoutMs = 10_000) {
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; ) {
    if (check()) return;
    await new Promise((done) => setImmediate(done));
  }
  throw new Error(`timed out waiting for ${what}`);
}
