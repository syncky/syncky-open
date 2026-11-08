import fs from 'node:fs';
import { spawn as nodeSpawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { LocalStateError, agentHome, resolveConfig } from './config.js';
import { LEVELS, createLogger } from './log.js';
import { createRuntime, readSkill, AGENT_VERSION, INBOX_MAX_LIMIT } from './runtime.js';
import { createSkillUpdater } from './skill-update.js';
import { registerAgent } from './register.js';
import { createPairingService, readPairingFile, renderTerminalQr } from './pairing.js';
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

export const EXIT = Object.freeze({ ok: 0, usage: 1, relay: 2, invalidToken: 3, local: 4 });
export class UsageError extends Error { constructor(message) { super(message); this.name = 'UsageError'; this.code = 'invalid_arguments'; } }
const globalFlags = { home: 'string', relay: 'string', 'url-scheme': 'string', 'log-level': 'string', help: 'boolean' };
const internalCommands = { 'pair-waiter': { max: 1 } };
const PAIR_WAITER_GRACE_MS = 60000;
const commands = {
  init: { usage: 'init --name <name> [--invite <secret>]', flags: { name: 'string', invite: 'string' } },
  pair: { usage: 'pair [--v1] [--wait] [--timeout <seconds>] [--no-qr]', flags: { v1: 'boolean', wait: 'boolean', timeout: 'string', 'no-qr': 'boolean' } },
  wait: { usage: 'wait [--timeout <seconds>]', flags: { timeout: 'string' } },
  confirm: { usage: 'confirm <member_id> <fingerprint>', max: 8 },
  reject: { usage: 'reject <member_id>', max: 1 },
  revoke: { usage: 'revoke <member_id>', max: 1, details: 'Revoke a known phone on the relay, then stop trusting it locally. History stays until forget.' },
  forget: { usage: 'forget <member_id> [--yes]', max: 1, flags: { yes: 'boolean' } },
  status: { usage: 'status' },
  send: { usage: 'send --type <type> --json <file|-> [--to <member_id>] [--validate]', flags: { type: 'string', to: 'string', validate: 'boolean' } },
  inbox: { usage: 'inbox [--type <type>] [--member <member_id>] [--after-seq <seq>] [--since <date>] [--until <date>] [--limit <n>]', flags: { type: 'string', member: 'string', 'after-seq': 'string', since: 'string', until: 'string', limit: 'string' } },
  receive: { usage: 'receive [--once] [--poll-interval <seconds>]', flags: { once: 'boolean', 'poll-interval': 'string' } },
  ack: { usage: 'ack --up-to-seq <seq>', flags: { 'up-to-seq': 'string' } },
  skill: { usage: 'skill [--diff]', flags: { diff: 'boolean' } },
  mcp: { usage: 'mcp' },
  selftest: { usage: 'selftest' },
  help: { usage: 'help [command]', max: 1 },
};
export const commandNames = () => Object.keys(commands);
export function generalHelp() { return `usage: syncky-agent <command> [options]\n\n${Object.values(commands).map(c => '  ' + c.usage).join('\n')}\n\nGlobal: --home <dir> --relay <url> --url-scheme <scheme> --log-level <level> --help\nJSON output: --json (send instead requires --json <file|-> as input).\nExit: 0 success, 1 usage, 2 relay, 3 invalid_token, 4 local state.\n`; }
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
async function waitPair(runtime, pairing, started, { timeout = 900, signal, sleep, now, deadline = now().getTime() + timeout * 1000, isCurrent, retryRelayErrors = false }) {
  let outcome, failures = 0;
  function confirmation() {
    const member = readHomeState(runtime.home).members[outcome.member.member_id];
    if (member?.state === 'confirmed') return { ...outcome, member: { ...outcome.member, state: 'confirmed' } };
    if (member?.proof_invalidated) throw new LocalStateError('pair_proof_invalid','compare the fingerprint with the phone before confirming');
    if (member?.state !== 'joined') throw new LocalStateError('invalid_transition','phone is no longer joined');
  }
  while (now().getTime() < deadline) {
    signal?.throwIfAborted();
    if (isCurrent && !await isCurrent()) return;
    let delayMs = 2000;
    try {
      if (!outcome) {
        const result = await pairing.refreshPairing(started.pairing_id, { signal, deadline });
        if (result.status === 'expired') throw new LocalStateError('pairing_expired','pairing expired');
        if (result.status === 'completed') outcome = result;
      }
      if (outcome) {
        if (isCurrent && !await isCurrent()) return;
        if (started.version === 1) return outcome;
        const confirmed = confirmation();
        if (!confirmed) await runtime.poller.once({ signal, deadline });
        const completed = confirmed ?? confirmation();
        if (completed) {
          await runtime.inbound.releaseHeld({ signal, deadline });
          await runtime.outbox.flush({ signal });
          if (!retryRelayErrors) return completed;
          const receipt = confirmationReceipt(runtime, outcome.member.member_id);
          if (receipt?.state === 'sent') return completed;
          if (receipt?.state === 'failed') throw new LocalStateError('invalid_transition', 'pairing confirmation delivery failed');
          delayMs = Math.max(delayMs, (typeof receipt?.next_attempt_at === 'string' ? Date.parse(receipt.next_attempt_at) : receipt?.next_attempt_at ?? 0) - now().getTime());
        }
      }
      failures = 0;
    } catch (err) {
      if (!signal?.aborted && now().getTime() >= deadline) throw new LocalStateError('timeout', 'pairing wait timed out');
      const recoverable = err.status === 0 || err.status === 429 || err.status >= 500 || err.name === 'AbortError' || ['network_error', 'timeout'].includes(err.code);
      if (signal?.aborted || (err.code !== 'home_locked' && err.status !== 429 && !(retryRelayErrors && recoverable))) throw err;
      if (retryRelayErrors && recoverable) delayMs = Math.min(30000, 1000 * 2 ** Math.min(++failures, 5));
      if ((err.status === 429 || (retryRelayErrors && recoverable)) && Number.isFinite(err.retryAfterS) && err.retryAfterS >= 0) delayMs = Math.max(1000, err.retryAfterS * 1000);
    }
    await abortableSleep(Math.min(delayMs, Math.max(0, deadline - now().getTime())), sleep, signal);
  }
  throw new LocalStateError('timeout','pairing wait timed out; receive can continue automatic code-proof confirmation');
}
function spawnPairWaiter(home, id, { spawn, env, logger, flags }) {
  if (receiverLockHeld(home)) return;
  let fd;
  try {
    fd = openPrivateAppend(join(home, 'pair-waiter.log'), { maxBytes: 256 * 1024 });
    const overrides = ['relay', 'url-scheme'].flatMap(key => flags[key] === undefined ? [] : [`--${key}`, flags[key]]);
    const child = spawn(process.execPath, [process.argv[1], '--home', resolve(home), ...overrides, 'pair-waiter', id], {
      detached: true, stdio: ['ignore', 'ignore', fd], windowsHide: true, env,
    });
    child.once('error', () => logger.warn('pair_waiter_spawn_failed'));
    child.unref();
  } catch { logger.warn('pair_waiter_spawn_failed'); }
  finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch { logger.warn('pair_waiter_spawn_failed'); } } }
}
export async function main(argv, { env = process.env, stdout = process.stdout, stderr = process.stderr, stdin = process.stdin, fetch = globalThis.fetch, now = () => new Date(), sleep, random, signal, spawn = nodeSpawn, createPoller, timers = globalThis } = {}) {
  const print = text => stdout.write(text), json = value => print(JSON.stringify(value) + '\n');
  let parsed;
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
      json({ ...await registerAgent({ home, relayUrl: config.relay_url, name: config.name, invite: flags.invite ?? (env.SYNCKY_INVITE || undefined), urlScheme: config.url_scheme, fetch, now, sleep, random, logger }), home }); return 0;
    }
    if (command === 'skill') {
      const result = readSkill(createSkillUpdater({ home }), { diff: flags.diff });
      if (flags.json) json(result); else print((flags.diff ? result.diff : result.skill) + '\n'); return 0;
    }
    if (command === 'selftest') { const result = await runSelftest({ dir: protocolDir(env) }); json(result); return result.ok ? 0 : 4; }
    if (command === 'mcp') {
      const runtime = () => createRuntime({ home, flags, env, fetch, now, sleep, random, logger });
      await runMcp({ input: stdin, write: print, version: AGENT_VERSION, logger, handlers: {
        syncky_status: () => retryHomeLock(() => runtime().status()), syncky_inbox: args => retryHomeLock(() => runtime().inbox(args)),
        syncky_send: async args => (await retryHomeLock(runtime)).send({ ...args, validate: args.type === 'access_request' || args.validate === true }),
        syncky_ack: async args => (await retryHomeLock(runtime)).poller.ack(args.up_to_seq), syncky_skill: args => readSkill(createSkillUpdater({ home }), args),
      } }); return 0;
    }
    const runtime = await retryHomeLock(() => createRuntime({ home, flags, env, fetch, now, sleep, random, logger, outboxMaxAttempts: command === 'pair-waiter' ? Infinity : undefined, createPoller, timers, onRecord: command === 'receive' ? json : undefined }));
    if (command === 'status') { json(await retryHomeLock(() => runtime.status())); return 0; }
    if (command === 'inbox') { json(await retryHomeLock(() => runtime.inbox(inboxArgs(flags)))); return 0; }
    if (command === 'send') {
      if (!flags.type || !flags.json || (flags.to !== undefined && !isMemberId(flags.to))) throw new UsageError('send requires type and JSON input path');
      json(await runtime.send({ type: flags.type, innerText: await inputText(flags.json, stdin), to: flags.to, validate: flags.validate })); return 0;
    }
    if (command === 'ack') { json(await runtime.poller.ack(integer(flags['up-to-seq'], 0, Number.MAX_SAFE_INTEGER))); return 0; }
    if (command === 'receive') {
      if (flags.once) { logger.info('receive_cycle', await runtime.poller.once({ signal })); return 0; }
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
      const started = current();
      if (!started || started.pairing_id !== positionals[0] || started.version !== 2) return 0;
      const isCurrent = () => retryHomeLock(() => {
        if (current()?.pairing_id !== started.pairing_id) return false;
        const state = readHomeState(home), member = state.members[state.pairings[started.pairing_id]?.member_id];
        if (member?.state === 'confirmed') {
          const receipt = confirmationReceipt(runtime, member.member_id);
          return Boolean(member.confirmation || (receipt && receipt.state !== 'sent'));
        }
        return !member || (member.state === 'joined' && !member.proof_invalidated);
      });
      const deadline = Date.parse(started.expires_at) + PAIR_WAITER_GRACE_MS, controller = new AbortController();
      const waiterSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      const timer = timers.setTimeout(() => controller.abort(), Math.max(0, deadline - now().getTime()));
      logger.info('pair_waiter_started', { pid: process.pid });
      try {
        await waitPair(runtime, pairing, started, { now, sleep, signal: waiterSignal, deadline, isCurrent, retryRelayErrors: true });
        logger.info('pair_waiter_finished');
      } catch { logger.info('pair_waiter_stopped'); }
      finally { timers.clearTimeout(timer); }
      return 0;
    }
    if (['confirm','reject','revoke','forget'].includes(command)) {
      const [id, ...fingerprint] = positionals;
      if (!isMemberId(id)) throw new UsageError('phone member id required');
      if (command === 'confirm') { if (!fingerprint.length) throw new UsageError('fingerprint required'); const result = await retryHomeLock(() => pairing.confirmWithFingerprint(id, fingerprint.join(' '))); await runtime.inbound.releaseHeld(); await runtime.outbox.flush(); json(result); }
      if (command === 'reject') json(await pairing.rejectMember(id));
      if (command === 'revoke') json(await pairing.revokeMember(id));
      if (command === 'forget') json(await retryHomeLock(() => pairing.forgetMember(id, { yes: flags.yes === true })));
      return 0;
    }
    const started = command === 'pair' ? await pairing.startPairing({ v1: flags.v1 }) : pairing.currentPairing({ includeCompleted: true });
    if (!started) throw new LocalStateError('pairing_expired','no pending pairing');
    if (command === 'pair' && !flags.wait) {
      if (flags.json) json(started);
      else { print(started.uri + '\n'); if (!flags['no-qr']) print(renderTerminalQr(started.uri)); if (started.code) print('Pairing code: ' + started.code + '\n'); }
      if (started.version === 2) spawnPairWaiter(home, started.pairing_id, { spawn, env, logger, flags });
      return 0;
    }
    if (command === 'pair') {
      if (flags.json) json(started);
      else { print(started.uri + '\n'); if (!flags['no-qr']) print(renderTerminalQr(started.uri)); if (started.code) print('Pairing code: ' + started.code + '\n'); }
    }
    json(await waitPair(runtime, pairing, started, { timeout: flags.timeout === undefined ? 900 : integer(flags.timeout, 1, 86400), now, sleep, signal })); return 0;
  } catch (error) {
    const usage = error instanceof UsageError, relay = error instanceof RelayError;
    const code = usage ? 'invalid_arguments' : typeof error.code === 'string' && /^[a-z_]{1,64}$/.test(error.code) ? error.code : 'local_error';
    stderr.write(JSON.stringify({ error: code, ...(usage && parsed?.command && commands[parsed.command] ? { usage: commandHelp(parsed.command).trim() } : {}) }) + '\n');
    return usage ? 1 : relay ? error.code === 'invalid_token' ? 3 : 2 : 4;
  }
}
