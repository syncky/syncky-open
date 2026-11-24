import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { main, parseArgs, commandNames } from '../../src/cli.js';
import { runCli, tempHome } from '../support/helpers.js';
import { setup, identity, keys, delivery } from '../support/thin-transport.js';
import { saveSecrets } from '../../src/secrets.js';
import { saveConfig, LocalStateError } from '../../src/config.js';
import { ERROR_GUIDANCE, errorHint } from '../../src/error-guidance.js';
import { RelayError } from '../../src/relay-client.js';
import { pairingWaitHome } from '../support/relay-socket.js';
import { RESPONSE_WAIT_MS } from '../../src/response-waits.js';

test('pair accepts explicit read and write scopes', () => {
  assert.equal(parseArgs(['pair', '--read', 'steps,body_mass', '--write', 'body_mass']).flags.read, 'steps,body_mass');
  assert.ok(!commandNames().includes('access'));
});

test('pair --wait listens before catch-up, checks at 30 seconds and wakes promptly on a hint', async t => {
  const { home, now, clock, pending, sockets, WebSocket } = pairingWaitHome(t);
  const checks = [], sleeps = [];
  const start = clock.now();
  const result = await runCli(['--home', home, 'pair', '--wait', '--v1', '--json', '--no-qr', '--timeout', '120'], {
    now, WebSocket, timers: clock.timers,
    fetch: async (url, options) => {
      const path = new URL(url).pathname;
      if (path === '/v1/pairings' && options.method === 'POST') return Response.json(pending);
      if (path === '/v1/members') return Response.json({ members: [{ member_id: keys.dev1.member_id, role: 'device', public_key: keys.dev1.pk }] });
      assert.equal(path, `/v1/pairings/${pending.pairing_id}`);
      assert.equal(sockets.length, 1);
      checks.push(clock.now() - start);
      if (checks.length === 1) sockets[0].open();
      if (checks.length === 4) return Response.json({ status: 'completed', member_id: keys.dev1.member_id, public_key: keys.dev1.pk, completed_at: now().toISOString() });
      return Response.json({ status: 'pending' });
    },
    sleep: async ms => {
      sleeps.push(ms);
      if (sleeps.length === 1) clock.advance(ms);
      else {
        assert.equal(sleeps.length, 2);
        clock.advance(400);
        sockets[0].message('changed'); sockets[0].message('changed');
      }
    },
  });
  assert.equal(result.code, 0);
  assert.equal(JSON.parse(result.stdout.trim().split('\n').at(-1)).status, 'completed');
  assert.ok(!/websocket|socket|real-time/i.test(result.stdout + result.stderr), 'pairing output exposed transport terminology');
  assert.deepEqual(checks, [0, 0, 30_000, 30_400]);
  assert.deepEqual(sleeps, [30_000, 30_000]);
  assert.equal(sockets[0].url.href, 'wss://relay.example/v1/socket');
  assert.equal(sockets[0].closes, 1);
  assert.equal(clock.pending.size, 0);
});

for (const source of ['file', 'env']) test(`pair --wait uses the two-second cadence when opted out by ${source}`, async t => {
  const { home, now, clock, pending, sockets, WebSocket } = pairingWaitHome(t, source === 'file' ? { fast_path: 'off' } : { fast_path: 'on' });
  const sleeps = [];
  const result = await runCli(['--home', home, 'pair', '--wait', '--v1', '--no-qr', '--timeout', '5'], {
    now, WebSocket, timers: clock.timers, env: source === 'env' ? { SYNCKY_FAST_PATH: 'off' } : {},
    fetch: async (url, options) => Response.json(options.method === 'POST' ? pending : { status: 'pending' }),
    sleep: async ms => { assert.ok(sleeps.length < 3); sleeps.push(ms); clock.advance(ms); },
  });
  assert.equal(result.code, 4);
  assert.equal(JSON.parse(result.stderr).error, 'timeout');
  assert.deepEqual(sleeps, [2000, 2000, 1000]);
  assert.equal(sockets.length, 0);
  assert.equal(clock.pending.size, 0);
});
for (const args of [[], ['unknown'], ['send','--json'], ['send','--json','--validate'], ['status','--bad'], ['status','extra'], ['status','--json=true'], ['help','unknown']]) test(`invalid CLI arguments fail safely: ${args[0] ?? 'none'}`, async t => {
  const tmp = tempHome(); t.after(tmp.cleanup);
  const result = await runCli(['--home', tmp.home, ...args]); assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stderr).error, 'invalid_arguments');
  assert.equal(JSON.parse(result.stderr).hint, ERROR_GUIDANCE.invalid_arguments);
});
test('send input flag is a path; other JSON flags are output switches', () => {
  assert.equal(parseArgs(['--home','/tmp/home','send','--type','future','--json','-']).flags.json, '-');
  assert.equal(parseArgs(['status','--json']).flags.json, true);
  assert.equal(parseArgs(['revoke','m_dev_1','--json']).flags.json, true);
});
test('refused forget returns the local failure exit and the recovery command', async t => {
  const { home } = setup(t);
  saveSecrets(home, { private_key: keys.agent.sk, public_key: keys.agent.pk,
    token: `sk_${identity.hub_id}_${'T'.repeat(40)}`, webhook_secret: `whsec_${'W'.repeat(43)}` });
  saveConfig(home, { relay_url: 'https://relay.example', name: 'Test' });
  const result = await runCli(['--home', home, 'forget', keys.dev1.member_id]);
  assert.equal(result.code, 4);
  assert.match(JSON.parse(result.stderr).hint, /syncky revoke <member_id>/);
  assert.ok(!JSON.parse(result.stderr).hint.includes('syncky-agent'));
});
test('receive exposes explicit record output while other commands refuse it', () => {
  assert.equal(parseArgs(['receive', '--once', '--emit-records']).flags['emit-records'], true);
  assert.throws(() => parseArgs(['receive', '--emit-records=true']), /boolean option takes no value/);
  assert.throws(() => parseArgs(['inbox', '--emit-records']), /unknown option/);
});

function commandReceiveHome(t) {
  const { home, transport } = setup(t);
  saveSecrets(home, { private_key: keys.agent.sk, public_key: keys.agent.pk,
    token: `sk_${identity.hub_id}_${'T'.repeat(40)}`, webhook_secret: `whsec_${'W'.repeat(43)}` });
  saveConfig(home, { relay_url: 'https://relay.example', name: 'Test', fast_path: 'off', heartbeat: 'off' });
  let at = Date.parse('2026-11-05T12:00:00Z'), messages = [], retryAfter;
  const queries = [];
  const run = (args, opts) => runCli(['--home', home, ...args], { now: () => new Date(at),
    fetch: async (rawUrl, { method }) => {
      const url = new URL(rawUrl);
      if (url.pathname === '/v1/acks') return Response.json({ acked: 1 });
      if (url.pathname !== '/v1/messages') return Response.json({ state: 'active' });
      if (method === 'POST') return Response.json({ seq: 2 }, { status: 201 });
      queries.push(url.searchParams.get('command_ack'));
      if (retryAfter !== undefined) {
        const { seconds, reason } = retryAfter;
        retryAfter = undefined;
        return Response.json({ error: 'rate_limited', details: { retry_after_s: seconds, reason } },
          { status: 429, headers: { 'Retry-After': String(seconds) } });
      }
      return Response.json({ messages, next_after: messages.at(-1)?.seq ?? 0, has_more: false });
    }, ...opts,
  });
  const receive = async () => {
    const result = await run(['receive', '--once']);
    assert.equal(result.code, 0);
    return result.stderr.trim().split('\n').map(line => JSON.parse(line)).find(line => line.event === 'receive_cycle');
  };
  const send = async () => {
    const date = new Date(at).toISOString().replace('.000Z', 'Z');
    const result = await run(['send', '--type', 'commands', '--json', '-', '--validate'], { stdin: Readable.from([JSON.stringify({
      v: 1, type: 'commands', commands: [{ command_id: 'write-1', version: 1, op: 'write', type: 'dietary_water',
        value: 0.25, unit: 'L', start: date, end: date }],
    })]) });
    assert.equal(result.code, 0);
    assert.equal(JSON.parse(result.stdout).state, 'sent');
  };
  return { run, receive, send, queries, advance: ms => { at += ms; },
    limitNextPoll: (seconds, reason) => { retryAfter = { seconds, reason }; },
    deliver: async (seq, acks) => { messages = [await delivery(transport, seq, { v: 1, type: 'sync', samples: [], acks, more: false })]; },
  };
}

for (const status of ['applied', 'rejected']) test(`receive --once collects the ${status} write acknowledgment seconds after a post-sync send`, async t => {
  const phone = commandReceiveHome(t);
  await phone.deliver(1, []);
  assert.equal((await phone.receive()).fetched, 1);
  phone.advance(1000);
  await phone.send();
  phone.advance(2000);
  await phone.deliver(3, [{ command_id: 'write-1', version: 1, status, ...(status === 'rejected' && { reason: 'healthkit_denied' }) }]);
  assert.equal((await phone.receive()).fetched, 1);
  const inbox = await phone.run(['inbox', '--json']);
  assert.equal(inbox.code, 0);
  assert.equal(JSON.parse(inbox.stdout).records.at(-1).inner.acks[0].status, status);
  phone.advance(25000);
  assert.equal((await phone.receive()).reason, 'poll_floor');
  assert.deepEqual(phone.queries, [null, '1']);
});

test('an unanswered write fetches again after 25 seconds and returns to the normal floor when its wait expires', async t => {
  const phone = commandReceiveHome(t);
  await phone.receive();
  phone.advance(1000);
  await phone.send();
  phone.advance(1000);
  assert.equal((await phone.receive()).fetched, 0);
  phone.advance(24999);
  assert.equal((await phone.receive()).reason, 'poll_floor');
  phone.advance(1);
  assert.equal((await phone.receive()).fetched, 0);
  phone.advance(RESPONSE_WAIT_MS - 26001);
  assert.equal((await phone.receive()).fetched, 0);
  phone.advance(25000);
  assert.equal((await phone.receive()).reason, 'poll_floor');
  assert.deepEqual(phone.queries, [null, '1', '1', '1']);
});

test('receive --once honors Retry-After while a write acknowledgment is pending', async t => {
  const phone = commandReceiveHome(t);
  await phone.receive();
  phone.advance(1000);
  await phone.send();
  phone.limitNextPoll(60);
  const limited = await phone.run(['receive', '--once']);
  assert.notEqual(limited.code, 0);
  assert.equal(JSON.parse(limited.stderr.trim().split('\n').at(-1)).error, 'rate_limited');
  await phone.deliver(3, [{ command_id: 'write-1', version: 1, status: 'applied' }]);
  phone.advance(59_999);
  assert.equal((await phone.receive()).reason, 'retry_after');
  assert.deepEqual(phone.queries, [null, '1']);
  phone.advance(1);
  assert.equal((await phone.receive()).fetched, 1);
});

for (const reason of ['agent_poll_floor', undefined]) test(
  `a send after a ${reason ? 'poll-floor refusal allows an early one-shot receive' : 'general rate limit leaves one-shot receive deferred'}`,
  async t => {
    const phone = commandReceiveHome(t);
    phone.limitNextPoll(299, reason);
    const limited = await phone.run(['receive', '--once']);
    assert.notEqual(limited.code, 0);
    assert.equal(JSON.parse(limited.stderr.trim().split('\n').at(-1)).error, 'rate_limited');
    phone.advance(1000);
    assert.equal((await phone.receive()).reason, 'retry_after');
    await phone.send();
    phone.advance(2000);
    await phone.deliver(3, [{ command_id: 'write-1', version: 1, status: 'applied' }]);

    if (reason) {
      assert.equal((await phone.receive()).fetched, 1);
      assert.deepEqual(phone.queries, [null, '1']);
    } else {
      assert.equal((await phone.receive()).reason, 'retry_after');
      assert.deepEqual(phone.queries, [null]);
      phone.advance(296_000);
      assert.equal((await phone.receive()).fetched, 1);
    }
  },
);

test('invalid receive intervals and relay overrides fail locally with distinct safe guidance', async t => {
  const { home } = setup(t);
  saveSecrets(home, { private_key: keys.agent.sk, public_key: keys.agent.pk,
    token: `sk_${identity.hub_id}_${'T'.repeat(40)}`, webhook_secret: `whsec_${'W'.repeat(43)}` });
  saveConfig(home, { relay_url: 'https://relay.example', name: 'Test' });
  let relayCalls = 0, pollerCreations = 0;
  const run = (args, env = {}) => runCli(['--home', home, 'receive', ...args], { env,
    fetch: () => { relayCalls++; assert.fail('config validation must precede relay access'); },
    createPoller: () => { pollerCreations++; assert.fail('config validation must precede poller creation'); },
  });
  const pollError = { error: 'invalid_config', detail: 'poll_interval_s',
    hint: '--poll-interval requires whole seconds in the inclusive 300–86,400 range. Use the same range for SYNCKY_POLL_INTERVAL_S or poll_interval_s in config.json.' };
  for (const once of [[], ['--once']]) {
    for (const value of ['10', '60', '299', '86401', '300.5', 'PRIVATE_CANARY']) {
      const result = await run([...once, '--poll-interval', value]);
      assert.equal(result.code, 4);
      assert.ok(result.stdout === '' && !result.stderr.includes('PRIVATE_CANARY'), 'invalid input leaked into output');
      assert.deepEqual(JSON.parse(result.stderr), pollError);
    }
  }
  const envError = await run(['--once'], { SYNCKY_POLL_INTERVAL_S: '60' });
  assert.equal(envError.code, 4);
  assert.deepEqual(JSON.parse(envError.stderr), pollError);
  for (const relay of ['https://other.example', 'https://PRIVATE_CANARY@relay.example']) {
    const result = await run(['--once', '--relay', relay]);
    assert.equal(result.code, 4);
    assert.ok(result.stdout === '' && !result.stderr.includes(relay), 'invalid relay override leaked into output');
    assert.deepEqual(JSON.parse(result.stderr), { error: 'invalid_config', hint: ERROR_GUIDANCE.invalid_config });
  }
  assert.equal(relayCalls, 0);
  assert.equal(pollerCreations, 0);
});
test('selftest keeps transport crypto, both pairing versions, markers and signature vectors', async () => {
  const result = await runCli(['selftest']); assert.equal(result.code, 0);
  assert.equal(JSON.parse(result.stdout).ok, true);

});


test('CLI error serialization preserves exits and suppresses untrusted details', async t => {
  const { home } = setup(t);
  saveSecrets(home, { private_key: keys.agent.sk, public_key: keys.agent.pk,
    token: `sk_${identity.hub_id}_${'T'.repeat(40)}`, webhook_secret: `whsec_${'W'.repeat(43)}` });
  saveConfig(home, { relay_url: 'https://relay.example', name: 'Test' });
  for (const code of ['invalid_token', 'invalid_config', 'future_error', 'constructor', 'PRIVATE_CANARY\nunsafe']) {
    for (const relay of [false, true]) {
      let stderr = '', stdout = '';
      const error = relay ? new RelayError({ code, status: 403, message: 'PRIVATE_CANARY', details: 'PRIVATE_CANARY' }) : new LocalStateError(code, 'PRIVATE_CANARY');
      error.hint = 'PRIVATE_CANARY';
      const exit = await main(['--home', home, 'status'], { env: {},
        stdout: { write: text => { stdout += text; } }, stderr: { write: text => { stderr += text; } },
        createPoller: () => { throw error; }, fetch: () => assert.fail('error serialization must not fetch'),
      });
      assert.equal(exit, relay ? code === 'invalid_token' ? 3 : 2 : 4);
      const value = JSON.parse(stderr);
      assert.equal(value.error, /^[a-z_]{1,64}$/.test(code) ? code : 'local_error');
      assert.equal(value.hint, errorHint(value.error)); assert.equal(stdout, '');
      assert.ok(!stderr.includes('PRIVATE_CANARY'));
      assert.equal(value.detail, undefined);
    }
  }
});

test('the dependency-free command registry states the byte limits the transport and the pairing scope enforce', async () => {
  const source = (await import('node:fs')).readFileSync(new URL('../../src/cli-commands.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /^import /m);
  const { PAIRING_BYTE_LIMITS } = await import('../../src/cli-commands.js');
  const { MAX_ACCESS_ENVELOPE_BYTES, MAX_CONTROL_ENVELOPE_BYTES } = await import('../../src/thin-transport.js');
  const { MAX_PAIRING_REQUEST_BODY_BYTES, MAX_PAIRING_SCOPE_BLOB_BYTES, MAX_PAIRING_SCOPE_BLOB_CHARS } = await import('../../src/pairing-scope-blob.js');
  assert.deepEqual({ ...PAIRING_BYTE_LIMITS }, {
    max_pairing_scope_blob_bytes: MAX_PAIRING_SCOPE_BLOB_BYTES,
    max_pairing_scope_blob_base64url_chars: MAX_PAIRING_SCOPE_BLOB_CHARS,
    max_pairing_request_body_bytes: MAX_PAIRING_REQUEST_BODY_BYTES,
    max_control_envelope_bytes: MAX_CONTROL_ENVELOPE_BYTES,
    max_access_envelope_bytes: MAX_ACCESS_ENVELOPE_BYTES,
  });
});
