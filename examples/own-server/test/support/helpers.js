import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID, createHmac } from "node:crypto";
import { openSqlite } from "../../docker/sql.js";
import { createStore } from "../../src/store.js";
import { createUploadCredentials } from "../../src/crypto.js";
import { handle } from "../../src/handler.js";

export const vectors = (name) => JSON.parse(readFileSync(new URL(`../../../../protocol/test-vectors/${name}.json`, import.meta.url), "utf8")).cases;
export const secret = () => randomBytes(32).toString("base64url");
export const device = () => `d_${randomBytes(16).toString("base64url")}`;
export const destination = () => `wh_${randomBytes(16).toString("base64url")}`;
export const at = "2026-10-14T07:00:00Z";
export const sample = (extra = {}) => ({ uuid: randomUUID(), type: "steps", start: at, end: at, value: 1, unit: "count", ...extra });
export const summary = (extra = {}) => ({ type: "steps", unit: "count", start: at, end: "2026-10-15T07:00:00Z", stat: "sum", value: 0, ...extra });
export const authHeader = ({ auth, token }) => auth.kind === "header" ? { [auth.header_name]: token } : { Authorization: auth.kind === "basic" ? `Basic ${Buffer.from(`${auth.user}:${token}`).toString("base64")}` : `Bearer ${token}` };
export function signed(headers, body, hmac, now) {
  const out = new Headers(headers);
  out.set("X-Syncky-Timestamp", String(now));
  out.set("X-Syncky-Signature", `v1=${createHmac("sha256", hmac).update(`${now}.`).update(body).digest("hex")}`);
  return Object.fromEntries(out);
}

export async function fixture(t, options = {}) {
  const sql = openSqlite(options.path ?? ":memory:");
  t.after(() => sql.close());
  const store = createStore(sql);
  const config = { auth: { kind: "bearer" }, token: secret(), hmac: null, ...options };
  if (options.initialized !== false) store.initializeCredentials(await createUploadCredentials(config));
  const deps = { store, now: () => 1791961200 };
  const send = (request) => handle(request, deps);
  return { sql, store, config, deps, send };
}

export function native(f, extra = {}, headers = {}) {
  const id = randomUUID();
  const message = { v: 1, type: "sync", device: device(), samples: [], deleted: [], acks: [], more: false, delivery: { destination: destination(), id, index: 0, count: 1, sent_at: at }, ...extra };
  return messageRequest(f, message, headers);
}

export function messageRequest(f, message, extraHeaders = {}) {
  const body = JSON.stringify(message);
  let headers = { "Content-Type": "application/json", "X-Syncky-Format": "native", "X-Syncky-Delivery": message.delivery?.id ?? randomUUID(), "X-Syncky-Destination": message.delivery?.destination ?? destination(), ...authHeader(f.config), ...extraHeaders };
  if (f.config.hmac) headers = signed(headers, body, f.config.hmac, f.deps.now());
  return new Request("https://receiver.example/server", { method: "POST", headers, body });
}

export async function vectorFixture(t, c) {
  const auth = c.destination.auth.kind === "none" ? { kind: "bearer" } : c.destination.auth;
  return fixture(t, { auth, token: c.secrets.token ?? c.secrets.header_value ?? secret(), hmac: c.destination.signing ? c.secrets.hmac : null });
}

export function vectorRequest(f, r) {
  const headers = new Headers(r.headers);
  for (const [name, value] of Object.entries(authHeader(f.config))) headers.set(name, value);
  return new Request("https://receiver.example/server", { method: "POST", headers, body: r.body });
}

export function databasePath(t) {
  const dir = mkdtempSync(join(tmpdir(), "syncky-own-server-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "own-server.sqlite");
}

export const rows = (f, table) => f.sql.all(`SELECT * FROM ${table} ORDER BY rowid`);
export const equalJSON = (a, b) => JSON.stringify(a) === JSON.stringify(b);
