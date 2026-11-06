import fs from 'node:fs';
import { LocalStateError, agentHome, resolveConfig } from './config.js';
import { LEVELS, createLogger } from './log.js';
import { createRuntime, readSkill, AGENT_VERSION, INBOX_MAX_LIMIT } from './runtime.js';
import { createSkillUpdater } from './skill-update.js';
import { registerAgent } from './register.js';
import { createPairingService, renderTerminalQr } from './pairing.js';
import { readHomeState } from './home-state.js';
import { loadSecrets } from './secrets.js';
import { runMcp } from './mcp.js';
import { runSelftest } from './selftest.js';
import { protocolDir } from './protocol-files.js';
import { RelayError } from './relay-client.js';
import { isMemberId } from './ids.js';
import { isPairUriName } from './pair-uri.js';
import { abortableSleep } from './transport-time.js';
import { retryHomeLock } from './thin-lock.js';

export const EXIT = Object.freeze({ ok: 0, usage: 1, relay: 2, invalidToken: 3, local: 4 });
export class UsageError extends Error { constructor(message) { super(message); this.name = 'UsageError'; this.code = 'invalid_arguments'; } }
const globalFlags = { home: 'string', relay: 'string', 'url-scheme': 'string', 'log-level': 'string', help: 'boolean' };
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
async function waitPair(runtime, pairing, started, { timeout = 900, signal, sleep, now }) {
  const deadline = now().getTime() + timeout * 1000;
  let outcome;
  function confirmation() {
    const member = readHomeState(runtime.home).members[outcome.member.member_id];
    if (member?.state === 'confirmed') return { ...outcome, member: { ...outcome.member, state: 'confirmed' } };
    if (member?.proof_invalidated) throw new LocalStateError('pair_proof_invalid','compare the fingerprint with the phone before confirming');
    if (member?.state !== 'joined') throw new LocalStateError('invalid_transition','phone is no longer joined');
  }
  while (now().getTime() < deadline) {
    signal?.throwIfAborted();
    let delayMs = 2000;
    try {
      if (!outcome) {
        const result = await pairing.refreshPairing(started.pairing_id, { signal, deadline });
        if (result.status === 'expired') throw new LocalStateError('pairing_expired','pairing expired');
        if (result.status === 'completed') outcome = result;
      }
      if (outcome) {
        if (started.version === 1) return outcome;
        const confirmed = confirmation();
        if (!confirmed) await runtime.poller.once({ signal, deadline });
        const completed = confirmed ?? confirmation();
        if (completed) {
          await runtime.inbound.releaseHeld({ signal, deadline });
          await runtime.outbox.flush({ signal });
          return completed;
        }
      }
    } catch (err) {
      if (!signal?.aborted && now().getTime() >= deadline) throw new LocalStateError('timeout', 'pairing wait timed out');
      if (signal?.aborted || (err.code !== 'home_locked' && err.status !== 429)) throw err;
      if (err.status === 429 && Number.isFinite(err.retryAfterS) && err.retryAfterS >= 0) delayMs = Math.max(1000, err.retryAfterS * 1000);
    }
    await abortableSleep(Math.min(delayMs, Math.max(0, deadline - now().getTime())), sleep, signal);
  }
  throw new LocalStateError('timeout','pairing wait timed out; receive can continue automatic code-proof confirmation');
}
export async function main(argv, { env = process.env, stdout = process.stdout, stderr = process.stderr, stdin = process.stdin, fetch = globalThis.fetch, now = () => new Date(), sleep, random, signal } = {}) {
  const print = text => stdout.write(text), json = value => print(JSON.stringify(value) + '\n');
  let parsed;
  try {
    parsed = parseArgs(argv);
    const { command, flags, positionals } = parsed;
    if ((!command && flags.help) || command === 'help') { const topic = positionals[0]; if (topic && !commands[topic]) throw new UsageError('unknown command'); print(topic ? commandHelp(topic) : generalHelp()); return 0; }
    if (!Object.hasOwn(commands, command ?? '')) throw new UsageError('unknown command');
    if (positionals.length > (commands[command].max ?? 0)) throw new UsageError('unexpected argument');
    if (flags.help) { print(commandHelp(command)); return 0; }
    const level = flags['log-level'] ?? env.SYNCKY_LOG_LEVEL ?? 'info';
    if (!Object.hasOwn(LEVELS, level)) throw new UsageError('unknown log level');
    const logger = createLogger({ level, sink: line => stderr.write(line + '\n'), name: 'syncky-agent' });
    const home = agentHome({ flags, env });
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
        syncky_status: () => retryHomeLock(() => runtime().status()), syncky_inbox: args => retryHomeLock(() => runtime().inbox(args)), syncky_send: args => runtime().send(args),
        syncky_ack: args => runtime().poller.ack(args.up_to_seq), syncky_skill: args => readSkill(createSkillUpdater({ home }), args),
      } }); return 0;
    }
    const runtime = createRuntime({ home, flags, env, fetch, now, sleep, random, logger, onRecord: command === 'receive' ? json : undefined });
    if (command === 'status') { json(await retryHomeLock(() => runtime.status())); return 0; }
    if (command === 'inbox') { json(await retryHomeLock(() => runtime.inbox(inboxArgs(flags)))); return 0; }
    if (command === 'send') {
      if (!flags.type || !flags.json || (flags.to !== undefined && !isMemberId(flags.to))) throw new UsageError('send requires type and JSON input path');
      json(await runtime.send({ type: flags.type, innerText: await inputText(flags.json, stdin), to: flags.to, validate: flags.validate })); return 0;
    }
    if (command === 'ack') { json(await runtime.poller.ack(integer(flags['up-to-seq'], 0, Number.MAX_SAFE_INTEGER))); return 0; }
    if (command === 'receive') {
      if (flags.once) { logger.info('receive_cycle', await runtime.poller.once({ signal })); return 0; }
      const receiver = runtime.poller.start();
      const stop = () => { receiver.stop(); };
      process.once('SIGINT', stop); process.once('SIGTERM', stop); signal?.addEventListener('abort', stop, { once: true });
      logger.info('receive_ready', { hub_id: readHomeState(home).identity.hub_id, member_id: runtime.self.memberId });
      try { const result = await receiver.done; return result.reason === 'invalid_token' ? 3 : 0; }
      finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); signal?.removeEventListener('abort', stop); }
    }
    const pairing = createPairingService({ home, relay: runtime.relay, publicKey: loadSecrets(home).public_key, agentName: runtime.config.name, urlScheme: runtime.config.url_scheme, now });
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
