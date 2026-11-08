import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync } from "node:fs";
import { join } from "node:path";

import { MAX_REPLY_BYTES } from "../server.mjs";
import { caseOptions, hmacHex, inbox, lines, nativeRequest, queue, requestCase, resultsRequest, send, signed, start, tempDir, water } from "./helpers.js";

const TOKEN = "srv_test-token";
const HMAC = "whsec_mgHtkTuuLB_wsJa221vi031K8GmN9QbtPNq_RV8uD8c";
const NOW = 1791961923;
const STEP = { uuid: "5E1D0000-0000-4000-8000-000000000001", type: "steps", value: 412, unit: "count", start: "2026-10-14T07:01:00Z", end: "2026-10-14T07:01:59Z", source: { app: "com.apple.Health", device: null } };

async function signedServer(t, extra = {}) {
  const dir = tempDir(t);
  const server = await start(t, { dir, auth: "bearer", token: TOKEN, hmac: HMAC, now: () => NOW, ...extra });
  return { dir, server };
}

const data = (port, options = {}) => {
  const request = nativeRequest({ token: TOKEN, hmac: HMAC, t: NOW, samples: [STEP], ...options });
  return send(port, request).then((reply) => ({ ...reply, delivery: request.delivery }));
};
const resultsFor = (port, commands) =>
  send(port, resultsRequest({ token: TOKEN, hmac: HMAC, t: NOW, results: commands.map((c) => ({ command_id: c.command_id, version: c.version, status: "applied" })) }));

function verifiedCommands(reply) {
  assert.equal(reply.status, 200);
  assert.equal(reply.headers.get("content-type"), "application/json");
  const expected = `t=${NOW},v1=${hmacHex(HMAC, `${reply.delivery}.${NOW}.${reply.body}`)}`;
  assert.equal(reply.headers.get("x-syncky-signature"), expected);
  const message = JSON.parse(reply.body);
  assert.equal(message.v, 1);
  assert.equal(message.type, "commands");
  return message.commands;
}

describe("auth and signatures", () => {
  it("401 for a missing or wrong token, a missing, bad or stale signature", async (t) => {
    const { dir, server } = await signedServer(t);
    const good = nativeRequest({ token: TOKEN, hmac: HMAC, t: NOW, samples: [STEP] });
    const cases = [
      ["no token", { ...good.headers, Authorization: undefined }],
      ["wrong token", { ...good.headers, Authorization: `Bearer ${TOKEN}x` }],
      ["basic instead of bearer", { ...good.headers, Authorization: `Basic ${Buffer.from(`u:${TOKEN}`).toString("base64")}` }],
      ["no signature", { ...good.headers, "X-Syncky-Signature": undefined, "X-Syncky-Timestamp": undefined }],
      ["bad signature", { ...good.headers, "X-Syncky-Signature": `v1=${"0".repeat(64)}` }],
      ["stale signature", signed({ ...good.headers }, good.body, HMAC, NOW - 301)],
    ];
    for (const [name, headers] of cases) {
      const clean = Object.fromEntries(Object.entries(headers).filter(([, v]) => v !== undefined));
      const reply = await send(server.port, { headers: clean, body: good.body });
      assert.equal(reply.status, 401, name);
    }
    assert.deepEqual(lines(join(dir, "samples.jsonl")), []);
    assert.equal((await send(server.port, good)).status, 200);
  });

  it("basic and custom-header auth compare the whole value", async (t) => {
    for (const [extra, ok, bad] of [
      [{ auth: "basic", user: "phone" }, { Authorization: `Basic ${Buffer.from(`phone:${TOKEN}`).toString("base64")}` }, { Authorization: `Basic ${Buffer.from(`other:${TOKEN}`).toString("base64")}` }],
      [{ auth: "header", header: "X-Api-Key" }, { "x-api-key": TOKEN }, { "x-api-key": `${TOKEN} ` + "x" }],
    ]) {
      const { server } = await signedServer(t, { ...extra, hmac: null });
      const request = nativeRequest({ t: NOW, samples: [STEP] });
      assert.equal((await send(server.port, { headers: { ...request.headers, ...bad }, body: request.body })).status, 401);
      assert.equal((await send(server.port, { headers: { ...request.headers, ...ok }, body: request.body })).status, 200);
    }
  });
});

describe("request handling", () => {
  it("413 above 1,000,000 bytes, GET /health, 404 for other GETs and 405 for other methods", async (t) => {
    const { server } = await signedServer(t);
    assert.equal((await send(server.port, { headers: { "X-Syncky-Format": "influx" }, body: "x".repeat(1_000_001) })).status, 413);
    const health = await send(server.port, { method: "GET", path: "/health" });
    assert.equal(health.status, 200);
    assert.deepEqual(JSON.parse(health.body), { ok: true });
    assert.equal((await send(server.port, { method: "GET", path: "/syncky" })).status, 404);
    assert.equal((await send(server.port, { method: "PUT", body: "{}" })).status, 405);
    assert.equal((await send(server.port, { method: "DELETE" })).status, 405);
  });

  it("400 for an unknown format, a body that is not a sync message and a results body that is not results", async (t) => {
    const { server } = await signedServer(t);
    const plain = nativeRequest({ token: TOKEN, hmac: HMAC, t: NOW });
    assert.equal((await send(server.port, { headers: { ...plain.headers, "X-Syncky-Format": "xml" }, body: plain.body })).status, 400);
    const bad = "[1,2]";
    assert.equal((await send(server.port, { headers: signed(plain.headers, bad, HMAC, NOW), body: bad })).status, 400);
    assert.equal((await send(server.port, { headers: signed({ ...plain.headers, "X-Syncky-Kind": "results" }, bad, HMAC, NOW), body: bad })).status, 400);
  });

  it("stores duplicates once and applies deletions", async (t) => {
    const c = requestCase("native_all_kinds");
    const dir = tempDir(t);
    const server = await start(t, { ...caseOptions(c, dir), now: () => Number(c.timestamp) });
    for (let round = 0; round < 2; round += 1) {
      for (const r of c.requests) assert.equal((await send(server.port, { headers: r.headers, body: r.body })).status, 200);
    }
    assert.equal(lines(join(dir, "samples.jsonl")).length, c.report.samples);
    assert.equal(lines(join(dir, "deleted.jsonl")).length, c.report.deleted);

    const hae = requestCase("hae_header_auth_unsigned_split");
    const haeDir = tempDir(t);
    const haeServer = await start(t, { ...caseOptions(hae, haeDir), now: () => Number(hae.timestamp) });
    for (let round = 0; round < 2; round += 1) {
      for (const r of hae.requests) assert.equal((await send(haeServer.port, { headers: r.headers, body: r.body })).status, 200);
    }
    assert.equal(inbox(haeDir).length, hae.requests.length);

    const { dir: own, server: ownServer } = await signedServer(t);
    assert.equal((await data(ownServer.port)).status, 200);
    assert.equal((await data(ownServer.port, { samples: [], deleted: [{ uuid: STEP.uuid, type: "steps" }] })).status, 200);
    assert.deepEqual(lines(join(own, "samples.jsonl")), []);
    assert.equal(lines(join(own, "deleted.jsonl")).length, 1);
    assert.equal((await data(ownServer.port, { samples: [], deleted: [{ uuid: STEP.uuid, type: "steps" }] })).status, 200);
    assert.equal(lines(join(own, "deleted.jsonl")).length, 1);
  });

  it("a delivery that failed to store is stored when the phone retries it", async (t) => {
    const { dir, server } = await signedServer(t);
    const request = nativeRequest({ token: TOKEN, hmac: HMAC, t: NOW, samples: [STEP] });
    chmodSync(dir, 0o500);
    try {
      assert.equal((await send(server.port, request)).status, 500);
    } finally {
      chmodSync(dir, 0o700);
    }
    assert.equal((await send(server.port, request)).status, 200);
    assert.deepEqual(lines(join(dir, "samples.jsonl")).map((line) => JSON.parse(line).uuid), [STEP.uuid]);
  });

  it("keeps what it stored across a restart", async (t) => {
    const { dir, server } = await signedServer(t);
    assert.equal((await data(server.port)).status, 200);
    await server.close();
    const again = await start(t, { dir, auth: "bearer", token: TOKEN, hmac: HMAC, now: () => NOW });
    assert.equal((await data(again.port)).status, 200);
    assert.equal(lines(join(dir, "samples.jsonl")).length, 1);
  });
});

describe("write-back", () => {
  it("accepts rejected results with optional details and completes their queued commands", async (t) => {
    const { dir, server } = await signedServer(t);
    const results = [
      { command_id: "c_1", version: 1, status: "rejected", reason: "invalid", detail: "end_in_future" },
      { command_id: "c_2", version: 1, status: "rejected", reason: "type_not_in_scope", detail: "declined_by_user" },
      { command_id: "c_3", version: 1, status: "rejected", reason: "invalid", detail: "future_detail" },
      { command_id: "c_4", version: 1, status: "rejected", reason: "invalid" },
    ];
    queue(dir, results.map((_, i) => water(i + 1)));
    const request = resultsRequest({ token: TOKEN, hmac: HMAC, t: NOW, results });
    assert.equal((await send(server.port, request)).status, 200);
    assert.deepEqual(lines(join(dir, "results.jsonl")).map(JSON.parse), results.map(({ detail, ...r }) => ({ at: new Date(NOW * 1000).toISOString(), ...r })));
    assert.equal((await data(server.port)).body, "");
    const recorded = lines(join(dir, "results.jsonl"));
    assert.equal((await send(server.port, request)).status, 200);
    assert.deepEqual(lines(join(dir, "results.jsonl")), recorded);
  });

  it("a queued write comes back as signed commands that verify independently", async (t) => {
    const { dir, server } = await signedServer(t);
    queue(dir, [water(1)]);
    assert.deepEqual(verifiedCommands(await data(server.port)), [water(1)]);
  });

  it("a lost reply is repeated until its result arrives, and a repeated result changes nothing", async (t) => {
    const { dir, server } = await signedServer(t);
    queue(dir, [water(1)]);
    assert.deepEqual(verifiedCommands(await data(server.port)), [water(1)]);
    assert.deepEqual(verifiedCommands(await data(server.port)), [water(1)]);
    assert.equal((await resultsFor(server.port, [water(1)])).status, 200);
    const after = await data(server.port);
    assert.equal(after.status, 200);
    assert.equal(after.body, "");
    const recorded = lines(join(dir, "results.jsonl"));
    assert.equal((await resultsFor(server.port, [water(1)])).status, 200);
    assert.deepEqual(lines(join(dir, "results.jsonl")), recorded);
    assert.equal((await data(server.port)).body, "");
  });

  it("a delete queued before the write was delivered replaces it, and its result ends both", async (t) => {
    const { dir, server } = await signedServer(t);
    const removal = { command_id: "c_1", version: 2, op: "delete", type: "dietary_water" };
    queue(dir, [water(1), water(2), removal]);
    assert.deepEqual(verifiedCommands(await data(server.port)), [water(2), removal]);
    assert.equal((await resultsFor(server.port, [removal])).status, 200);
    assert.deepEqual(verifiedCommands(await data(server.port)), [water(2)]);
  });

  it("an unsigned server replies unsigned commands", async (t) => {
    const { dir, server } = await signedServer(t, { hmac: null });
    queue(dir, [water(1)]);
    const reply = await send(server.port, nativeRequest({ token: TOKEN, t: NOW, samples: [STEP] }));
    assert.equal(reply.status, 200);
    assert.equal(reply.headers.get("x-syncky-signature"), null);
    assert.deepEqual(JSON.parse(reply.body).commands, [water(1)]);
  });

  it("a backlog of 500 writes drains over several deliveries, no reply above 60,000 bytes", async (t) => {
    const { dir, server } = await signedServer(t);
    const backlog = Array.from({ length: 500 }, (_, i) => ({ ...water(i + 1), value: 0.25 + i / 1000 }));
    queue(dir, backlog);
    const seen = [];
    let deliveries = 0;
    for (;;) {
      const reply = await data(server.port);
      if (reply.body === "") break;
      deliveries += 1;
      assert.ok(Buffer.byteLength(reply.body) <= MAX_REPLY_BYTES, `reply ${deliveries} has ${Buffer.byteLength(reply.body)} bytes`);
      const commands = verifiedCommands(reply);
      assert.ok(commands.length > 0);
      seen.push(...commands.map((c) => c.command_id));
      assert.equal((await resultsFor(server.port, commands)).status, 200);
      assert.ok(deliveries < 50, "the backlog does not drain");
    }
    assert.ok(deliveries > 1, `drained in ${deliveries} delivery`);
    assert.deepEqual(seen, backlog.map((c) => c.command_id));
  });
});
