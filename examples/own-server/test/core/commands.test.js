import { it } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { connected, rpc, tool, command, write, errorCode } from "../support/mcp.js";
import { destination, device, sample, databasePath, vectors, signed, authHeader } from "../support/helpers.js";
import { openSqlite } from "../../docker/sql.js";
import { createStore } from "../../src/store.js";
import catalog from "../../src/write-catalog.json" with { type: "json" };
import { setup } from "../support/browser.js";

it("writes are hidden and denied by default and require both current toggle and explicit per-client consent", async (t) => {
  const b = await connected(t);
  assert.equal(errorCode(await write(b, command(b))), "write_denied");
  assert.equal((await b.post("/admin/settings", { writes_enabled: "true" })).status, 200);
  assert.equal(errorCode(await write(b, command(b))), "write_denied");
  const tokens = await b.access(b.client, { scope: "read:steps write:dietary_water" });
  b.accessToken = tokens.access_token;
  const list = await (await rpc(b, b.accessToken, "tools/list")).json();
  assert.deepEqual(list.result.tools.map(v => v.name), ["syncky_status", "syncky_query", "syncky_write"]);
  assert.equal(list.result.tools.at(-1).annotations.readOnlyHint, false);
  const queued = await write(b, command(b));
  assert.equal(queued.state, "queued");
  assert.equal(Object.hasOwn(queued, "result"), false);
  assert.equal((await b.post("/admin/settings", { writes_enabled: "false" })).status, 200);
  const off = await (await rpc(b, b.accessToken, "tools/list")).json();
  assert.ok(!off.result.tools.some(v => v.name === "syncky_write"));
  assert.equal(errorCode(await write(b, command(b))), "write_denied");
});

it("validates writable catalog/schema, finite converted bounds, timestamps, categories and known target binding", async (t) => {
  const b = await connected(t, { write: true });
  for (const extra of [{ type: "apple_exercise_time", value: 30, unit: "min" }, { type: "workout" }, { value: -1 }, { value: 101 }, { value: 100001, unit: "mL" }, { value: "0.25" }, { unit: "count" }, { version: 0 }, { version: 1.5 }, { version: 2 }, { command_id: "x".repeat(65) }, { op: "update" }, { start: "2026-02-30T07:00:00Z" }, { start: "2026-10-14T07:00:00.000Z" }, { end: "2026-10-14T06:00:00Z" }, { end: "2026-10-17T07:00:00Z" }, { destination: destination() }, { device: device() }]) assert.ok(errorCode(await write(b, command(b, extra))), "invalid command refused");
  assert.equal((await write(b, command(b, { value: 250, unit: "mL" }))).state, "queued");
  const category = command(b, { type: "sleep_analysis", value: "asleep_core" });
  delete category.unit;
  assert.equal((await write(b, category)).state, "queued");
  assert.ok(errorCode(await write(b, { ...category, command_id: randomUUID(), value: "invented" })));
  assert.ok(errorCode(await write(b, { ...category, command_id: randomUUID(), unit: "s" })));
  const request = command(b, { value: Number.POSITIVE_INFINITY });
  assert.ok(errorCode(await write(b, request)));
  const [type, definition] = Object.entries(catalog.types).find(([name, v]) => v.kind === "quantity" && name !== "dietary_water");
  assert.equal(errorCode(await write(b, command(b, { type, unit: definition.unit, value: definition.min }))), "type_not_consented");
  const secondDevice = device(), secondDestination = destination();
  const second = await b.deliver({ device: secondDevice, delivery: { destination: secondDestination }, samples: [sample()] });
  assert.equal(second.status, 200);
  assert.equal(errorCode(await write(b, command(b, { destination: secondDestination }))), "invalid_target");
  assert.equal(errorCode(await write(b, command(b, { device: secondDevice }))), "invalid_target");
});

it("enforces idempotent latest versions, command ownership, immutable type/target and own result receipts", async (t) => {
  const b = await connected(t, { write: true });
  const c = command(b);
  assert.equal((await write(b, c)).state, "queued");
  assert.equal((await write(b, Object.fromEntries(Object.entries(c).reverse()))).state, "queued");
  assert.equal(b.sql.all("SELECT * FROM commands").length, 1);
  assert.equal(errorCode(await write(b, { ...c, value: 0.5 })), "version_conflict");
  const other = await b.access(await b.register(), { scope: "read:steps write:dietary_water" });
  assert.equal(errorCode(await write(b, c, other.access_token)), "command_not_owned");
  const erase = { destination: c.destination, device: c.device, command_id: c.command_id, version: 2, op: "delete", type: c.type };
  assert.equal(errorCode(await write(b, { ...erase, command_id: randomUUID() })), "command_not_owned");
  assert.equal(errorCode(await write(b, { ...erase, version: 3 })), "version_conflict");
  assert.equal((await write(b, erase)).state, "queued");
  assert.equal(errorCode(await write(b, c)), "version_conflict");
  assert.equal(errorCode(await write(b, { ...erase, version: 3, type: "sleep_analysis" })), "command_not_owned");
  assert.equal((await b.results([{ command_id: c.command_id, version: 1, status: "applied" }])).status, 200);
  assert.equal((await write(b, erase)).state, "queued");
  const reply = await b.deliver();
  assert.equal((await reply.json()).commands[0].version, 2);
  assert.equal((await b.results([{ command_id: c.command_id, version: 2, status: "rejected", reason: "healthkit_denied" }])).status, 200);
  const receipt = await write(b, erase);
  assert.equal(receipt.state, "rejected");
  assert.equal(receipt.result.reason, "healthkit_denied");
  assert.equal(errorCode(await write(b, erase, other.access_token)), "command_not_owned");
  assert.equal(await (await b.deliver()).text(), "");
});

it("resends only on matching ordinary native uploads, signs exact reply bytes, and ignores wrong/unknown/duplicate results", async (t) => {
  const b = await connected(t, { write: true });
  const c = command(b);
  await b.results([{ command_id: c.command_id, version: 1, status: "applied" }]);
  await write(b, c);
  for (let n = 0; n < 2; n++) {
    const requestId = randomUUID();
    const response = await b.deliver({ delivery: { id: requestId } });
    assert.equal(response.headers.get("content-type"), "application/json");
    const body = await response.text();
    assert.equal(JSON.parse(body).commands.length, 1);
    const expected = `t=${b.deps.now()},v1=${createHmac("sha256", b.config.hmac).update(`${requestId}.${b.deps.now()}.`).update(body).digest("hex")}`;
    assert.ok(response.headers.get("x-syncky-signature") === expected, "reply signature binds delivery and exact bytes");
  }
  assert.equal(await (await b.deliver({ device: device() })).text(), "");
  assert.equal(await (await b.deliver({ delivery: { destination: destination() } })).text(), "");
  const probe = await b.deliver({ delivery: { test: true } });
  assert.equal(await probe.text(), "");
  assert.equal(probe.headers.has("x-syncky-signature"), false);
  assert.equal(await (await b.results([{ command_id: c.command_id, version: 1, status: "applied" }], destination())).text(), "");
  assert.equal((await write(b, c)).state, "queued");
  assert.equal(await (await b.results([{ command_id: "unknown", version: 9, status: "applied" }])).text(), "");
  assert.equal((await write(b, c)).state, "queued");
  await b.results([{ command_id: c.command_id, version: 1, status: "rejected", reason: "type_not_in_scope" }]);
  await b.results([{ command_id: c.command_id, version: 1, status: "applied" }]);
  const receipt = await write(b, c);
  assert.equal(receipt.state, "rejected");
  assert.equal(receipt.result.reason, "type_not_in_scope");
  assert.equal(await (await b.deliver()).text(), "");
  assert.equal((await b.post("/admin/settings", { hmac_enabled: "false" })).status, 200);
  const rotated = await b.post("/admin/rotate-upload", { confirm: "rotate" });
  assert.equal(rotated.status, 200);
  const link = new URL(setup(await rotated.text()));
  b.config.token = link.searchParams.get("token"); b.config.hmac = null;
  assert.equal((await write(b, command(b))).state, "queued");
  const unsigned = await b.deliver();
  assert.equal(unsigned.headers.has("x-syncky-signature"), false);
  assert.equal((await unsigned.json()).commands.length, 1);
});

for (const action of ["disable", "revoke"]) it(`lost reply → ${action} → restart prevents retries, accepts late results and respects later consent`, async (t) => {
  const path = databasePath(t), b = await connected(t, { write: true, path });
  const first = command(b), late = command(b);
  await write(b, first); await write(b, late);
  assert.equal((await (await b.deliver()).json()).commands.length, 2);
  const response = action === "disable" ? await b.post("/admin/settings", { writes_enabled: "false" }) : await b.post(`/admin/clients/${b.client.client_id}/revoke`);
  assert.equal(response.status, 200);
  b.sql.close();
  const reopened = openSqlite(path); t.after(() => reopened.close());
  b.deps.store = createStore(reopened);
  assert.equal(await (await b.deliver()).text(), "");
  assert.equal(await (await b.results([{ command_id: late.command_id, version: 1, status: "applied" }])).text(), "");
  assert.equal(await (await b.deliver()).text(), "");
  if (action === "disable") {
    assert.equal((await b.post("/admin/settings", { writes_enabled: "true" })).status, 200);
    const next = await (await b.deliver()).json();
    assert.equal(next.commands.length, 1);
    assert.equal(next.commands[0].command_id, first.command_id);
    assert.equal((await write(b, late)).state, "applied");
  } else {
    assert.equal((await rpc(b, b.accessToken, "tools/list")).status, 401);
    const renewed = await b.access(b.client, { scope: "read:steps write:dietary_water" });
    assert.equal(await (await b.deliver()).text(), "");
    assert.equal(errorCode(await write(b, first, renewed.access_token)), "command_not_owned");
    assert.ok(reopened.all("SELECT state FROM commands").every(r => r.state === "cancelled"));
  }
});

it("caps replies at 60,000 UTF-8 bytes, rejects a larger single command and packs multiple pending commands", async (t) => {
  const b = await connected(t, { write: true });
  const c = command(b, { note: "" });
  const { destination: d, device: p, ...payload } = c;
  const overhead = new TextEncoder().encode(JSON.stringify({ v: 1, type: "commands", commands: [payload] })).length;
  const padding = 60_000 - overhead;
  c.note = "😀".repeat(Math.floor(padding / 4)) + "x".repeat(padding % 4);
  assert.equal((await write(b, c)).state, "queued");
  assert.equal(errorCode(await write(b, { ...c, command_id: randomUUID(), note: c.note + "x" })), "command_too_large");
  const second = command(b);
  assert.equal((await write(b, second)).state, "queued");
  const body = await (await b.deliver()).text();
  assert.equal(new TextEncoder().encode(body).length, 60_000);
  assert.equal(JSON.parse(body).commands.length, 1);
  await b.results([{ command_id: c.command_id, version: 1, status: "applied" }]);
  assert.equal((await (await b.deliver()).json()).commands.length, 1);
});

it("preserves queue/result atomicity when storage fails and never acknowledges an uncommitted native upload", async (t) => {
  const b = await connected(t, { write: true });
  const c = command(b); await write(b, c);
  b.sql.run("CREATE TRIGGER fail_sample BEFORE INSERT ON samples BEGIN SELECT RAISE(ABORT, 'storage_failure'); END");
  const failure = await b.deliver({ samples: [sample()] });
  assert.equal(failure.status, 500);
  assert.equal((await write(b, c)).state, "queued");
  b.sql.run("CREATE TRIGGER fail_result BEFORE UPDATE ON commands BEGIN SELECT RAISE(ABORT, 'storage_failure'); END");
  assert.equal((await b.results([{ command_id: c.command_id, version: 1, status: "applied" }])).status, 500);
  assert.equal(b.sql.all("SELECT * FROM results").length, 0);
});

it("replays exchange request vectors with a live queue; vector non-writable commands are refused before delivery", async (t) => {
  const b = await connected(t, { write: true });
  const first = vectors("webhook-exchanges").find(c => c.name === "signed_http");
  for (const payload of JSON.parse(first.body).commands) {
    const result = await write(b, { destination: b.destination, device: b.device, ...payload });
    assert.equal(Object.hasOwn(catalog.types, payload.type) ? result.state : errorCode(result), Object.hasOwn(catalog.types, payload.type) ? "queued" : "type_not_writable");
  }
  for (const c of vectors("webhook-exchanges").filter(c => c.kind !== "reply")) {
    const headers = new Headers(c.headers);
    for (const [key, value] of Object.entries(authHeader(b.config))) headers.set(key, value);
    const response = await b.send(new Request("https://receiver.example/server", { method: "POST", headers: signed(headers, c.body, b.config.hmac, b.deps.now()), body: c.body }));
    assert.equal(response.status, c.kind === "results_request" || c.format === "native" ? 200 : 415);
    if (response.status === 200) assert.equal(await response.text(), "");
  }
  const erase = JSON.parse(vectors("webhook-exchanges").find(c => c.name === "signed_http_delete").body).commands[0];
  assert.equal((await write(b, { destination: b.destination, device: b.device, ...erase })).state, "queued");
  const response = await b.deliver();
  assert.equal((await response.json()).commands[0].op, "delete");
});
