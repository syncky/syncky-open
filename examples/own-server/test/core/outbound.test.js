import { it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fixture, native, sample, messageRequest } from "../support/helpers.js";
import { browser, origin, hidden } from "../support/browser.js";
import { connected, command, write, tool } from "../support/mcp.js";

it("shared runtime has no network clients, service hosts, timers or remote assets", () => {
  const dir = new URL("../../src/", import.meta.url);
  for (const file of readdirSync(dir).filter(n => n.endsWith(".js"))) {
    const source = readFileSync(new URL(file, dir), "utf8");
    assert.ok(!/\bfetch\s*\(|\bWebSocket\b|\bXMLHttpRequest\b|\bconnect\s*\(|\bset(?:Interval|Timeout)\s*\(|https?:\/\/|syncky\.app/.test(source), "no external runtime egress");
  }
});

it("runtime has no external egress through initialization, admin, registration, consent, OAuth or MCP", async (t) => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("network_denied"); });
  const b = await browser(t);
  const { link } = await b.login();
  const setup = new URL(link);
  b.config.token = setup.searchParams.get("token");
  b.config.hmac = setup.searchParams.get("hmac");
  assert.equal((await b.send(native(b, { samples: [sample()] }))).status, 200);
  const client = await b.register({ client_uri: "https://attacker.example/metadata", logo_uri: "https://attacker.example/logo" });
  const auth = await b.authorize(client, {}, false);
  for (const path of ["/admin", "/admin/clients", "/admin/login"]) {
    const response = await b.get(path), html = await response.text();
    assert.equal(response.status, 200);
    assert.ok(!/<(?:script|img|link|iframe)\b|(?:src|action)="https?:/i.test(html), "no remote assets");
  }
  assert.ok(!auth.html.includes("attacker.example"));
  const tokens = await b.access(client);
  const ping = await b.mcp(tokens.access_token);
  assert.equal(ping.status, 200);
  assert.deepEqual((await ping.json()).result, {});
  assert.equal((await b.post("/oauth/token", { grant_type: "password" })).status, 401);
  assert.equal((await b.post("/oauth/authorize", { consent: hidden(auth.html, "consent") + "invalid", decision: "approve", scope: "read:steps" })).status, 400);
  const malformed = await b.send(new Request(origin + "/oauth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"redirect_uris":[{}]}' }));
  assert.equal(malformed.status, 400);
  assert.equal((await b.post("/admin/clients/unknown/revoke")).status, 200);
});

it("ingest, probes, results and errors work with external network denied", async (t) => {
  const f = await fixture(t);
  t.mock.method(globalThis, "fetch", () => { throw new Error("network_denied"); });
  assert.equal((await f.send(native(f, { samples: [sample()] }))).status, 200);
  const m = await native(f).json();
  m.delivery.test = true;
  assert.equal((await f.send(native(f, m))).status, 200);
  const r = messageRequest(f, { v: 1, type: "results", results: [] }, { "X-Syncky-Kind": "results" });
  r.headers.delete("X-Syncky-Format");
  assert.equal((await f.send(r)).status, 200);
  const bad = native(f);
  bad.headers.delete("Authorization");
  assert.equal((await f.send(bad)).status, 401);
});

it("all MCP tools, queued replies, results, pause and revocation run without external egress", async (t) => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("network_denied"); });
  const b = await connected(t, { write: true });
  assert.equal((await b.deliver({ samples: [sample()] })).status, 200);
  assert.equal((await tool(b, b.accessToken, "syncky_status")).targets.length, 1);
  assert.equal((await tool(b, b.accessToken, "syncky_query", { type: "steps" })).rows.length, 1);
  const c = command(b);
  assert.equal((await write(b, c)).state, "queued");
  assert.equal((await (await b.deliver()).json()).commands.length, 1);
  assert.equal((await b.results([{ command_id: c.command_id, version: 1, status: "rejected", reason: "healthkit_denied" }])).status, 200);
  assert.equal((await write(b, c)).state, "rejected");
  assert.equal((await b.post("/admin/settings", { writes_enabled: "false" })).status, 200);
  assert.equal(await (await b.deliver()).text(), "");
  assert.equal((await b.post(`/admin/clients/${b.client.client_id}/revoke`)).status, 200);
  assert.equal((await b.mcp(b.accessToken)).status, 401);
});
