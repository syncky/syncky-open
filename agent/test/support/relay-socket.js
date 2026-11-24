import { saveConfig } from '../../src/config.js';
import { createHomeState } from '../../src/home-state.js';
import { saveSecrets } from '../../src/secrets.js';
import { fixture, identity, keys } from './thin-home.js';

export function socketClock(start = 0) {
  let at = start;
  const pending = new Map();
  const timers = {
    setTimeout(run, ms) {
      const id = Symbol();
      pending.set(id, { at: at + ms, run });
      return id;
    },
    clearTimeout: id => pending.delete(id),
  };
  function advance(ms) {
    const end = at + ms;
    for (;;) {
      const next = [...pending].filter(([, job]) => job.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, job] = next;
      pending.delete(id);
      at = job.at;
      job.run();
    }
    at = end;
  }
  return { now: () => at, timers, pending, advance };
}

export function fakeSockets() {
  const sockets = [];
  class WebSocket extends EventTarget {
    sent = [];
    closes = 0;
    constructor(url) {
      super();
      this.url = url;
      sockets.push(this);
    }
    send(data) { this.sent.push(data); }
    close() { this.closes++; }
    open() { this.dispatchEvent(new Event('open')); }
    message(data) { this.dispatchEvent(new MessageEvent('message', { data })); }
    error() { this.dispatchEvent(new Event('error')); }
    peerClose(code, reason = '') { this.dispatchEvent(Object.assign(new Event('close'), { code, reason })); }
  }
  return { WebSocket, sockets, connect: () => new WebSocket() };
}

export function stepSleep() {
  let next = Promise.withResolvers();
  return {
    sleep(ms) {
      const pause = Promise.withResolvers();
      next.resolve({ ms, resume: pause.resolve });
      return pause.promise;
    },
    async next() {
      const step = await next.promise;
      next = Promise.withResolvers();
      return step;
    },
  };
}

export function pairingWaitHome(t, config) {
  const home = fixture(t), baseUrl = 'https://relay.example';
  createHomeState(home, identity);
  saveConfig(home, { relay_url: baseUrl, name: 'Test', ...config });
  saveSecrets(home, { private_key: keys.agent.sk, public_key: keys.agent.pk,
    token: `sk_${identity.hub_id}_${'T'.repeat(40)}`, webhook_secret: `whsec_${'W'.repeat(43)}` });
  const clock = socketClock(Date.parse('2026-11-19T12:00:00Z'));
  const now = () => new Date(clock.now());
  const pending = { pairing_id: `p_${'P'.repeat(22)}`, pairing_token: `pt_${'T'.repeat(43)}`,
    expires_at: new Date(clock.now() + 600_000).toISOString() };
  return { home, baseUrl, now, clock, pending, ...fakeSockets() };
}
