import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { ensureHome } from "../../src/config.js";
import { tempHome } from "../support/helpers.js";
import { pollClock } from "../support/poll-clock.js";

import { createLogger } from "../../src/log.js";
import { createRelayClient, JSON_CONTENT_TYPE, MAX_PAGE_RESPONSE_BYTES, MAX_RESPONSE_BYTES, RelayError, RETRY_POLICY } from "../../src/relay-client.js";

const BASE = "http://relay.test";
const TOKEN = `sk_hub_${"A".repeat(22)}_${"B".repeat(40)}`;
const INVITE = "invite-secret-value";

function jsonResponse(status, body, headers = {}) {
  const text = body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body);
  return new Response(status === 204 ? null : text, { status, headers: { "Content-Type": "application/json", ...headers } });
}

function harness(script = [], extra = {}) {
  const requests = [];
  const delays = [];
  const queue = [...script];
  let pollTime = 0;
  const fetch = async (url, init) => {
    requests.push({
      url,
      method: init.method,
      headers: { ...init.headers },
      body: init.body,
    });
    const next = queue.shift() ?? jsonResponse(200, {});
    if (typeof next === "function") return next(url, init);
    if (next instanceof Error) throw next;
    return next;
  };
  const client = createRelayClient({
    baseUrl: `${BASE}/`,
    token: TOKEN,
    fetch,
    sleep: async (ms) => {
      delays.push(ms);
    },
    random: () => 0.5,
    ...extra,
  });
  return { client, requests, delays };
}

const errorBody = (code, details) => ({ error: code, message: `relay says ${code}`, ...(details ? { details } : {}) });

it('heartbeat accepts old 204 and returns optional advisory JSON without logging it', async () => {
  const hint = { skill_update: { skill_version: 2, url: 'https://syncky.app/agent-skill.json', whats_new: 'PRIVATE_HINT' }, protocol_incompatible: { minimum_protocol_version: 2 } };
  const events = [];
  const logger = { debug: (...args) => events.push(args), warn: (...args) => events.push(args) };
  const { client } = harness([jsonResponse(204), jsonResponse(200, hint)], { logger });
  assert.equal(await client.heartbeat({ version: '0.1.0', platform: 'linux' }), undefined);
  assert.deepEqual(await client.heartbeat({ version: '0.1.0', platform: 'linux' }), hint);
  assert.ok(!JSON.stringify(events).includes('PRIVATE_HINT'));
});

describe("relay client request shapes", () => {
  const ENVELOPE = '{"v":1,"msg_id":"x"}';
  const cases = [
    { name: "health", call: (c) => c.health(), method: "GET", path: "/v1/health", auth: false, body: undefined, response: [200, { ok: true }] },
    {
      name: "register",
      call: (c) => c.register({ invite: INVITE, name: "agent", publicKey: "k".repeat(43), webhookUrl: "https://a.example/h" }),
      method: "POST",
      path: "/v1/agents/register",
      auth: false,
      body: { name: "agent", public_key: "k".repeat(43), webhook_url: "https://a.example/h" },
      response: [201, { hub_id: "hub_x" }],
    },
    {
      name: "register without webhook",
      call: (c) => c.register({ invite: INVITE, name: "agent", publicKey: "k".repeat(43) }),
      method: "POST",
      path: "/v1/agents/register",
      auth: false,
      body: { name: "agent", public_key: "k".repeat(43) },
      response: [201, { hub_id: "hub_x" }],
    },
    { name: "createPairing", call: (c) => c.createPairing(), method: "POST", path: "/v1/pairings", auth: true, body: {}, response: [201, { pairing_id: "p" }] },
    { name: "getPairing", call: (c) => c.getPairing("p_abc"), method: "GET", path: "/v1/pairings/p_abc", auth: true, body: undefined, response: [200, { status: "pending" }] },
    { name: "listMembers", call: (c) => c.listMembers(), method: "GET", path: "/v1/members", auth: true, body: undefined, response: [200, { members: [] }] },
    { name: "deleteSelf", call: (c) => c.deleteSelf(), method: "DELETE", path: "/v1/members/me", auth: true, body: undefined, response: [204] },
    { name: "revokeMember", call: (c) => c.revokeMember("m_dev_2"), method: "DELETE", path: "/v1/members/m_dev_2", auth: true, body: undefined, response: [204] },
    {
      name: "postMessage",
      call: (c) => c.postMessage(ENVELOPE),
      method: "POST",
      path: "/v1/messages",
      auth: true,
      rawBody: ENVELOPE,
      response: [201, { seq: 7, msg_id: "x" }],
    },
    { name: "getMessages default", call: (c) => c.getMessages(), method: "GET", path: "/v1/messages?poll_interval_s=1800", auth: true, body: undefined, response: [200, { messages: [] }] },
    {
      name: "getMessages after+limit",
      call: (c) => c.getMessages({ after: 0, limit: 100 }),
      method: "GET",
      path: "/v1/messages?after=0&limit=100&poll_interval_s=1800",
      auth: true,
      body: undefined,
      response: [200, { messages: [] }],
    },
    {
      name: "heartbeat",
      call: (c) => c.heartbeat({ version: "0.1.0", platform: "linux" }),
      method: "POST",
      path: "/v1/agents/heartbeat",
      auth: true,
      body: { version: "0.1.0", platform: "linux" },
      response: [204],
    },
    { name: "ack", call: (c) => c.ack(42), method: "POST", path: "/v1/acks", auth: true, body: { up_to_seq: 42 }, response: [200, { acked: 1, cursor: 42 }] },
  ];

  for (const tc of cases) {
    it(tc.name, async () => {
      const { client, requests } = harness([jsonResponse(...tc.response)]);
      await tc.call(client);
      assert.equal(requests.length, 1);
      const [req] = requests;
      assert.equal(req.method, tc.method);
      assert.equal(req.url, `${BASE}${tc.path}`);
      if (tc.auth) assert.equal(req.headers.Authorization, `Bearer ${TOKEN}`);
      else assert.equal(req.headers.Authorization, undefined);
      if (tc.name.startsWith("register")) assert.equal(req.headers["X-Syncky-Invite"], INVITE);
      else assert.equal(req.headers["X-Syncky-Invite"], undefined);
      const expectedBody = tc.rawBody ?? (tc.body === undefined ? undefined : JSON.stringify(tc.body));
      assert.equal(req.body, expectedBody);
      assert.equal(req.headers["Content-Type"], expectedBody === undefined ? undefined : JSON_CONTENT_TYPE);
      assert.equal(new Headers(req.headers).has("X-Syncky-App-Version"), false);
    });
  }

  it("returns parsed bodies and null for 204", async () => {
    const { client } = harness([jsonResponse(200, { members: [{ member_id: "m_agent_1" }] }), jsonResponse(204)]);
    assert.deepEqual(await client.listMembers(), { members: [{ member_id: "m_agent_1" }] });
    assert.equal(await client.deleteSelf(), undefined);
  });

  it("201 on E10 is not a duplicate, 200 is", async () => {
    const { client } = harness([
      jsonResponse(201, { seq: 3, msg_id: "a" }),
      jsonResponse(200, { seq: 3, msg_id: "a", duplicate: true }),
    ]);
    assert.deepEqual(await client.postMessage("{}"), { seq: 3, msg_id: "a", duplicate: false });
    assert.deepEqual(await client.postMessage("{}"), { seq: 3, msg_id: "a", duplicate: true });
  });

  it("encodes path parameters", async () => {
    const { client, requests } = harness([jsonResponse(404, errorBody("not_found"))]);
    await assert.rejects(client.getPairing("a/b?c"), { code: "not_found" });
    assert.equal(requests[0].url, `${BASE}/v1/pairings/a%2Fb%3Fc`);
  });

  it("rejects bad local input before any request", async () => {
    const { client, requests } = harness();
    assert.throws(() => client.getMessages({ after: -1 }), TypeError);
    assert.throws(() => client.getMessages({ limit: 1.5 }), TypeError);
    assert.throws(() => client.getMessages({ after: "5" }), TypeError);
    assert.throws(() => client.register({ invite: "", name: "a", publicKey: "k" }), TypeError);
    await assert.rejects(client.postMessage({ v: 1 }), TypeError);
    const anonymous = createRelayClient({ baseUrl: BASE, fetch: async () => jsonResponse(200, {}) });
    await assert.rejects(anonymous.listMembers(), /no token/);
    assert.throws(() => createRelayClient({ baseUrl: "relay.syncky.app" }), TypeError);
    assert.equal(requests.length, 0);
  });

});

describe("relay client error mapping", () => {
  const codes = [
    [400, "invalid_request"],
    [400, "invalid_envelope"],
    [401, "invalid_token"],
    [403, "invalid_invite"],
    [403, "forbidden"],
    [404, "not_found"],
    [404, "pairing_not_found"],
    [404, "unknown_recipient"],
    [405, "method_not_allowed"],
    [409, "msg_id_conflict"],
    [409, "hub_full"],
    [410, "pairing_expired"],
    [413, "payload_too_large"],
    [415, "unsupported_media_type"],
    [426, "client_outdated"],
    [429, "rate_limited"],
    [500, "internal_error"],
  ];

  for (const [status, code] of codes) {
    it(`${status} ${code} → RelayError.code`, async () => {
      const details = code === "unknown_recipient" ? { member_ids: ["m_dev_9"] } : code === "invalid_envelope" ? { field: "/v" } : undefined;
      const response = () => jsonResponse(status, errorBody(code, details));
      const { client, requests } = harness(Array.from({ length: 5 }, response));
      const err = await client.listMembers().catch((e) => e);
      assert.ok(err instanceof RelayError);
      assert.equal(err.name, "RelayError");
      assert.equal(err.status, status);
      assert.equal(err.code, code);
      assert.deepEqual(err.details, details);
      assert.match(err.message, new RegExp(code));
      const retryable = status === 429 || status >= 500;
      assert.equal(requests.length, retryable ? RETRY_POLICY.maxAttempts : 1);
    });
  }

  for (const status of [400, 401, 403, 404, 409, 410, 413, 415, 426]) {
    it(`${status} is not retried`, async () => {
      const { client, requests, delays } = harness([jsonResponse(status, errorBody("whatever")), jsonResponse(200, {})]);
      await assert.rejects(client.ack(1), { status });
      assert.equal(requests.length, 1);
      assert.deepEqual(delays, []);
    });
  }

  it("non-JSON error bodies map to relay_error", async () => {
    const { client } = harness([new Response("<html>bad gateway</html>", { status: 418 })]);
    const err = await client.health().catch((e) => e);
    assert.equal(err.code, "relay_error");
    assert.equal(err.status, 418);
    assert.equal(err.details, undefined);
    assert.match(err.message, /HTTP 418/);
  });

  it("escapes control characters in the relay's error message", async () => {
    const { client } = harness([jsonResponse(400, { error: "invalid_request\u001b[2K", message: "bad\r\u001b[8mhidden" })]);
    const err = await client.health().catch((e) => e);
    assert.ok(!/[\u0000-\u001f]/.test(err.message), err.message);
    assert.match(err.message, /bad\\u\{d\}\\u\{1b\}\[8mhidden/);
  });

  it("an error code outside the contract list maps to relay_error and never carries the token", async () => {
    const { client } = harness([jsonResponse(400, { error: TOKEN, message: "nope" })]);
    const err = await client.ack(1).catch((e) => e);
    assert.equal(err.code, "relay_error");
    assert.ok(!err.message.includes(TOKEN), err.message);
  });

  it("JSON without an error string maps to relay_error", async () => {
    const { client } = harness([jsonResponse(400, { oops: true })]);
    assert.equal((await client.health().catch((e) => e)).code, "relay_error");
  });

  it("register without an invite sends no invite header", async () => {
    const { client, requests } = harness([jsonResponse(201, { hub_id: "h", member_id: "m_agent_1", token: "t", webhook_secret: "w" })]);
    await client.register({ name: "a", publicKey: "k" });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].headers["X-Syncky-Invite"], undefined);
  });

  it("the message never contains the token or the invite", async () => {
    const echo = (url, init) =>
      jsonResponse(403, { error: "invalid_invite", message: `bad invite ${init.headers["X-Syncky-Invite"]} token ${TOKEN}` });
    const { client } = harness([echo]);
    const err = await client.register({ invite: INVITE, name: "a", publicKey: "k" }).catch((e) => e);
    assert.equal(err.code, "invalid_invite");
    assert.ok(!err.message.includes(INVITE), err.message);
    assert.ok(!err.message.includes(TOKEN), err.message);
    assert.ok(!err.message.includes("sk_hub_"), err.message);

    const leaky = harness([jsonResponse(401, { error: "invalid_token", message: `token ${TOKEN} unknown` })]);
    const err2 = await leaky.client.listMembers().catch((e) => e);
    assert.ok(!err2.message.includes(TOKEN));
  });
});

describe("client_outdated recovery", () => {
  for (const call of [c => c.health(), c => c.postMessage('{}'), c => c.getMessages(), c => c.ack(7)]) {
    it("refuses once without retrying or blocking another call", async () => {
      const { client, requests, delays } = harness([jsonResponse(426, { error: 'client_outdated' }), jsonResponse(200, { messages: [] })]);
      await assert.rejects(call(client), { code: 'client_outdated', status: 426 });
      assert.equal(requests.length, 1); assert.deepEqual(delays, []);
      await client.getMessages(); assert.equal(requests.length, 2);
    });
  }
});

describe("relay client retry policy", () => {
  it("429 with Retry-After: 3 waits exactly 3 s", async () => {
    const { client, delays, requests } = harness([
      jsonResponse(429, errorBody("rate_limited", { retry_after_s: 3 }), { "Retry-After": "3" }),
      jsonResponse(200, { members: [] }),
    ]);
    assert.deepEqual(await client.listMembers(), { members: [] });
    assert.deepEqual(delays, [3000]);
    assert.equal(requests.length, 2);
  });

  it("falls back to details.retry_after_s without the header", async () => {
    const { client, delays } = harness([jsonResponse(429, errorBody("rate_limited", { retry_after_s: 7 })), jsonResponse(200, {})]);
    await client.listMembers();
    assert.deepEqual(delays, [7000]);
  });

  it("accepts an HTTP-date Retry-After", async () => {
    const nowMs = Date.UTC(2026, 9, 12, 12, 0, 0);
    const date = new Date(nowMs + 5000).toUTCString();
    const { client, delays } = harness([jsonResponse(503, errorBody("internal_error"), { "Retry-After": date }), jsonResponse(200, {})], {
      now: () => nowMs,
    });
    await client.listMembers();
    assert.deepEqual(delays, [5000]);
  });

  it("ignores a garbage Retry-After and uses backoff", async () => {
    const { client, delays } = harness([jsonResponse(503, errorBody("internal_error"), { "Retry-After": "soon-ish" }), jsonResponse(200, {})]);
    await client.listMembers();
    assert.deepEqual(delays, [500]);
  });

  it("a Retry-After beyond the cap fails immediately with retryAfterS", async () => {
    const { client, delays, requests } = harness([jsonResponse(429, errorBody("rate_limited", { retry_after_s: 3600 }), { "Retry-After": "3600" })]);
    const err = await client.register({ invite: INVITE, name: "a", publicKey: "k" }).catch((e) => e);
    assert.equal(err.code, "rate_limited");
    assert.equal(err.retryAfterS, 3600);
    assert.deepEqual(delays, []);
    assert.equal(requests.length, 1);
  });

  it("500 ×4 then 201 succeeds after 4 jittered waits within the cap", async () => {
    const randoms = [0.1, 0.9, 0.5, 0.999];
    const failing = () => jsonResponse(500, errorBody("internal_error"));
    const { client, delays, requests } = harness(
      [failing(), failing(), failing(), failing(), jsonResponse(201, { seq: 1, msg_id: "m" })],
      { random: () => randoms.shift() },
    );
    assert.deepEqual(await client.postMessage("{}"), { seq: 1, msg_id: "m", duplicate: false });
    assert.equal(requests.length, 5);
    assert.equal(delays.length, 4);
    assert.deepEqual(delays, [100, 1800, 2000, 7992]);
    delays.forEach((d, i) => {
      assert.ok(d >= 0 && d <= Math.min(RETRY_POLICY.capMs, RETRY_POLICY.baseMs * 2 ** i));
    });
  });

  it("the jitter ceiling is capped at 60 s", async () => {
    const failing = () => jsonResponse(502, "bad gateway");
    const { client, delays } = harness(Array.from({ length: 10 }, failing), {
      random: () => 0.999999,
      retry: { ...RETRY_POLICY, maxAttempts: 10 },
    });
    await client.health().catch(() => {});
    assert.equal(delays.length, 9);
    assert.ok(delays.every((d) => d < RETRY_POLICY.capMs));
    assert.ok(delays.at(-1) >= 59_000);
  });

  it("5 failures surface the last error", async () => {
    const statuses = [500, 503, 429, 502, 504];
    const { client, requests, delays } = harness(statuses.map((s) => jsonResponse(s, s === 429 ? errorBody("rate_limited") : "x")));
    const err = await client.listMembers().catch((e) => e);
    assert.equal(requests.length, 5);
    assert.equal(delays.length, 4);
    assert.equal(err.status, 504);
    assert.equal(err.code, "relay_error");
  });

  it("retries network errors", async () => {
    const { client, requests, delays } = harness([new TypeError("fetch failed"), jsonResponse(200, { ok: true })]);
    assert.deepEqual(await client.health(), { ok: true });
    assert.equal(requests.length, 2);
    assert.equal(delays.length, 1);
  });

  it("network errors after all attempts become network_error with status 0", async () => {
    const { client } = harness(Array.from({ length: 5 }, () => new TypeError(`connect ECONNREFUSED ${TOKEN}`)));
    const err = await client.listMembers().catch((e) => e);
    assert.equal(err.code, "network_error");
    assert.equal(err.status, 0);
    assert.ok(!err.message.includes(TOKEN));
  });

  it("a timeout aborts the attempt and retries", async () => {
    const hang = (url, init) =>
      new Promise((_, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason));
      });
    const { client, requests, delays } = harness([hang, jsonResponse(200, { members: [] })], { timeoutMs: 20 });
    assert.deepEqual(await client.listMembers(), { members: [] });
    assert.equal(requests.length, 2);
    assert.equal(delays.length, 1);
  });

  it("persistent timeouts end as code timeout", async () => {
    const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
    const { client } = harness(Array.from({ length: 5 }, () => hang), { timeoutMs: 5 });
    const err = await client.ack(1).catch((e) => e);
    assert.equal(err.code, "timeout");
    assert.equal(err.status, 0);
  });

  it("E10 retries resend the byte-identical body", async () => {
    const body = '{"v":1,"msg_id":"0192f000-0000-7000-8000-000000000000","kind":"data","nonce":"é"}';
    const { client, requests } = harness([
      jsonResponse(503, errorBody("internal_error")),
      new TypeError("socket hang up"),
      jsonResponse(200, { seq: 9, msg_id: "0192f000-0000-7000-8000-000000000000", duplicate: true }),
    ]);
    const result = await client.postMessage(body);
    assert.equal(result.duplicate, true);
    assert.equal(result.seq, 9);
    assert.equal(requests.length, 3);
    for (const req of requests) assert.equal(req.body, body);
  });

  it("an E10 beforeRetry hook runs after each backoff and its throw ends the retries", async () => {
    const { client, requests } = harness([jsonResponse(503, errorBody("internal_error")), jsonResponse(503, errorBody("internal_error"))]);
    let checks = 0;
    const stop = new Error("stop");
    const err = await client
      .postMessage("{}", {
        beforeRetry: () => {
          checks += 1;
          if (checks === 2) throw stop;
        },
      })
      .catch((e) => e);
    assert.equal(err, stop);
    assert.equal(checks, 2);
    assert.equal(requests.length, 2);
  });

  it("an E10 404 unknown_recipient is final", async () => {
    const { client, requests } = harness([jsonResponse(404, errorBody("unknown_recipient", { member_ids: ["m_dev_1"] }))]);
    const err = await client.postMessage("{}").catch((e) => e);
    assert.equal(err.code, "unknown_recipient");
    assert.deepEqual(err.details.member_ids, ["m_dev_1"]);
    assert.equal(requests.length, 1);
  });

  it("logs retries and failures without the token", async () => {
    const lines = [];
    const logger = createLogger({ level: "debug", sink: (l) => lines.push(l) });
    const { client } = harness([jsonResponse(500, errorBody("internal_error")), jsonResponse(401, errorBody("invalid_token"))], { logger });
    await assert.rejects(client.listMembers(), { code: "invalid_token" });
    const out = lines.join("\n");
    assert.match(out, /relay_retry/);
    assert.match(out, /relay_request_failed/);
    assert.ok(!out.includes(TOKEN));
  });

  it("heartbeat makes one attempt and logs its failure at debug, while other calls keep warn", async () => {
    const lines = [];
    const logger = createLogger({ level: "debug", sink: (l) => lines.push(JSON.parse(l)) });
    const { client, requests } = harness([jsonResponse(503, errorBody("internal_error")), jsonResponse(204)], { logger });
    await assert.rejects(client.heartbeat({ version: "0.1.0", platform: "linux" }), { status: 503 });
    assert.equal(requests.length, 1);
    assert.deepEqual(
      lines.filter((l) => l.event === "relay_request_failed").map((l) => l.level),
      ["debug"],
    );
    assert.ok(!lines.some((l) => l.level === "warn" || l.level === "error"));
    const { client: other } = harness([jsonResponse(401, errorBody("invalid_token"))], { logger });
    await assert.rejects(other.listMembers(), { code: "invalid_token" });
    assert.equal(lines.filter((l) => l.event === "relay_request_failed").at(-1).level, "warn");
  });

  it("the default sleep really waits", async () => {
    const client = createRelayClient({
      baseUrl: BASE,
      token: TOKEN,
      random: () => 0,
      fetch: (() => {
        let n = 0;
        return async () => (n++ === 0 ? jsonResponse(503, "x") : jsonResponse(200, {}));
      })(),
    });
    assert.deepEqual(await client.listMembers(), {});
  });

  it("aborting E3 retry backoff clears the real default sleep timer", async (t) => {
    const timers = new Set();
    const nativeSet = globalThis.setTimeout;
    const nativeClear = globalThis.clearTimeout;
    t.mock.method(globalThis, "setTimeout", (...args) => {
      const timer = nativeSet(...args);
      timers.add(timer);
      return timer;
    });
    t.mock.method(globalThis, "clearTimeout", (timer) => { timers.delete(timer); nativeClear(timer); });
    t.after(() => { for (const timer of timers) nativeClear(timer); });
    const controller = new AbortController();
    const { client, requests } = harness([
      jsonResponse(503, errorBody("internal_error"), { "Retry-After": "60" }),
    ], { sleep: undefined });
    const stopped = assert.rejects(client.getPairing("pairing-test", { signal: controller.signal }), { name: "AbortError" });
    await pollClock().settle();
    assert.equal(timers.size, 1);
    assert.ok([...timers][0].hasRef());
    controller.abort();
    await stopped;
    assert.equal(timers.size, 0);
    assert.equal(requests.length, 1);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  });

  it("the default sleep removes its abort listener when retry backoff fires", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const controller = new AbortController();
    const { client, requests } = harness([
      jsonResponse(503, errorBody("internal_error"), { "Retry-After": "60" }),
      jsonResponse(200, {}),
    ], { sleep: undefined });
    const pending = client.getPairing("pairing-test", { signal: controller.signal });
    await pollClock().settle();
    assert.equal(getEventListeners(controller.signal, "abort").length, 1);
    t.mock.timers.tick(60_000);
    assert.deepEqual(await pending, {});
    assert.equal(requests.length, 2);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  });

  it("E5 refuses an expired deadline without fetching", async () => {
    const { client, requests } = harness([], { now: () => 1000 });
    await assert.rejects(client.listMembers({ retry: false, deadline: 1000 }), { code: "timeout" });
    assert.equal(requests.length, 0);
  });

  it("E5 bounds a stalled request by its caller deadline", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let reached, requestSignal;
    const started = new Promise(resolve => { reached = resolve; });
    const { client, requests } = harness([(_, init) => new Promise((resolve, reject) => {
      requestSignal = init.signal;
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }); reached();
    })], { now: () => 1000, timeoutMs: 60000 });
    const pending = assert.rejects(client.listMembers({ retry: false, deadline: 1500 }), { code: "timeout" });
    await started; t.mock.timers.tick(499); assert.equal(requestSignal.aborted, false);
    t.mock.timers.tick(1); assert.equal(requestSignal.aborted, true);
    await pending; assert.equal(requests.length, 1);
  });
});

describe("relay client body cap", () => {
  const padded = (json, size) => json + " ".repeat(size - Buffer.byteLength(json));
  const STATE = JSON.stringify({ state: "active", reason: null, expires_at: null, deleting_at: null });
  const PAGE = JSON.stringify({ messages: [], next_after: 0, has_more: false });

  function streamed(chunks, status = 200) {
    let i = 0;
    return new Response(
      new ReadableStream({
        pull(controller) {
          if (i < chunks.length) controller.enqueue(chunks[i++]);
          else controller.close();
        },
      }),
      { status, headers: { "Content-Type": "application/json" } },
    );
  }

  function endless(status) {
    const state = { cancelled: false, pulled: 0 };
    const response = new Response(
      new ReadableStream({
        pull(controller) {
          state.pulled++;
          controller.enqueue(new Uint8Array(64 * 1024).fill(0x20));
        },
        cancel() {
          state.cancelled = true;
        },
      }),
      { status, headers: { "Content-Type": "application/json" } },
    );
    return { response, state };
  }

  it("reads a body at the cap", async () => {
    const { client } = harness([new Response(padded(STATE, MAX_RESPONSE_BYTES), { status: 200 })]);
    assert.equal((await client.getHubState()).state, "active");
  });

  it("refuses a body over the cap after one request", async () => {
    const { client, requests, delays } = harness([new Response(padded(STATE, MAX_RESPONSE_BYTES + 1), { status: 200 })]);
    await assert.rejects(client.getHubState(), (err) => err instanceof RelayError && err.code === "invalid_response" && err.status === 200);
    assert.equal(requests.length, 1);
    assert.deepEqual(delays, []);
  });

  it("does not retry an oversized error body", async () => {
    const big = padded(JSON.stringify(errorBody("internal_error")), MAX_RESPONSE_BYTES + 1);
    const { client, requests, delays } = harness([new Response(big, { status: 503 }), jsonResponse(200, { state: "active" })]);
    await assert.rejects(client.getHubState(), (err) => err.code === "invalid_response" && err.status === 503);
    assert.equal(requests.length, 1);
    assert.deepEqual(delays, []);
  });

  it("gives a message page the page cap", async () => {
    const body = padded(PAGE, MAX_RESPONSE_BYTES * 2);
    const { client } = harness([new Response(body, { status: 200 }), new Response(padded(PAGE, MAX_PAGE_RESPONSE_BYTES + 1), { status: 200 })]);
    assert.equal((await client.getMessages()).next_after, 0);
    await assert.rejects(client.getMessages(), (err) => err.code === "invalid_response");
    const other = harness([new Response(padded(STATE, MAX_RESPONSE_BYTES * 2), { status: 200 })]);
    await assert.rejects(other.client.getHubState(), (err) => err.code === "invalid_response");
  });

  for (const status of [200, 503]) {
    it(`stops reading a ${status} body that never ends`, async () => {
      const { response, state } = endless(status);
      const { client, requests } = harness([response]);
      await assert.rejects(client.getMessages(), (err) => err.code === "invalid_response");
      assert.equal(requests.length, 1);
      assert.equal(state.cancelled, true);
      assert.ok(state.pulled * 64 * 1024 <= MAX_PAGE_RESPONSE_BYTES + 3 * 64 * 1024);
    });
  }

  it("decodes a character split across chunks", async () => {
    const bytes = Buffer.from(JSON.stringify({ state: "€" }));
    const cut = bytes.indexOf(0xe2) + 1;
    const { client } = harness([streamed([bytes.subarray(0, cut), bytes.subarray(cut)])]);
    assert.equal((await client.getHubState()).state, "€");
  });
});

describe("relay client insecure URL warning", () => {
  const warnings = (baseUrl) => {
    const records = [];
    const logger = { debug() {}, info() {}, warn: (event, fields) => records.push({ event, fields }), error() {} };
    createRelayClient({ baseUrl, token: TOKEN, fetch: async () => jsonResponse(200, {}), logger });
    return records;
  };

  it("warns once per process and host for an http relay that is not loopback, naming only the host", () => {
    assert.deepEqual(warnings("http://plain-a.test/some/path?q=1"), [{ event: "relay_url_insecure", fields: { host: "plain-a.test" } }]);
    assert.deepEqual(warnings("http://plain-a.test/"), []);
    assert.deepEqual(warnings("http://plain-b.test:8080"), [{ event: "relay_url_insecure", fields: { host: "plain-b.test" } }]);
  });

  it("stays quiet for https and for a loopback http relay", () => {
    for (const url of ["https://secure-a.test", "http://127.0.0.1:8787", "http://[::1]:8787", "http://localhost:8787", "http://LOCALHOST:8787/"]) {
      assert.deepEqual(warnings(url), [], url);
    }
  });

  it("does not throw for a URL that passes the scheme check but does not parse", () => {
    assert.doesNotThrow(() => warnings("http://[bad"));
  });
});
