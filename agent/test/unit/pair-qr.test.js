import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { saveConfig } from '../../src/config.js';
import { createHomeState, readHomeState } from '../../src/home-state.js';
import { saveSecrets } from '../../src/secrets.js';
import { createPairingService, readPairingFile } from '../../src/pairing.js';
import { cleanupPairingQr, createPairingQrFiles, pairingQr, qrPng, qrSvg, renderTerminalQr } from '../../src/pair-qr.js';
import { buildPairUri } from '../../src/pair-uri.js';
import { createLogger } from '../../src/log.js';
import { acquireHomeLock } from '../../src/protected-files.js';
import { identity, keys } from '../support/thin-home.js';
import { runCli, tempHome } from '../support/helpers.js';

const uri = buildPairUri({ relayBase: 'https://relay.syncky.app', hubId: identity.hub_id, pairingToken: `pt_${'T'.repeat(43)}`, agentPublicKey: keys.agent.pk, agentName: 'My agent', pairSecret: 'A'.repeat(22) });

function fixture(t) {
  const tmp = tempHome(), home = tmp.home;
  fs.mkdirSync(home, { mode: 0o700 }); createHomeState(home, identity);
  saveSecrets(home, { private_key: keys.agent.sk, public_key: keys.agent.pk, token: `sk_${identity.hub_id}_${'T'.repeat(40)}`, webhook_secret: `whsec_${'W'.repeat(43)}` });
  saveConfig(home, { relay_url: 'https://relay.syncky.app', name: 'My agent' });
  let at = Date.parse('2026-11-16T10:00:00Z'), count = 0;
  const now = () => new Date(at), advance = ms => { at += ms; };
  const fetch = async (_url, opts) => Response.json(opts.method === 'POST' ? { pairing_id: `p_${String(++count).padStart(22, 'A')}`, pairing_token: `pt_${'T'.repeat(43)}`, expires_at: new Date(at + 600000).toISOString() } : { status: 'pending' });
  const receiver = acquireHomeLock(home, 'receiver');
  t.after(() => { receiver.release(); tmp.cleanup(); });
  const cli = (args, options) => runCli(['--home', home, ...args], { fetch, now, spawn: () => assert.fail('unexpected waiter'), ...options });
  const service = createPairingService({ home, relay: { baseUrl: 'https://relay.syncky.app', createPairing: async () => (await fetch('', { method: 'POST' })).json(), getPairing: async () => ({ status: 'expired' }) }, publicKey: keys.agent.pk, agentName: 'My agent', now });
  return { ...tmp, cli, service, advance, now, receiver };
}

function crc(bytes) {
  const table = Array.from({ length: 256 }, (_, n) => {
    for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
    return n >>> 0;
  });
  return (bytes.reduce((n, b) => table[(n ^ b) & 255] ^ (n >>> 8), 0xffffffff) ^ 0xffffffff) >>> 0;
}

test('PNG chunks, CRCs, grayscale pixels and SVG modules encode exactly the URI matrix with a quiet zone', () => {
  const matrix = pairingQr(uri), png = qrPng(matrix), chunks = [];
  assert.deepEqual(png.subarray(0, 8), Buffer.from([137,80,78,71,13,10,26,10]));
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset), type = png.toString('ascii', offset + 4, offset + 8), data = png.subarray(offset + 8, offset + 8 + length);
    assert.equal(png.readUInt32BE(offset + 8 + length), crc(png.subarray(offset + 4, offset + 8 + length)));
    chunks.push({ type, data }); offset += length + 12;
    assert.ok(offset <= png.length);
  }
  assert.deepEqual(chunks.map(c => c.type), ['IHDR', 'IDAT', 'IEND']);
  const size = (matrix.length + 8) * 8, header = chunks[0].data, pixels = inflateSync(chunks[1].data);
  assert.equal(header.readUInt32BE(0), size); assert.equal(header.readUInt32BE(4), size);
  assert.deepEqual([...header.subarray(8)], [8,0,0,0,0]); assert.equal(pixels.length, size * (size + 1));
  for (let y = 0; y < size; y++) {
    assert.equal(pixels[y * (size + 1)], 0);
    for (let x = 0; x < size; x++) assert.equal(pixels[y * (size + 1) + x + 1], matrix[Math.floor(y / 8) - 4]?.[Math.floor(x / 8) - 4] ? 0 : 255);
  }
  const svg = qrSvg(matrix), paths = [...svg.matchAll(/M(\d+) (\d+)h1v1h-1z/g)].map(m => [Number(m[1]) - 4, Number(m[2]) - 4]);
  assert.match(svg, new RegExp(`viewBox="0 0 ${matrix.length + 8} ${matrix.length + 8}"`));
  assert.equal(paths.length, matrix.flat().filter(Boolean).length);
  for (const [x, y] of paths) assert.equal(matrix[y][x], true);
  assert.ok(!svg.includes(uri));
});

const imageDoc = { uri, pairing_id: `p_${'A'.repeat(22)}` };
const imagePath = (home, doc = imageDoc, format = 'png') => join(home, 'pairing-qr', `${doc.pairing_id}.${format}`);

for (const kind of ['file', 'symlink', 'dangling', 'directory']) test(`exclusive image creation refuses an existing ${kind} without clobbering`, t => {
  const f = fixture(t), directory = join(f.home, 'pairing-qr'), target = join(f.home, 'target');
  fs.mkdirSync(directory, { mode: 0o700 }); fs.writeFileSync(target, 'keep', { mode: 0o600 });
  const path = imagePath(f.home);
  if (kind === 'file') fs.writeFileSync(path, 'original', { mode: 0o600 });
  if (kind === 'symlink') fs.symlinkSync(target, path);
  if (kind === 'dangling') fs.symlinkSync(join(f.home, 'absent'), path);
  if (kind === 'directory') fs.mkdirSync(path);
  assert.throws(() => createPairingQrFiles(f.home, imageDoc, { qrPng: true }), { code: 'invalid_input' });
  assert.equal(fs.readFileSync(target, 'utf8'), 'keep'); assert.equal(fs.existsSync(join(f.home, 'absent')), false);
  if (kind === 'file') assert.equal(fs.readFileSync(path, 'utf8'), 'original');
  if (kind === 'symlink' || kind === 'dangling') assert.ok(fs.lstatSync(path).isSymbolicLink());
  if (kind === 'directory') assert.ok(fs.lstatSync(path).isDirectory());
});

test('images use fixed private paths, exclusive no-follow opens, full writes and fsync; partial failure removes only new files', t => {
  const f = fixture(t), png = imagePath(f.home), svg = imagePath(f.home, imageDoc, 'svg'), synced = [], opens = [];
  const injected = { ...fs,
    openSync: (path, flags, mode) => { opens.push({ path, flags, mode }); return fs.openSync(path, flags, mode); },
    writeSync: (fd, bytes, offset, length) => fs.writeSync(fd, bytes, offset, Math.min(length, 31)),
    fsyncSync: fd => { synced.push(fs.fstatSync(fd).ino); fs.fsyncSync(fd); },
  };
  assert.deepEqual(createPairingQrFiles(f.home, imageDoc, { qrPng: true, qrSvg: true }, { fs: injected }), { qr_png: png, qr_svg: svg });
  assert.equal(fs.statSync(join(f.home, 'pairing-qr')).mode & 0o7777, 0o700);
  for (const path of [png, svg]) {
    const stat = fs.statSync(path), opened = opens.find(row => row.path === path);
    assert.equal(stat.mode & 0o7777, 0o600); assert.ok(synced.includes(stat.ino));
    assert.equal(opened.mode, 0o600);
    assert.equal(opened.flags & (fs.constants.O_EXCL | fs.constants.O_NOFOLLOW), fs.constants.O_EXCL | fs.constants.O_NOFOLLOW);
  }
  assert.deepEqual(fs.readFileSync(png), qrPng(pairingQr(uri))); assert.equal(fs.readFileSync(svg, 'utf8'), qrSvg(pairingQr(uri)));
  fs.unlinkSync(png); fs.writeFileSync(svg, 'keep');
  assert.throws(() => createPairingQrFiles(f.home, imageDoc, { qrPng: true, qrSvg: true }), { code: 'invalid_input' });
  assert.equal(fs.existsSync(png), false); assert.equal(fs.readFileSync(svg, 'utf8'), 'keep');
  assert.throws(() => createPairingQrFiles(f.home, { ...imageDoc, pairing_id: '../state.json' }, { qrPng: true }), { code: 'invalid_input' });
  assert.throws(() => createPairingQrFiles(f.home, imageDoc, { qrPng: join(f.home, 'pairing.json') }), { code: 'invalid_input' });
});

for (const kind of ['mode', 'symlink', 'file']) test(`a ${kind} pairing-qr directory is refused and never traversed by creation or cleanup`, async t => {
  const f = fixture(t), directory = join(f.home, 'pairing-qr'), target = join(f.home, 'target');
  fs.mkdirSync(target, { mode: 0o700 }); fs.writeFileSync(join(target, 'orphan.png'), 'keep');
  if (kind === 'mode') { fs.mkdirSync(directory, { mode: 0o755 }); fs.chmodSync(directory, 0o755); fs.writeFileSync(join(directory, 'orphan.png'), 'keep'); }
  if (kind === 'symlink') fs.symlinkSync(target, directory);
  if (kind === 'file') fs.writeFileSync(directory, 'keep');
  const result = await f.cli(['pair', '--qr-png', '--json']);
  assert.equal(result.code, 4); assert.equal(result.stdout, ''); assert.equal(JSON.parse(result.stderr).error, 'insecure_permissions');
  assert.doesNotThrow(() => cleanupPairingQr(f.home, null));
  assert.equal(fs.readFileSync(join(target, 'orphan.png'), 'utf8'), 'keep');
  if (kind === 'mode') assert.equal(fs.readFileSync(join(directory, 'orphan.png'), 'utf8'), 'keep');
  if (kind === 'file') assert.equal(fs.readFileSync(directory, 'utf8'), 'keep');
});

test('pair and show-qr preserve URI, scope, code and deadline while creating and re-creating private images', async t => {
  const f = fixture(t);
  const result = await f.cli(['pair', '--read', 'body_mass', '--write', 'dietary_water', '--qr-png', '--json']);
  assert.equal(result.code, 0, result.stderr);
  const started = JSON.parse(result.stdout), before = readPairingFile(f.home), state = fs.readFileSync(join(f.home, 'state.json'));
  const png = imagePath(f.home, before), svg = imagePath(f.home, before, 'svg');
  assert.equal(started.qr_png, png); assert.equal(started.qr_text, renderTerminalQr(before.uri)); assert.equal(before.qr_files, undefined);
  const shown = await f.cli(['pair', '--show-qr', '--qr-svg', '--json'], { fetch: () => assert.fail('show-qr must be offline') });
  assert.equal(shown.code, 0, shown.stderr);
  assert.deepEqual(JSON.parse(shown.stdout), { ...started, qr_svg: svg });
  assert.deepEqual(readPairingFile(f.home), before); assert.deepEqual(fs.readFileSync(join(f.home, 'state.json')), state);
  for (const path of [png, svg]) assert.equal(fs.statSync(path).mode & 0o777, 0o600);
  fs.unlinkSync(png);
  const human = await f.cli(['pair', '--show-qr', '--qr-png']);
  assert.equal(human.code, 0); assert.deepEqual(fs.readFileSync(png), qrPng(pairingQr(before.uri)));
  assert.ok(human.stdout.startsWith('Pairing link (open on the iPhone with Syncky Health, single use, expires '));
  assert.ok(human.stdout.indexOf(before.uri) < human.stdout.indexOf(started.qr_text));
  assert.ok(human.stdout.indexOf(started.qr_text) < human.stdout.indexOf('Pairing code: ' + started.code));
  assert.ok(human.stdout.includes('Private QR PNG: ' + png + '\n'));
  fs.unlinkSync(svg);
  const humanSvg = await f.cli(['pair', '--show-qr', '--qr-svg', '--no-qr']);
  assert.equal(humanSvg.code, 0); assert.ok(humanSvg.stdout.includes('Private QR SVG: ' + svg + '\n'));
  const noQr = await f.cli(['pair', '--show-qr', '--no-qr', '--json']); assert.deepEqual(JSON.parse(noQr.stdout), { ...started, qr_svg: svg, qr_text: null });
  const plain = await f.cli(['pair', '--show-qr', '--no-qr']); assert.ok(!plain.stdout.includes(started.qr_text));
  for (const flag of ['--v1', '--read', '--write']) {
    const bad = await f.cli(['pair', '--show-qr', flag, ...(flag === '--v1' ? [] : ['body_mass'])]);
    assert.equal(bad.code, 1); assert.equal(bad.stdout, '');
  }
  const clobber = await f.cli(['pair', '--show-qr', '--qr-png']);
  assert.equal(clobber.code, 4); assert.equal(JSON.parse(clobber.stderr).error, 'invalid_input');
  assert.deepEqual(readPairingFile(f.home), before);
});

for (const action of ['show', 'wait', 'waiter', 'receiver', 'refresh', 'replace', 'current']) test(`expired pairing image is removed by ${action}`, async t => {
  const f = fixture(t), started = await f.cli(['pair', '--qr-png', '--json']);
  assert.equal(started.code, 0);
  const png = JSON.parse(started.stdout).qr_png, pending = readPairingFile(f.home); f.advance(600001);
  if (action === 'show' || action === 'wait') {
    const result = await f.cli(action === 'show' ? ['pair', '--show-qr', '--json'] : ['wait']);
    assert.equal(result.code, 4); assert.equal(result.stdout, ''); assert.equal(JSON.parse(result.stderr).error, 'pairing_expired');
  } else if (action === 'replace') assert.equal((await f.cli(['pair', '--json'])).code, 0);
  else if (action === 'refresh') await f.service.refreshPairing(pending.pairing_id);
  else if (action === 'current') assert.equal(f.service.currentPairing(), null);
  else if (action === 'waiter') {
    f.receiver.release();
    f.advance(60000);
    const result = await f.cli(['pair-waiter', pending.pairing_id]); assert.equal(result.code, 0); assert.equal(result.stdout, '');
  } else {
    f.receiver.release();
    const result = await f.cli(['receive', '--once'], { fetch: async (url) => Response.json(new URL(url).pathname.includes('/pairings/') ? { status: 'expired' } : new URL(url).pathname === '/v1/members' ? { members: [] } : { messages: [], has_more: false }) });
    assert.equal(result.code, 0, result.stderr);
  }
  assert.equal(fs.existsSync(png), false);
});

for (const action of ['show', 'pair']) test(`${action} sweeps crash orphans even with no pending pairing`, async t => {
  const f = fixture(t), directory = join(f.home, 'pairing-qr');
  fs.mkdirSync(directory, { mode: 0o700 });
  for (const name of [`${imageDoc.pairing_id}.png`, 'crash-left.tmp']) fs.writeFileSync(join(directory, name), 'private');
  const result = await f.cli(action === 'show' ? ['pair', '--show-qr', '--qr-png'] : ['pair', '--json']);
  assert.equal(result.code, action === 'show' ? 4 : 0);
  if (action === 'show') { assert.equal(result.stdout, ''); assert.equal(JSON.parse(result.stderr).error, 'pairing_expired'); }
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('sweep keeps live PNG/SVG, removes every stale regular file, and ignores symlinks and directories', async t => {
  const f = fixture(t), result = await f.cli(['pair', '--qr-png', '--qr-svg', '--json']); assert.equal(result.code, 0);
  const live = JSON.parse(result.stdout), directory = join(f.home, 'pairing-qr'), target = join(f.home, 'outside');
  const before = [fs.readFileSync(live.qr_png), fs.readFileSync(live.qr_svg)]; fs.writeFileSync(target, 'keep');
  for (const name of [`${imageDoc.pairing_id}.png`, 'crash-left.png', `${live.pairing_id}.tmp`, 'unrelated-file']) fs.writeFileSync(join(directory, name), 'stale');
  fs.symlinkSync(target, join(directory, 'link')); fs.symlinkSync(join(f.home, 'absent'), join(directory, `${imageDoc.pairing_id}.svg`)); fs.mkdirSync(join(directory, 'subdir'));
  const shown = await f.cli(['pair', '--show-qr', '--json']); assert.equal(shown.code, 0);
  assert.deepEqual(fs.readdirSync(directory).sort(), [`${live.pairing_id}.png`, `${live.pairing_id}.svg`, `${imageDoc.pairing_id}.svg`, 'link', 'subdir'].sort());
  assert.deepEqual([fs.readFileSync(live.qr_png), fs.readFileSync(live.qr_svg)], before);
  cleanupPairingQr(f.home, null);
  assert.deepEqual(fs.readdirSync(directory).sort(), [`${imageDoc.pairing_id}.svg`, 'link', 'subdir'].sort());
  assert.equal(fs.readFileSync(target, 'utf8'), 'keep'); assert.equal(fs.existsSync(join(f.home, 'absent')), false);
});

test('boolean QR flags reject all arbitrary paths and never touch home files', async t => {
  const f = fixture(t), files = ['secrets.json', 'config.json', 'state.json'];
  const snapshots = files.map(name => fs.readFileSync(join(f.home, name)));
  for (const args of [['--qr-png', join(f.home, 'pairing.json')], ['--qr-svg=' + join(f.home, 'secrets.json')], ['--qr-png', join(f.home, 'state.json')]]) {
    const result = await f.cli(['pair', ...args]); assert.equal(result.code, 1); assert.equal(result.stdout, '');
  }
  assert.equal(fs.existsSync(join(f.home, 'pairing.json')), false);
  assert.deepEqual(files.map(name => fs.readFileSync(join(f.home, name))), snapshots);
  const result = await f.cli(['pair', '--qr-png', '--json']); assert.equal(result.code, 0);
  assert.equal(JSON.parse(result.stdout).qr_png, imagePath(f.home, readPairingFile(f.home)));
  assert.deepEqual(files.slice(0, 2).map(name => fs.readFileSync(join(f.home, name))), snapshots.slice(0, 2));
  assert.equal(fs.readFileSync(join(f.home, 'pairing.json'), 'utf8').startsWith('{'), true);
});

test('old qr_files records are accepted but never used as output or cleanup paths', async t => {
  const f = fixture(t); assert.equal((await f.cli(['pair', '--json'])).code, 0);
  const doc = readPairingFile(f.home), target = join(f.home, 'keep'), stat = fs.statSync(join(f.home, 'config.json'));
  fs.writeFileSync(target, 'keep');
  doc.qr_files = [{ format: 'png', path: target, dev: stat.dev, ino: fs.statSync(target).ino }];
  fs.writeFileSync(join(f.home, 'pairing.json'), JSON.stringify(doc));
  assert.deepEqual(readPairingFile(f.home).qr_files, doc.qr_files);
  const shown = await f.cli(['pair', '--show-qr', '--json']); assert.equal(shown.code, 0); assert.equal(JSON.parse(shown.stdout).qr_png, undefined);
  assert.equal((await f.cli(['pair', '--json'])).code, 0); assert.equal(readPairingFile(f.home).qr_files, undefined); assert.equal(fs.readFileSync(target, 'utf8'), 'keep');
});

test('only pair output carries URI, QR text and image paths; logs, receive and MCP stay credential-free', async t => {
  const f = fixture(t), started = await f.cli(['pair', '--qr-png', '--json']); assert.equal(started.code, 0);
  const doc = readPairingFile(f.home), output = JSON.parse(started.stdout), path = output.qr_png, secrets = [doc.uri, doc.pairing_token, doc.pair_secret, output.qr_text, path];
  f.receiver.release();
  const calls = ['syncky_status', 'syncky_inbox'].map((name, i) => JSON.stringify({ jsonrpc: '2.0', id: i + 1, method: 'tools/call', params: { name, arguments: {} } })).join('\n') + '\n';
  const messages = [started.stderr];
  for (const args of [['status', '--json'], ['receive', '--once'], ['mcp']]) {
    const result = await f.cli(args, { stdin: Readable.from([calls]), fetch: async url => Response.json(new URL(url).pathname.includes('/pairings/') ? { status: 'pending' } : new URL(url).pathname === '/v1/members' ? { members: [] } : { messages: [], has_more: false }) });
    assert.equal(result.code, 0, result.stderr); messages.push(result.stdout + result.stderr);
  }
  const logger = createLogger({ level: 'debug', sink: line => messages.push(line) });
  logger.info('pair_metadata', { ...output, qr_files: [{ path }] });
  for (const text of messages) for (const secret of secrets) assert.ok(!text.includes(secret), 'private pairing presentation leaked');
  assert.ok(!JSON.stringify(readHomeState(f.home)).includes(path));
});

for (const v1 of [false, true]) test(`live v${v1 ? 1 : 2} replacement removes all old images including a regular replacement`, async t => {
  const f = fixture(t), started = await f.cli(['pair', ...(v1 ? ['--v1'] : []), '--qr-png', '--qr-svg', '--json']); assert.equal(started.code, 0);
  const first = JSON.parse(started.stdout);
  fs.unlinkSync(first.qr_png); fs.writeFileSync(first.qr_png, 'replacement in agent-owned directory');
  const result = await f.cli(['pair', '--qr-png', '--json']); assert.equal(result.code, 0);
  const next = JSON.parse(result.stdout); assert.notEqual(next.pairing_id, first.pairing_id);
  for (const path of [first.qr_png, first.qr_svg]) assert.equal(fs.existsSync(path), false);
  assert.ok(fs.existsSync(next.qr_png)); assert.equal(readPairingFile(f.home).qr_files, undefined);
});

test('interrupted replacement and image writes leave no permanent orphans after the next sweep', async t => {
  const f = fixture(t), first = await f.cli(['pair', '--qr-png', '--json']); assert.equal(first.code, 0);
  const png = JSON.parse(first.stdout).qr_png, rename = fs.renameSync;
  const failure = t.mock.method(fs, 'renameSync', (from, to) => { if (to === join(f.home, 'state.json')) throw Object.assign(Error('full'), { code: 'ENOSPC' }); return rename(from, to); });
  const failed = await f.cli(['pair', '--qr-png', '--json']); assert.equal(failed.code, 4); failure.mock.restore();
  const doc = readPairingFile(f.home), orphan = imagePath(f.home, doc);
  fs.writeFileSync(orphan, 'crash after image fsync');
  const result = await f.cli(['pair', '--json']); assert.equal(result.code, 0);
  assert.equal(fs.existsSync(png), false); assert.equal(fs.existsSync(orphan), false);
});

test('image cleanup errors never fail pairing and the next sweep retries', async t => {
  const f = fixture(t), first = await f.cli(['pair', '--qr-png', '--json']); assert.equal(first.code, 0);
  const path = JSON.parse(first.stdout).qr_png, unlink = fs.unlinkSync;
  const failure = t.mock.method(fs, 'unlinkSync', file => { if (file === path) throw Object.assign(Error('denied'), { code: 'EACCES' }); return unlink(file); });
  const result = await f.cli(['pair', '--json']); assert.equal(result.code, 0); assert.equal(result.stderr, ''); assert.equal(fs.existsSync(path), true);
  failure.mock.restore();
  assert.equal((await f.cli(['pair', '--show-qr', '--json'])).code, 0); assert.equal(fs.existsSync(path), false);
  assert.doesNotThrow(() => cleanupPairingQr(f.home, null, { fs: { ...fs, readdirSync: () => { throw Error('denied'); } } }));
});

test('wait on a home with QR images retries a briefly held state lock instead of failing', async t => {
  const f = fixture(t);
  const started = await f.cli(['pair', '--v1', '--qr-png', '--json']);
  assert.equal(started.code, 0, started.stderr);
  assert.ok(fs.lstatSync(join(f.home, 'pairing-qr')).isDirectory());
  const transaction = acquireHomeLock(f.home, 'state'), mkdirSync = fs.mkdirSync;
  let blocked = false, released = false;
  const release = () => { if (!released) { released = true; transaction.release(); } };
  t.mock.method(fs, 'mkdirSync', (...args) => {
    try { return mkdirSync(...args); }
    catch (error) {
      if (args[0] === join(f.home, '.state.lock') && error.code === 'EEXIST') { blocked = true; queueMicrotask(release); }
      throw error;
    }
  });
  try {
    const result = await f.cli(['wait', '--json', '--timeout', '1'], { sleep: async ms => f.advance(ms) });
    assert.equal(blocked, true);
    assert.doesNotMatch(result.stderr, /home_locked/);
  } finally { release(); }
});
