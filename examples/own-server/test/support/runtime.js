import { random, base64url, pkceChallenge, signReply } from "../../src/crypto.js";

export const check = (condition, label) => { if (!condition) throw new Error(label); };
const hidden = (html, name) => html.match(new RegExp('name="' + name + '" value="([^"]+)"'))?.[1];
const cookie = response => response.headers.get("set-cookie")?.split(";", 1)[0];
const hex = bytes => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, "0")).join("");
export const callback = "https://claude.ai/api/mcp/auth_callback";

export function client(runtime) {
  const b = { runtime, origin: runtime.origin, cookie: "", csrf: "" };
  b.send = (path, options = {}) => runtime.send(new Request(b.origin + path, { redirect: "manual", ...options }));
  b.get = (path, headers = {}) => b.send(path, { headers: { Cookie: b.cookie, ...headers } });
  b.post = (path, data = {}, headers = {}) => b.send(path, { method: "POST", headers: { Origin: b.origin, Cookie: b.cookie, "Content-Type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams({ csrf: b.csrf, ...data }) });
  b.login = async () => {
    const page = await b.get("/admin/login");
    b.cookie = cookie(page); b.csrf = hidden(await page.text(), "csrf");
    const response = await b.post("/admin/login", { password: runtime.password });
    check(response.status === 200, "runtime login");
    b.cookie = cookie(response);
    const html = await response.text();
    b.csrf = hidden(html, "csrf");
    const link = html.match(/href="(syncky:[^"]+)"/)?.[1].replaceAll("&amp;", "&");
    if (link) {
      const setup = new URL(link);
      check(setup.searchParams.get("url") === b.origin + "/server" && setup.searchParams.get("format") === "native", "runtime setup origin");
      b.token = setup.searchParams.get("token"); b.hmac = setup.searchParams.get("hmac");
    }
    return link;
  };
  b.register = async (manual = false, confidential = false) => {
    const response = await b.send(manual ? "/admin/clients" : "/oauth/register", { method: "POST", headers: { "Content-Type": "application/json", ...(manual ? { Cookie: b.cookie, Origin: b.origin, "X-CSRF-Token": b.csrf } : {}) }, body: JSON.stringify({ client_name: "Local AI", redirect_uris: [callback], token_endpoint_auth_method: confidential ? "client_secret_basic" : "none" }) });
    check(response.status === 201, "runtime registration");
    return response.json();
  };
  b.access = async (registered, scope = "read:steps", beforeExchange) => {
    const verifier = random();
    const params = { response_type: "code", client_id: registered.client_id, redirect_uri: callback, resource: b.origin + "/mcp", code_challenge_method: "S256", code_challenge: await pkceChallenge(verifier), scope, state: random() };
    const page = await b.get("/oauth/authorize?" + new URLSearchParams(params));
    const html = await page.text();
    check(page.status === 200 && html.includes("Local AI") && html.includes("steps") && html.includes("health and fitness") && html.includes("claude.ai"), "runtime consent disclosure");
    const approval = await b.post("/oauth/authorize", { consent: hidden(html, "consent"), scope, decision: "approve" });
    check(approval.status === 303, "runtime explicit consent");
    const code = new URL(approval.headers.get("location")).searchParams.get("code");
    const exchange = { grant_type: "authorization_code", client_id: registered.client_id, code, code_verifier: verifier, redirect_uri: callback, resource: b.origin + "/mcp" };
    const headers = registered.client_secret ? { Authorization: "Basic " + btoa(registered.client_id + ":" + registered.client_secret) } : {};
    if (beforeExchange) await beforeExchange(exchange, headers);
    const response = await b.post("/oauth/token", exchange, headers);
    check(response.status === 200, "runtime PKCE exchange");
    const tokens = await response.json();
    return { ...tokens, code, exchange, headers };
  };
  b.rpc = (token, method = "ping", params, headers = {}) => b.send("/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json", "MCP-Protocol-Version": "2025-06-18", ...(token ? { Authorization: "Bearer " + token } : {}), ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }) });
  b.tool = async (token, name, args = {}) => {
    const response = await b.rpc(token, "tools/call", { name, arguments: args });
    check(response.status === 200, "runtime tool transport");
    const value = await response.json();
    return value.error ? { error: value.error.data?.code } : JSON.parse(value.result.content[0].text);
  };
  const time = new Date(runtime.now() * 1000).toISOString().replace(".000Z", "Z");
  b.message = { v: 1, type: "sync", device: "d_" + base64url(crypto.getRandomValues(new Uint8Array(16))), samples: [], deleted: [], acks: [], more: false, delivery: { destination: "wh_" + base64url(crypto.getRandomValues(new Uint8Array(16))), id: crypto.randomUUID(), index: 0, count: 1, sent_at: time } };
  b.sample = () => ({ uuid: crypto.randomUUID(), type: "steps", start: time, end: time, value: 17, unit: "count" });
  b.command = () => ({ destination: b.message.delivery.destination, device: b.message.device, command_id: crypto.randomUUID(), version: 1, op: "write", type: "dietary_water", value: 0.25, unit: "L", start: time, end: time });
  b.upload = async (extra = {}, options = {}) => {
    const message = { ...b.message, ...extra, delivery: { ...b.message.delivery, id: crypto.randomUUID(), ...extra.delivery } };
    const body = JSON.stringify(options.results ? { v: 1, type: "results", results: options.results } : message);
    const timestamp = String(runtime.now());
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(b.hmac), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = "v1=" + hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(timestamp + "." + body)));
    const headers = { Authorization: "Bearer " + b.token, "Content-Type": "application/json", "X-Syncky-Delivery": message.delivery.id, "X-Syncky-Destination": message.delivery.destination, "X-Syncky-Timestamp": timestamp, "X-Syncky-Signature": signature, ...(options.results ? { "X-Syncky-Kind": "results" } : { "X-Syncky-Format": "native" }), ...options.headers };
    const response = await b.send("/server", { method: "POST", headers, body: options.body ?? body });
    return { response, message };
  };
  b.empty = async (extra = {}, options = {}) => {
    const { response } = await b.upload(extra, options);
    check(response.status === 200 && await response.text() === "" && !response.headers.has("x-syncky-signature"), "runtime empty reply");
  };
  return b;
}

export async function flow(runtime, manual = false) {
  const b = client(runtime);
  check(Boolean(await b.login()), "runtime first setup");
  check(!await b.login(), "runtime setup shown once");
  const record = b.sample();
  await b.empty({ samples: [record], summaries: [{ type: "steps", unit: "count", start: record.start, end: new Date(runtime.now() * 1000 + 3600000).toISOString(), stat: "sum", value: 0 }] });
  await b.empty({ samples: [record] });
  const registered = await b.register(manual, manual);
  let tokens = await b.access(registered);
  const listed = await (await b.rpc(tokens.access_token, "tools/list")).json();
  check(!listed.result.tools.some(t => t.name === "syncky_write"), "runtime default read only");
  check((await b.tool(tokens.access_token, "syncky_write", b.command())).error === "write_denied", "runtime explicit default write denied");
  check((await b.tool(tokens.access_token, "syncky_query", { type: "steps" })).rows.length === 1, "runtime deduplicated read");
  check((await b.tool(tokens.access_token, "syncky_query", { type: "steps", kind: "summaries" })).rows.length === 1, "runtime zero summary read");
  check((await b.post("/admin/settings", { writes_enabled: "true" })).status === 200, "runtime write toggle");
  tokens = await b.access(registered, "read:steps write:dietary_water");
  const command = b.command();
  check((await b.tool(tokens.access_token, "syncky_write", command)).state === "queued", "runtime queued write");
  await b.empty({ delivery: { test: true } });
  await b.empty({}, { results: [] });
  const sent = await b.upload();
  const body = await sent.response.text();
  check(sent.response.status === 200 && JSON.parse(body).commands[0].command_id === command.command_id, "runtime ordinary reply delivery");
  check(sent.response.headers.get("x-syncky-signature") === await signReply(b.hmac, sent.message.delivery.id, runtime.now(), body), "runtime signed reply bytes");
  const retry = await b.upload();
  check((await retry.response.json()).commands.length === 1, "runtime retries until result");
  await b.empty({}, { results: [{ command_id: command.command_id, version: 1, status: "rejected", reason: "healthkit_denied" }] });
  check((await b.tool(tokens.access_token, "syncky_write", command)).state === "rejected", "runtime phone rejection authoritative");
  const deletion = { destination: command.destination, device: command.device, command_id: command.command_id, type: command.type, version: 2, op: "delete" };
  check((await b.tool(tokens.access_token, "syncky_write", deletion)).state === "queued", "runtime delete version increment");
  check((await (await b.upload()).response.json()).commands[0].version === 2, "runtime latest version delivered");
  await b.empty({}, { results: [{ command_id: command.command_id, version: 2, status: "applied" }] });
  await runtime.restart();
  check(!await b.login(), "runtime persisted bootstrap");
  check((await b.tool(tokens.access_token, "syncky_query", { type: "steps" })).rows.length === 1, "runtime persisted samples and tokens");
  check((await b.tool(tokens.access_token, "syncky_write", deletion)).state === "applied", "runtime persisted result");
  check((await b.post("/admin/clients/" + registered.client_id + "/revoke")).status === 200, "runtime revoke");
  check((await b.rpc(tokens.access_token)).status === 401, "runtime revoked token denied");
  check((await b.post("/oauth/token", { grant_type: "refresh_token", client_id: registered.client_id, refresh_token: tokens.refresh_token, resource: b.origin + "/mcp" }, tokens.headers)).status === 400, "runtime revoked refresh denied");
}

export async function lostReply(runtime, action) {
  const b = client(runtime); await b.login();
  await b.post("/admin/settings", { writes_enabled: "true" });
  const registered = await b.register();
  const tokens = await b.access(registered, "read:steps write:dietary_water");
  await b.empty();
  const first = b.command(), late = b.command();
  for (const c of [first, late]) check((await b.tool(tokens.access_token, "syncky_write", c)).state === "queued", "runtime lost queue");
  check((await (await b.upload()).response.json()).commands.length === 2, "runtime lost reply emitted");
  const response = action === "disable" ? await b.post("/admin/settings", { writes_enabled: "false" }) : await b.post("/admin/clients/" + registered.client_id + "/revoke");
  check(response.status === 200, "runtime stop delivery");
  await runtime.restart();
  await b.empty();
  await b.empty({}, { results: [{ command_id: late.command_id, version: 1, status: "applied" }] });
  await b.empty();
  const rows = await runtime.all("SELECT state FROM commands");
  check(rows.length === 2 && rows.every(r => action === "revoke" ? r.state === "cancelled" : ["pending", "applied"].includes(r.state)), "runtime durable command state");
  if (action === "disable") {
    check((await runtime.all("SELECT value_json FROM settings WHERE key = ?", "writes_enabled"))[0].value_json === "false", "runtime durable write toggle");
    await b.post("/admin/settings", { writes_enabled: "true" });
    check((await (await b.upload()).response.json()).commands.length === 1, "runtime authorized reenable");
  } else {
    check((await b.rpc(tokens.access_token)).status === 401, "runtime durable token revocation");
    const renewed = await b.access(registered, "read:steps write:dietary_water");
    await b.empty();
    check((await b.tool(renewed.access_token, "syncky_write", first)).error === "command_not_owned", "runtime new consent cannot revive old grant");
  }
}

export async function authorization(runtime) {
  const b = client(runtime); await b.login();
  for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-authorization-server"]) {
    const response = await b.get(path, { "X-Forwarded-Host": "forged.example" });
    check(response.status === 200, "runtime discovery");
    const metadata = await response.json();
    check((metadata.issuer ?? metadata.resource) === b.origin + (metadata.resource ? "/mcp" : ""), "runtime canonical discovery");
  }
  const missing = await b.rpc();
  check(missing.status === 401 && missing.headers.has("www-authenticate"), "runtime missing OAuth discovery");
  const registered = await b.register();
  check((await b.get("/oauth/authorize?" + new URLSearchParams({ client_id: registered.client_id, response_type: "code", redirect_uri: callback, resource: b.origin + "/mcp", code_challenge: random(), code_challenge_method: "plain", scope: "read:steps" }))).status === 400, "runtime plain PKCE denied");
  const replayed = await b.access(registered);
  check((await b.post("/oauth/token", replayed.exchange)).status === 400, "runtime code replay denied");
  check((await b.rpc(replayed.access_token)).status === 401, "runtime code replay revokes access");
  const tokens = await b.access(registered, "read:steps", async (exchange, headers) => {
    for (const extra of [{ resource: b.origin + "/wrong" }, { code_verifier: random() }, { redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect" }]) check((await b.post("/oauth/token", { ...exchange, ...extra }, headers)).status === 400, "runtime token resource/verifier/redirect binding");
  });
  await runtime.run("UPDATE grants SET consented = 0 WHERE client_id = ?", registered.client_id);
  for (const method of ["initialize", "notifications/initialized", "ping", "tools/list", "tools/call", "unknown"]) {
    const denied = await b.rpc(tokens.access_token, method, method === "tools/call" ? { name: "syncky_query", arguments: { type: "steps" } } : undefined);
    check(denied.status === 403 && (await denied.json()).code === "consent_required", "runtime every MCP method requires consent");
  }
  await runtime.run("UPDATE grants SET consented = 1 WHERE client_id = ?", registered.client_id);
  for (const token of [b.token, runtime.password, b.cookie.split("=")[1]]) check((await b.rpc(token)).status === 401, "runtime credential separation MCP");
  check((await b.upload({}, { headers: { Authorization: "Bearer " + tokens.access_token } })).response.status === 401, "runtime credential separation upload");
  check((await b.upload({}, { body: "{}" })).response.status === 401, "runtime altered body rejected");
  check((await b.get("/admin", { Host: "forged.example" })).status === 400, "runtime forged host denied");
  check((await b.post("/admin/settings", {}, { Origin: "https://forged.example" })).status === 403, "runtime cross origin denied");
  check((await b.rpc(tokens.access_token, "ping", undefined, { Origin: "https://forged.example" })).status === 403, "runtime MCP origin denied");
  const other = await b.access(await b.register());
  await b.empty({ samples: [b.sample(), b.sample()] });
  const page = await b.tool(tokens.access_token, "syncky_query", { type: "steps", limit: 1 });
  check(Boolean(page.next_cursor), "runtime bounded pagination");
  check((await b.tool(other.access_token, "syncky_query", { type: "steps", limit: 1, cursor: page.next_cursor })).error === "invalid_cursor", "runtime cursor client isolation");
  check(Boolean((await b.tool(tokens.access_token, "syncky_query", { type: "steps", limit: 201 })).error), "runtime query bound");
  check(Boolean((await b.tool(tokens.access_token, "syncky_query", { type: "steps' OR 1=1 --" })).error), "runtime prepared query isolation");
  const refresh = { grant_type: "refresh_token", client_id: registered.client_id, refresh_token: tokens.refresh_token, resource: b.origin + "/mcp" };
  const rotated = await b.post("/oauth/token", refresh);
  check(rotated.status === 200, "runtime refresh rotation");
  const fresh = await rotated.json();
  check((await b.post("/oauth/token", refresh)).status === 400, "runtime refresh replay denied");
  check((await b.rpc(fresh.access_token)).status === 401, "runtime replay revokes family");
  const encoded = JSON.stringify(await runtime.all("SELECT * FROM oauth_tokens"));
  check(!encoded.includes(tokens.access_token) && !encoded.includes(tokens.refresh_token), "runtime OAuth hashes at rest");
  runtime.setNow(runtime.now() + 301);
  check((await b.rpc(other.access_token)).status === 401, "runtime short access expiry");
}
