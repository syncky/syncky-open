import { updateHomeState } from '../../src/home-state.js';
import { now } from './thin-transport.js';

export const pairingId = 'p_' + 'A'.repeat(22);
export const requestedScope = { request_ref: 'a'.repeat(32), read: ['steps'], write: ['body_mass'] };
export function scopedRequest(home) {
  updateHomeState(home, s => {
    const member = s.members.m_dev_1;
    member.pairing_id = pairingId;
    s.pairings[pairingId] = { pairing_id: pairingId, status: 'completed', version: 2,
      expires_at: new Date(now().getTime() + 600000).toISOString(), requested_scope: structuredClone(requestedScope),
      member_id: member.member_id, public_key: member.public_key,
      access: { state: 'awaiting', joined_at: now().toISOString(), deadline_at: new Date(now().getTime() + 900000).toISOString(),
        ...(member.state === 'confirmed' && { confirmed_at: member.confirmed_at }) } };
  });
}
export const resolvedReply = () => ({ v: 1, type: 'access_reply', request_ref: requestedScope.request_ref,
  decided_at: now().toISOString(), outcome: 'resolved', read: [{ type: 'steps', outcome: 'allowed' }],
  write: [{ type: 'body_mass', outcome: 'needs_health_settings' }] });
