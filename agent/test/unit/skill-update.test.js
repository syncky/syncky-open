import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import fs from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { build } from 'esbuild';
import { createSkillUpdater } from '../../src/skill-update.js';
import { MAX_ENVELOPE_BYTES, skillTrustForTests } from '../../src/skill-document.js';
import { createGenericSender } from '../../src/send.js';
import { createOutbox } from '../../src/outbox.js';
import { createThinPoller } from '../../src/thin-poller.js';
import { createInbox } from '../../src/inbox.js';
import { readHomeState, updateHomeState } from '../../src/home-state.js';
import { delivery, now, self, setup } from '../support/thin-transport.js';
import { diskFailure, fixture } from '../support/thin-home.js';
import { proveSkillExtension, receiverClock } from '../support/skill-extension.js';
import { waitFor } from '../support/helpers.js';

test('unlisted encrypted feature extends through a signed schema and skill only', { timeout: 60000 }, proveSkillExtension);

test('gated receiver clock drains long poll and Retry-After waits then parks', async t => {
  for (const field of ['next_poll_at', 'poll_retry_at', 'retry_after_until']) {
    const { home, transport } = setup(t), clock = receiverClock();
    let polls = 0;
    const relay = { getMessages: async () => {
      if (++polls === 2) throw Object.assign(new Error('fixture retry'), { status: 429, retryAfterS: 3.5 });
      return { messages: [] };
    } };
    const receiver = createThinPoller({ home, transport, self, relay, ...clock }).start();
    try {
      await waitFor(() => readHomeState(home).transport.last_poll_at);
      const at = clock.now().getTime();
      updateHomeState(home, s => { s.transport[field] = at + 3500; });
      await clock.poll();
      assert.equal(polls, 3);
      assert.equal(clock.now().getTime(), at + 7000);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(polls, 3);
      await clock.poll();
      assert.equal(polls, 4);
      assert.equal(clock.now().getTime(), at + 7020);
    } finally { await receiver.stop(); }
  }
});

const bootstrap = fs.readFileSync(new URL('../../skills/syncky/bootstrap.json', import.meta.url));
const initial = JSON.parse(Buffer.from(JSON.parse(bootstrap).payload, 'base64'));
const encode = value => Buffer.from(JSON.stringify(value));
const FEED_URL = 'https://dev.syncky.app/agent-skill.json';
const hint = (version = initial.skill_version + 1, url = FEED_URL) => ({ skill_update: { skill_version: version, url, whats_new: 'UNTRUSTED_HINT <script>run()</script>\u001b[2J' } });
function signedFixture(t) {
  const home = fixture(t), pair = generateKeyPairSync('ed25519');
  const trust = skillTrustForTests(Buffer.from(pair.publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64'));
  const envelope = bytes => encode({ payload: bytes.toString('base64'), signature: sign(null, bytes, pair.privateKey).toString('base64') });
  const doc = version => ({ ...initial, skill_version: version ?? initial.skill_version + 1, skill: '# Updated\n', whats_new: 'Verified changes' });
  return { home, trust, envelope, doc, feed: version => envelope(encode(doc(version))) };
}
const check = (worker, state, code) => {
  assert.equal(worker.status().state, state);
  if (code) assert.equal(worker.status().code, code);
};

test('empty pin serves only package bootstrap offline and refuses before fetch', async t => {
  const home = fixture(t); let fetches = 0;
  const worker = createSkillUpdater({ home, fetch: async () => { fetches++; assert.fail('empty pin'); } });
  assert.deepEqual(worker.read().envelopeBytes, bootstrap);
  assert.equal(worker.read().document.skill, initial.skill);
  worker.observeHeartbeat(hint());
  assert.equal((await worker.tick()).code, 'skill_key_unset');
  assert.equal(fetches, 0); check(worker, 'failed', 'skill_key_unset');
  fs.writeFileSync(join(home, 'installed-bundle.json'), bootstrap, { mode: 0o600 });
  const recovered = createSkillUpdater({ home });
  assert.deepEqual(recovered.read().envelopeBytes, bootstrap);
  check(recovered, 'bootstrap', 'skill_state_invalid');
});

test('a package bootstrap v3 supersedes installed signed v2 without blocking transport', async t => {
  const f = signedFixture(t), { home, transport } = setup(t);
  f.home = home;
  const old = createSkillUpdater({ ...f, fetch: async () => new Response(f.feed()) });
  old.observeHeartbeat(hint()); assert.equal((await old.tick()).state, 'applied');
  const doc = f.doc(initial.skill_version + 2), upgraded = f.envelope(encode(doc));
  const outfile = join(home, 'upgraded-package.mjs');
  await build({ entryPoints: [fileURLToPath(new URL('../../src/skill-update.js', import.meta.url))], outfile,
    bundle: true, platform: 'node', format: 'esm',
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
    plugins: [{ name: 'package-bootstrap', setup(builder) {
      builder.onLoad({ filter: /[/\\]embedded-skill\.js$/ }, () => ({ contents: `export const bootstrapBase64 = ${JSON.stringify(upgraded.toString('base64'))};` }));
    } }],
  });
  const { createSkillUpdater: upgradedUpdater } = await import(pathToFileURL(outfile));
  const worker = upgradedUpdater({ home });
  assert.equal(worker.status().state, 'bootstrap'); assert.equal(worker.status().code, null);
  assert.equal(worker.status().high_water, doc.skill_version);
  assert.deepEqual(worker.read().envelopeBytes, upgraded);
  const message = await delivery(transport, 1), acks = [], sent = [];
  const relay = { getMessages: async () => ({ messages: [message], next_after: 1 }), ack: async seq => { acks.push(seq); },
    postMessage: async body => { sent.push(body); return { seq: 2 }; } };
  await createGenericSender({ home, transport, self, now })({ type: 'future', innerText: '{"type":"future"}' });
  await createThinPoller({ home, transport, self, relay, now, outbox: createOutbox({ home, relay, now }) }).once();
  assert.equal(createInbox(home).read().length, 1); assert.deepEqual(acks, [1]); assert.equal(sent.length, 1);
});

test('exact bundle, high-water and previous bytes activate together and survive restart', async t => {
  const f = signedFixture(t), payload = Buffer.from(` \n${JSON.stringify(f.doc(), null, 2)}\n`), feed = f.envelope(payload);
  let calls = 0;
  const options = { ...f, fetch: async (url, init) => {
    calls++; assert.equal(url, FEED_URL); assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit');
    assert.deepEqual(init.headers, { Accept: 'application/json' });
    return new Response(feed);
  } };
  const worker = createSkillUpdater(options);
  worker.observeHeartbeat({ ...hint(), protocol_incompatible: { minimum_protocol_version: 2, text: 'UNTRUSTED_HINT' } });
  assert.equal((await worker.tick()).state, 'applied');
  assert.deepEqual(worker.read().payloadBytes, payload);
  assert.deepEqual(worker.read().envelopeBytes, feed);
  assert.deepEqual(worker.read().previous.envelopeBytes, bootstrap);
  assert.equal(worker.read().document.whats_new, 'Verified changes');
  const restarted = createSkillUpdater(options);
  assert.deepEqual(restarted.read().payloadBytes, payload);
  assert.deepEqual(restarted.read().previous.envelopeBytes, bootstrap);
  assert.equal(restarted.status().high_water, initial.skill_version + 1);
  assert.equal(restarted.status().protocol_incompatible.minimum_protocol_version, 2);
  assert.equal((await restarted.tick()).state, 'unchanged');
  assert.equal(calls, 2);
  assert.ok(!JSON.stringify(restarted.status()).includes('UNTRUSTED_HINT'));
  assert.ok(!fs.readFileSync(join(f.home, 'skill-update.json'), 'utf8').includes('UNTRUSTED_HINT'));
  assert.equal(fs.statSync(join(f.home, 'installed-bundle.json')).mode & 0o777, 0o600);
});

test('corrupt update metadata preserves a valid signed bundle and recovers on heartbeat', async t => {
  const f = signedFixture(t), options = { ...f, fetch: async () => new Response(f.feed()) };
  const worker = createSkillUpdater(options); worker.observeHeartbeat(hint()); await worker.tick();
  const before = worker.read().envelopeBytes;
  fs.writeFileSync(join(f.home, 'skill-update.json'), '{BROKEN_PRIVATE_CANARY', { mode: 0o600 });
  const restarted = createSkillUpdater(options);
  check(restarted, 'failed', 'skill_state_invalid');
  assert.deepEqual(restarted.read().envelopeBytes, before);
  assert.equal(restarted.status().high_water, initial.skill_version + 1);
  restarted.observeHeartbeat(hint());
  assert.equal((await restarted.tick()).state, 'unchanged');
  assert.equal(restarted.status().code, null);
});

for (const variant of ['wrong-key', 'tamper', 'downgrade', 'equal-conflict', 'version-mismatch']) test(`${variant} never changes active or previous bytes`, async t => {
  const f = signedFixture(t); let feed = f.feed(), at = 0;
  const options = { ...f, now: () => at, fetch: async () => new Response(feed) };
  const worker = createSkillUpdater(options); worker.observeHeartbeat(hint()); await worker.tick();
  const before = fs.readFileSync(join(f.home, 'installed-bundle.json'));
  let version = initial.skill_version + 2;
  if (variant === 'wrong-key') feed = signedFixture(t).feed(version);
  if (variant === 'tamper') { const e = JSON.parse(f.feed(version)); e.payload = Buffer.concat([Buffer.from(e.payload, 'base64'), Buffer.from(' ')]).toString('base64'); feed = encode(e); }
  if (variant === 'downgrade') version = initial.skill_version;
  if (variant === 'equal-conflict') { version--; feed = f.envelope(encode({ ...f.doc(version), skill: '# Conflict' })); }
  if (variant === 'version-mismatch') feed = f.feed(version + 1);
  at++; worker.observeHeartbeat(hint(version));
  const result = await worker.tick();
  assert.equal(result.state, variant === 'downgrade' ? 'stale' : 'failed');
  assert.deepEqual(fs.readFileSync(join(f.home, 'installed-bundle.json')), before);
  assert.equal(createSkillUpdater(options).read().document.skill_version, initial.skill_version + 1);
});

test('equal version requires identical payload bytes and signed high-water rejects stale hints', async t => {
  const f = signedFixture(t); let feed = f.feed(initial.skill_version + 2), calls = 0;
  const worker = createSkillUpdater({ ...f, fetch: async () => { calls++; return new Response(feed); } });
  worker.observeHeartbeat(hint(initial.skill_version + 2));
  assert.equal((await worker.tick()).state, 'applied');
  const previous = worker.read().previous.envelopeBytes;
  feed = Buffer.concat([feed, Buffer.from('\n')]);
  assert.equal((await worker.tick()).state, 'unchanged');
  assert.deepEqual(worker.read().previous.envelopeBytes, previous);
  worker.observeHeartbeat(hint(initial.skill_version));
  assert.equal((await worker.tick()).state, 'stale'); assert.equal(calls, 2);
});

for (const failed of [false, true]) test(`bad high-version hint followed by a good lower hint recovers (${failed ? 'failed' : 'unverified'})`, async t => {
  const f = signedFixture(t), calls = [];
  const worker = createSkillUpdater({ ...f, fetch: async url => {
    calls.push(url); return url.endsWith('/bad.json') ? new Response(null, { status: 404 }) : new Response(f.feed());
  } });
  worker.observeHeartbeat(hint(initial.skill_version + 30, 'https://dev.syncky.app/bad.json'));
  if (failed) assert.equal((await worker.tick()).state, 'failed');
  worker.observeHeartbeat(hint());
  assert.equal(worker.status().attempts, 0); assert.equal(worker.status().hint_version, initial.skill_version + 1);
  assert.equal((await worker.tick()).state, 'applied');
  assert.equal(calls.at(-1), FEED_URL);
  assert.equal(createSkillUpdater(f).status().high_water, initial.skill_version + 1);
});

test('equal-version whitespace conflicts are rejected; a second activation retains the exact previous signed feed', async t => {
  const f = signedFixture(t); let feed = f.feed(), at = 0;
  const worker = createSkillUpdater({ ...f, now: () => at, fetch: async () => new Response(feed) });
  worker.observeHeartbeat(hint()); await worker.tick();
  const first = worker.read();
  feed = f.envelope(Buffer.concat([first.payloadBytes, Buffer.from(' ')]));
  assert.equal((await worker.tick()).code, 'skill_version_conflict');
  assert.deepEqual(worker.read().envelopeBytes, first.envelopeBytes);
  at++; feed = f.feed(initial.skill_version + 2); worker.observeHeartbeat(hint(initial.skill_version + 2));
  assert.equal((await worker.tick()).state, 'applied');
  const restarted = createSkillUpdater(f);
  assert.deepEqual(restarted.read().previous.envelopeBytes, first.envelopeBytes);
  assert.deepEqual(restarted.read().previous.payloadBytes, first.payloadBytes);
  assert.equal(restarted.status().high_water, initial.skill_version + 2);
});

test('retries are bounded across restart and each daily hint resets the budget', async t => {
  const f = signedFixture(t); let at = 0, calls = 0;
  const options = { ...f, now: () => at, maxAttempts: 3, fetch: async () => { calls++; throw new Error('PRIVATE_FAILURE'); } };
  let worker = createSkillUpdater(options); worker.observeHeartbeat(hint());
  for (let n = 1; n <= 3; n++) {
    assert.equal((await worker.tick()).state, 'failed');
    assert.equal(worker.status().attempts, n);
    assert.equal((await worker.tick()).state, 'backoff');
    at = worker.status().next_attempt_at; worker = createSkillUpdater(options);
  }
  at += 86400000; worker.observeHeartbeat(hint());
  assert.equal((await worker.tick()).state, 'failed'); assert.equal(calls, 4);
  worker.observeHeartbeat(hint(initial.skill_version + 2));
  assert.equal((await worker.tick()).state, 'failed'); assert.equal(calls, 5);
});

test('404 then publication retries the unchanged hint after the next daily heartbeat', async t => {
  const f = signedFixture(t); let at = 0, published = false, calls = 0;
  const options = { ...f, now: () => at, fetch: async () => {
    calls++; return published ? new Response(f.feed()) : new Response(null, { status: 404 });
  } };
  let worker = createSkillUpdater(options); worker.observeHeartbeat(hint());
  for (let n = 1; n <= 5; n++) {
    assert.equal((await worker.tick()).code, 'skill_response_invalid');
    at = worker.status().next_attempt_at;
  }
  published = true; at += 86400000; worker = createSkillUpdater(options);
  assert.equal((await worker.tick()).state, 'backoff'); assert.equal(calls, 5);
  worker.observeHeartbeat(hint());
  assert.equal((await worker.tick()).state, 'applied'); assert.equal(calls, 6);
  assert.equal(worker.status().code, null);
});

test('an identical retry clears cached failure metadata without replacing previous bytes', async t => {
  const f = signedFixture(t); let feed = f.feed(), at = 0;
  const worker = createSkillUpdater({ ...f, now: () => at, fetch: async () => new Response(feed) });
  worker.observeHeartbeat(hint()); await worker.tick();
  const previous = worker.read().previous.envelopeBytes;
  feed = Buffer.from('invalid'); assert.equal((await worker.tick()).state, 'failed');
  at = worker.status().next_attempt_at; feed = f.feed();
  assert.equal((await worker.tick()).state, 'unchanged');
  check(worker, 'unchanged'); assert.equal(worker.status().code, null); assert.equal(worker.status().attempts, 0);
  assert.deepEqual(worker.read().previous.envelopeBytes, previous);
});

test('malformed hints and invalid pins neither fetch nor become authoritative status text', async t => {
  const f = signedFixture(t); let calls = 0;
  const worker = createSkillUpdater({ ...f, trust: skillTrustForTests('PRIVATE_BAD_PIN'), fetch: async () => { calls++; assert.fail(); } });
  for (const reply of [undefined, null, [], 'PRIVATE_HINT', { skill_update: { skill_version: '2', url: FEED_URL } }, { protocol_incompatible: { minimum_protocol_version: 'PRIVATE_HINT' } }]) worker.observeHeartbeat(reply);
  assert.equal((await worker.tick()).state, 'idle');
  worker.observeHeartbeat(hint()); assert.equal((await worker.tick()).code, 'skill_key_invalid');
  assert.equal(calls, 0); assert.ok(!JSON.stringify(worker.status()).includes('PRIVATE'));
});

for (const url of ['\0'.repeat(2048), `https://syncky.app/${'\0'.repeat(2029)}`, `https://syncky.app/${'\ud800'.repeat(2029)}`]) test('invalid escaped hint URLs cannot poison cached status or restart', async t => {
  const f = signedFixture(t); let calls = 0;
  const options = { ...f, fetch: async () => { calls++; assert.fail('invalid URL'); } };
  const worker = createSkillUpdater(options);
  assert.doesNotThrow(() => worker.observeHeartbeat(hint(undefined, url)));
  assert.ok(fs.statSync(join(f.home, 'skill-update.json')).size <= 8192);
  assert.equal(worker.status().hint_version, initial.skill_version + 1);
  const restarted = createSkillUpdater(options);
  assert.equal((await restarted.tick()).code, 'skill_url_invalid');
  assert.equal(calls, 0);
  check(createSkillUpdater(options), 'failed', 'skill_url_invalid');
});

test('maximum-length Unicode hint URL remains within the serialized cache limit', t => {
  const f = signedFixture(t), worker = createSkillUpdater(f);
  const url = `https://syncky.app/${'中'.repeat(2029)}`;
  assert.equal(url.length, 2048);
  worker.observeHeartbeat(hint(undefined, url));
  assert.ok(fs.statSync(join(f.home, 'skill-update.json')).size <= 8192);
  assert.equal(createSkillUpdater(f).status().hint_version, initial.skill_version + 1);
});

for (const [name, reply] of [['204', undefined], ['omitted field', {}], ['skill hint only', hint()], ['explicit null', { protocol_incompatible: null }]]) test(`${name} heartbeat clears withdrawn protocol advice across restart`, async t => {
  const f = signedFixture(t), worker = createSkillUpdater({ ...f, fetch: async () => { throw new Error('offline'); } });
  worker.observeHeartbeat({ ...hint(), protocol_incompatible: { minimum_protocol_version: 2 } });
  assert.equal((await worker.tick()).state, 'failed');
  const before = worker.status();
  assert.deepEqual(before.protocol_incompatible, { minimum_protocol_version: 2 });
  worker.observeHeartbeat(reply);
  const expected = { ...before, protocol_incompatible: null };
  if (reply?.skill_update) Object.assign(expected, { attempts: 0, next_attempt_at: 0, code: null, state: 'available' });
  assert.deepEqual(worker.status(), expected);
  assert.deepEqual(createSkillUpdater(f).status(), expected);
});

for (const url of ['http://syncky.app/agent-skill.json', 'https://syncky.app.evil.test/a', 'https://evil.test/syncky.app', 'https://user:pass@syncky.app/a',
  'https://syncky.app:444/a', 'https://syncky.app:0443/a', 'https://syncky.app./a', 'https://%73yncky.app/a', 'https://syncky.app\\@evil.test/a',
  ' https://syncky.app/a', 'https://syncky.app/a\n', 'https://syncky.app/a#fragment', '//syncky.app/a', 'file:///a']) test('rejects unsafe URL before fetch', async t => {
  const f = signedFixture(t); let calls = 0;
  const worker = createSkillUpdater({ ...f, fetch: async () => { calls++; return new Response(f.feed()); } });
  worker.observeHeartbeat(hint(undefined, url));
  assert.equal((await worker.tick()).code, 'skill_url_invalid'); assert.equal(calls, 0);
  assert.deepEqual(worker.read().envelopeBytes, bootstrap);
});

for (const url of ['https://syncky.app/agent-skill.json', 'https://dev.syncky.app:443/agent-skill.json']) test('accepts pinned HTTPS default-port URLs', async t => {
  const f = signedFixture(t), worker = createSkillUpdater({ ...f, fetch: async () => new Response(f.feed()) });
  worker.observeHeartbeat(hint(undefined, url)); assert.equal((await worker.tick()).state, 'applied');
});

for (const kind of ['redirect', 'redirected', 'oversize-header', 'oversize-stream', 'timeout-fetch', 'timeout-body', 'network', 'http']) test(`${kind} is bounded and preserves interpretation`, async t => {
  const f = signedFixture(t); let cancelled = false, at = 0;
  const fetch = async () => {
    if (kind === 'redirect') return new Response(null, { status: 302, headers: { Location: 'https://evil.test' } });
    if (kind === 'redirected') return { redirected: true, body: null, status: 200, headers: new Headers() };
    if (kind === 'oversize-header') return new Response('x', { headers: { 'Content-Length': String(MAX_ENVELOPE_BYTES + 1) } });
    if (kind === 'timeout-fetch') return new Promise(() => {});
    if (kind === 'network') throw new Error('TOKEN_IN_ERROR https://private.test');
    if (kind === 'http') return new Response('PRIVATE_BODY', { status: 503 });
    return new Response(new ReadableStream({ start(c) { if (kind === 'oversize-stream') c.enqueue(new Uint8Array(MAX_ENVELOPE_BYTES + 1)); }, cancel() { cancelled = true; } }));
  };
  const options = { ...f, fetch, timeoutMs: 20, now: () => at }, worker = createSkillUpdater(options);
  worker.observeHeartbeat(hint()); assert.equal((await worker.tick()).state, 'failed');
  assert.equal((await worker.tick()).state, 'backoff');
  const restarted = createSkillUpdater(options); assert.equal((await restarted.tick()).state, 'backoff');
  assert.deepEqual(worker.read().envelopeBytes, bootstrap);
  assert.ok(!JSON.stringify(worker.status()).includes('TOKEN_IN_ERROR'));
  if (kind === 'oversize-stream' || kind === 'timeout-body') assert.equal(cancelled, true);
});

for (const change of [doc => { const t = JSON.parse(doc.messages); t.aad.base = 'unsupported'; doc.messages = JSON.stringify(t); },
  doc => { doc.protocol.protocol_version = 2; const t = JSON.parse(doc.messages); t.protocol_version = 2; doc.messages = JSON.stringify(t); },
  doc => { doc.schemas = { 'inner-bad.schema.json': '{"type":"unknown"}' }; },
  doc => { doc.schemas = { 'inner-bad.schema.json': '{"$ref":"https://evil.test/schema"}' }; },
  doc => { doc.schemas = { 'inner-bad.schema.json': '{"type":"object","$defs":{"unused":{"$ref":"https://evil.test/schema"}}}' }; },
  doc => { doc.schemas = { 'inner-bad.schema.json': '{"type":"object","$vocabulary":{"https://future.test/vocab":true}}' }; },
  doc => { doc.schemas = { 'inner-bad.schema.json': '{"$schema":"https://future.test/schema","type":"object"}' }; }]) test('unsupported table/schema keeps the last good bundle', async t => {
  const f = signedFixture(t), doc = structuredClone(f.doc()); change(doc);
  const worker = createSkillUpdater({ ...f, fetch: async () => new Response(f.envelope(encode(doc))) });
  worker.observeHeartbeat(hint()); assert.equal((await worker.tick()).code, 'protocol_incompatible');
  assert.deepEqual(worker.read().envelopeBytes, bootstrap);
});

for (const operation of ['writeSync', 'fsyncSync', 'renameSync']) test(`${operation} interrupted activation preserves active, previous and high-water across restart`, async t => {
  const f = signedFixture(t), worker = createSkillUpdater({ ...f, fetch: async () => new Response(f.feed()) });
  worker.observeHeartbeat(hint()); await worker.tick();
  const before = fs.readFileSync(join(f.home, 'installed-bundle.json'));
  const broken = createSkillUpdater({ ...f, fs: diskFailure(operation, 1, /\.installed-bundle\.json\./), fetch: async () => new Response(f.feed(initial.skill_version + 2)) });
  broken.observeHeartbeat(hint(initial.skill_version + 2)); assert.equal((await broken.tick()).state, 'failed');
  assert.deepEqual(fs.readFileSync(join(f.home, 'installed-bundle.json')), before);
  assert.equal(createSkillUpdater(f).status().high_water, initial.skill_version + 1);
  assert.ok(!fs.readdirSync(f.home).some(name => name.endsWith('.tmp')));
});

test('directory fsync failure after rename leaves one complete valid activation across restart', async t => {
  const f = signedFixture(t), feed = f.feed(); let armed = false;
  const io = new Proxy(fs, { get(target, key) {
    if (key === 'renameSync') return (from, to) => { target.renameSync(from, to); if (to === join(f.home, 'installed-bundle.json')) armed = true; };
    if (key === 'fsyncSync') return fd => { if (armed) { armed = false; throw Object.assign(new Error('disk failure'), { code: 'ENOSPC' }); } return target.fsyncSync(fd); };
    return target[key];
  } });
  const worker = createSkillUpdater({ ...f, fs: io, fetch: async () => new Response(feed) });
  worker.observeHeartbeat(hint()); assert.equal((await worker.tick()).code, 'skill_write_failed');
  const restarted = createSkillUpdater(f);
  assert.deepEqual(restarted.read().envelopeBytes, feed);
  assert.deepEqual(restarted.read().previous.envelopeBytes, bootstrap);
  assert.equal(restarted.status().high_water, initial.skill_version + 1);
});

test('protected installed files fall back on symlinks and corruption without trusting home bootstrap bytes', async t => {
  const f = signedFixture(t), worker = createSkillUpdater({ ...f, fetch: async () => new Response(f.feed()) });
  worker.observeHeartbeat(hint()); await worker.tick();
  const installed = join(f.home, 'installed-bundle.json'), saved = join(f.home, 'saved.json');
  fs.renameSync(installed, saved); fs.symlinkSync(saved, installed);
  check(createSkillUpdater(f), 'bootstrap', 'skill_state_invalid');
  assert.deepEqual(createSkillUpdater(f).read().envelopeBytes, bootstrap);
  fs.unlinkSync(installed); fs.writeFileSync(installed, '{"schema":1}', { mode: 0o600 });
  check(createSkillUpdater(f), 'bootstrap', 'skill_state_invalid');
  assert.deepEqual(createSkillUpdater(f).read().envelopeBytes, bootstrap);
});

test('a late older fetch cannot overwrite a newer atomic activation', async t => {
  const f = signedFixture(t); let finish, reached;
  const started = new Promise(resolve => { reached = resolve; });
  const old = createSkillUpdater({ ...f, fetch: () => { reached(); return new Promise(resolve => { finish = resolve; }); } });
  old.observeHeartbeat(hint()); const pending = old.tick(); await started;
  const newer = createSkillUpdater({ ...f, fetch: async () => new Response(f.feed(initial.skill_version + 2)) });
  newer.observeHeartbeat(hint(initial.skill_version + 2)); await newer.tick();
  finish(new Response(f.feed())); assert.equal((await pending).code, 'skill_downgrade');
  assert.equal(createSkillUpdater(f).status().high_water, initial.skill_version + 2);
});

test('pending fetch and failure backoff do not block encrypted receive, ACK, generic send or daily heartbeat', async t => {
  const f = signedFixture(t), { home, transport } = setup(t); let at = now().getTime(), beats = 0, finish, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const worker = createSkillUpdater({ ...f, home, now: () => at, maxAttempts: 1, fetch: () => { entered(); return new Promise(resolve => { finish = resolve; }); } });
  worker.observeHeartbeat(hint()); const pending = worker.tick(); await started;
  assert.equal((await worker.tick()).state, 'pending');
  const message = await delivery(transport, 1), sent = [], acks = [];
  const relay = { getMessages: async () => ({ messages: [message], next_after: 1 }), ack: async seq => { acks.push(seq); }, postMessage: async body => { sent.push(body); return { seq: 2 }; } };
  await createGenericSender({ home, transport, self, now })({ type: 'future_send', innerText: '{"type":"future_send"}' });
  const poller = createThinPoller({ home, transport, self, relay, now: () => new Date(at), outbox: createOutbox({ home, relay, now: () => new Date(at) }),
    heartbeat: async () => { beats++; worker.observeHeartbeat(hint()); } });
  await poller.once();
  assert.equal(createInbox(home).read().length, 1); assert.deepEqual(acks, [1]); assert.equal(sent.length, 1); assert.equal(beats, 1);
  finish(new Response(null, { status: 503 })); await pending;
  assert.equal((await worker.tick()).state, 'backoff');
  await createGenericSender({ home, transport, self, now })({ type: 'future_send', innerText: '{"type":"future_send"}' });
  await createOutbox({ home, relay, now: () => new Date(at) }).flush(); assert.equal(sent.length, 2);
  at += 86400000; await poller.once(); assert.equal(beats, 2);
  assert.equal((await worker.tick()).state, 'failed');
  assert.equal(readHomeState(home).transport.acked_seq, 1);
});
