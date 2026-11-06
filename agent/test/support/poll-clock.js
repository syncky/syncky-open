import { RelayError } from "../../src/relay-client.js";

const limited = (retryAfterS) => new RelayError({ status: 429, code: "rate_limited", retryAfterS });

export function pollClock(start = 0) {
  let at = start;
  const timers = new Set();
  const now = () => at;
  const sleep = (ms) => new Promise((resolve) => timers.add({ at: at + ms, resolve }));
  const settle = async () => {
    for (let i = 0; i < 40; i++) await Promise.resolve();
  };
  async function advance(ms) {
    at += ms;
    for (const timer of timers) {
      if (timer.at <= at) {
        timers.delete(timer);
        timer.resolve();
      }
    }
    await settle();
  }
  return { now, sleep, settle, advance };
}

export function floorRelay(clock, { last = null, graceUntil = 0, pages = 0, tokenUntil = 0 } = {}) {
  const attempts = [];
  let acked = false;
  return {
    attempts,
    join: (until) => { graceUntil = until; },
    limit: (until) => { tokenUntil = until; },
    ack: () => { acked = true; },
    fetch: async () => {
      const at = clock.now();
      attempts.push(at);
      if (at < tokenUntil) throw limited(Math.ceil((tokenUntil - at) / 1000));
      if (last !== null && at < last + 300_000 && at >= graceUntil && !acked) {
        throw limited(Math.ceil((last + 300_000 - at) / 1000));
      }
      acked = false;
      last = at;
      return { messages: [], next_after: 0, has_more: pages-- > 0 };
    },
  };
}
