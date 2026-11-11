import { isUuidV7 } from './ids.js';

const NAME = /^[a-z][a-z0-9_]{0,63}$/;
const names = v => Array.isArray(v) && v.every((n, i) => typeof n === 'string' && NAME.test(n) && (!i || v[i - 1] < n));
const merge = (a, b) => [...new Set([...a, ...b])].sort();
const holds = (side, name) => side === 'all' || (Array.isArray(side) && side.includes(name));

export function validScopeRelease(release) {
  return release === undefined || (release !== null && typeof release === 'object' && isUuidV7(release.msg_id)
    && names(release.read) && names(release.write) && (release.read.length > 0 || release.write.length > 0)
    && Number.isSafeInteger(release.requested_at) && release.requested_at >= 0
    && ['pending', 'applied', 'not_supported', 'failed'].includes(release.state)
    && (release.sent_seq === undefined || (Number.isSafeInteger(release.sent_seq) && release.sent_seq >= 0))
    && Object.keys(release).every(k => ['msg_id', 'read', 'write', 'requested_at', 'state', 'sent_seq'].includes(k)));
}

const sendFailed = (release, outbox) => outbox.find(e => e.msg_id === release.msg_id)?.state === 'failed';

export function recordScopeRelease(member, inner, msgId, at, outbox) {
  const settled = release => ['applied', 'failed'].includes(release.state) || sendFailed(release, outbox);
  const prior = member.scope_release && !settled(member.scope_release) ? member.scope_release : undefined;
  member.scope_release = { msg_id: msgId, read: merge(prior?.read ?? [], inner.read), write: merge(prior?.write ?? [], inner.write), requested_at: at, state: 'pending' };
}

// The phone sends no reply. A sync the relay accepted after the release tells the outcome:
// a phone that knows scope_release has narrowed the scope by then, an older phone ignored the message.
export function settleScopeRelease(member, seq, outbox) {
  const release = member.scope_release;
  if (!release || !member.scope) return;
  const entry = outbox.find(e => e.msg_id === release.msg_id);
  if (entry?.state === 'failed') { release.state = 'failed'; return; }
  if (entry?.state === 'sent' && Number.isSafeInteger(entry.seq)) release.sent_seq = entry.seq;
  // Receipts are pruned; without a recorded send the release was never seen leaving, so it is not judged.
  if (release.sent_seq === undefined || seq <= release.sent_seq) return;
  const kept = release.read.some(n => holds(member.scope.read, n)) || release.write.some(n => holds(member.scope.write, n));
  release.state = kept ? 'not_supported' : 'applied';
}

export const scopeReleaseView = (member, outbox) => member.scope_release && { read: member.scope_release.read, write: member.scope_release.write,
  requested_at: member.scope_release.requested_at,
  state: member.scope_release.state === 'pending' && sendFailed(member.scope_release, outbox) ? 'failed' : member.scope_release.state };
