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
test('receive help and parser expose the explicit record output switch', async () => {
  const result = await runCli(['help', 'receive']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /receive \[--once\] \[--poll-interval <seconds>\] \[--emit-records\]/);
  assert.equal(parseArgs(['receive', '--once', '--emit-records']).flags['emit-records'], true);
  assert.throws(() => parseArgs(['receive', '--emit-records=true']), /boolean option takes no value/);
  assert.throws(() => parseArgs(['inbox', '--emit-records']), /unknown option/);
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
