#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export async function createFixtureRuntime({ home, agentBin, clockStepMs, ...options }) {
  let offset = 0;
  if (clockStepMs !== undefined) {
    if (!Number.isSafeInteger(clockStepMs) || clockStepMs < 0) throw Error('invalid fixture clock step');
    options.now = () => new Date(Date.now() + offset);
    options.sleep = async ms => { await delay(Math.min(ms, 1000)); offset += clockStepMs; };
  }
  const bin = resolve(agentBin);
  const modules = bin.endsWith('.js')
    ? { 'runtime.js': await import(pathToFileURL(join(dirname(bin), '../src/runtime.js'))),
      'thin-poller.js': await import(pathToFileURL(join(dirname(bin), '../src/thin-poller.js'))) }
    : (await import(pathToFileURL(bin.endsWith('.mjs') ? bin : join(dirname(bin), 'syncky-agent.mjs')))).modules;
  const runtime = modules['runtime.js'].createRuntime({ ...options, home, flags: { 'poll-interval': '300' },
    createPoller: settings => modules['thin-poller.js'].createThinPoller({ ...settings, schedulePoll: at => at + 1000,
      relay: { ...settings.relay, async getMessages(query, context) {
        const requested = join(home, '.e2e-receive-pause'), paused = join(home, '.e2e-receive-paused');
        try {
          while (existsSync(requested)) {
            let nonce;
            try { nonce = readFileSync(requested); }
            catch (error) { if (error.code === 'ENOENT') break; throw error; }
            writeFileSync(paused, nonce, { mode: 0o600 });
            await delay(25, undefined, { signal: context?.signal });
          }
        } finally { rmSync(paused, { force: true }); }
        return settings.relay.getMessages(query, context);
      } } }) });
  if (new URL(runtime.config.relay_url).hostname !== '127.0.0.1') throw Error('receiver fixture requires loopback relay');
  return runtime;
}

async function main() {
  process.umask(0o077);
  const { values } = parseArgs({ options: { home: { type: 'string' }, 'agent-bin': { type: 'string' }, once: { type: 'boolean' }, 'clock-step-ms': { type: 'string' } } });
  const runtime = await createFixtureRuntime({ home: values.home, agentBin: values['agent-bin'], clockStepMs: values['clock-step-ms'] === undefined ? undefined : Number(values['clock-step-ms']) });
  if (values.once) { await runtime.poller.once(); return; }
  const receiver = runtime.poller.start();
  const stop = () => { receiver.stop(); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  process.stderr.write(JSON.stringify({ event: 'receive_ready', hub_id: runtime.status().hub_id }) + '\n');
  try { process.exitCode = (await receiver.done).reason === 'invalid_token' ? 3 : 0; }
  finally { process.off('SIGTERM', stop); process.off('SIGINT', stop); }
}

export async function runFixture() {
  try { await main(); } catch (error) { process.stderr.write(JSON.stringify({ event: 'receiver_fixture_failed', code: error.code ?? error.name }) + '\n'); process.exitCode = 1; }
}

if (process.argv[1] && existsSync(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  await runFixture();
}
