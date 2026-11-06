import { readFileSync } from "node:fs";
import { aeadOpen, aeadSeal, hpkeOpenAuth, hpkeSealAuth, randomBytes } from "./crypto.js";
import { b64uDecode, b64uEncode, exceedsJsonDepth, formatTimestamp, isB64u, isTimestamp, utf8, utf8Decode } from "./encoding.js";
import { isHubId, isMemberId, isUuidV7, uuidv7 } from "./ids.js";

export class EnvelopeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "EnvelopeError";
    this.code = code;
  }
}

const object = v => v !== null && typeof v === "object" && !Array.isArray(v);
const own = (v, k) => Object.hasOwn(v, k);
const selectFields = (v, names) => object(v) ? Object.fromEntries(names.filter(k => own(v, k)).map(k => [k, v[k]])) : v;
const fields = ["v", "msg_id", "kind", "from", "created_at", "recipients", "nonce", "ciphertext"];
const recipientFields = ["member_id", "enc", "wrapped_key"];
const error = code => new EnvelopeError(code, "encrypted transport rejected input");
const sameSet = (a, b) => Array.isArray(a) && a.length === b.length && new Set(a).size === a.length && b.every(v => a.includes(v));

export function parseRawInner(input, { maxBytes = 262144 } = {}) {
  try {
    const bytes = typeof input === "string" ? utf8(input) : input;
    if (!(bytes instanceof Uint8Array) || bytes.length > maxBytes) throw error("inner_invalid");
    const innerText = utf8Decode(bytes), inner = JSON.parse(innerText);
    if (!object(inner) || typeof inner.type !== "string" || exceedsJsonDepth(inner)) throw error("inner_invalid");
    return { inner, innerText };
  } catch { throw error("inner_invalid"); }
}

export function validateMessageTable(input) {
  try {
    const t = structuredClone(input), l = t.limits;
    if (t.schema_version !== 1 || t.protocol_version !== 1 || !sameSet(t.kinds, ["data", "control"])
      || !object(t.messages) || !object(t.markers) || !object(l)
      || t.aad.base !== "syncky-v1|<hub_id>|<msg_id>|<from>" || t.aad.marker_template !== "|<field>=<value>"
      || t.aad.kind_suffixes.data !== "" || t.aad.kind_suffixes.control !== "|control"
      || !sameSet(t.aad.uses, ["hpke_auth", "payload_aead"])
      || !sameSet(t.aad.marker_order, Object.keys(t.markers))
      || !sameSet(t.canonical.envelope_fields, [...fields, ...Object.keys(t.markers)])
      || !sameSet(t.canonical.recipient_fields, recipientFields)
      || l.cek_bytes !== 32 || l.nonce_bytes !== 12 || l.enc_bytes !== 32 || l.wrapped_key_bytes !== 48 || l.tag_bytes !== 16
      || l.max_markers !== 1 || l.max_recipients !== 7 || l.max_member_id_length !== 64
      || l.max_envelope_bytes !== 262144 || l.max_control_envelope_bytes !== 4096
      || t.default.kind !== "control" || t.default.marker !== undefined || t.default.max_envelope_bytes !== l.max_control_envelope_bytes) throw error("protocol_incompatible");
    for (const [field, values] of Object.entries(t.markers)) {
      if (!/^[a-z][a-z_]*$/.test(field) || fields.includes(field) || !Array.isArray(values) || !values.length
        || new Set(values).size !== values.length || !values.every(v => typeof v === "string" && /^[a-z][a-z_]*$/.test(v))) throw error("protocol_incompatible");
    }
    for (const r of Object.values(t.messages)) {
      if (!object(r) || !t.kinds.includes(r.kind) || !Number.isSafeInteger(r.max_envelope_bytes) || r.max_envelope_bytes < 1
        || r.max_envelope_bytes > (r.kind === "control" ? l.max_control_envelope_bytes : l.max_envelope_bytes)
        || (r.max_inner_bytes !== undefined && (!Number.isSafeInteger(r.max_inner_bytes) || r.max_inner_bytes < 1 || r.max_inner_bytes > l.max_envelope_bytes))
        || (r.marker && (!object(r.marker) || !t.markers[r.marker.field]?.includes(r.marker.value)))) throw error("protocol_incompatible");
    }
    for (const [field, values] of Object.entries(t.markers)) for (const value of values) {
      const rules = Object.values(t.messages).filter(r => r.marker?.field === field && r.marker.value === value);
      if (!rules.length || new Set(rules.map(r => r.kind)).size !== 1) throw error("protocol_incompatible");
    }
    return t;
  } catch { throw error("protocol_incompatible"); }
}

export function createThinTransport({ table, tablePath } = {}) {
  if (table === undefined) {
    if (tablePath === undefined) throw error("protocol_incompatible");
    try { table = JSON.parse(readFileSync(tablePath, "utf8")); } catch { throw error("protocol_incompatible"); }
  }
  const t = validateMessageTable(table), l = t.limits, markers = t.aad.marker_order;
  const rule = type => structuredClone(own(t.messages, type) ? t.messages[type] : t.default);
  const serialize = envelope => JSON.stringify(Object.fromEntries(t.canonical.envelope_fields.filter(k => own(envelope, k)).map(k => [k, k === "recipients"
    ? envelope[k].map(r => Object.fromEntries(t.canonical.recipient_fields.map(f => [f, r[f]]))) : envelope[k]])));
  const aad = (hubId, e) => `syncky-v1|${hubId}|${e.msg_id}|${e.from}${t.aad.kind_suffixes[e.kind]}${markers.filter(f => own(e, f)).map(f => `|${f}=${e[f]}`).join("")}`;
  const invalid = field => { throw { field }; };
  function keySet(obj, required, optional = [], prefix = "") {
    for (const k of Object.keys(obj)) if (!required.includes(k) && !optional.includes(k)) invalid(`${prefix}/${k.replaceAll("~", "~0").replaceAll("/", "~1")}`);
    for (const k of required) if (!own(obj, k)) invalid(`${prefix}/${k}`);
  }
  function shape(e, caller) {
    if (!object(e) || exceedsJsonDepth(e)) invalid("");
    keySet(e, fields, markers);
    if (e.v !== 1) invalid("/v");
    if (!isUuidV7(e.msg_id)) invalid("/msg_id");
    if (!t.kinds.includes(e.kind)) invalid("/kind");
    let count = 0;
    for (const f of markers) if (own(e, f)) {
      if (++count > l.max_markers || !Object.values(t.messages).some(r => r.kind === e.kind && r.marker?.field === f && r.marker.value === e[f])) invalid(`/${f}`);
    }
    if (typeof e.from !== "string" || !e.from.length || e.from !== caller) invalid("/from");
    if (!isTimestamp(e.created_at)) invalid("/created_at");
    if (!Array.isArray(e.recipients) || e.recipients.length < 1 || e.recipients.length > l.max_recipients) invalid("/recipients");
    const seen = new Set();
    e.recipients.forEach((r, i) => {
      const p = `/recipients/${i}`;
      if (!object(r)) invalid(p);
      keySet(r, recipientFields, [], p);
      if (typeof r.member_id !== "string" || !r.member_id.length || r.member_id.length > l.max_member_id_length || r.member_id === e.from || seen.has(r.member_id)) invalid(`${p}/member_id`);
      seen.add(r.member_id);
      if (!isB64u(r.enc, { length: l.enc_bytes })) invalid(`${p}/enc`);
      if (!isB64u(r.wrapped_key, { length: l.wrapped_key_bytes })) invalid(`${p}/wrapped_key`);
    });
    if (!isB64u(e.nonce, { length: l.nonce_bytes })) invalid("/nonce");
    if (!isB64u(e.ciphertext) || b64uDecode(e.ciphertext).length < l.tag_bytes) invalid("/ciphertext");
    return [...seen];
  }
  function validateShape(e, { caller, activeMembers, bytes, allowUnknown = false } = {}) {
    if (allowUnknown) {
      e = selectFields(e, t.canonical.envelope_fields);
      if (Array.isArray(e?.recipients)) e.recipients = e.recipients.map(r => selectFields(r, t.canonical.recipient_fields));
    }
    let ids;
    try { ids = shape(e, caller); }
    catch (err) { if (typeof err.field === "string") return { status: 400, error: "invalid_envelope", field: err.field }; throw err; }
    const size = bytes ?? utf8(serialize(e)).length;
    if (size > l.max_envelope_bytes || (e.kind === "control" && size > l.max_control_envelope_bytes)) return { status: 413, error: "payload_too_large" };
    const active = new Set(activeMembers ?? ids), unknown = ids.filter(id => !active.has(id));
    return unknown.length ? { status: 404, error: "unknown_recipient", member_ids: unknown } : { status: 201 };
  }
  function validateText(input, options) {
    try {
      const raw = typeof input === "string" ? utf8(input) : input;
      if (raw.length > l.max_envelope_bytes) return { status: 413, error: "payload_too_large" };
      return validateShape(JSON.parse(utf8Decode(raw)), { ...options, bytes: raw.length });
    } catch { return { status: 400, error: "invalid_envelope", field: "" }; }
  }
  function checkedInner(e, plaintext, receiving = false) {
    const parsed = parseRawInner(plaintext, { maxBytes: l.max_envelope_bytes }), r = rule(parsed.inner.type);
    if (receiving && !own(t.messages, parsed.inner.type)) {
      if (markers.some(f => own(e, f))) throw error("inner_invalid");
      return parsed;
    }
    // Legacy diagnostics authenticate without a marker; stripped marked ciphertext fails in open.
    const legacy = receiving && r.marker?.field === "diagnostics" && !markers.some(f => own(e, f));
    if (e.kind !== r.kind || utf8(serialize(e)).length > r.max_envelope_bytes
      || (r.max_inner_bytes && plaintext.length > r.max_inner_bytes)
      || markers.some(f => r.marker?.field === f ? !legacy && e[f] !== r.marker.value : own(e, f))) throw error("inner_invalid");
    return parsed;
  }
  async function seal({ hubId, from, recipients, senderPrivateKey, plaintext, kind = "data", msgId = uuidv7(), createdAt = formatTimestamp(new Date()), random, ekmFor, ...extra }) {
    if (!isHubId(hubId) || !isMemberId(from) || !(senderPrivateKey instanceof Uint8Array) || senderPrivateKey.length !== 32
      || !isUuidV7(msgId) || !isTimestamp(createdAt) || !t.kinds.includes(kind)
      || !Array.isArray(recipients) || recipients.length < 1 || recipients.length > l.max_recipients
      || new Set(recipients.map(r => r?.memberId)).size !== recipients.length
      || recipients.some(r => !isMemberId(r?.memberId) || r.memberId === from || !(r.publicKey instanceof Uint8Array) || r.publicKey.length !== 32)) throw error("invalid_input");
    const bytes = typeof plaintext === "string" ? utf8(plaintext) : plaintext;
    if (!(bytes instanceof Uint8Array) || bytes.length > l.max_envelope_bytes) throw error("invalid_input");
    const e = { v: 1, msg_id: msgId, kind, ...Object.fromEntries(markers.filter(f => extra[f] !== undefined).map(f => [f, extra[f]])), from, created_at: createdAt };
    if (markers.filter(f => own(e, f)).length > l.max_markers || markers.some(f => own(e, f)
      && !Object.values(t.messages).some(r => r.kind === kind && r.marker?.field === f && r.marker.value === e[f]))) throw error("invalid_input");
    const associated = utf8(aad(hubId, e)), cek = randomBytes(l.cek_bytes, random), nonce = randomBytes(l.nonce_bytes, random);
    try {
      e.recipients = [];
      for (const r of recipients) {
        const wrapped = await hpkeSealAuth({ recipientPublicKey: r.publicKey, senderPrivateKey, info: utf8("syncky-cek-v1"), aad: associated, plaintext: cek, ekm: ekmFor?.(r.memberId) });
        e.recipients.push({ member_id: r.memberId, enc: b64uEncode(wrapped.enc), wrapped_key: b64uEncode(wrapped.ciphertext) });
      }
      e.nonce = b64uEncode(nonce); e.ciphertext = b64uEncode(await aeadSeal(cek, nonce, associated, bytes));
      if (validateShape(e, { caller: from }).status !== 201) throw error("invalid_input");
      return JSON.parse(serialize(e));
    } catch (err) { throw err instanceof EnvelopeError ? err : error(err.code ?? "malformed"); }
    finally { cek.fill(0); }
  }
  async function open({ envelope: e, hubId, self, senderKeyOf }) {
    if (validateShape(e, { caller: e?.from, allowUnknown: true }).status !== 201) throw error("malformed");
    const mine = e.recipients.find(r => r.member_id === self.memberId);
    if (!mine) throw error("not_a_recipient");
    const key = senderKeyOf(e.from);
    if (key == null) throw error("unknown_sender");
    const associated = utf8(aad(hubId, e)); let cek;
    try {
      cek = await hpkeOpenAuth({ enc: b64uDecode(mine.enc), recipientPrivateKey: self.privateKey, senderPublicKey: key, info: utf8("syncky-cek-v1"), aad: associated, ciphertext: b64uDecode(mine.wrapped_key) });
      if (cek.length !== l.cek_bytes) throw error("hpke_open_failed");
      return await aeadOpen(cek, b64uDecode(e.nonce), associated, b64uDecode(e.ciphertext));
    } catch (err) { throw error(["malformed", "hpke_open_failed", "aead_failed"].includes(err.code) ? err.code : "malformed"); }
    finally { cek?.fill(0); }
  }
  return {
    rule, serialize, aad, validateShape, validateText, seal, open,
    async sealMessage({ innerText, ...options }) {
      const { inner } = parseRawInner(innerText), r = rule(inner.type);
      const envelope = await seal({ ...options, plaintext: innerText, kind: r.kind, ...(r.marker ? { [r.marker.field]: r.marker.value } : {}) });
      checkedInner(envelope, utf8(innerText)); return envelope;
    },
    async receive(options) {
      const plaintext = await open(options);
      try { return checkedInner(options.envelope, plaintext, true); } finally { plaintext.fill(0); }
    },
    lane(envelope) { const marker = markers.find(f => own(envelope, f)); return marker ? `marker:${marker}` : envelope.kind; },
    hasMarker: envelope => markers.some(f => own(envelope, f)),
  };
}
