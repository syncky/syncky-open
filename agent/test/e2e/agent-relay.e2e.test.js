import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCAL_STATE_ERROR_CODES } from '../../src/config.js';
import { b64uDecode, b64uEncode, toHex } from '../../src/encoding.js';
import { TOKEN_RE } from '../../src/ids.js';
import { parsePairUri } from '../../src/pair-uri.js';
import { RELAY_CLIENT_ERROR_CODES, RELAY_ERROR_CODES } from '../../src/relay-client.js';
import { MAX_INNER_BYTES } from '../support/fake-phone.js';
import { agentBin } from '../support/agent-bin.js';
import { FakePhoneError, chunkSync, createFakePhone, sevenDaysOfStepsAndHeartRate } from '../support/fake-phone.js';
import { tempHome, waitFor } from '../support/helpers.js';
import { waitForSend } from '../support/send-receipt.js';
import { futureEcho } from '../support/skill-extension.js';

const RELAY = process.env.SYNCKY_E2E_RELAY;
const BIN = process.env.SYNCKY_E2E_AGENT_BIN || agentBin();
const launch = args => /\.m?js$/.test(BIN) ? [process.execPath, [BIN, ...args]] : [BIN, args];
const RECEIVE_FIXTURE = fileURLToPath(new URL('../support/receive-fixture.js', import.meta.url));
const RECEIVE_ERROR_CODES = new Set([...LOCAL_STATE_ERROR_CODES, ...RELAY_CLIENT_ERROR_CODES, ...RELAY_ERROR_CODES,
  'ENOENT', 'EEXIST', 'EACCES', 'EPERM', 'EIO', 'ENOSPC', 'ENOTEMPTY',
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'AbortError', 'ABORT_ERR',
  'malformed', 'inner_invalid', 'protocol_incompatible']);
const WAIT = { timeoutMs: 30_000, intervalMs: 250 };
const TIMEOUT = 60_000;
const source = { app: 'com.apple.Health', device: null };
const SKIP = RELAY ? false : 'SYNCKY_E2E_RELAY is not set';

describe('thin agent against the real relay (wrangler dev)', { skip: SKIP }, () => {
  const t = tempHome(), operational = [], sampleUuids = [], values = [], pairingTokens = [], privateTokens = [];
  let receiver, phone, identity, week, water;
  const secrets = () => JSON.parse(readFileSync(join(t.home, 'secrets.json'), 'utf8'));
  const env = () => {
    const result = { ...process.env, SYNCKY_INVITE: process.env.SYNCKY_E2E_INVITE || 'dev-invite' };
    for (const key of ['SYNCKY_AGENT_HOME', 'SYNCKY_RELAY_URL', 'SYNCKY_LOG_LEVEL', 'SYNCKY_URL_SCHEME']) delete result[key];
    return result;
  };
  async function run(args, { home = t.home, input, privateOutput = false } = {}) {
    const child = spawn(...launch(['--home', home, ...args]), { env: env(), stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    if (input !== undefined) { child.stdin.on('error', () => {}); child.stdin.end(input); }
    let stdout = '', stderr = '';
    child.stdout.on('data', c => { stdout += c; }); child.stderr.on('data', c => { stderr += c; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); }).finally(() => clearTimeout(timer));
    operational.push(stderr); if (!privateOutput) operational.push(stdout);
    return { code, stdout, stderr };
  }
  async function json(args, options = {}) {
    const output = await run(args[0] === 'send' ? args : [...args, '--json'], options);
    assert.equal(output.code, 0, `agent ${args[0]} exited ${output.code}`);
    return JSON.parse(output.stdout);
  }
  const status = () => json(['status']);
  async function inbox(type, member = phone?.memberId) {
    const records = []; let after = -1;
    for (;;) {
      const page = await json(['inbox', ...(after >= 0 ? ['--after-seq', String(after)] : []), '--limit', '1000', ...(type ? ['--type', type] : []), ...(member ? ['--member', member] : [])], { privateOutput: true });
      records.push(...page.records);
      if (!page.has_more) return records;
      assert.ok(page.next_after_seq > after); after = page.next_after_seq;
    }
  }
  const send = async inner => waitForSend(await json(['send', '--type', inner.type, '--to', phone.memberId, '--json', '-'], { input: JSON.stringify(inner) }), status, WAIT);
  const member = async () => (await status()).members.find(m => m.member_id === phone.memberId);
  const samples = async () => (await inbox('sync')).flatMap(r => r.inner.samples ?? []);
  const acks = async () => (await inbox('sync')).flatMap(r => r.inner.acks ?? []);
  const awaitAck = (command, outcome) => waitFor(async () => (await acks()).findLast(a => a.command_id === command.command_id && a.version === command.version && a.status === outcome), { ...WAIT, what: 'matching phone command outcome' });
  const fixture = n => {
    const sample = { uuid: randomUUID().toUpperCase(), type: 'heart_rate', value: Number(`73.12345${n}`), unit: 'count/min', start: '2026-10-12T08:00:00Z', end: '2026-10-12T08:00:00Z', source };
    sampleUuids.push(sample.uuid); values.push(String(sample.value)); return sample;
  };
  async function startReceive() {
    const child = spawn(process.execPath, [RECEIVE_FIXTURE, '--agent-bin', BIN, '--home', t.home], { env: env(), stdio: ['ignore', 'ignore', 'pipe'] });
    const proc = { child, stderr: '', done: new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => { proc.code = code; resolve(code); }); }) };
    receiver = proc;
    child.stderr.on('data', c => { proc.stderr += c; });
    await waitFor(() => { if (proc.code !== undefined) throw Error('receiver exited'); return proc.stderr.includes('receive_ready'); }, { ...WAIT, what: 'receive metadata readiness' });
  }
  async function stopReceive() {
    if (!receiver) return;
    const proc = receiver; receiver = null; proc.child.kill('SIGTERM');
    const timer = setTimeout(() => proc.child.kill('SIGKILL'), 15_000);
    try { assert.equal(await proc.done, 0); } finally { clearTimeout(timer); operational.push(proc.stderr); }
  }
  before(async () => { assert.equal((await fetch(`${RELAY}/v1/health`)).status, 200); });
  after(async () => { await stopReceive(); t.cleanup(); });

  it('registers, polls, holds authentic data until fingerprint confirmation and rejects a mismatch', { timeout: TIMEOUT }, async () => {
    const wrong = tempHome();
    try { const result = await run(['init', '--relay', RELAY, '--name', 'Wrong invite', '--invite', 'wrong-invite-e2e-0000'], { home: wrong.home }); assert.equal(result.code, 2); assert.match(result.stderr, /invalid_invite/); } finally { wrong.cleanup(); }
    identity = await json(['init', '--relay', RELAY, '--name', 'Thin relay e2e']);
    const pairing = await json(['pair', '--v1'], { privateOutput: true });
    pairingTokens.push(parsePairUri(pairing.uri, { allowInsecureRelay: true }).value.pairingToken);
    await startReceive();
    phone = createFakePhone({ relayUrl: RELAY, name: 'Thin e2e phone' }); await phone.pair(pairing.uri);
    await waitFor(async () => (await member())?.state === 'joined', { ...WAIT, what: 'joined phone' });
    assert.equal((await member()).fingerprint, phone.fingerprint());
    const early = [1, 2, 3, 4, 5].map(fixture); await phone.sendSync({ samples: early });
    await waitFor(async () => (await status()).held > 0, { ...WAIT, what: 'durably held ciphertext' });
    assert.equal((await inbox()).length, 0);
    const mismatch = await run(['confirm', phone.memberId, '0000 0000 0000 0000']);
    assert.equal(mismatch.code, 4); assert.match(mismatch.stderr, /fingerprint_mismatch/); assert.equal((await member()).state, 'joined');
    assert.equal((await json(['confirm', phone.memberId, phone.fingerprint()])).state, 'confirmed');
    await waitFor(async () => (await samples()).length === early.length, { ...WAIT, what: 'held samples released' });
    await waitFor(async () => (await status()).held === 0, { ...WAIT, what: 'held ciphertext cleanup' });
    assert.deepEqual(await samples(), early);
  });
  it('preserves controls and sends a generic resync request', { timeout: TIMEOUT }, async () => {
    await waitFor(async () => {
      await phone.fetchCommands(); return phone.controlReceived.some(m => m.type === 'confirmed');
    }, { ...WAIT, what: 'phone confirmation delivery' });
    await phone.sendControl({ type: 'paused', reason: 'user_paused' }); await phone.sendControl({ type: 'resumed' });
    await waitFor(async () => (await inbox('resumed')).length === 1, { ...WAIT, what: 'raw control receipts' });
    assert.equal((await inbox('paused'))[0].inner.reason, 'user_paused');
    const receipt = await send({ v: 1, type: 'resync_request', from: '2026-10-10T00:00:00Z' });
    assert.equal(receipt.state, 'sent'); await phone.fetchCommands();
    assert.equal(phone.controlReceived.at(-1).type, 'resync_request'); assert.equal(phone.controlReceived.at(-1).from, '2026-10-10T00:00:00Z');
  });
  it('keeps a week, resends and deletion messages verbatim while the consumer projects current samples', { timeout: TIMEOUT }, async () => {
    week = sevenDaysOfStepsAndHeartRate({ now: new Date('2026-10-12T10:00:00Z') }); sampleUuids.push(...week.map(s => s.uuid));
    const first = await phone.sendSync({ samples: week }); assert.equal(first.length, 2); assert.ok(first.every(c => c.bytes <= MAX_INNER_BYTES));
    await waitFor(async () => (await samples()).length === 5 + week.length, { ...WAIT, what: 'raw week' });
    const history = await inbox('sync'); await phone.sendSync({ samples: week });
    await waitFor(async () => (await samples()).length === 5 + 2 * week.length, { ...WAIT, what: 'raw resend retained' });
    const deletion = { uuid: week[10].uuid, type: week[10].type }; await phone.sendSync({ deleted: [deletion] });
    await waitFor(async () => (await inbox('sync')).some(r => r.inner.deleted?.some(d => d.uuid === deletion.uuid)), { ...WAIT, what: 'raw deletion' });
    assert.deepEqual((await inbox('sync')).slice(0, history.length), history);
    const current = new Map(); for (const r of await inbox('sync')) { for (const s of r.inner.samples ?? []) current.set(s.uuid, s); for (const d of r.inner.deleted ?? []) current.delete(d.uuid); }
    assert.equal(current.size, 5 + week.length - 1);
  });
  it('keeps every per-version outcome, phone deduplication and poison progress', { timeout: TIMEOUT }, async () => {
    const at = new Date().toISOString(); water = { command_id: `c_${randomUUID()}`, version: 1, op: 'write', type: 'dietary_water', value: 0.25, unit: 'L', start: at, end: at };
    await send({ v: 1, type: 'commands', commands: [water] }); await phone.answer(await phone.fetchCommands()); await awaitAck(water, 'applied'); assert.equal(phone.applyCount, 1);
    const bad = { ...water, command_id: `c_${randomUUID()}`, type: 'apple_exercise_time', value: 30, unit: 'min' };
    await send({ v: 1, type: 'commands', commands: [bad] }); await phone.answer(await phone.fetchCommands());
    assert.equal((await awaitAck(bad, 'rejected')).reason, 'type_not_allowed');
    const before = (await acks()).filter(a => a.command_id === water.command_id && a.version === 1).length;
    await send({ v: 1, type: 'commands', commands: [water] }); await phone.answer(await phone.fetchCommands());
    await waitFor(async () => (await acks()).filter(a => a.command_id === water.command_id && a.version === 1).length === before + 1, { ...WAIT, what: 're-ack retained' }); assert.equal(phone.applyCount, 1);
    const next = { ...water, version: 2, value: 0.5 };
    await send({ v: 1, type: 'commands', commands: [next] }); await phone.answer(await phone.fetchCommands()); await awaitAck(next, 'applied');
    assert.ok((await acks()).some(a => a.command_id === water.command_id && a.version === 1), 'version 1 outcome remains after version 2 is applied');
    const [inner] = chunkSync({ device: phone.memberId, samples: [fixture(6)] });
    const envelope = JSON.parse(await phone.seal(inner)), ciphertext = b64uDecode(envelope.ciphertext); ciphertext[10] ^= 1; envelope.ciphertext = b64uEncode(ciphertext);
    const poison = await phone.postEnvelope(JSON.stringify(envelope)); const valid = fixture(7); await phone.sendSync({ samples: [valid] });
    await waitFor(async () => (await samples()).some(s => s.uuid === valid.uuid), { ...WAIT, what: 'progress after poison' });
    assert.ok(!(await samples()).some(s => s.uuid === JSON.parse(inner).samples[0].uuid), 'poison ciphertext never reaches the inbox');
    await waitFor(async () => (await status()).transport.acked_seq > poison.seq, { ...WAIT, what: 'transport ACK past poison after durable inbox progress' });
  });
  it('round-trips an unlisted encrypted control through CLI and MCP with the running receiver', { timeout: TIMEOUT }, async () => {
    assert.ok(receiver && receiver.code === undefined);
    const inners = [false, true].map(mcp => ({ ...futureEcho, request: mcp ? 'mcp-echo' : 'cli-echo' }));
    for (const [i, inner] of inners.entries()) {
      const receipt = i === 0 ? await send(inner) : (await json(['mcp'], {
        input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'syncky_send', arguments: { type: inner.type, inner, to: phone.memberId, validate: true } } }) + '\n',
      })).result.structuredContent;
      await waitForSend(receipt, status, WAIT);
      const page = await (await fetch(`${RELAY}/v1/messages`, { headers: { Authorization: `Bearer ${phone.token}` } })).json();
      const wire = page.messages.find(row => row.msg_id === receipt.msg_id);
      assert.ok(wire); assert.equal(wire.kind, 'control'); assert.equal(wire.access, undefined); assert.equal(wire.diagnostics, undefined);
      assert.ok(!JSON.stringify(wire).includes(inner.nested.canary));
      await phone.fetchCommands();
      const received = phone.controlReceived.find(row => row.msg_id === receipt.msg_id);
      assert.ok(received, 'phone authenticated unlisted control');
      const { seq, msg_id, ...echo } = received;
      assert.ok(JSON.stringify(echo) === JSON.stringify(inner), 'unknown fields unchanged at phone');
      await phone.sendControl(echo);
    }
    await waitFor(async () => (await inbox('future_echo')).length === 2, { ...WAIT, what: 'raw future echoes' });
    assert.ok(JSON.stringify((await inbox('future_echo')).map(row => row.inner)) === JSON.stringify(inners), 'nested unknown fields unchanged in inbox');
    const mcp = await json(['mcp'], { privateOutput: true, input: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'syncky_inbox', arguments: { type: 'future_echo', member: phone.memberId } } }) + '\n' });
    assert.ok(JSON.stringify(mcp.result.structuredContent.records.map(row => row.inner)) === JSON.stringify(inners), 'MCP preserves every echo');
  });
  it('ACKs on the relay, retains history on revocation and forgets only after an explicit operation', { timeout: TIMEOUT }, async () => {
    const receivedSeq = (await inbox()).at(-1).seq;
    const { cursor } = await waitFor(async () => {
      const transport = (await status()).transport;
      return transport.cursor >= receivedSeq && transport;
    }, { ...WAIT, what: 'receive checkpoint after the last inbox record' });
    assert.equal((await json(['ack', '--up-to-seq', String(cursor)])).acked_up_to, cursor);
    const token = secrets().token;
    await waitFor(async () => (await (await fetch(`${RELAY}/v1/messages`, { headers: { Authorization: `Bearer ${token}` } })).json()).messages.length === 0,
      { ...WAIT, what: 'relay inbox drained after ACK' });
    const history = await inbox(); await phone.revokeSelf();
    await assert.rejects(phone.fetchCommands(), err => err instanceof FakePhoneError && err.status === 401 && err.code === 'invalid_token');
    await waitFor(async () => (await member()).state === 'revoked', { ...WAIT, what: 'reconciled revocation' }); assert.deepEqual(await inbox(), history);
    const preview = await json(['forget', phone.memberId]); assert.ok(preview);
    assert.deepEqual(await inbox(), history); await json(['forget', phone.memberId, '--yes']); assert.deepEqual(await inbox(), []); assert.equal((await member()).state, 'revoked');
  });
  it('revokes a confirmed phone through the CLI before explicitly forgetting it', { timeout: TIMEOUT }, async () => {
    const recovery = tempHome(), options = { home: recovery.home };
    try {
      await json(['init', '--relay', RELAY, '--name', 'Revoke e2e'], options);
      const pairing = await json(['pair'], { ...options, privateOutput: true });
      pairingTokens.push(parsePairUri(pairing.uri, { allowInsecureRelay: true }).value.pairingToken);
      const recovered = createFakePhone({ relayUrl: RELAY }); await recovered.pair(pairing.uri);
      privateTokens.push(recovered.token); await recovered.sendPairProof();
      assert.equal((await json(['wait', '--timeout', '20'], options)).member.state, 'confirmed');
      assert.equal((await run(['forget', recovered.memberId, '--yes'], options)).code, 4);
      const revoked = await json(['revoke', recovered.memberId], options);
      assert.equal(revoked.state, 'revoked'); assert.equal(revoked.member.state, 'revoked'); assert.equal(revoked.revoked_on_relay, true);
      await assert.rejects(recovered.fetchCommands(), err => err instanceof FakePhoneError && err.code === 'invalid_token');
      assert.equal((await json(['forget', recovered.memberId], options)).dry_run, true);
      assert.equal((await json(['forget', recovered.memberId, '--yes'], options)).dry_run, false);
      assert.equal((await json(['status'], options)).members.find(m => m.member_id === recovered.memberId).state, 'revoked');
    } finally { recovery.cleanup(); }
  });
  it('receives scoped pairing outcomes after proof and learns scope only from an empty sync', { timeout: TIMEOUT }, async () => {
    const scoped = tempHome(), options = { home: scoped.home, privateOutput: true };
    try {
      await json(['init', '--relay', RELAY, '--name', 'Scoped e2e'], options);
      const pairing = await json(['pair', '--read', 'steps', '--write', 'dietary_water'], options);
      const parsed = parsePairUri(pairing.uri, { allowInsecureRelay: true }).value;
      privateTokens.push(pairing.uri, pairing.code, parsed.requestedScope.request_ref, parsed.pairingToken, parsed.pairSecret);
      const joined = createFakePhone({ relayUrl: RELAY }); await joined.pair(pairing.uri);
      privateTokens.push(joined.token);
      const poll = async () => {
        const child = spawn(process.execPath, [RECEIVE_FIXTURE, '--agent-bin', BIN, '--home', scoped.home, '--once'],
          { env: env(), stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', chunk => { stderr += chunk; });
        const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT);
        try {
          const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
          let failureCode = 'unknown';
          if (code !== 0) for (const line of stderr.split('\n')) {
            try {
              const failure = JSON.parse(line);
              if (failure?.event === 'receiver_fixture_failed' && RECEIVE_ERROR_CODES.has(failure.code)) failureCode = failure.code;
            } catch {}
          }
          assert.equal(code, 0, `receiver fixture failed: ${failureCode}`);
        }
        finally { clearTimeout(timer); }
      };
      const scopedMember = async () => (await json(['status'], options)).members.find(m => m.member_id === joined.memberId);
      await joined.sendAccessReply({ request_ref: parsed.requestedScope.request_ref, decided_at: new Date().toISOString(),
        outcome: 'resolved', read: [{ type: 'steps', outcome: 'allowed' }], write: [{ type: 'dietary_water', outcome: 'declined' }] });
      await poll();
      assert.equal((await scopedMember()).state, 'joined');
      assert.equal((await scopedMember()).pairing_access.state, 'awaiting');
      assert.equal((await scopedMember()).scope, null);
      await joined.sendPairProof();
      await waitFor(async () => { await poll(); return (await scopedMember()).pairing_access.state === 'resolved'; },
        { ...WAIT, what: 'confirmed scoped pairing outcomes' });
      assert.equal((await scopedMember()).state, 'confirmed');
      assert.equal((await scopedMember()).scope, null);
      await joined.fetchCommands();
      assert.equal(joined.controlReceived.filter(m => m.type === 'access_request').length, 0);
      await joined.sendSync({ scope: { read: ['steps'], write: 'none' } });
      await waitFor(async () => { await poll(); return (await scopedMember()).scope !== null; },
        { ...WAIT, what: 'scope-only pairing sync' });
      assert.deepEqual((await scopedMember()).scope.read, ['steps']);
      assert.equal((await scopedMember()).scope.write, 'none');
      const records = (await json(['inbox', '--limit', '1000'], options)).records;
      assert.equal(records.filter(r => r.type === 'access_request').length, 0);
      assert.ok(records.filter(r => r.type === 'sync').every(r => r.inner.samples.length === 0 && r.inner.acks.length === 0));
    } finally { scoped.cleanup(); }
  });
  it('keeps credentials and inner values out of operational output', { timeout: TIMEOUT }, async () => {
    await stopReceive(); const secret = secrets();
    const forbidden = [secret.token, TOKEN_RE.exec(secret.token)[2], secret.private_key, toHex(b64uDecode(secret.private_key, { length: 32 })), phone.token, ...privateTokens, ...pairingTokens, ...sampleUuids, ...values, '"type":"sync"', futureEcho.nested.canary, '"nested":'];
    assert.ok(operational.length > 20);
    for (const text of operational) for (const needle of forbidden.filter(Boolean)) assert.ok(!text.includes(needle), 'private data in operational output');
  });
});
