import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { pairCode } from "../src/protocol.mjs";
import { DemoSession, HUB_STATE_MS, MAX_SAMPLES, POLL_MS, PROOF_WAIT_MS } from "../src/session.mjs";
import { RELAY, stubRelay, until } from "./support/stub-relay.mjs";

const json = (status, body, headers = {}) => () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

const live = new Set();
afterEach(() => {
  for (const session of live) session.finish();
  live.clear();
});

async function started(options = {}, sessionOptions = {}) {
  const relay = await stubRelay(options);
  const sleeps = [];
  const session = new DemoSession({
    relay: RELAY,
    scheme: "syncky-dev",
    fetch: relay.fetch,
    sleep: (ms) => {
      sleeps.push(ms);
      return new Promise((done) => setImmediate(done));
    },
    onChange: (s) => {
      if (s.pairing?.uri) relay.lastUri = s.pairing.uri;
    },
    ...sessionOptions,
  });
  live.add(session);
  const running = session.start();
  return { relay, session, sleeps, running };
}

async function confirmed(options, sessionOptions) {
  const ctx = await started(options, sessionOptions);
  await until(() => ctx.session.state.phase === "confirmed", "confirmation");
  return ctx;
}

const sync = (extra) => ({ v: 1, type: "sync", device: "m_dev_1", samples: [], deleted: [], acks: [], more: false, ...extra });

describe('access control tolerance', () => {
  for (const access of ['request', 'reply']) it(`authenticates/skips ${access} and continues cursor/ACK/sync without content output`, async () => {
    const { relay, session } = await confirmed();
    await relay.phoneSends({ v: 1, type: `access_${access}`, reason: 'PRIVATE', read: ['PRIVATE'] }, 'control', { access });
    const seq = relay.seq;
    await until(() => relay.acked >= seq, 'access ACK');
    assert.equal(JSON.stringify(session.state).includes('PRIVATE'), false);
    await relay.phoneSends(sync({ samples: [{ uuid: 'after-access', type: 'steps', value: 1 }] }));
    await until(() => relay.acked >= seq + 1, 'later sync');
    assert.ok(session.state.samples.some(s => s.uuid === 'after-access'));
    await session.end();
  });
});

describe("DemoSession countdown", () => {
  for (const skew of [-86_400_000, 86_400_000]) {
    it(`ticks every second from the relay's expiry with client skew ${skew}`, async t => {
      t.mock.timers.enable({ apis: ["setInterval"] });
      const serverAt = Date.parse("2026-10-29T12:00:00Z");
      const expiresAt = serverAt + 3_552_000;
      let at = serverAt + skew;
      const { session } = await confirmed({ demoEndsAt: new Date(expiresAt).toISOString(), demoRemainingS: (expiresAt - serverAt) / 1000 }, { now: () => at });
      assert.equal(session.state.countdown, "Demo ends in 59:12");
      at += 1000;
      t.mock.timers.tick(1000);
      assert.equal(session.state.countdown, "Demo ends in 59:11");
      at += 71_000;
      t.mock.timers.tick(1000);
      assert.equal(session.state.countdown, "Demo ends in 58:00");
      await session.end();
    });
  }

  it("at 0:00 stops polling and clears secrets and samples into the End demo state, even offline", async t => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    let at = 0;
    const manual = await confirmed();
    await manual.session.end();
    const { relay, session, running } = await confirmed({ demoRemainingS: 1 }, { now: () => at });
    session.state.samples.push({ uuid: "sample" });
    session.state.commands.push({ id: "command" });
    relay.failOn["GET /v1/messages"] = [() => { throw new TypeError("offline"); }];
    await until(() => session.state.error !== null, "offline poll");
    at = 1000;
    t.mock.timers.tick(1000);
    assert.equal(session.state.countdown, "Demo ends in 00:00");
    assert.equal(session.state.phase, manual.session.state.phase);
    assert.equal(session.state.notice, manual.session.state.notice);
    assert.deepEqual(session.state.samples, []);
    assert.deepEqual(session.state.commands, []);
    assert.equal(session.state.phone, null);
    assert.equal(session.state.pairing, null);
    assert.equal(session.state.error, null);
    assert.equal(session.keys, null);
    assert.equal(session.token, null);
    await running;
    const calls = relay.calls.length;
    at += 60_000;
    t.mock.timers.tick(60_000);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(relay.calls.length, calls);
    assert.ok(!relay.calls.some(c => c.method === "DELETE"));
  });

  it("ignores an in-flight pairing response after 0:00", async t => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    let at = 0;
    let respond;
    const { session, running } = await started({ demoRemainingS: 1, failOn: {
      "GET /v1/pairings/p_BBBBBBBBBBBBBBBBBBBBBB": [() => new Promise(resolve => { respond = resolve; })],
    } }, { now: () => at });
    await until(() => respond !== undefined, "pending pairing");
    at = 1000;
    t.mock.timers.tick(1000);
    respond(json(200, { status: "completed", member_id: "m_dev_1" })());
    await running;
    assert.equal(session.state.phase, "ended");
    assert.equal(session.state.phone, null);
    assert.equal(session.keys, null);
  });

  it("still ends at 0:00 after a terminal polling error", async t => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    let at = 0;
    const { relay, session, running } = await confirmed({ demoRemainingS: 1 }, { now: () => at });
    relay.failOn["GET /v1/messages"] = [json(400, { error: "invalid_request" })];
    await until(() => session.state.phase === "error", "poll error");
    await running;
    assert.deepEqual(relay.calls.find(c => c.method === "DELETE" && c.path === "/v1/members/me")?.body, { purge: true });
    assert.equal(relay.agentGone, true);
    assert.ok(session.keys === null && session.token === null);
    at = 1000;
    t.mock.timers.tick(1000);
    assert.equal(session.state.phase, "ended");
    assert.equal(session.state.countdown, "Demo ends in 00:00");
    assert.equal(session.state.error, null);
    assert.equal(session.keys, null);
    assert.equal(session.token, null);
  });

  it("expires credentials after End during registration followed by a failed leave", async t => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    let at = 0;
    let respond;
    const relay = await stubRelay({ demoRemainingS: 1, failOn: {
      "DELETE /v1/members/me": [json(503, { error: "unavailable" })],
    } });
    const session = new DemoSession({ relay: RELAY, now: () => at, fetch: async (url, init) => {
      const response = await relay.fetch(url, init);
      return new URL(url).pathname === "/v1/agents/register" ? new Promise(resolve => { respond = () => resolve(response); }) : response;
    } });
    live.add(session);
    const running = session.start();
    await until(() => respond !== undefined, "pending registration");
    const ending = session.end();
    respond();
    await Promise.all([running, ending]);
    assert.equal(session.state.phase, "leave_failed");
    assert.ok(session.keys && session.token);
    assert.equal(relay.agentGone, false);
    assert.equal(session.state.countdown, "Demo ends in 00:01");
    assert.deepEqual(relay.calls.map(c => `${c.method} ${c.path}`), ["POST /v1/agents/register", "DELETE /v1/members/me"]);
    const calls = relay.calls.length;
    at = 1000;
    t.mock.timers.tick(1000);
    assert.equal(session.state.phase, "ended");
    assert.equal(session.state.countdown, "Demo ends in 00:00");
    assert.equal(session.state.error, null);
    assert.equal(session.keys, null);
    assert.equal(session.token, null);
    at += 60_000;
    t.mock.timers.tick(60_000);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(relay.calls.length, calls);
  });
});

describe("DemoSession hub state", () => {
  const reads = (relay) => relay.calls.filter((c) => c.path === "/v1/hub/state");

  it("reads E14 after registration and shows its state, reason, deadlines and complete notice in one line", async () => {
    const notice = `Maintenance: ${"x".repeat(480)}`;
    const { relay, session } = await started({ hubState: { state: "suspended", reason: "launch_ended", expires_at: "2026-11-01T00:00:00Z", deleting_at: "2026-12-01T00:00:00Z", notice, future_key: "ignored" } });
    await until(() => session.state.phase === "pairing", "pairing");
    assert.equal(relay.calls[1].method, "GET");
    assert.equal(relay.calls[1].path, "/v1/hub/state");
    assert.equal(relay.calls[1].headers.Authorization, relay.calls[2].headers.Authorization);
    assert.equal(session.state.hubState, `state: suspended · reason: launch_ended · expires_at: 2026-11-01T00:00:00Z · deleting_at: 2026-12-01T00:00:00Z · notice: ${notice}`);
    assert.equal(session.state.notice, null);
    await until(() => session.state.phase === "confirmed", "confirmation");
    await session.end();
  });

  it("refreshes once a minute while connected, independently of the 5 s message poll, and stops on End demo", async () => {
    let at = 0;
    const { relay, session, sleeps, running } = await confirmed({}, { now: () => at });
    assert.equal(reads(relay).length, 1);
    assert.equal(session.state.hubState, "state: active · reason: launch");
    relay.hubState = { state: "active", notice: "Updated notice" };
    for (at = POLL_MS; at < HUB_STATE_MS; at += POLL_MS) {
      const count = sleeps.length;
      await until(() => sleeps.length > count, "message poll");
      assert.equal(reads(relay).length, 1);
    }
    await until(() => session.state.hubState === "state: active · notice: Updated notice", "hub refresh");
    assert.equal(reads(relay).length, 2);
    await session.end();
    await running;
    at += HUB_STATE_MS;
    await session.checkHubState();
    assert.equal(reads(relay).length, 2);
  });

  it("ignores an E14 response arriving after End demo without creating a pairing", async () => {
    let respond;
    const { relay, session, running } = await started({ failOn: { "GET /v1/hub/state": [() => new Promise((resolve) => { respond = resolve; })] } });
    await until(() => respond !== undefined, "hub state request");
    await session.end();
    respond(json(200, { state: "active", reason: "launch" })());
    await running;
    assert.equal(session.state.phase, "ended");
    assert.equal(session.state.hubState, null);
    assert.ok(!relay.calls.some((c) => c.path === "/v1/pairings"));
  });

  for (const [label, hubState, expected] of [
    ["unknown values and keys", { state: "future_state", reason: "future_plan", new_key: "ignored" }, "state: future_state · reason: future_plan"],
    ["absent keys", {}, null],
    ["null response", null, null],
    ["wrong types and unset deadlines", { state: 7, reason: {}, expires_at: null, deleting_at: false, notice: [] }, null],
    ["multiline notice", { notice: "Update\nwith\u2028a\u202enotice" }, "notice: Update with a notice"],
  ]) {
    it(`tolerates ${label}`, async () => {
      const { session } = await confirmed({ hubState });
      assert.equal(session.state.hubState, expected);
      assert.equal(session.state.error, null);
      await session.end();
    });
  }

  for (const [label, failure] of [
    ["401", json(401, { error: "invalid_token" })],
    ["429", json(429, { error: "rate_limited" }, { "Retry-After": "7200" })],
    ["503", json(503, { error: "unavailable" })],
    ["invalid JSON", () => new Response("bad JSON", { status: 200 })],
    ["network error", () => Promise.reject(new TypeError("offline"))],
  ]) {
    it(`keeps pairing, polling and writes working through E14 ${label} at startup and on refresh`, async () => {
      let at = 0;
      const { relay, session, sleeps, running } = await confirmed({ failOn: { "GET /v1/hub/state": [failure] } }, { now: () => at });
      assert.equal(session.state.hubState, label === "429" ? "state: active · reason: launch" : null);
      if (label === "429") assert.ok(sleeps.includes(7_200_000));
      at = HUB_STATE_MS;
      await until(() => session.state.hubState === "state: active · reason: launch", "hub recovery");
      relay.failOn["GET /v1/hub/state"].push(failure);
      const count = sleeps.length;
      at += HUB_STATE_MS;
      await until(() => reads(relay).length === 3 && sleeps.length > count, "failed refresh");
      assert.equal(session.state.phase, "confirmed");
      if (label === "429") await until(() => session.state.error === null, "rate-limit recovery");
      assert.equal(session.state.error, null);
      assert.equal(session.state.hubState, "state: active · reason: launch");
      await session.write("water");
      await relay.phoneSends(sync({ acks: [{ command_id: "c_1", version: 1, status: "applied" }] }));
      await until(() => session.state.commands[0].state === "applied", "write acknowledgement");
      relay.hubState = { state: "active", reason: null, expires_at: null, deleting_at: null };
      at += HUB_STATE_MS;
      await until(() => session.state.hubState === "state: active", "later hub recovery");
      await session.end();
      await running;
    });
  }

  for (const startup of [true, false]) {
    for (const [label, header, details, ms] of [
      ["seconds", "7200", undefined, 7_200_000],
      ["HTTP-date", new Date(7_250_000).toUTCString(), undefined, 7_250_000],
      ["details", undefined, { retry_after_s: 7300 }, 7_300_000],
      ["fallback", "bad", undefined, POLL_MS],
    ]) {
      it(`honours E14 429 ${label} at ${startup ? "startup" : "refresh"} before any more pairing or message polls`, async () => {
        let at = 0;
        const waits = [];
        const retryAfter = label === "HTTP-date" ? new Date((startup ? 0 : HUB_STATE_MS) + ms).toUTCString() : header;
        const failure = json(429, { error: "rate_limited", details }, retryAfter === undefined ? {} : { "Retry-After": retryAfter });
        const { relay, session, running } = await started({ failOn: { "GET /v1/hub/state": startup ? [failure] : [] } }, {
          now: () => at,
          sleep: ms => new Promise(resolve => waits.push({ ms, resolve })),
        });
        let index = 0;
        if (!startup) {
          while (session.state.phase !== "confirmed") {
            await until(() => waits.length > index, "pairing wait");
            waits[index++].resolve();
          }
          await until(() => waits.length > index, "confirmed wait");
          at = HUB_STATE_MS;
          relay.failOn["GET /v1/hub/state"].push(failure);
          waits[index++].resolve();
        }
        await until(() => waits.length > index, "E14 retry wait");
        assert.equal(waits[index].ms, ms);
        assert.match(session.state.error ?? "", /asked to wait/);
        if (startup) assert.ok(!relay.calls.some(c => c.path.startsWith("/v1/pairings") || c.path.startsWith("/v1/messages")));
        const count = relay.calls.length;
        at += ms - 1;
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(relay.calls.length, count);
        if (startup) {
          at++;
          waits[index++].resolve();
          await until(() => waits.length > index, "resumed pairing");
          assert.equal(relay.calls.filter(c => c.path === "/v1/hub/state").length, 2);
          assert.equal(session.state.phase, "pairing");
        }
        await session.end();
        const endedCalls = relay.calls.length;
        waits[index].resolve();
        await running;
        assert.equal(relay.calls.length, endedCalls);
      });
    }
  }
});

describe("DemoSession pairing", () => {
  it("registers a demo hub, shows a v2 link with the build's scheme and its code, confirms the phone by its proof", async () => {
    const { relay, session } = await started();
    await until(() => session.state.phase === "pairing", "pairing");
    const register = relay.calls[0];
    assert.equal(register.path, "/v1/agents/register");
    assert.equal(register.body.demo, true);
    assert.equal(register.body.name, "Syncky browser demo");
    const { uri, code } = session.state.pairing;
    assert.match(uri, /^syncky-dev:\/\/pair\?v=2&r=relay\.example&h=hub_A{22}&t=pt_C{43}&k=[\w-]{43}&n=Syncky%20browser%20demo&c=[\w-]{22}$/);
    assert.equal(code, await pairCode(new URL(uri).searchParams.get("c")));
    await until(() => session.state.phase === "joined", "phone joined");
    assert.deepEqual(session.state.pairing, { code });
    assert.equal(session.pairing, null);
    await until(() => session.state.phase === "confirmed", "confirmation");
    assert.equal(session.state.pairing, null);
    assert.deepEqual(session.state.phone, { id: "m_dev_1", pk: relay.phoneKeys.pk, name: "iPhone", proof: null });
    assert.deepEqual(relay.phoneMessages, [{ kind: "control", inner: { v: 1, type: "confirmed" } }]);
    assert.ok(relay.acked >= 2, "the member_joined event and the proof are acked");
    await session.end();
  });

  it("revokes a phone whose proof does not match and offers a new code", async () => {
    const { relay, session } = await started({ wrongProof: true });
    await until(() => session.state.phase === "phone_left", "rejection");
    assert.equal(session.state.pairing, null);
    assert.ok(relay.calls.some((c) => c.method === "DELETE" && c.path === "/v1/members/m_dev_1"));
    assert.deepEqual(relay.phoneMessages, []);
    assert.match(session.state.notice, /does not match/);
    await session.pairAgain();
    assert.equal(relay.calls.filter((c) => c.path === "/v1/pairings").length, 2);
    await session.end();
  });

  it("holds data from a joined phone that has not proved the code, without acking it", async () => {
    const relay = await stubRelay();
    const session = new DemoSession({ relay: RELAY, fetch: relay.fetch, sleep: () => new Promise((done) => setImmediate(done)) });
    session.keys = { sk: "x" };
    session.state.phase = "joined";
    const code = await pairCode("A".repeat(22));
    session.state.pairing = { code };
    session.state.phone = { id: "m_dev_1", pk: relay.phoneKeys.pk, proof: "x" };
    assert.equal(await session.handle({ seq: 1, kind: "data", from: "m_dev_1" }), false);
    assert.equal(await session.handle({ seq: 2, kind: "data", from: "m_dev_9" }), true);
    assert.equal(session.state.pairing.code, code);
  });

  it("clears the code when the joined phone leaves before sending its proof", async () => {
    const { relay, session } = await started({ autoProof: false });
    await until(() => session.state.phase === "joined", "phone joined");
    assert.equal(session.state.pairing.code, await pairCode(new URL(relay.lastUri).searchParams.get("c")));
    relay.queue.push({ seq: ++relay.seq, kind: "system", event: "member_revoked", body: { member_id: "m_dev_1" } });
    relay.joined = false;
    await until(() => session.state.phase === "phone_left", "phone left");
    assert.equal(session.state.pairing, null);
    assert.equal(session.state.phone, null);
    assert.deepEqual(relay.phoneMessages, []);
    await session.end();
  });

  for (const phase of ["expired", "phone_left"]) {
    it(`keeps one poller when New pairing code is clicked during the ${phase} sleep`, async () => {
      const waits = [];
      const { relay, session, running } = await started(phase === "expired" ? {
        failOn: { [`GET /v1/pairings/p_${"B".repeat(22)}`]: [json(200, { status: "expired" })] },
      } : {}, { sleep: ms => new Promise(resolve => waits.push({ ms, resolve })) });
      let index = 0;
      if (phase === "phone_left") {
        while (session.state.phase !== "confirmed") {
          await until(() => waits.length > index, "pairing wait");
          waits[index++].resolve();
        }
        await until(() => waits.length > index, "confirmed wait");
        relay.queue.push({ seq: ++relay.seq, kind: "system", event: "member_revoked", body: { member_id: "m_dev_1" } });
        relay.joined = false;
        waits[index++].resolve();
      }
      await until(() => session.state.phase === phase && waits.length > index, "old runner sleep");
      assert.equal(session.state.pairing, null);
      const polls = () => relay.calls.filter(c => c.method === "GET" && (c.path.startsWith("/v1/pairings/") || c.path.startsWith("/v1/messages"))).length;
      const before = polls();
      const again = session.pairAgain();
      await until(() => session.state.phase === "pairing", "new code");
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(polls(), before);
      assert.equal(waits.length, index + 1);
      for (let step = 1; step <= 3; step++) {
        waits[index++].resolve();
        await until(() => waits.length > index, "single poll");
        assert.equal(polls(), before + step);
      }
      assert.equal(session.state.phase, "confirmed");
      await session.write("water");
      await relay.phoneSends(sync({ samples: [{ uuid: "single", type: "mindful_session", value: "not_applicable" }], acks: [{ command_id: "c_1", status: "applied" }] }));
      const acks = relay.calls.filter(c => c.path === "/v1/acks").length;
      waits[index++].resolve();
      await until(() => waits.length > index, "single data poll");
      assert.equal(polls(), before + 4);
      assert.equal(session.state.samples.length, 1);
      assert.equal(session.state.commands[0].state, "applied");
      assert.equal(relay.calls.filter(c => c.path === "/v1/acks").length, acks + 1);
      await session.end();
      waits[index].resolve();
      await Promise.all([running, again]);
    });
  }
});

describe("DemoSession data and writes", () => {
  it("decrypts samples into rows, newest first, without keeping anything else", async () => {
    const { relay, session } = await confirmed();
    await relay.phoneSends(sync({
      samples: [
        { uuid: "u1", type: "step_count", value: 812, unit: "count", start: "2026-10-28T08:00:00Z", end: "2026-10-28T09:00:00Z", source: { app: "x", device: null } },
        { uuid: "u2", type: "sleep_analysis", value: "asleep_core", start: "2026-10-28T01:00:00Z", end: "2026-10-28T02:00:00Z", source: { app: "x", device: null } },
        { uuid: "u3", type: "workout", activity: "running", duration_s: 1800, start: "2026-10-28T07:00:00Z", end: "2026-10-28T07:30:00Z", source: { app: "x", device: null } },
        { uuid: "u4", type: "Bad Type!", start: 5 },
      ],
    }));
    await until(() => session.state.samples.length === 4, "samples");
    assert.deepEqual(session.state.samples, [
      { uuid: "u4", type: "unknown", time: "", value: "" },
      { uuid: "u3", type: "workout", time: "2026-10-28T07:00:00Z", value: "running, 30 min" },
      { uuid: "u2", type: "sleep_analysis", time: "2026-10-28T01:00:00Z", value: "asleep_core" },
      { uuid: "u1", type: "step_count", time: "2026-10-28T08:00:00Z", value: "812 count" },
    ]);
    await session.end();
  });

  it(`keeps at most ${MAX_SAMPLES} rows`, async () => {
    const { relay, session } = await confirmed();
    const samples = Array.from({ length: MAX_SAMPLES + 20 }, (_, i) => ({ uuid: `u${i}`, type: "step_count", value: i, unit: "count", start: "2026-10-28T08:00:00Z" }));
    await relay.phoneSends(sync({ samples }));
    await until(() => session.state.samples.length > 0, "samples");
    assert.equal(session.state.samples.length, MAX_SAMPLES);
    assert.equal(session.state.samples[0].uuid, `u${MAX_SAMPLES + 19}`);
    await session.end();
  });

  it("ignores a sync whose device is not the sender and an envelope it cannot open", async () => {
    const { relay, session } = await confirmed();
    await relay.phoneSends(sync({ device: "m_dev_2", samples: [{ uuid: "x", type: "step_count", value: 1, unit: "count" }] }));
    relay.queue.push({ seq: ++relay.seq, v: 1, kind: "data", from: "m_dev_1", msg_id: "x", recipients: [], nonce: "", ciphertext: "" });
    await until(() => relay.queue.length === 0, "acks");
    assert.deepEqual(session.state.samples, []);
    await session.end();
  });

  it("sends the water and mindful writes to the phone and shows applied and rejected acks", async () => {
    const { relay, session } = await confirmed();
    await session.write("water");
    await session.write("mindful");
    const [water, mindful] = relay.phoneMessages.slice(1).map((m) => m.inner.commands[0]);
    assert.deepEqual({ ...water, start: undefined, end: undefined }, { command_id: "c_1", version: 1, op: "write", type: "dietary_water", value: 0.25, unit: "L", start: undefined, end: undefined });
    assert.equal(water.start, water.end);
    assert.deepEqual({ ...mindful, start: undefined, end: undefined }, { command_id: "c_2", version: 1, op: "write", type: "mindful_session", value: "not_applicable", start: undefined, end: undefined });
    assert.equal(Date.parse(mindful.end) - Date.parse(mindful.start), 600_000);
    assert.deepEqual(session.state.commands.map((c) => c.state), ["sent", "sent"]);
    await relay.phoneSends(sync({ acks: [{ command_id: "c_1", version: 1, status: "applied" }, { command_id: "c_2", version: 1, status: "rejected", reason: "type_not_in_scope" }] }));
    await until(() => session.state.commands[0].state === "applied", "acks");
    assert.deepEqual(session.state.commands.map(({ state, reason }) => ({ state, reason })), [{ state: "applied", reason: undefined }, { state: "rejected", reason: "type_not_in_scope" }]);
    await session.end();
  });

  it("shows a write the relay refused with its wait, and marks an expired one", async () => {
    const { relay, session } = await confirmed();
    relay.failOn["POST /v1/messages"] = [json(429, { error: "rate_limited", message: "x" }, { "Retry-After": "240" })];
    await session.write("water");
    assert.deepEqual(session.state.commands.map(({ state, reason }) => ({ state, reason })), [{ state: "not_sent", reason: "rate_limited, retry in 240 s" }]);
    await session.write("water");
    const msgId = session.state.commands[1].msgId;
    relay.queue.push({ seq: ++relay.seq, v: 1, kind: "system", from: "relay", msg_id: "y", event: "message_expired", body: { msg_id: msgId, seq: 9, undelivered_to: ["m_dev_1"] } });
    await until(() => session.state.commands[1].state === "expired", "expiry");
    await session.write("nothing");
    assert.equal(session.state.commands.length, 2);
    await session.end();
  });

  for (const status of ["applied", "rejected"]) {
    for (const failure of ["network", "503", "invalid JSON"]) {
      it(`accepts a later ${status} ack after an accepted write loses its ${failure} response`, async () => {
        const { relay, session } = await confirmed();
        const fetch = session.fetchFn;
        session.fetchFn = async (url, init) => {
          const response = await fetch(url, init);
          if (init.method !== "POST" || new URL(url).pathname !== "/v1/messages") return response;
          if (failure === "network") throw new TypeError("offline");
          return failure === "503" ? json(503, { error: "unavailable" })() : new Response("bad JSON", { status: 201 });
        };
        await session.write("water");
        assert.equal(relay.phoneMessages.at(-1).inner.type, "commands");
        assert.equal(session.state.commands[0].state, "uncertain");
        await relay.phoneSends(sync({ acks: [{ command_id: "c_1", status, reason: "type_not_in_scope" }] }));
        await until(() => session.state.commands[0].state === status, "late write ack");
        assert.equal(session.state.commands[0].reason, status === "rejected" ? "type_not_in_scope" : undefined);
        await session.end();
      });
    }
  }

  it("keeps an applied ack that arrives before the lost write response fails", async () => {
    const { relay, session } = await confirmed();
    const fetch = session.fetchFn;
    let reject;
    session.fetchFn = async (url, init) => {
      const response = await fetch(url, init);
      if (init.method === "POST" && new URL(url).pathname === "/v1/messages") return new Promise((_, fail) => { reject = fail; });
      return response;
    };
    const writing = session.write("water");
    await until(() => reject !== undefined, "accepted write");
    await relay.phoneSends(sync({ acks: [{ command_id: "c_1", status: "applied" }] }));
    await until(() => session.state.commands[0].state === "applied", "early write ack");
    reject(new TypeError("offline"));
    await writing;
    assert.equal(session.state.commands[0].state, "applied");
    await session.end();
  });
});

describe("DemoSession polling and ending", () => {
  it("polls at the relay's demo floor once confirmed, faster while waiting for the proof, and honours Retry-After", async () => {
    const { relay, session, sleeps } = await confirmed();
    assert.ok(sleeps.includes(PROOF_WAIT_MS));
    sleeps.length = 0;
    await until(() => sleeps.length >= 2, "two polls");
    assert.deepEqual(sleeps.slice(0, 2), [POLL_MS, POLL_MS]);
    relay.failNext.push(json(429, { error: "rate_limited", message: "x" }, { "Retry-After": "3" }));
    await until(() => sleeps.includes(3000), "the relay's wait");
    assert.match(session.state.error ?? "", /wait 3 s/);
    await until(() => session.state.error === null, "recovery");
    await session.end();
  });

  it("retries on a network error or 5xx and stops on any other refusal", async () => {
    const { relay, session, running } = await confirmed();
    relay.failNext.push(() => Promise.reject(new TypeError("offline")), json(503, { error: "unavailable", message: "x" }));
    await until(() => relay.failNext.length === 0 && session.state.error === null, "recovery");
    relay.failNext.push(json(400, { error: "invalid_request", message: "x" }));
    await until(() => session.state.phase === "error", "stop");
    await running;
    assert.equal(session.state.error, "The relay refused the demo (invalid_request).");
    assert.deepEqual(relay.calls.find(c => c.method === "DELETE" && c.path === "/v1/members/me")?.body, { purge: true });
    assert.equal(relay.agentGone, true);
    assert.ok(session.keys === null && session.token === null);
  });

  for (const route of ["GET /v1/messages", "POST /v1/acks"]) {
    for (const status of [400, 403]) {
      it(`leaves with purge after ${route} refuses with ${status}`, async () => {
        const { relay, session, running } = await confirmed();
        relay.failOn[route] = [json(status, { error: "invalid_request" })];
        await relay.phoneSends(sync({}));
        await running;
        assert.equal(session.state.phase, "error");
        const leave = relay.calls.find(c => c.method === "DELETE" && c.path === "/v1/members/me");
        assert.deepEqual(leave?.body, { purge: true });
        assert.equal(leave.keepalive, true);
        assert.equal(relay.agentGone, true);
        assert.ok(session.keys === null && session.token === null);
      });
    }
  }

  for (const registration of [true, false]) {
    it(`leaves after an invalid ${registration ? "registration countdown" : "message page"} response`, async () => {
      const { relay, session, running } = await started(registration ? { demoRemainingS: -1 } : {
        failOn: { "GET /v1/messages": [json(200, { messages: null })] },
      });
      await running;
      assert.equal(session.state.phase, "error");
      assert.match(session.state.error, /invalid_response/);
      assert.deepEqual(relay.calls.find(c => c.method === "DELETE" && c.path === "/v1/members/me")?.body, { purge: true });
      assert.equal(relay.agentGone, true);
      assert.ok(session.keys === null && session.token === null);
    });
  }

  for (const [label, failure] of [
    ["network error", () => Promise.reject(new TypeError("offline"))],
    ["503", json(503, { error: "unavailable" })],
  ]) {
    it(`keeps a terminal error and drops credentials after a best-effort leave fails with ${label}`, async () => {
      const { relay, session, running } = await confirmed();
      let respond;
      const keys = session.keys;
      const token = session.token;
      relay.failOn["DELETE /v1/members/me"] = [() => new Promise(resolve => { respond = () => resolve(failure()); })];
      relay.failOn["GET /v1/messages"] = [json(400, { error: "invalid_request" })];
      await until(() => respond !== undefined, "pending error cleanup");
      assert.equal(session.stopped, true);
      assert.ok(session.keys === keys && session.token === token);
      respond();
      await running;
      assert.equal(session.state.phase, "error");
      assert.equal(session.state.error, "The relay refused the demo (invalid_request).");
      assert.deepEqual(relay.calls.find(c => c.method === "DELETE" && c.path === "/v1/members/me")?.body, { purge: true });
      assert.ok(session.keys === null && session.token === null);
    });
  }

  it("End demo leaves the hub with purge, drops the keys and stops polling", async () => {
    const { relay, session, running } = await confirmed();
    await session.end();
    await running;
    const leave = relay.calls.find((c) => c.method === "DELETE" && c.path === "/v1/members/me");
    assert.deepEqual(leave.body, { purge: true });
    assert.equal(session.state.phase, "ended");
    assert.equal(session.keys, null);
    assert.equal(session.token, null);
    const count = relay.calls.length;
    await new Promise((done) => setTimeout(done, 20));
    assert.equal(relay.calls.length, count);
    await session.end();
    assert.equal(relay.calls.length, count);
  });

  for (const failure of [() => Promise.reject(new TypeError("offline")), json(503, { error: "unavailable" }), json(429, { error: "rate_limited" }, { "Retry-After": "3" })]) {
    it("retains credentials and shows a failed End demo so the user can retry", async () => {
      const { relay, session, running } = await confirmed();
      const keys = session.keys;
      const token = session.token;
      relay.failOn["DELETE /v1/members/me"] = [failure];
      await session.end();
      await running;
      assert.equal(relay.agentGone, false);
      assert.equal(session.state.phase, "leave_failed");
      assert.match(session.state.error, /End demo.*retry/);
      assert.equal(session.state.notice, null);
      assert.ok(session.keys === keys && session.token === token);
      const count = relay.calls.length;
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(relay.calls.length, count);
      await session.end();
      assert.equal(relay.agentGone, true);
      assert.equal(session.state.phase, "ended");
      assert.equal(session.state.error, null);
      assert.equal(session.token, null);
      assert.equal(session.keys, null);
    });
  }

  for (const [leaveFails, demoRemainingS] of [[false, 3600], [true, 3600], [false, -1], [true, -1]]) {
    it(`revokes a late registration after End demo${demoRemainingS < 0 ? " with an invalid countdown" : ""}${leaveFails ? " and retains it if leave fails" : ""}`, async () => {
      const relay = await stubRelay({ demoRemainingS });
      let respond;
      const session = new DemoSession({ relay: RELAY, fetch: async (url, init) => {
        const response = await relay.fetch(url, init);
        return new URL(url).pathname === "/v1/agents/register" ? new Promise(resolve => { respond = () => resolve(response); }) : response;
      } });
      live.add(session);
      const running = session.start();
      await until(() => respond !== undefined, "pending registration");
      if (leaveFails) relay.failOn["DELETE /v1/members/me"] = [json(503, { error: "unavailable" })];
      const ending = session.end();
      assert.equal(session.state.phase, "ending");
      respond();
      await Promise.all([running, ending]);
      assert.equal(relay.calls.filter(c => c.method === "DELETE" && c.path === "/v1/members/me").length, 1);
      assert.ok(!relay.calls.some(c => c.path === "/v1/pairings" || c.path === "/v1/hub/state"));
      if (leaveFails) {
        assert.equal(session.state.phase, "leave_failed");
        assert.ok(session.token && session.keys);
        await session.end();
      }
      assert.equal(relay.agentGone, true);
      assert.equal(session.state.phase, "ended");
      assert.equal(session.token, null);
      assert.equal(session.keys, null);
    });
  }

  for (const stopped of [false, true]) {
    it(`leaves with a keepalive request when the tab goes away${stopped ? " after stopping" : ""}`, async () => {
      const { relay, session } = await confirmed();
      session.stopped = stopped;
      const unloading = session.leaveOnUnload();
      await until(() => relay.agentGone, "leave");
      const leave = relay.calls.find((c) => c.method === "DELETE");
      assert.equal(leave.keepalive, true);
      assert.deepEqual(leave.body, { purge: true });
      session.leaveOnUnload();
      assert.equal(relay.calls.filter((c) => c.method === "DELETE").length, 1);
      await unloading;
      assert.ok(session.token === null);
    });
  }

  for (const [label, failure] of [
    ["429", json(429, { error: "rate_limited" }, { "Retry-After": "3" })],
    ["network error", () => Promise.reject(new TypeError("offline"))],
    ["503", json(503, { error: "unavailable" })],
  ]) {
    it(`finishes End demo when its in-flight registration fails with ${label}`, async () => {
      let respond;
      const { relay, session, running } = await started({ failOn: {
        "POST /v1/agents/register": [() => new Promise(resolve => { respond = () => resolve(failure()); })],
      } });
      await until(() => respond !== undefined, "pending registration");
      const ending = session.end();
      assert.equal(session.state.phase, "ending");
      respond();
      await Promise.all([running, ending]);
      assert.equal(session.state.phase, "ended");
      assert.equal(session.state.error, null);
      assert.ok(session.keys === null && session.token === null);
      assert.deepEqual(relay.calls.map(c => `${c.method} ${c.path}`), ["POST /v1/agents/register"]);
      await session.end();
      assert.equal(session.state.phase, "ended");
      assert.equal(relay.calls.length, 1);
    });
  }

  it("ends when the relay ended the hub (401), and shows that the phone left", async () => {
    const { relay, session } = await confirmed();
    relay.queue.push({ seq: ++relay.seq, v: 1, kind: "system", from: "relay", msg_id: "z", event: "member_revoked", body: { member_id: "m_dev_1", revoked_by: "m_dev_1", self: true } });
    relay.joined = false;
    await until(() => session.state.phase === "phone_left", "phone left");
    relay.agentGone = true;
    await session.pairAgain();
    assert.equal(session.state.phase, "error");
    assert.deepEqual(relay.calls.find(c => c.method === "DELETE" && c.path === "/v1/members/me")?.body, { purge: true });
    assert.ok(session.keys === null && session.token === null);
    const second = await confirmed();
    second.relay.agentGone = true;
    await until(() => second.session.state.phase === "ended", "end");
    assert.match(second.session.state.notice, /Demo ended/);
  });

  it("explains a registration the relay limited", async () => {
    const relay = await stubRelay();
    relay.failNext.push(json(429, { error: "rate_limited", message: "x" }, { "Retry-After": "1800" }));
    const session = new DemoSession({ relay: RELAY, fetch: relay.fetch });
    await session.start();
    assert.equal(session.state.phase, "error");
    assert.equal(session.state.error, "The relay refused the demo (rate_limited). Try again in 30 min.");
  });

  it("sends no cookie and asks the browser not to cache", async () => {
    const { relay, session } = await confirmed();
    await session.end();
    assert.ok(relay.calls.every((c) => c.headers.Cookie === undefined));
  });
});

describe("DemoSession Retry-After deadlines", () => {
  const epoch = Date.parse("2026-10-29T12:00:00Z");
  for (const [label, header, details, seconds] of [
    ["seconds", "7200", undefined, 7200],
    ["long seconds", "100000", undefined, 100000],
    ["HTTP-date", new Date(epoch + 7250_000).toUTCString(), undefined, 7250],
    ["details", undefined, { retry_after_s: 7300 }, 7300],
    ["malformed header with details", "nonsense", { retry_after_s: 7400 }, 7400],
    ["header priority", "7500", { retry_after_s: 1 }, 7500],
  ]) {
    it(`waits the full ${label} deadline and End demo prevents another poll`, async () => {
      let at = epoch;
      let polls = 0;
      const waits = [];
      const session = new DemoSession({ relay: RELAY, now: () => at,
        fetch: async () => {
          polls++;
          return json(429, { error: "rate_limited", details }, header === undefined ? {} : { "Retry-After": header })();
        },
        sleep: ms => new Promise(resolve => waits.push({ ms, resolve })),
      });
      live.add(session);
      session.state.phase = "confirmed";
      const running = session.run();
      await until(() => waits.length === 1, "retry wait");
      assert.equal(waits[0].ms, seconds * 1000);
      at += seconds * 1000 - 1;
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(polls, 1);
      await session.end();
      at++;
      waits[0].resolve();
      await running;
      assert.equal(polls, 1);
    });
  }

  for (const header of [undefined, "nonsense", "-1", "1.5"]) {
    it(`uses bounded increasing backoff for ${header ?? "absent"} Retry-After and resumes after the deadline`, async () => {
      let at = epoch;
      let polls = 0;
      const waits = [];
      const session = new DemoSession({ relay: RELAY, now: () => at,
        fetch: async () => ++polls <= 6
          ? json(429, { error: "rate_limited", details: { retry_after_s: -1 } }, header === undefined ? {} : { "Retry-After": header })()
          : json(200, { messages: [], next_after: 0, has_more: false, undelivered: [], agent_activity: [], agent_activity_as_of: new Date(at).toISOString() })(),
        sleep: ms => new Promise(resolve => waits.push({ ms, resolve })),
      });
      live.add(session);
      session.state.phase = "confirmed";
      const running = session.run();
      for (const [i, ms] of [5000, 10000, 20000, 40000, 60000, 60000].entries()) {
        await until(() => waits.length === i + 1, "backoff");
        assert.equal(waits[i].ms, ms);
        assert.equal(polls, i + 1);
        at += ms;
        waits[i].resolve();
      }
      await until(() => waits.length === 7, "successful page");
      assert.equal(waits[6].ms, POLL_MS);
      assert.equal(session.state.error, null);
      await session.end();
      waits[6].resolve();
      await running;
      assert.equal(polls, 7);
    });
  }

  it("keeps a long Retry-After beyond the browser timer range without an early poll", async t => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: epoch });
    let polls = 0;
    const seconds = 3_000_000;
    const session = new DemoSession({ relay: RELAY,
      fetch: async () => ++polls === 1
        ? json(429, { error: "rate_limited" }, { "Retry-After": String(seconds) })()
        : json(200, { messages: [], has_more: false })(),
    });
    live.add(session);
    session.state.phase = "confirmed";
    const running = session.run();
    await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(2_147_483_647);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(polls, 1);
    t.mock.timers.tick(seconds * 1000 - 2_147_483_647 - 1);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(polls, 1);
    t.mock.timers.tick(1);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(polls, 2);
    await session.end();
    t.mock.timers.tick(POLL_MS);
    await running;
    assert.equal(polls, 2);
  });

  it("accepts E11 activity keys without changing proof, pagination, acknowledgement or the 5 s cadence", async () => {
    const relay = await stubRelay();
    const baseFetch = relay.fetch;
    relay.fetch = async (url, init) => {
      const response = await baseFetch(url, init);
      if (init.method !== "GET" || new URL(url).pathname !== "/v1/messages" || !response.ok) return response;
      const page = await response.json();
      const messages = page.messages.slice(0, 1);
      return json(200, { ...page, messages, next_after: messages.at(-1)?.seq ?? page.next_after,
        has_more: page.messages.length > 1, undelivered: [], agent_activity: [], agent_activity_as_of: new Date(epoch).toISOString() })();
    };
    const waits = [];
    const session = new DemoSession({ relay: RELAY, fetch: relay.fetch,
      sleep: ms => { waits.push(ms); return new Promise(resolve => setImmediate(resolve)); },
      onChange: state => { if (state.pairing?.uri) relay.lastUri = state.pairing.uri; },
    });
    live.add(session);
    const running = session.start();
    await until(() => session.state.phase === "confirmed" && relay.acked >= 2, "paged proof and acks");
    await until(() => waits.includes(POLL_MS), "demo cadence");
    assert.equal(relay.phoneMessages[0].inner.type, "confirmed");
    assert.ok(relay.calls.filter(call => call.method === "GET" && call.path.startsWith("/v1/messages")).every(call => !call.path.includes("poll_interval_s")));
    await session.end();
    await running;
  });
});
