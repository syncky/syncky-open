import catalog from "./write-catalog.json" with { type: "json" };
import { authorizeMcp } from "./oauth.js";
import { canWrite, queueCommand } from "./commands.js";
import { query, status } from "./query.js";
import { readBody, parseBody } from "./upload.js";
import { SafeError, fail, json, method } from "./security.js";

const version = "2025-06-18";
const MAX_RESPONSE_BYTES = 1_048_576;
const encoder = new TextEncoder();
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const metadata = value => value === undefined || object(value) && (!Object.hasOwn(value, "progressToken") || typeof value.progressToken === "string" || typeof value.progressToken === "number" && Number.isFinite(value.progressToken));
const result = (id, value) => ({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(value) }], isError: false } });
const response = value => json(200, value, { "MCP-Protocol-Version": version });
const error = (id, code, message, detail) => response({ jsonrpc: "2.0", id, error: { code, message, ...(detail ? { data: { code: detail } } : {}) } });
const schema = properties => ({ type: "object", properties, additionalProperties: false });
const integer = max => ({ type: "integer", minimum: 1, maximum: max });

function tools(store, grant) {
  const read = JSON.parse(grant.read_types_json);
  const entries = read.length ? [
    { name: "syncky_status", description: "Selected type availability and last accepted upload metadata; this does not establish phone authorization or freshness.", inputSchema: schema({ limit: integer(50), cursor: { type: "string", maxLength: 4096 } }), annotations: { readOnlyHint: true, openWorldHint: false } },
    { name: "syncky_query", description: "Read native samples or separate summaries for one selected type. Defaults to seven days; maximum 31 days and 200 whole rows per page.", inputSchema: { ...schema({ type: { type: "string", enum: read }, kind: { enum: ["samples", "summaries"] }, since: { type: "string" }, until: { type: "string" }, device: { type: "string" }, limit: integer(200), cursor: { type: "string", maxLength: 4096 } }), required: ["type"] }, annotations: { readOnlyHint: true, openWorldHint: false } },
  ] : [];
  if (canWrite(store, grant)) entries.push({
    name: "syncky_write", description: "Queue a selected write or delete for the next ordinary phone upload reply. Queued does not mean applied; phone permissions and results decide.",
    inputSchema: { type: "object", properties: { destination: { type: "string", pattern: "^wh_[A-Za-z0-9_-]{22}$" }, device: { type: "string", pattern: "^d_[A-Za-z0-9_-]{22}$" }, type: { enum: JSON.parse(grant.write_types_json) } }, required: ["destination", "device"], $defs: catalog.command_schema.$defs, oneOf: [{ $ref: "#/$defs/command_write" }, { $ref: "#/$defs/command_delete" }] },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  });
  return entries;
}

export async function mcp(request, deps, origin, authorization) {
  const { store, now } = deps;
  const wrong = method(request, ["POST"]);
  if (wrong) return wrong;
  if (!store.rate("mcp:" + authorization.grant.id, 60, 60, now())) return json(429, { ok: false, code: "rate_limited" }, { "Retry-After": "60" });
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") fail(415, "unsupported_media_type");
  const accept = request.headers.get("accept") ?? "*/*";
  if (!accept.split(",").some(part => {
    const [media, ...params] = part.trim().toLowerCase().split(";");
    return ["application/json", "application/*", "*/*"].includes(media) && !params.some(p => /^\s*q=0(?:\.0*)?\s*$/.test(p));
  })) fail(406, "not_acceptable");
  const body = await readBody(request, 65_536);
  let message;
  try { message = parseBody(body); } catch { return error(null, -32700, "Parse error"); }
  const current = await authorizeMcp(request, store, now(), origin);
  if (current.response) return current.response;
  const notification = object(message) && message.jsonrpc === "2.0" && typeof message.method === "string" && !Object.hasOwn(message, "id");
  if (!object(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string" || message.method.length > 128 || message.params !== undefined && !object(message.params) || Object.hasOwn(message, "id") && !(typeof message.id === "string" && message.id.length <= 128 || Number.isSafeInteger(message.id))) return notification ? json(400, { ok: false, code: "invalid_notification" }) : error(null, -32600, "Invalid Request");
  const id = message.id;
  if (message.method !== "initialize" && request.headers.get("mcp-protocol-version") !== version) fail(400, "unsupported_protocol_version");
  const { _meta, ...params } = message.params ?? {};
  if (id === undefined) {
    if (message.method !== "notifications/initialized" || Object.keys(params).length || !metadata(_meta)) return json(400, { ok: false, code: "invalid_notification" });
    return new Response(null, { status: 202, headers: { "Cache-Control": "no-store" } });
  }
  if (!metadata(_meta)) return error(id, -32602, "Invalid params");
  try {
    if (message.method === "initialize") {
      if (typeof params.protocolVersion !== "string" || params.protocolVersion.length > 64 || !object(params.capabilities) || !object(params.clientInfo) || typeof params.clientInfo.name !== "string" || params.clientInfo.name.length > 128 || typeof params.clientInfo.version !== "string" || params.clientInfo.version.length > 128) return error(id, -32602, "Invalid params");
      return response({ jsonrpc: "2.0", id, result: { protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "syncky-own-server", version: "1" } } });
    }
    if (message.method === "ping") return Object.keys(params).length ? error(id, -32602, "Invalid params") : response({ jsonrpc: "2.0", id, result: {} });
    if (message.method === "tools/list") return Object.keys(params).length ? error(id, -32602, "Invalid params") : response({ jsonrpc: "2.0", id, result: { tools: tools(store, current.grant) } });
    if (message.method !== "tools/call") return error(id, -32601, "Method not found");
    if (Object.keys(params).some(k => !["name", "arguments"].includes(k)) || typeof params.name !== "string" || params.arguments !== undefined && !object(params.arguments)) return error(id, -32602, "Invalid params");
    const fits = value => encoder.encode(JSON.stringify(result(id, value))).length <= MAX_RESPONSE_BYTES;
    let value;
    const args = params.arguments ?? {};
    if (params.name === "syncky_status") value = await status(store, current.grant, args, fits);
    else if (params.name === "syncky_query") value = await query(store, current.grant, args, now(), fits);
    else if (params.name === "syncky_write") value = queueCommand(store, current.grant, args, now());
    else fail(400, "unknown_tool");
    const final = await authorizeMcp(request, store, now(), origin);
    if (final.response) return final.response;
    if (!fits(value)) fail(413, "response_too_large");
    return response(result(id, value));
  } catch (failure) {
    if (!(failure instanceof SafeError)) return error(id, -32603, "Internal error");
    return error(id, failure.status === 400 ? -32602 : -32000, "Tool request rejected", failure.code);
  }
}
