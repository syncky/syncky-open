import Ajv from 'ajv/dist/2020.js';
import { isB64u, isTimestamp } from './encoding.js';
import { isMemberId, isPairingId } from './ids.js';
import { isRequestRef } from './access-scope.js';
import { loadJson } from './protocol-files.js';

export const RESPONSE_WAIT_MS = 900000;
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const time = v => Number.isSafeInteger(v) && v >= 0;
const commandId = v => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(v);
const version = v => Number.isSafeInteger(v) && v > 0;
const names = v => Array.isArray(v) && v.every((n, i) => typeof n === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(n) && (!i || v[i - 1] < n));
export const responseWaitKey = w => JSON.stringify([w.kind, w.member_id, w.public_key, w.request_ref ?? w.command_id, w.version ?? null]);

export function validResponseCorrelation(w) {
  if (!object(w) || !['access', 'diagnostics', 'command'].includes(w.kind) || !isMemberId(w.member_id) || !w.member_id.startsWith('m_dev_')
    || !isB64u(w.public_key, { length: 32 }) || !time(w.opened_at)) return false;
  if (w.kind === 'command') return commandId(w.command_id) && version(w.version) && w.expires_at === null
    && Object.keys(w).every(k => ['kind', 'member_id', 'public_key', 'opened_at', 'expires_at', 'command_id', 'version'].includes(k));
  return isRequestRef(w.request_ref) && time(w.expires_at) && (w.kind !== 'access' || (names(w.read) && names(w.write)))
    && Object.keys(w).every(k => ['kind', 'member_id', 'public_key', 'opened_at', 'expires_at', 'request_ref', ...(w.kind === 'access' ? ['read', 'write'] : [])].includes(k));
}

export function validResponseWaits(waits) {
  return waits === undefined || (object(waits) && Object.entries(waits).every(([key, w]) => {
    if (!object(w) || !time(w.expires_at) || !['queued', 'sent'].includes(w.state) || (w.completed_at !== undefined && !time(w.completed_at))) return false;
    if (w.kind === 'pairing') return key === `pairing:${w.pairing_id}` && isPairingId(w.pairing_id) && time(w.opened_at)
      && isRequestRef(w.request_ref) && ((w.member_id === null && w.public_key === null) || (isMemberId(w.member_id) && isB64u(w.public_key, { length: 32 })))
      && Object.keys(w).every(k => ['kind', 'pairing_id', 'request_ref', 'member_id', 'public_key', 'state', 'opened_at', 'expires_at'].includes(k));
    const { state, completed_at, merged_into, ...correlation } = w;
    return (merged_into === undefined || (w.kind === 'access' && isRequestRef(merged_into) && merged_into !== w.request_ref))
      && key === responseWaitKey(w) && validResponseCorrelation({ ...correlation, expires_at: w.kind === 'command' ? null : w.expires_at });
  }));
}

export function validCommandWaitDeadlines(deadlines) {
  return deadlines === undefined || (object(deadlines) && Object.entries(deadlines).every(([key, w]) => object(w)
    && w.kind === 'command' && key === responseWaitKey(w) && time(w.expires_at) && w.expires_at === w.opened_at + RESPONSE_WAIT_MS
    && validResponseCorrelation({ ...w, expires_at: null })));
}

export function responseCorrelations(inner, member, at) {
  const base = { member_id: member.member_id, public_key: member.public_key, opened_at: at };
  if (inner.v !== 1) return [];
  if (inner.type === 'commands' && Array.isArray(inner.commands)) return [...new Map(inner.commands.filter(c => commandId(c?.command_id) && version(c?.version))
    .map(c => { const w = { ...base, kind: 'command', command_id: c.command_id, version: c.version, expires_at: null }; return [responseWaitKey(w), w]; })).values()];
  if (!['access_request', 'diagnostics_request'].includes(inner.type) || !isRequestRef(inner.request_ref) || !isTimestamp(inner.expires_at) || !isTimestamp(inner.created_at)) return [];
  const w = { ...base, kind: inner.type === 'access_request' ? 'access' : 'diagnostics', request_ref: inner.request_ref, expires_at: Date.parse(inner.expires_at),
    ...(inner.type === 'access_request' && { read: inner.read, write: inner.write }) };
  return validResponseCorrelation(w) ? [w] : [];
}

export function maintainResponseWaits(state, at) {
  const before = JSON.stringify(state.transport.response_waits), previous = state.transport.response_waits ?? {}, waits = state.transport.response_waits ?? {};
  const deadlinesBefore = JSON.stringify(state.transport.command_wait_deadlines);
  const pairingOpened = Object.fromEntries(Object.entries(previous).filter(([, w]) => w.kind === 'pairing').map(([key, w]) => [key, w.opened_at]));
  const hubGone = [true, '1'].includes(state.transport.hub_revoked) || [true, '1'].includes(state.transport.hub_deleted);
  for (const [key, w] of Object.entries(state.transport.command_wait_deadlines ?? {})) {
    const m = state.members[w.member_id];
    if (hubGone || !m || m.public_key !== w.public_key || m.state !== 'confirmed' || m.unpair_reason) delete state.transport.command_wait_deadlines[key];
  }
  for (const [key, w] of Object.entries(waits)) {
    const m = state.members[w.member_id];
    if (w.kind === 'pairing' || w.expires_at <= at || hubGone || !m || m.public_key !== w.public_key || m.state !== 'confirmed' || m.unpair_reason) delete waits[key];
  }
  for (const row of Object.values(state.pairings)) {
    if (hubGone || row.access?.state !== 'awaiting' || Date.parse(row.access.deadline_at) <= at) continue;
    const m = state.members[row.member_id];
    if (row.member_id && (!m || m.public_key !== row.public_key || !['joined', 'confirmed'].includes(m.state) || m.unpair_reason)) continue;
    waits[`pairing:${row.pairing_id}`] = { kind: 'pairing', pairing_id: row.pairing_id, request_ref: row.requested_scope.request_ref,
      member_id: row.member_id ?? null, public_key: row.public_key ?? null, state: row.member_id ? 'sent' : 'queued',
      opened_at: pairingOpened[`pairing:${row.pairing_id}`] ?? at, expires_at: Date.parse(row.access.deadline_at) };
  }
  if (before !== undefined || Object.keys(waits).length) state.transport.response_waits = waits;
  return before !== JSON.stringify(state.transport.response_waits) || deadlinesBefore !== JSON.stringify(state.transport.command_wait_deadlines);
}

export function activateResponseWaits(state, entries, at) {
  const seen = new Set(), activated = [];
  for (const entry of entries.filter(e => e.state === 'sent').sort((a, b) => Date.parse(a.sent_at) - Date.parse(b.sent_at))) {
    const sentAt = Date.parse(entry.sent_at);
    if (!time(sentAt)) continue;
    for (const correlation of entry.response_waits ?? []) {
      const key = responseWaitKey(correlation);
      if (seen.has(key)) continue;
      seen.add(key);
      let opened_at = sentAt, expires_at = correlation.expires_at ?? sentAt + RESPONSE_WAIT_MS;
      if (correlation.kind === 'command') {
        const deadlines = state.transport.command_wait_deadlines ??= {}, prior = state.transport.response_waits?.[key];
        deadlines[key] ??= { ...correlation, opened_at: prior?.opened_at ?? sentAt, expires_at: prior?.expires_at ?? expires_at };
        ({ opened_at, expires_at } = deadlines[key]);
      }
      state.transport.response_waits ??= {};
      if (expires_at > at && !state.transport.response_waits[key]) {
        state.transport.response_waits[key] = { ...correlation, state: 'sent', opened_at, expires_at };
        activated.push(correlation);
      }
    }
  }
  maintainResponseWaits(state, at);
  return activated;
}

let validators;
function valid(type, inner) {
  if (!validators) {
    const ajv = new Ajv({ strict: false, validateFormats: false });
    for (const name of ['inner-system', 'inner-sync', 'inner-diagnostics']) ajv.addSchema(loadJson(`schemas/${name}.schema.json`));
    const ref = (file, def) => ajv.compile({ $ref: `https://syncky.app/protocol/schemas/${file}.schema.json#/$defs/${def}` });
    validators = { access_reply: ref('inner-system', 'access_reply'), diagnostics_reply: ref('inner-system', 'diagnostics_reply'), diagnostics: ref('inner-diagnostics', 'diagnostics'), ack: ref('inner-sync', 'ack') };
  }
  return validators[type](inner);
}

export function completeResponseWaits(state, memberId, publicKey, inner, at) {
  if (state.members[memberId]?.state !== 'confirmed' || state.members[memberId].public_key !== publicKey || inner.v !== 1) return;
  const waits = Object.values(state.transport.response_waits ?? {});
  const accessReply = inner.type === 'access_reply' && valid(inner.type, inner);
  for (const w of waits) {
    if (w.kind === 'pairing' || w.member_id !== memberId || w.public_key !== publicKey || w.state !== 'sent' || w.completed_at !== undefined) continue;
    let matched = false;
    if (w.kind === 'access' && accessReply) {
      if (inner.outcome === 'merged' && inner.request_ref === w.request_ref) {
        const root = waits.find(r => r.kind === 'access' && r.member_id === memberId && r.public_key === publicKey && r.request_ref === inner.merged_into);
        if (inner.merged_into === w.request_ref || (w.merged_into && w.merged_into !== inner.merged_into) || root?.merged_into
          || waits.some(r => r.kind === 'access' && r.member_id === memberId && r.public_key === publicKey && r.merged_into === w.request_ref)
          || Object.values(state.pairings).some(p => p.requested_scope?.request_ref === inner.merged_into)
          || !['read', 'write'].every(side => inner[side].every(item => w[side].includes(item.type)))) continue;
        w.merged_into = inner.merged_into;
        w.expires_at = Math.min(w.expires_at, root?.expires_at ?? w.expires_at);
        if (root?.completed_at !== undefined) w.completed_at = root.completed_at;
        continue;
      }
      const terminal = ['resolved', 'expired'].includes(inner.outcome);
      const own = inner.request_ref === w.request_ref && !w.merged_into;
      const alias = terminal && inner.merged_refs?.includes(w.request_ref) && (!w.merged_into || w.merged_into === inner.request_ref);
      matched = inner.outcome !== 'merged' && (own || alias);
      if (matched && ['resolved', 'filtered'].includes(inner.outcome)) matched = ['read', 'write'].every(side =>
        w[side].every(type => inner[side].some(item => item.type === type))
        && (inner.merged_refs?.length || inner[side].length === w[side].length));
    }
    if (w.kind === 'diagnostics' && ['diagnostics', 'diagnostics_reply'].includes(inner.type) && inner.request_ref === w.request_ref) matched = valid(inner.type, inner);
    if (w.kind === 'command' && inner.type === 'sync' && Array.isArray(inner.acks)) matched = inner.acks.some(a => a?.command_id === w.command_id && a.version === w.version && valid('ack', a));
    // Recovery must not reopen a completed correlation before its original expiry.
    if (matched) w.completed_at = at;
  }
  maintainResponseWaits(state, at);
}

export const hasResponseWait = state => Object.values(state.transport.response_waits ?? {}).some(w => w.completed_at === undefined && (w.state === 'sent' || w.kind === 'pairing'));
