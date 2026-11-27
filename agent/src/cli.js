import fs from 'node:fs';
import { spawn as nodeSpawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentErrorCode, errorHint } from './error-guidance.js';
import { LocalStateError, POLL_INTERVAL_MIN_S, agentHome, errorDetail, resolveConfig } from './config.js';
import { LEVELS, createLogger } from './log.js';
import { createRuntime, readSkill, validateSend, AGENT_VERSION, INBOX_MAX_LIMIT } from './runtime.js';
import { createSkillUpdater } from './skill-update.js';
import { registerAgent } from './register.js';
import { createPairingService, readPairingFile } from './pairing.js';
import { pairOutput } from './pair-output.js';
import { readHomeState } from './home-state.js';
import { loadSecrets } from './secrets.js';
import { runMcp } from './mcp.js';
import { runSelftest } from './selftest.js';
import { protocolDir } from './protocol-files.js';
import { RelayError } from './relay-client.js';
import { isMemberId, isPairingId } from './ids.js';
import { isPairUriName } from './pair-uri.js';
import { abortableSleep } from './transport-time.js';
import { retryHomeLock, retryReceiverLock } from './thin-lock.js';
import { openPrivateAppend, receiverLockHeld } from './protected-files.js';
import { pairingAccessView, PAIRING_REPLY_MS } from './pairing-access.js';
import { commands, globalFlags } from './cli-commands.js';
export { commandNames } from './cli-commands.js';

export const EXIT = Object.freeze({ ok: 0, usage: 1, relay: 2, invalidToken: 3, local: 4 });
export class UsageError extends Error { constructor(message) { super(message); this.name = 'UsageError'; this.code = 'invalid_arguments'; } }
const internalCommands = { 'pair-waiter': { max: 1 } };
const PAIR_WAITER_GRACE_MS = 60000;
const PAIR_WAITER_COLLECTION_MS = 30 * 60_000;
const CLI_ENTRY = fileURLToPath(typeof __SYNCKY_AGENT_BUNDLE__ === 'undefined'
  ? new URL('../bin/syncky-agent.js', import.meta.url) : import.meta.url);
export function generalHelp() { return `usage: syncky-agent <command> [options]\n\n${Object.values(commands).map(c => '  ' + c.usage).join('\n')}\n\nGlobal: --home <dir> --relay <url> --url-scheme <scheme> --log-level <level> --help\n--url-scheme selects the HTTPS pairing site: syncky uses syncky.app, syncky-<label> uses <label>.syncky.app; on a syncky.app relay the label must match relay-<label>, otherwise invalid_url_scheme. The app accepts a labelled site only with its matching relay; for other relays use syncky or leave it unset.\nJSON output: --json (send instead requires --json <file|-> as input).\nExit: 0 success, 1 usage, 2 relay, 3 invalid_token, 4 local state.\n`; }
export function commandHelp(command) { return `usage: syncky-agent ${commands[command]?.usage ?? '<command>'}\n${commands[command]?.details ? '\n' + commands[command].details + '\n' : ''}`; }
export function parseArgs(argv) {
  const command = argv.find((arg, i) => !arg.startsWith('-') && (i === 0 || !['--home','--relay','--url-scheme','--log-level'].includes(argv[i - 1])));
  const spec = commands[command], types = { ...globalFlags, ...spec?.flags, json: command === 'send' ? 'string' : 'boolean' };
  const flags = {}, positionals = []; let found = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') { positionals.push(...argv.slice(i + 1)); break; }
    if (arg === '-h') { flags.help = true; continue; }
    if (arg.startsWith('--')) {
      const [name, ...tail] = arg.slice(2).split('='), type = types[name];
      if (!type) throw new UsageError('unknown option');
      if (type === 'boolean') { if (tail.length) throw new UsageError('boolean option takes no value'); flags[name] = true; }
      else { const value = tail.length ? tail.join('=') : argv[++i]; if (value === undefined || value.startsWith('--')) throw new UsageError('option needs a value'); flags[name] = value; }
    } else if (!found && arg === command) found = true;
    else if (arg.startsWith('-') && arg !== '-') throw new UsageError('unknown option');
    else positionals.push(arg);
  }
  return { command: command ?? null, flags, positionals };
}
const integer = (value, min, max) => {
  if (typeof value !== 'string' || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) throw new UsageError('invalid integer option');
  return Number(value);
};
function inboxArgs(flags) {
  if (flags.member !== undefined && !isMemberId(flags.member)) throw new UsageError('invalid member');
  for (const date of [flags.since, flags.until]) if (date !== undefined && (!/^\d{4}-\d\d-\d\d(?:T.*Z)?$/.test(date) || !Number.isFinite(Date.parse(date)))) throw new UsageError('invalid inbox date');
  if (flags.since && flags.until && Date.parse(flags.since) > Date.parse(flags.until)) throw new UsageError('inbox dates are reversed');
  return { member: flags.member, type: flags.type, after_seq: flags['after-seq'] === undefined ? -1 : integer(flags['after-seq'], 0, Number.MAX_SAFE_INTEGER), since: flags.since, until: flags.until,
    limit: flags.limit === undefined ? 100 : integer(flags.limit, 1, INBOX_MAX_LIMIT) };
}
async function inputText(path, input) {
  let bytes;
  if (path === '-') {
    const chunks = []; let size = 0;
    for await (const chunk of input) { const b = Buffer.from(chunk); size += b.length; if (size > 262144) throw new LocalStateError('invalid_input','JSON input exceeds limit'); chunks.push(b); }
    bytes = Buffer.concat(chunks);
  } else {
    if (fs.statSync(path).size > 262144) throw new LocalStateError('invalid_input','JSON input exceeds limit');
    bytes = fs.readFileSync(path);
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new LocalStateError('invalid_input','JSON input must be UTF-8'); }
}
const confirmationReceipt = (runtime, id) => runtime.outbox.receipts().find(e => e.type === 'confirmed' && e.to?.includes(id));
async function waitPair(runtime, pairing, started, { timeout = 900, signal, sleep, now, deadline = now().getTime() + timeout * 1000, deadlineOf, isCurrent, retryRelayErrors = false, collectionOptions }) {
  let outcome, completedResult, failures = 0;
  const until = () => deadlineOf?.() ?? deadline;
  let end = deadline, wakePending = false, hinted = false, sleeping, collection, socketEnd;
  const connection = runtime.pairingSocket?.({ signal,
    canConnect(retrying) {
      if (now().getTime() >= end || receiverLockHeld(runtime.home)) return false;
      if (collection) return now().getTime() < collection.joinUntil;
      if (!retrying) return true;
      try { return isCurrent ? isCurrent() : pairing.currentPairing({ includeCompleted: true, includeExpired: true })?.pairing_id === started.pairing_id; }
      catch { return false; }
    },
    onWake(event, reason) {
      wakePending = true;
      hinted = event !== 'failure';
      socketEnd = reason;
      if (reason) collection?.finish(reason);
      sleeping?.abort();
    },
  });
  const hints = { pending: () => hinted && connection.healthy, consume: () => { hinted = false; },
    hasWindow: () => connection.firstSync || Boolean(collection && now().getTime() < collection.joinUntil) };
  const onRetryAfter = at => connection?.deferRetriesUntil(at);
  async function pause(ms, interruptible, waitSignal = signal) {
    if (!interruptible || !connection) return abortableSleep(ms, sleep, waitSignal);
    if (wakePending) return;
    const wake = new AbortController();
    sleeping = wake;
    try { await abortableSleep(ms, sleep, waitSignal ? AbortSignal.any([waitSignal, wake.signal]) : wake.signal); }
    catch (error) { if (!wake.signal.aborted || waitSignal?.aborted) throw error; }
    finally { sleeping = undefined; }
  }
  async function collect(member, joinUntil) {
    const { begin, timers } = collectionOptions;
    const at = now().getTime();
    end = (Date.parse(member.confirmed_at) || at) + PAIR_WAITER_COLLECTION_MS;
    const controller = new AbortController(), collectSignal = AbortSignal.any([signal, controller.signal]);
    let reason;
    collection = { joinUntil, finish(why) { reason ??= why; controller.abort(); } };
    begin();
    const timer = timers.setTimeout(() => collection.finish('window_cap'), Math.max(0, end - at));
    let pollAt = 0, blockedUntil = 0;
    try {
      while (!collectSignal.aborted) {
        const at = now().getTime();
        if (receiverLockHeld(runtime.home)) return 'receiver';
        if (at >= end) return 'window_cap';
        if (!connection.firstSync && at >= joinUntil) return 'join_window_ended';
        if (connection.healthy && at >= blockedUntil && (hinted || at >= pollAt)) {
          wakePending = false;
          try {
            const result = await runtime.poller.once({ signal: collectSignal, deadline: end, operator: false, hints, yieldToReceiver: true });
            pollAt = result?.capped ? at : result?.next_poll_at ?? Infinity;
            blockedUntil = ['cadence', 'poll_floor'].includes(result?.reason) ? 0 : result?.next_poll_at ?? 0;
            if (result?.reason === 'retry_after') onRetryAfter(blockedUntil);
          } catch (error) {
            if (collectSignal.aborted) break;
            if (error.code === 'invalid_token') return 'invalid_token';
            const delay = Number.isFinite(error.retryAfterS) ? Math.max(1000, error.retryAfterS * 1000) : 1000;
            pollAt = blockedUntil = now().getTime() + delay;
            if (Number.isFinite(error.retryAfterS)) onRetryAfter(blockedUntil);
          }
          continue;
        }
        wakePending = false;
        await pause(Math.min(1000, end - at), true, collectSignal);
      }
    } catch (error) {
      if (!collectSignal.aborted) throw error;
    } finally {
      timers.clearTimeout(timer);
    }
    return reason ?? 'stopped';
  }
  function confirmation() {
    const state = readHomeState(runtime.home), member = state.members[outcome.member.member_id], row = state.pairings[started.pairing_id];
    if (member?.role !== 'device' || member.pairing_id !== started.pairing_id || row?.status !== 'completed' || row.member_id !== member.member_id
      || (row.public_key !== undefined && row.public_key !== member.public_key) || member.unpair_reason != null
      || [true, '1'].includes(state.transport.hub_revoked) || [true, '1'].includes(state.transport.hub_deleted)) throw new LocalStateError('invalid_transition','phone binding is no longer current');
    if (member?.state === 'confirmed') return { ...outcome, member: { ...outcome.member, state: 'confirmed' } };
    if (member?.proof_invalidated) throw new LocalStateError('pair_proof_invalid','compare the fingerprint with the phone before confirming');
    if (member?.state !== 'joined') throw new LocalStateError('invalid_transition','phone is no longer joined');
  }
  const withAccess = (confirmed, row, ended = false) => row?.requested_scope
    ? { ...confirmed, member: { ...confirmed.member, pairing_access: pairingAccessView(row, { ended }) } } : confirmed;
  try {
    while (now().getTime() < (end = until())) {
      signal?.throwIfAborted();
      if (isCurrent && !await retryHomeLock(isCurrent)) return;
      connection?.start();
      wakePending = false;
      let delayMs = 2000, interruptible = true;
      try {
        if (!outcome) {
          const result = await pairing.refreshPairing(started.pairing_id, { signal, deadline: until(), onRetryAfter });
          if (result.status === 'expired') throw new LocalStateError('pairing_expired','pairing expired');
          if (result.status === 'completed') outcome = result;
        }
        if (outcome) {
          if (isCurrent && !await retryHomeLock(isCurrent)) return;
          let row = readHomeState(runtime.home).pairings[started.pairing_id];
          const confirmed = confirmation();
          if (!confirmed && (started.version === 1 || (!retryRelayErrors && Date.parse(started.expires_at) <= now().getTime()))) return outcome;
          if (!confirmed || row?.access?.state === 'awaiting') {
            const cycle = await runtime.poller.once({ signal, deadline: until(), operator: false, ...(connection && { hints }) });
            if (cycle?.reason === 'retry_after') connection?.deferRetriesUntil(cycle.next_poll_at);
          }
          if (confirmation()) {
            await runtime.inbound.releaseHeld({ signal, deadline: until() });
            await runtime.outbox.flush({ signal });
            const completed = confirmation();
            if (!completed) throw new LocalStateError('invalid_transition', 'phone is no longer confirmed');
            row = readHomeState(runtime.home).pairings[started.pairing_id];
            const result = withAccess(completed, row);
            completedResult = result;
            if (!retryRelayErrors && row?.access?.state !== 'awaiting') return result;
            const receipt = confirmationReceipt(runtime, outcome.member.member_id);
            if (receipt?.state === 'sent' && collectionOptions) {
              const state = await retryHomeLock(() => readHomeState(runtime.home));
              const member = state.members[outcome.member.member_id];
              const joinUntil = member?.join_grace_until ?? 0;
              if (member && connection?.healthy && (connection.firstSync || joinUntil > now().getTime())) {
                return { collectionReason: await collect(member, joinUntil) };
              }
              if (socketEnd && row?.access?.state !== 'awaiting') return { collectionReason: socketEnd };
            }
            if (receipt?.state === 'sent' && row?.access?.state !== 'awaiting') return result;
            if (receipt?.state === 'failed') throw new LocalStateError('invalid_transition', 'pairing confirmation delivery failed');
            const receiptDue = typeof receipt?.next_attempt_at === 'string' ? Date.parse(receipt.next_attempt_at) : receipt?.next_attempt_at ?? 0;
            if (receiptDue > now().getTime()) {
              delayMs = Math.max(delayMs, receiptDue - now().getTime());
              interruptible = false;
            }
            if (receipt?.state === 'sent' && row?.access?.state === 'awaiting') {
              const transport = readHomeState(runtime.home).transport;
              delayMs = Math.max(delayMs, Math.min(30000, Math.max(transport.next_poll_at ?? 0, transport.poll_retry_at ?? 0) - now().getTime()));
            }
          }
        }
        failures = 0;
      } catch (err) {
        if (!signal?.aborted && now().getTime() >= until()) break;
        const recoverable = err.status === 0 || err.status === 429 || err.status >= 500 || err.name === 'AbortError' || ['network_error', 'timeout'].includes(err.code);
        if (signal?.aborted || (err.code !== 'home_locked' && err.status !== 429 && !(retryRelayErrors && recoverable))) throw err;
        interruptible = false;
        if (retryRelayErrors && recoverable) delayMs = Math.min(30000, 1000 * 2 ** Math.min(++failures, 5));
        if ((err.status === 429 || (retryRelayErrors && recoverable)) && Number.isFinite(err.retryAfterS) && err.retryAfterS >= 0) {
          delayMs = Math.max(1000, err.retryAfterS * 1000);
          connection?.deferRetriesUntil(now().getTime() + delayMs);
        }
      }
      if (interruptible && connection?.healthy) delayMs = 30000;
      await pause(Math.min(delayMs, Math.max(0, (end = until()) - now().getTime())), interruptible);
    }
    if (outcome && ((!retryRelayErrors && completedResult) || confirmationReceipt(runtime, outcome.member.member_id)?.state === 'sent') && confirmation()) {
      await retryHomeLock(() => pairing.currentPairing({ includeCompleted: true, includeExpired: true }));
      return withAccess(confirmation(), readHomeState(runtime.home).pairings[started.pairing_id], true);
    }
    throw new LocalStateError('timeout','pairing wait timed out; receive can continue automatic code-proof confirmation');
  } finally { connection?.stop(); }
}
function spawnPairWaiter(home, id, { spawn, env, logger, flags }) {
  if (receiverLockHeld(home)) return;
  let fd;
  try {
    fd = openPrivateAppend(join(home, 'pair-waiter.log'), { maxBytes: 256 * 1024 });
    const overrides = ['relay', 'url-scheme'].flatMap(key => flags[key] === undefined ? [] : [`--${key}`, flags[key]]);
    const child = spawn(process.execPath, [CLI_ENTRY, '--home', resolve(home), ...overrides, 'pair-waiter', id], {
      detached: true, stdio: ['ignore', 'ignore', fd], windowsHide: true, env,
    });
    child.once('error', () => logger.warn('pair_waiter_spawn_failed'));
    child.unref();
  } catch { logger.warn('pair_waiter_spawn_failed'); }
  finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch { logger.warn('pair_waiter_spawn_failed'); } } }
}
function pairingErrorHint(error, { command, home, id }) {
  const forget = command === 'forget' && error instanceof LocalStateError && error.code === 'invalid_transition';
  const reject = command === 'reject' && error instanceof RelayError;
  if (!forget && !reject) return;
  try {
    const member = readHomeState(home).members[id];
    if (member?.role !== 'device') return;
    if (forget && ['joined', 'confirmed'].includes(member.state)) return 'Run syncky revoke <member_id> to remove the phone on the relay first, then retry forget.';
    if (reject && member.state === 'rejected') return 'The phone is already rejected locally. Run syncky revoke <member_id> after the relay is reachable or the token is fixed to finish relay revocation. After invalid_token, stop and tell the owner.';
  } catch {}
}
export async function main(argv, { env = process.env, stdout = process.stdout, stderr = process.stderr, stdin = process.stdin, fetch = globalThis.fetch, WebSocket, now = () => new Date(), sleep, random, signal, spawn = nodeSpawn, createPoller, timers = globalThis } = {}) {
  const print = text => stdout.write(text), json = value => print(JSON.stringify(value) + '\n');
  let parsed, hint;
  try {
    parsed = parseArgs(argv);
    const { command, flags, positionals } = parsed;
    if ((!command && flags.help) || command === 'help') { const topic = positionals[0]; if (topic && !commands[topic]) throw new UsageError('unknown command'); print(topic ? commandHelp(topic) : generalHelp()); return 0; }
    const spec = Object.hasOwn(commands, command ?? '') ? commands[command] : Object.hasOwn(internalCommands, command ?? '') ? internalCommands[command] : undefined;
    if (!spec) throw new UsageError('unknown command');
    if (positionals.length > (spec.max ?? 0)) throw new UsageError('unexpected argument');
    if (flags.help) { print(commandHelp(command)); return 0; }
    const level = flags['log-level'] ?? env.SYNCKY_LOG_LEVEL ?? 'info';
    if (!Object.hasOwn(LEVELS, level)) throw new UsageError('unknown log level');
    const logger = createLogger({ level, sink: line => stderr.write(line + '\n'), name: 'syncky-agent' });
    const home = agentHome({ flags, env });
    if (command === 'pair-waiter') {
      if (!isPairingId(positionals[0])) throw new UsageError('pairing id required');
      if (receiverLockHeld(home)) return 0;
      readPairingFile(home);
    }
    if (command === 'init') {
      const config = resolveConfig({ env, flags: { relay_url: flags.relay, url_scheme: flags['url-scheme'], name: flags.name } });
      if (!isPairUriName(config.name)) throw new UsageError('init requires a name that fits the pairing URI');
      json({ ...await registerAgent({ home, relayUrl: config.relay_url, name: config.name, invite: flags.invite ?? (env.SYNCKY_INVITE || undefined), urlScheme: config.url_scheme, fetch, now, sleep, random, logger, timers }), home }); return 0;
    }
    if (command === 'skill') {
      const result = await readSkill(createSkillUpdater({ home }), { diff: flags.diff });
      if (flags.json) json(result); else print((flags.diff ? result.diff : result.skill) + '\n'); return 0;
    }
    if (command === 'selftest') { const result = await runSelftest({ dir: protocolDir(env) }); json(result); return result.ok ? 0 : 4; }
    const makeRuntime = () => createRuntime({ home, flags, env, fetch, WebSocket, now, sleep, random, logger, outboxMaxAttempts: command === 'pair-waiter' ? Infinity : undefined, createPoller, timers, onRecord: command === 'receive' && flags['emit-records'] ? json : undefined });
    if (command === 'mcp') {
      await runMcp({ input: stdin, write: print, version: AGENT_VERSION, logger, handlers: {
        syncky_status: () => { const current = makeRuntime(); return retryHomeLock(() => current.status()); },
        syncky_inbox: args => { const current = makeRuntime(); return retryHomeLock(() => current.inbox(args)); },
        syncky_send: ({ validate, ...args }) => validate ? validateSend(home, args)
          : makeRuntime().send({ ...args, validate: ['access_request', 'scope_release'].includes(args.type) }),
        syncky_ack: args => makeRuntime().poller.ack(args.up_to_seq), syncky_skill: args => readSkill(createSkillUpdater({ home }), args),
      } }); return 0;
    }
    if (command === 'send') {
      if (!flags.type || !flags.json || (flags.to !== undefined && !isMemberId(flags.to))) throw new UsageError('send requires type and JSON input path');
      const args = { type: flags.type, innerText: await inputText(flags.json, stdin), to: flags.to };
      if (flags.validate) {
        json(await validateSend(home, args));
        stderr.write('validated only; nothing sent\n');
      } else json(await makeRuntime().send({ ...args, validate: args.type === 'access_request' }));
      return 0;
    }
    const runtime = makeRuntime();
    if (command === 'status') { json(await retryHomeLock(() => runtime.status())); return 0; }
    if (command === 'inbox') { json(await retryHomeLock(() => runtime.inbox(inboxArgs(flags)))); return 0; }
    if (command === 'ack') { json(await runtime.poller.ack(integer(flags['up-to-seq'], 0, Number.MAX_SAFE_INTEGER))); return 0; }
    if (command === 'receive') {
      if (flags.once) {
        const result = await runtime.poller.once({ signal });
        logger.info('receive_cycle', { ...result, limits: { poll_floor_s: POLL_INTERVAL_MIN_S } });
        return 0;
      }
      const receiver = await retryReceiverLock(() => runtime.poller.start(), { signal, sleep });
      const stop = () => { receiver.stop(); };
      process.once('SIGINT', stop); process.once('SIGTERM', stop); signal?.addEventListener('abort', stop, { once: true });
      logger.info('receive_ready', { hub_id: (await retryHomeLock(() => readHomeState(home))).identity.hub_id, member_id: runtime.self.memberId });
      try { const result = await receiver.done; return result.reason === 'invalid_token' ? 3 : 0; }
      finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); signal?.removeEventListener('abort', stop); }
    }
    const pairing = createPairingService({ home, relay: runtime.relay, publicKey: loadSecrets(home).public_key, agentName: runtime.config.name, urlScheme: runtime.config.url_scheme, now });
    if (command === 'pair-waiter') {
      const current = () => pairing.currentPairing({ includeCompleted: true, graceMs: PAIR_WAITER_GRACE_MS });
      const started = await retryHomeLock(current);
      if (!started || started.pairing_id !== positionals[0] || started.version !== 2) return 0;
      const isCurrent = () => {
        if (receiverLockHeld(home)) return false;
        if (current()?.pairing_id !== started.pairing_id) return false;
        const state = readHomeState(home), member = state.members[state.pairings[started.pairing_id]?.member_id];
        if (member?.state === 'confirmed') {
          const receipt = confirmationReceipt(runtime, member.member_id);
          return Boolean(state.pairings[started.pairing_id]?.access?.state === 'awaiting' || member.confirmation || (receipt && receipt.state !== 'sent'));
        }
        return !member || (member.state === 'joined' && !member.proof_invalidated);
      };
      const deadline = Date.parse(started.expires_at) + PAIR_WAITER_GRACE_MS, controller = new AbortController();
      const scoped = Boolean(readHomeState(home).pairings[started.pairing_id]?.requested_scope);
      const deadlineOf = () => {
        const access = readHomeState(home).pairings[started.pairing_id]?.access;
        return access?.state === 'awaiting' && access.joined_at ? Date.parse(access.deadline_at) : deadline;
      };
      const waiterSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      const timer = timers.setTimeout(() => controller.abort(), Math.max(0, deadline + (scoped ? PAIRING_REPLY_MS * 2 : 0) - now().getTime()));
      logger.info('pair_waiter_started', { pid: process.pid });
      try {
        const result = await waitPair(runtime, pairing, started, {
          now, sleep, signal: waiterSignal, deadline, ...(scoped && { deadlineOf }), isCurrent, retryRelayErrors: true,
          collectionOptions: { timers, begin() { timers.clearTimeout(timer); logger.info('pair_waiter_collecting'); } },
        });
        logger.info('pair_waiter_finished', { reason: result?.collectionReason ?? 'pairing_finished' });
      } catch { logger.info('pair_waiter_stopped'); }
      finally {
        timers.clearTimeout(timer);
        await retryHomeLock(() => pairing.currentPairing({ includeCompleted: true }));
      }
      return 0;
    }
    if (['confirm','reject','revoke','forget'].includes(command)) {
      const [id, ...fingerprint] = positionals;
      if (!isMemberId(id)) throw new UsageError('phone member id required');
      if (command === 'confirm') {
        if (!fingerprint.length) throw new UsageError('fingerprint required');
        const result = await retryHomeLock(() => pairing.confirmWithFingerprint(id, fingerprint.join(' ')));
        await runtime.inbound.releaseHeld(); await runtime.outbox.flush();
        const receipt = await retryHomeLock(() => {
          const request = readHomeState(home).pairings[result.member.pairing_id]?.v1_request;
          return request && runtime.outbox.receipts().find(entry => entry.msg_id === request.msg_id);
        });
        json({ ...result, ...(receipt && { access_request: receipt }) });
      }
      try {
        if (command === 'reject') json(await pairing.rejectMember(id));
        if (command === 'revoke') json(await pairing.revokeMember(id));
        if (command === 'forget') json(await retryHomeLock(() => pairing.forgetMember(id, { yes: flags.yes === true })));
      } catch (error) { hint = pairingErrorHint(error, { command, home, id }); throw error; }
      return 0;
    }
    if (flags['show-qr'] && (flags.v1 || flags.read !== undefined || flags.write !== undefined)) throw new UsageError('--show-qr cannot change pairing version or scope');
    const images = { qrPng: flags['qr-png'], qrSvg: flags['qr-svg'] };
    const started = command === 'pair' ? flags['show-qr'] ? await retryHomeLock(() => pairing.showPairing(images)) : await pairing.startPairing({ ...images, v1: flags.v1,
      ...(flags.read !== undefined && { read: flags.read.split(',') }), ...(flags.write !== undefined && { write: flags.write.split(',') }) }) : await retryHomeLock(() => pairing.currentPairing({ includeCompleted: true }));
    if (!started) throw new LocalStateError('pairing_expired','no pending pairing');
    if (command === 'pair') print(pairOutput(started, { json: flags.json, noQr: flags['no-qr'] }));
    if (command === 'pair' && !flags.wait) {
      if (!flags['show-qr'] && started.version === 2) spawnPairWaiter(home, started.pairing_id, { spawn, env, logger, flags });
      return 0;
    }
    try { json(await waitPair(runtime, pairing, started, { timeout: flags.timeout === undefined ? 900 : integer(flags.timeout, 1, 86400), now, sleep, signal })); }
    finally { await retryHomeLock(() => pairing.currentPairing({ includeCompleted: true, includeExpired: true })); }
    return 0;
  } catch (error) {
    const usage = error instanceof UsageError, relay = error instanceof RelayError;
    const code = usage ? 'invalid_arguments' : typeof error.code === 'string' && /^[a-z_]{1,64}$/.test(error.code) ? agentErrorCode(error.code) : 'local_error';
    const details = errorDetail(error);
    stderr.write(JSON.stringify({ error: code, ...details, hint: hint ?? errorHint(code, details.detail), ...(usage && parsed?.command && commands[parsed.command] ? { usage: commandHelp(parsed.command).trim() } : {}) }) + '\n');
    return usage ? 1 : relay ? error.code === 'invalid_token' ? 3 : 2 : 4;
  }
}
