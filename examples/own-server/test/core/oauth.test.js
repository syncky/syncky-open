import { it } from "node:test";
import assert from "node:assert/strict";
import { browser, origin, callback, challenge, hidden } from "../support/browser.js";
import { secret, native, sample, summary } from "../support/helpers.js";

it("issuer and routes use only the deployment origin; discovery never reflects an untrusted host", async (t) => {
  const b = await browser(t);
  assert.equal((await b.get("/.well-known/oauth-authorization-server")).status, 503);
  await b.login();
  const metadata = await (await b.get("/.well-known/oauth-authorization-server")).json();
  assert.equal(metadata.issuer, origin);
  for (const field of ["authorization_endpoint", "token_endpoint", "registration_endpoint", "revocation_endpoint"]) assert.ok(metadata[field].startsWith(origin + "/oauth/"));
  assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);
  assert.deepEqual(metadata.grant_types_supported, ["authorization_code", "refresh_token"]);
  for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
    const resource = await (await b.get(path)).json();
    assert.equal(resource.resource, origin + "/mcp");
    assert.deepEqual(resource.authorization_servers, [origin]);
    assert.equal((await b.post(path)).status, 405);
  }
  assert.match((await b.mcp()).headers.get("www-authenticate"), /resource_metadata="https:\/\/receiver.example\//);
});

it("allowlisted DCR and manual confidential clients keep secrets hashed and enforce metadata bounds", async (t) => {
  const b = await browser(t);
  await b.login();
  const client = await b.register({ token_endpoint_auth_method: "client_secret_basic" }, true);
  assert.ok(client.client_secret && !JSON.stringify(b.sql.all("SELECT * FROM clients")).includes(client.client_secret), "client secret hashed");
  const auth = await b.authorize(client);
  assert.equal((await b.token(client, auth.code, auth.verifier)).status, 401);
  const basic = "Basic " + Buffer.from(client.client_id + ":" + client.client_secret).toString("base64");
  assert.equal((await b.token(client, auth.code, auth.verifier, {}, { Authorization: "Basic " + Buffer.from(client.client_id + ":" + secret()).toString("base64") })).status, 401);
  const response = await b.token(client, auth.code, auth.verifier, {}, { Authorization: basic });
  assert.equal(response.status, 200);
  for (const redirect of [callback + "/extra", callback + "#fragment", "http://claude.ai/api/mcp/auth_callback", "https://claude.ai.evil.example/api/mcp/auth_callback", "https://user:pass@claude.ai/api/mcp/auth_callback"]) {
    const r = await b.send(new Request(origin + "/oauth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "AI", redirect_uris: [redirect] }) }));
    assert.equal(r.status, 400);
  }
  assert.equal((await b.send(new Request(origin + "/oauth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: " ".repeat(16_385) }))).status, 413);
  assert.equal((await b.post("/admin/clients", { client_uri: "https://attacker.example/metadata" }, { Cookie: "" })).status, 401);
});

it("manual and dynamic registration have independent attempt limits", async (t) => {
  const b = await browser(t);
  await b.login();
  for (let n = 0; n < 10; n++) await b.register();
  const register = () => b.send(new Request(origin + "/oauth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "AI", redirect_uris: [callback] }) }));
  assert.equal((await register()).status, 429);
  for (let n = 0; n < 10; n++) await b.register({}, true);
  assert.equal((await b.post("/admin/clients", { client_name: "Another client", redirect_uri: callback, token_endpoint_auth_method: "none" })).status, 429);
  assert.equal((await register()).status, 429);
});

it("authorization rejects invalid redirects, plain/missing PKCE, resources and unsupported response types before redirect", async (t) => {
  const b = await browser(t);
  await b.login();
  const client = await b.register();
  for (const extra of [{ redirect_uri: callback + "/bad" }, { code_challenge_method: "plain" }, { code_challenge: "" }, { resource: "https://other.example/mcp" }, { response_type: "token" }, { scope: "all" }]) {
    const { page } = await b.authorize(client, extra, false);
    assert.equal(page.status, 400);
    assert.equal(page.headers.get("location"), null);
  }
  const params = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: callback, resource: origin + "/mcp", code_challenge_method: "S256", code_challenge: challenge(secret()), scope: "read:steps" });
  params.append("redirect_uri", callback);
  assert.equal((await b.get("/oauth/authorize?" + params)).status, 400);
});

it("codes bind client, redirect, resource and verifier; are single use; expire at sixty seconds", async (t) => {
  const b = await browser(t);
  await b.login();
  const a = await b.register(), other = await b.register();
  const auth = await b.authorize(a);
  for (const [client, verifier, extra] of [[other, auth.verifier, {}], [a, secret(), {}], [a, auth.verifier, { redirect_uri: callback + "/bad" }], [a, auth.verifier, { resource: origin + "/other" }]]) assert.equal((await b.token(client, auth.code, verifier, extra)).status, 400);
  assert.equal((await b.token(a, auth.code, auth.verifier)).status, 200);
  assert.equal((await b.token(a, auth.code, auth.verifier)).status, 400);
  const expired = await b.authorize(a);
  const time = b.deps.now();
  b.deps.now = () => time + 60;
  assert.equal((await b.token(a, expired.code, expired.verifier)).status, 400);
});

it("access expiry, refresh rotation, replay family revocation and client isolation are enforced", async (t) => {
  const b = await browser(t);
  await b.login();
  const a = await b.register(), other = await b.register();
  const tokens = await b.access(a);
  assert.equal(tokens.expires_in, 300);
  const stored = JSON.stringify(b.sql.all("SELECT * FROM oauth_tokens")) + JSON.stringify(b.sql.all("SELECT * FROM auth_codes"));
  for (const value of [tokens.access_token, tokens.refresh_token, tokens.auth.code]) assert.ok(!stored.includes(value), "opaque credentials hashed");
  assert.notEqual((await b.mcp(tokens.access_token)).status, 401);
  const time = b.deps.now();
  b.deps.now = () => time + 300;
  assert.equal((await b.mcp(tokens.access_token)).status, 401);
  const refresh = (client, token, extra = {}) => b.post("/oauth/token", { grant_type: "refresh_token", client_id: client.client_id, refresh_token: token, resource: origin + "/mcp", ...extra });
  assert.equal((await refresh(other, tokens.refresh_token)).status, 400);
  assert.equal((await refresh(a, tokens.refresh_token, { resource: "https://other.example/mcp" })).status, 400);
  const response = await refresh(a, tokens.refresh_token);
  assert.equal(response.status, 200);
  const next = await response.json();
  assert.ok(next.refresh_token !== tokens.refresh_token, "refresh rotates");
  assert.equal((await refresh(a, tokens.refresh_token)).status, 400);
  assert.equal((await b.mcp(next.access_token)).status, 401);
  assert.equal((await refresh(a, next.refresh_token)).status, 400);
  const fresh = await b.access(a);
  b.deps.now = () => time + 300 + 7 * 86400;
  assert.equal((await refresh(a, fresh.refresh_token)).status, 400);
});

it("refresh family absolute lifetime and RFC-style revocation do not disclose token existence", async (t) => {
  const b = await browser(t);
  await b.login();
  const a = await b.register(), other = await b.register();
  await b.access(other);
  let tokens = await b.access(a);
  const time = b.deps.now();
  for (let day = 6; day <= 24; day += 6) {
    b.deps.now = () => time + day * 86400;
    const response = await b.post("/oauth/token", { grant_type: "refresh_token", client_id: a.client_id, refresh_token: tokens.refresh_token, resource: origin + "/mcp" });
    assert.equal(response.status, 200);
    tokens = await response.json();
  }
  b.deps.now = () => time + 30 * 86400;
  assert.equal((await b.post("/oauth/token", { grant_type: "refresh_token", client_id: a.client_id, refresh_token: tokens.refresh_token, resource: origin + "/mcp" })).status, 400);
  b.deps.now = () => time;
  await b.login();
  tokens = await b.access(a);
  for (const [client, token] of [[other, tokens.refresh_token], [a, secret()], [a, tokens.refresh_token]]) {
    const response = await b.post("/oauth/revoke", { client_id: client.client_id, token });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "");
  }
  assert.equal((await b.mcp(tokens.access_token)).status, 401);
});

it("registration is limited per deployment and never accepts metadata-fetch or wildcard policy", async (t) => {
  const b = await browser(t);
  await b.login();
  for (let n = 0; n < 10; n++) await b.register();
  const register = () => b.send(new Request(origin + "/oauth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "AI", redirect_uris: [callback] }) }));
  assert.equal((await register()).status, 429);
  const time = b.deps.now();
  for (let hour = 1; hour <= 3; hour++) {
    b.deps.now = () => time + hour * 3600;
    for (let n = 0; n < (hour === 3 ? 2 : 10); n++) await b.register();
  }
  assert.equal((await register()).status, 429);
  await b.login();
  assert.equal((await b.post("/admin/settings", { redirect_allowlist: "https://*.example/callback" })).status, 400);
});

it("unused registrations expire after a day while consented registrations survive", async (t) => {
  const b = await browser(t);
  await b.login();
  const used = await b.register(), unused = await b.register({}, true);
  await b.access(used);
  const pending = await b.authorize(unused, {}, false);
  const time = b.deps.now();
  b.deps.now = () => time + 86400 - 1;
  await b.get("/.well-known/oauth-authorization-server");
  assert.equal(b.sql.all("SELECT * FROM clients").length, 2);
  b.deps.now = () => time + 86400;
  await b.login();
  assert.deepEqual(b.sql.all("SELECT id FROM clients").map(c => c.id), [used.client_id]);
  assert.equal((await b.post("/oauth/authorize", { consent: hidden(pending.html, "consent"), decision: "approve", scope: "read:steps" })).status, 400);
  assert.equal((await b.authorize(unused, {}, false)).page.status, 400);
  await b.access(used);
  await b.register({}, true);
});

it("admin can recover full registration capacity without erasing Health data", async (t) => {
  const b = await browser(t);
  const link = new URL((await b.login()).link);
  b.config.token = link.searchParams.get("token");
  b.config.hmac = link.searchParams.get("hmac");
  assert.equal((await b.send(native(b, { samples: [sample()], summaries: [summary()] }))).status, 200);
  const clients = [], time = b.deps.now();
  for (let hour = 0; hour < 4; hour++) {
    b.deps.now = () => time + hour * 3600;
    for (let n = 0; n < (hour === 3 ? 2 : 10); n++) clients.push(await b.register());
  }
  await b.login();
  const full = await b.send(new Request(origin + "/oauth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "AI", redirect_uris: [callback] }) }));
  assert.equal(full.status, 429);
  assert.equal((await full.json()).code, "client_limit");
  await b.register({}, true);
  const id = clients[0].client_id, path = `/admin/clients/${id}/remove`;
  const html = await (await b.get("/admin/clients")).text();
  assert.ok(html.includes(path), "unused clients have a recovery form");
  assert.equal((await b.get(path)).status, 405);
  assert.equal((await b.post(path, { confirm: "remove" }, { Cookie: "" })).status, 401);
  assert.equal((await b.post(path, { confirm: "remove", csrf: "" })).status, 403);
  assert.equal((await b.post(path, { confirm: "remove" }, { Origin: "https://attacker.example" })).status, 403);
  assert.equal((await b.post(path)).status, 400);
  assert.equal(b.sql.all("SELECT * FROM clients").length, 33);
  assert.equal((await b.post(path, { confirm: "remove" })).status, 200);
  assert.equal(b.sql.all("SELECT * FROM clients").length, 32);
  await b.register({}, true);
  assert.equal(b.sql.all("SELECT * FROM samples").length, 1);
  assert.equal(b.sql.all("SELECT * FROM summaries").length, 1);
  assert.equal((await b.send(native(b))).status, 200);
});

it("removing a consented client invalidates its codes, tokens and pending consent and cancels its commands", async (t) => {
  const b = await browser(t);
  await b.login();
  const client = await b.register(), other = await b.register();
  const tokens = await b.access(client), otherTokens = await b.access(other);
  const auth = await b.authorize(client), pending = await b.authorize(client, {}, false);
  const grant = b.sql.all("SELECT id FROM grants WHERE client_id = ? AND revoked_at IS NULL", client.client_id)[0];
  b.sql.run("INSERT INTO commands(destination, command_id, version, device, client_id, grant_id, type, op, payload_json, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", secret(), "queued", 1, secret(), client.client_id, grant.id, "dietary_water", "write", "{}", "pending", b.deps.now());
  b.sql.run("CREATE TRIGGER reject_removal BEFORE DELETE ON clients BEGIN SELECT RAISE(ABORT, 'storage_failure'); END");
  assert.equal((await b.post(`/admin/clients/${client.client_id}/remove`, { confirm: "remove" })).status, 500);
  assert.equal(b.sql.all("SELECT revoked_at FROM grants WHERE id = ?", grant.id)[0].revoked_at, null);
  assert.equal(b.sql.all("SELECT state FROM commands")[0].state, "pending");
  assert.equal(b.sql.all("SELECT * FROM consent_requests").length, 1);
  assert.equal(b.sql.all("SELECT * FROM auth_codes WHERE client_id = ?", client.client_id).length, 1);
  b.sql.run("DROP TRIGGER reject_removal");
  assert.equal((await b.post(`/admin/clients/${client.client_id}/remove`, { confirm: "remove" })).status, 200);
  assert.equal((await b.mcp(tokens.access_token)).status, 401);
  assert.equal((await b.token(client, auth.code, auth.verifier)).status, 401);
  assert.equal((await b.post("/oauth/token", { grant_type: "refresh_token", client_id: client.client_id, refresh_token: tokens.refresh_token, resource: origin + "/mcp" })).status, 401);
  assert.equal((await b.post("/oauth/authorize", { consent: hidden(pending.html, "consent"), decision: "approve", scope: "read:steps" })).status, 400);
  for (const table of ["clients", "grants", "auth_codes", "consumed_codes", "oauth_tokens"]) assert.equal(b.sql.all(`SELECT * FROM ${table} WHERE ${table === "clients" ? "id" : "client_id"} = ?`, client.client_id).length, 0);
  assert.equal(b.sql.all("SELECT * FROM consent_requests").length, 0);
  assert.equal(b.sql.all("SELECT state FROM commands")[0].state, "cancelled");
  assert.notEqual((await b.mcp(otherTokens.access_token)).status, 401);
});
