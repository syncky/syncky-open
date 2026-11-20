import { ACCESS_RELAY_HINT, agentErrorCode, errorHint, LARGE_ACCESS_ACCEPTED_NOTICE } from './error-guidance.js';
import { RELAY_ERROR_CODES, RELAY_CLIENT_ERROR_CODES } from './relay-client.js';
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { cipherEntries, createCipherFiles, readHomeState, updateHomeState } from "./home-state.js";
import { retryHomeLock } from "./thin-lock.js";
import { privateStat, removePrivateFile, syncDirectory, withHomeLock } from "./protected-files.js";
import { iterateInbox, committedInboxRecord } from "./inbox.js";
import { activateResponseWaits, completeResponseWaits } from "./response-waits.js";
import { isAccessEnvelope, MAX_ACCESS_ENVELOPE_BYTES, MAX_CONTROL_ENVELOPE_BYTES } from './thin-transport.js';
import { v1AccessMember } from './pairing-access.js';

const relayCodes = new Set([...RELAY_ERROR_CODES, ...RELAY_CLIENT_ERROR_CODES]);
const relayCause = error => ({
  relay_code: relayCodes.has(agentErrorCode(error.code)) ? agentErrorCode(error.code) : 'relay_error',
  relay_status: Number.isInteger(error.status) && (error.status === 0 || error.status >= 100 && error.status <= 599) ? error.status : 0,
});

export function sendReceipt(entry) {
  const receipt = Object.fromEntries(["msg_id", "kind", "type", "to", "state", "seq", "attempts", "next_attempt_at", "retry_after_until", "code"].filter(k => entry[k] !== undefined).map(k => [k, entry[k]]));
  if (receipt.code) receipt.code = agentErrorCode(receipt.code);
  const access = ['access_request', 'access_reply'].includes(entry.type) && typeof entry.body === 'string' && isAccessEnvelope(JSON.parse(entry.body));
  const bytes = access ? Buffer.byteLength(entry.body) : 0;
  if (access) receipt.envelope_bytes = bytes;
  if (entry.state === 'sent' && entry.type === 'access_request' && bytes > MAX_CONTROL_ENVELOPE_BYTES) receipt.notice = LARGE_ACCESS_ACCEPTED_NOTICE;
  if (['pending', 'failed'].includes(entry.state) && entry.code) {
    if (entry.code !== 'target_revoked' && (entry.relay_code != null || entry.relay_status != null)) Object.assign(receipt, relayCause({ code: entry.relay_code, status: entry.relay_status }));
    const hint = receipt.relay_status === 413 && bytes > MAX_CONTROL_ENVELOPE_BYTES ? ACCESS_RELAY_HINT : errorHint(receipt.relay_code ?? entry.code);
    receipt.hint = (entry.state === 'pending' ? 'Queued; the receiver retries after the receipt deadline. ' : 'Terminal receipt; this send will not retry. ') + hint;
  }
  return receipt;
}

export function createOutbox({ home, relay, fs, now = () => new Date(), maxAttempts = 5, timeoutMs = 15000, timers = globalThis }) {
  const queue = createCipherFiles(home, "outbox", { fs }), active = new Map();
  const owner = `${process.pid}:${randomUUID()}`;
  const laneOf = entry => {
    const e = JSON.parse(entry.body), marker = Object.keys(e).find(k => !["v", "msg_id", "kind", "from", "created_at", "recipients", "nonce", "ciphertext"].includes(k));
    return marker ? `marker:${marker}` : entry.kind;
  };
  const candidates = () => retryHomeLock(() => cipherEntries(home, "outbox", { fs }));
  const change = (id, patch, when) => retryHomeLock(() => queue.update(id, patch, { when }));
  const liveV1Request = (state, entry, at) => {
    const row = state.pairings[entry.pairing_id], wait = entry.response_waits[0];
    return v1AccessMember(state, row)?.member_id === wait.member_id && row.public_key === wait.public_key
      && row.v1_request?.msg_id === entry.msg_id && row.v1_request.request_ref === wait.request_ref
      && Date.parse(row.v1_request.expires_at) > at;
  };
  const prune = async () => {
    const recovered = new Set((await recoverWaits()).map(e => e.msg_id));
    await retryHomeLock(() => withHomeLock(home, () => {
      const state = readHomeState(home, { fs });
      const protectedConfirmations = new Set(Object.values(state.pairings)
        .filter(row => v1AccessMember(state, row) && !row.v1_request?.queued).map(row => row.v1_confirmation));
      const receipts = cipherEntries(home, "outbox", { fs }).filter(e => ["sent", "failed"].includes(e.state)).sort((a, b) => a.msg_id.localeCompare(b.msg_id));
      for (const entry of receipts.slice(0, -100)) {
        if (protectedConfirmations.has(entry.msg_id) || (entry.pairing_id && liveV1Request(state, entry, now().getTime())
          && !state.pairings[entry.pairing_id].v1_request.queued)) continue;
        if (entry.state === "sent" && entry.response_waits?.length && !recovered.has(entry.msg_id)) continue;
        removePrivateFile(join(home, "outbox", `${entry.msg_id}.json`), { fs });
      }
    }, { fs }));
  };
  async function lane(laneId, signal) {
    for (const entry of (await candidates()).filter(e => e.state === "pending" && laneOf(e) === laneId)) {
      signal?.throwIfAborted();
      const state = await retryHomeLock(() => readHomeState(home, { fs }));
      if (Math.max(state.transport.send_lanes?.[laneId] ?? 0, laneId === "data" ? Number(state.transport.commands_retry_at) || 0 : 0) > now().getTime()) break;
      if (entry.to?.some(id => state.members[id]?.state !== "confirmed" || state.members[id]?.unpair_reason != null) || [true, "1"].includes(state.transport.hub_deleted) || [true, "1"].includes(state.transport.hub_revoked)) {
        await change(entry.msg_id, { state: "failed", code: "target_revoked", relay_code: null, relay_status: null }, e => e.state === "pending"); continue;
      }
      const at = now().getTime();
      if (entry.pairing_id && !liveV1Request(state, entry, at)) {
        await change(entry.msg_id, { state: 'failed', code: 'pairing_access_cancelled', relay_code: null, relay_status: null }, e => e.state === 'pending'); continue;
      }
      const bytes = Buffer.byteLength(entry.body), envelope = JSON.parse(entry.body);
      const cap = entry.kind === 'control' || envelope?.kind === 'control'
        ? isAccessEnvelope(envelope) ? MAX_ACCESS_ENVELOPE_BYTES : MAX_CONTROL_ENVELOPE_BYTES : 262144;
      if (bytes > cap) {
        await change(entry.msg_id, { state: 'failed', code: 'payload_too_large', relay_code: null, relay_status: null }, e => e.state === 'pending'); continue;
      }
      const claimed = await change(entry.msg_id, { lease_owner: owner, lease_until: at + timeoutMs + 15000, attempts: (entry.attempts ?? 0) + 1 }, e =>
        e.state === "pending" && (typeof e.next_attempt_at === "string" ? Date.parse(e.next_attempt_at) : e.next_attempt_at ?? 0) <= at
        && (e.retry_after_until ?? 0) <= at && (e.lease_until ?? 0) <= at
        && (!e.pairing_id || liveV1Request(readHomeState(home, { fs }), e, at)));
      if (!claimed) continue;
      const owned = e => e.state === "pending" && e.lease_owner === owner;
      const controller = new AbortController(), timer = timers.setTimeout(() => controller.abort(), timeoutMs);
      let result;
      try {
        const timeout = new Promise((_, reject) => controller.signal.addEventListener("abort", () => reject({ code: "timeout", status: 0 }), { once: true }));
        result = await Promise.race([relay.postMessage(claimed.body, { attempts: 1, signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal, deadline: at + timeoutMs }), timeout]);
        if (!Number.isSafeInteger(result?.seq) || result.seq < 0) throw { code: "invalid_response", status: 0 };
      } catch (err) {
        const limited = err.status === 429, failures = (claimed.failures ?? 0) + (limited ? 0 : 1);
        const retryable = limited || err.status === 0 || err.status >= 500 || ["timeout", "network_error"].includes(err.code) || signal?.aborted;
        const retryAt = now().getTime() + (retryable && Number.isFinite(err.retryAfterS) && err.retryAfterS >= 0 ? err.retryAfterS * 1000 : Math.min(60000, 1000 * 2 ** Math.min(failures, 10)));
        if (limited) await retryHomeLock(() => updateHomeState(home, s => { s.transport.send_lanes ??= {}; s.transport.send_lanes[laneId] = Math.max(s.transport.send_lanes[laneId] ?? 0, retryAt); }, { fs }));
        await change(entry.msg_id, { state: retryable && failures < maxAttempts ? "pending" : "failed", failures, ...relayCause(err), code: limited ? "rate_limited" : retryable ? "send_retry" : "send_failed",
          next_attempt_at: retryAt, retry_after_until: limited ? retryAt : 0, lease_owner: null, lease_until: 0 }, owned);
        break;
      } finally { timers.clearTimeout(timer); }
      await change(entry.msg_id, { state: "sent", seq: result.seq, sent_at: now().toISOString(), code: null, relay_code: null, relay_status: null, lease_owner: null, lease_until: 0 }, owned);
      await recoverWaits();
    }
  }
  async function recoverWaits() {
    const sent = (await candidates()).filter(e => e.state === "sent" && e.response_waits?.length);
    if (sent.length) await retryHomeLock(() => updateHomeState(home, s => {
      const activated = activateResponseWaits(s, sent, now().getTime());
      if (!activated.length) return;
      for (const { record } of iterateInbox(home, { fs, afterSeq: Math.min(...activated.map(w => w.inbox_after ?? -1)) })) {
        if (!committedInboxRecord(record, s)) continue;
        const correlations = activated.filter(w => record.from === w.member_id);
        for (const w of correlations) completeResponseWaits(s, w.member_id, w.public_key, record.inner, now().getTime(), record);
      }
    }, { fs }));
    return sent;
  }
  return {
    receipts: () => queue.list().map(sendReceipt),
    async flush({ signal } = {}) {
      await recoverWaits();
      const lanes = [...new Set((await candidates()).filter(e => e.state === "pending").map(laneOf))];
      await Promise.all(lanes.map(id => {
        if (!active.has(id)) active.set(id, lane(id, signal).finally(() => active.delete(id)));
        return active.get(id);
      }));
      if ((await candidates()).filter(e => ["sent", "failed"].includes(e.state)).length > 100) await prune();
      if (privateStat(join(home, "outbox"), { fs, directory: true, optional: true })) syncDirectory(join(home, "outbox"), { fs });
    },
  };
}
