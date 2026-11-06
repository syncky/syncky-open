import { setTimeout as delay } from "node:timers/promises";
import { abortableSleep } from "./transport-time.js";

export async function retryReceiverLock(operation, { signal, sleep, deadline = Infinity, now = () => new Date() } = {}) {
  for (let attempt = 0;; attempt++) {
    signal?.throwIfAborted();
    try { return operation(); }
    catch (error) {
      if (error.code !== "home_locked" || attempt >= 200 || now().getTime() >= deadline) throw error;
      await abortableSleep(Math.min(100, deadline - now().getTime()), sleep, signal);
    }
  }
}

export async function retryHomeLock(operation) {
  for (let n = 0;; n++) {
    try { return operation(); }
    catch (error) {
      if (error.code !== "home_locked" || n >= 200) throw error;
      await delay(5 + n % 13);
    }
  }
}
