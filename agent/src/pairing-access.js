import { isB64u, isTimestamp } from './encoding.js';
import { isMemberId, isUuidV7 } from './ids.js';
import { isRequestRef, isStoredRequestedScope, pairingReplyOutcomes } from './access-scope.js';

export const PAIRING_REPLY_MS = 900000;
export const PAIRING_ACCESS_NOTICE = 'Pairing confirmed. No access reply arrived. Check Syncky on the phone. With Syncky 0.1.5, choose Health data on the phone, or update Syncky and ask your agent to send an access request.';
export const PAIRING_ACCESS_FOLLOW_UP = 'Send a follow-up only with renewed explicit owner approval and phone availability. Use a fresh request_ref and finite positive TTL <= 24 hours.';
export const V1_ACCESS_TTL_MS = 86400000;
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);

export function validV1Scope(scope) {
  return object(scope) && Object.keys(scope).length === 2 && isStoredRequestedScope({ ...scope, request_ref: '0'.repeat(32) });
}

export function validV1Intent(row) {
  if (row.v1_scope === undefined) return row.v1_confirmation === undefined && row.v1_request === undefined && row.v1_cancelled === undefined;
  if (row.version !== 1 || row.requested_scope !== undefined || !validV1Scope(row.v1_scope)
    || (row.v1_cancelled !== undefined && row.v1_cancelled !== true)) return false;
  if (row.v1_confirmation !== undefined && (row.status !== 'completed' || !isUuidV7(row.v1_confirmation)
    || !isMemberId(row.member_id) || !row.member_id.startsWith('m_dev_') || !isB64u(row.public_key, { length: 32 }))) return false;
  const request = row.v1_request;
  return request === undefined || (row.v1_confirmation !== undefined && object(request) && isUuidV7(request.msg_id)
    && isRequestRef(request.request_ref) && isTimestamp(request.created_at)
    && isTimestamp(request.expires_at) && Date.parse(request.expires_at) - Date.parse(request.created_at) === V1_ACCESS_TTL_MS
    && (request.queued === undefined || request.queued === true));
}

export function v1AccessMember(state, row) {
  if (!row?.v1_scope || row.v1_cancelled || row.status !== 'completed' || !row.v1_confirmation
    || [true, '1'].includes(state.transport.hub_revoked) || [true, '1'].includes(state.transport.hub_deleted)) return null;
  const member = state.members[row.member_id];
  return member?.role === 'device' && member.state === 'confirmed' && member.confirmation_method === 'fingerprint'
    && member.pairing_id === row.pairing_id && member.public_key === row.public_key && member.unpair_reason == null ? member : null;
}

export function validPairingAccess(row) {
  if (row.requested_scope === undefined) return row.access === undefined;
  if (!isStoredRequestedScope(row.requested_scope) || !object(row.access)
    || !['awaiting', 'resolved', 'no_reply', 'cancelled'].includes(row.access.state) || !isTimestamp(row.access.deadline_at)) return false;
  const access = row.access;
  for (const key of ['joined_at', 'confirmed_at', 'notice_at', 'decided_at']) if (access[key] !== undefined && !isTimestamp(access[key])) return false;
  const start = access.confirmed_at ?? access.joined_at;
  if (Date.parse(access.deadline_at) !== (start ? Date.parse(start) + PAIRING_REPLY_MS : Date.parse(row.expires_at))) return false;
  if ((row.member_id !== undefined || row.public_key !== undefined) && (!isMemberId(row.member_id) || !row.member_id.startsWith('m_dev_') || !isB64u(row.public_key, { length: 32 }))) return false;
  if ((row.status === 'completed' || access.confirmed_at) && (!row.member_id || !row.public_key)) return false;
  if (access.state === 'no_reply' && !access.confirmed_at) return false;
  if (access.state === 'resolved') {
    if (!object(access.outcomes) || !access.confirmed_at || !access.decided_at) return false;
    if (!pairingReplyOutcomes({ ...access.outcomes, v: 1, type: 'access_reply', outcome: 'resolved',
      request_ref: row.requested_scope.request_ref, decided_at: access.decided_at }, row.requested_scope)) return false;
  } else if (access.outcomes !== undefined || access.decided_at !== undefined) return false;
  return true;
}

export function cancelPairingAccess(row) {
  if (row?.v1_scope) row.v1_cancelled = true;
  if (row?.access && row.access.state !== 'resolved') row.access.state = 'cancelled';
}

export function maintainPairingAccess(state, at, { received = false } = {}) {
  let changed = false;
  for (const row of Object.values(state.pairings)) {
    if (row.v1_scope && !row.v1_cancelled && (row.status === 'expired' || (row.v1_confirmation && !v1AccessMember(state, row)))) {
      row.v1_cancelled = true; changed = true;
    }
    const access = row.access;
    if (!access || access.state !== 'awaiting') continue;
    const member = state.members[row.member_id];
    // A locally expired link may already be completed on the relay.
    if (row.status === 'expired' || ['revoked', 'rejected'].includes(member?.state) || member?.unpair_reason
      || [true, '1'].includes(state.transport.hub_revoked) || [true, '1'].includes(state.transport.hub_deleted)) {
      access.state = 'cancelled'; changed = true;
    } else if (row.status !== 'pending' && Date.parse(access.deadline_at) <= at) {
      access.state = access.confirmed_at ? 'no_reply' : 'cancelled';
      changed = true;
    } else if (received && access.confirmed_at && !access.notice_at) {
      access.notice_at = new Date(at).toISOString(); changed = true;
    }
  }
  return changed;
}

export function recordPairingReply(state, memberId, publicKey, inner) {
  const member = state.members[memberId], row = state.pairings[member?.pairing_id];
  if (member?.state !== 'confirmed' || member.public_key !== publicKey || !row?.requested_scope || row.status !== 'completed'
    || row.member_id !== memberId || row.public_key !== publicKey || !['awaiting', 'no_reply'].includes(row.access?.state)) return;
  const outcomes = pairingReplyOutcomes(inner, row.requested_scope);
  if (!outcomes) return;
  row.access.state = 'resolved'; row.access.outcomes = outcomes; row.access.decided_at = inner.decided_at;
}

export function pairingAccessView(row, { ended = false } = {}) {
  if (!row?.requested_scope || !row.access) return null;
  const access = row.access;
  const notice = access.state === 'no_reply' || (access.state === 'awaiting' && (access.notice_at || (ended && access.confirmed_at)));
  return { requested_scope: { read: row.requested_scope.read, write: row.requested_scope.write }, state: access.state, expires_at: row.expires_at,
    deadline_at: access.deadline_at, confirmed_at: access.confirmed_at ?? null, outcomes: access.outcomes ?? null,
    decided_at: access.decided_at ?? null,
    notice: notice ? PAIRING_ACCESS_NOTICE : null, ...(notice && { follow_up: PAIRING_ACCESS_FOLLOW_UP }) };
}
