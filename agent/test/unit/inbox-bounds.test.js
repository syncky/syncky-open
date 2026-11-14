import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createInbox, inboxMetadata, INBOX_PAGE_BUDGET } from '../../src/inbox.js';
import { INBOX_CHUNK_BYTES } from '../../src/inbox-io.js';
import { fixture, diskFailure } from '../support/thin-home.js';

const record = (seq, day = '2026-11-05') => ({ seq, cursor: seq, from: 'm_dev_1', kind: 'data', type: 'sync', received_at: day + 'T12:00:00Z', inner: { type: 'sync' } });
function ioTrace() {
  const paths = new Map(), stats = { bytes: 0, reads: 0, max: 0, opened: [] };
  const io = new Proxy(fs, { get(target, op) {
    if (op === 'openSync') return (path, ...args) => { const fd = target.openSync(path, ...args); paths.set(fd, String(path)); if (String(path).endsWith('.jsonl')) stats.opened.push(String(path)); return fd; };
    if (op === 'closeSync') return fd => { paths.delete(fd); return target.closeSync(fd); };
    if (op === 'readFileSync') return (fd, ...args) => { assert.equal((paths.get(fd) ?? String(fd)).endsWith('.jsonl'), false, 'payload materialized'); return target.readFileSync(fd, ...args); };
    if (op === 'readSync') return (fd, buf, offset, length, position) => {
      if (paths.get(fd)?.endsWith('.jsonl')) { stats.max = Math.max(stats.max, length); stats.reads++; }
      const n = target.readSync(fd, buf, offset, length, position); if (paths.get(fd)?.endsWith('.jsonl')) stats.bytes += n; return n;
    };
    return target[op];
  } });
  return { fs: io, stats };
}
function seed(home, count, padding = 0, day = '2026-11-05', first = 1) {
  fs.mkdirSync(join(home, 'inbox'), { mode: 0o700, recursive: true });
  const fd = fs.openSync(join(home, 'inbox', day + '.jsonl'), 'a', 0o600);
  try { for (let seq = first; seq < first + count; seq++) fs.writeSync(fd, JSON.stringify({ ...record(seq, day), inner: { type: 'sync', pad: 'x'.repeat(padding) } }) + '\n'); }
  finally { fs.closeSync(fd); }
}

test('plain pagination crosses history larger than both default budgets with bounded reads and cursor seeks', t => {
  const home = fixture(t); seed(home, 12001, 6000);
  assert.ok(fs.statSync(join(home, 'inbox/2026-11-05.jsonl')).size > INBOX_PAGE_BUDGET.bytes);
  const trace = ioTrace(), budget = { bytes: 2 * 1024 * 1024, records: 256 };
  const inbox = createInbox(home, { ...trace, pageBudget: budget });
  assert.equal(inbox.read({ limit: 1 }).length, 1);
  assert.ok(trace.stats.bytes <= INBOX_CHUNK_BYTES);
  assert.ok(trace.stats.max <= INBOX_CHUNK_BYTES);
  let afterSeq = -1, total = 0;
  while (total < 12001) {
    const before = trace.stats.bytes;
    const page = inbox.read({ afterSeq, limit: 100 });
    assert.ok(page.length > 0); assert.ok(trace.stats.bytes - before <= budget.bytes);
    for (const row of page) { assert.equal(row.seq, ++total); afterSeq = row.cursor; }
  }
  assert.deepEqual(inbox.read({ afterSeq }), []);
  assert.equal(total, 12001);
});

test('single-record pages seek past large records within the former 128-record block', t => {
  const home = fixture(t); seed(home, 110, 600 * 1024);
  inboxMetadata(home);
  const trace = ioTrace(), inbox = createInbox(home, trace);
  for (let afterSeq = 0; afterSeq < 110; afterSeq++) {
    trace.stats.bytes = 0;
    assert.deepEqual(inbox.read({ afterSeq, limit: 1 }).map(r => r.seq), [afterSeq + 1]);
    assert.ok(trace.stats.bytes <= 600 * 1024 + INBOX_CHUNK_BYTES);
  }
});

test('cold snapshots decode only the requested page and include all payload I/O in its budget', t => {
  const home = fixture(t); seed(home, 110, 600 * 1024);
  for (const snapshot of [true, false]) {
    const trace = ioTrace(), inbox = createInbox(home, { ...trace, pageBudget: { bytes: 700 * 1024, records: 1 } });
    assert.deepEqual(inbox.read({ limit: 1 }, { snapshot }).map(r => r.seq), [1]);
    assert.ok(trace.stats.bytes <= 700 * 1024);
    assert.ok(trace.stats.max <= INBOX_CHUNK_BYTES);
  }
  const trace = ioTrace();
  assert.throws(() => createInbox(home, { ...trace, pageBudget: { bytes: 200, records: 1 } }).read({ limit: 1 }, { snapshot: true }), { code: 'inbox_scan_limit' });
  assert.ok(trace.stats.bytes <= 200);
  const cold = ioTrace(), pageBudget = { bytes: 16 * 1024 * 1024, records: 16 };
  assert.deepEqual(createInbox(home, { ...cold, pageBudget }).read({ afterSeq: 109, limit: 1 }, { snapshot: true }).map(r => r.seq), [110]);
  assert.ok(cold.stats.bytes <= pageBudget.bytes);
});

test('append and bounded crash-tail recovery skip the active day prefix and preserve seq conflicts', t => {
  const home = fixture(t); seed(home, 1200, 1000);
  inboxMetadata(home);
  let trace = ioTrace(), inbox = createInbox(home, trace);
  assert.equal(inbox.append(record(1201)).inserted, true);
  assert.equal(trace.stats.bytes, 0);
  const path = join(home, 'inbox/2026-11-05.jsonl'), original = fs.statSync(path).size;
  fs.appendFileSync(path, '{"interrupted":');
  trace = ioTrace(); inbox = createInbox(home, trace);
  assert.equal(inbox.append(record(1202)).inserted, true);
  assert.ok(trace.stats.bytes < INBOX_CHUNK_BYTES);
  assert.ok(fs.statSync(path).size > original);
  assert.throws(() => inbox.append({ ...record(1), inner: { type: 'sync', conflicting: true } }), { code: 'invalid_state' });
  const rows = inbox.read({ afterSeq: 1200 });
  assert.deepEqual(rows.map(r => r.seq), [1201, 1202]);
});

test('per-page record and byte budgets return resumable filtered pages without file changes', t => {
  for (const pageBudget of [{ bytes: 1e6, records: 3 }, { bytes: 1024, records: 1000 }, { bytes: 200, records: 1000 }]) {
    const home = fixture(t); seed(home, 30, 100);
    const path = join(home, 'inbox/2026-11-05.jsonl'), before = fs.readFileSync(path);
    const trace = ioTrace(), inbox = createInbox(home, { ...trace, pageBudget });
    if (pageBudget.bytes === 200) {
      assert.throws(() => inbox.readPage({ type: 'absent', limit: 2 }), { code: 'inbox_scan_limit' });
    } else {
      let afterSeq = -1;
      while (afterSeq < 30) {
        trace.stats.bytes = 0;
        const page = inbox.readPage({ type: 'absent', afterSeq, limit: 2 });
        assert.deepEqual(page.records, []);
        assert.ok(page.next_after_seq > afterSeq && page.next_after_seq - Math.max(0, afterSeq) <= pageBudget.records);
        assert.ok(trace.stats.bytes <= pageBudget.bytes);
        afterSeq = page.next_after_seq;
        if (!page.has_more) break;
      }
      assert.equal(afterSeq, 30);
    }
    assert.ok(fs.readFileSync(path).equals(before));
  }
});

test('date selection skips unrelated payloads; cursor order merges overlapping days exactly', t => {
  const home = fixture(t), inbox = createInbox(home);
  for (let seq = 1; seq <= 30; seq++) inbox.append(record(seq, seq % 2 ? '2026-11-05' : '2026-11-04'));
  const trace = ioTrace(), read = createInbox(home, { ...trace, pageBudget: { bytes: 65536, records: 100 } });
  const page = read.read({ afterSeq: 10, limit: 5 });
  assert.deepEqual(page.map(r => r.seq), [11, 12, 13, 14, 15]);
  trace.stats.opened.length = 0;
  assert.deepEqual(read.read({ since: '2026-11-05T12:00:00Z', until: '2026-11-05T12:00:00Z', limit: 2 }).map(r => r.seq), [1, 3]);
  assert.equal(trace.stats.opened.some(p => p.includes('2026-11-04')), false);
  trace.stats.opened.length = 0;
  assert.deepEqual(read.read({ afterSeq: 30 }), []);
  assert.deepEqual(trace.stats.opened, []);
});

test('missing seek metadata rebuilds in bounded chunks; prune and forget-style rewrites stream original bytes', t => {
  const home = fixture(t); seed(home, 1500, 1000);
  const trace = ioTrace(), inbox = createInbox(home, trace);
  assert.equal(inbox.read({ limit: 1 }).length, 1);
  assert.ok(trace.stats.max <= INBOX_CHUNK_BYTES);
  fs.rmSync(join(home, '.inbox-index'), { recursive: true });
  assert.equal(inbox.read({ afterSeq: 1498 }).length, 2);
  trace.stats.bytes = 0;
  inbox.prune(new Date('2026-12-06T00:00:00Z'));
  assert.equal(trace.stats.bytes, 0);
  assert.deepEqual(inbox.read(), []);
  assert.deepEqual(fs.readdirSync(join(home, '.inbox-index')), []);
});

test('streamed forget and outbox recovery keep history durable and use cursor seek bounds', async t => {
  const { setup, self, now } = await import('../support/thin-transport.js');
  const { createGenericSender } = await import('../../src/send.js');
  const { createCipherFiles, readHomeState, forgetThinMember } = await import('../../src/home-state.js');
  const { createOutbox } = await import('../../src/outbox.js');
  const { home, transport, pairing } = setup(t);
  seed(home, 1500, 1000);
  createInbox(home).read({ limit: 1 });
  const queued = await createGenericSender({ home, transport, self, now })({ type: 'commands', to: 'm_dev_1', innerText: JSON.stringify({ v: 1, type: 'commands', commands: [{ command_id: 'bounded', version: 1 }] }) });
  createCipherFiles(home, 'outbox').update(queued.msg_id, { state: 'sent', seq: 2000, sent_at: now().toISOString() });
  createInbox(home).append({ ...record(1501), inner: { v: 1, type: 'sync', device: 'm_dev_1', more: false, samples: [], deleted: [], acks: [{ command_id: 'bounded', version: 1, status: 'applied' }] } });
  const trace = ioTrace();
  await createOutbox({ home, now, fs: trace.fs }).flush();
  assert.ok(trace.stats.bytes < 128 * 1200);
  const waits = Object.values(readHomeState(home).transport.response_waits ?? {});
  assert.equal(waits.length, 1); assert.equal(waits[0].completed_at, now().getTime());
  assert.equal(waits[0].inbox_after, 1500);
  pairing.revoke('m_dev_1'); trace.stats.bytes = 0;
  assert.equal(forgetThinMember(home, 'm_dev_1', trace).inbox, 1501);
  assert.equal(forgetThinMember(home, 'm_dev_1', { ...trace, yes: true }).inbox, 1501);
  assert.ok(trace.stats.max <= INBOX_CHUNK_BYTES);
  assert.deepEqual(createInbox(home).read(), []);
  assert.deepEqual(fs.readdirSync(join(home, '.inbox-index')), []);
  assert.equal(readHomeState(home).members.m_dev_1.state, 'revoked');
});

test('metadata progress survives a rebuild fault without rereading completed blocks', t => {
  const home = fixture(t); seed(home, 600, 1000);
  const { fs: traceFs, stats } = ioTrace();
  let reads = 0;
  const io = new Proxy(traceFs, { get(target, op) {
    if (op !== 'readSync') return target[op];
    return (...args) => {
      if (++reads === 8) throw Object.assign(new Error('fixture rebuild failure'), { code: 'EIO' });
      return target.readSync(...args);
    };
  } });
  assert.throws(() => createInbox(home, { fs: io }).read({ limit: 600 }), { code: 'EIO' });
  const progress = JSON.parse(fs.readFileSync(join(home, '.inbox-index/2026-11-05.jsonl.json')));
  assert.ok(progress.end > 0);
  stats.bytes = 0;
  assert.equal(createInbox(home, { fs: traceFs }).read({ afterSeq: 590 }).length, 10);
  assert.ok(stats.bytes < fs.statSync(join(home, 'inbox/2026-11-05.jsonl')).size - progress.end + 2 * INBOX_CHUNK_BYTES);
});

test('immutable tail repair faults leave committed records retryable and indexes reject unsafe aliases', t => {
  const home = fixture(t), inbox = createInbox(home); inbox.append(record(1));
  const path = join(home, 'inbox/2026-11-05.jsonl');
  fs.appendFileSync(path, '{"partial":');
  const before = fs.readFileSync(path), inode = fs.statSync(path).ino;
  for (const op of ['copyFileSync', 'ftruncateSync', 'fsyncSync']) {
    assert.throws(() => createInbox(home, { fs: diskFailure(op, 1, op === 'copyFileSync' ? /\.jsonl$/ : /\.jsonl\..*\.tmp$/) }).append(record(2)), { code: 'ENOSPC' });
    assert.ok(fs.readFileSync(path).equals(before));
    assert.equal(fs.statSync(path).ino, inode);
    assert.deepEqual(fs.readdirSync(join(home, 'inbox')), ['2026-11-05.jsonl']);
  }
  assert.deepEqual(inbox.read().map(r => r.seq), [1]);
  inbox.append(record(2));
  assert.deepEqual(inbox.read().map(r => r.seq), [1, 2]);
  const alias = join(home, 'alias'); fs.linkSync(path, alias);
  assert.throws(() => inbox.read(), { code: 'insecure_permissions' }); fs.unlinkSync(alias);
  const index = join(home, '.inbox-index/2026-11-05.jsonl.json'), bytes = fs.readFileSync(index);
  fs.writeFileSync(alias, bytes, { mode: 0o600 }); fs.unlinkSync(index); fs.symlinkSync(alias, index);
  assert.throws(() => inbox.read(), { code: 'insecure_permissions' });
  assert.throws(() => inbox.append(record(3)), { code: 'insecure_permissions' });
});

test('default filtered scan budget reaches CLI/MCP as a partial page with a continuation cursor', async t => {
  const { createHomeState } = await import('../../src/home-state.js');
  const { identity, keys } = await import('../support/thin-home.js');
  const { saveConfig } = await import('../../src/config.js');
  const { saveSecrets } = await import('../../src/secrets.js');
  const { main } = await import('../../src/cli.js');
  const { Readable } = await import('node:stream');
  const home = fixture(t); createHomeState(home, identity); seed(home, 10001);
  saveConfig(home, { relay_url: 'https://relay.test' });
  saveSecrets(home, { private_key: keys.agent.sk, public_key: keys.agent.pk, token: `sk_${identity.hub_id}_${'T'.repeat(40)}`, webhook_secret: `whsec_${'W'.repeat(43)}` });
  const before = fs.readFileSync(join(home, 'state.json'));
  for (const mcp of [false, true]) {
    let stdout = '', stderr = '', fetched = 0;
    const code = await main(['--home', home, ...(mcp ? ['mcp'] : ['inbox', '--type', 'absent'])], {
      env: {}, fetch: () => { fetched++; }, stdin: Readable.from([JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'syncky_inbox', arguments: { type: 'absent' } } }) + '\n']),
      stdout: { write: s => { stdout += s; } }, stderr: { write: s => { stderr += s; } },
    });
    assert.equal(code, 0); assert.equal(fetched, 0); assert.equal(stderr, '');
    const output = mcp ? JSON.parse(stdout).result : JSON.parse(stdout);
    if (mcp) assert.equal(output.isError, false);
    const page = mcp ? JSON.parse(output.content[0].text) : output;
    assert.deepEqual(page, { records: [], next_after_seq: 10000, has_more: true });
    assert.ok(fs.readFileSync(join(home, 'state.json')).equals(before));
  }
});
