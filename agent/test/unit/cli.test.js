import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseArgs, commandNames } from '../../src/cli.js';
import { runCli, tempHome } from '../support/helpers.js';
import { loadVectors } from '../../src/protocol-files.js';

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
});
for (const args of [[], ['unknown'], ['send','--json'], ['send','--json','--validate'], ['status','--bad'], ['status','extra'], ['status','--json=true'], ['help','unknown']]) test(`invalid CLI arguments fail safely: ${args[0] ?? 'none'}`, async t => {
  const tmp = tempHome(); t.after(tmp.cleanup);
  const result = await runCli(['--home', tmp.home, ...args]); assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stderr).error, 'invalid_arguments');
});
test('send input flag is a path; other JSON flags are output switches', () => {
  assert.equal(parseArgs(['--home','/tmp/home','send','--type','future','--json','-']).flags.json, '-');
  assert.equal(parseArgs(['status','--json']).flags.json, true);
  assert.equal(parseArgs(['revoke','m_dev_1','--json']).flags.json, true);
});
test('revoke help explains relay-first revocation and retained history', async () => {
  const result = await runCli(['help', 'revoke']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /revoke <member_id>/);
  assert.match(result.stdout, /relay, then stop trusting it locally/);
  assert.match(result.stdout, /History stays until forget/);
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
