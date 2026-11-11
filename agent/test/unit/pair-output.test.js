import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import qrcode from 'qrcode-terminal';
import QRErrorCorrectLevel from 'qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel.js';
import { saveConfig } from '../../src/config.js';
import { pairCode } from '../../src/pair-code.js';
import { parsePairUri } from '../../src/pair-uri.js';
import { readPairingFile } from '../../src/pairing.js';
import { acquireHomeLock } from '../../src/protected-files.js';
import { startRelayDouble } from '../support/relay-double.js';
import { runCli, tempHome } from '../support/helpers.js';

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
        assert.ok(result.stdout === `${uri}\n${qr}Pairing code: ${pairCode(pairing.pair_secret)}\n`, 'QR differs from printed link');
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
    assert.equal(result.code, 0);
    const uri = JSON.parse(result.stdout).uri;
    assert.equal(new URL(uri).origin, `https://${site}`);
    assert.equal(parsePairUri(uri, { allowInsecureRelay: true }).value.relayBase, flagRelay ?? envRelay ?? relay.url);
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
