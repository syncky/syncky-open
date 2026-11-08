import { it } from "node:test";
import assert from "node:assert/strict";
import { connected, rpc, tool, command, errorCode } from "../support/mcp.js";
import { native, sample, summary, device, secret } from "../support/helpers.js";
import { origin } from "../support/browser.js";

it("negotiates JSON Streamable HTTP and exposes only consented read tools with read-only annotations", async (t) => {
  const b = await connected(t);
  for (const protocolVersion of ["2025-06-18", "unsupported"]) {
    const response = await rpc(b, b.accessToken, "initialize", { protocolVersion, capabilities: {}, clientInfo: { name: "Local", version: "1" } });
    assert.equal(response.status, 200);
    const { result } = await response.json();
    assert.equal(result.protocolVersion, "2025-06-18");
    assert.deepEqual(result.capabilities, { tools: { listChanged: false } });
  }
  const listed = await (await rpc(b, b.accessToken, "tools/list")).json();
  assert.deepEqual(listed.result.tools.map(v => v.name), ["syncky_status", "syncky_query"]);
  for (const entry of listed.result.tools) {
    assert.equal(entry.annotations.readOnlyHint, true);
    assert.equal(entry.inputSchema.type, "object");
  }
  assert.deepEqual((await (await rpc(b, b.accessToken, "ping")).json()).result, {});
  const notification = await rpc(b, b.accessToken, "notifications/initialized", undefined, {}, { id: undefined });
  assert.equal(notification.status, 202);
  assert.equal(await notification.text(), "");
  assert.equal((await b.send(new Request(origin + "/mcp", { headers: { Authorization: `Bearer ${b.accessToken}` } }))).status, 405);
});

it("checks auth and consent before transport, metadata and errors on every method", async (t) => {
  const b = await connected(t);
  b.sql.run("UPDATE grants SET consented = 0 WHERE client_id = ?", b.client.client_id);
  for (const method of ["initialize", "notifications/initialized", "ping", "tools/list", "tools/call", "unknown"]) {
    for (const headers of [{}, { "Content-Type": "text/plain", Accept: "text/event-stream" }]) {
      const response = await rpc(b, b.accessToken, method, { name: "syncky_query" }, headers);
      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), { ok: false, code: "consent_required" });
      assert.equal((await rpc(b, secret(), method)).status, 401);
    }
  }
});

it("accepts standard request metadata separately from method and tool arguments", async (t) => {
  const b = await connected(t);
  for (const _meta of [{}, { progressToken: "" }, { progressToken: 0 }, { progressToken: 1.5 }, { progressToken: "progress", "client.example/context": { nested: true } }]) {
    for (const [method, params] of [
      ["initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "Local", version: "1" } }],
      ["ping", {}], ["tools/list", {}], ["tools/call", { name: "syncky_query", arguments: { type: "steps" } }],
    ]) {
      const reply = await rpc(b, b.accessToken, method, { ...params, _meta }, {}, { id: method });
      assert.equal(reply.status, 200);
      const body = await reply.json();
      assert.equal(body.id, method);
      assert.ok(Object.hasOwn(body, "result"), "metadata does not invalidate the request");
    }
  }
  assert.equal(errorCode(await tool(b, b.accessToken, "syncky_query", { type: "steps", _meta: {} })), "invalid_params");
});

it("rejects malformed metadata on every supported request with the original ID", async (t) => {
  const b = await connected(t);
  for (const _meta of [null, [], "metadata", { progressToken: null }, { progressToken: true }, { progressToken: {} }]) {
    for (const [method, params] of [
      ["initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "Local", version: "1" } }],
      ["ping", {}], ["tools/list", {}], ["tools/call", { name: "syncky_status" }],
    ]) {
      const reply = await rpc(b, b.accessToken, method, { ...params, _meta }, {}, { id: 0 });
      assert.equal(reply.status, 200);
      const body = await reply.json();
      assert.equal(body.jsonrpc, "2.0");
      assert.equal(body.id, 0);
      assert.equal(body.error.code, -32602);
    }
  }
});

it("returns HTTP errors for rejected notifications and empty 202 for initialized notifications", async (t) => {
  const b = await connected(t);
  for (const [method, params] of [["ping", undefined], ["tools/list", undefined], ["tools/call", { name: "syncky_status" }], ["notifications/unsupported", undefined], ["notifications/initialized", { extra: true }], ["notifications/initialized", { _meta: null }], ["notifications/initialized", []]]) {
    const reply = await rpc(b, b.accessToken, method, params, {}, { id: undefined });
    assert.equal(reply.status, 400);
    const body = await reply.json();
    assert.equal(Object.hasOwn(body, "jsonrpc"), false);
    assert.equal(Object.hasOwn(body, "id"), false);
    assert.equal(b.sql.all("SELECT * FROM commands").length, 0);
  }
  for (const params of [undefined, {}, { _meta: { "client.example/context": true } }]) {
    const reply = await rpc(b, b.accessToken, "notifications/initialized", params, {}, { id: undefined });
    assert.equal(reply.status, 202);
    assert.equal(await reply.text(), "");
  }
});

it("uses invalid-params errors for unknown tools and invalid read/write arguments", async (t) => {
  const b = await connected(t, { write: true });
  for (const [name, args, detail] of [
    ["unknown", {}, "unknown_tool"], ["syncky_query", { type: "steps", limit: 0 }, "invalid_params"],
    ["syncky_write", command(b, { device: "invalid" }), "invalid_target"],
    ["syncky_write", command(b, { version: 0 }), "invalid_command"],
    ["syncky_write", command(b, { type: "workout" }), "type_not_writable"],
    ["syncky_write", command(b, { value: -1 }), "value_out_of_range"],
  ]) {
    const reply = await rpc(b, b.accessToken, "tools/call", { name, arguments: args }, {}, { id: name });
    assert.equal(reply.status, 200);
    const body = await reply.json();
    assert.equal(body.jsonrpc, "2.0");
    assert.equal(body.id, name);
    assert.equal(body.error.code, -32602);
    assert.equal(body.error.data.code, detail);
  }
  assert.equal(b.sql.all("SELECT * FROM commands").length, 0);
});

it("keeps internal tool-list failures in a safe JSON-RPC envelope with a zero ID", async (t) => {
  const b = await connected(t);
  const store = b.deps.store;
  b.deps.store = { ...store, setting(name) { if (name === "writes_enabled") throw new Error(secret()); return store.setting(name); } };
  const reply = await rpc(b, b.accessToken, "tools/list", undefined, {}, { id: 0 });
  assert.equal(reply.status, 200);
  assert.deepEqual(await reply.json(), { jsonrpc: "2.0", id: 0, error: { code: -32603, message: "Internal error" } });
});

it("validates headers, JSON-RPC shapes, protocol versions and 64 KiB bodies with safe errors", async (t) => {
  const b = await connected(t);
  for (const [headers, status] of [[{ "Content-Type": "text/plain" }, 415], [{ Accept: "text/event-stream" }, 406], [{ "MCP-Protocol-Version": "unknown" }, 400], [{ "MCP-Protocol-Version": "" }, 400], [{ Origin: "https://attacker.example" }, 403]]) assert.equal((await rpc(b, b.accessToken, "ping", undefined, headers)).status, status);
  for (const Origin of [origin, "https://claude.ai"]) assert.equal((await rpc(b, b.accessToken, "ping", undefined, { Origin })).status, 200);
  for (const extra of [{ jsonrpc: "1.0" }, { id: {} }, { id: "x".repeat(129) }, { method: 1 }, { params: [] }]) {
    const value = await (await rpc(b, b.accessToken, "ping", undefined, {}, extra)).json();
    assert.equal(value.error.code, -32600);
    assert.equal(value.id, null);
  }
  const send = body => b.send(new Request(origin + "/mcp", { method: "POST", headers: { Authorization: `Bearer ${b.accessToken}`, "Content-Type": "application/json", Accept: "application/json", "MCP-Protocol-Version": "2025-06-18" }, body }));
  const ping = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
  assert.equal((await send(ping.padEnd(65_536, " "))).status, 200);
  for (const [body, code] of [["{", -32700], ["[]", -32600], ['{"jsonrpc":"2.0","id":null,"method":"ping"}', -32600]]) assert.equal((await (await send(body)).json()).error.code, code);
  assert.equal((await send(" ".repeat(65_537))).status, 413);
  const value = await (await rpc(b, b.accessToken, "not-a-method")).json();
  assert.equal(value.error.code, -32601);
  assert.equal(errorCode(await tool(b, b.accessToken, "unknown")), "unknown_tool");
  assert.equal(errorCode(await tool(b, b.accessToken, "syncky_query", { type: "steps", note: secret() })), "invalid_params");
});

it("bounds query times/limits/filters, isolates selected types and preserves raw versus summary provenance", async (t) => {
  const b = await connected(t);
  assert.equal((await b.deliver({ samples: [sample(), sample({ type: "heart_rate" }), sample({ type: "future_type" })], summaries: [summary()] })).status, 200);
  const raw = await tool(b, b.accessToken, "syncky_query", { type: "steps" });
  assert.equal(raw.rows.length, 1);
  assert.equal(raw.provenance, "native_samples");
  assert.ok(raw.rows[0].sample.type === "steps", "only selected payload disclosed");
  const aggregates = await tool(b, b.accessToken, "syncky_query", { type: "steps", kind: "summaries" });
  assert.equal(aggregates.provenance, "native_summaries");
  assert.equal(aggregates.rows.length, 1);
  assert.ok(aggregates.rows[0].value === 0, "zero summary preserved separately");
  assert.equal(errorCode(await tool(b, b.accessToken, "syncky_query", { type: "heart_rate" })), "type_not_consented");
  for (const args of [{ limit: 0 }, { limit: 201 }, { limit: 1.5 }, { limit: null }, { since: null }, { until: null }, { kind: null }, { kind: "samples; DROP TABLE samples" }, { device: "' OR 1=1 --" }, { since: "not-time" }, { since: "2026-02-30T00:00:00Z" }, { since: "2026-10-15T00:00:00Z", until: "2026-10-14T00:00:00Z" }, { since: "2026-09-01T00:00:00Z", until: "2026-10-03T00:00:00Z" }]) assert.equal(errorCode(await tool(b, b.accessToken, "syncky_query", { type: "steps", ...args })), "invalid_params");
  assert.equal((await tool(b, b.accessToken, "syncky_query", { type: "steps", since: "2026-09-14T07:00:00Z", until: "2026-10-15T07:00:00Z", limit: 200 })).rows.length, 1);
  const client = await b.register();
  const tokens = await b.access(client, { scope: "read:future_type" });
  assert.equal((await tool(b, tokens.access_token, "syncky_query", { type: "future_type" })).rows.length, 1);
  assert.equal(b.sql.all("SELECT * FROM samples").length, 3);
});

it("defaults to seven days and 100 rows, permits 200 rows, and does not cross the time boundary", async (t) => {
  const b = await connected(t);
  const now = b.deps.now() * 1000;
  const before = new Date(now - 7 * 86400_000 - 1).toISOString();
  const boundary = new Date(now - 7 * 86400_000).toISOString();
  const later = new Date(now + 1).toISOString();
  await b.deliver({ samples: [sample({ start: before, end: before }), sample({ start: boundary, end: boundary }), sample({ start: later, end: later }), ...Array.from({ length: 200 }, () => sample())] });
  const first = await tool(b, b.accessToken, "syncky_query", { type: "steps" });
  assert.equal(first.rows.length, 100);
  assert.equal(first.has_more, true);
  const maximum = await tool(b, b.accessToken, "syncky_query", { type: "steps", limit: 200 });
  assert.equal(maximum.rows.length, 200);
  const last = await tool(b, b.accessToken, "syncky_query", { type: "steps", limit: 200, cursor: maximum.next_cursor });
  assert.equal(last.rows.length, 1);
  assert.equal(last.has_more, false);
});

it("uses opaque scoped keyset cursors across inserts, filter/client changes, tampering and new consent", async (t) => {
  const b = await connected(t);
  const samples = Array.from({ length: 5 }, () => sample());
  await b.deliver({ samples });
  const args = { type: "steps", limit: 2 };
  const first = await tool(b, b.accessToken, "syncky_query", args);
  assert.equal(first.rows.length, 2);
  assert.equal(first.has_more, true);
  assert.ok(typeof first.next_cursor === "string", "opaque next cursor provided");
  const visible = Buffer.from(first.next_cursor.split(".")[0], "base64url").toString("utf8");
  assert.ok(!visible.includes(b.client.client_id) && !visible.includes('"max"') && !visible.includes('"last"'), "cursor does not disclose internal row metadata");
  await b.deliver({ samples: [sample()] });
  const next = await tool(b, b.accessToken, "syncky_query", { ...args, cursor: first.next_cursor });
  const last = await tool(b, b.accessToken, "syncky_query", { ...args, cursor: next.next_cursor });
  assert.equal(last.has_more, false);
  assert.equal(last.next_cursor, null);
  assert.equal(new Set([...first.rows, ...next.rows, ...last.rows].map(r => r.sample.uuid)).size, 5);
  for (const extra of [{ device: device() }, { kind: "summaries" }, { limit: 3 }, { cursor: first.next_cursor + "x" }]) assert.equal(errorCode(await tool(b, b.accessToken, "syncky_query", { ...args, cursor: first.next_cursor, ...extra })), "invalid_cursor");
  const other = await b.access(await b.register());
  assert.equal(errorCode(await tool(b, other.access_token, "syncky_query", { ...args, cursor: first.next_cursor })), "invalid_cursor");
  const renewed = await b.access(b.client);
  assert.equal(errorCode(await tool(b, renewed.access_token, "syncky_query", { ...args, cursor: first.next_cursor })), "invalid_cursor");
});

it("status returns at most 50 scoped target metadata entries and does not reveal unselected availability", async (t) => {
  const scope = ["read:steps", ...Array.from({ length: 79 }, (_, n) => `read:future_${n}_${"x".repeat(45)}`)].join(" ");
  const b = await connected(t, { scope });
  const uploads = Array.from({ length: 51 }, () => native(b, { samples: [sample()] }));
  for (const upload of uploads) assert.equal((await b.send(upload)).status, 200);
  assert.equal((await b.send(native(b, { samples: [sample({ type: "heart_rate" })] }))).status, 200);
  const first = await tool(b, b.accessToken, "syncky_status");
  assert.equal(first.targets.length, 50);
  assert.equal(first.has_more, true);
  assert.ok(first.next_cursor.length <= 4096, "cursor stays bounded with many selected types");
  assert.ok(first.targets.every(v => v.available_types.join() === "steps" && !Object.hasOwn(v, "samples") && !Object.hasOwn(v, "count")), "scoped metadata only");
  const last = await tool(b, b.accessToken, "syncky_status", { cursor: first.next_cursor });
  assert.equal(last.targets.length, 1);
  assert.equal(last.has_more, false);
  assert.equal(errorCode(await tool(b, b.accessToken, "syncky_status", { limit: 51 })), "invalid_params");
  const other = await b.access(await b.register());
  assert.equal(errorCode(await tool(b, other.access_token, "syncky_status", { cursor: first.next_cursor })), "invalid_cursor");
  const time = b.deps.now(); b.deps.now = () => time + 10;
  await b.deliver({ samples: [sample()] });
  b.deps.now = () => time + 20;
  await b.deliver();
  const current = await tool(b, b.accessToken, "syncky_status", { limit: 50 });
  const second = await tool(b, b.accessToken, "syncky_status", { limit: 50, cursor: current.next_cursor });
  assert.equal([...current.targets, ...second.targets].find(v => v.device === b.device).last_accepted_upload, time + 20);
});

it("keeps whole multibyte rows within 1 MiB, paginates without loss and errors on one oversized row", async (t) => {
  const b = await connected(t);
  for (let n = 0; n < 3; n++) assert.equal((await b.deliver({ samples: [sample({ note: "😀".repeat(80_000) })] })).status, 200);
  let cursor, count = 0;
  do {
    const response = await rpc(b, b.accessToken, "tools/call", { name: "syncky_query", arguments: { type: "steps", ...(cursor ? { cursor } : {}) } });
    const text = await response.text();
    assert.ok(new TextEncoder().encode(text).length <= 1_048_576, "bounded response bytes");
    const data = JSON.parse(JSON.parse(text).result.content[0].text);
    assert.ok(data.rows.every(r => r.sample.note.length === 160_000), "whole series payload preserved");
    count += data.rows.length; cursor = data.next_cursor;
  } while (cursor);
  assert.equal(count, 3);
  const bigDevice = device();
  assert.equal((await b.deliver({ device: bigDevice, samples: [sample({ note: '"'.repeat(300_000) })] })).status, 200);
  assert.equal(errorCode(await tool(b, b.accessToken, "syncky_query", { type: "steps", device: bigDevice })), "row_too_large");
});

it("rate-limits authenticated MCP requests to 60 per grant per minute", async (t) => {
  const b = await connected(t);
  for (let n = 0; n < 60; n++) assert.equal((await rpc(b, b.accessToken, "ping")).status, 200);
  const denied = await rpc(b, b.accessToken, "ping");
  assert.equal(denied.status, 429);
  assert.equal((await denied.json()).code, "rate_limited");
  const other = await b.access(await b.register());
  assert.equal((await rpc(b, other.access_token, "ping")).status, 200);
  const now = b.deps.now(); b.deps.now = () => now + 60;
  assert.equal((await rpc(b, b.accessToken, "ping")).status, 200);
});
