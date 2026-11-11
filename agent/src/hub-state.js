import { isTimestamp } from './encoding.js';
import { readHomeState, updateHomeState } from './home-state.js';
import { retryHomeLock } from './thin-lock.js';

export function createHubObserver({ home, relay, now = () => new Date() }) {
  let active = false;
  return async ({ signal, deadline } = {}) => {
    const before = (await retryHomeLock(() => readHomeState(home))).transport, at = now().getTime();
    if (active || before.hub_revoked || at < (before.hub_state_retry_at ?? 0) ||
      (!before.hub_state_refresh && at < (before.hub_state_checked_at ?? -Infinity) + 300000)) return;
    active = true;
    const mutate = change => retryHomeLock(() => updateHomeState(home, change));
    try {
      const body = await relay.getHubState({ attempts: 1, quiet: true, signal, deadline });
      if (!body || !['unpaid', 'active', 'suspended'].includes(body.state)) throw { code: 'invalid_response' };
      const metadata = { state: body.state, reason: typeof body.reason === 'string' && /^[a-z_]{1,32}$/.test(body.reason) ? body.reason : null,
        expires_at: isTimestamp(body.expires_at) ? body.expires_at : null, deleting_at: isTimestamp(body.deleting_at) ? body.deleting_at : null, at: now().toISOString() };
      await mutate(s => {
        if ((s.transport.hub_state_revision ?? 0) !== (before.hub_state_revision ?? 0)) return;
        Object.assign(s.transport, { hub_state: metadata, hub_state_refresh: false, hub_state_checked_at: at, hub_state_retry_at: 0 });
        delete s.transport.hub_state_error;
      });
    } catch (err) {
      if (signal?.aborted) return;
      await mutate(s => {
        s.transport.hub_state_error = ['invalid_token', 'invalid_response', 'timeout', 'rate_limited'].includes(err.code) ? err.code : 'relay_error';
        s.transport.hub_state_retry_at = at + Math.max(300000, Number.isFinite(err.retryAfterS) ? err.retryAfterS * 1000 : 0);
        if (err.code === 'invalid_token') s.transport.hub_revoked = true;
      });
    } finally { active = false; }
  };
}
