import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { cipherEntries, createCipherFiles, readHomeState, updateHomeState } from "./home-state.js";
import { retryHomeLock } from "./thin-lock.js";
import { privateStat, removePrivateFile, syncDirectory, withHomeLock } from "./protected-files.js";

export function sendReceipt(entry) {
  return Object.fromEntries(["msg_id", "kind", "type", "to", "state", "seq", "attempts", "next_attempt_at", "retry_after_until", "code"].filter(k => entry[k] !== undefined).map(k => [k, entry[k]]));
}

export function createOutbox({ home, relay, fs, now = () => new Date(), maxAttempts = 5, timeoutMs = 15000 }) {
  const queue = createCipherFiles(home, "outbox", { fs }), active = new Map();
  const owner = `${process.pid}:${randomUUID()}`;
  const laneOf = entry => {
    const e = JSON.parse(entry.body), marker = Object.keys(e).find(k => !["v", "msg_id", "kind", "from", "created_at", "recipients", "nonce", "ciphertext"].includes(k));
    return marker ? `marker:${marker}` : entry.kind;
  };
  const candidates = () => retryHomeLock(() => cipherEntries(home, "outbox", { fs }));
  const change = (id, patch, when) => retryHomeLock(() => queue.update(id, patch, { when }));
  const prune = () => retryHomeLock(() => withHomeLock(home, () => {
    const receipts = cipherEntries(home, "outbox", { fs }).filter(e => ["sent", "failed"].includes(e.state)).sort((a, b) => a.msg_id.localeCompare(b.msg_id));
    for (const entry of receipts.slice(0, -100)) removePrivateFile(join(home, "outbox", `${entry.msg_id}.json`), { fs });
  }, { fs }));
  async function lane(laneId, signal) {
    for (const entry of (await candidates()).filter(e => e.state === "pending" && laneOf(e) === laneId)) {
      signal?.throwIfAborted();
      const state = readHomeState(home, { fs });
      if (Math.max(state.transport.send_lanes?.[laneId] ?? 0, laneId === "data" ? Number(state.transport.commands_retry_at) || 0 : 0) > now().getTime()) break;
      if (entry.to?.some(id => state.members[id]?.state !== "confirmed" || state.members[id]?.unpair_reason != null) || [true, "1"].includes(state.transport.hub_deleted) || [true, "1"].includes(state.transport.hub_revoked)) {
        await change(entry.msg_id, { state: "failed", code: "target_revoked" }, e => e.state === "pending"); continue;
      }
      const at = now().getTime();
      const claimed = await change(entry.msg_id, { lease_owner: owner, lease_until: at + timeoutMs + 15000, attempts: (entry.attempts ?? 0) + 1 }, e =>
        e.state === "pending" && (typeof e.next_attempt_at === "string" ? Date.parse(e.next_attempt_at) : e.next_attempt_at ?? 0) <= at && (e.retry_after_until ?? 0) <= at && (e.lease_until ?? 0) <= at);
      if (!claimed) continue;
      const owned = e => e.state === "pending" && e.lease_owner === owner;
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
      let result;
      try {
        const timeout = new Promise((_, reject) => controller.signal.addEventListener("abort", () => reject({ code: "timeout", status: 0 }), { once: true }));
        result = await Promise.race([relay.postMessage(claimed.body, { attempts: 1, signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal, deadline: at + timeoutMs }), timeout]);
        if (!Number.isSafeInteger(result?.seq) || result.seq < 0) throw { code: "invalid_response", status: 0 };
      } catch (err) {
        const limited = err.status === 429, failures = (claimed.failures ?? 0) + (limited ? 0 : 1);
        const retryable = limited || err.status === 0 || err.status >= 500 || ["timeout", "network_error"].includes(err.code) || signal?.aborted;
        const retryAt = now().getTime() + (limited && Number.isFinite(err.retryAfterS) && err.retryAfterS >= 0 ? err.retryAfterS * 1000 : Math.min(60000, 1000 * 2 ** Math.min(failures, 10)));
        if (limited) await retryHomeLock(() => updateHomeState(home, s => { s.transport.send_lanes ??= {}; s.transport.send_lanes[laneId] = Math.max(s.transport.send_lanes[laneId] ?? 0, retryAt); }, { fs }));
        await change(entry.msg_id, { state: retryable && failures < maxAttempts ? "pending" : "failed", failures, code: limited ? "rate_limited" : retryable ? "send_retry" : "send_failed",
          next_attempt_at: retryAt, retry_after_until: limited ? retryAt : 0, lease_owner: null, lease_until: 0 }, owned);
        break;
      } finally { clearTimeout(timer); }
      await change(entry.msg_id, { state: "sent", seq: result.seq, sent_at: now().toISOString(), code: null, lease_owner: null, lease_until: 0 }, owned);
    }
  }
  return {
    receipts: () => queue.list().map(sendReceipt),
    async flush({ signal } = {}) {
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
