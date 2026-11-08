import { random, digest, equal, pkceChallenge } from "./crypto.js";
import { fail, json, method, data, exactRedirect, redirectAllowed, activeGrant, mutation, session, page, escaped, input } from "./security.js";

export const resourcePath = "/.well-known/oauth-protected-resource/mcp";
const oauthError = (status, code) => json(status, { error: code });

export async function registerClient(body, store, now, manual = false) {
  const name = body.client_name, redirects = body.redirect_uris, auth = body.token_endpoint_auth_method ?? "none";
  if (typeof name !== "string" || !name.trim() || name.length > 128 || /[\x00-\x1f\x7f]/.test(name) || !Array.isArray(redirects) || redirects.length < 1 || redirects.length > 8 || !["none", "client_secret_basic"].includes(auth)) fail(400, "invalid_client_metadata");
  if (body.grant_types !== undefined && (!Array.isArray(body.grant_types) || body.grant_types.some(g => !["authorization_code", "refresh_token"].includes(g)))) fail(400, "invalid_client_metadata");
  if (body.response_types !== undefined && (!Array.isArray(body.response_types) || body.response_types.length !== 1 || body.response_types[0] !== "code")) fail(400, "invalid_client_metadata");
  const exact = [...new Set(redirects.map(exactRedirect))];
  const id = random(), secret = auth === "client_secret_basic" ? random() : null;
  const hash = secret ? await digest(secret) : null;
  store.sql.transaction(() => {
    if (exact.some(uri => !redirectAllowed(store, uri))) fail(400, "invalid_redirect_uri");
    if (store.sql.all("SELECT COUNT(*) AS n FROM clients")[0].n >= (manual ? 40 : 32)) fail(429, "client_limit");
    store.sql.run("INSERT INTO clients(id, name, redirects_json, auth_method, secret_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)", id, name, JSON.stringify(exact), auth, hash, now);
  });
  return json(201, { client_id: id, client_name: name, redirect_uris: exact, token_endpoint_auth_method: auth, grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}) });
}

async function clientAuth(request, body, store) {
  let id = body.client_id, secret;
  const authorization = request.headers.get("authorization");
  if (authorization !== null) {
    if (!/^Basic [A-Za-z0-9+/]+={0,2}$/.test(authorization)) fail(401, "invalid_client");
    let decoded;
    try { decoded = atob(authorization.slice(6)); } catch { fail(401, "invalid_client"); }
    const colon = decoded.indexOf(":");
    if (colon < 1) fail(401, "invalid_client");
    let basicId;
    try { basicId = decodeURIComponent(decoded.slice(0, colon)); secret = decodeURIComponent(decoded.slice(colon + 1)); } catch { fail(401, "invalid_client"); }
    if (id !== undefined && id !== basicId) fail(401, "invalid_client");
    id = basicId;
  }
  if (typeof id !== "string" || id.length > 128 || body.client_secret !== undefined) fail(401, "invalid_client");
  const client = store.sql.all("SELECT * FROM clients WHERE id = ?", id)[0];
  if (!client || client.auth_method === "none" && authorization !== null || client.auth_method === "client_secret_basic" && (secret === undefined || !equal(await digest(secret), client.secret_hash))) fail(401, "invalid_client");
  return client;
}

async function newTokens() {
  const access = random(), refresh = random();
  return { access, refresh, accessHash: await digest(access), refreshHash: await digest(refresh) };
}

function persistTokens(store, tokens, binding, now) {
  for (const [kind, hash, expires] of [["access", tokens.accessHash, now + 300], ["refresh", tokens.refreshHash, Math.min(now + 7 * 86400, binding.family_expires_at)]]) {
    store.sql.run("INSERT INTO oauth_tokens(token_hash, kind, client_id, redirect_uri, resource, issuer, grant_id, family, family_expires_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      hash, kind, binding.client_id, binding.redirect_uri, binding.resource, binding.issuer, binding.grant_id, binding.family, binding.family_expires_at, expires);
  }
  const grant = activeGrant(store, binding.grant_id, binding.client_id);
  return [...JSON.parse(grant.read_types_json).map(t => "read:" + t), ...JSON.parse(grant.write_types_json).map(t => "write:" + t)].join(" ");
}

function validBinding(store, row, client, origin) {
  const grant = activeGrant(store, row.grant_id, client.id);
  return row.client_id === client.id && row.issuer === origin && row.resource === origin + "/mcp" && JSON.parse(client.redirects_json).includes(row.redirect_uri) && grant?.consented === 1 && grant.redirect_uri === row.redirect_uri;
}

async function token(request, store, now, origin) {
  const body = await data(request);
  const client = await clientAuth(request, body, store);
  if (body.resource !== origin + "/mcp") return oauthError(400, "invalid_target");
  const tokens = await newTokens();
  let granted = false, scope;
  if (body.grant_type === "authorization_code") {
    if (typeof body.code !== "string" || body.code.length > 128 || typeof body.code_verifier !== "string" || !/^[A-Za-z0-9._~-]{43,128}$/.test(body.code_verifier)) return oauthError(400, "invalid_grant");
    const hash = await digest(body.code), challenge = await pkceChallenge(body.code_verifier);
    granted = store.sql.transaction(() => {
      const row = store.sql.all("SELECT * FROM auth_codes WHERE code_hash = ?", hash)[0];
      if (!row) {
        const used = store.sql.all("SELECT * FROM consumed_codes WHERE code_hash = ?", hash)[0];
        if (used && used.expires_at > now && used.client_id === client.id && used.redirect_uri === body.redirect_uri && used.resource === body.resource && used.issuer === origin && equal(used.challenge, challenge)) store.sql.run("UPDATE oauth_tokens SET revoked = 1 WHERE family = ?", used.family);
        return false;
      }
      if (row.expires_at <= now || row.redirect_uri !== body.redirect_uri || !equal(row.challenge, challenge) || !validBinding(store, row, client, origin)) return false;
      const family = random();
      store.sql.run("INSERT INTO consumed_codes(code_hash, client_id, redirect_uri, resource, issuer, challenge, family, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", hash, row.client_id, row.redirect_uri, row.resource, row.issuer, row.challenge, family, now + 300);
      store.sql.run("DELETE FROM auth_codes WHERE code_hash = ?", hash);
      scope = persistTokens(store, tokens, { ...row, family, family_expires_at: now + 30 * 86400 }, now);
      return true;
    });
  } else if (body.grant_type === "refresh_token") {
    if (typeof body.refresh_token !== "string" || body.refresh_token.length > 128) return oauthError(400, "invalid_grant");
    const hash = await digest(body.refresh_token);
    granted = store.sql.transaction(() => {
      const row = store.sql.all("SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh'", hash)[0];
      if (!row || row.client_id !== client.id) return false;
      if (row.used) { store.sql.run("UPDATE oauth_tokens SET revoked = 1 WHERE family = ?", row.family); return false; }
      if (row.revoked || row.expires_at <= now || row.family_expires_at <= now || !validBinding(store, row, client, origin)) return false;
      store.sql.run("UPDATE oauth_tokens SET used = 1 WHERE token_hash = ?", hash);
      scope = persistTokens(store, tokens, row, now);
      return true;
    });
  } else return oauthError(400, "unsupported_grant_type");
  if (!granted) return oauthError(400, "invalid_grant");
  return json(200, { access_token: tokens.access, refresh_token: tokens.refresh, token_type: "Bearer", expires_in: 300, scope });
}

async function revoke(request, store) {
  const body = await data(request), client = await clientAuth(request, body, store);
  if (typeof body.token !== "string" || body.token.length > 128) fail(400, "invalid_request");
  const hash = await digest(body.token);
  store.sql.transaction(() => {
    const row = store.sql.all("SELECT family FROM oauth_tokens WHERE token_hash = ? AND client_id = ?", hash, client.id)[0];
    if (row) store.sql.run("UPDATE oauth_tokens SET revoked = 1 WHERE family = ?", row.family);
  });
  return new Response(null, { headers: { "Cache-Control": "no-store" } });
}

export async function authorizeMcp(request, store, now, origin) {
  const value = request.headers.get("authorization");
  const denied = () => json(401, { ok: false, code: "unauthorized" }, { "WWW-Authenticate": `Bearer resource_metadata="${origin + resourcePath}"` });
  if (!value || !/^Bearer [A-Za-z0-9_-]{43}$/.test(value)) return { response: denied() };
  const token = store.sql.all("SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = 'access'", await digest(value.slice(7)))[0];
  if (!token || token.revoked || token.used || token.expires_at <= now || token.family_expires_at <= now || token.issuer !== origin || token.resource !== origin + "/mcp") return { response: denied() };
  const grant = activeGrant(store, token.grant_id, token.client_id), client = store.sql.all("SELECT * FROM clients WHERE id = ?", token.client_id)[0];
  if (!grant || !client || grant.redirect_uri !== token.redirect_uri || !JSON.parse(client.redirects_json).includes(token.redirect_uri)) return { response: denied() };
  if (!grant.consented) return { response: json(403, { ok: false, code: "consent_required" }) };
  const sentOrigin = request.headers.get("origin");
  const origins = [origin, ...JSON.parse(client.redirects_json).filter(uri => redirectAllowed(store, uri)).map(uri => new URL(uri).origin)];
  if (sentOrigin !== null && !origins.includes(sentOrigin)) return { response: json(403, { ok: false, code: "invalid_origin" }) };
  return { grant, client, token };
}

async function clients(request, deps, origin) {
  const { store, now } = deps, path = new URL(request.url).pathname;
  const wrong = method(request, path === "/admin/clients" ? ["GET", "POST"] : ["POST"]);
  if (wrong) return wrong;
  if (request.method === "GET") {
    const human = await session(request, store, now());
    const registrations = store.sql.all("SELECT * FROM clients ORDER BY created_at DESC").map(c => `<section><h2>${escaped(c.name)}</h2><p>${escaped(c.id)}</p><form method="post" action="/admin/clients/${escaped(c.id)}/remove">${input("csrf", human.csrf)}${input("confirm", "remove")}<button>Remove registration and revoke access</button></form></section>`).join("");
    const entries = store.sql.all("SELECT * FROM grants ORDER BY created_at DESC");
    const content = entries.map(g => {
      const client = store.sql.all("SELECT name FROM clients WHERE id = ?", g.client_id)[0];
      return `<section><h2>${escaped(client?.name ?? g.client_id)}</h2><p>${escaped(g.client_id)} · ${escaped(new URL(g.redirect_uri).host)}</p><p>Read: ${escaped(JSON.parse(g.read_types_json).join(", "))}; write: ${escaped(JSON.parse(g.write_types_json).join(", "))}</p><p>${escaped(g.purpose)}</p><p>${g.revoked_at === null ? "Active" : "Revoked"}</p><form method="post" action="/admin/clients/${escaped(g.id)}/revoke">${input("csrf", human.csrf)}<button>Revoke</button></form></section>`;
    }).join("");
    return page("Granted clients", `${content}<p>Revocation stops future disclosure and delivery, including retries. It cannot recall an emitted reply or erase AI-provider copies.</p><h2>Registered clients</h2>${registrations}<p>Unused registrations expire after 24 hours. Dynamic registration admits clients only below 32 registrations; eight further slots are reserved for manual clients. Manual registration has an independent attempt limit. Removal revokes access and frees capacity without erasing Health data. Reconnect a removed client by registering it again.</p><form method="post" action="/admin/clients">${input("csrf", human.csrf)}<label>Client name<input name="client_name" required></label><label>Exact allowed callback<input name="redirect_uri" required></label><label>Authentication<select name="token_endpoint_auth_method"><option>none</option><option>client_secret_basic</option></select></label><button>Create manual client</button></form><a href="/admin">Admin</a>`);
  }
  const { body } = await mutation(request, store, now(), origin);
  if (path === "/admin/clients") {
    if (!store.rate("manual_registration", 10, 3600, now())) fail(429, "rate_limited");
    return registerClient({ ...body, redirect_uris: body.redirect_uris ?? [body.redirect_uri] }, store, now(), true);
  }
  const id = path.split("/")[3];
  if (path.endsWith("/remove")) {
    if (body.confirm !== "remove") fail(400, "confirmation_required");
    store.sql.transaction(() => {
      for (const grant of store.sql.all("SELECT id FROM grants WHERE client_id = ?", id)) store.revokeGrant(grant.id, now());
      for (const table of ["auth_codes", "consumed_codes", "oauth_tokens", "grants"]) store.sql.run(`DELETE FROM ${table} WHERE client_id = ?`, id);
      store.sql.run("DELETE FROM consent_requests WHERE json_extract(request_json, '$.client_id') = ?", id);
      store.sql.run("DELETE FROM clients WHERE id = ?", id);
    });
    return json(200, { ok: true });
  }
  store.sql.transaction(() => {
    for (const grant of store.sql.all("SELECT id FROM grants WHERE id = ? OR client_id = ?", id, id)) store.revokeGrant(grant.id, now());
  });
  return json(200, { ok: true });
}

export async function oauth(request, deps, origin) {
  const { store, now } = deps, path = new URL(request.url).pathname;
  if (path.startsWith("/admin/clients")) return clients(request, deps, origin);
  if (!store.setting("origin")) fail(503, "not_initialized");
  if (path.startsWith("/.well-known/")) {
    const wrong = method(request, ["GET"]);
    if (wrong) return wrong;
    if (["/.well-known/oauth-protected-resource", resourcePath].includes(path)) return json(200, { resource: origin + "/mcp", authorization_servers: [origin], bearer_methods_supported: ["header"] });
    if (path === "/.well-known/oauth-authorization-server") return json(200, {
      issuer: origin, authorization_endpoint: origin + "/oauth/authorize", token_endpoint: origin + "/oauth/token", registration_endpoint: origin + "/oauth/register", revocation_endpoint: origin + "/oauth/revoke",
      response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], token_endpoint_auth_methods_supported: ["none", "client_secret_basic"], code_challenge_methods_supported: ["S256"],
    });
    fail(404, "not_found");
  }
  const wrong = method(request, ["POST"]);
  if (wrong) return wrong;
  if (path === "/oauth/register") {
    if (!store.rate("registration", 10, 3600, now())) fail(429, "rate_limited");
    return registerClient(await data(request), store, now());
  }
  if (path === "/oauth/token") return token(request, store, now(), origin);
  if (path === "/oauth/revoke") return revoke(request, store);
  fail(404, "not_found");
}
