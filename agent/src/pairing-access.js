import { isB64u, isTimestamp } from './encoding.js';
import { isMemberId } from './ids.js';
import { isStoredRequestedScope, pairingReplyOutcomes } from './access-scope.js';

export const PAIRING_REPLY_MS = 900000;
export const PAIRING_ACCESS_NOTICE = 'Pairing confirmed; access reply not received. If using an older app, send --type access_request with a fresh request_ref and exactly 24-hour TTL. The phone may be offline or consent pending; missing replies do not identify an old app.';
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);

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
  if (row?.access && row.access.state !== 'resolved') row.access.state = 'cancelled';
}

export function maintainPairingAccess(state, at, { received = false } = {}) {
  let changed = false;
  for (const row of Object.values(state.pairings)) {
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

export function pairingAccessView(row) {
  if (!row?.requested_scope || !row.access) return null;
  const access = row.access;
  return { requested_scope: { read: row.requested_scope.read, write: row.requested_scope.write }, state: access.state, expires_at: row.expires_at,
    deadline_at: access.deadline_at, confirmed_at: access.confirmed_at ?? null, outcomes: access.outcomes ?? null,
    decided_at: access.decided_at ?? null,
    notice: access.state === 'no_reply' || (access.state === 'awaiting' && access.notice_at) ? PAIRING_ACCESS_NOTICE : null };
}
