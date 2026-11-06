import { LocalStateError, POLL_INTERVAL_MIN_S, POLL_INTERVAL_MAX_S } from "./config.js";
import { readHomeState, updateHomeState } from "./home-state.js";
import { createInbox } from "./inbox.js";
import { acquireHomeLock } from "./protected-files.js";
import { createThinInbound } from "./thin-inbound.js";
import { retryHomeLock, retryReceiverLock } from "./thin-lock.js";
import { startThinFastPoll } from "./thin-pairing.js";
import { abortableSleep } from "./transport-time.js";

const invalid = () => new LocalStateError("invalid_response", "invalid receive checkpoint");
const retryAt = (err, at, floor = 1000) => at + (err.status === 429 && Number.isFinite(err.retryAfterS) && err.retryAfterS >= 0 ? Math.max(1000, err.retryAfterS * 1000) : floor);
function inheritedRetry(transport) {
  return Math.max(Number(transport.retry_after_until) || 0, transport.poll_progress?.retry_after_until ?? 0, transport.poll_progress?.retry_at ?? 0);
}
const nextPollAt = transport => transport.next_poll_at ?? transport.poll_progress?.next_poll_at ?? 0;
async function cancellable(work, signal) {
  signal.throwIfAborted();
  let abort;
  const stopped = new Promise((_, reject) => {
    abort = () => reject(signal.reason); signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([Promise.resolve().then(work), stopped]); }
  finally { signal.removeEventListener("abort", abort); }
}

export function createThinPoller({ home, transport, self, relay, fs, now = () => new Date(), intervalS = 300, heartbeat, outbox, sleep, maxPages = 50, onRecord, watchPairing, observeHubState, schedulePoll = (at, interval) => at + interval * 1000 }) {
  if (!Number.isSafeInteger(intervalS) || intervalS < POLL_INTERVAL_MIN_S || intervalS > POLL_INTERVAL_MAX_S) throw new LocalStateError("invalid_input", "invalid polling cadence");
  const options = { fs }, inbox = createInbox(home, options), inbound = createThinInbound({ home, transport, self, relay, fs, now, onRecord });
  const mutate = change => retryHomeLock(() => updateHomeState(home, change, options));
  const state = () => readHomeState(home, options);
  let active = false;
  async function heartbeatIfDue(signal) {
    const day = now().toISOString().slice(0, 10);
    if (!heartbeat || state().transport.heartbeat_day === day) return;
    await mutate(s => { s.transport.heartbeat_day = day; });
    return heartbeat({ signal });
  }
  function cadence() {
    const fast = state().transport.fast_poll;
    return fast?.devices?.length && fast.until > now().getTime() ? 25 : intervalS;
  }
  async function ack(seq, { signal, deadline } = {}) {
    signal?.throwIfAborted();
    const current = state().transport;
    if (!Number.isSafeInteger(seq) || seq < 0 || seq > current.cursor) throw new LocalStateError("unsafe_ack", "ACK exceeds durable receive checkpoint");
    if (seq <= current.acked_seq) return { acked_up_to: current.acked_seq };
    if (Math.max(current.ack_retry_at ?? 0, current.poll_retry_at ?? 0, inheritedRetry(current)) > now().getTime()) return { deferred: true };
    await mutate(s => { s.transport.pending_ack = { up_to_seq: Math.max(s.transport.pending_ack?.up_to_seq ?? 0, seq) }; });
    try {
      await relay.ack(seq, { signal, deadline, independent: true });
    } catch (err) {
      await mutate(s => { s.transport.ack_retry_at = retryAt(err, now().getTime()); });
      throw err;
    }
    await mutate(s => {
      s.transport.acked_seq = Math.max(s.transport.acked_seq, seq);
      if (s.transport.pending_ack?.up_to_seq <= seq) s.transport.pending_ack = null;
      s.transport.ack_retry_at = 0; s.transport.last_ack_at = now().getTime();
    });
    return { acked_up_to: seq };
  }
  async function cycle(options) {
    try { return await receiveCycle(options); }
    catch (err) {
      if (err.code === "invalid_response") await mutate(s => { s.transport.poll_retry_at = Math.max(s.transport.poll_retry_at ?? 0, now().getTime() + cadence() * 1000); });
      throw err;
    }
  }
  async function receiveCycle({ signal, deadline } = {}) {
    const context = { signal, deadline };
    signal?.throwIfAborted();
    const retry = state().transport;
    if (Math.max(retry.poll_retry_at ?? 0, inheritedRetry(retry)) > now().getTime()) return { deferred: true };
    try { await inbound.releaseHeld(context); }
    catch (err) {
      if (err.status === 429 || err.status === 0 || err.status >= 500) await mutate(s => { s.transport.poll_retry_at = retryAt(err, now().getTime(), cadence() * 1000); });
      throw err;
    }
    const pending = state().transport.pending_ack;
    if (pending) {
      const result = await ack(pending.up_to_seq, context);
      if (result.deferred) return result;
    }
    const transportState = state().transport;
    if (Math.max(transportState.poll_retry_at ?? 0, nextPollAt(transportState), inheritedRetry(transportState)) > now().getTime()) return { deferred: true };
    let pages = 0, fetched = 0;
    while (pages < maxPages) {
      signal?.throwIfAborted();
      const current = state().transport;
      let page;
      try { page = await relay.getMessages({ after: current.cursor, limit: 100 }, { ...context, independent: true, pollIntervalS: intervalS }); }
      catch (err) {
        await mutate(s => {
          s.transport.poll_retry_at = retryAt(err, now().getTime(), cadence() * 1000);
          if (err.code === "invalid_token") s.transport.hub_revoked = true;
        });
        throw err;
      }
      signal?.throwIfAborted();
      const fetchedAt = now().getTime(), poison = [];
      pages++;
      if (!Array.isArray(page?.messages)) throw invalid();
      const rows = page.messages.filter(row => Number.isSafeInteger(row?.seq) && row.seq >= 0);
      if (page.messages.length && !rows.length) throw invalid();
      if (rows.length) {
        let previous = -1;
        for (const row of rows) {
          if (row.seq <= previous) throw invalid();
          previous = row.seq;
        }
        if (page.next_after !== previous) throw invalid();
        const malformed = page.messages.length - rows.length;
        if (malformed) poison.push({ status: "poison", code: "malformed", count: malformed });
        for (const row of rows) {
          signal?.throwIfAborted();
          if (row.seq <= current.cursor) continue;
          let result;
          try { result = await inbound.receive(row, context); await inbound.releaseHeld(context); }
          catch (err) {
            if (err.status === 429 || err.status === 0 || err.status >= 500) await mutate(s => { s.transport.poll_retry_at = retryAt(err, now().getTime(), cadence() * 1000); });
            throw err;
          }
          if (result.status === "poison" || result.status === "metadata") poison.push({ seq: row.seq, status: result.status, code: result.code });
          fetched++;
        }
      }
      signal?.throwIfAborted();
      const interval = cadence();
      await mutate(s => {
        if (rows.length) {
          s.transport.cursor = Math.max(s.transport.cursor, rows.at(-1).seq);
          s.transport.pending_ack = { up_to_seq: s.transport.cursor };
          s.transport.events = [...(s.transport.events ?? []), ...poison].slice(-100);
        }
        s.transport.last_poll_at = fetchedAt; s.transport.poll_retry_at = 0; s.transport.poll_interval_s = intervalS;
        s.transport.next_poll_at = schedulePoll(fetchedAt, interval);
      });
      if (rows.length) {
        await inbound.releaseHeld(context);
        await ack(state().transport.cursor, context);
      }
      if (!rows.length || page.has_more !== true) break;
    }
    return { pages, fetched, capped: pages === maxPages, acked_up_to: state().transport.acked_seq };
  }
  function acquire(role) {
    if (active) throw new LocalStateError("home_locked", "receiver is already active");
    const lease = acquireHomeLock(home, "receiver", { ...options, role }); active = true;
    return () => { active = false; lease.release(); };
  }
  return {
    ack,
    startFastPoll(memberId, graceUntil) {
      return mutate(s => startThinFastPoll(s, memberId, graceUntil, now().getTime()));
    },
    async once({ signal, deadline } = {}) {
      const release = await retryReceiverLock(() => acquire("once"), { signal, sleep, deadline, now }), controller = new AbortController();
      const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      deadline = Math.min(deadline ?? Infinity, now().getTime() + 15000);
      const timer = setTimeout(() => controller.abort(), Math.max(0, deadline - now().getTime())), tasks = [];
      try {
        await retryHomeLock(() => inbox.prune(now()));
        if (watchPairing) await watchPairing({ signal: combined, deadline });
        if (observeHubState) tasks.push(cancellable(() => observeHubState({ signal: combined }), combined).catch(() => {}));
        tasks.push(cancellable(() => heartbeatIfDue(combined), combined).catch(() => {}));
        if (outbox) tasks.push(cancellable(() => outbox.flush({ signal: combined }), combined).catch(() => {}));
        const result = await cycle({ signal: combined, deadline });
        await Promise.all(tasks); return result;
      } finally { controller.abort(); clearTimeout(timer); await Promise.allSettled(tasks); release(); }
    },
    start() {
      const release = acquire("receiver"), controller = new AbortController(), tasks = new Set();
      let stopped = false, pruneAt = -Infinity;
      async function pruneIfDue() {
        const at = now();
        if (at.getTime() < pruneAt) return;
        await retryHomeLock(() => inbox.prune(at));
        pruneAt = at.getTime() + 86400000;
      }
      function background(work) {
        const pending = cancellable(work, controller.signal).catch(() => {}).finally(() => tasks.delete(pending));
        tasks.add(pending);
      }
      const done = (async () => {
        try {
          while (!stopped) {
            await pruneIfDue();
            if (watchPairing) background(() => watchPairing({ signal: controller.signal }));
            if (observeHubState) background(() => observeHubState({ signal: controller.signal }));
            background(() => heartbeatIfDue(controller.signal));
            if (outbox) background(() => outbox.flush({ signal: controller.signal }));
            try { await cycle({ signal: controller.signal }); }
            catch (err) {
              if (stopped) break;
              if (err.code === "invalid_token") return { reason: "invalid_token" };
              await mutate(s => { s.transport.poll_retry_at = Math.max(s.transport.poll_retry_at ?? 0, now().getTime() + 1000); });
            }
            if (stopped) break;
            const fallback = now().getTime() + 1000;
            const dueAt = () => {
              const current = state().transport;
              const next = current.pending_ack ? current.ack_retry_at ?? 0 : nextPollAt(current) || fallback;
              return Math.max(current.poll_retry_at ?? 0, next, inheritedRetry(current));
            };
            while (!stopped && now().getTime() < dueAt()) {
              await abortableSleep(Math.min(1000, dueAt() - now().getTime()), sleep, controller.signal);
              if (!stopped) await pruneIfDue();
              if (!stopped && watchPairing) background(() => watchPairing({ signal: controller.signal }));
              if (!stopped && observeHubState) background(() => observeHubState({ signal: controller.signal }));
              if (outbox) background(() => outbox.flush({ signal: controller.signal }));
            }
          }
          return { reason: "stopped" };
        } catch (err) { if (!stopped) throw err; return { reason: "stopped" }; }
        finally { controller.abort(); await Promise.allSettled([...tasks]); release(); }
      })();
      return { done, stop() { stopped = true; controller.abort(); return done; } };
    },
  };
}
