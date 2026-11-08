import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fixture, secret } from "./helpers.js";

export const origin = "https://receiver.example";
export const callback = "https://claude.ai/api/mcp/auth_callback";
export const challenge = (v) => createHash("sha256").update(v).digest("base64url");
export const hidden = (html, name) => html.match(new RegExp(`name="${name}" value="([^"]+)"`))?.[1];
export const setup = (html) => html.match(/href="(syncky(?:-dev|-staging)?:[^\"]+)"/)?.[1].replaceAll("&amp;", "&");
export const cookie = (response) => response.headers.get("set-cookie")?.split(";", 1)[0];

export async function browser(t, options = {}) {
  const f = await fixture(t, { initialized: false, ...options });
  f.deps.adminPassword = secret();
  return browserSession(f);
}

export function browserSession(f) {
  const b = { ...f, password: f.deps.adminPassword, cookie: "", csrf: "" };
  b.get = (path, headers = {}) => f.send(new Request(origin + path, { headers: { Cookie: b.cookie, ...headers } }));
  b.post = (path, data = {}, headers = {}) => f.send(new Request(origin + path, { method: "POST", headers: { Origin: origin, Cookie: b.cookie, "Content-Type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams({ csrf: b.csrf, ...data }) }));
  b.login = async (password = b.password) => {
    const page = await b.get("/admin/login");
    b.cookie = cookie(page);
    b.csrf = hidden(await page.text(), "csrf");
    const response = await b.post("/admin/login", { password });
    const html = await response.text();
    if (response.status === 200) {
      b.cookie = cookie(response);
      b.csrf = hidden(html, "csrf");
    }
    return { response, html, link: setup(html) };
  };
  b.register = async (extra = {}, manual = false) => {
    const response = await f.send(new Request(origin + (manual ? "/admin/clients" : "/oauth/register"), { method: "POST", headers: { "Content-Type": "application/json", ...(manual ? { Origin: origin, Cookie: b.cookie, "X-CSRF-Token": b.csrf } : {}) }, body: JSON.stringify({ client_name: "Local AI", redirect_uris: [callback], token_endpoint_auth_method: "none", ...extra }) }));
    assert.equal(response.status, 201);
    return response.json();
  };
  b.authorize = async (client, extra = {}, approve = true) => {
    const verifier = secret();
    const params = { response_type: "code", client_id: client.client_id, redirect_uri: callback, resource: origin + "/mcp", code_challenge_method: "S256", code_challenge: challenge(verifier), scope: "read:steps", state: secret(), ...extra };
    const page = await b.get("/oauth/authorize?" + new URLSearchParams(params));
    const html = await page.text();
    if (!approve || page.status !== 200) return { page, html, params, verifier };
    const response = await b.post("/oauth/authorize", { consent: hidden(html, "consent"), scope: params.scope, decision: "approve" });
    assert.equal(response.status, 303);
    const location = new URL(response.headers.get("location"));
    return { page, html, params, verifier, response, code: location.searchParams.get("code") };
  };
  b.token = (client, code, verifier, extra = {}, headers = {}) => b.post("/oauth/token", { grant_type: "authorization_code", client_id: client.client_id, code, code_verifier: verifier, redirect_uri: callback, resource: origin + "/mcp", ...extra }, headers);
  b.access = async (client, extra = {}) => {
    const auth = await b.authorize(client, extra);
    const response = await b.token(client, auth.code, auth.verifier);
    assert.equal(response.status, 200);
    return { ...await response.json(), auth };
  };
  b.mcp = (token, method = "ping", headers = {}) => f.send(new Request(origin + "/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json", "MCP-Protocol-Version": "2025-06-18", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method }) }));
  return b;
}
