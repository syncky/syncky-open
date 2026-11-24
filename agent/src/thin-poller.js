import { LocalStateError, POLL_INTERVAL_MIN_S, POLL_INTERVAL_MAX_S } from "./config.js";
import { readHomeState, updateHomeState } from "./home-state.js";
import { createInbox } from "./inbox.js";
import { acquireHomeLock } from "./protected-files.js";
import { createThinInbound } from "./thin-inbound.js";
import { retryHomeLock, retryReceiverLock } from "./thin-lock.js";
import { startThinFastPoll } from "./thin-pairing.js";
import { abortableSleep } from "./transport-time.js";
import { maintainPairingAccess } from './pairing-access.js';
import { hasResponseWait, latestCommandWaitStart, maintainResponseWaits, responseWaitUntil } from "./response-waits.js";

const MAX_TIMER_MS = 2 ** 31 - 1;
const FAST_POLL_S = 25;
const invalid = () => new LocalStateError("invalid_response", "invalid receive checkpoint");
const retryAt = (err, at, floor = 1000) => at + (err.status === 429 && Number.isFinite(err.retryAfterS) && err.retryAfterS >= 0 ? Math.max(1000, err.retryAfterS * 1000) : floor);
function inheritedRetry(transport) {
  // Older homes did not distinguish rate limits from transient retries.
  const legacyPoll = transport.poll_retry_after_until === undefined ? Number(transport.poll_retry_at) || 0 : 0;
  const legacyAck = transport.ack_retry_after_until === undefined ? Number(transport.ack_retry_at) || 0 : 0;
  return Math.max(Number(transport.retry_after_until) || 0, transport.poll_progress?.retry_after_until ?? 0,
    transport.poll_progress?.retry_at ?? 0, transport.poll_retry_after_until ?? 0, transport.ack_retry_after_until ?? 0, legacyPoll, legacyAck);
}
const nextPollAt = transport => transport.next_poll_at ?? transport.poll_progress?.next_poll_at ?? 0;
const canResumePage = transport => transport.pagination_after !== undefined && transport.pagination_after === transport.cursor;
const hubUnavailable = transport => [true, "1"].includes(transport.hub_revoked) || [true, "1"].includes(transport.hub_deleted);
function connectionUntil(current) {
  const { pairings, transport } = current;
  if (hubUnavailable(transport)) return 0;
  const fast = transport.fast_poll;
  let until = fast?.devices?.length ? fast.until ?? 0 : 0;
  for (const row of Object.values(pairings)) {
    if (row.status === "pending") until = Math.max(until, Date.parse(row.expires_at));
  }
  return Math.max(until, responseWaitUntil(current));
}

async function cancellable(work, signal) {
  signal.throwIfAborted();
  let abort;
  const stopped = new Promise((_, reject) => {
    abort = () => reject(signal.reason); signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([Promise.resolve().then(work), stopped]); }
  finally { signal.removeEventListener("abort", abort); }
}

export function createThinPoller({ home, transport, self, relay, fs, now = () => new Date(), intervalS = 300, heartbeat, outbox, sleep, maxPages = 50, onRecord, watchPairing, observeHubState, pairingSocket, schedulePoll = (at, interval) => at + interval * 1000, timers = globalThis, setCycleTimer = timers.setTimeout }) {
  if (!Number.isSafeInteger(intervalS) || intervalS < POLL_INTERVAL_MIN_S || intervalS > POLL_INTERVAL_MAX_S) throw new LocalStateError("invalid_input", "invalid polling cadence");
  const options = { fs }, inbox = createInbox(home, options), inbound = createThinInbound({ home, transport, self, relay, fs, now, onRecord });
  const mutate = change => retryHomeLock(() => updateHomeState(home, change, options));
  const state = ({ signal, deadline = Infinity } = {}) => retryHomeLock(() => {
    signal?.throwIfAborted();
    if (now().getTime() >= deadline) throw new LocalStateError("timeout", "receive deadline reached");
    return readHomeState(home, options);
  });
  let active = false, scheduledAt;
  const scheduled = new Map();
  async function heartbeatIfDue(signal) {
    const day = now().toISOString().slice(0, 10);
    if (!heartbeat || (await state({ signal })).transport.heartbeat_day === day) return;
    await mutate(s => { s.transport.heartbeat_day = day; });
    return heartbeat({ signal });
  }
  function fastPollInterval(current, at, last = at) {
    const commandStarted = latestCommandWaitStart(current, at);
    if (commandStarted >= 0) return last < commandStarted ? 0 : FAST_POLL_S;
    const fast = current.transport.fast_poll;
    return fast?.devices?.length && fast.until > at ? FAST_POLL_S : undefined;
  }
  function cadence(current, at = now().getTime(), last = at) {
    return fastPollInterval(current, at, last) ?? (hasResponseWait(current, at) ? POLL_INTERVAL_MIN_S : intervalS);
  }
  function floorAt(current, at = now().getTime()) {
    const t = current.transport, last = t.last_poll_at ?? t.poll_progress?.last_poll_at;
    const attempted = t.poll_attempt_at;
    if (last === undefined && attempted === undefined) return nextPollAt(t);
    const lastActivity = Math.max(last ?? 0, attempted ?? 0);
    return scheduledDue(lastActivity, fastPollInterval(current, at, lastActivity) ?? POLL_INTERVAL_MIN_S);
  }
  function configuredDue(current, at = now().getTime()) {
    const t = current.transport, last = t.last_poll_at ?? t.poll_progress?.last_poll_at;
    return last === undefined ? nextPollAt(t) : scheduledDue(last, cadence(current, at, last));
  }
  function pollBackoffAt(current, at) {
    const t = current.transport, checkpoint = t.poll_retry_checkpoint;
    if (checkpoint && latestCommandWaitStart(current, at) > checkpoint.attempted_at) return 0;
    return t.poll_retry_at ?? 0;
  }
  function retryAfterAt(current, at) {
    const t = current.transport;
    const floorRetry = t.poll_retry_checkpoint?.reason === "poll_floor" ? pollBackoffAt(current, at) : 0;
    return Math.max(inheritedRetry(t), floorRetry);
  }
  function pollDue(current) {
    const at = now().getTime();
    return Math.max(configuredDue(current, at), floorAt(current, at));
  }
  function scheduledDue(at, interval) {
    if (scheduledAt !== at) { scheduled.clear(); scheduledAt = at; }
    if (!scheduled.has(interval)) scheduled.set(interval, schedulePoll(at, interval));
    return scheduled.get(interval);
  }
  async function maintain(context) {
    const current = await state(context), at = now().getTime();
    const pairingChanged = maintainPairingAccess(current, at), waitsChanged = maintainResponseWaits(current, at);
    const due = pollDue(current), changedDue = current.transport.last_poll_at !== undefined && current.transport.next_poll_at !== due;
    if (pairingChanged || waitsChanged || changedDue) return mutate(s => {
      maintainPairingAccess(s, at); maintainResponseWaits(s, at);
      if (s.transport.last_poll_at !== undefined) s.transport.next_poll_at = pollDue(s);
      return s;
    });
    return current;
  }
  function retryDeferral(current, at, operatorPoll) {
    const t = current.transport, retry = retryAfterAt(current, at);
    if (retry <= at) return null;
    let due = retry;
    if (operatorPoll && !canResumePage(t)) {
      due = Math.max(retry, floorAt(current, at));
      due = Math.max(due, floorAt(current, due));
    } else if (operatorPoll && t.pending_ack?.up_to_seq > t.acked_seq) {
      due = ackBackoffDeferral(current, retry, true)?.next_poll_at ?? retry;
    }
    return { deferred: true, reason: "retry_after", next_poll_at: due };
  }
  function ackBackoffDeferral(current, at, operator) {
    const backoff = Math.max(current.transport.ack_retry_at ?? 0, pollBackoffAt(current, at));
    if (backoff <= at) return null;
    if (operator) {
      const floor = floorAt(current, at);
      if (floor <= at) return null;
      const due = floorAt(current, floor);
      if (due < backoff) return { deferred: true, reason: "poll_floor", next_poll_at: due };
    }
    return { deferred: true, reason: "backoff", next_poll_at: backoff };
  }
  function eligibility(current, { operator = false, ackOnly = false, hinted = false } = {}) {
    const t = current.transport, at = now().getTime();
    const retry = retryDeferral(current, at, operator && !ackOnly);
    if (retry) return retry;
    if (ackOnly) return ackBackoffDeferral(current, at, operator);
    const backoff = pollBackoffAt(current, at);
    if (canResumePage(t) && (operator || backoff <= at)) return null;
    const floor = floorAt(current, at);
    if (!hinted && floor > at) return { deferred: true, reason: "poll_floor", next_poll_at: floor };
    if (!operator) {
      if (backoff > at) return { deferred: true, reason: "backoff", next_poll_at: backoff };
      const due = configuredDue(current, at);
      if (!hinted && due > at) return { deferred: true, reason: "cadence", next_poll_at: due };
    }
    return null;
  }
  function recordRetry(s, err, at, { bypassed = false, attemptedAt } = {}) {
    const t = s.transport;
    const hasRetryAfter = Number.isFinite(err.retryAfterS) && err.retryAfterS >= 0;
    const refusedBypass = bypassed && err.status === 429 && !hasRetryAfter;
    const pollFloor = attemptedAt !== undefined && err.status === 429 && err.details?.reason === "agent_poll_floor";
    const transientFetch = attemptedAt !== undefined && (err.status === 0 || err.status >= 500);
    t.poll_retry_at = retryAt(err, at, refusedBypass ? 1000 : cadence(s) * 1000);
    t.poll_retry_after_until ??= 0;
    if (pollFloor || transientFetch) {
      t.poll_retry_checkpoint = { attempted_at: attemptedAt, reason: pollFloor ? "poll_floor" : "transient" };
    } else {
      delete t.poll_retry_checkpoint;
    }
    if (pollFloor) return;
    if (err.status === 429 && !refusedBypass) t.poll_retry_after_until = Math.max(t.poll_retry_after_until, t.poll_retry_at);
    if (hasRetryAfter) t.poll_retry_after_until = Math.max(t.poll_retry_after_until, at + err.retryAfterS * 1000);
  }
  async function ack(seq, { signal, deadline, operator = false } = {}) {
    const context = { signal, deadline };
    signal?.throwIfAborted();
    const current = (await state(context)).transport;
    if (!Number.isSafeInteger(seq) || seq < 0 || seq > current.cursor) throw new LocalStateError("unsafe_ack", "ACK exceeds durable receive checkpoint");
    if (seq <= current.acked_seq) return { acked_up_to: current.acked_seq };
    const deferred = eligibility(await state(context), { ackOnly: true, operator });
    if (deferred) return deferred;
    await mutate(s => { s.transport.pending_ack = { up_to_seq: Math.max(s.transport.pending_ack?.up_to_seq ?? 0, seq) }; });
    try {
      await relay.ack(seq, { signal, deadline, independent: true });
    } catch (err) {
      await mutate(s => {
        s.transport.ack_retry_at = retryAt(err, now().getTime());
        s.transport.ack_retry_after_until ??= 0;
        if (err.status === 429) s.transport.ack_retry_after_until = Math.max(s.transport.ack_retry_after_until, s.transport.ack_retry_at);
        if (Number.isFinite(err.retryAfterS) && err.retryAfterS >= 0) s.transport.ack_retry_after_until = now().getTime() + err.retryAfterS * 1000;
      });
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
      if (err.code === "invalid_response") await mutate(s => {
        delete s.transport.pagination_after;
        delete s.transport.poll_retry_checkpoint;
        s.transport.poll_retry_after_until ??= 0;
        s.transport.poll_retry_at = Math.max(s.transport.poll_retry_at ?? 0, now().getTime() + cadence(s) * 1000);
        s.transport.poll_attempt_at = now().getTime();
      });
      throw err;
    }
  }
  async function receiveCycle({ signal, deadline, operator = false, onMaintenance, hints } = {}) {
    const context = { signal, deadline, operator };
    signal?.throwIfAborted();
    await inbound.reconcile(context);
    const maintained = await maintain(context);
    onMaintenance?.(maintained);
    const authoritative = retryDeferral(await state(context), now().getTime(), operator);
    if (authoritative) return authoritative;
    try { await inbound.releaseHeld(context); }
    catch (err) {
      if (err.status === 429 || err.status === 0 || err.status >= 500) await mutate(s => { recordRetry(s, err, now().getTime()); });
      throw err;
    }
    const pending = (await state(context)).transport.pending_ack;
    if (pending) {
      const result = await ack(pending.up_to_seq, context);
      if (result.deferred) return eligibility(await state(context), context) ?? result;
    }
    const opening = await state(context), normal = eligibility(opening, context);
    const bypassed = hints?.pending(opening)
      && (normal?.reason === "poll_floor" || normal?.reason === "cadence");
    const deferred = bypassed ? eligibility(opening, { ...context, hinted: true }) : normal;
    if (deferred) return deferred;
    hints?.consume();
    let pages = 0, fetched = 0;
    while (pages < maxPages) {
      signal?.throwIfAborted();
      const current = await state(context), at = now().getTime();
      const { cursor, poll_attempt_at } = current.transport;
      await mutate(s => { delete s.transport.pagination_after; s.transport.poll_attempt_at = at; });
      let page;
      try {
        page = await relay.getMessages({ after: cursor, limit: 100 }, {
          ...context, independent: true, pollIntervalS: intervalS, commandAck: latestCommandWaitStart(current, at) >= 0,
        });
      }
      catch (err) {
        await mutate(s => {
          recordRetry(s, err, now().getTime(), { bypassed: bypassed && pages === 0, attemptedAt: at });
          if (err.status !== 429) s.transport.poll_attempt_at = now().getTime();
          else if (poll_attempt_at === undefined) delete s.transport.poll_attempt_at;
          else s.transport.poll_attempt_at = poll_attempt_at;
          if (err.code === "invalid_token") s.transport.hub_revoked = true;
        });
        throw err;
      }
      const fetchedAt = now().getTime(), poison = [];
      signal?.throwIfAborted();
      pages++;
      if (!Array.isArray(page?.messages)) throw invalid();
      const rows = page.messages.filter(row => Number.isSafeInteger(row?.seq) && row.seq >= 0);
      if (page.messages.length && !rows.length) throw invalid();
      if (rows.length) {
        let previous = -1;
        let capacityError;
        for (const row of rows) {
          if (row.seq <= previous) throw invalid();
          previous = row.seq;
        }
        if (page.next_after !== previous) throw invalid();
        const malformed = page.messages.length - rows.length;
        if (malformed) poison.push({ status: "poison", code: "malformed", count: malformed });
        for (const row of rows) {
          signal?.throwIfAborted();
          if (row.seq <= cursor) continue;
          let result;
          try { result = await inbound.receive(row, context); await inbound.releaseHeld(context); }
          catch (err) {
            if (err.code === "inbox_seen_limit") { capacityError ??= err; continue; }
            if (err.status === 429 || err.status === 0 || err.status >= 500) await mutate(s => { recordRetry(s, err, now().getTime()); });
            throw err;
          }
          if (result.status === "poison" || result.status === "metadata") poison.push({ seq: row.seq, status: result.status, code: result.code });
          fetched++;
        }
        if (capacityError) throw capacityError;
      }
      signal?.throwIfAborted();
      await mutate(s => {
        if (rows.length) {
          s.transport.cursor = Math.max(s.transport.cursor, rows.at(-1).seq);
          s.transport.pending_ack = { up_to_seq: s.transport.cursor };
          s.transport.events = [...(s.transport.events ?? []), ...poison].slice(-100);
        }
        s.transport.last_poll_at = fetchedAt; s.transport.poll_retry_at = 0; s.transport.poll_interval_s = intervalS;
        delete s.transport.poll_retry_checkpoint;
        if (page.has_more === true && rows.length && rows.at(-1).seq > cursor) s.transport.pagination_after = s.transport.cursor;
        else delete s.transport.pagination_after;
        s.transport.poll_attempt_at = fetchedAt;
        s.transport.next_poll_at = pollDue(s);
      });
      if (rows.length) {
        await inbound.releaseHeld(context);
        await ack((await state(context)).transport.cursor, context);
      }
      if (!rows.length || page.has_more !== true || rows.at(-1).seq <= cursor) break;
    }
    await mutate(s => { maintainPairingAccess(s, now().getTime(), { received: true }); maintainResponseWaits(s, now().getTime()); });
    return { pages, fetched, capped: pages === maxPages, acked_up_to: (await state(context)).transport.acked_seq };
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
    async once({ signal, deadline, operator = true, hints, yieldToReceiver = false } = {}) {
      signal?.throwIfAborted();
      const release = yieldToReceiver ? acquire("once") : await retryReceiverLock(() => acquire("once"), { signal, sleep, deadline, now });
      const controller = new AbortController();
      const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      deadline = Math.min(deadline ?? Infinity, now().getTime() + 15000);
      const timer = setCycleTimer(() => controller.abort(), Math.max(0, deadline - now().getTime())), tasks = [];
      try {
        await inbound.reconcile({ signal: combined, deadline });
        await retryHomeLock(() => inbox.prune(now()));
        if (watchPairing) await watchPairing({ signal: combined, deadline });
        if (observeHubState) tasks.push(cancellable(() => observeHubState({ signal: combined }), combined).catch(() => {}));
        tasks.push(cancellable(() => heartbeatIfDue(combined), combined).catch(() => {}));
        if (outbox) tasks.push(cancellable(() => outbox.flush({ signal: combined }), combined).catch(() => {}));
        const result = await cycle({ signal: combined, deadline, operator, hints: hints && {
          pending: current => !hubUnavailable(current.transport)
            && (hints.hasWindow?.() || connectionUntil(current) > now().getTime()) && hints.pending(),
          consume: () => hints.consume(),
        } });
        await Promise.all(tasks); return result;
      } finally { controller.abort(); timers.clearTimeout(timer); await Promise.allSettled(tasks); release(); }
    },
    start() {
      const release = acquire("receiver"), controller = new AbortController(), tasks = new Set();
      const context = { signal: controller.signal };
      let stopped = false, pruneAt = -Infinity;
      let connection, windowUntil = 0, windowTimer, pairingRetryAt = 0, sleeping;
      let hintPending = false, pairingWake = false, connectionFailed = false;
      const hints = {
        pending: current => hintPending && connection?.healthy && !hubUnavailable(current.transport)
          && (connection.firstSync || connectionUntil(current) > now().getTime()),
        consume: () => { hintPending = false; },
      };
      function retireConnection() {
        timers.clearTimeout(windowTimer);
        connection?.stop();
        connection = undefined;
        hintPending = pairingWake = connectionFailed = false;
      }
      function watchWindowEnd() {
        timers.clearTimeout(windowTimer);
        windowTimer = timers.setTimeout(() => {
          if (connection?.firstSync) return;
          if (now().getTime() < windowUntil) return watchWindowEnd();
          let until;
          try { until = connectionUntil(readHomeState(home, options)); }
          catch { windowTimer = timers.setTimeout(watchWindowEnd, 1000); return; }
          if (until <= now().getTime()) retireConnection();
          else { windowUntil = until; watchWindowEnd(); }
        }, Math.min(MAX_TIMER_MS, Math.max(0, windowUntil - now().getTime())));
      }
      function refreshConnection(current) {
        if (!pairingSocket) return;
        const at = now().getTime();
        windowUntil = connectionUntil(current);
        if (hubUnavailable(current.transport)) {
          retireConnection();
          return;
        }
        if (windowUntil <= at) {
          if (!connection?.firstSync) retireConnection();
          return;
        }
        connection ??= pairingSocket({
          signal: controller.signal,
          reclaimReplaced: true,
          canConnect(retrying) {
            const at = now().getTime();
            if (windowUntil <= at) return false;
            if (!retrying) return true;
            try { return connectionUntil(readHomeState(home, options)) > at; }
            catch { return false; }
          },
          onWake(event) {
            hintPending = event !== "failure";
            if (!hintPending) connectionFailed = true;
            pairingWake = true;
            sleeping?.abort();
          },
        });
        watchWindowEnd();
        const retryAt = Math.max(retryAfterAt(current, at), pairingRetryAt);
        connection.deferRetriesUntil(retryAt);
        if (at >= retryAt) connection.start();
      }
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
      function backgroundWork() {
        if (watchPairing) background(() => watchPairing({
          ...context,
          healthy: connection?.healthy,
          wake: pairingWake ? () => { pairingWake = false; } : undefined,
          deferRetriesUntil(at) {
            pairingRetryAt = Math.max(pairingRetryAt, at);
            connection?.deferRetriesUntil(pairingRetryAt);
          },
        }));
        if (observeHubState) background(() => observeHubState(context));
        if (outbox) background(() => outbox.flush(context));
      }
      async function pause(ms) {
        if (!connection) return abortableSleep(ms, sleep, controller.signal);
        const wake = new AbortController();
        sleeping = wake;
        try { await abortableSleep(ms, sleep, AbortSignal.any([controller.signal, wake.signal])); }
        catch (error) { if (!wake.signal.aborted || controller.signal.aborted) throw error; }
        finally { sleeping = undefined; }
      }
      const done = (async () => {
        try {
          while (!stopped) {
            await inbound.reconcile(context);
            await pruneIfDue();
            connectionFailed = false;
            try {
              await cycle({ ...context, hints, onMaintenance(current) {
                refreshConnection(current);
                backgroundWork();
                background(() => heartbeatIfDue(controller.signal));
              } });
            }
            catch (err) {
              if (stopped) break;
              if (err.code === "invalid_token") return { reason: "invalid_token" };
              await mutate(s => { s.transport.poll_retry_after_until ??= 0; s.transport.poll_retry_at = Math.max(s.transport.poll_retry_at ?? 0, now().getTime() + 1000); });
            }
            if (stopped) break;
            const fallback = now().getTime() + 1000;
            let snapshot = await state(context);
            refreshConnection(snapshot);
            while (!stopped) {
              const current = snapshot.transport, at = now().getTime();
              const next = current.pending_ack ? current.ack_retry_at ?? 0
                : hints.pending(snapshot) || canResumePage(current) ? 0 : pollDue(snapshot) || fallback;
              const due = Math.max(pollBackoffAt(snapshot, at), next, retryAfterAt(snapshot, at));
              if (connectionFailed || at >= due) break;
              await pause(Math.min(1000, due - at));
              if (stopped) break;
              await pruneIfDue();
              snapshot = await maintain(context);
              refreshConnection(snapshot);
              backgroundWork();
            }
          }
          return { reason: "stopped" };
        } catch (err) { if (!stopped) throw err; return { reason: "stopped" }; }
        finally { controller.abort(); timers.clearTimeout(windowTimer); await Promise.allSettled([...tasks]); release(); }
      })();
      return { done, stop() { stopped = true; controller.abort(); return done; } };
    },
  };
}
