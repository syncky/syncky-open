import { CipherSuite, HkdfSha256 } from "@hpke/core";
import { DhkemX25519HkdfSha256 } from "@hpke/dhkem-x25519";
import { Chacha20Poly1305 } from "@hpke/chacha20poly1305";

const fail = (code, message) => Object.assign(new Error(message), { code });
export const utf8 = (text) => new TextEncoder().encode(text);
export const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));
export const nowText = (ms = Date.now()) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

export function b64u(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Reject anything that does not re-encode identically: padding, junk and non-canonical trailing bits.
export function unb64u(text, length) {
  let bytes = null;
  if (typeof text === "string" && /^[A-Za-z0-9_-]*$/.test(text) && text.length % 4 !== 1) {
    const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4));
    bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  }
  if (!bytes || b64u(bytes) !== text || (length !== undefined && bytes.length !== length)) {
    throw fail("malformed", `not base64url${length === undefined ? "" : ` of ${length} bytes`}`);
  }
  return bytes;
}

const isB64u = (v, length) => {
  try {
    return !!unb64u(v, length);
  } catch {
    return false;
  }
};

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export function uuidv7(now = Date.now()) {
  const b = randomBytes(16);
  const ms = now.toString(16).padStart(12, "0");
  for (let i = 0; i < 6; i++) b[i] = parseInt(ms.slice(i * 2, i * 2 + 2), 16);
  [b[6], b[8]] = [0x70 | (b[6] & 0x0f), 0x80 | (b[8] & 0x3f)];
  const h = hex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const uuidTime = (id) => parseInt(id.replace("-", "").slice(0, 12), 16);

const suite = new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Chacha20Poly1305() });
const importPrivate = (sk) => suite.kem.deserializePrivateKey(unb64u(sk, 32));
const importPublic = (pk) => suite.kem.deserializePublicKey(unb64u(pk, 32));

export async function generateKeys() {
  const { privateKey, publicKey } = await suite.kem.generateKeyPair();
  const raw = async (bytes) => b64u(new Uint8Array(await bytes));
  return { sk: await raw(suite.kem.serializePrivateKey(privateKey)), pk: await raw(suite.kem.serializePublicKey(publicKey)) };
}

export async function pairCode(c) {
  const d = new DataView(await crypto.subtle.digest("SHA-256", utf8(`syncky-code-v2|${c}`)));
  return [0, 2, 4].map((i) => String(d.getUint16(i) % 1000).padStart(3, "0")).join(" ");
}

export async function pairProof(c, agentPk, devicePk) {
  const key = await crypto.subtle.importKey("raw", unb64u(c, 16), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u(new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8(`syncky-pair-v2|${agentPk}|${devicePk}`))));
}

export function proofMatches(expected, given) {
  if (!isB64u(given, 32)) return false;
  const [a, b] = [unb64u(expected, 32), unb64u(given, 32)];
  let diff = 0;
  for (let i = 0; i < 32; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

const CEK_INFO = utf8("syncky-cek-v1");
export const envelopeAad = (hubId, msgId, from, kind = "data", diagnostics, access) => `syncky-v1|${hubId}|${msgId}|${from}${kind === "control" ? "|control" : ""}${diagnostics === undefined ? "" : `|diagnostics=${diagnostics}`}${access === undefined ? "" : `|access=${access}`}`;
const validAccess = (kind, access) => kind === "control" && ["request", "reply"].includes(access);
const validDiagnostics = (kind, diagnostics) => diagnostics === "archive" ? kind === "data" : ["request", "reply"].includes(diagnostics) && kind === "control";

export async function sealEnvelope({ hubId, from, sk, recipients, plaintext, msgId = uuidv7(), kind = "data", diagnostics, access }) {
  if (!["data", "control"].includes(kind)) throw fail("invalid_input", "kind must be data or control");
  if (diagnostics !== undefined && !validDiagnostics(kind, diagnostics)) throw fail("invalid_input", "invalid diagnostics");
  if (access !== undefined && (!validAccess(kind, access) || diagnostics !== undefined)) throw fail("invalid_input", "invalid access");
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

// The sender key comes only from `registry` (the confirmed phone, or the joined key for its pair_proof), never from the envelope or the relay.
export async function openEnvelope(e, { hubId, memberId, sk, registry, kind = "data" }) {
  if (e?.v !== 1 || !["data", "control"].includes(kind) || e.kind !== kind || typeof e.msg_id !== "string" || typeof e.from !== "string") throw fail("malformed", "not an envelope");
  if (Object.hasOwn(e, "diagnostics") && !validDiagnostics(e.kind, e.diagnostics)) throw fail("malformed", "invalid diagnostics");
  if (Object.hasOwn(e, "access") && (!validAccess(e.kind, e.access) || Object.hasOwn(e, "diagnostics"))) throw fail("malformed", "invalid access");
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
  let text;
  try {
    const plain = await new Chacha20Poly1305().createEncryptionContext(cek).open(nonce, ciphertext, aad);
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(plain);
  } catch {
    throw fail("aead_failed", "cannot decrypt the payload");
  } finally {
    cek.fill(0);
  }
  if (Object.hasOwn(e, "diagnostics")) {
    let inner;
    try { inner = JSON.parse(text); } catch { throw fail("inner_invalid", "invalid marked inner"); }
    if (inner?.v !== 1 || inner.type !== ({ request: "diagnostics_request", reply: "diagnostics_reply", archive: "diagnostics" })[e.diagnostics]) throw fail("inner_invalid", "invalid marked inner");
  }
  let accessInner; try { accessInner = JSON.parse(text); } catch { if (Object.hasOwn(e, "access")) throw fail("inner_invalid", "invalid marked inner"); }
  if (Object.hasOwn(e, "access") ? accessInner?.v !== 1 || accessInner.type !== `access_${e.access}` : ["access_request", "access_reply"].includes(accessInner?.type)) throw fail("inner_invalid", "invalid marked inner");
  return text;
}

export const PAIR_SCHEMES = ["syncky", "syncky-dev", "syncky-staging"];
const pctEncode = (v) => encodeURIComponent(v).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export function buildPairUri({ relay_base, hub_id, pairing_token, agent_public_key, agent_name, pair_secret, url_scheme = "syncky" }) {
  if (!PAIR_SCHEMES.includes(url_scheme)) throw new TypeError("url scheme must be syncky, syncky-dev or syncky-staging");
  const query = { r: relay_base.replace(/^https?:\/\//, ""), h: hub_id, t: pairing_token, k: agent_public_key, n: agent_name, ...(pair_secret && { c: pair_secret }) };
  const params = Object.entries(query).map(([key, value]) => `&${key}=${pctEncode(value)}`).join("");
  return `${url_scheme}://pair?v=${pair_secret ? 2 : 1}${params}${relay_base.startsWith("http://") ? "&s=http" : ""}`;
}

export const MEMBER_ID_RE = /^m_(agent|dev)_[1-9][0-9]{0,5}$/;
export const isPublicKey = (v) => isB64u(v, 32);
export const clean = (text) => String(text).slice(0, 64).replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, "?");
