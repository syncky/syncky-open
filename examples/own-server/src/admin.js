import { random, digest, passwordHash, equal, mac, createUploadCredentials, buildLink, validAuth, base64url } from "./crypto.js";
import { fail, json, page, input, escaped, method, cookie, loginCookieName, cookieName, setCookie, sameOrigin, data, session, mutation, defaultRedirects, exactRedirect, adminConfigured } from "./security.js";
import { boundedRows } from "./pagination.js";

const form = (path, csrf, content) => `<form method="post" action="${escaped(path)}">${input("csrf", csrf)}${content}</form>`;
const defaultOptions = () => ({ auth: { kind: "bearer" }, hmac_enabled: true, scheme: "syncky" });
const checkbox = (name, label, enabled) => `<label>${escaped(label)}<select name="${escaped(name)}"><option value="${enabled}">${enabled ? "On" : "Off"}</option><option value="${!enabled}">${enabled ? "Off" : "On"}</option></select></label>`;

function adminPage(store, human, link, headers = {}) {
  const options = store.setting("upload_options");
  return page("Your server", `${input("csrf", human.csrf)}${link ? `<p>Save this private setup link now. It is shown once. Lost links require explicit upload credential rotation and phone re-import.</p><a href="${escaped(link)}">Open native setup link</a>` : ""}
    <p><a href="/admin/clients">Granted clients</a> · <a href="/admin/export">Export local records</a></p>
    ${form("/admin/settings", human.csrf, `<label>Upload authentication<select name="auth_kind">${["bearer", "basic", "header"].map(k => `<option${options.auth.kind === k ? " selected" : ""}>${k}</option>`).join("")}</select></label>
    <label>Basic username<input name="auth_user" value="${escaped(options.auth.user ?? "phone")}"></label>
    <label>Custom header<input name="header_name" value="${escaped(options.auth.header_name ?? "X-Upload-Key")}"></label>
    ${checkbox("hmac_enabled", "HMAC", options.hmac_enabled)}${checkbox("writes_enabled", "Allow newly consented writes", store.setting("writes_enabled"))}
    <label>App scheme<select name="scheme">${["syncky", "syncky-dev", "syncky-staging"].map(k => `<option${options.scheme === k ? " selected" : ""}>${k}</option>`).join("")}</select></label>
    <label>Exact HTTPS callbacks<textarea name="redirect_allowlist">${escaped(store.setting("redirect_allowlist").join("\n"))}</textarea></label><button>Save settings</button>`)}
    <p>Upload authentication and HMAC changes take effect on explicit rotation. Disabling writes pauses unfinished delivery, including retries. Re-enabling resumes only still-authorized grants. An already emitted reply cannot be recalled.</p>
    ${form("/admin/rotate-upload", human.csrf, `${input("confirm", "rotate")}<button>Rotate upload credentials and show link once</button>`)}
    ${form("/admin/erase", human.csrf, `<label>Type erase to delete local Health data and grants<input name="confirm"></label><button>Erase and rotate upload credentials</button>`)}
    <p>Erasure cannot remove AI-provider copies or operator backups. Full removal also requires deleting this deployment's storage and backups.</p>
    ${form("/admin/logout", human.csrf, "<button>Log out</button>")}`, headers);
}

async function uploadSet(options, origin) {
  const token = random(), hmac = options.hmac_enabled ? "whsec_" + random() : null;
  return {
    credentials: await createUploadCredentials({ auth: options.auth, token, hmac }), hmac,
    link: buildLink({ name: "Your server", url: origin + "/server", format: "native", auth: options.auth, signing: hmac !== null }, { token, header_value: token, hmac }, options.scheme),
  };
}

async function login(request, deps, origin) {
  const { store, adminPassword, now } = deps;
  if (request.method === "GET") {
    const csrf = random();
    return page("Admin login", form("/admin/login", csrf, '<label>Password<input type="password" name="password" autocomplete="current-password" required></label><button>Log in</button>'), { "Set-Cookie": setCookie(loginCookieName, csrf, 300) });
  }
  sameOrigin(request, origin);
  if (new URL(request.url).search) fail(400, "invalid_request");
  const body = await data(request);
  if (!equal(body.csrf, cookie(request, loginCookieName)) || !/^[A-Za-z0-9_-]{43}$/.test(body.csrf)) fail(403, "csrf_failed");
  const denied = () => {
    if (!store.rate("login", 10, 60, now())) fail(429, "rate_limited");
    fail(401, "unauthorized");
  };
  if (typeof body.password !== "string" || body.password.length > 1024 || !equal(await digest(body.password), await digest(adminPassword))) denied();
  const existing = store.setting("admin_verifier");
  const salt = existing?.salt ?? random();
  const verifier = await passwordHash(body.password, salt);
  if (existing && !equal(verifier, existing.hash)) denied();
  const options = defaultOptions();
  const prepared = existing ? null : await uploadSet(options, origin);
  const material = existing ? null : { oauth: random(), session: random() };
  const initialized = store.sql.transaction(() => {
    const current = store.setting("admin_verifier");
    if (current) return false;
    if (store.credentials()) fail(503, "not_initialized");
    store.setSetting("admin_verifier", { salt, hash: verifier });
    store.setSetting("origin", origin);
    store.setSetting("upload_options", options);
    store.setSetting("upload_credentials", prepared.credentials);
    store.setSetting("redirect_allowlist", defaultRedirects());
    store.setSetting("writes_enabled", false);
    for (const [name, value] of Object.entries({ ...material, hmac: prepared.hmac })) store.sql.run("INSERT INTO crypto_secrets(name, value) VALUES (?, ?)", name, value);
    return true;
  });
  if (!initialized && !equal(await passwordHash(body.password, store.setting("admin_verifier").salt), store.setting("admin_verifier").hash)) denied();
  const token = random(), csrf = await mac(store.key("session"), token);
  const sessionHash = await digest(token), csrfHash = await digest(csrf);
  store.sql.transaction(() => {
    store.sql.run("DELETE FROM admin_sessions WHERE session_hash IN (SELECT session_hash FROM admin_sessions ORDER BY expires_at DESC LIMIT -1 OFFSET 31)");
    store.sql.run("INSERT INTO admin_sessions(session_hash, csrf_hash, expires_at) VALUES (?, ?, ?)", sessionHash, csrfHash, now() + 1800);
  });
  return adminPage(store, { csrf }, initialized ? prepared.link : null, { "Set-Cookie": setCookie(cookieName, token, 1800) });
}

function boolean(value) {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  fail(400, "invalid_settings");
}

function settings(store, body, now) {
  const options = structuredClone(store.setting("upload_options"));
  if (Object.hasOwn(body, "auth_kind")) {
    options.auth = { kind: body.auth_kind };
    if (body.auth_kind === "basic") options.auth.user = body.auth_user;
    if (body.auth_kind === "header") options.auth.header_name = body.header_name;
    if (!validAuth(options.auth)) fail(400, "invalid_settings");
  }
  if (Object.hasOwn(body, "hmac_enabled")) options.hmac_enabled = boolean(body.hmac_enabled);
  if (Object.hasOwn(body, "scheme")) {
    if (!["syncky", "syncky-dev", "syncky-staging"].includes(body.scheme)) fail(400, "invalid_settings");
    options.scheme = body.scheme;
  }
  let redirects = store.setting("redirect_allowlist");
  if (Object.hasOwn(body, "redirect_allowlist")) {
    if (typeof body.redirect_allowlist !== "string" || body.redirect_allowlist.length > 12_000) fail(400, "invalid_settings");
    redirects = [...new Set(body.redirect_allowlist.split(/\s+/).filter(Boolean).map(exactRedirect))];
    if (redirects.length > 32) fail(400, "invalid_settings");
  }
  const writes = Object.hasOwn(body, "writes_enabled") ? boolean(body.writes_enabled) : store.setting("writes_enabled");
  store.sql.transaction(() => {
    store.setSetting("upload_options", options);
    store.setSetting("writes_enabled", writes);
    store.setSetting("redirect_allowlist", redirects);
    for (const grant of store.sql.all("SELECT id, redirect_uri FROM grants WHERE revoked_at IS NULL")) if (!redirects.includes(grant.redirect_uri)) store.revokeGrant(grant.id, now);
    for (const pending of store.sql.all("SELECT state_hash, request_json FROM consent_requests")) if (!redirects.includes(JSON.parse(pending.request_json).redirect_uri)) store.sql.run("DELETE FROM consent_requests WHERE state_hash = ?", pending.state_hash);
  });
}

async function rotate(store, origin, erase) {
  const options = store.setting("upload_options"), prepared = await uploadSet(options, origin);
  store.sql.transaction(() => {
    if (JSON.stringify(store.setting("upload_options")) !== JSON.stringify(options)) fail(409, "settings_changed");
    if (erase) {
      for (const table of ["samples", "summaries", "results", "commands", "upload_targets", "auth_codes", "consumed_codes", "oauth_tokens", "consent_requests", "grants"]) store.sql.run(`DELETE FROM ${table}`);
      store.setSetting("writes_enabled", false);
    }
    store.setSetting("upload_credentials", prepared.credentials);
    if (prepared.hmac === null) store.sql.run("DELETE FROM crypto_secrets WHERE name = ?", "hmac");
    else store.sql.run("INSERT INTO crypto_secrets(name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value", "hmac", prepared.hmac);
  });
  return prepared.link;
}

async function exportPage(request, store, human) {
  const params = new URL(request.url).searchParams;
  const kind = params.get("kind") ?? "samples", limit = Number(params.get("limit") ?? 100);
  if (!["samples", "summaries", "results"].includes(kind) || !Number.isInteger(limit) || limit < 1 || limit > 200) fail(400, "invalid_export");
  let last = 0;
  const cursor = params.get("cursor");
  if (cursor) {
    if (cursor.length > 1024) fail(400, "invalid_cursor");
    const [payload, signature, extra] = cursor.split(".");
    if (extra || !equal(signature, await mac(store.key("session"), payload ?? ""))) fail(400, "invalid_cursor");
    let value;
    try { value = JSON.parse(atob(payload.replaceAll("-", "+").replaceAll("_", "/"))); } catch { fail(400, "invalid_cursor"); }
    if (value.kind !== kind || value.session !== human.session_hash || !Number.isSafeInteger(value.last) || value.last < 0) fail(400, "invalid_cursor");
    last = value.last;
  }
  const selected = boundedRows(after => store.sql.all(`SELECT rowid AS page_id, * FROM ${kind} WHERE rowid > ? ORDER BY rowid LIMIT 1`, after)[0], last, limit);
  const rows = selected.rows.map(({ page_id, ...row }) => ({ export_id: page_id, ...row }));
  let next = null;
  if (selected.more) {
    const payload = base64url(new TextEncoder().encode(JSON.stringify({ kind, session: human.session_hash, last: rows.at(-1).export_id })));
    next = payload + "." + await mac(store.key("session"), payload);
  }
  return json(200, { rows, next_cursor: next });
}

export async function admin(request, deps, origin) {
  const { store, now } = deps, path = new URL(request.url).pathname;
  adminConfigured(deps.adminPassword);
  if (path === "/admin/login") return method(request, ["GET", "POST"]) ?? login(request, deps, origin);
  const allowed = path === "/admin" || path === "/admin/export" ? ["GET"] : path === "/admin/clients" ? ["GET", "POST"] : ["POST"];
  const wrong = method(request, allowed);
  if (wrong) return wrong;
  if (!store.setting("admin_verifier")) fail(503, "not_initialized");
  if (request.method === "GET") {
    const human = await session(request, store, now());
    if (path === "/admin") return adminPage(store, human);
    if (path === "/admin/export") return exportPage(request, store, human);
    return null;
  }
  if (path === "/admin/clients" || /^\/admin\/clients\/[^/]+\/(revoke|remove)$/.test(path)) return null;
  const { body, human } = await mutation(request, store, now(), origin);
  if (path === "/admin/logout") {
    store.sql.run("DELETE FROM admin_sessions WHERE session_hash = ?", human.session_hash);
    return page("Logged out", "", { "Set-Cookie": setCookie(cookieName, "", 0) });
  }
  if (path === "/admin/settings") { settings(store, body, now()); return adminPage(store, human); }
  if (path === "/admin/rotate-upload" || path === "/admin/erase") {
    const erase = path === "/admin/erase";
    if (body.confirm !== (erase ? "erase" : "rotate")) fail(400, "confirmation_required");
    return adminPage(store, human, await rotate(store, origin, erase));
  }
  fail(404, "not_found");
}
