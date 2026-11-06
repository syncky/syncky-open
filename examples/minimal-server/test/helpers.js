import { createHmac } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createServer } from "../server.mjs";

export const SERVER = fileURLToPath(new URL("../server.mjs", import.meta.url));
const VECTORS = fileURLToPath(new URL("../../../protocol/test-vectors/", import.meta.url));

export const vectors = (name) => JSON.parse(readFileSync(join(VECTORS, `${name}.json`), "utf8")).cases;
export const requestCase = (name) => vectors("webhook-requests").find((c) => c.name === name);
export const exchangeCase = (name) => vectors("webhook-exchanges").find((c) => c.name === name);

export function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "syncky-minimal-server-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function caseOptions(c, dir) {
  return {
    dir,
    auth: c.destination.auth.kind,
    user: c.destination.auth.user ?? null,
    header: c.destination.auth.header_name ?? null,
    token: c.secrets.token ?? c.secrets.header_value ?? null,
    hmac: c.destination.signing ? c.secrets.hmac : null,
  };
}

export async function start(t, options) {
  const server = await createServer({ log: () => {}, ...options });
  t.after(() => server.close());
  return server;
}

export async function send(port, { method = "POST", path = "/syncky", headers = {}, body } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body });
  return { status: res.status, headers: res.headers, body: await res.text() };
}

export const lines = (file) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : []);
export const inbox = (dir) => (existsSync(join(dir, "inbox")) ? readdirSync(join(dir, "inbox")).sort() : []);

export function queue(dir, commands) {
  appendFileSync(join(dir, "outbox.jsonl"), commands.map((c) => `${JSON.stringify(c)}\n`).join(""));
}

export const water = (n, version = 1) => ({ command_id: `c_${n}`, version, op: "write", type: "dietary_water", value: 0.25, unit: "L", start: "2026-10-14T07:00:00Z", end: "2026-10-14T07:00:00Z" });

export function hmacHex(secret, text) {
  return createHmac("sha256", Buffer.from(secret, "utf8")).update(text, "utf8").digest("hex");
}

export function signed(headers, body, hmac, t) {
  const out = { ...headers, "X-Syncky-Timestamp": String(t) };
  out["X-Syncky-Signature"] = `v1=${hmacHex(hmac, `${t}.${body}`)}`;
  return out;
}

let deliveries = 0;
export function nativeRequest({ token, hmac, t, samples = [], deleted = [], test = false, device = "d_AAAAAAAAAAAAAAAAAAAAAA", kind = null }) {
  deliveries += 1;
  const delivery = `01a13940-fe30-7000-8000-${String(deliveries).padStart(12, "0")}`;
  const body = JSON.stringify({ v: 1, type: "sync", device, samples, deleted, acks: [], more: false, delivery: { destination: "wh_AAAAAAAAAAAAAAAAAAAAAA", id: delivery, index: 0, count: 1, sent_at: "2026-10-14T07:00:00Z", ...(test ? { test } : {}) } });
  const headers = { "Content-Type": "application/json", "X-Syncky-Format": "native", "X-Syncky-Delivery": delivery };
  if (kind) headers["X-Syncky-Kind"] = kind;
  if (token) headers.Authorization = `Bearer ${token}`;
  return { delivery, body, headers: hmac ? signed(headers, body, hmac, t) : headers };
}

export function resultsRequest({ token, hmac, t, results }) {
  deliveries += 1;
  const delivery = `01a13941-0000-7000-8000-${String(deliveries).padStart(12, "0")}`;
  const body = JSON.stringify({ v: 1, type: "results", results });
  const headers = { "Content-Type": "application/json", "X-Syncky-Kind": "results", "X-Syncky-Delivery": delivery };
  if (token) headers.Authorization = `Bearer ${token}`;
  return { body, headers: hmac ? signed(headers, body, hmac, t) : headers };
}

export function run(args, { env = {}, cwd } = {}) {
  const clean = { PATH: process.env.PATH, HOME: process.env.HOME, ...env };
  return spawnSync(process.execPath, [SERVER, ...args], { env: clean, cwd, encoding: "utf8" });
}
