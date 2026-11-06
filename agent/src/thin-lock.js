import { setTimeout as delay } from "node:timers/promises";

export async function retryHomeLock(operation) {
  for (let n = 0;; n++) {
    try { return operation(); }
    catch (error) {
      if (error.code !== "home_locked" || n >= 200) throw error;
      await delay(5 + n % 13);
    }
  }
}
