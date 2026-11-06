#!/usr/bin/env node
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const MAX_BODY_BYTES = 1_000_000;
export const MAX_REPLY_BYTES = 60_000;
export const MAX_SKEW_S = 300;
const EXTENSIONS = { native: "json", hae: "json", csv: "csv", influx: "lp" };
const AUTH_KINDS = ["none", "bearer", "basic", "header"];
const URL_SCHEMES = ["syncky", "syncky-dev", "syncky-staging"];
const URL_SCHEME_ERROR = "url_scheme must be syncky, syncky-dev or syncky-staging";
const urlSchemeOf = (value) => URL_SCHEMES.includes(value) ? value : usage(URL_SCHEME_ERROR);
const UPSERT_TYPES = new Set(["characteristic", "activity_summary"]);
const DELIVERY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TIMESTAMP_RE = /^[0-9]{1,15}$/;
const TYPE_RE = /^[a-z][a-z0-9_]{1,63}$/;
const COMMAND_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const HEADER_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,256}$/;
const NUMBER_RE = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/;
const RFC3339_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{3})?Z$/;
const EMPTY_REPLY_BYTES = Buffer.byteLength('{"v":1,"type":"commands","commands":[]}');
const FILES = { samples: "samples.jsonl", deleted: "deleted.jsonl", outbox: "outbox.jsonl", results: "results.jsonl", inbox: "inbox" };
export function percentEncode(value) {
  const encode = (byte) => (/[A-Za-z0-9\-._~]/.test(String.fromCharCode(byte)) ? String.fromCharCode(byte) : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`);
  return [...Buffer.from(String(value), "utf8")].map(encode).join("");
}

export function buildLink(destination, secrets = {}, urlScheme = "syncky") {
  urlSchemeOf(urlScheme);
  const kind = destination.auth?.kind ?? "none";
  const need = (value, what) => (typeof value === "string" && value !== "" ? percentEncode(value) : usage(`the link needs ${what}`));
  const parts = ["v=1", `name=${percentEncode(destination.name)}`, `url=${percentEncode(destination.url)}`, `format=${destination.format}`, `auth=${kind}`];
  if (kind === "bearer") parts.push(`token=${need(secrets.token, "a token")}`);
  if (kind === "header") parts.push(`header=${need(destination.auth.header_name, "a header name")}`, `token=${need(secrets.header_value, "a header value")}`);
  if (kind === "basic") parts.push(`user=${need(destination.auth.user, "a user")}`, `token=${need(secrets.token, "a password")}`);
  if (destination.signing) parts.push(`hmac=${need(secrets.hmac, "an hmac secret")}`);
  if (destination.types) parts.push(`types=${destination.types.map(percentEncode).join(",")}`);
  return `${urlScheme}://webhook?${parts.join("&")}`;
}
const digest = (value) => createHash("sha256").update(String(value)).digest();
const sameValue = (a, b) => timingSafeEqual(digest(a), digest(b));
const hmacHex = (secret, prefix, body) => createHmac("sha256", Buffer.from(secret, "utf8")).update(prefix).update(body).digest("hex");
export const signBody = (secret, timestamp, body) => `v1=${hmacHex(secret, `${timestamp}.`, body)}`;
export const signReply = (secret, delivery, t, body) => `t=${t},v1=${hmacHex(secret, `${delivery}.${t}.`, body)}`;

export function verifySignature({ secret, timestamp, signature, body, now }) {
  if (typeof timestamp !== "string" || !TIMESTAMP_RE.test(timestamp) || typeof signature !== "string") return "bad_signature";
  if (!sameValue(signature, signBody(secret, timestamp, body))) return "bad_signature";
  return Math.abs(now - Number(timestamp)) > MAX_SKEW_S ? "stale" : "valid";
}
const readLines = (file) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
const appendLines = (file, lines) => appendFileSync(file, lines.map((line) => `${line}\n`).join(""), { mode: 0o600 });
const appendLine = (file, value) => appendLines(file, [JSON.stringify(value)]);
const isSync = (m) => m?.v === 1 && m.type === "sync" && typeof m.device === "string" && Array.isArray(m.samples) && Array.isArray(m.deleted);
const parseJson = (text) => { try { return JSON.parse(text); } catch { return null; } };

export function pendingCommands(dir) {
  const done = new Map();
  for (const r of readLines(join(dir, FILES.results))) done.set(r.command_id, Math.max(done.get(r.command_id) ?? 0, r.version));
  const latest = new Map();
  for (const c of readLines(join(dir, FILES.outbox))) {
    latest.delete(c.command_id);
    latest.set(c.command_id, c);
  }
  return [...latest.values()].filter((c) => (done.get(c.command_id) ?? 0) < c.version);
}

export function pickCommands(pending, limit = MAX_REPLY_BYTES) {
  const picked = [];
  let size = EMPTY_REPLY_BYTES;
  for (const command of pending) {
    const bytes = Buffer.byteLength(JSON.stringify(command)) + (picked.length > 0 ? 1 : 0);
    if (size + bytes > limit) break;
    size += bytes;
    picked.push(command);
  }
  return picked;
}
const sampleKey = (r) => `${r.device}|${r.uuid}`;
function remember(samples, record) {
  const key = sampleKey(record);
  if (!samples.has(key)) samples.set(key, new Map());
  samples.get(key).set(record.part ?? "", JSON.stringify(record));
}

function loadState(dir) {
  const state = { samples: new Map(), deleted: new Set(readLines(join(dir, FILES.deleted)).map(sampleKey)) };
  for (const record of readLines(join(dir, FILES.samples))) remember(state.samples, record);
  return state;
}

function storeNative(dir, state, message) {
  const out = { stored: 0, duplicates: 0, deleted: 0, invalid: 0 };
  const added = [];
  let rewrite = false;
  for (const sample of message.samples) {
    if (!sample || typeof sample.uuid !== "string" || typeof sample.type !== "string") {
      out.invalid += 1;
      continue;
    }
    const record = { device: message.device, ...sample };
    const line = JSON.stringify(record);
    const stored = state.samples.get(sampleKey(record))?.get(sample.part ?? "");
    if (stored !== undefined && (stored === line || !UPSERT_TYPES.has(sample.type))) {
      out.duplicates += 1;
      continue;
    }
    if (stored !== undefined) rewrite = true;
    remember(state.samples, record);
    state.deleted.delete(sampleKey(record));
    added.push(line);
    out.stored += 1;
  }
  for (const d of message.deleted) {
    if (!d || typeof d.uuid !== "string") continue;
    const key = sampleKey({ device: message.device, uuid: d.uuid });
    if (state.samples.delete(key)) rewrite = true;
    if (state.deleted.has(key)) continue;
    state.deleted.add(key);
    appendLine(join(dir, FILES.deleted), { device: message.device, uuid: d.uuid, type: d.type });
    out.deleted += 1;
  }
  const file = join(dir, FILES.samples);
  if (rewrite) {
    const all = [...state.samples.values()].flatMap((parts) => [...parts.values()]);
    writeFileSync(`${file}.tmp`, all.map((line) => `${line}\n`).join(""), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  } else appendLines(file, added);
  return out;
}

function isProbe(format, text, message) {
  if (format === "native") return message.delivery?.test === true;
  if (format === "hae") return Object.values(message.data).every((v) => Array.isArray(v) && v.length === 0);
  if (format === "csv") return text.split("\r\n").filter(Boolean).length <= 1;
  return text === "";
}

function authorized(req, { auth, user, header, token }) {
  if (auth === "none") return true;
  if (auth === "header") {
    const value = req.headers[header.toLowerCase()];
    return typeof value === "string" && sameValue(value, token);
  }
  const expected = auth === "basic" ? `Basic ${Buffer.from(`${user}:${token}`, "utf8").toString("base64")}` : `Bearer ${token}`;
  return typeof req.headers.authorization === "string" && sameValue(req.headers.authorization, expected);
}

function readBody(req) {
  const chunks = [];
  let size = 0;
  return new Promise((done, fail) => {
    req.on("data", (chunk) => (size += chunk.length) <= MAX_BODY_BYTES && chunks.push(chunk));
    req.on("end", () => done(size > MAX_BODY_BYTES ? null : Buffer.concat(chunks)));
    req.on("error", fail);
  });
}
const counted = (counts) => Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(" ");

export async function createServer({ dir, port = 0, bind = "127.0.0.1", auth = "bearer", user = null, header = null, token = null, hmac = null,
  now = () => Math.floor(Date.now() / 1000), log = (line) => process.stdout.write(`${line}\n`) } = {}) {
  if (!dir) throw new Error("createServer needs a dir");
  if (!AUTH_KINDS.includes(auth)) throw new Error(`auth must be one of ${AUTH_KINDS.join(", ")}`);
  if (auth !== "none" && !token) throw new Error(`auth ${auth} needs a token`);
  if (auth === "basic" && (!user || user.includes(":"))) throw new Error("auth basic needs a user without a colon");
  if (auth === "header" && !HEADER_RE.test(header ?? "")) throw new Error("auth header needs a header name");
  mkdirSync(join(dir, FILES.inbox), { recursive: true, mode: 0o700 });
  let state = loadState(dir);
  let stale = false;
  async function handle(req, res) {
    const entry = { kind: "data", format: "-", counts: {} };
    const finish = (status, code = null, body = "", headers = {}) => {
      const text = code ? JSON.stringify({ ok: false, code }) : body;
      const sent = code ? { "Content-Type": "application/json" } : headers;
      res.writeHead(status, { ...sent, "Content-Length": Buffer.byteLength(text) });
      res.end(text);
      log([new Date(now() * 1000).toISOString(), entry.kind, entry.format, counted(entry.counts), status, code].filter((p) => p !== null && p !== "").join(" "));
    };
    const path = (req.url ?? "/").split("?")[0];
    if (req.method !== "POST") {
      req.resume();
      entry.kind = req.method === "GET" ? "get" : "other";
      if (req.method !== "GET") return finish(405, "method_not_allowed");
      return path === "/health" ? finish(200, null, '{"ok":true}', { "Content-Type": "application/json" }) : finish(404, "not_found");
    }
    const format = req.headers["x-syncky-format"];
    if (Object.hasOwn(EXTENSIONS, format)) entry.format = format;
    if (req.headers["x-syncky-kind"] === "results") entry.kind = "results";
    const body = await readBody(req);
    if (body === null) return finish(413, "payload_too_large");
    if (!authorized(req, { auth, user, header, token })) return finish(401, "unauthorized");
    if (hmac) {
      const signature = req.headers["x-syncky-signature"];
      const verdict = signature === undefined ? "unsigned" : verifySignature({ secret: hmac, timestamp: req.headers["x-syncky-timestamp"], signature, body, now: now() });
      if (verdict !== "valid") return finish(401, verdict);
    }
    const text = body.toString("utf8");
    if (entry.kind === "results") return results(text, entry, finish);
    if (entry.format === "-") return finish(400, "unknown_format");
    const message = format === "native" || format === "hae" ? parseJson(text) : null;
    if (format === "native" && !isSync(message)) return finish(400, "not_sync");
    if (format === "hae" && (typeof message?.data !== "object" || message.data === null)) return finish(400, "not_hae");
    if (isProbe(format, text, message)) entry.kind = "test";
    if (entry.kind === "test") return finish(200);
    if (stale) [state, stale] = [loadState(dir), false];
    if (format === "native") entry.counts = storeNative(dir, state, message);
    else {
      const delivery = req.headers["x-syncky-delivery"];
      const name = DELIVERY_RE.test(delivery ?? "") ? delivery : randomUUID();
      writeFileSync(join(dir, FILES.inbox, `${name}.${EXTENSIONS[format]}`), body, { mode: 0o600 });
      entry.counts = { bytes: body.length };
    }
    const commands = pickCommands(pendingCommands(dir));
    entry.counts.commands = commands.length;
    if (commands.length === 0) return finish(200);
    const reply = JSON.stringify({ v: 1, type: "commands", commands });
    const headers = { "Content-Type": "application/json" };
    if (hmac) headers["X-Syncky-Signature"] = signReply(hmac, req.headers["x-syncky-delivery"] ?? "", now(), reply);
    return finish(200, null, reply, headers);
  }
  function results(text, entry, finish) {
    const message = parseJson(text);
    const valid = (r) => r && COMMAND_ID_RE.test(r.command_id) && Number.isInteger(r.version) && r.version >= 1 && typeof r.status === "string";
    if (message?.v !== 1 || message.type !== "results" || !Array.isArray(message.results) || !message.results.every(valid)) return finish(400, "not_results");
    const file = join(dir, FILES.results);
    const seen = new Set(readLines(file).map((r) => `${r.command_id}|${r.version}`));
    entry.counts = { results: message.results.length, new: 0 };
    for (const r of message.results) {
      if (seen.has(`${r.command_id}|${r.version}`)) continue;
      seen.add(`${r.command_id}|${r.version}`);
      appendLine(file, { at: new Date(now() * 1000).toISOString(), command_id: r.command_id, version: r.version, status: r.status, ...(r.reason ? { reason: r.reason } : {}) });
      entry.counts.new += 1;
    }
    return finish(200);
  }
  const server = createHttpServer((req, res) =>
    handle(req, res).catch(() => {
      stale = true;
      if (res.headersSent) return res.destroy();
      res.writeHead(500, { "Content-Type": "application/json" }).end('{"ok":false,"code":"internal"}');
      log(`${new Date(now() * 1000).toISOString()} error - 500 internal`);
    }),
  );
  await new Promise((done, fail) => server.once("error", fail).listen(port, bind, () => done(server.off("error", fail))));
  const close = () => new Promise((done) => server.close(() => done()).closeAllConnections());
  return { port: server.address().port, close };
}
const USAGE = `usage: server.mjs <command> [options]
  init                                       create the data dir and its token and hmac files (mode 600)
  serve [--port 3000] [--bind 127.0.0.1]     accept Syncky deliveries on any path (POST), GET /health
  link [--host <name>.local] [--port 3000] [--format native|hae|csv|influx] [--name <name>] [--url-scheme syncky|syncky-dev|syncky-staging]
                                             print the setup link for the iPhone (it contains the secrets)
  write [--at <rfc3339>] [--] <type> <value> <unit>  queue a Health write for the next reply (-- before a negative value)
  delete <command_id>                        queue the deletion of a record a write created
  status                                     counts of what is stored and queued
options for every command: --data <dir> (default ./syncky-data)
auth for serve and link: --auth none|bearer|basic|header (default bearer), --user <name>, --header <Name>
link scheme: --url-scheme > SYNCKY_URL_SCHEME > <data>/config.json url_scheme > syncky
example: server.mjs link --url-scheme syncky-dev
secrets: SYNCKY_SERVER_TOKEN and SYNCKY_SERVER_HMAC, else the token and hmac files in the data dir`;
class UsageError extends Error {}
const usage = (message) => {
  throw new UsageError(message);
};
const OPTIONS = Object.fromEntries(["data", "port", "bind", "auth", "user", "header", "host", "format", "name", "at", "url-scheme"].map((k) => [k, { type: "string" }]));
function linkScheme(dir, values) {
  let config = {};
  try { config = JSON.parse(readFileSync(join(dir, "config.json"), "utf8")); }
  catch (error) { if (error.code !== "ENOENT") usage("config.json must contain a JSON object"); }
  if (!config || typeof config !== "object" || Array.isArray(config)) usage("config.json must contain a JSON object");
  return urlSchemeOf(values["url-scheme"] ?? (process.env.SYNCKY_URL_SCHEME || null) ?? config.url_scheme ?? "syncky");
}

function readSecret(dir, name, variable) {
  if (process.env[variable]) return process.env[variable];
  const file = join(dir, name);
  return existsSync(file) ? readFileSync(file, "utf8").trim() || null : null;
}
function authOptions(values, dir) {
  const auth = values.auth ?? "bearer";
  if (!AUTH_KINDS.includes(auth)) usage("--auth must be none, bearer, basic or header");
  if (auth === "basic" && (!values.user || values.user.includes(":"))) usage("--auth basic needs --user <name> without a colon");
  if (auth === "header" && !HEADER_RE.test(values.header ?? "")) usage("--auth header needs --header <Name>");
  const token = auth === "none" ? null : readSecret(dir, "token", "SYNCKY_SERVER_TOKEN");
  if (auth !== "none" && !token) throw new Error("no token: run init or set SYNCKY_SERVER_TOKEN");
  return { auth, user: values.user ?? null, header: values.header ?? null, token, hmac: readSecret(dir, "hmac", "SYNCKY_SERVER_HMAC") };
}

function portOf(value) {
  const port = Number(value ?? 3000);
  if (!/^[0-9]{1,5}$/.test(value ?? "3000") || port > 65535) usage("--port must be 0 to 65535");
  return port;
}

function init(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const [name, prefix] of [["token", "srv_"], ["hmac", "whsec_"]]) {
    const file = join(dir, name);
    if (!existsSync(file)) writeFileSync(file, `${prefix}${randomBytes(32).toString("base64url")}\n`, { mode: 0o600 });
  }
  process.stdout.write(`${dir}: token and hmac files ready (mode 600)\n`);
}

async function serve(dir, values) {
  const port = portOf(values.port);
  const options = authOptions(values, dir);
  const bind = values.bind ?? "127.0.0.1";
  const server = await createServer({ dir, port, bind, ...options });
  process.stdout.write(`listening on ${bind}:${server.port}, auth ${options.auth}, ${options.hmac ? "signed" : "unsigned"} requests\n`);
  const stop = () => server.close().then(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

function link(dir, values) {
  const urlScheme = linkScheme(dir, values);
  const o = authOptions(values, dir);
  const format = values.format ?? "native";
  if (!Object.hasOwn(EXTENSIONS, format)) usage("--format must be native, hae, csv or influx");
  const host = values.host ?? `${hostname().replace(/\.local$/, "")}.local`;
  const destination = {
    name: values.name ?? "Minimal server",
    url: `http://${host}:${portOf(values.port)}/syncky`,
    format,
    auth: { kind: o.auth, user: o.user, header_name: o.header },
    signing: Boolean(o.hmac),
    types: null,
  };
  const secrets = o.auth === "header" ? { header_value: o.token, hmac: o.hmac } : { token: o.token, hmac: o.hmac };
  process.stdout.write(`${buildLink(destination, secrets, urlScheme)}\n`);
  process.stderr.write("Open this link on the iPhone (Connections › + › Paste a setup link), or show it as a QR code, for example with: qrencode -t ansiutf8\n");
}

function write(dir, [type, value, unit], values) {
  if (!TYPE_RE.test(type)) usage("<type> must be a Syncky type name such as dietary_water");
  if (!NUMBER_RE.test(value) || !Number.isFinite(Number(value))) usage("<value> must be a decimal number");
  if (!/^\S{1,32}$/.test(unit)) usage("<unit> must be a unit such as L or count");
  const at = values.at ?? new Date().toISOString().replace(/\.[0-9]{3}Z$/, "Z");
  if (!RFC3339_RE.test(at) || Number.isNaN(Date.parse(at))) usage("--at must be an RFC 3339 UTC time such as 2026-10-14T07:00:00Z");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, FILES.outbox);
  const ids = new Set(readLines(file).map((c) => c.command_id));
  let n = ids.size + 1;
  while (ids.has(`c_${n}`)) n += 1;
  appendLine(file, { command_id: `c_${n}`, version: 1, op: "write", type, value: Number(value), unit, start: at, end: at });
  process.stdout.write(`queued c_${n} version 1\n`);
}

function remove(dir, [id]) {
  const file = join(dir, FILES.outbox);
  const latest = readLines(file).filter((c) => c.command_id === id).at(-1);
  if (!latest) usage(`no command ${id} in the outbox`);
  if (latest.op === "delete") usage(`${id} is already deleted`);
  appendLine(file, { command_id: id, version: latest.version + 1, op: "delete", type: latest.type });
  process.stdout.write(`queued ${id} version ${latest.version + 1}\n`);
}

function status(dir) {
  const count = (name) => readLines(join(dir, name)).length;
  const inbox = existsSync(join(dir, FILES.inbox)) ? readdirSync(join(dir, FILES.inbox)).length : 0;
  const commands = new Set(readLines(join(dir, FILES.outbox)).map((c) => c.command_id)).size;
  process.stdout.write(
    `samples ${count(FILES.samples)}\ndeleted ${count(FILES.deleted)}\ninbox ${inbox}\n` +
      `commands ${commands} (${pendingCommands(dir).length} waiting for a result)\nresults ${count(FILES.results)}\n`,
  );
}

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    if (error.message.startsWith("Option '--url-scheme")) usage(URL_SCHEME_ERROR);
    usage(error.message.split(".")[0]);
  }
  const { values, positionals: [command, ...rest] } = parsed;
  if (command !== "link" && Object.hasOwn(values, "url-scheme")) usage("--url-scheme is only valid for link");
  const dir = resolve(values.data ?? "syncky-data");
  const want = (n) => rest.length === n || usage(`${command} takes ${n} argument${n === 1 ? "" : "s"}`);
  if (command === "init" && want(0)) return init(dir);
  if (command === "serve" && want(0)) return serve(dir, values);
  if (command === "link" && want(0)) return link(dir, values);
  if (command === "write" && want(3)) return write(dir, rest, values);
  if (command === "delete" && want(1)) return remove(dir, rest);
  if (command === "status" && want(0)) return status(dir);
  usage(command ? `unknown command: ${command}` : "missing command");
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch((error) => {
    const isUsage = error instanceof UsageError;
    process.stderr.write(isUsage ? `${error.message}\n${USAGE}\n` : `error: ${error instanceof SyntaxError ? "a file in the data dir is not valid JSON lines" : error.message}\n`);
    process.exit(isUsage ? 2 : 1);
  });
}
