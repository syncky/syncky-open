import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { browser, origin } from "./browser.js";
import { native, messageRequest, at } from "./helpers.js";

export function rpc(b, token, method, params, headers = {}, extra = {}) {
  return b.send(new Request(origin + "/mcp", {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json", "MCP-Protocol-Version": "2025-06-18", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }), ...extra }),
  }));
}

export async function tool(b, token, name, args = {}) {
  const response = await rpc(b, token, "tools/call", { name, arguments: args });
  assert.equal(response.status, 200);
  const body = await response.json();
  return body.error ? { error: body.error } : JSON.parse(body.result.content[0].text);
}

export async function connected(t, options = {}) {
  const b = await browser(t, options);
  const { link } = await b.login();
  const setup = new URL(link);
  b.config.token = setup.searchParams.get("token");
  b.config.hmac = setup.searchParams.get("hmac");
  if (options.write) assert.equal((await b.post("/admin/settings", { writes_enabled: "true" })).status, 200);
  b.client = await b.register();
  b.tokens = await b.access(b.client, { scope: options.scope ?? (options.write ? "read:steps write:dietary_water write:sleep_analysis" : "read:steps") });
  b.accessToken = b.tokens.access_token;
  b.upload = await native(b).json();
  b.destination = b.upload.delivery.destination;
  b.device = b.upload.device;
  b.deliver = (extra = {}) => b.send(messageRequest(b, { ...b.upload, ...extra, delivery: { ...b.upload.delivery, id: randomUUID(), ...extra.delivery } }));
  b.results = (results, destination = b.destination) => {
    const request = messageRequest(b, { v: 1, type: "results", results }, { "X-Syncky-Kind": "results", "X-Syncky-Destination": destination });
    request.headers.delete("X-Syncky-Format");
    return b.send(request);
  };
  assert.equal((await b.deliver()).status, 200);
  return b;
}

export const command = (b, extra = {}) => ({ destination: b.destination, device: b.device, command_id: randomUUID(), version: 1, op: "write", type: "dietary_water", value: 0.25, unit: "L", start: at, end: at, ...extra });
export const write = (b, c, token = b.accessToken) => tool(b, token, "syncky_write", c);
export const errorCode = (value) => value.error?.data?.code;
