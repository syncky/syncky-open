import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { registerAgent, AGENT_FILES, isInitialized } from '../../src/register.js';
import { loadSecrets } from '../../src/secrets.js';
import { readHomeState } from '../../src/home-state.js';
import { redact } from '../../src/log.js';
import { tempHome, runCli } from '../support/helpers.js';
import { startRelayDouble } from '../support/relay-double.js';

const invite = 'register-private-invite';
async function fixture(t) {
  const tmp = tempHome(), relay = await startRelayDouble({ invite });
  t.after(async () => { await relay.stop(); tmp.cleanup(); });
  return { ...tmp, relay, init: (args = [], env = {}) => runCli(['--home', tmp.home, 'init', '--name', 'Lab agent', '--relay', relay.url, ...args], { env: { SYNCKY_INVITE: invite, ...env } }) };
}

test('registration writes protected file identity and no database; all credentials stay private', async t => {
  const { home, relay, init } = await fixture(t);
  const result = await init(); assert.equal(result.code, 0);
  const out = JSON.parse(result.stdout), secrets = loadSecrets(home), state = readHomeState(home);
  assert.equal(out.hub_id, state.identity.hub_id); assert.equal(state.identity.public_key, secrets.public_key);
  assert.equal(relay.state.member(out.member_id, out.hub_id).publicKey, secrets.public_key);
  assert.equal(fs.statSync(home).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(home).sort(), ['config.json', 'secrets.json', 'state.json']);
  for (const f of fs.readdirSync(home)) assert.equal(fs.statSync(join(home, f)).mode & 0o777, 0o600);
  for (const secret of [invite, secrets.token, secrets.private_key, secrets.webhook_secret]) {
    assert.ok(!result.stdout.includes(secret) && !result.stderr.includes(secret));
    assert.ok(!redact(secret).includes(secret));
    if (secret === invite) for (const f of fs.readdirSync(home)) assert.ok(!fs.readFileSync(join(home, f), 'utf8').includes(secret));
  }
});

test('init refuses every initialized/legacy artifact without touching it or registering', async t => {
  const { home, relay } = await fixture(t); fs.mkdirSync(home, { mode: 0o700 });
  for (const f of AGENT_FILES) {
    fs.writeFileSync(join(home, f), 'retained', { mode: 0o600 }); assert.equal(isInitialized(home), true);
    await assert.rejects(registerAgent({ home, relayUrl: relay.url, name: 'Lab', invite }), { code: 'already_initialized' });
    assert.equal(fs.readFileSync(join(home, f), 'utf8'), 'retained'); fs.unlinkSync(join(home, f));
  }
  assert.equal(relay.state.requests.length, 0);
});

for (const scheme of ['syncky', 'syncky-dev', 'syncky-staging']) test(`init preserves explicit ${scheme} scheme`, async t => {
  const { home, init } = await fixture(t); assert.equal((await init(['--url-scheme', scheme])).code, 0);
  assert.equal(JSON.parse(fs.readFileSync(join(home, 'config.json'))).url_scheme, scheme);
});

test('invalid scheme and insecure home fail before any relay operation', async t => {
  const { home, relay, init } = await fixture(t);
  assert.equal((await init(['--url-scheme', 'https://PRIVATE'])).code, 4);
  fs.mkdirSync(home, { mode: 0o755 }); fs.writeFileSync(join(home, 'notes'), 'retain');
  assert.equal((await init()).code, 4); assert.equal(relay.state.requests.length, 0);
});

for (const bad of [{ hub_id: 'bad' }, { member_id: 'bad' }, { webhook_secret: 'bad' }, { token: 'bad' }]) test(`malformed registration identity is refused: ${Object.keys(bad)[0]}`, async t => {
  const { home, relay } = await fixture(t);
  await assert.rejects(registerAgent({ home, relayUrl: relay.url, name: 'Lab', invite, fetch: async (url, init) => {
    const res = await fetch(url, init); return Response.json({ ...await res.json(), ...bad }, { status: 201 });
  } }), { code: 'invalid_response' });
  assert.equal(fs.existsSync(join(home, 'state.json')), false);
});

test('wrong invite and authoritative Retry-After retain no credentials; bounded retry succeeds', async t => {
  const { home, relay, init } = await fixture(t);
  assert.equal((await init([], { SYNCKY_INVITE: 'PRIVATE_WRONG' })).code, 2);
  assert.equal(fs.existsSync(join(home, 'secrets.json')), false);
  relay.failNext('E1', 429, { 'Retry-After': '2' });
  const result = await init(); assert.equal(result.code, 0); assert.deepEqual(result.sleeps, [2000]);
  const before = fs.readFileSync(join(home, 'secrets.json'));
  assert.equal((await init()).code, 4); assert.equal((await init(['--force'])).code, 1);
  assert.deepEqual(fs.readFileSync(join(home, 'secrets.json')), before);
});
