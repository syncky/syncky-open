import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import fs from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createFakePhone } from './fake-phone.js';
import { waitFor } from './helpers.js';
import { fixture } from './thin-home.js';
import { startRelayDouble } from './relay-double.js';
import { skillExample } from './skill-examples.js';

const agent = fileURLToPath(new URL('../../', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const schemaName = 'inner-future-echo.schema.json';
export const futureEcho = {
  v: 1, type: 'future_echo', request: 'extension-proof',
  nested: { canary: 'FUTURE_ECHO_PRIVATE_CANARY', unknown: [null, false, { unicode: '水💧', revision: 7 }] },
};
export const futureSchema = JSON.stringify({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object', required: ['type', 'request', 'nested'],
  properties: { type: { const: 'future_echo' }, request: { type: 'string' }, nested: { type: 'object' } },
});
const extraSkill = '\n## Future echo\n\nOnly on explicit owner request, send an unmarked control and read its unchanged nested fields from inbox.\n\n```sh\nsyncky-agent send --type future_echo --validate --json - <<\'JSON\'\n' + JSON.stringify(futureEcho) + '\nJSON\nsyncky-agent inbox --type future_echo\n```\n';

export function receiverClock() {
  let at = Date.now(), wake, advancing = false, completed = 0;
  return {
    now: () => new Date(at),
    sleep: ms => new Promise(resolve => {
      const advance = () => { wake = undefined; at += ms; setImmediate(resolve); };
      if (advancing) advance(); else wake = advance;
    }),
    schedulePoll: at => { advancing = false; completed++; return at + 20; },
    async poll() {
      const next = await waitFor(() => wake, { what: 'receiver ready for next poll' }), before = completed;
      advancing = true; next();
      await waitFor(() => completed > before, { what: 'receiver completes next poll' });
    },
  };
}

export async function proveSkillExtension(t) {
  const root = fixture(t), pair = generateKeyPairSync('ed25519');
  const pin = Buffer.from(pair.publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64');
  const implementation = [join(agent, 'build.mjs'), join(agent, 'bin/syncky-agent.js'), join(agent, '../protocol/messages.json'),
    ...fs.readdirSync(join(agent, 'src')).filter(f => f.endsWith('.js')).map(f => join(agent, 'src', f))];
  const snapshot = () => implementation.map(path => digest(fs.readFileSync(path)));
  const before = snapshot();
  for (const path of implementation) assert.ok(!fs.readFileSync(path, 'utf8').includes('future_echo'), 'fixture type is absent from implementation/build');
  const initial = JSON.parse(Buffer.from(JSON.parse(fs.readFileSync(join(agent, 'skills/syncky/bootstrap.json'))).payload, 'base64'));
  assert.ok(!initial.messages.includes('future_echo'));
  assert.ok(!Object.values(initial.schemas).some(s => s.includes('future_echo')));
  const document = { ...initial, skill_version: initial.skill_version + 1, skill: initial.skill + extraSkill,
    schemas: { ...initial.schemas, [schemaName]: futureSchema } };
  assert.deepEqual(Object.keys(document).filter(key => JSON.stringify(initial[key]) !== JSON.stringify(document[key])).sort(), ['schemas', 'skill', 'skill_version']);
  const payload = Buffer.from(JSON.stringify(document));
  const feed = JSON.stringify({ payload: payload.toString('base64'), signature: sign(null, payload, pair.privateKey).toString('base64') });
  const source = join(root, 'source'); fs.mkdirSync(source);
  for (const name of ['src', 'skills', 'package.json']) fs.cpSync(join(agent, name), join(source, name), { recursive: true });
  fs.symlinkSync(join(agent, 'node_modules'), join(source, 'node_modules'), 'dir');
  fs.mkdirSync(join(root, 'protocol'));
  for (const name of ['messages.json', 'types.json']) fs.copyFileSync(join(agent, '../protocol', name), join(root, 'protocol', name));
  const provisionPin = (path, pattern) => {
    const text = fs.readFileSync(path, 'utf8');
    assert.equal([...text.matchAll(pattern)].length, 1, 'exactly one empty package pin');
    fs.writeFileSync(path, text.replace(pattern, match => match.replace(/(['"])\1/, JSON.stringify(pin))));
  };
  provisionPin(join(source, 'src/skill-document.js'), /SKILL_PUBLIC_KEY = ''/g);
  let release;
  if (process.env.SYNCKY_AGENT_BUNDLE_FIXTURE) release = JSON.parse(fs.readFileSync(process.env.SYNCKY_AGENT_BUNDLE_FIXTURE)).release;
  else { const { buildAgent } = await import('../../build.mjs'); release = await buildAgent({ outdir: join(root, 'release') }); }
  const bundle = join(root, 'test-agent.mjs'); fs.copyFileSync(release.bundlePath, bundle);
  provisionPin(bundle, /SKILL_PUBLIC_KEY = ""/g);
  const sourceModules = Object.fromEntries(await Promise.all(['cli.js', 'runtime.js', 'thin-poller.js', 'home-state.js'].map(async name => [name, await import(pathToFileURL(join(source, 'src', name)))])));
  const bundleModules = (await import(pathToFileURL(bundle))).modules;
  const relay = await startRelayDouble();
  try {
    for (const [mode, modules, executable] of [['source', sourceModules, join(source, 'src/cli.js')], ['bundle', bundleModules, bundle]]) {
      await t.test(`${mode}: signed schema/skill-only extension with an explicit receiver`, async () => {
        const executableFiles = mode === 'source' ? fs.readdirSync(join(source, 'src')).map(name => join(source, 'src', name)) : [executable];
        const executableHashes = () => executableFiles.map(path => digest(fs.readFileSync(path)));
        const executableBefore = executableHashes(), home = join(root, mode + '-home'), logs = [];
        let fetches = 0;
        const fetch = async (url, options) => {
          if (url === 'https://dev.syncky.app/agent-skill.json') {
            fetches++; assert.equal(options.redirect, 'error'); assert.equal(options.headers.Authorization, undefined);
            return new Response(feed);
          }
          assert.equal(new URL(url).origin, relay.url);
          return globalThis.fetch(url, options);
        };
        async function cli(args, input = '', privateOutput = false) {
          let stdout = '', stderr = '';
          const code = await modules['cli.js'].main(['--home', home, ...args], { env: {}, fetch, stdin: Readable.from([input]),
            stdout: { write: s => { stdout += s; } }, stderr: { write: s => { stderr += s; } } });
          logs.push(stderr); if (!privateOutput) logs.push(stdout);
          return { code, json: stdout ? JSON.parse(stdout) : null, error: stderr.trim() ? JSON.parse(stderr.trim().split('\n').at(-1)).error : undefined };
        }
        async function ok(args, input, privateOutput) { const r = await cli(args, input, privateOutput); assert.equal(r.code, 0, 'CLI succeeded'); return r.json; }
        const rpc = async (name, args, privateOutput = false) => {
          const reply = await ok(['mcp'], JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) + '\n', privateOutput);
          assert.equal(reply.error, undefined); return reply.result;
        };
        const identity = await ok(['init', '--relay', relay.url, '--name', 'Extension fixture', '--invite', 'test-invite']);
        const pairing = await ok(['pair', '--v1', '--json'], '', true);
        const phone = createFakePhone({ relayUrl: relay.url }); await phone.pair(pairing.uri);
        const clock = receiverClock();
        let receivedCount = 0;
        const runtime = modules['runtime.js'].createRuntime({ home, env: {}, fetch,
          onRecord: () => { receivedCount++; },
          createPoller: options => modules['thin-poller.js'].createThinPoller({ ...options, now: clock.now, sleep: clock.sleep, schedulePoll: clock.schedulePoll }) });
        const receiver = runtime.poller.start();
        try {
          await waitFor(() => modules['home-state.js'].readHomeState(home).members[phone.memberId]
            && runtime.status().members.some(m => m.member_id === phone.memberId), { what: 'explicit receiver observes phone' });
          assert.ok(fs.existsSync(join(home, '.receiver.lock')));
          await ok(['confirm', phone.memberId, phone.fingerprint()]); await phone.fetchCommands();
          const read = async mcp => mcp ? (await rpc('syncky_inbox', { type: 'future_echo' }, true)).structuredContent.records
            : (await ok(['inbox', '--type', 'future_echo'], '', true)).records;
          const send = async (inner, mcp, validate = true) => mcp ? (await rpc('syncky_send', { type: inner.type, inner, to: phone.memberId, validate })).structuredContent
            : (await cli(['send', '--type', inner.type, '--to', phone.memberId, '--json', '-', ...(validate ? ['--validate'] : [])], JSON.stringify(inner)));
          let count = 0;
          async function roundTrip(inner, mcp, validate = true) {
            const sent = await send(inner, mcp, validate), receipt = mcp ? sent : sent.json;
            if (!mcp) assert.equal(sent.code, 0);
            assert.equal(receipt.state, 'sent');
            const envelope = [...relay.state.hub(identity.hub_id).messages.values()].find(row => row.msgId === receipt.msg_id);
            const wire = JSON.parse(envelope.body);
            assert.equal(wire.kind, 'control'); assert.equal(wire.access, undefined); assert.equal(wire.diagnostics, undefined);
            assert.ok(!envelope.body.includes(futureEcho.nested.canary));
            await phone.fetchCommands();
            const received = phone.controlReceived.find(row => row.msg_id === receipt.msg_id);
            assert.ok(received, 'test phone authenticated the unlisted control');
            const { seq, msg_id, ...echo } = received;
            assert.ok(JSON.stringify(echo) === JSON.stringify(inner), 'phone received unchanged unknown fields');
            await phone.sendControl(echo); count++;
            await clock.poll();
            await waitFor(() => receivedCount === count, { what: 'receiver persists echo' });
            let cliRows;
            for (const viaMcp of [false, true]) {
              const rows = await read(viaMcp);
              assert.equal(rows.length, count);
              if (!viaMcp) cliRows = rows;
              const row = rows.at(-1);
              assert.equal(row.from, phone.memberId); assert.equal(row.kind, 'control');
              assert.ok(JSON.stringify(row.inner) === JSON.stringify(inner), 'private inbox preserves nested unknown fields');
            }
            return cliRows;
          }
          const malformed = { ...futureEcho, request: 12 };
          for (const mcp of [false, true]) await roundTrip(futureEcho, mcp);
          const baseline = await roundTrip(malformed, false);
          runtime.updater.observeHeartbeat({ skill_update: { skill_version: document.skill_version, url: 'https://dev.syncky.app/agent-skill.json' } });
          assert.equal((await runtime.updater.tick()).state, 'applied'); assert.equal(fetches, 1);
          assert.equal(runtime.updater.read().document.messages, initial.messages);
          assert.deepEqual(runtime.updater.read().document.schemas, document.schemas);
          assert.ok((await ok(['skill', '--json'], '', true)).skill === document.skill, 'CLI serves the verified skill');
          assert.ok((await ok(['skill', '--diff', '--json'], '', true)).diff.includes('## Future echo'));
          assert.ok((await rpc('syncky_skill', {}, true)).structuredContent.skill === document.skill, 'MCP serves the verified skill');
          const example = skillExample('future_echo', {}, runtime.updater.read().document.skill);
          assert.ok(JSON.stringify(example) === JSON.stringify(futureEcho), 'signed skill provides the executable example');
          for (const mcp of [false, true]) {
            const lastSeq = relay.state.hub(identity.hub_id).lastSeq;
            const rejected = await send(malformed, mcp);
            assert.equal(rejected.code, mcp ? 'schema_invalid' : 4);
            if (!mcp) assert.equal(rejected.error, 'schema_invalid');
            assert.equal(relay.state.hub(identity.hub_id).lastSeq, lastSeq, 'malformed validated send never reaches relay');
            await roundTrip(example, mcp);
          }
          const final = await roundTrip(malformed, true, false);
          assert.ok(JSON.stringify(final.slice(0, baseline.length)) === JSON.stringify(baseline), 'update preserves every raw reply');
          assert.equal(runtime.updater.status().high_water, document.skill_version);
          assert.deepEqual(executableHashes(), executableBefore, 'identical executable before and after signed update');
          const secrets = JSON.parse(fs.readFileSync(join(home, 'secrets.json')));
          for (const log of logs) for (const value of [futureEcho.nested.canary, secrets.token, secrets.private_key, phone.token, '"nested":']) assert.ok(!log.includes(value), 'private data absent from operational output');
        } finally { receiver.stop(); await receiver.done; }
      });
    }
  } finally { await relay.stop(); }
  assert.deepEqual(snapshot(), before, 'no agent implementation or build change');
}
