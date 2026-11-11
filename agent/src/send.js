import Ajv from "ajv/dist/2020.js";
import { LocalStateError } from "./config.js";
import { b64uDecode } from "./encoding.js";
import { cipherEntries, readHomeState, createCipherFiles, updateHomeState } from "./home-state.js";
import { parseRawInner } from "./thin-transport.js";
import { retryHomeLock } from "./thin-lock.js";
import { normalizeAccessRequest, scopeReleaseProblem, validateAccessScope } from './access-scope.js';
import { recordScopeRelease } from './scope-release.js';

import { responseCorrelations } from "./response-waits.js";

export { normalizeAccessRequest } from './access-scope.js';

function validateAccessRequest(inner) {
  if (inner.type !== "access_request") return;
  const ttl = Date.parse(inner.expires_at) - Date.parse(inner.created_at);
  const scope = validateAccessScope(inner, { request: inner });
  const detail = ttl !== 86400000 ? "ttl" : scope.ok ? null : scope.detail;
  if (detail) throw new LocalStateError("schema_invalid", `invalid access request: ${detail}`, { detail, ...(detail === "not_writable" && { types: scope.types }) });
}

function validateScopeRelease(inner) {
  if (inner.type !== "scope_release") return;
  const detail = scopeReleaseProblem(inner);
  if (detail) throw new LocalStateError("schema_invalid", `invalid scope release: ${detail}`);
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
  return async ({ type, innerText, to, validate = false }) => {
    const { inner } = parseRawInner(innerText);
    if (inner.type !== type) throw new LocalStateError("invalid_input", "send type must match input type");
    normalizeAccessRequest(inner);
    // The phone never answers a release, so a malformed one would vanish without a trace.
    if (validate || inner.type === "scope_release") validateLocal(inner);
    if (["access_request", "scope_release"].includes(inner.type)) innerText = JSON.stringify(inner);
    const state = readHomeState(home, { fs });
    const targets = to === undefined ? Object.values(state.members).filter(m => m.role === "device" && m.state === "confirmed" && m.unpair_reason == null) : [state.members[to]];
    if (to === undefined && targets.length !== 1) throw new LocalStateError("ambiguous_target", "select one confirmed phone");
    if (!targets[0] || targets[0].state !== "confirmed" || targets[0].unpair_reason != null || [true, "1"].includes(state.transport.hub_revoked) || [true, "1"].includes(state.transport.hub_deleted)) throw new LocalStateError("target_not_confirmed", "target is not confirmed");
    const target = targets[0], envelope = await retryHomeLock(() => transport.sealMessage({ hubId: state.identity.hub_id, from: self.memberId, senderPrivateKey: self.privateKey,
      recipients: [{ memberId: target.member_id, publicKey: b64uDecode(target.public_key) }], innerText, createdAt: now().toISOString() }));
    const entry = await retryHomeLock(() => ({ msg_id: envelope.msg_id, kind: envelope.kind, type, to: [target.member_id], lane: transport.lane(envelope), body: transport.serialize(envelope), state: "pending", attempts: 0, next_attempt_at: 0 }));
    const waits = responseCorrelations(inner, target, now().getTime());
    if (waits.length) entry.response_waits = waits;
    await retryHomeLock(() => outbox.put(entry));
    if (inner.type === "scope_release") await retryHomeLock(() => updateHomeState(home, s => {
      if (s.members[target.member_id]) recordScopeRelease(s.members[target.member_id], inner, entry.msg_id, now().getTime(), cipherEntries(home, "outbox", { fs }));
    }, { fs }));
    return { msg_id: entry.msg_id, kind: entry.kind, type, to: entry.to, state: entry.state };
  };
}
