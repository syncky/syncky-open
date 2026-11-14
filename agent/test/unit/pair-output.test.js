import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import qrcode from 'qrcode-terminal';
import QRErrorCorrectLevel from 'qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel.js';
import { saveConfig } from '../../src/config.js';
import { createHomeState } from '../../src/home-state.js';
import { saveSecrets } from '../../src/secrets.js';
import { identity, keys } from '../support/thin-home.js';
import { pairCode } from '../../src/pair-code.js';
import { parsePairUri } from '../../src/pair-uri.js';
import { readPairingFile } from '../../src/pairing.js';
import { acquireHomeLock } from '../../src/protected-files.js';
import { startRelayDouble } from '../support/relay-double.js';
import { runCli, tempHome } from '../support/helpers.js';

const limitsNotice = 'Hosted default pairing-link lifetime: 10 minutes; expires_at from the relay is authoritative.\nHosted default never-joined hub lifetime: 24 hours from registration; creating another link does not restart it.\n';
const limits = { hosted_defaults: { pairing_link_ttl_s: 600, unjoined_hub_ttl_s: 86400 },
  pairing_link_deadline: 'expires_at', unjoined_hub_clock: 'registration' };

test('every pair presentation labels hosted defaults without inventing a new registration deadline', async t => {
  const tmp = tempHome(), home = tmp.home;
  fs.mkdirSync(home, { mode: 0o700 });
  createHomeState(home, identity);
  saveSecrets(home, { private_key: keys.agent.sk, public_key: keys.agent.pk,
    token: `sk_${identity.hub_id}_${'T'.repeat(40)}`, webhook_secret: `whsec_${'W'.repeat(43)}` });
  saveConfig(home, { relay_url: 'https://relay.example', name: 'Lab' });
  const lock = acquireHomeLock(home, 'receiver'); t.after(() => { lock.release(); tmp.cleanup(); });
  let instant = Date.parse('2026-11-13T00:00:00Z'), count = 0;
  const expires = '2026-11-14T00:07:00Z';
  const fetch = async (_url, options) => Response.json(options.method === 'POST'
    ? { pairing_id: `p_${String(++count).padStart(22, 'A')}`, pairing_token: `pt_${'P'.repeat(43)}`, expires_at: expires }
    : { status: 'pending', expires_at: expires });
  for (const v1 of [false, true]) for (const wait of [false, true]) for (const noQr of [false, true]) for (const json of [false, true]) {
    instant += 3600000;
    const result = await runCli(['--home', home, 'pair', ...(v1 ? ['--v1'] : []), ...(wait ? ['--wait', '--timeout', '1'] : []),
      ...(noQr ? ['--no-qr'] : []), ...(json ? ['--json'] : [])], { fetch, now: () => new Date(instant),
      sleep: async ms => { instant += ms; }, spawn: () => assert.fail('must not spawn a detached waiter') });
    assert.equal(result.code, wait ? 4 : 0);
    if (wait) assert.equal(JSON.parse(result.stderr).error, 'timeout');
    const pairing = readPairingFile(home), parsed = parsePairUri(pairing.uri);
    assert.equal(parsed.ok, true);
    if (json) {
      const output = JSON.parse(result.stdout);
      assert.deepEqual(output.limits, limits);
      assert.equal(output.expires_at, expires);
      assert.ok(output.uri === pairing.uri, 'private URI changed');
      assert.deepEqual(Object.keys(output).sort(), ['pairing_id', 'uri', 'expires_at', 'version', 'limits', ...(v1 ? [] : ['code'])].sort());
    } else {
      assert.ok(result.stdout.startsWith(pairing.uri + '\n'), 'private URI changed');
      let qr = ''; if (!noQr) { qrcode.error = QRErrorCorrectLevel.M; qrcode.generate(pairing.uri, { small: true }, text => { qr = text; }); }
      assert.ok(result.stdout === `${pairing.uri}\n${qr}${v1 ? '' : 'Pairing code: ' + pairCode(pairing.pair_secret) + '\n'}${limitsNotice}Link expires_at: ${expires}\n`, 'pair presentation changed');
    }
    for (const secret of [pairing.uri, parsed.value.pairingToken, parsed.value.pairSecret].filter(Boolean)) {
      assert.ok(!result.stderr.includes(secret), 'credential leaked into logs');
      assert.ok(!JSON.stringify(limits).includes(secret), 'credential leaked into limits');
    }
    assert.ok(!Object.hasOwn(pairing, 'limits'), 'presentation metadata changed stored pairing');
  }
  const help = await runCli(['help', 'pair']);
  assert.ok(help.stdout.includes(limitsNotice));

  const member = { member_id: keys.dev1.member_id, public_key: keys.dev1.pk, role: 'device', name: 'Phone' };
  const completed = await runCli(['--home', home, 'pair', '--v1', '--wait', '--no-qr', '--json'], {
    now: () => new Date(instant), spawn: () => assert.fail('must not spawn a detached waiter'),
    fetch: async (url, options) => {
      if (options.method === 'POST') return fetch(url, options);
      return Response.json(new URL(url).pathname === '/v1/members' ? { members: [member] }
        : { status: 'completed', member_id: member.member_id, public_key: member.public_key, completed_at: new Date(instant).toISOString() });
    },
  });
  assert.equal(completed.code, 0);
  const lines = completed.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[0].limits, limits);
  assert.equal(lines[0].expires_at, expires);
  assert.equal(lines[1].status, 'completed');
  assert.equal(lines[1].member.state, 'joined');
  assert.equal(lines[1].member.fingerprint.split(' ').join('').length, 16);
  assert.equal(completed.stderr, '');
});

test('pair output follows flag > environment > saved config, leaving config intact and QR/print/JSON identical', async t => {
  const tmp = tempHome(), relay = await startRelayDouble({ invite: 'output-fixture' });
  let lock;
  t.after(async () => { lock?.release(); await relay.stop(); tmp.cleanup(); });
  assert.equal((await runCli(['--home', tmp.home, 'init', '--name', 'Lab', '--relay', relay.url], { env: { SYNCKY_INVITE: 'output-fixture' } })).code, 0);
  const path = join(tmp.home, 'config.json'), config = JSON.parse(fs.readFileSync(path, 'utf8'));
  lock = acquireHomeLock(tmp.home, 'receiver');
  for (const [saved, envScheme, flagScheme, prefix] of [
    [undefined, undefined, undefined, 'https://syncky.app/pair#'],
    [null, '', undefined, 'https://syncky.app/pair#'],
    ['syncky', undefined, undefined, 'syncky://pair?'],
    ['syncky', 'syncky-staging', undefined, 'syncky-staging://pair?'],
    ['syncky', 'syncky-staging', 'syncky-dev', 'syncky-dev://pair?'],
  ]) {
    saveConfig(tmp.home, { ...config, ...(saved === undefined ? {} : { url_scheme: saved }) });
    const before = fs.readFileSync(path, 'utf8'), env = envScheme === undefined ? {} : { SYNCKY_URL_SCHEME: envScheme };
    for (const json of [false, true]) {
      const result = await runCli(['--home', tmp.home, 'pair', ...(flagScheme ? ['--url-scheme', flagScheme] : []), ...(json ? ['--json'] : [])], { env });
      assert.equal(result.code, 0);
      const pairing = readPairingFile(tmp.home), uri = pairing.uri;
      assert.ok(uri.startsWith(prefix), 'wrong pairing transport');
      const parsed = parsePairUri(uri, { allowInsecureRelay: true }); assert.equal(parsed.ok, true);
      assert.equal(parsed.value.relayBase, relay.url);
      if (json) assert.ok(JSON.parse(result.stdout).uri === uri, 'JSON differs from persisted link');
      else {
        assert.ok(result.stdout.split('\n')[0] === uri, 'printed link differs from persisted link');
        let qr = '';
        qrcode.error = QRErrorCorrectLevel.M;
        qrcode.generate(uri, { small: true }, text => { qr = text; });
        assert.ok(qr.length > 0, 'expected QR is empty');
        assert.ok(result.stdout === `${uri}\n${qr}Pairing code: ${pairCode(pairing.pair_secret)}\n${limitsNotice}Link expires_at: ${pairing.expires_at}\n`, 'QR differs from printed link');
      }
      assert.equal(fs.readFileSync(path, 'utf8'), before);
      for (const credential of [uri, parsed.value.pairingToken, parsed.value.pairSecret]) assert.ok(!result.stderr.includes(credential), 'credential leaked into logs');
      const status = await runCli(['--home', tmp.home, 'status', '--json']);
      assert.equal(status.code, 0);
      for (const credential of [uri, parsed.value.pairingToken, parsed.value.pairSecret]) assert.ok(!(status.stdout + status.stderr).includes(credential), 'credential leaked into status');
    }
  }
  saveConfig(tmp.home, { ...config, url_scheme: null });
  for (const [flagRelay, envRelay, site] of [
    [undefined, undefined, 'syncky.app'],
    [relay.url + '/', undefined, 'syncky.app'],
    [undefined, relay.url + '/', 'syncky.app'],
    [undefined, 'https://relay-staging.syncky.app:8443', 'staging.syncky.app'],
    ['https://relay-dev.syncky.app:8443', 'https://relay-staging.syncky.app', 'dev.syncky.app'],
    ['https://relay-dev.syncky.app.example', 'https://relay-dev.syncky.app', 'syncky.app'],
  ]) {
    const before = fs.readFileSync(path, 'utf8'), requested = [];
    const result = await runCli(['--home', tmp.home, 'pair', '--json', ...(flagRelay ? ['--relay', flagRelay] : [])], {
      env: envRelay ? { SYNCKY_RELAY_URL: envRelay } : {}, fetch: (url, options) => {
        const target = new URL(url); requested.push(target.origin);
        return fetch(relay.url + target.pathname + target.search, options);
      },
    });
    if ([flagRelay, envRelay].some(value => value && new URL(value).origin !== relay.url)) {
      assert.notEqual(result.code, 0); assert.equal(result.stdout, '');
      assert.equal(JSON.parse(result.stderr.trim().split('\n').at(-1)).error, 'invalid_config');
      assert.deepEqual(requested, []); assert.equal(fs.readFileSync(path, 'utf8'), before);
      continue;
    }
    assert.equal(result.code, 0);
    const uri = JSON.parse(result.stdout).uri;
    assert.equal(new URL(uri).origin, `https://${site}`);
    assert.equal(parsePairUri(uri, { allowInsecureRelay: true }).value.relayBase, new URL(flagRelay ?? envRelay ?? relay.url).origin);
    assert.ok(requested.every(origin => origin === new URL(flagRelay ?? envRelay ?? relay.url).origin));
    assert.equal(fs.readFileSync(path, 'utf8'), before);
  }
  const requests = relay.state.requests.length;
  for (const [args, env] of [[['--url-scheme', 'PRIVATE_SCHEME'], {}], [[], { SYNCKY_URL_SCHEME: 'PRIVATE_SCHEME' }], [['--link-host', 'PRIVATE_HOST'], {}]]) {
    const result = await runCli(['--home', tmp.home, 'pair', ...args], { env });
    assert.notEqual(result.code, 0); assert.equal(result.stdout, '');
    assert.doesNotMatch(result.stderr, /PRIVATE_/);
  }
  assert.equal(relay.state.requests.length, requests);
});
