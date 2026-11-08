import { readBody, parseBody } from "./upload.js";
import { digest, equal, mac } from "./crypto.js";

export class SafeError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
export const fail = (status, code) => { throw new SafeError(status, code); };
export const json = (status, value, headers = {}) => Response.json(value, { status, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", ...headers } });
export const escaped = (value) => String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export const input = (name, value) => `<input type="hidden" name="${escaped(name)}" value="${escaped(value)}">`;
export const pagePolicy = (callbackOrigin) => `default-src 'none'; form-action 'self'${callbackOrigin ? " " + callbackOrigin : ""}; frame-ancestors 'none'; base-uri 'none'`;
export const page = (title, body, headers = {}) => new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><title>${escaped(title)}</title><body><h1>${escaped(title)}</h1>${body}</body></html>`, { headers: {
  "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY", "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": pagePolicy(), ...headers,
} });
export const method = (request, allowed) => allowed.includes(request.method) ? null : json(405, { ok: false, code: "method_not_allowed" }, { Allow: allowed.join(", ") });
export const cookieName = "__Host-syncky-session";
export const loginCookieName = "__Host-syncky-login";
export function adminConfigured(password) {
  if (typeof password !== "string" || password.length < 1 || new TextEncoder().encode(password).length > 1024) fail(503, "admin_not_configured");
}
export const setCookie = (name, value, age) => `${name}=${value}; Path=/; Max-Age=${age}; Secure; HttpOnly; SameSite=Lax`;
export function cookie(request, name) {
  const matches = (request.headers.get("cookie") ?? "").split(";").map(s => s.trim()).filter(s => s.startsWith(name + "="));
  return matches.length === 1 ? matches[0].slice(name.length + 1) : "";
}
export function canonicalOrigin(value) {
  let url;
  try { url = new URL(value); } catch { fail(400, "invalid_origin"); }
  const hostname = url.hostname.toLowerCase(), service = ["syncky", "app"].join(".");
  if (url.username || url.password || hostname === service || hostname.endsWith("." + service) ||
      !(url.protocol === "https:" || url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(hostname))) fail(400, "invalid_origin");
  return url.origin;
}
export function checkOrigin(request, store, publicUrl) {
  const url = new URL(request.url);
  const actual = canonicalOrigin(request.url);
  let configured;
  if (publicUrl !== undefined) {
    const parsed = new URL(publicUrl);
    if (parsed.pathname !== "/" || parsed.search || parsed.hash) fail(400, "invalid_origin");
    configured = canonicalOrigin(publicUrl);
  }
  const expected = store.setting("origin") ?? configured ?? actual;
  if (actual !== expected || configured && configured !== expected || request.headers.has("host") && request.headers.get("host").toLowerCase() !== url.host.toLowerCase()) fail(400, "invalid_origin");
  return expected;
}
export function sameOrigin(request, origin) {
  if (request.headers.get("origin") !== origin) fail(403, "csrf_failed");
  if (request.headers.get("sec-fetch-site") === "cross-site") fail(403, "csrf_failed");
}
export async function data(request, cap = 16_384) {
  const body = await readBody(request, cap);
  const kind = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (kind === "application/json") {
    const value = parseBody(body);
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(400, "invalid_request");
    return value;
  }
  if (kind !== "application/x-www-form-urlencoded") fail(415, "unsupported_media_type");
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(body); } catch { fail(400, "invalid_request"); }
  return parameters(new URLSearchParams(text));
}
export function parameters(params) {
  const out = Object.create(null);
  for (const [key, value] of params) {
    if (Object.hasOwn(out, key)) {
      if (key !== "scope") fail(400, "invalid_request");
      out[key] += " " + value;
    } else out[key] = value;
  }
  return out;
}
export async function session(request, store, now) {
  const value = cookie(request, cookieName);
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) fail(401, "admin_required");
  const row = store.sql.all("SELECT * FROM admin_sessions WHERE session_hash = ? AND expires_at > ?", await digest(value), now)[0];
  if (!row) fail(401, "admin_required");
  return { ...row, csrf: await mac(store.key("session"), value) };
}
export async function mutation(request, store, now, origin) {
  const human = await session(request, store, now);
  sameOrigin(request, origin);
  if (new URL(request.url).search) fail(400, "invalid_request");
  const body = await data(request);
  const csrf = request.headers.get("x-csrf-token") ?? body.csrf;
  if (!equal(csrf, human.csrf) || !equal(await digest(csrf ?? ""), human.csrf_hash)) fail(403, "csrf_failed");
  return { body, human };
}
export function exactRedirect(value) {
  if (typeof value !== "string" || value.length > 2048 || /[\s*]/.test(value)) fail(400, "invalid_redirect_uri");
  let url;
  try { url = new URL(value); } catch { fail(400, "invalid_redirect_uri"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || value.includes("#") || url.href !== value) fail(400, "invalid_redirect_uri");
  return value;
}
export const defaultRedirects = () => [
  new URL("/api/mcp/auth_callback", "https:" + "//claude.ai").href,
  new URL("/connector_platform_oauth_redirect", "https:" + "//chatgpt.com").href,
];
export const redirectAllowed = (store, uri) => (store.setting("redirect_allowlist") ?? []).includes(uri);
export const activeGrant = (store, id, clientId) => {
  const grant = store.sql.all("SELECT * FROM grants WHERE id = ? AND client_id = ? AND revoked_at IS NULL", id, clientId)[0];
  return grant && redirectAllowed(store, grant.redirect_uri) ? grant : null;
};
