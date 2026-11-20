import { it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { browser, browserSession, origin, setup, setupParams } from "../support/browser.js";
import { databasePath, native, secret } from "../support/helpers.js";
import { openSqlite } from "../../docker/sql.js";
import { createStore } from "../../src/store.js";

it("first login generates distinct deployment-local credentials once; failed login stays closed", async (t) => {
  const b = await browser(t);
  assert.equal((await b.login(secret())).response.status, 401);
  assert.equal(b.store.credentials(), null);
  const { response, link } = await b.login();
  assert.equal(response.status, 200);
  assert.ok(link, "initial setup link shown");
  const url = new URL(link);
  assert.equal(url.origin, "https://syncky.app");
  assert.equal(url.pathname, "/connect");
  assert.equal(url.search, "");
  const params = setupParams(link), token = params.get("token"), hmac = params.get("hmac");
  assert.equal(params.get("format"), "native");
  assert.equal(params.get("url"), origin + "/server");
  assert.ok(/^[A-Za-z0-9_-]{43}$/.test(token), "upload token shape");
  assert.ok(/^whsec_[A-Za-z0-9_-]{43}$/.test(hmac), "HMAC secret shape");
  const keys = b.sql.all("SELECT value FROM crypto_secrets").map(r => r.value);
  assert.equal(new Set([token, hmac, b.password, ...keys]).size, keys.length + 2, "only HMAC appears both in link and usable key storage");
  const persisted = JSON.stringify(b.sql.all("SELECT * FROM settings"));
  assert.ok(!persisted.includes(token) && !persisted.includes(b.password), "verifiers only");
  assert.ok(!await (await b.get("/admin")).text().then(s => s.includes(token)), "refresh never discloses upload token");
  assert.equal((await b.login()).link, undefined);
  for (const value of [token, b.password, b.cookie.split("=")[1]]) assert.equal((await b.mcp(value)).status, 401);
  const client = await b.register(), tokens = await b.access(client);
  b.config.hmac = hmac;
  for (const value of [b.password, tokens.access_token, tokens.refresh_token, b.cookie.split("=")[1]]) {
    b.config.token = value;
    assert.equal((await b.send(native(b))).status, 401);
  }
  for (const value of [token, tokens.access_token]) assert.equal((await b.get("/admin", { Cookie: "", Authorization: `Bearer ${value}` })).status, 401);
});

it("bootstrap transaction failure leaves no partial credential set and can be retried", async (t) => {
  const b = await browser(t);
  b.sql.run("CREATE TRIGGER reject_bootstrap BEFORE INSERT ON crypto_secrets BEGIN SELECT RAISE(ABORT, 'storage_failure'); END");
  assert.equal((await b.login()).response.status, 500);
  assert.equal(b.store.credentials(), null);
  assert.equal(b.sql.all("SELECT * FROM crypto_secrets").length, 0);
  assert.equal(b.sql.all("SELECT * FROM admin_sessions").length, 0);
  b.sql.run("DROP TRIGGER reject_bootstrap");
  assert.ok((await b.login()).link);
});

it("restart preserves secrets; two deployments differ; concurrent initialization has one disclosure", async (t) => {
  const path = databasePath(t), b = await browser(t, { path });
  const otherBrowser = browserSession(b);
  const replies = await Promise.all([b.login(), otherBrowser.login()]);
  assert.deepEqual(replies.map(r => r.response.status), [200, 200]);
  assert.equal(replies.filter(r => r.link).length, 1);
  assert.notEqual(b.cookie, otherBrowser.cookie);
  assert.equal((await b.get("/admin")).status, 200);
  assert.equal((await otherBrowser.get("/admin")).status, 200);
  assert.deepEqual(b.sql.all("SELECT name FROM crypto_secrets ORDER BY name").map(r => r.name), ["hmac", "oauth", "session"]);
  const params = setupParams(replies.find(r => r.link).link);
  assert.ok(b.store.key("hmac") === params.get("hmac"), "stored HMAC differs from setup");
  assert.equal(b.sql.all("SELECT * FROM settings WHERE key = 'upload_credentials'").length, 1);
  b.config.token = params.get("token");
  b.config.hmac = params.get("hmac");
  assert.equal((await b.send(native(b))).status, 200);
  const original = JSON.stringify(b.sql.all("SELECT * FROM crypto_secrets ORDER BY name"));
  const secondSql = openSqlite(path);
  t.after(() => secondSql.close());
  b.deps.store = createStore(secondSql);
  assert.equal((await b.login()).link, undefined);
  assert.equal(JSON.stringify(secondSql.all("SELECT * FROM crypto_secrets ORDER BY name")), original);
  const other = await browser(t);
  const otherLink = (await other.login()).link;
  assert.ok(otherLink && !original.includes(setupParams(otherLink).get("hmac")));
});

it("rotation explicitly replaces upload credentials and respects auth and HMAC settings", async (t) => {
  const b = await browser(t);
  const first = setupParams((await b.login()).link);
  const settings = { auth_kind: "basic", auth_user: "phone", hmac_enabled: "false", writes_enabled: "false" };
  assert.equal((await b.post("/admin/settings", settings)).status, 200);
  const response = await b.post("/admin/rotate-upload", { confirm: "rotate" });
  const html = await response.text();
  const link = setup(html);
  assert.equal(new URL(link).origin, "https://syncky.app");
  const next = setupParams(link);
  assert.equal(next.get("auth"), "basic");
  assert.equal(next.get("user"), "phone");
  assert.equal(next.has("hmac"), false);
  b.config.auth = { kind: "bearer" };
  b.config.token = first.get("token");
  assert.equal((await b.send(native(b))).status, 401);
  b.config.auth = { kind: "basic", user: "phone" };
  b.config.token = next.get("token");
  assert.equal((await b.send(native(b))).status, 200);
  assert.equal((await b.post("/admin/settings", { auth_kind: "none" })).status, 400);
  assert.equal((await b.post("/admin/settings", { auth_kind: "header", header_name: "Authorization" })).status, 400);
});

it("rotates a saved custom label through the production site and refuses unsupported settings", async (t) => {
  const b = await browser(t);
  await b.login();
  const stored = { ...b.store.setting("upload_options"), scheme: "syncky-lab" };
  b.store.setSetting("upload_options", stored);
  const html = await (await b.get("/admin")).text();
  assert.doesNotMatch(html, /name="scheme"/);
  assert.ok(!html.includes(stored.scheme), "admin reflected a saved custom label");
  assert.equal((await b.post("/admin/settings", { hmac_enabled: "true" })).status, 200);
  const old = JSON.stringify(b.store.credentials());
  for (const scheme of [stored.scheme, "https://invalid.example/?token=do-not-print"]) {
    const response = await b.post("/admin/settings", { scheme, auth_kind: "basic", auth_user: "phone" });
    assert.equal(response.status, 400);
    const error = await response.text();
    assert.ok(error.includes("invalid_settings") && !error.includes(scheme), "unsafe settings error");
  }
  assert.deepEqual(b.store.setting("upload_options"), stored);
  assert.ok(JSON.stringify(b.store.credentials()) === old, "invalid settings changed credentials");
  const rotated = await b.post("/admin/rotate-upload", { confirm: "rotate" });
  assert.equal(rotated.status, 200);
  const link = setup(await rotated.text());
  const url = new URL(link);
  assert.equal(url.origin, "https://syncky.app");
  assert.equal(url.pathname, "/connect");
  assert.equal(url.search, "");
  const params = setupParams(link);
  assert.equal(params.get("auth"), "bearer");
  b.config.token = params.get("token");
  b.config.hmac = params.get("hmac");
  assert.equal((await b.send(native(b))).status, 200);
  assert.deepEqual(b.store.setting("upload_options"), stored);
});

it("source contains no deployment secrets", () => {
  for (const file of readdirSync(new URL("../../src/", import.meta.url)).filter(n => n.endsWith(".js"))) {
    const source = readFileSync(new URL(`../../src/${file}`, import.meta.url), "utf8");
    assert.ok(!/["'][A-Za-z0-9_-]{43,}["']|whsec_[A-Za-z0-9_-]{10,}/.test(source), "no embedded deployment credentials");
  }
});
