import Ajv from "ajv/dist/2020.js";
import { LocalStateError } from "./config.js";
import { b64uDecode, formatTimestamp, parseTimestamp, toHex } from "./encoding.js";
import { randomBytes } from './crypto.js';
import { uuidv7 } from './ids.js';
import { cipherEntries, readHomeState, createCipherFiles, updateHomeState } from "./home-state.js";
import { MAX_CONTROL_ENVELOPE_BYTES, parseRawInner } from "./thin-transport.js";
import { retryHomeLock } from "./thin-lock.js";
import { accessRequestFits, normalizeAccessRequest, scopeReleaseProblem, validateAccessScope } from './access-scope.js';
import { recordScopeRelease } from './scope-release.js';
import { v1AccessMember, V1_ACCESS_TTL_MS } from './pairing-access.js';
import { ACCESS_SIZE_HINT } from './error-guidance.js';

import { responseCorrelations } from "./response-waits.js";

export { normalizeAccessRequest } from './access-scope.js';

function validateAccessRequest(inner) {
  if (inner.type !== "access_request") return;
  const created = parseTimestamp(inner.created_at), expires = parseTimestamp(inner.expires_at);
  const ttl = created === null || expires === null ? NaN : expires - created;
  const scope = validateAccessScope(inner, { request: inner });
  const detail = !Number.isFinite(ttl) || ttl <= 0 || ttl > 86400000 ? 'ttl' : !scope.ok ? scope.detail
    : accessRequestFits(scope.value, inner) ? null : 'too_large';
  if (detail) throw new LocalStateError("schema_invalid", detail === 'too_large' ? ACCESS_SIZE_HINT : `invalid access request: ${detail}`, { detail, ...(detail === "not_writable" && { types: scope.types }) });
}

function validateScopeRelease(inner) {
  if (inner.type !== "scope_release") return;
  const detail = scopeReleaseProblem(inner);
  if (detail) throw new LocalStateError("schema_invalid", `invalid scope release: ${detail}`, { detail });
}

export function createLocalValidator(schemas = []) {
  const ajv = new Ajv({ strict: false, validateFormats: false }), definitions = new Map(), compiled = new Map();
  const documents = structuredClone(schemas);
  function discover(node, root, pointer) {
    if (!node || typeof node !== "object") return;
    const type = node.properties?.type?.const;
    if (typeof type === "string") definitions.set(type, [...(definitions.get(type) ?? []), { root, pointer }]);
    for (const [key, child] of Object.entries(node)) discover(child, root, `${pointer}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`);
  }
  documents.forEach((doc, i) => {
    const root = doc.$id ?? `urn:syncky:local:${i}`; doc.$id = root;
    discover(doc, root, "");
  });
  return inner => {
    normalizeAccessRequest(inner);
    validateAccessRequest(inner);
    validateScopeRelease(inner);
    const matches = definitions.get(inner.type);
    if (!matches) return;
    try {
      if (!compiled.has(inner.type)) {
        for (const doc of documents) if (!ajv.getSchema(doc.$id)) ajv.addSchema(doc);
        compiled.set(inner.type, matches.map(({ root, pointer }) => ajv.compile({ $ref: `${root}#${pointer}` })));
      }
      if (!compiled.get(inner.type).some(validate => validate(inner))) throw new Error();
    } catch { throw new LocalStateError("schema_invalid", "local schema validation failed"); }
  };
}

export function createGenericSender({ home, transport, self, now = () => new Date(), fs, schemas = [] }) {
  const validateLocal = createLocalValidator(schemas), outbox = createCipherFiles(home, "outbox", { fs });
  return async ({ type, innerText, to, validate = false }, intent) => {
    const { inner } = parseRawInner(innerText);
    if (inner.type !== type) throw new LocalStateError("invalid_input", "send type must match input type");
    normalizeAccessRequest(inner);
    // The phone never answers a release, so a malformed one would vanish without a trace.
    if (validate || inner.type === "scope_release") validateLocal(inner);
    if (!validate && inner.type === 'access_request') {
      const names = value => Array.isArray(value) ? value.filter(name => typeof name === 'string') : [];
      const scope = { request_ref: inner.request_ref, read: names(inner.read), write: names(inner.write) };
      if (!accessRequestFits(scope, inner)) throw new LocalStateError('schema_invalid', ACCESS_SIZE_HINT, { detail: 'too_large' });
    }
    if (["access_request", "scope_release"].includes(inner.type)) innerText = JSON.stringify(inner);
    const state = readHomeState(home, { fs });
    const allowedIntent = current => {
      const row = current.pairings[intent.pairing_id];
      return v1AccessMember(current, row)?.member_id === to && row.v1_request?.msg_id === intent.msg_id
        && !row.v1_request.queued && Date.parse(row.v1_request.expires_at) > now().getTime();
    };
    if (intent && !allowedIntent(state)) return null;
    const targets = to === undefined ? Object.values(state.members).filter(m => m.role === "device" && m.state === "confirmed" && m.unpair_reason == null) : [state.members[to]];
    if (to === undefined && targets.length !== 1) throw new LocalStateError("ambiguous_target", "select one confirmed phone");
    if (!targets[0] || targets[0].state !== "confirmed" || targets[0].unpair_reason != null || [true, "1"].includes(state.transport.hub_revoked) || [true, "1"].includes(state.transport.hub_deleted)) throw new LocalStateError("target_not_confirmed", "target is not confirmed");
    const target = targets[0], envelope = await retryHomeLock(() => transport.sealMessage({ hubId: state.identity.hub_id, from: self.memberId, senderPrivateKey: self.privateKey,
      recipients: [{ memberId: target.member_id, publicKey: b64uDecode(target.public_key) }], innerText,
      createdAt: intent?.created_at ?? now().toISOString(), ...(intent && { msgId: intent.msg_id }) }));
    const entry = await retryHomeLock(() => ({ msg_id: envelope.msg_id, kind: envelope.kind, type, to: [target.member_id], lane: transport.lane(envelope), body: transport.serialize(envelope), state: "pending", attempts: 0, next_attempt_at: 0 }));
    if (intent) entry.pairing_id = intent.pairing_id;
    const waits = responseCorrelations(inner, target, now().getTime(), {
      largeAccess: type === 'access_request' && Buffer.byteLength(entry.body) > MAX_CONTROL_ENVELOPE_BYTES,
      pairingId: intent?.pairing_id, msgId: entry.msg_id,
    });
    if (waits.length) entry.response_waits = waits;
    const saved = await retryHomeLock(() => outbox.put(entry, { pairingGuard: intent && allowedIntent }));
    if (intent && !saved) return null;
    if (inner.type === "scope_release") await retryHomeLock(() => updateHomeState(home, s => {
      if (s.members[target.member_id]) recordScopeRelease(s.members[target.member_id], inner, entry.msg_id, now().getTime(), cipherEntries(home, "outbox", { fs }));
    }, { fs }));
    return { msg_id: entry.msg_id, kind: entry.kind, type, to: entry.to, state: entry.state };
  };
}

export async function queueV1Access({ home, send, now, fs }) {
  const options = { fs }, state = await retryHomeLock(() => readHomeState(home, options));
  const candidates = Object.values(state.pairings).filter(row => v1AccessMember(state, row) && !row.v1_request?.queued);
  if (!candidates.length) return false;
  const accepted = new Set((await retryHomeLock(() => cipherEntries(home, 'outbox', options)))
    .filter(entry => entry.type === 'confirmed' && entry.state === 'sent').map(entry => entry.msg_id));
  let queued = false;
  for (const candidate of candidates) {
    if (!candidate.v1_request && !accepted.has(candidate.v1_confirmation)) continue;
    const next = await retryHomeLock(() => updateHomeState(home, current => {
      const row = current.pairings[candidate.pairing_id], member = v1AccessMember(current, row), at = now();
      if (!member || row.v1_request?.queued || (!row.v1_request && !accepted.has(row.v1_confirmation))) return null;
      row.v1_request ??= { msg_id: uuidv7({ now: () => at.getTime() }), request_ref: toHex(randomBytes(16)),
        created_at: formatTimestamp(at), expires_at: formatTimestamp(at.getTime() + V1_ACCESS_TTL_MS) };
      const { msg_id, request_ref, created_at, expires_at } = row.v1_request;
      if (Date.parse(expires_at) <= at.getTime()) { row.v1_cancelled = true; return null; }
      return { pairing_id: row.pairing_id, msg_id, created_at, to: member.member_id,
        inner: { v: 1, type: 'access_request', request_ref, created_at, expires_at, ...row.v1_scope } };
    }, options));
    if (!next || !await send({ type: 'access_request', innerText: JSON.stringify(next.inner), to: next.to, validate: true }, next)) continue;
    await retryHomeLock(() => updateHomeState(home, current => {
      const request = current.pairings[next.pairing_id]?.v1_request;
      if (request?.msg_id === next.msg_id) request.queued = true;
    }, options));
    queued = true;
  }
  return queued;
}
