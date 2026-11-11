import { maintainResponseWaits } from "./response-waits.js";
import { LocalStateError, loadConfig } from './config.js';
import { loadSecrets } from './secrets.js';
import { readHomeState, detectLegacyFiles, cipherEntries } from './home-state.js';
import { createInbox } from './inbox.js';
import { createThinTransport } from './thin-transport.js';
import { createThinInbound } from './thin-inbound.js';
import { createThinPoller } from './thin-poller.js';
import { createGenericSender } from './send.js';
import { createPairingService } from "./pairing.js";
import { createOutbox, sendReceipt } from './outbox.js';
import { createSkillUpdater } from './skill-update.js';
import { createRelayClient } from './relay-client.js';
import { createHubObserver } from './hub-state.js';
import { retryHomeLock, retryHomeLockSync } from './thin-lock.js';
import metadata from '../package.json' with { type: 'json' };
import { maintainPairingAccess, pairingAccessView } from './pairing-access.js';
import { scopeReleaseView } from './scope-release.js';

export const AGENT_VERSION = metadata.version;
export const INBOX_MAX_BYTES = 1048576;
export const INBOX_MAX_LIMIT = 1000;

export async function readSkill(updater, { diff = false } = {}) {
  const { document, previous } = await retryHomeLock(() => updater.read());
  const skill = document.skill;
  if (!diff) return { skill_version: document.skill_version, skill };
  const before = previous?.document.skill ?? '';
  const oldLines = before.split('\n'), newLines = skill.split('\n');
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;
  let end = 0;
  while (end < oldLines.length - start && end < newLines.length - start && oldLines.at(-1 - end) === newLines.at(-1 - end)) end++;
  const changed = before === skill ? '' : ['--- previous','+++ current', ...oldLines.slice(start, end ? -end : undefined).map(s => '-' + s), ...newLines.slice(start, end ? -end : undefined).map(s => '+' + s)].join('\n');
  return { skill_version: document.skill_version, previous_version: previous?.document.skill_version ?? null, diff: changed };
}

export function readInbox(home, { member, type, after_seq = -1, since, until, limit = 100 } = {}) {
  const records = createInbox(home).read({ member, type, afterSeq: after_seq, since, until, limit: limit + 1 }, { snapshot: true });
  const page = []; let size = 128;
  for (const record of records.slice(0, limit)) {
    const bytes = Buffer.byteLength(JSON.stringify(record)) + 1;
    if (size + bytes > INBOX_MAX_BYTES) break;
    page.push(record); size += bytes;
  }
  return { records: page, next_after_seq: page.at(-1)?.cursor ?? page.at(-1)?.seq ?? after_seq, has_more: records.length > page.length };
}

export function localStatus(home, updater, at = Date.now()) {
  const state = readHomeState(home), entries = cipherEntries(home, 'outbox'), transport = state.transport;
  maintainPairingAccess(state, at);
  maintainResponseWaits(state, at);
  const sendLanes = { ...transport.send_lanes };
  if (Number(transport.commands_retry_at) > 0) sendLanes.data = Math.max(sendLanes.data ?? 0, Number(transport.commands_retry_at));
  const members = Object.values(state.members).map(m => ({ member_id: m.member_id, role: m.role, name: m.name ?? null,
    state: m.state, fingerprint: m.fingerprint ?? null, confirmation_method: m.confirmation_method ?? null,
    code_check: Boolean(m.pair_proof) || m.proof_invalidated === true, pairing_id: m.pairing_id ?? null, scope: m.scope ?? null, unpair_reason: m.unpair_reason ?? null,
    ...(m.scope_release && { scope_release: scopeReleaseView(m, entries) }),
    ...(state.pairings[m.pairing_id]?.requested_scope && { pairing_access: pairingAccessView(state.pairings[m.pairing_id]) }) }));
  const responseWaits = transport.response_waits === undefined ? {} : { response_waits: Object.values(transport.response_waits).map(w =>
    Object.fromEntries(['kind','member_id','state','opened_at','expires_at','completed_at'].filter(k => w[k] !== undefined).map(k => [k, w[k]]))) };
  return { ...state.identity, members, transport: { ...Object.fromEntries(['cursor','acked_seq','pending_ack','last_poll_at','last_ack_at','next_poll_at','poll_interval_s','poll_retry_at','ack_retry_at','heartbeat_day','hub_revoked','hub_deleted','hub_state','hub_state_error','fast_poll','poll_retry_after_until'].filter(k => transport[k] !== undefined).map(k => [k, transport[k]])), ...responseWaits, send_lanes: sendLanes },
    operator_notice: transport.hub_revoked ? 'Relay identity refused; tell the owner and retain local history.' :
      transport.hub_state?.state === 'unpaid' ? 'Choose a relay plan on the phone before sending data.' :
      transport.hub_state?.state === 'suspended' ? 'Relay data is paused; review the plan and retention deadline on the phone.' : null,
    held: cipherEntries(home, 'held').length,
    outbox: Object.fromEntries(['pending','sent','failed'].map(s => [s, entries.filter(e => e.state === s).length])),
    sends: entries.filter((e, i) => e.state === 'pending' || i >= entries.length - 100).map(sendReceipt),
    pairings: Object.values(state.pairings).filter(p => p.requested_scope).map(p => ({ pairing_id: p.pairing_id, member_id: p.member_id ?? null, ...pairingAccessView(p) })),
    skill: updater.status(), legacy_files: detectLegacyFiles(home) };
}

export function createRuntime({ home, flags = {}, env = process.env, fetch, sleep, random, now = () => new Date(), logger, onRecord, outboxMaxAttempts, createPoller = createThinPoller, timers = globalThis } = {}) {
  const state = retryHomeLockSync(() => readHomeState(home)), secrets = loadSecrets(home);
  if (state.identity.public_key !== secrets.public_key) throw new LocalStateError('key_mismatch', 'home identity and secrets disagree');
  const config = loadConfig(home, { env, flags: { relay_url: flags.relay, url_scheme: flags['url-scheme'], poll_interval_s: flags['poll-interval'] } });
  const updater = createSkillUpdater({ home, fetch, now: () => now().getTime() });
  let active, activeMessages;
  const latest = () => {
    const messages = updater.read().document.messages;
    if (messages !== activeMessages) { active = createThinTransport({ table: JSON.parse(messages) }); activeMessages = messages; }
    return active;
  };
  const transport = new Proxy({}, { get: (_, key) => (...args) => latest()[key](...args) });
  const self = { memberId: state.identity.member_id, privateKey: secrets.privateKeyBytes };
  const relay = createRelayClient({ baseUrl: config.relay_url, token: secrets.token, fetch, sleep, random, now: () => now().getTime(), logger, pollIntervalS: config.poll_interval_s, timers });
  const outbox = createOutbox({ home, relay, now, maxAttempts: outboxMaxAttempts, timers });
  const inbound = createThinInbound({ home, transport, self, relay, now, onRecord });
  const pairing = createPairingService({ home, relay, publicKey: secrets.public_key, agentName: config.name, urlScheme: config.url_scheme, now });
  let checking = false, checkedAt = -Infinity;
  async function watchPairing(context) {
    if (checking || now().getTime() - checkedAt < 2000) return;
    checking = true;
    try {
      const pending = await retryHomeLock(() => pairing.currentPairing({ includeExpired: true }));
      if (!pending) return;
      checkedAt = now().getTime();
      await pairing.refreshPairing(pending.pairing_id, context);
    } finally { checking = false; }
  }
  const poller = createPoller({ home, transport, self, relay, now, intervalS: config.poll_interval_s, sleep, onRecord, watchPairing, timers, observeHubState: createHubObserver({ home, relay, now }),
    heartbeat: config.heartbeat === 'off' ? undefined : async ({ signal }) => {
      const reply = await relay.heartbeat({ version: AGENT_VERSION, platform: ['darwin','linux','win32'].includes(process.platform) ? process.platform : 'other' }, { signal, attempts: 1 });
      await retryHomeLock(() => updater.observeHeartbeat(reply));
    }, outbox: { flush: options => Promise.all([outbox.flush(options), updater.tick(options)]) } });
  return { home, self, relay, config, updater, transport, inbound, outbox, poller,
    status: () => localStatus(home, updater, now().getTime()),
    inbox: args => readInbox(home, args),
    skill: args => readSkill(updater, args),
    async send({ type, inner, innerText = JSON.stringify(inner), to, validate = false }) {
      const schemas = Object.values((await retryHomeLock(() => updater.read())).document.schemas).map(text => JSON.parse(text));
      const receipt = await createGenericSender({ home, transport, self, now, schemas })({ type, innerText, to, validate });
      await outbox.flush();
      return (await retryHomeLock(() => outbox.receipts())).find(e => e.msg_id === receipt.msg_id);
    },
  };
}
