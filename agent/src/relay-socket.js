import { RETRY_POLICY } from "./transport-time.js";

const HANDSHAKE_MS = 15_000;
const PING_MS = 30_000;
const MAX_ATTEMPTS = 3;
const MAX_TIMER_MS = 2 ** 31 - 1;
const USE_POLLING = 4403;
const REPLACED = 4409;

export function createRelaySocket({ connect, onWake, canConnect = () => true, reclaimReplaced = false, signal, now = Date.now, random = Math.random, timers = globalThis }) {
  let socket, listeners, timer, stopped = false, healthy = false, attempts = 0, owed = true;
  let firstSync = false, retryAt, retryNotBefore = 0;

  function schedule(callback, ms) {
    timers.clearTimeout(timer);
    timer = timers.setTimeout(callback, ms);
  }

  function disconnect() {
    timers.clearTimeout(timer);
    listeners?.abort();
    try { socket?.close(); } catch {}
    socket = undefined;
    healthy = false;
    firstSync = false;
  }

  function stop() {
    stopped = true;
    signal?.removeEventListener("abort", stop);
    disconnect();
  }

  function scheduleRetry() {
    const delay = Math.max(retryAt, retryNotBefore) - now();
    if (delay > MAX_TIMER_MS) schedule(scheduleRetry, MAX_TIMER_MS);
    else schedule(open, Math.max(0, delay));
  }

  function failed(code, reason) {
    disconnect();
    const retry = attempts < MAX_ATTEMPTS && code !== USE_POLLING && (code !== REPLACED || reclaimReplaced);
    if (retry) {
      owed = true;
      const { baseMs, factor, capMs } = RETRY_POLICY;
      retryAt = now() + Math.floor(random() * Math.min(capMs, baseMs * factor ** (attempts - 1)));
      scheduleRetry();
    }
    const end = code === USE_POLLING ? (reason === "first_sync_done" ? "first_sync_done" : "polling")
      : !retry || [1000, 1008, 4401].includes(code) ? "socket_closed" : undefined;
    onWake("failure", end);
  }

  function open() {
    retryAt = undefined;
    if (stopped || signal?.aborted || !canConnect(attempts > 0)) return;
    owed = false;
    attempts++;
    try { socket = connect(); }
    catch { failed(); return; }

    let waitingForPong = false, missedPongs = 0;
    function ping() {
      if (waitingForPong && ++missedPongs >= 2) { failed(); return; }
      waitingForPong = true;
      try { socket.send("ping"); }
      catch { failed(); return; }
      schedule(ping, PING_MS);
    }

    listeners = new AbortController();
    const options = { signal: listeners.signal };
    function failActive(code, reason) {
      // A failed native handshake can report another error while closing.
      if (!options.signal.aborted) failed(code, reason);
    }
    socket.addEventListener("open", () => {
      healthy = true;
      schedule(ping, PING_MS);
      onWake("subscribed");
    }, { ...options, once: true });
    socket.addEventListener("message", ({ data }) => {
      if (healthy && data === "changed") onWake("hint");
      if (healthy && data === "first_sync" && !firstSync) {
        firstSync = true;
        // A heartbeat before relay-initiated close avoids workerd's idle close delay.
        if (!waitingForPong) ping();
      }
      if (data === "pong") { waitingForPong = false; missedPongs = 0; }
    }, options);
    socket.addEventListener("error", () => failActive(), options);
    socket.addEventListener("close", ({ code, reason }) => failActive(code, reason), options);
    schedule(() => failed(), HANDSHAKE_MS);
  }

  signal?.addEventListener("abort", stop, { once: true });
  return {
    get healthy() { return healthy; },
    get firstSync() { return firstSync; },
    start() {
      if (!owed || retryAt !== undefined || stopped) return;
      if (now() >= retryNotBefore) open();
      else { retryAt = now(); scheduleRetry(); }
    },
    deferRetriesUntil(at) {
      if (stopped || !(at > retryNotBefore)) return;
      retryNotBefore = at;
      if (retryAt !== undefined) scheduleRetry();
    },
    stop,
  };
}
