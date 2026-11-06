import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { b64uEncode, toHex } from '../../src/encoding.js';
import { createLogger } from '../../src/log.js';
import { createRuntime } from '../../src/runtime.js';
import { createPairingService } from '../../src/pairing.js';
import { loadSecrets } from '../../src/secrets.js';
import { loadVectors } from '../../src/protocol-files.js';
import { createFakePhone } from '../support/fake-phone.js';
import { startRelayDouble } from '../support/relay-double.js';
import { runCli, tempHome } from '../support/helpers.js';

function absent(text, needles, channel) { for (const needle of needles) assert.ok(!text.includes(needle), `private fixture leaked into ${channel}`); }

test('credentials, CEKs, all Health kinds and inner bodies stay out of logs/status/receipts and ciphertext files', async t => {
  const tmp = tempHome(), relay = await startRelayDouble({ invite:'private-log-invite' });
  t.after(async () => { await relay.stop(); tmp.cleanup(); });
  const initialized = await runCli(['--home',tmp.home,'init','--name','Lab','--relay',relay.url,'--log-level','debug'], { env:{ SYNCKY_INVITE:'private-log-invite' } });
  assert.equal(initialized.code, 0);
  const secrets = loadSecrets(tmp.home), logs = [initialized.stdout, initialized.stderr], ceks = [];
  let at = Date.now(); const now = () => new Date(at);
  const runtime = createRuntime({ home:tmp.home, env:{}, now, logger:createLogger({ level:'debug', sink:s => logs.push(s) }) });
  const pairing = createPairingService({ home:tmp.home, relay:runtime.relay, publicKey:secrets.public_key, agentName:'Lab', now });
  const pair = await pairing.startPairing();
  const phone = createFakePhone({ relayUrl:relay.url, random:n => { const bytes = crypto.getRandomValues(new Uint8Array(n)); if (n === 32) ceks.push(bytes); return bytes; } });
  await phone.pair(pair.uri); await pairing.refreshPairing(pair.pairing_id);
  const samples = loadVectors('series-parts').cases.flatMap(c => c.parts);
  const raw = JSON.stringify({ type:'sync', samples, more:false, private:'INNER_CANARY', diagnostics_ref:'DIAGNOSTICS_CANARY' });
  await phone.postEnvelope(await phone.seal(raw)); await runtime.poller.once();
  await phone.sendPairProof(); at += 300000; await runtime.poller.once(); await runtime.outbox.flush();
  const receipt = await runtime.send({ type:'future', inner:{ type:'future', private:'SEND_CANARY' } });
  const params = new URL(pair.uri).searchParams;
  for (const key of ['t', 'c']) assert.ok(params.get(key), `pairing URI lacks ${key} credential`);
  const credentials = ['private-log-invite', secrets.token, secrets.private_key, toHex(secrets.privateKeyBytes), secrets.webhook_secret, params.get('t'), params.get('c'), ...ceks.flatMap(b => [b64uEncode(b),toHex(b)])].filter(Boolean);
  const health = ['INNER_CANARY','SEND_CANARY','DIAGNOSTICS_CANARY','"samples"','"points"','"beats"', ...samples.map(s => s.uuid)];
  absent(logs.join('\n') + JSON.stringify(runtime.status()) + JSON.stringify(receipt), [...credentials, ...health, pair.uri, pair.code], 'operational output');
  for (const folder of ['outbox','held']) for (const name of fs.readdirSync(join(tmp.home,folder))) absent(fs.readFileSync(join(tmp.home,folder,name),'utf8'), [...credentials, ...health], folder);
  for (const name of fs.readdirSync(join(tmp.home,'inbox'))) absent(fs.readFileSync(join(tmp.home,'inbox',name),'utf8'), credentials, 'inbox credentials');
  assert.ok(runtime.inbox({ limit:100 }).records.some(r => r.inner.private === 'INNER_CANARY'));
  assert.equal(fs.existsSync(join(tmp.home,'agent.db')), false);
});
