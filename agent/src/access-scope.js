import { loadJson } from './protocol-files.js';
import { isTimestamp } from './encoding.js';

const catalog = loadJson('types.json');
const types = new Map([...catalog.types, ...catalog.characteristics, { name: 'workout', write: false }].map(t => [t.name, t]));
const timestamp = '9999-12-31T23:59:59.999Z';
export const isRequestRef = value => typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
export const normalizeScopeNames = names => Array.isArray(names) && names.every(n => typeof n === 'string') ? [...new Set(names)].sort() : names;
const strings = names => Array.isArray(names) && names.every(n => typeof n === 'string');
const canonical = names => strings(names) && names.every((n, i) => i === 0 || names[i - 1] < n);
const invalid = (param, detail) => ({ ok: false, param, detail });

export function accessEnvelopeSizes(scope, { request, agentId = 'm_agent_999999', deviceId = 'm_dev_999999' } = {}) {
  const bytes = (inner, from, to, access) => Buffer.byteLength(JSON.stringify({ v: 1,
    msg_id: '00000000-0000-7000-8000-000000000000', kind: 'control', access, from, created_at: timestamp,
    recipients: [{ member_id: to, enc: 'A'.repeat(43), wrapped_key: 'A'.repeat(64) }], nonce: 'A'.repeat(16),
    ciphertext: 'A'.repeat(Math.ceil((Buffer.byteLength(JSON.stringify(inner)) + 16) * 4 / 3)) }));
  const base = { v: 1, type: 'access_reply', request_ref: scope.request_ref, decided_at: timestamp };
  const aliases = ['1', '2', '3', '4'].map(n => n.repeat(32)).filter(ref => ref !== scope.request_ref).slice(0, 3);
  const refused = names => names.map(type => ({ type, outcome: 'refused', reason: 'requested_recently', next_available_at: timestamp }));
  const owner = names => names.map(type => ({ type, outcome: 'needs_health_settings' }));
  const read = request ? refused(scope.read) : owner(scope.read), write = request ? refused(scope.write) : owner(scope.write);
  if (request && (read.length || write.length)) {
    const shown = read.length ? read : write;
    shown[0] = { type: shown[0].type, outcome: 'needs_health_settings' };
  }
  const replyBytes = inner => bytes(inner, deviceId, agentId, 'reply');
  return {
    request: bytes(request ?? { v: 1, type: 'access_request', request_ref: scope.request_ref,
      created_at: '9999-12-30T23:59:59.999Z', expires_at: timestamp, read: scope.read, write: scope.write }, agentId, deviceId, 'request'),
    reply: replyBytes({ ...base, outcome: 'resolved', read, write, ...(request && { merged_refs: aliases }) }),
    refusal: Math.max(replyBytes({ ...base, outcome: 'rate_limited', read: [], write: [], next_available_at: timestamp,
      ...(request && { limit_reason: 'amendment_limit' }) }), request ? replyBytes({ ...base, outcome: 'filtered', read: refused(scope.read), write: refused(scope.write) }) : 0),
    ...(request && { acknowledgement: replyBytes({ ...base, request_ref: aliases[0], outcome: 'merged', merged_into: scope.request_ref,
      read: refused(scope.read), write: refused(scope.write) }) }),
  };
}

export function validateAccessScope(scope, { normalize = false, request } = {}) {
  if (!scope || !isRequestRef(scope.request_ref)) return invalid('request_ref', 'malformed');
  const value = { request_ref: scope.request_ref, read: normalize ? normalizeScopeNames(scope.read) : scope.read,
    write: normalize ? normalizeScopeNames(scope.write) : scope.write };
  for (const side of ['read', 'write']) if (!canonical(value[side])) return invalid(side, 'malformed');
  if (!value.read.length && !value.write.length) return invalid('read', 'empty');
  for (const side of ['read', 'write']) if (value[side].some(n => !/^[a-z][a-z0-9_]{0,63}$/.test(n) || !types.has(n))) return invalid(side, 'unknown_type');
  const readOnly = value.write.filter(n => types.get(n).write !== true);
  if (readOnly.length) return { ...invalid('write', 'not_writable'), types: readOnly };
  if (Object.values(accessEnvelopeSizes(value, { request })).some(n => n > 4096)) return invalid('scope', 'too_large');
  return { ok: true, value };
}

export const isStoredRequestedScope = scope => validateAccessScope(scope).ok && Object.keys(scope).every(k => ['request_ref', 'read', 'write'].includes(k));

export function scopeReleaseProblem(inner) {
  if (!strings(inner.read) || !strings(inner.write)) return 'malformed';
  if (!inner.read.length && !inner.write.length) return 'empty';
  if ([...inner.read, ...inner.write].some(n => !types.has(n))) return 'unknown_type';
  return inner.write.some(n => types.get(n).write !== true) ? 'not_writable' : null;
}

export function normalizeAccessRequest(inner) {
  if (['access_request', 'scope_release'].includes(inner.type)) for (const side of ['read', 'write']) inner[side] = normalizeScopeNames(inner[side]);
  return inner;
}

export function pairingReplyOutcomes(inner, scope) {
  if (inner?.v !== 1 || inner.type !== 'access_reply' || inner.request_ref !== scope.request_ref || inner.outcome !== 'resolved'
    || !isTimestamp(inner.decided_at) || Date.parse(inner.decided_at) < 0
    || Object.keys(inner).some(k => !['v', 'type', 'request_ref', 'decided_at', 'outcome', 'read', 'write'].includes(k))) return null;
  const outcomes = {};
  for (const side of ['read', 'write']) {
    const items = inner[side];
    if (!Array.isArray(items) || items.length !== scope[side].length || items.some((item, i) => !item || item.type !== scope[side][i]
      || Object.keys(item).some(k => !['type', 'outcome'].includes(k)) || !['allowed', 'declined', 'needs_health_settings'].includes(item.outcome))) return null;
    outcomes[side] = items.map(({ type, outcome }) => ({ type, outcome }));
  }
  return outcomes;
}
