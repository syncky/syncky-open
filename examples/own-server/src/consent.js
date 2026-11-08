import catalog from "./write-catalog.json" with { type: "json" };
import { random, digest, mac, equal } from "./crypto.js";
import { fail, page, pagePolicy, escaped, input, method, parameters, session, mutation, redirectAllowed, adminConfigured } from "./security.js";

export const purpose = "answer your personal health and fitness questions";

function scopes(value, store) {
  if (typeof value !== "string" || value.length > 8192) fail(400, "invalid_scope");
  const list = [...new Set(value.trim().split(/\s+/))];
  if (list.length < 1 || list.length > 128 || list.some(v => !/^(read|write):[a-z][a-z0-9_]{1,63}$/.test(v))) fail(400, "invalid_scope");
  if (list.some(v => v.startsWith("write:") && (!store.setting("writes_enabled") || !Object.hasOwn(catalog.types, v.slice(6))))) fail(400, "invalid_scope");
  return list;
}

function validated(params, store, origin) {
  const client = typeof params.client_id === "string" && store.sql.all("SELECT * FROM clients WHERE id = ?", params.client_id)[0];
  if (!client || !JSON.parse(client.redirects_json).includes(params.redirect_uri) || !redirectAllowed(store, params.redirect_uri)) fail(400, "invalid_redirect_uri");
  if (params.response_type !== "code") fail(400, "unsupported_response_type");
  if (params.resource !== origin + "/mcp") fail(400, "invalid_target");
  if (params.code_challenge_method !== "S256" || typeof params.code_challenge !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(params.code_challenge)) fail(400, "invalid_request");
  if (params.state !== undefined && (typeof params.state !== "string" || params.state.length > 1024)) fail(400, "invalid_request");
  const selected = scopes(params.scope, store);
  return { client, selected };
}

const redirect = (params, response) => {
  const url = new URL(params.redirect_uri);
  for (const key of ["code", "error", "state"]) url.searchParams.delete(key);
  for (const [key, value] of Object.entries(response)) url.searchParams.set(key, value);
  if (params.state !== undefined) url.searchParams.set("state", params.state);
  return new Response(null, { status: 303, headers: { Location: url.href, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
};

export async function consent(request, deps, origin) {
  adminConfigured(deps.adminPassword);
  const wrong = method(request, ["GET", "POST"]);
  if (wrong) return wrong;
  const { store, now } = deps;
  if (!store.setting("origin")) fail(503, "not_initialized");
  if (request.method === "GET") {
    if (new URL(request.url).search.length > 12_000) fail(400, "invalid_request");
    const params = parameters(new URL(request.url).searchParams);
    const { client, selected } = validated(params, store, origin);
    let human;
    try { human = await session(request, store, now()); } catch (error) {
      if (error.status !== 401) throw error;
      return page("Admin login required", '<p>Log in to your server, then return to this authorization request.</p><a href="/admin/login" target="_blank" rel="noreferrer">Admin login</a>');
    }
    const nonce = random(), state = nonce + "." + await mac(store.key("oauth"), nonce);
    const stateHash = await digest(state);
    store.sql.transaction(() => {
      store.sql.run("DELETE FROM consent_requests WHERE state_hash IN (SELECT state_hash FROM consent_requests WHERE session_hash = ? ORDER BY expires_at DESC, rowid DESC LIMIT -1 OFFSET 31)", human.session_hash);
      store.sql.run("INSERT INTO consent_requests(state_hash, session_hash, request_json, expires_at) VALUES (?, ?, ?, ?)", stateHash, human.session_hash, JSON.stringify(params), now() + 300);
    });
    return page("Share selected Health types", `<p>Client: ${escaped(client.name)}</p><p>Client ID: ${escaped(client.id)}</p><p>Callback host: ${escaped(new URL(params.redirect_uri).host)}</p><p>Client metadata is supplied by the client and does not verify its identity.</p>
      <p>Purpose: ${purpose}</p><p>Review this AI provider's training and privacy settings in its account settings or official help before sharing. Revocation stops future access; it cannot erase copies already disclosed to the provider.</p>
      <form method="post" action="/oauth/authorize">${input("csrf", human.csrf)}${input("consent", state)}${selected.map(s => `<label><input type="checkbox" name="scope" value="${escaped(s)}">${s.startsWith("write:") ? "Write" : "Read"}: ${escaped(s.split(":")[1])}</label>`).join("")}<button name="decision" value="approve">Approve selected types</button><button name="decision" value="deny">Deny</button></form>`, { "Content-Security-Policy": pagePolicy(new URL(params.redirect_uri).origin) });
  }
  const { body, human } = await mutation(request, store, now(), origin);
  if (typeof body.consent !== "string" || body.consent.length > 128) fail(400, "invalid_request");
  const [nonce, signature, extra] = body.consent.split(".");
  if (extra || !equal(signature, await mac(store.key("oauth"), nonce ?? ""))) fail(400, "invalid_request");
  const stateHash = await digest(body.consent), code = random(), codeHash = await digest(code);
  const result = store.sql.transaction(() => {
    const row = store.sql.all("SELECT * FROM consent_requests WHERE state_hash = ?", stateHash)[0];
    if (!row || row.session_hash !== human.session_hash || row.expires_at <= now()) fail(400, "invalid_request");
    const params = JSON.parse(row.request_json), { selected: requested } = validated(params, store, origin);
    if (body.decision === "deny") { store.sql.run("DELETE FROM consent_requests WHERE state_hash = ?", stateHash); return { params, denied: true }; }
    if (body.decision !== "approve") fail(400, "invalid_request");
    const selected = scopes(body.scope, store);
    if (selected.some(s => !requested.includes(s))) fail(400, "invalid_scope");
    const id = random();
    const read = selected.filter(s => s.startsWith("read:")).map(s => s.slice(5)), write = selected.filter(s => s.startsWith("write:")).map(s => s.slice(6));
    const revision = store.sql.all("SELECT COALESCE(MAX(revision), 0) + 1 AS n FROM grants WHERE client_id = ?", params.client_id)[0].n;
    for (const previous of store.sql.all("SELECT id FROM grants WHERE client_id = ? AND redirect_uri = ? AND revoked_at IS NULL", params.client_id, params.redirect_uri)) store.revokeGrant(previous.id, now());
    store.sql.run("INSERT INTO grants(id, client_id, redirect_uri, read_types_json, write_types_json, purpose, revision, consented, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)", id, params.client_id, params.redirect_uri, JSON.stringify(read), JSON.stringify(write), purpose, revision, now());
    store.sql.run("INSERT INTO auth_codes(code_hash, client_id, redirect_uri, resource, issuer, grant_id, challenge, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", codeHash, params.client_id, params.redirect_uri, params.resource, origin, id, params.code_challenge, now() + 60);
    store.sql.run("DELETE FROM consent_requests WHERE state_hash = ?", stateHash);
    return { params, denied: false };
  });
  return redirect(result.params, result.denied ? { error: "access_denied" } : { code });
}
