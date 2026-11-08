import { authorized, initializedCredentials, verifySignature } from "./crypto.js";
import { readBody, parseBody, validateHeaders, validateNative, validateResults } from "./upload.js";
import { admin } from "./admin.js";
import { oauth, authorizeMcp } from "./oauth.js";
import { consent } from "./consent.js";
import { mcp } from "./mcp.js";
import { commandReply } from "./commands.js";
import { SafeError, checkOrigin } from "./security.js";

const json = (status, value, headers = {}) => Response.json(value, { status, headers: { "Cache-Control": "no-store", ...headers } });
const error = (status, code) => json(status, { ok: false, code, ...(code === "unsupported_format" ? { hint: "Use native JSON" } : {}) });
const empty = () => new Response(null, { status: 200, headers: { "Cache-Control": "no-store" } });

export async function handle(request, dependencies) {
  try {
    const { store, now = () => Math.floor(Date.now() / 1000) } = dependencies;
    const deps = { ...dependencies, now };
    const path = new URL(request.url).pathname;
    if (path === "/health") return request.method === "GET" ? json(200, { ok: true }) : json(405, { ok: false, code: "method_not_allowed" }, { Allow: "GET" });
    const origin = checkOrigin(request, store, dependencies.publicUrl);
    store.prune(now());
    if (path.startsWith("/admin")) {
      const response = await admin(request, deps, origin);
      if (response) return response;
    }
    if (path === "/oauth/authorize") return await consent(request, deps, origin);
    if (path.startsWith("/oauth/") || path.startsWith("/.well-known/") || path.startsWith("/admin/clients")) return await oauth(request, deps, origin);
    if (path === "/mcp") {
      const authorization = await authorizeMcp(request, store, now(), origin);
      return authorization.response ?? await mcp(request, deps, origin, authorization);
    }
    if (path !== "/server") return error(404, "not_found");
    if (request.method !== "POST") return json(405, { ok: false, code: "method_not_allowed" }, { Allow: "POST" });
    const credentials = store.credentials();
    if (!initializedCredentials(credentials)) return error(503, "not_initialized");
    if (!await authorized(request.headers, credentials)) return error(401, "unauthorized");
    const body = await readBody(request);
    if (credentials.hmac !== null) {
      const signature = request.headers.get("x-syncky-signature");
      const verdict = signature === null ? "unsigned" : await verifySignature({ secret: credentials.hmac, timestamp: request.headers.get("x-syncky-timestamp"), signature, body, now: now() });
      if (verdict !== "valid") return error(401, verdict);
    }
    const kind = request.headers.get("x-syncky-kind");
    if (kind !== null && kind !== "results") return error(400, "unknown_kind");
    if (kind !== "results" && request.headers.get("x-syncky-format") !== "native") return error(415, "unsupported_format");
    if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") return error(415, "unsupported_media_type");
    const message = parseBody(body);
    validateHeaders(request.headers);
    if (kind === "results") {
      store.acceptResults(request.headers.get("x-syncky-destination"), validateResults(message), now());
      return empty();
    }
    validateNative(message, request.headers);
    if (message.delivery.test) return empty();
    store.ingest(message, now());
    return await commandReply(store, message, credentials, now());
  } catch (failure) {
    const safeCodes = new Set(["payload_too_large", "invalid_content_length", "invalid_body", "invalid_json", "invalid_target", "not_sync", "invalid_delivery", "invalid_sample", "invalid_deletion", "invalid_summary", "invalid_probe", "not_results"]);
    if (failure instanceof SafeError) return json(failure.status, { ok: false, code: failure.code, ...(new URL(request.url).pathname.startsWith("/oauth/") ? { error: failure.code } : {}) }, failure.code === "invalid_client" ? { "WWW-Authenticate": 'Basic realm="oauth"' } : {});
    return safeCodes.has(failure?.code) ? error(failure.status, failure.code) : error(500, "internal");
  }
}
