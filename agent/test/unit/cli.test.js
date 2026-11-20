import assert from 'node:assert/strict';
import { test } from 'node:test';
import { main, parseArgs, commandNames } from '../../src/cli.js';
import { runCli, tempHome } from '../support/helpers.js';
import { loadVectors } from '../../src/protocol-files.js';
import { setup, identity, keys } from '../support/thin-transport.js';
import { saveSecrets } from '../../src/secrets.js';
import { saveConfig, LocalStateError } from '../../src/config.js';
import { ERROR_GUIDANCE, errorHint } from '../../src/error-guidance.js';
import { RelayError } from '../../src/relay-client.js';

test('pair exposes comma-separated read/write flags without a typed access command', async () => {
  const result = await runCli(['help', 'pair']);
  assert.match(result.stdout, /--read <comma-separated-types>/);
  for (const cap of [12000, 16000, 16384, 4096, 131072]) assert.match(result.stdout, new RegExp(`\\b${cap}\\b`));
  assert.match(result.stdout, /--write <comma-separated-types>/);
  assert.equal(parseArgs(['pair', '--read', 'steps,body_mass', '--write', 'body_mass']).flags.read, 'steps,body_mass');
  assert.ok(!commandNames().includes('access'));
});

for (const name of commandNames()) test(`help for ${name} works without network or a home`, async t => {
  const tmp = tempHome(); t.after(tmp.cleanup);
  const result = await runCli(['--home', tmp.home, 'help', name]);
  assert.equal(result.code, 0); assert.match(result.stdout, new RegExp(name));
  assert.ok(result.stdout.startsWith(`usage: syncky-agent ${name}`));
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
test('general help keeps the documented syncky-agent usage', async () => {
  const result = await runCli(['--help']);
  assert.equal(result.code, 0);
  assert.ok(result.stdout.startsWith('usage: syncky-agent <command>'));
});
test('command usage keeps syncky-agent while refused forget hints use syncky', async t => {
  const { home } = setup(t);
  saveSecrets(home, { private_key: keys.agent.sk, public_key: keys.agent.pk,
    token: `sk_${identity.hub_id}_${'T'.repeat(40)}`, webhook_secret: `whsec_${'W'.repeat(43)}` });
  saveConfig(home, { relay_url: 'https://relay.example', name: 'Test' });
  const help = await runCli(['help', 'forget']);
  assert.ok(help.stdout.startsWith('usage: syncky-agent forget '));
  const result = await runCli(['--home', home, 'forget', keys.dev1.member_id]);
  assert.equal(result.code, 4);
  assert.match(JSON.parse(result.stderr).hint, /syncky revoke <member_id>/);
  assert.ok(!JSON.parse(result.stderr).hint.includes('syncky-agent'));
});
test('revoke help explains relay-first revocation and retained history', async () => {
  const result = await runCli(['help', 'revoke']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /revoke <member_id>/);
  assert.match(result.stdout, /relay, then stop trusting it locally/);
  assert.match(result.stdout, /held ciphertext/i);
  assert.match(result.stdout, /pending sends to that phone fail/);
  assert.match(result.stdout, /normal 30-day retention/);
  assert.match(result.stdout, /earlier owner-approved syncky forget <member_id> --yes/);
});
test('reject help explains local rejection, recovery and history retention', async () => {
  const result = await runCli(['help', 'reject']);
  assert.equal(result.code, 0);
  for (const text of ['held ciphertext', 'pending sends to that phone fail', 'normal 30-day retention',
    'earlier owner-approved syncky forget <member_id> --yes', 'syncky revoke <member_id>',
    'after the relay is reachable or the token is fixed', 'invalid_token', 'tell the owner']) assert.ok(result.stdout.includes(text));
});
test('receive help explains polling limits and exposes the explicit record output switch', async () => {
  const result = await runCli(['help', 'receive']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /receive \[--once\] \[--poll-interval <seconds>\] \[--emit-records\]/);
  for (const text of ['whole seconds (300–86,400, inclusive, default 1800)', '--once skips that cadence',
    'minimum between polls is 300 seconds', 'First-sync join polling and pagination', 'Relay Retry-After']) {
    assert.ok(result.stdout.includes(text), text);
  }
  assert.equal(parseArgs(['receive', '--once', '--emit-records']).flags['emit-records'], true);
  assert.throws(() => parseArgs(['receive', '--emit-records=true']), /boolean option takes no value/);
  assert.throws(() => parseArgs(['inbox', '--emit-records']), /unknown option/);
});

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
  const cases = loadVectors('envelopes').cases;
  assert.ok(cases.some(c => c.name === 'access_reply_resolved_merged'));
  assert.ok(cases.some(c => c.name === 'access_reply_filtered'));
  assert.equal(JSON.parse(result.stdout).files.find(f => f.file === 'envelopes.json').cases, cases.length);
});


test('CLI public error serialization covers every known code with fixed guidance and unchanged exits', async t => {
  const { home } = setup(t);
  saveSecrets(home, { private_key: keys.agent.sk, public_key: keys.agent.pk,
    token: `sk_${identity.hub_id}_${'T'.repeat(40)}`, webhook_secret: `whsec_${'W'.repeat(43)}` });
  saveConfig(home, { relay_url: 'https://relay.example', name: 'Test' });
  for (const code of [...Object.keys(ERROR_GUIDANCE), 'future_error', 'constructor', 'PRIVATE_CANARY\nunsafe']) {
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

test('send help explains receipt states and the unchanged success exit', async () => {
  const result = await runCli(['help', 'send']);
  assert.equal(result.code, 0);
  for (const text of ['pending', 'sent', 'failed', 'relay_code', 'relay_status', 'exit 0', 'Phone application']) assert.ok(result.stdout.includes(text));
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

test('receive help states the configured poll limits from config', async () => {
  const { commands } = await import('../../src/cli-commands.js');
  const { CONFIG_DEFAULTS, POLL_INTERVAL_MIN_S, POLL_INTERVAL_MAX_S } = await import('../../src/config.js');
  const range = `whole seconds (${POLL_INTERVAL_MIN_S}–${POLL_INTERVAL_MAX_S.toLocaleString('en-US')}, inclusive, default ${CONFIG_DEFAULTS.poll_interval_s})`;
  assert.ok(commands.receive.details.includes(range));
  assert.ok(commands.receive.details.includes(`minimum between polls is ${POLL_INTERVAL_MIN_S} seconds`));
});
