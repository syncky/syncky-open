import { it } from "node:test";
import assert from "node:assert/strict";
import { browser, origin, hidden, cookie } from "../support/browser.js";
import { secret, native, sample } from "../support/helpers.js";

it("missing password fails closed; login and all mutations require origin and CSRF", async (t) => {
  const b = await browser(t);
  b.deps.adminPassword = undefined;
  assert.equal((await b.login()).response.status, 503);
  b.deps.adminPassword = b.password;
  assert.equal((await b.post("/admin/login", { password: b.password, csrf: "" })).status, 403);
  assert.equal((await b.post("/admin/login", { password: b.password }, { Origin: "https://attacker.example" })).status, 403);
  await b.login();
  for (const path of ["/admin/settings", "/admin/rotate-upload", "/admin/erase", "/admin/logout", "/admin/clients", "/admin/clients/unknown/revoke", "/admin/clients/unknown/remove", "/oauth/authorize"]) {
    assert.equal((await b.post(path, { csrf: "" })).status, 403);
    assert.equal((await b.post(path, {}, { Origin: "null" })).status, 403);
  }
  assert.equal((await b.get("/admin", { Cookie: "" })).status, 401);
  b.deps.adminPassword = undefined;
  assert.equal((await b.get("/admin")).status, 503);
  assert.equal((await b.get("/admin/clients")).status, 503);
  assert.equal((await b.get("/oauth/authorize")).status, 503);
});

it("sessions expire, logout invalidates them, cookies and pages have strict privacy headers", async (t) => {
  const b = await browser(t);
  const { response } = await b.login();
  assert.match(response.headers.get("set-cookie"), /Secure; HttpOnly; SameSite=Lax/);
  assert.match(response.headers.get("set-cookie"), /Max-Age=1800/);
  for (const path of ["/admin", "/admin/clients", "/admin/login"]) {
    const page = await b.get(path);
    assert.equal(page.headers.get("cache-control"), "no-store");
    assert.equal(page.headers.get("referrer-policy"), "no-referrer");
    assert.equal(page.headers.get("x-frame-options"), "DENY");
    assert.match(page.headers.get("content-security-policy"), /default-src 'none'/);
    assert.ok(!/<script|<img|<link[^>]+href="https?:/i.test(await page.text()));
  }
  const saved = b.cookie;
  assert.equal((await b.post("/admin/logout")).status, 200);
  b.cookie = saved;
  assert.equal((await b.get("/admin")).status, 401);
  await b.login();
  const time = b.deps.now();
  b.deps.now = () => time + 1800;
  assert.equal((await b.get("/admin")).status, 401);
});

it("freezes canonical origin, rejects Host/redirect/proxy attacks and bounds login attempts", async (t) => {
  const b = await browser(t);
  await b.login();
  for (const host of ["attacker.example", "receiver.example:444"]) assert.equal((await b.get("/admin", { Host: host })).status, 400);
  assert.equal((await b.send(new Request("https://attacker.example/admin", { headers: { Cookie: b.cookie } }))).status, 400);
  const discovery = await b.get("/.well-known/oauth-authorization-server", { "X-Forwarded-Host": "attacker.example", Forwarded: "host=attacker.example" });
  assert.equal((await discovery.json()).issuer, origin);
  const f = await browser(t);
  for (let n = 0; n < 10; n++) assert.equal((await f.login(secret())).response.status, 401);
  assert.equal((await f.login(secret())).response.status, 429);
  assert.equal((await f.login()).response.status, 200);
  assert.equal((await f.login(secret())).response.status, 429);
  const time = f.deps.now();
  f.deps.now = () => time + 60;
  assert.equal((await f.login(secret())).response.status, 401);
  assert.equal((await f.login()).response.status, 200);
  const foreign = await browser(t);
  foreign.deps.publicUrl = "https://fixed.example";
  assert.equal((await foreign.login()).response.status, 400);
});

it("login CSRF cookie is required and admin password changes fail closed", async (t) => {
  const b = await browser(t);
  const page = await b.get("/admin/login");
  b.csrf = hidden(await page.text(), "csrf");
  b.cookie = "";
  assert.equal((await b.post("/admin/login", { password: b.password })).status, 403);
  b.cookie = cookie(page);
  assert.equal((await b.post("/admin/login", { password: b.password })).status, 200);
  b.deps.adminPassword = secret();
  assert.equal((await b.login(b.password)).response.status, 401);
  assert.equal((await b.login(b.deps.adminPassword)).response.status, 401);
});

it("admin export is bounded and authenticated, erasure is explicit and rotates credentials", async (t) => {
  const b = await browser(t);
  const { link } = await b.login();
  const url = new URL(link);
  b.config.token = url.searchParams.get("token");
  b.config.hmac = url.searchParams.get("hmac");
  await b.send(native(b, { samples: [sample(), sample()] }));
  assert.equal((await b.get("/admin/export", { Cookie: "" })).status, 401);
  const first = await (await b.get("/admin/export?kind=samples&limit=1")).json();
  assert.equal(first.rows.length, 1);
  assert.ok(first.next_cursor);
  const second = await (await b.get("/admin/export?kind=samples&limit=1&cursor=" + encodeURIComponent(first.next_cursor))).json();
  assert.equal(second.rows.length, 1);
  assert.notEqual(first.rows[0].uuid, second.rows[0].uuid);
  assert.equal((await b.get("/admin/export?limit=201")).status, 400);
  assert.equal((await b.post("/admin/erase")).status, 400);
  assert.equal((await b.post("/admin/erase", { confirm: "erase" })).status, 200);
  assert.equal(b.sql.all("SELECT * FROM samples").length, 0);
  assert.equal((await b.send(native(b))).status, 401);
});
