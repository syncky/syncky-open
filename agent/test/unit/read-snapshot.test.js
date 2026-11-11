import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { main } from '../../src/cli.js';
import { saveConfig } from '../../src/config.js';
import { createHomeState, createCipherFiles } from '../../src/home-state.js';
import { createInbox, inboxLines } from '../../src/inbox.js';
import { acquireHomeLock, atomicPrivateWrite } from '../../src/protected-files.js';
import { localStatus, readInbox } from '../../src/runtime.js';
import { saveSecrets } from '../../src/secrets.js';
import { fixture, identity, keys, messageId } from '../support/thin-home.js';

const record = { seq: 1, from: 'm_dev_1', kind: 'control', type: 'future',
  received_at: '2026-11-08T00:00:00.000Z', inner: { type: 'future' } };

function setup(t) {
  const home = fixture(t);
  createHomeState(home, identity);
  saveSecrets(home, { private_key: keys.agent.sk, public_key: keys.agent.pk,
    token: `sk_${identity.hub_id}_${'T'.repeat(40)}`, webhook_secret: `whsec_${'W'.repeat(43)}` });
  saveConfig(home, { relay_url: 'http://127.0.0.1:8787', name: 'Test' });
  createCipherFiles(home, 'outbox').put({ msg_id: messageId(1), kind: 'control', body: 'sealed', state: 'pending' });
  createCipherFiles(home, 'held').put({ msg_id: messageId(2), seq: 2, kind: 'control', body: 'sealed' });
  createInbox(home).append(record);
  return home;
}

function check(command, result) {
  if (command === 'status') {
    assert.equal(result.member_id, identity.member_id);
    assert.equal(result.held, 1);
    assert.deepEqual(result.outbox, { pending: 1, sent: 0, failed: 0 });
  } else assert.deepEqual(result.records, [{ ...record, cursor: 1 }]);
}

for (const command of ['status', 'inbox']) test(`${command} reads beside a persistent ownerless state lock`, t => {
  const home = setup(t), lock = join(home, '.state.lock');
  fs.mkdirSync(lock, { mode: 0o700 });
  const result = command === 'status' ? localStatus(home, { status: () => ({}) }) : readInbox(home);
  check(command, result);
  assert.deepEqual(fs.readdirSync(lock), []);
});

for (const surface of ['CLI', 'MCP']) for (const command of ['status', 'inbox']) {
  for (const phase of ['starting', 'running', 'stopping']) {
    test(`${surface} ${command} reads without locking or fsync while the receiver is ${phase}`, async t => {
      const home = setup(t), directory = join(home, '.receiver.lock');
      let receiver;
      if (phase === 'starting') fs.mkdirSync(directory, { mode: 0o700 });
      else {
        receiver = acquireHomeLock(home, 'receiver');
        if (phase === 'stopping') fs.unlinkSync(join(directory, fs.readdirSync(directory)[0]));
      }
      const transaction = acquireHomeLock(home, 'state'), state = fs.readFileSync(join(home, 'state.json'));
      const owners = fs.readdirSync(directory), stateOwners = fs.readdirSync(join(home, '.state.lock'));
      const mkdirSync = fs.mkdirSync;
      const mkdir = t.mock.method(fs, 'mkdirSync', (path, ...args) => {
        assert.notEqual(path, join(home, '.state.lock'), 'read attempted to acquire the writer lock');
        return mkdirSync(path, ...args);
      });
      const sync = t.mock.method(fs, 'fsyncSync', () => assert.fail('read attempted fsync'));
      let stdout = '', stderr = '';
      try {
        const request = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: `syncky_${command}`, arguments: {} } };
        const code = await main(['--home', home, ...(surface === 'CLI' ? [command, '--json'] : ['mcp'])], {
          env: {}, fetch: () => assert.fail('read attempted network work'),
          stdin: Readable.from([JSON.stringify(request) + '\n']),
          stdout: { write: line => { stdout += line; } }, stderr: { write: line => { stderr += line; } },
        });
        assert.equal(code, 0, stderr);
        const reply = JSON.parse(stdout);
        if (surface === 'MCP') assert.equal(reply.result.isError, false);
        check(command, surface === 'CLI' ? reply : reply.result.structuredContent);
        assert.deepEqual(fs.readFileSync(join(home, 'state.json')), state);
        assert.deepEqual(fs.readdirSync(directory), owners);
        assert.deepEqual(fs.readdirSync(join(home, '.state.lock')), stateOwners);
      } finally {
        mkdir.mock.restore(); sync.mock.restore(); transaction.release();
        if (phase === 'running') receiver.release();
      }
    });
  }
}

test('inbox snapshot leaves interrupted rewrite recovery to locked operations', t => {
  const home = setup(t), marker = join(home, 'inbox', '.rewrite-pending');
  fs.writeFileSync(marker, '{}\n', { mode: 0o600 });
  const sync = t.mock.method(fs, 'fsyncSync', () => assert.fail('snapshot attempted recovery fsync'));
  try { check('inbox', readInbox(home)); }
  finally { sync.mock.restore(); }
  assert.equal(fs.readFileSync(marker, 'utf8'), '{}\n');
  createInbox(home).read();
  assert.equal(fs.existsSync(marker), false);
});

test('inbox snapshot tolerates pruning after directory enumeration without taking the writer lock', t => {
  const home = setup(t), directory = join(home, 'inbox'), path = join(directory, '2026-11-08.jsonl');
  const transaction = acquireHomeLock(home, 'state'), readdirSync = fs.readdirSync;
  t.mock.method(fs, 'readdirSync', (name, ...args) => {
    const files = readdirSync(name, ...args);
    if (name === directory) fs.unlinkSync(path);
    return files;
  });
  try { assert.deepEqual(readInbox(home).records, []); }
  finally { transaction.release(); }
});

test('inbox snapshot reads complete records beside an unfinished append', t => {
  const home = setup(t), transaction = acquireHomeLock(home, 'state');
  try {
    fs.appendFileSync(join(home, 'inbox', '2026-11-08.jsonl'), '{"seq":2');
    check('inbox', readInbox(home));
  } finally { transaction.release(); }
});

for (const command of ['status', 'inbox']) test(`${command} snapshot retries an atomic file replacement beside a writer`, t => {
  const home = setup(t), transaction = acquireHomeLock(home, 'state');
  const path = command === 'status' ? join(home, 'outbox', `${messageId(1)}.json`) : join(home, 'inbox', '2026-11-08.jsonl');
  const before = fs.readFileSync(path), openSync = fs.openSync;
  let replaced = false;
  t.mock.method(fs, 'openSync', (name, ...args) => {
    if (name === path && !replaced) { replaced = true; atomicPrivateWrite(path, before); }
    return openSync(name, ...args);
  });
  try {
    check(command, command === 'status' ? localStatus(home, { status: () => ({}) }) : readInbox(home));
    assert.equal(replaced, true);
  } finally { transaction.release(); }
});

test('split inbox reads cannot splice a repaired partial tail into a fabricated record', t => {
  const home = fixture(t), inbox = createInbox(home);
  inbox.append(record);
  const path = join(home, 'inbox', '2026-11-08.jsonl'), inode = fs.statSync(path).ino;
  const before = fs.readFileSync(path);
  const old = { ...record, seq: 2, cursor: 2, inner: { type: 'future', left: 'old', right: 'old' } };
  const next = { ...old, inner: { type: 'future', left: 'new', right: 'new' } };
  const tail = JSON.stringify({ seq: old.seq, cursor: old.cursor, ...old }), split = before.length + tail.indexOf('"right"');
  fs.appendFileSync(path, tail.slice(0, -3));
  const readFileSync = fs.readFileSync;
  let interleaved = false;
  t.mock.method(fs, 'readFileSync', (fd, ...args) => {
    if (typeof fd !== 'number' || interleaved || fs.fstatSync(fd).ino !== inode) return readFileSync(fd, ...args);
    interleaved = true;
    const prefix = Buffer.alloc(split);
    assert.equal(fs.readSync(fd, prefix, 0, split, null), split);
    inbox.append(next);
    return Buffer.concat([prefix, readFileSync(fd, ...args)]);
  });
  assert.deepEqual(inboxLines(home, { snapshot: true }).map(l => l.record), [{ ...record, cursor: 1 }]);
  assert.equal(interleaved, true);
  assert.deepEqual(inbox.read().map(r => r.inner), [record.inner, next.inner]);
  assert.notEqual(fs.statSync(path).ino, inode);
});

test('split inbox reads preserve a complete failed append across replay and another append', t => {
  const home = fixture(t), inbox = createInbox(home);
  inbox.append(record);
  const path = join(home, 'inbox', '2026-11-08.jsonl'), inode = fs.statSync(path).ino;
  const before = fs.readFileSync(path);
  const old = { ...record, seq: 2, cursor: 2, inner: { type: 'future', left: 'old', right: 'old' } };
  const next = { ...old, seq: 3, cursor: 3, inner: { type: 'future', left: 'new', right: 'new' } };
  const split = before.length + JSON.stringify({ seq: old.seq, cursor: old.cursor, ...old }).indexOf('"right"'), readFileSync = fs.readFileSync;
  let interleaved = false;
  t.mock.method(fs, 'readFileSync', (fd, ...args) => {
    if (typeof fd !== 'number' || interleaved || fs.fstatSync(fd).ino !== inode) return readFileSync(fd, ...args);
    interleaved = true;
    const prefix = Buffer.alloc(split);
    let failed = false;
    const io = new Proxy(fs, { get(target, key) {
      if (key === 'fsyncSync') return appendFd => {
        if (!failed && fs.fstatSync(appendFd).ino === inode) {
          failed = true;
          assert.equal(fs.readSync(fd, prefix, 0, split, null), split);
          throw Object.assign(new Error('fixture disk failure'), { code: 'ENOSPC' });
        }
        return target.fsyncSync(appendFd);
      };
      return target[key];
    } });
    assert.throws(() => createInbox(home, { fs: io }).append(old), { code: 'ENOSPC' });
    assert.equal(failed, true);
    assert.deepEqual(inbox.append(old), { inserted: false, seq: 2 });
    assert.throws(() => inbox.append({ ...next, seq: 2 }), { code: 'invalid_state' });
    inbox.append(next);
    return Buffer.concat([prefix, readFileSync(fd, ...args)]);
  });
  assert.deepEqual(inboxLines(home, { snapshot: true }).map(l => l.record), [{ ...record, cursor: 1 }, old, next]);
  assert.equal(interleaved, true);
  assert.deepEqual(inbox.read().map(r => r.inner), [record.inner, old.inner, next.inner]);
  assert.equal(fs.statSync(path).ino, inode);
});

test('inbox snapshot recovers the file cursor ceiling when the reservation file is missing', t => {
  const home = fixture(t), inbox = createInbox(home);
  inbox.append({ ...record, seq: 2 });
  inbox.append({ ...record, received_at: '2026-11-07T00:00:00.000Z' });
  const expected = readInbox(home), cursorPath = join(home, '.inbox-cursor.json');
  fs.unlinkSync(cursorPath);
  const transaction = acquireHomeLock(home, 'state');
  try {
    assert.deepEqual(readInbox(home), expected);
    const first = readInbox(home, { limit: 1 });
    assert.deepEqual(first.records.map(r => [r.seq, r.cursor]), [[2, 2]]);
    assert.equal(first.has_more, true);
    assert.deepEqual(readInbox(home, { after_seq: first.next_after_seq }).records.map(r => [r.seq, r.cursor]), [[1, 3]]);
    assert.equal(fs.existsSync(cursorPath), false);
  } finally { transaction.release(); }
});

for (const mode of ['current', 'legacy', 'missing']) test(`inbox pagination defers appends between ${mode} daily scans without skipping a delayed release`, t => {
  const home = fixture(t), inbox = createInbox(home);
  inbox.append({ ...record, received_at: '2026-11-07T00:00:00.000Z' });
  inbox.append({ ...record, seq: 2 });
  if (mode === 'legacy') {
    for (const name of fs.readdirSync(join(home, 'inbox'))) {
      const path = join(home, 'inbox', name), stored = JSON.parse(fs.readFileSync(path));
      delete stored.cursor;
      fs.writeFileSync(path, JSON.stringify(stored) + '\n');
    }
  }
  if (mode !== 'current') fs.unlinkSync(join(home, '.inbox-cursor.json'));
  const path = join(home, 'inbox', '2026-11-07.jsonl'), inode = fs.statSync(path).ino;
  const readFileSync = fs.readFileSync;
  let interleaved = false, scans = 0;
  t.mock.method(fs, 'readFileSync', (fd, ...args) => {
    const bytes = readFileSync(fd, ...args);
    if (typeof fd === 'number' && !interleaved && fs.fstatSync(fd).ino === inode && ++scans === (mode === 'current' ? 1 : 2)) {
      interleaved = true;
      inbox.append({ ...record, seq: 0, received_at: '2026-11-07T01:00:00.000Z' });
      inbox.append({ ...record, seq: 3 });
    }
    return bytes;
  });
  const first = readInbox(home);
  assert.equal(interleaved, true);
  assert.deepEqual(first.records.map(r => r.cursor ?? r.seq), [1, 2]);
  assert.equal(first.next_after_seq, 2);
  assert.equal(first.has_more, false);
  const second = readInbox(home, { after_seq: first.next_after_seq, limit: 1 });
  assert.deepEqual(second.records.map(r => [r.seq, r.cursor]), [[0, 3]]);
  assert.equal(second.has_more, true);
  const third = readInbox(home, { after_seq: second.next_after_seq });
  assert.deepEqual(third.records.map(r => r.cursor), [4]);
  assert.equal(third.has_more, false);
});
