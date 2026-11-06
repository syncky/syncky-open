import { setTimeout as delay } from "node:timers/promises";
import { parseTimestamp } from "./encoding.js";

export const JOIN_GRACE_MS = 900_000;
export const RETRY_POLICY = Object.freeze({ baseMs: 1000, factor: 2, capMs: 60_000, maxAttempts: 5 });

export async function abortableSleep(ms, sleep, signal) {
  signal?.throwIfAborted();
  if (!sleep) return delay(ms, undefined, { signal });
  let abort;
  const stopped = new Promise((_, reject) => {
    abort = () => reject(signal.reason);
    signal?.addEventListener("abort", abort, { once: true });
  });
  try {
    await Promise.race([sleep(ms), stopped]);
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

export function joinGraceUntil(completedAt, now = Date.now()) {
  const at = typeof completedAt === "string" ? parseTimestamp(completedAt) : null;
  return at !== null ? Math.min(at, now) + JOIN_GRACE_MS : 0;
}
