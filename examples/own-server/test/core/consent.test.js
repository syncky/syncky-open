import { it } from "node:test";
import assert from "node:assert/strict";
import { browser, hidden, callback } from "../support/browser.js";
import { secret, databasePath } from "../support/helpers.js";
import { openSqlite } from "../../docker/sql.js";
import { createStore } from "../../src/store.js";

it("consent CSP permits only the selected validated callback origin through approve and deny redirects", async (t) => {
  const b = await browser(t);
  await b.login();
  const extra = "https://ai.example:8443/oauth/callback";
  assert.equal((await b.post("/admin/settings", { redirect_allowlist: callback + "\n" + extra })).status, 200);
  const client = await b.register({ redirect_uris: [callback, extra] });
  for (const redirect_uri of [callback, extra]) {
    for (const decision of ["approve", "deny"]) {
      const auth = await b.authorize(client, { redirect_uri }, false);
      assert.equal(auth.page.status, 200);
      assert.equal(auth.page.headers.get("content-security-policy"), `default-src 'none'; form-action 'self' ${new URL(redirect_uri).origin}; frame-ancestors 'none'; base-uri 'none'`);
      const response = await b.post("/oauth/authorize", { consent: hidden(auth.html, "consent"), decision, scope: "read:steps" });
      assert.equal(response.status, 303);
      const location = new URL(response.headers.get("location"));
      assert.equal(location.origin + location.pathname, redirect_uri);
      assert.equal(location.searchParams.get("state"), auth.params.state);
      assert.equal(location.searchParams.has("code"), decision === "approve");
      assert.equal(location.searchParams.has("error"), decision === "deny");
    }
  }
  for (const path of ["/admin", "/admin/login", "/admin/clients"]) assert.equal((await b.get(path)).headers.get("content-security-policy"), "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
});

it("screen names client types and purpose, escapes metadata, and requires explicit selection and approval", async (t) => {
  const b = await browser(t);
  await b.login();
  const client = await b.register({ client_name: '<img src=x onerror="alert(1)">' });
  const auth = await b.authorize(client, { scope: "read:steps read:heart_rate" }, false);
  for (const text of ["&lt;img", client.client_id, "claude.ai", "steps", "heart_rate", "answer your personal health and fitness questions", "training", "privacy"]) assert.ok(auth.html.includes(text), "consent disclosure present");
  assert.ok(!auth.html.includes("<img") && !auth.html.includes(" checked"));
  const state = hidden(auth.html, "consent");
  assert.equal((await b.post("/oauth/authorize", { consent: state, decision: "approve" })).status, 400);
  assert.equal((await b.post("/oauth/authorize", { consent: state, decision: "approve", scope: "read:body_mass" })).status, 400);
  const denied = await b.post("/oauth/authorize", { consent: state, decision: "deny" });
  assert.equal(denied.status, 303);
  assert.equal(new URL(denied.headers.get("location")).searchParams.get("error"), "access_denied");
  assert.equal(b.sql.all("SELECT * FROM auth_codes").length, 0);
  assert.equal((await b.post("/oauth/authorize", { consent: state, decision: "approve", scope: "read:steps" })).status, 400);
});

it("MCP without consent returns 403 consent_required for every method; clients and new types remain isolated", async (t) => {
  const b = await browser(t);
  await b.login();
  const a = await b.register(), other = await b.register();
  const tokens = await b.access(a);
  const second = await b.access(other, { scope: "read:heart_rate" });
  const grants = b.sql.all("SELECT * FROM grants ORDER BY rowid");
  assert.notEqual(grants[0].id, grants[1].id);
  b.sql.run("UPDATE grants SET consented = 0 WHERE id = ?", grants[0].id);
  for (const method of ["initialize", "notifications/initialized", "ping", "tools/list", "tools/call", "unknown"]) {
    const response = await b.mcp(tokens.access_token, method);
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, "consent_required");
    assert.equal((await b.mcp(undefined, method)).status, 401);
  }
  assert.notEqual((await b.mcp(second.access_token)).status, 403);
  b.sql.run("UPDATE oauth_tokens SET client_id = ? WHERE token_hash = (SELECT token_hash FROM oauth_tokens WHERE kind = 'access' AND client_id = ? LIMIT 1)", other.client_id, a.client_id);
  assert.equal((await b.mcp(tokens.access_token)).status, 401);
});

it("write consent needs current toggle and fresh explicit grant; consent state binds session and expires", async (t) => {
  const b = await browser(t);
  await b.login();
  const client = await b.register();
  assert.equal((await b.authorize(client, { scope: "read:steps write:dietary_water" }, false)).page.status, 400);
  assert.equal((await b.post("/admin/settings", { writes_enabled: "true" })).status, 200);
  const read = await b.access(client);
  assert.equal(JSON.parse(b.sql.all("SELECT write_types_json FROM grants")[0].write_types_json).length, 0);
  const auth = await b.authorize(client, { scope: "read:steps write:dietary_water" }, false);
  const consent = hidden(auth.html, "consent");
  assert.equal((await b.post("/oauth/authorize", { consent: consent + "x", decision: "approve", scope: "read:steps" })).status, 400);
  const oldCookie = b.cookie, oldCsrf = b.csrf;
  await b.login();
  assert.equal((await b.post("/oauth/authorize", { consent, decision: "approve", scope: "read:steps" })).status, 400);
  b.cookie = oldCookie;
  b.csrf = oldCsrf;
  const time = b.deps.now();
  b.deps.now = () => time + 301;
  assert.equal((await b.post("/oauth/authorize", { consent, decision: "approve", scope: "read:steps" })).status, 400);
  b.deps.now = () => time;
  const write = await b.access(client, { scope: "read:steps write:dietary_water" });
  assert.ok(write.access_token !== read.access_token);
  assert.ok(b.sql.all("SELECT * FROM grants").some(g => JSON.parse(g.write_types_json).includes("dietary_water")));
});

it("revocation stops access and refresh, invalidates codes and durably cancels unfinished grant commands", async (t) => {
  const path = databasePath(t), b = await browser(t, { path });
  await b.login();
  const client = await b.register(), other = await b.register();
  const tokens = await b.access(client), otherTokens = await b.access(other);
  const unused = await b.authorize(client);
  const grant = b.sql.all("SELECT * FROM grants WHERE client_id = ? ORDER BY rowid LIMIT 1", client.client_id)[0];
  b.sql.run("INSERT INTO commands(destination, command_id, version, device, client_id, grant_id, type, op, payload_json, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", secret(), "c", 1, secret(), client.client_id, grant.id, "dietary_water", "write", "{}", "pending", b.deps.now());
  const page = await b.get("/admin/clients");
  assert.ok((await page.text()).includes("Revoke"));
  assert.equal((await b.post(`/admin/clients/${client.client_id}/revoke`)).status, 200);
  assert.equal((await b.mcp(tokens.access_token)).status, 401);
  assert.equal((await b.token(client, unused.code, unused.verifier)).status, 400);
  assert.equal((await b.post("/oauth/token", { grant_type: "refresh_token", client_id: client.client_id, refresh_token: tokens.refresh_token, resource: "https://receiver.example/mcp" })).status, 400);
  assert.equal(b.sql.all("SELECT state FROM commands")[0].state, "cancelled");
  const reopened = openSqlite(path);
  t.after(() => reopened.close());
  b.deps.store = createStore(reopened);
  assert.equal((await b.mcp(tokens.access_token)).status, 401);
  assert.equal(reopened.all("SELECT state FROM commands")[0].state, "cancelled");
  assert.notEqual((await b.mcp(otherTokens.access_token)).status, 401);
  await b.access(client);
  assert.equal(b.sql.all("SELECT state FROM commands")[0].state, "cancelled");
});

it("narrowed consent replaces prior authorization without widening the new token scope", async (t) => {
  const b = await browser(t);
  await b.login();
  const client = await b.register();
  const old = await b.access(client, { scope: "read:steps read:heart_rate" });
  const pending = await b.authorize(client, { scope: "read:steps read:heart_rate" }, false);
  const approved = await b.post("/oauth/authorize", { consent: hidden(pending.html, "consent"), decision: "approve", scope: "read:steps" });
  assert.equal(approved.status, 303);
  const response = await b.token(client, new URL(approved.headers.get("location")).searchParams.get("code"), pending.verifier);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).scope, "read:steps");
  assert.equal((await b.mcp(old.access_token)).status, 401);
});

it("removing exact callbacks invalidates grants; consent cannot be replayed after policy changes", async (t) => {
  const b = await browser(t);
  await b.login();
  const client = await b.register();
  const tokens = await b.access(client);
  const auth = await b.authorize(client, {}, false);
  assert.equal((await b.post("/admin/settings", { redirect_allowlist: "https://chatgpt.com/connector_platform_oauth_redirect" })).status, 200);
  assert.equal((await b.mcp(tokens.access_token)).status, 401);
  assert.equal((await b.post("/oauth/authorize", { consent: hidden(auth.html, "consent"), decision: "approve", scope: "read:steps" })).status, 400);
  assert.equal((await b.post("/admin/settings", { redirect_allowlist: callback })).status, 200);
  assert.equal((await b.mcp(tokens.access_token)).status, 401);
  assert.equal((await b.post("/oauth/authorize", { consent: hidden(auth.html, "consent"), decision: "approve", scope: "read:steps" })).status, 400);
});
