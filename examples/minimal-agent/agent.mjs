#!/usr/bin/env node
import { createHash, createHmac, getRandomValues, timingSafeEqual } from "node:crypto";
import { chmodSync, linkSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { CipherSuite, HkdfSha256 } from "@hpke/core";
import { DhkemX25519HkdfSha256 } from "@hpke/dhkem-x25519";
import { Chacha20Poly1305 } from "@hpke/chacha20poly1305";
import qrcode from "qrcode-terminal";
const USAGE = `usage: agent.mjs <command> [options]
  init --relay <url> [--invite <invite>] [--name <name>]
  pair [--wait <seconds>]
  poll [--once]
  send-water <liters> --to <member_id>
  status
state: $SYNCKY_HOME/state.json (default ./.syncky-minimal)
exit codes: 0 ok, 1 relay/protocol error, 2 bad arguments, 3 not initialized`;
const MEMBER_ID_RE = /^m_(agent|dev)_[1-9][0-9]{0,5}$/;
const exitError = (exit, message) => Object.assign(new Error(message), { exit });
const usage = (message) => exitError(2, `${message}\n${USAGE}`);
// State: one JSON file, readable only by the owner because it holds the bearer token and the private key.
export function loadState(home) {
  const file = join(home, "state.json");
  try { if (statSync(file).mode & 0o077) throw new Error("state.json must be private (chmod 600)"); } catch (err) { if (err.code === "ENOENT") return null; throw err; }
  try { return JSON.parse(readFileSync(file, "utf8")); } catch (err) { throw err instanceof SyntaxError ? new Error("state.json is not valid JSON; restore it or remove it and run init again") : err; }
}
export function saveState(home, state) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  const file = join(home, "state.json");
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}
// poll may run beside pair or send-water, so each change re-reads state.json under state.lock, which holds its owner's pid. Only the waiter holding state.lock.claim may remove a lock whose owner is gone; a claim whose owner is gone is left for the user, because two waiters removing it could each delete the other's fresh claim.
export function updateState(home, change) {
  const lock = join(home, "state.lock"), claim = `${lock}.claim`, me = String(process.pid), mine = `${lock}.${me}`;
  const dead = (file) => { const owner = readFileSync(file, "utf8"); try { return owner === me || !process.kill(Number(owner), 0); } catch (err) { return err.code === "ESRCH"; } };
  const take = (file) => { try { return linkSync(mine, file), true; } catch (err) { if (err.code === "EEXIST") return false; throw err; } };
  writeFileSync(mine, me, { mode: 0o600 });
  try {
    for (; !take(lock); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)) {
      try {
        if (!dead(lock)) continue;
        if (!take(claim)) { if (dead(claim)) throw new Error(`${claim} was left by a process that is no longer running; remove it and retry`); continue; }
        try { if (dead(lock)) unlinkSync(lock); } finally { unlinkSync(claim); }
      } catch (err) { if (err.code !== "ENOENT") throw err; }
    }
  } finally { unlinkSync(mine); }
  try { const state = loadState(home); change(state); saveState(home, state); return state; } finally { try { if (readFileSync(lock, "utf8") === me) unlinkSync(lock); } catch {} }
}
// Encoding, keys and ids
const fail = (code, message) => Object.assign(new Error(message), { code });
const utf8 = (text) => new TextEncoder().encode(text);
const randomBytes = (n) => getRandomValues(new Uint8Array(n));
const nowText = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const clean = (text) => String(text).slice(0, 64).replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, "?");
export const b64u = (bytes) => Buffer.from(bytes).toString("base64url");
// Buffer.from(_, "base64url") is lenient (accepts padding, skips junk), so reject anything that does not re-encode identically.
export function unb64u(text, length) {
  const bytes = typeof text === "string" && /^[A-Za-z0-9_-]*$/.test(text) ? new Uint8Array(Buffer.from(text, "base64url")) : null;
  if (!bytes || b64u(bytes) !== text || (length !== undefined && bytes.length !== length)) {
    throw fail("malformed", `not base64url${length === undefined ? "" : ` of ${length} bytes`}`);
  }
  return bytes;
}
const suite = new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Chacha20Poly1305() });
const importPrivate = (sk) => suite.kem.deserializePrivateKey(unb64u(sk, 32));
const importPublic = (pk) => suite.kem.deserializePublicKey(unb64u(pk, 32));
export async function generateKeys() {
  const { privateKey, publicKey } = await suite.kem.generateKeyPair();
  const raw = async (bytes) => b64u(new Uint8Array(await bytes));
  return { sk: await raw(suite.kem.serializePrivateKey(privateKey)), pk: await raw(suite.kem.serializePublicKey(publicKey)) };
}

export function uuidv7(now = Date.now()) {
  const b = randomBytes(16);
  b.set(Buffer.from(now.toString(16).padStart(12, "0"), "hex"));
  [b[6], b[8]] = [0x70 | (b[6] & 0x0f), 0x80 | (b[8] & 0x3f)];
  const h = Buffer.from(b).toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// Pairing code and proof, both derived from the link's secret c (16 bytes, base64url).
export function pairCode(c) {
  const d = createHash("sha256").update(`syncky-code-v2|${c}`).digest();
  return [0, 2, 4].map((i) => String(d.readUInt16BE(i) % 1000).padStart(3, "0")).join(" ");
}

export const pairProof = (c, agentPk, devicePk) => b64u(createHmac("sha256", unb64u(c, 16)).update(`syncky-pair-v2|${agentPk}|${devicePk}`).digest());

// Envelopes: one random CEK encrypts the inner JSON; each recipient gets the CEK through HPKE Auth mode.
const CEK_INFO = utf8("syncky-cek-v1");
export const envelopeAad = (hubId, msgId, from, kind = "data", diagnostics, access) => `syncky-v1|${hubId}|${msgId}|${from}${kind === "control" ? "|control" : ""}${diagnostics === undefined ? "" : `|diagnostics=${diagnostics}`}${access === undefined ? "" : `|access=${access}`}`;
const validMarker = e => (!Object.hasOwn(e, "access") || !Object.hasOwn(e, "diagnostics") && e.kind === "control" && ["request", "reply"].includes(e.access)) && (!Object.hasOwn(e, "diagnostics") || (e.diagnostics === "archive" ? e.kind === "data" : ["request", "reply"].includes(e.diagnostics) && e.kind === "control"));

export async function sealEnvelope({ hubId, from, sk, recipients, plaintext, msgId = uuidv7(), kind = "data", diagnostics, access }) {
  if (!validMarker({ kind, ...(diagnostics === undefined ? {} : { diagnostics }), ...(access === undefined ? {} : { access }) })) throw fail("invalid_input", "invalid marker");
  const aad = utf8(envelopeAad(hubId, msgId, from, kind, diagnostics, access));
  const [cek, nonce] = [randomBytes(32), randomBytes(12)];
  const senderKey = await importPrivate(sk);
  const sealed = [];
  for (const r of recipients) {
    const ctx = await suite.createSenderContext({ recipientPublicKey: await importPublic(r.pk), senderKey, info: CEK_INFO });
    const wrapped = new Uint8Array(await ctx.seal(cek, aad));
    sealed.push({ member_id: r.member_id, enc: b64u(new Uint8Array(ctx.enc)), wrapped_key: b64u(wrapped) });
  }
  const ciphertext = new Uint8Array(await new Chacha20Poly1305().createEncryptionContext(cek).seal(nonce, utf8(plaintext), aad));
  cek.fill(0);
  return { v: 1, msg_id: msgId, kind, ...(access === undefined ? {} : { access }), ...(diagnostics === undefined ? {} : { diagnostics }), from, created_at: nowText(), recipients: sealed, nonce: b64u(nonce), ciphertext: b64u(ciphertext) };
}

// The sender key comes only from `registry` (confirmed keys, or the joined key for its pair_proof), never from the envelope or the relay.
export async function openEnvelope(e, { hubId, memberId, sk, registry, kind = "data" }) {
  if (e?.v !== 1 || !["data", "control"].includes(kind) || !validMarker(e) || e.kind !== kind || typeof e.msg_id !== "string" || typeof e.from !== "string") throw fail("malformed", "not an envelope");
  if (!Array.isArray(e.recipients) || e.recipients.length < 1) throw fail("malformed", "no recipients");
  const mine = e.recipients.find((r) => r?.member_id === memberId);
  if (!mine) throw fail("not_a_recipient", "this member is not a recipient");
  if (!Object.hasOwn(registry, e.from)) throw fail("unknown_sender", "sender is not a confirmed member");
  const [enc, wrapped, nonce, ciphertext] = [unb64u(mine.enc, 32), unb64u(mine.wrapped_key, 48), unb64u(e.nonce, 12), unb64u(e.ciphertext)];
  if (ciphertext.length < 16) throw fail("malformed", "ciphertext shorter than the tag");
  const aad = utf8(envelopeAad(hubId, e.msg_id, e.from, kind, e.diagnostics, e.access));
  let cek;
  try {
    const senderPublicKey = await importPublic(registry[e.from]);
    const ctx = await suite.createRecipientContext({ recipientKey: await importPrivate(sk), enc, info: CEK_INFO, senderPublicKey });
    cek = new Uint8Array(await ctx.open(wrapped, aad));
  } catch {
    throw fail("hpke_open_failed", "cannot unwrap the content key");
  }
  try {
    const plain = await new Chacha20Poly1305().createEncryptionContext(cek).open(nonce, ciphertext, aad);
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(plain);
    let inner; try { inner = JSON.parse(text); } catch { if (Object.hasOwn(e, "access")) throw fail("inner_invalid", "invalid marked inner"); }
    if (Object.hasOwn(e, "access") ? inner?.v !== 1 || inner.type !== `access_${e.access}` : ["access_request", "access_reply"].includes(inner?.type)) throw fail("inner_invalid", "invalid marked inner");
    return text;
  } catch (err) {
    if (err.code === "inner_invalid") throw err;
    throw fail("aead_failed", "cannot decrypt the payload");
  } finally {
    cek.fill(0);
  }
}

const PAIR_SCHEMES = ["syncky", "syncky-dev", "syncky-staging"];
const PAIR_KEYS = new Set("vrhtkncs");
const isB64u = (v, length) => { try { return !!unb64u(v, length); } catch { return false; } };
const RELAY_RE = /^(?:[A-Za-z0-9.-]{1,253}|\[[0-9A-Fa-f:.]{2,45}\])(?::([1-9][0-9]{0,4}))?$/;
const PAIR_CHECKS = {
  r: (v) => { const m = RELAY_RE.exec(v); return !!m && (m[1] === undefined || Number(m[1]) <= 65535); },
  h: (v) => /^hub_[A-Za-z0-9_-]{22}$/.test(v),
  t: (v) => /^pt_[A-Za-z0-9_-]{43}$/.test(v),
  k: (v) => isB64u(v, 32),
  n: (v) => v.length >= 1 && v.length <= 64,
};
const pctEncode = (v) => encodeURIComponent(v).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export function parsePairUri(uri, allowInsecure = false) {
  const bad = (param) => ({ ok: false, error: "invalid_uri", param });
  const prefix = typeof uri === "string" && PAIR_SCHEMES.find((s) => uri.startsWith(`${s}://`));
  if (!prefix) return bad("scheme");
  const rest = uri.slice(prefix.length + 3);
  const query = rest.search(/[?#]/);
  const end = query < 0 ? rest.length : query;
  if (rest.slice(0, end) !== "pair") return bad("host");
  if (rest.includes("#")) return bad("fragment");
  const p = {};
  for (const segment of rest.slice(end + 1).split("&")) {
    const eq = segment.indexOf("=");
    const key = segment.slice(0, eq);
    if (eq < 0 || !PAIR_KEYS.has(key)) continue;
    if (Object.hasOwn(p, key)) return bad(key);
    try { p[key] = decodeURIComponent(segment.slice(eq + 1)); } catch { return bad("encoding"); }
    if (!p[key].isWellFormed()) return bad("encoding");
  }
  if (p.v === undefined) return bad("v");
  if (p.v !== "1" && p.v !== "2") return { ok: false, error: "unsupported_version" };
  for (const key of Object.keys(PAIR_CHECKS)) if (p[key] === undefined) return bad(key);
  if (p.v === "2" && p.c === undefined) return bad("c");
  for (const [key, check] of Object.entries(PAIR_CHECKS)) if (!check(p[key])) return bad(key);
  if (p.v === "2" && !isB64u(p.c, 16)) return bad("c");
  if (p.s !== undefined && p.s !== "http") return bad("s");
  if (p.s !== undefined && !allowInsecure) return { ok: false, error: "insecure_relay" };
  const relay_base = `${p.s ? "http" : "https"}://${p.r}`;
  return { ok: true, relay_base, hub_id: p.h, pairing_token: p.t, agent_public_key: p.k, agent_name: p.n, ...(p.v === "2" && { pair_secret: p.c }) };
}

export function buildPairUri({ relay_base, hub_id, pairing_token, agent_public_key, agent_name, pair_secret, url_scheme = "syncky" }) {
  if (!PAIR_SCHEMES.includes(url_scheme)) throw new TypeError("url scheme must be syncky, syncky-dev or syncky-staging");
  const query = { r: relay_base.replace(/^https?:\/\//, ""), h: hub_id, t: pairing_token, k: agent_public_key, n: agent_name, ...(pair_secret && { c: pair_secret }) };
  const params = Object.entries(query).map(([key, value]) => `&${key}=${pctEncode(value)}`).join("");
  return `${url_scheme}://pair?v=${pair_secret ? 2 : 1}${params}${relay_base.startsWith("http://") ? "&s=http" : ""}`;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
export async function relayCall(state, method, path, { body, headers = {} } = {}) {
  const init = { method, body, headers: { Accept: "application/json", ...headers } };
  if (state.token) init.headers.Authorization = `Bearer ${state.token}`;
  if (body !== undefined) init.headers["Content-Type"] = "application/json; charset=utf-8";
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${state.relay}${path}`, { ...init, signal: AbortSignal.timeout(15_000) }).catch((err) => {
      throw fail("network_error", `relay unreachable: ${err.cause?.code ?? err.name}`);
    });
    const json = res.status === 204 ? null : await res.json().catch(() => undefined);
    if (res.ok && json !== undefined) return json;
    if (res.ok) throw fail("invalid_response", `relay ${res.status}: the body is not JSON`);
    const header = res.headers.get("retry-after") ?? "";
    const wait = /^[0-9]{1,5}$/.test(header) ? Number(header) : 1;
    if (attempt === 1 && (res.status === 429 || res.status >= 500) && wait <= 60) { await sleep(wait * 1000); continue; }
    const code = typeof json?.error === "string" ? clean(json.error) : "relay_error";
    const hint = code === "invalid_token" ? " (token revoked or the hub was deleted: no plan within 7 days or 7 days after the plan ended; remove state.json, then init and pair again)" : "";
    throw fail(code, `relay ${res.status} ${code}: ${clean(json?.message ?? "no message")}${hint}`);
  }
}

// E1: register (with the invite only if this relay requires one); the relay creates a hub and returns this agent's bearer token.
async function init(home, { relay, invite = process.env.SYNCKY_INVITE, name }) {
  const keys = await generateKeys();
  const body = JSON.stringify({ name, public_key: keys.pk });
  const reg = await relayCall({ relay }, "POST", "/v1/agents/register", { body, headers: invite ? { "X-Syncky-Invite": invite } : {} });
  const valid = /^hub_[\w-]{22}$/.test(reg?.hub_id) && MEMBER_ID_RE.test(reg.member_id) && reg.token?.startsWith(`sk_${reg.hub_id}_`);
  if (!valid) throw fail("invalid_response", "the relay returned a malformed registration");
  const { hub_id, member_id, token } = reg;
  saveState(home, { relay, name, hub_id, member_id, token, sk: keys.sk, pk: keys.pk, webhook_url: null, last_seq: 0, acked_seq: 0, members: {}, commands: {} });
  console.log(`Registered ${member_id} in ${hub_id}. Next: pair`);
}

// E2 + E3: show the pairing URI with a fresh secret c as a QR code, print its code and wait for the phone to join.
async function waitForPhone(state, deadline) {
  const p = await relayCall(state, "POST", "/v1/pairings", { body: "{}" });
  if (!/^p_[\w-]{22}$/.test(p?.pairing_id) || !/^pt_[\w-]{43}$/.test(p.pairing_token)) throw fail("invalid_response", "malformed pairing");
  const c = b64u(randomBytes(16));
  const uri = buildPairUri({ relay_base: state.relay, hub_id: state.hub_id, pairing_token: p.pairing_token, agent_public_key: state.pk, agent_name: state.name, pair_secret: c });
  // qrcode-terminal 0.12.0 ignores setErrorLevel("M") because M is 0, so set the level directly.
  qrcode.error = 0;
  qrcode.generate(uri, { small: true }, (qr) => console.log(qr));
  console.log(`${uri}\ncode: ${pairCode(c)}\nScan this with the Syncky app; the phone confirms by picking this code. Waiting for the phone...`);
  for (; ; await sleep(2000)) {
    const s = await relayCall(state, "GET", `/v1/pairings/${p.pairing_id}`);
    if (s?.status === "completed") {
      if (!MEMBER_ID_RE.test(s.member_id) || !PAIR_CHECKS.k(s.public_key)) throw fail("invalid_response", "malformed pairing status");
      return [s.member_id, { name: clean(s.device_name ?? "phone"), pk: s.public_key, state: "joined" }, pairProof(c, state.pk, s.public_key)];
    }
    if (s?.status !== "pending") throw fail("pairing_expired", "the pairing expired; run pair again");
    if (Date.now() >= deadline) throw fail("timeout", "no phone joined in time; run pair again");
  }
}

const settle = (home, id, to) => updateState(home, ({ members: { [id]: m } }) => { if (m.state === "joined") m.state = to; delete m.proof; });

// E9: a phone that cannot prove the pairing secret must not stay in the hub, where it would keep receiving the agent's messages.
async function revoke(home, state, id) {
  await relayCall(state, "DELETE", `/v1/members/${id}`).catch((err) => err.code === "not_found" || Promise.reject(err));
  settle(home, id, "rejected");
}

// A joined phone without a stored proof joined a link whose secret is gone (an earlier pair ended first): nothing can confirm it.
async function pair(home, state, { wait = "600" }) {
  const deadline = Date.now() + Number(wait) * 1000;
  for (const [id, m] of Object.entries(state.members)) if (m.state === "joined" && !m.proof) await revoke(home, state, id);
  const [id, joined, proof] = await waitForPhone(state, deadline);
  updateState(home, (s) => {
    if (Object.hasOwn(s.members, id) && s.members[id].pk !== joined.pk) throw fail("key_conflict", `${id} is known with another key`);
    Object.assign((s.members[id] ??= joined), { proof });
  });
  console.log(`Device "${joined.name}" (${id}) joined. Waiting for it to pick the code...`);
  for (; ; await sleep(2000)) {
    await pollOnce(home, true);
    const m = loadState(home).members[id];
    if (m.state === "confirmed") return console.log(`Confirmed ${id}. Next: poll`);
    if (m.state === "rejected") throw fail("pair_proof_invalid", `${id} sent a proof that does not match this link and was revoked; run pair again`);
    if (m.state !== "joined") throw fail("member_revoked", `${id} left (a wrong pick on the phone cancels the pairing); run pair again`);
    if (Date.now() >= deadline) throw fail("timeout", `${id} has not picked the code in time; poll still confirms it when it does`);
  }
}

// E11 + E12: fetch pages in seq order, process, persist, then ack up to the last processed seq (resent until it succeeds).
export async function handleMessage(home, state, msg) {
  const tag = `seq ${msg.seq}`;
  const sender = Object.hasOwn(state.members, msg.from) ? state.members[msg.from] : null;
  const proofCheck = msg.kind === "control" && sender?.state === "joined" && !!sender.proof;
  if (!validMarker(msg)) return console.log(`${tag}: skipped (malformed)`);
  if (msg.kind === "control" && !proofCheck && !Object.hasOwn(msg, "access")) return console.log(`${tag}: skipped (control message)`);
  let inner;
  if (msg.kind !== "system") {
    const registry = proofCheck ? { [msg.from]: sender.pk } : Object.fromEntries(Object.entries(state.members).filter(([, m]) => m.state === "confirmed").map(([id, m]) => [id, m.pk]));
    inner = await openEnvelope(msg, { hubId: state.hub_id, memberId: state.member_id, sk: state.sk, registry, kind: msg.kind }).then(JSON.parse).catch((err) => err);
    if (inner instanceof Error) return console.log(`${tag}: skipped (${inner.code ?? "inner_invalid"})`);
    if (Object.hasOwn(msg, "diagnostics") && (inner?.v !== 1 || inner.type !== ({ archive: "diagnostics", request: "diagnostics_request", reply: "diagnostics_reply" })[msg.diagnostics])) return console.log(`${tag}: skipped (inner_invalid)`);
    if (Object.hasOwn(msg, "access")) return console.log(`${tag}: skipped (control message)`);
    if (proofCheck) return checkProof(home, state, msg, sender, inner);
    if (inner?.v !== 1 || inner.type !== "sync" || inner.device !== msg.from) return console.log(`${tag}: skipped (${Number.isInteger(inner?.v) && inner.v !== 1 ? "unsupported_version" : "inner_invalid"})`);
  }
  const members = msg.kind === "system" && msg.event === "member_revoked" ? (await relayCall(state, "GET", "/v1/members"))?.members : [];
  if (!Array.isArray(members) || !members.every((m) => MEMBER_ID_RE.test(m?.member_id))) throw fail("invalid_response", "malformed member list");
  updateState(home, (state) => {
    if (msg.kind === "system") {
      const b = msg.body ?? {};
      const known = Object.hasOwn(state.members, b.member_id) ? state.members[b.member_id] : null;
      if (msg.event === "member_joined" && !known && MEMBER_ID_RE.test(b.member_id) && PAIR_CHECKS.k(b.public_key)) {
        state.members[b.member_id] = { name: clean(b.device_name ?? "phone"), pk: b.public_key, state: "joined" };
        return console.log(`${tag}: ${b.member_id} joined; it is confirmed when it picks the code pair shows`);
      }
      if (msg.event === "member_revoked" && known && !members.some((m) => m.member_id === b.member_id)) known.state = "revoked";
      for (const c of Object.values(state.commands)) if (msg.event === "message_expired" && c.msg_id === b.msg_id && ["pending", "sent"].includes(c.state)) c.state = "expired";
      return console.log(`${tag}: ${clean(msg.event)}${typeof b.member_id === "string" ? ` ${clean(b.member_id)}` : ""}`);
    }
    const list = (x) => (Array.isArray(x) ? x : []), types = list(inner.samples).map((s) => (/^[a-z0-9_]{1,64}$/.test(s?.type) ? s.type : "unknown"));
    for (const a of list(inner.acks)) {
      const c = Object.hasOwn(state.commands, a?.command_id) ? state.commands[a.command_id] : null;
      if (c?.to !== msg.from || (a.version ?? 1) !== c.version || !(["pending", "sent", "expired"].includes(c.state) || (c.state === "applied" && a.status === "deleted_by_user"))) continue;
      if (["applied", "rejected", "deleted_by_user"].includes(a.status)) { c.state = a.status; delete c.reason; delete c.detail; }
      if (a.status === "rejected") c.reason = /^[a-z_]{1,32}$/.test(a.reason) ? a.reason : "unknown";
      if (a.status === "rejected" && typeof a.detail === "string" && /^[a-z_]{1,32}$/.test(a.detail)) c.detail = a.detail;
    }
    const counts = [...new Set(types)].map((t) => `${t}=${types.filter((x) => x === t).length}`).join(" ") || "none";
    console.log(`${tag}: sync from ${msg.from}: samples ${counts}; deleted ${list(inner.deleted).length}; acks ${list(inner.acks).length}`);
  });
}

// The one control envelope opened before confirmation: pair_proof from a joined phone, under the key it joined with.
async function checkProof(home, state, msg, member, inner) {
  if (inner?.v !== 1 || inner.type !== "pair_proof") return console.log(`seq ${msg.seq}: skipped (control message)`);
  if (!isB64u(inner.proof, 32) || !timingSafeEqual(unb64u(inner.proof), unb64u(member.proof))) {
    await revoke(home, state, msg.from);
    return console.log(`seq ${msg.seq}: ${msg.from} sent a wrong pairing proof; rejected and revoked`);
  }
  const envelope = await sealEnvelope({ hubId: state.hub_id, from: state.member_id, sk: state.sk, recipients: [{ member_id: msg.from, pk: member.pk }], plaintext: '{"v":1,"type":"confirmed"}', kind: "control" });
  await relayCall(state, "POST", "/v1/messages", { body: JSON.stringify(envelope) });
  settle(home, msg.from, "confirmed");
  console.log(`seq ${msg.seq}: ${msg.from} picked the right code; confirmed`);
}

async function pollOnce(home, pairing = false) {
  for (let state = loadState(home); ; state = loadState(home)) {
    const page = await relayCall(state, "GET", `/v1/messages?after=${state.last_seq}&limit=100`);
    if (!Array.isArray(page?.messages)) throw fail("invalid_response", "malformed message page");
    let done = state.last_seq, waiting = null;
    for (const msg of page.messages) {
      if (!Number.isSafeInteger(msg?.seq) || msg.seq <= done) throw fail("invalid_response", "message without an ascending seq");
      const fresh = loadState(home);
      // Never ack data from a joined phone (it does not upload it again), nor its pair_proof before pair stored the expected proof. Inside pair only its own phone can still prove a link, so any other joined phone without a proof is revoked.
      const m = Object.hasOwn(fresh.members, msg.from) ? fresh.members[msg.from] : null;
      if (pairing && m?.state === "joined" && !m.proof) await revoke(home, fresh, msg.from);
      else if (m?.state === "joined" && (msg.kind === "data" || !m.proof)) { waiting = msg.from; break; }
      await handleMessage(home, fresh, msg);
      done = msg.seq;
    }
    if (done > state.last_seq) updateState(home, (s) => (s.last_seq = Math.max(s.last_seq, done)));
    if (done > (state.acked_seq ?? 0)) {
      await relayCall(state, "POST", "/v1/acks", { body: JSON.stringify({ up_to_seq: done }) });
      updateState(home, (s) => (s.acked_seq = Math.max(s.acked_seq ?? 0, done)));
    }
    if (waiting) return console.log(`Holding messages from ${waiting} until it picks the code pair shows (run pair again if pair has ended)`);
    if (page.has_more !== true || page.messages.length === 0) return;
  }
}

export const pollDue = (state, tick, at = Date.now()) => tick % 6 === 0 || Object.values(state.commands).some((c) => ["pending", "sent"].includes(c.state) && at - parseInt(c.msg_id.replace("-", "").slice(0, 12), 16) < 900_000);
async function poll(home, once) {
  if (once) return pollOnce(home);
  for (let tick = 0; ; tick++, await sleep(300_000)) {
    if (!pollDue(loadState(home), tick)) continue;
    try { await pollOnce(home); } catch (err) { if (err.code === "invalid_token") throw err; console.error(`poll failed: ${err.message}`); }
  }
}

// E10: one write command, sealed for the target phone only.
async function sendWater(home, state, { liters, to }) {
  const target = Object.hasOwn(state.members, to) ? state.members[to] : null;
  if (target?.state !== "confirmed") throw exitError(2, `send-water: ${to} is not a confirmed device; run pair first`);
  const msgId = uuidv7();
  let command_id;
  updateState(home, (s) => {
    command_id = `c_${Object.keys(s.commands).length + 1}`;
    s.commands[command_id] = { to, version: 1, msg_id: msgId, state: "pending" };
  });
  const at = nowText();
  const command = { command_id, version: 1, op: "write", type: "dietary_water", value: liters, unit: "L", start: at, end: at };
  const plaintext = JSON.stringify({ v: 1, type: "commands", commands: [command] });
  const envelope = await sealEnvelope({ hubId: state.hub_id, from: state.member_id, sk: state.sk, recipients: [{ member_id: to, pk: target.pk }], plaintext, msgId });
  const res = await relayCall(state, "POST", "/v1/messages", { body: JSON.stringify(envelope) });
  updateState(home, ({ commands: { [command_id]: c } }) => c.state === "pending" && Object.assign(c, { state: "sent", seq: res?.seq }));
  console.log(`Sent ${command_id} to ${to}. The phone applies it on its next sync; poll then shows its ack.`);
}

function status(state) {
  console.log(`relay ${state.relay}\nhub ${state.hub_id}, this agent ${state.member_id} "${clean(state.name)}"\nlast seq ${state.last_seq}`);
  for (const [id, m] of Object.entries(state.members)) console.log(`member ${id} "${clean(m.name)}": ${m.state === "joined" ? "not confirmed" : m.state}`);
  for (const [id, c] of Object.entries(state.commands)) console.log(`command ${id} v${c.version} dietary_water to ${c.to}: ${c.state}${c.reason ? ` (${c.reason}${c.detail ? `/${c.detail}` : ""})` : ""}`);
}

// CLI
const COMMANDS = {
  init: { options: { relay: { type: "string" }, invite: { type: "string" }, name: { type: "string" } } },
  pair: { options: { wait: { type: "string" } } },
  poll: { options: { once: { type: "boolean" } } },
  "send-water": { options: { to: { type: "string" } }, positionals: 1 },
  status: { options: {} },
};

export function parseCommand(argv) {
  const [name, ...rest] = argv;
  const spec = COMMANDS[name];
  if (!spec) throw usage(name ? `unknown command: ${name}` : "missing command");
  let parsed;
  try { parsed = parseArgs({ args: rest, options: spec.options, allowPositionals: true, strict: true }); } catch (err) { throw usage(err.message); }
  const { values, positionals } = parsed;
  if (positionals.length !== (spec.positionals ?? 0)) throw usage(`${name}: unexpected arguments`);
  if (name === "init") {
    if (!values.relay) throw usage("init: --relay is required");
    const url = URL.parse(values.relay);
    if (!/^https?:$/.test(url?.protocol)) throw usage("init: --relay must be an http(s) URL");
    values.relay = url.origin;
    values.name ??= "Syncky minimal agent";
    if (values.name.trim() === "" || values.name.length > 64 || /[\u0000-\u001f\u007f]/.test(values.name)) throw usage("init: --name must be 1 to 64 characters without control characters");
  }
  if (name === "pair" && values.wait !== undefined && !/^[1-9][0-9]{0,4}$/.test(values.wait)) throw usage("pair: --wait must be a whole number of seconds");
  if (name === "send-water") {
    const liters = Number(positionals[0]);
    if (!/^[0-9]+(\.[0-9]+)?$/.test(positionals[0]) || !Number.isFinite(liters)) throw usage("send-water: <liters> must be a decimal number, 0 or more");
    if (!MEMBER_ID_RE.test(values.to ?? "")) throw usage("send-water: --to <member_id> is required (m_dev_N)");
    values.liters = liters;
  }
  return { name, values };
}

async function main(argv) {
  const { name, values } = parseCommand(argv);
  const home = resolve(process.env.SYNCKY_HOME || ".syncky-minimal");
  const state = loadState(home);
  if (name === "init" && state) throw exitError(2, `already initialized (${join(home, "state.json")}); remove it to register again`);
  if (name === "init") return init(home, values);
  if (!state) throw exitError(3, `not initialized: run init first (state: ${join(home, "state.json")})`);
  if (name === "pair") return pair(home, state, values);
  if (name === "poll") return poll(home, values.once);
  if (name === "send-water") return sendWater(home, state, values);
  status(state);
}

if (process.argv[1] && realpathSync(process.argv[1]) === import.meta.filename) {
  process.umask(0o077);
  try {
    await main(process.argv.slice(2));
  } catch (err) {
    process.exitCode = err.exit ?? 1;
    console.error(err.exit ? err.message : `error: ${err.message}`);
  }
}
