import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createInbox, inboxLines, inboxMetadata } from '../../src/inbox.js';
import { updateHomeState } from '../../src/home-state.js';
import { setup } from '../support/thin-transport.js';

const day = '2026-11-05';
const sync = { v: 1, type: 'sync', scope: { read: 'none', write: 'none' }, more: false };
const row = (seq, cursor = seq, pad = '') => ({ seq, cursor, from: 'm_dev_1', kind: 'data', type: 'sync', received_at: `${day}T12:00:00Z`, inner: pad ? { ...sync, pad } : sync });
const text = rows => rows.map(r => JSON.stringify(r) + '\n').join('');

function reusingFs({ onClose } = {}) {
  const aliases = new Map(), counts = { bytes: 0 }, paths = new Map();
  const alias = st => aliases.has(st.ino) ? Object.assign(Object.create(Object.getPrototypeOf(st)), st, { ino: aliases.get(st.ino) }) : st;
  const io = new Proxy(fs, { get(target, op) {
    if (typeof target[op] !== 'function') return target[op];
    if (['lstatSync', 'statSync', 'fstatSync'].includes(op)) return (...args) => alias(target[op](...args));
    if (op === 'readSync') return (...args) => { const n = target.readSync(...args); counts.bytes += n; return n; };
    if (op === 'openSync') return (...args) => { const fd = target.openSync(...args); paths.set(fd, String(args[0])); return fd; };
    if (op === 'closeSync') return fd => { const path = paths.get(fd); paths.delete(fd); target.closeSync(fd); if (path?.endsWith('.jsonl')) onClose?.(path); };
    return target[op].bind(target);
  } });
  return { io, counts, alias: (path, ino) => aliases.set(fs.statSync(path).ino, ino) };
}
function seed(t, rows) {
  const { home } = setup(t);
  const inbox = createInbox(home);
  for (const { cursor, ...r } of rows) inbox.append(r);
  inboxMetadata(home);
  return { home, path: join(home, 'inbox', day + '.jsonl') };
}
function replace(path, content) {
  const ino = fs.statSync(path).ino;
  fs.unlinkSync(path); fs.writeFileSync(path, content, { mode: 0o600 });
  return ino;
}
function commitAll(home) {
  updateHomeState(home, s => { s.transport.inbox_committed_cursor = 1000; });
  fs.writeFileSync(join(home, '.inbox-cursor.json'), '{"cursor":1000}\n', { mode: 0o600 });
}
const cursors = (home, io) => inboxLines(home, { fs: io }).map(l => l.record.cursor);

for (const shape of ['unrelated rows', 'the same first row', 'a legacy index without line fingerprints']) {
  test(`a larger file that reuses the indexed inode with ${shape} is rescanned from the start`, t => {
    const { home, path } = seed(t, [row(1), row(2), row(3)]);
    const before = fs.statSync(path).size;
    if (shape.startsWith('a legacy')) {
      const indexFile = join(home, '.inbox-index', day + '.jsonl.json'), index = JSON.parse(fs.readFileSync(indexFile));
      delete index.head; delete index.tail; fs.writeFileSync(indexFile, JSON.stringify(index) + '\n');
    }
    const first = fs.readFileSync(path, 'utf8').split('\n')[0] + '\n';
    const rows = shape === 'unrelated rows' ? [row(80, 80, 'x'.repeat(40)), row(81), row(82), row(83)] : [row(84, 84, 'y'.repeat(40)), row(85), row(86)];
    const content = (shape === 'the same first row' ? first : '') + text(rows);
    const old = replace(path, content), reuse = reusingFs(); reuse.alias(path, old);
    assert.ok(fs.statSync(path).size > before);
    const index = inboxMetadata(home, { fs: reuse.io })[0].index;
    assert.equal(index.end, content.length);
    const expected = shape === 'the same first row' ? [1, ...rows.map(r => r.cursor)] : rows.map(r => r.cursor);
    assert.deepEqual(index.blocks.map(b => [b.first, b.last]), [[expected[0], expected.at(-1)]]);
    assert.deepEqual(cursors(home, reuse.io), expected);
  });
}

test('a same-inode replacement between the line check and the scan falls back to a full rescan', t => {
  const { home, path } = seed(t, [row(1), row(2), row(3)]);
  const end = fs.statSync(path).size, base = text([row(90, 90, 'z')]).length;
  const rows = [row(90, 90, 'z'.repeat(end + 20 - base + 1)), row(91)], content = text(rows);
  fs.appendFileSync(path, text([row(4)]));
  assert.equal(content.indexOf('\n'), end + 19);
  assert.ok(fs.statSync(path).size > end + 20);
  let checked = false;
  const reuse = reusingFs({ onClose() {
    if (checked) return;
    checked = true; reuse.alias(path, replace(path, content));
  } });
  const index = inboxMetadata(home, { fs: reuse.io })[0].index;
  assert.equal(checked, true);
  assert.equal(index.end, content.length);
  assert.deepEqual(cursors(home, reuse.io), [90, 91]);
});

test('plain growth of the same file still resumes from the indexed end', t => {
  const filler = 'f'.repeat(2000), { home, path } = seed(t, Array.from({ length: 20 }, (_, i) => row(i + 1, i + 1, filler)));
  const before = fs.statSync(path).size, appended = text([row(21)]);
  fs.appendFileSync(path, appended);
  const reuse = reusingFs(), index = inboxMetadata(home, { fs: reuse.io })[0].index;
  assert.equal(index.end, before + appended.length);
  assert.equal(index.blocks.at(-1).last, 21);
  assert.ok(reuse.counts.bytes < 3 * 2200 + appended.length, `read ${reuse.counts.bytes} bytes of ${before + appended.length}`);
  assert.deepEqual(cursors(home), Array.from({ length: 21 }, (_, i) => i + 1));
});

for (const afterSeq of [1, 2]) test(`a same-inode replacement under a budgeted snapshot read after cursor ${afterSeq} retries instead of reporting corruption or skipping`, t => {
  const filler = 'g'.repeat(70 * 1024), { home, path } = seed(t, [row(1, 1, filler), row(2, 2, filler)]);
  fs.appendFileSync(path, text([row(3)])); commitAll(home);
  const rows = [row(95, 95, 'h'.repeat(80 * 1024)), row(96, 96, 'h'.repeat(80 * 1024))], content = text(rows);
  let checked = false;
  const reuse = reusingFs({ onClose() {
    if (checked) return;
    checked = true; reuse.alias(path, replace(path, content));
  } });
  const page = createInbox(home, { fs: reuse.io }).readPage({ afterSeq }, { snapshot: true });
  assert.equal(checked, true);
  assert.deepEqual(page.records.map(r => r.cursor), [95, 96]);
});

test('checking a grown file with long boundary lines reads only bounded edges and charges the page budget', t => {
  const filler = 'k'.repeat(300 * 1024), { home, path } = seed(t, [row(1, 1, filler), row(2, 2, filler)]);
  fs.appendFileSync(path, text([row(3)])); commitAll(home);
  const reuse = reusingFs(), pageBudget = { bytes: 64 * 1024, records: 100 };
  const page = createInbox(home, { fs: reuse.io, pageBudget }).readPage({ afterSeq: 2 }, { snapshot: true });
  assert.deepEqual(page.records.map(r => r.cursor), [3]);
  assert.ok(reuse.counts.bytes <= 5 * 4096, `read ${reuse.counts.bytes} bytes`);
  const tight = reusingFs();
  fs.appendFileSync(path, text([row(4)]));
  assert.throws(() => createInbox(home, { fs: tight.io, pageBudget: { bytes: 1024, records: 100 } }).readPage({ afterSeq: 3 }, { snapshot: true }), { code: 'inbox_scan_limit' });
  assert.ok(tight.counts.bytes <= 1024, `read ${tight.counts.bytes} bytes`);
});

for (const edge of ['head', 'tail']) for (const value of [null, 7, { hash: 'x' }]) test(`a saved index with ${edge} ${JSON.stringify(value)} is corrupt state`, t => {
  const { home } = seed(t, [row(1), row(2)]);
  const indexFile = join(home, '.inbox-index', day + '.jsonl.json'), index = JSON.parse(fs.readFileSync(indexFile));
  index[edge] = value; fs.writeFileSync(indexFile, JSON.stringify(index) + '\n');
  assert.throws(() => inboxMetadata(home), { name: 'LocalStateError', code: 'corrupt_state' });
});

test('a same-inode replacement whose long boundary line differs only in its cursor is rescanned', t => {
  const filler = 'm'.repeat(6000), { home, path } = seed(t, [row(1, 1, filler), row(10, 10, filler)]);
  const [first, second] = fs.readFileSync(path, 'utf8').split('\n');
  const swapped = second.replace('"seq":10,"cursor":10', '"seq":95,"cursor":95');
  assert.equal(swapped.length, second.length); assert.notEqual(swapped, second);
  const content = first + '\n' + swapped + '\n' + text([row(96)]);
  const old = replace(path, content), reuse = reusingFs(); reuse.alias(path, old);
  commitAll(home);
  assert.deepEqual(createInbox(home, { fs: reuse.io }).readPage({ afterSeq: 10 }, { snapshot: true }).records.map(r => r.cursor), [95, 96]);
});
