import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createInbox, inboxLines, inboxMetadata } from '../../src/inbox.js';
import { readHomeState, updateHomeState } from '../../src/home-state.js';
import { setup, delivery, self, now, keys, messageId } from '../support/thin-transport.js';

function instrument(source, url, inboxUrl) {
  return source.replace(/(from\s+)(['"])(\.[^'"]+)\2/g, (_, from, quote, path) =>
    from + JSON.stringify(path === './inbox.js' && inboxUrl ? inboxUrl : new URL(path, url).href));
}
const inboxSourceUrl = new URL('../../src/inbox.js', import.meta.url);
let inboxSource = fs.readFileSync(inboxSourceUrl, 'utf8');
for (const name of ['findInboxSequence', 'inboxMetadata', 'collectAdmissionIndexes', 'appendInboxLocked']) {
  inboxSource = inboxSource.replace(new RegExp(`(function ${name}\\([^\\n]*\\) \\{\\n)`), `$1  work.hit('${name}');\n`);
}
inboxSource += '\nexport const work = { hit() {} };\n';
const moduleUrl = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const inboxUrl = moduleUrl(instrument(inboxSource, inboxSourceUrl));
const measured = await import(inboxUrl);
const inboundUrl = new URL('../../src/thin-inbound.js', import.meta.url);
const inboundSource = instrument(fs.readFileSync(inboundUrl, 'utf8'), inboundUrl, inboxUrl)
  .replace(/(      reconcileState\(state, emitted(?:, Infinity, view)?\);\n)/, '$1      admissionWork.hit("admitLookup");\n')
  .replace(/(      if \(ids\[record.msg_id\] !== undefined\) \{\n)/, '$1        admissionWork.hit("duplicateLookup");\n')
  + `\nimport { work as admissionWork } from ${JSON.stringify(inboxUrl)};\n`;
const { createThinInbound } = await import(moduleUrl(inboundSource));

const days = ['2026-11-03', '2026-11-04', '2026-11-05'];
const sync = read => ({ v: 1, type: 'sync', scope: { read, write: 'none' }, more: false });
const row = (seq, day = days[2], extra = {}) => ({ seq, from: 'm_dev_1', kind: 'data', type: 'sync', received_at: day + 'T12:00:00Z', inner: sync('none'), ...extra });
const identified = (seq, cursor = seq, day = days[2]) => row(seq, day, { cursor, msg_id: messageId(seq), public_key: keys.dev1.pk, accepted_at: now().getTime() - 1000 });
function put(home, record, suffix = '') {
  fs.mkdirSync(join(home, 'inbox'), { recursive: true, mode: 0o700 });
  fs.appendFileSync(join(home, 'inbox', record.received_at.slice(0, 10) + '.jsonl'), JSON.stringify(record) + '\n' + suffix, { mode: 0o600 });
}
function seed(home) {
  for (const [i, day] of days.entries()) createInbox(home).append(row(i + 1, day));
  updateHomeState(home, s => { s.transport.inbox_committed_cursor = 3; });
}
const inodeAliases = new Map();
const aliasStat = (op, st) => ['lstatSync', 'statSync', 'fstatSync'].includes(op) && inodeAliases.has(st.ino)
  ? Object.assign(Object.create(Object.getPrototypeOf(st)), st, { ino: inodeAliases.get(st.ino) }) : st;
function trace(home, hook = () => {}, work = measured.work) {
  const paths = new Map(), transactions = [], standalone = [], calls = {};
  let armed = false, active;
  const stats = () => ({ calls: {}, indexes: {}, enumerations: 0, stats: 0, bytes: 0, maxRead: 0, opens: 0, synced: [] });
  active = stats(); standalone.push(active);
  work.hit = name => {
    calls[name] = (calls[name] ?? 0) + 1;
    if (active) active.calls[name] = (active.calls[name] ?? 0) + 1;
    hook('work', name, active);
  };
  const io = new Proxy(fs, { get(target, op) {
    if (typeof target[op] !== 'function') return target[op];
    return (...args) => {
      const path = paths.get(args[0]) ?? String(args[0]);
      hook(op, path, active);
      if (op === 'mkdirSync' && path === join(home, '.state.lock')) {
        const result = target.mkdirSync(...args);
        active = stats(); (armed ? transactions : standalone).push(active); return result;
      }
      if (op === 'openSync') {
        const fd = target.openSync(...args); paths.set(fd, path);
        if (active && path.endsWith('.jsonl')) active.opens++;
        return fd;
      }
      if (op === 'closeSync') { paths.delete(args[0]); return target.closeSync(...args); }
      if (op === 'rmdirSync' && path === join(home, '.state.lock')) {
        const result = target.rmdirSync(...args); active = armed ? undefined : standalone[0]; return result;
      }
      if (active) {
        if (op === 'readFileSync') {
          assert.equal(path.endsWith('.jsonl'), false, 'payload materialized');
          if (path.includes('/.inbox-index/') && path.endsWith('.json')) active.indexes[path.split('/').at(-1)] = (active.indexes[path.split('/').at(-1)] ?? 0) + 1;
        }
        if (op === 'readdirSync' && path === join(home, 'inbox')) active.enumerations++;
        if (op === 'lstatSync' && path.endsWith('.jsonl')) active.stats++;
        if (op === 'fsyncSync') active.synced.push(path);
        if (op === 'readSync' && path.endsWith('.jsonl')) {
          active.maxRead = Math.max(active.maxRead, args[3]);
          const count = target.readSync(...args); active.bytes += count; return count;
        }
      }
      return aliasStat(op, target[op](...args));
    };
  } });
  return { fs: io, transactions, standalone, calls, arm() { armed = true; active = undefined; }, disarm() { armed = false; active = standalone[0]; } };
}
function receiver(home, transport, spy, { inject = () => {}, onRecord, clock = now, factory = createThinInbound } = {}) {
  return factory({ home, self, now: clock, fs: spy.fs, onRecord, transport: { ...transport, async receive(...args) {
    const parsed = await transport.receive(...args); inject(); spy.arm(); return parsed;
  } } });
}
function bounds(stats, { searches = 1, collections = 1, indexes = Object.fromEntries(days.map(day => [day + '.jsonl.json', 1])) } = {}) {
  assert.equal(stats.calls.findInboxSequence ?? 0, searches, 'incoming sequence searches');
  assert.equal(stats.calls.collectAdmissionIndexes ?? 0, collections, 'shared metadata/index collections');
  assert.equal(stats.calls.inboxMetadata ?? 0, 0, 'subsequent whole-inbox metadata passes');
  assert.deepEqual(stats.indexes, indexes, 'saved index reads');
  assert.ok(stats.enumerations >= 1); assert.ok(stats.stats >= Object.keys(indexes).length);
  assert.ok(stats.maxRead <= 64 * 1024);
}

for (const mode of ['new', 'duplicate', 'resequenced', 'new day']) test(`warm ${mode} admission shares lookup misses and indexes through target reuse`, async t => {
  const { home, transport } = setup(t); seed(home);
  const message = await delivery(transport, 4, sync('all'));
  if (['duplicate', 'resequenced'].includes(mode)) {
    await createThinInbound({ home, transport, self, now }).receive(message);
  }
  const spy = trace(home), emitted = [];
  const incoming = mode === 'resequenced' ? { ...message, seq: 5 } : message;
  const result = await receiver(home, transport, spy, { onRecord: r => emitted.push(r.cursor) }).receive(incoming, { receivedAt: mode === 'new day' ? '2026-11-06T12:00:00Z' : now().toISOString() });
  assert.equal(result.status, ['duplicate', 'resequenced'].includes(mode) ? 'duplicate' : 'stored');
  assert.equal(spy.transactions.length, 1); bounds(spy.transactions[0]);
  assert.ok(spy.standalone.length >= 1);
  const stats = spy.transactions[0], probe = spy.standalone[0];
  t.diagnostic(`admission searches=${stats.calls.findInboxSequence} collections=${stats.calls.collectAdmissionIndexes} metadata=${stats.calls.inboxMetadata ?? 0} indexReads=${Object.values(stats.indexes).reduce((a, b) => a + b, 0)} enumerations=${stats.enumerations} stats=${stats.stats} payloadBytes=${stats.bytes}; standalone enumerations=${probe.enumerations} indexReads=${Object.values(probe.indexes).reduce((a, b) => a + b, 0)}`);
  assert.equal(emitted.length, result.status === 'stored' ? 1 : 0);
  if (mode === 'duplicate') assert.ok(spy.transactions[0].synced.includes(join(home, 'inbox', days[2] + '.jsonl')));
});

for (const legacy of [false, true]) test(`${legacy ? 'legacy' : 'committed'} admission preserves paired stat/index fault ordering`, async t => {
  const { home, transport } = setup(t); seed(home);
  if (legacy) updateHomeState(home, s => { delete s.transport.inbox_committed_cursor; });
  const spy = trace(home); let emissions = 0;
  const inbound = receiver(home, transport, spy, { inject() {
    fs.writeFileSync(join(home, '.inbox-index', days[0] + '.jsonl.json'), '{}\n');
    fs.chmodSync(join(home, 'inbox', days[2] + '.jsonl'), 0o644);
  }, onRecord: () => emissions++ });
  await assert.rejects(inbound.receive(await delivery(transport, 4)), {
    code: legacy ? 'corrupt_state' : 'insecure_permissions',
    message: legacy ? 'invalid inbox seek metadata' : 'thin home requires private regular files and directories'
  });
  assert.equal(emissions, 0); assert.equal(readHomeState(home).members.m_dev_1.scope, undefined);
  assert.deepEqual(spy.transactions[0].indexes, legacy ? { [days[0] + '.jsonl.json']: 1 } : {});
});

for (const legacy of [false, true]) for (const failCommit of [false, true]) test(`admission-local ${legacy ? 'legacy bootstrap' : 'complete/partial tail'} recovers in order${failCommit ? ' across commit retry' : ''}`, async t => {
  const { home, transport } = setup(t); seed(home);
  const original = identified(10, legacy ? 81 : 10);
  original.inner = sync('all');
  const emitted = []; let injected = false, failed = false, at = now().getTime();
  const spy = trace(home, (op, path, active) => {
    if (failCommit && active && op === 'renameSync' && path.includes('/.state.json.') && !failed) {
      failed = true; throw Object.assign(new Error('fixture commit failure'), { code: 'ENOSPC' });
    }
  });
  const inbound = receiver(home, transport, spy, { clock: () => new Date(at), inject() {
    if (injected) return;
    injected = true;
    if (legacy) {
      updateHomeState(home, s => { delete s.transport.inbox_committed_cursor; });
      put(home, row(80, days[2], { cursor: 80, type: 'unpair', inner: { v: 1, type: 'unpair', reason: 'user' } }));
    }
    put(home, original, '{"interrupted":');
    fs.writeFileSync(join(home, '.inbox-cursor.json'), '{"cursor":100}\n', { mode: 0o600 });
    assert.equal(readHomeState(home).members.m_dev_1.scope, undefined);
    assert.equal(readHomeState(home).transport.inbox_committed_cursor, legacy ? undefined : 3);
  }, onRecord(record) {
    assert.equal(readHomeState(home).members.m_dev_1.scope.seq, 4);
    emitted.push(record);
  } });
  const text = '{ "v":1, "type":"sync", "scope":{"read":"none","write":"none"}, "more":false }';
  const message = await delivery(transport, 4, text);
  if (failCommit) {
    await assert.rejects(inbound.receive(message), { code: 'ENOSPC' });
    assert.equal(emitted.length, 0); assert.equal(readHomeState(home).members.m_dev_1.scope, undefined);
    bounds(spy.transactions[0]); spy.disarm(); at += 10000;
  }
  assert.equal((await inbound.receive(message)).status, failCommit ? 'duplicate' : 'stored');
  bounds(spy.transactions.at(-1));
  assert.deepEqual(emitted.map(r => r.seq), [10, 4]);
  assert.deepEqual(emitted[0], original);
  assert.equal(emitted[1].cursor, 101);
  assert.equal(emitted[1].accepted_at, now().getTime()); assert.equal(emitted[1].received_at, now().toISOString());
  assert.equal(readHomeState(home).members.m_dev_1.scope.seq, 4);
  assert.equal(readHomeState(home).members.m_dev_1.unpair_reason, undefined);
  const rows = inboxLines(home).map(l => l.record);
  assert.deepEqual(rows.find(r => r.seq === 10), original);
  assert.equal(rows.filter(r => r.seq === 4).length, 1);
  assert.equal(rows.filter(r => r.seq === 80).length, legacy ? 1 : 0);
  assert.ok(fs.readFileSync(join(home, 'inbox', days[2] + '.jsonl'), 'utf8').includes(text));
  spy.disarm();
  assert.equal((await inbound.receive({ ...message, seq: 5 })).status, 'duplicate');
  bounds(spy.transactions.at(-1)); assert.equal(emitted.length, 2);
});

const mutations = [
  { name: 'same-inode growth with a complete row and partial tail', change(home) { put(home, row(80, days[2], { cursor: 80 }), '{"interrupted":'); }, high: 80, affected: days[2] },
  { name: 'same-size same-inode rewrite', change(home) {
    const path = join(home, 'inbox', days[2] + '.jsonl'), text = fs.readFileSync(path, 'utf8');
    const rewritten = text.replace('"seq":3,"cursor":3', '"seq":8,"cursor":8');
    assert.equal(rewritten.length, text.length); assert.notEqual(rewritten, text);
    fs.writeFileSync(path, rewritten); fs.utimesSync(path, 1, 1);
  }, high: 8, affected: days[2] },
  { name: 'target replacement', change(home) {
    const path = join(home, 'inbox', days[2] + '.jsonl'); fs.renameSync(path, path + '.old');
    fs.unlinkSync(path + '.old'); put(home, row(80, days[2], { cursor: 80 }));
  }, high: 80, affected: days[2] },
  { name: 'target replacement reusing the inode', change(home) {
    const path = join(home, 'inbox', days[2] + '.jsonl'), old = fs.statSync(path), replacement = JSON.stringify(row(80, days[2], { cursor: 80 })) + '\n';
    assert.ok(replacement.length > old.size);
    fs.unlinkSync(path); put(home, row(80, days[2], { cursor: 80 })); inodeAliases.set(fs.statSync(path).ino, old.ino);
  }, high: 80, affected: days[2] },
  { name: 'target creation', day: '2026-11-06', change(home) { put(home, row(80, '2026-11-06', { cursor: 80 })); }, high: 80 },
  { name: 'other day creation', change(home) { put(home, row(80, '2026-11-02', { cursor: 80 })); }, high: 80 },
  { name: 'other day removal', change(home) { fs.unlinkSync(join(home, 'inbox', days[0] + '.jsonl')); }, high: 3 },
  { name: 'target removal', change(home) { fs.unlinkSync(join(home, 'inbox', days[2] + '.jsonl')); }, high: 3 }
];
for (const phase of ['lookup', 'append', 'target']) for (const mutation of mutations) {
  if (phase === 'target' && mutation.name.startsWith('other day')) continue;
  test(`${mutation.name} at ${phase} refreshes only affected indexes and cursor maxima`, async t => {
    const { home, transport } = setup(t); seed(home); let fired = false;
    t.after(() => inodeAliases.clear());
    const spy = trace(home, (op, path, active) => {
      if (!active || fired) return;
      if (phase === 'lookup' && op === 'work' && path === 'findInboxSequence'
        || phase === 'append' && op === 'work' && path === 'appendInboxLocked'
        || phase === 'target' && op === 'renameSync' && path.includes('/..inbox-cursor.json.')) {
        fired = true; mutation.change(home);
      }
    });
    const inbound = receiver(home, transport, spy);
    const result = await inbound.receive(await delivery(transport, 4, sync('all')), { receivedAt: (mutation.day ?? days[2]) + 'T12:00:00Z' });
    assert.equal(fired, true); assert.equal(result.status, 'stored');
    const indexes = Object.fromEntries(days.map(day => [day + '.jsonl.json', day === mutation.affected ? 2 : 1]));
    bounds(spy.transactions[0], { searches: phase === 'lookup' ? 1 : 2, collections: 2, indexes });
    const rows = inboxLines(home).map(l => l.record), accepted = rows.find(r => r.seq === 4);
    assert.equal(accepted.cursor, mutation.high + 1);
    if (mutation.high === 80) assert.equal(rows.filter(r => r.seq === 80).length, 1);
    if (mutation.name.startsWith('same-inode')) assert.equal(rows.filter(r => r.seq === 3).length, 1);
    assert.equal(readHomeState(home).transport.inbox_committed_cursor, accepted.cursor);
  });
}

for (const phase of ['append', 'target']) for (const duplicate of [false, true]) test(`a fresh ${duplicate ? 'hit' : 'conflict'} at ${phase} invalidates a cached miss`, async t => {
  const { home, transport } = setup(t); seed(home); let fired = false, emissions = 0;
  const incoming = identified(4, 80); incoming.inner = sync(duplicate ? 'all' : 'none');
  const spy = trace(home, (op, path, active) => {
    if (active && !fired && (phase === 'append' && op === 'work' && path === 'appendInboxLocked'
      || phase === 'target' && op === 'renameSync' && path.includes('/..inbox-cursor.json.'))) {
      fired = true; put(home, incoming);
    }
  });
  const inbound = receiver(home, transport, spy, { onRecord: () => emissions++ });
  const message = await delivery(transport, 4, sync('all'));
  if (duplicate) {
    assert.equal((await inbound.receive(message)).status, 'stored');
    assert.equal(emissions, 1); assert.equal(readHomeState(home).transport.inbox_committed_cursor, 80);
    assert.ok(spy.transactions[0].synced.includes(join(home, 'inbox', days[2] + '.jsonl')));
  } else {
    await assert.rejects(inbound.receive(message), { code: 'invalid_state', message: 'inbox sequence conflict' });
    assert.equal(emissions, 0); assert.equal(readHomeState(home).members.m_dev_1.scope, undefined);
  }
  assert.equal(fired, true);
  bounds(spy.transactions[0], { searches: 2, collections: 2, indexes: Object.fromEntries(days.map(day => [day + '.jsonl.json', day === days[2] ? 2 : 1])) });
  assert.equal(inboxLines(home).filter(l => l.record.seq === 4).length, 1);
});

test('a non-target day growing during the reservation read refreshes cursor maxima', async t => {
  const { home, transport } = setup(t); seed(home); let fired = false;
  const emitted = [], spy = trace(home, (op, path, active) => {
    if (active && !fired && op === 'readFileSync' && path === join(home, '.inbox-cursor.json')) {
      fired = true; put(home, row(80, days[0], { cursor: 80 }));
    }
  });
  const inbound = receiver(home, transport, spy, { onRecord: record => emitted.push(record.cursor) });
  assert.equal((await inbound.receive(await delivery(transport, 4))).status, 'stored');
  assert.equal(fired, true);
  assert.deepEqual(emitted, [81]);
  assert.equal(JSON.parse(fs.readFileSync(join(home, '.inbox-cursor.json'))).cursor, 81);
  assert.equal(readHomeState(home).transport.inbox_committed_cursor, 81);
  const rows = inboxLines(home).map(line => line.record);
  assert.equal(rows.find(record => record.seq === 80).cursor, 80);
  assert.equal(rows.find(record => record.seq === 3).cursor, 3);
  bounds(spy.transactions[0], { searches: 2, collections: 2, indexes: Object.fromEntries(days.map(day => [day + '.jsonl.json', day === days[0] ? 2 : 1])) });
});

for (const legacy of [false, true]) test(`${legacy ? 'legacy' : 'committed'} reservation-read refresh preserves sequential stat/index fault ordering`, async t => {
  const { home, transport } = setup(t); seed(home);
  let fired = false, emissions = 0, before;
  const target = join(home, 'inbox', days[2] + '.jsonl'), original = fs.readFileSync(target, 'utf8');
  const spy = trace(home, (op, path, active) => {
    if (active && !fired && op === 'readFileSync' && path === join(home, '.inbox-cursor.json')) {
      fired = true; put(home, row(80, days[0], { cursor: 80 }));
      fs.writeFileSync(join(home, '.inbox-index', days[0] + '.jsonl.json'), '{}\n');
      fs.chmodSync(target, 0o644);
    }
  });
  const inbound = receiver(home, transport, spy, { inject() {
    if (legacy) updateHomeState(home, s => { delete s.transport.inbox_committed_cursor; });
    before = readHomeState(home);
  }, onRecord: () => emissions++ });
  await assert.rejects(inbound.receive(await delivery(transport, 4, sync('all'))), {
    code: 'corrupt_state', message: 'invalid inbox seek metadata'
  });
  assert.equal(fired, true); assert.equal(emissions, 0);
  assert.deepEqual(readHomeState(home), before);
  assert.equal(fs.readFileSync(target, 'utf8'), original);
  assert.equal(JSON.parse(fs.readFileSync(join(home, '.inbox-cursor.json'))).cursor, 3);
  assert.deepEqual(spy.transactions[0].indexes, Object.fromEntries(days.map(day => [day + '.jsonl.json', day === days[0] ? 2 : 1])));
});

for (const boundary of ['admit lookup', 'append lookup', 'duplicate hit', 'duplicate miss', 'append duplicate', 'reservation read', 'earlier target', 'later target']) {
  for (const legacy of [false, true]) test(`${legacy ? 'legacy' : 'committed'} ${boundary} paired faults retain HEAD error precedence`, async t => {
    const { home, transport } = setup(t); seed(home);
    const message = await delivery(transport, 4, sync('all'));
    if (boundary === 'append duplicate') {
      createInbox(home).append(row(4, days[2], { inner: sync('all') }));
      updateHomeState(home, s => { s.transport.inbox_committed_cursor = 4; });
    } else if (boundary.startsWith('duplicate')) {
      await createThinInbound({ home, transport, self, now }).receive(message);
    }
    const targetDay = boundary === 'earlier target' ? days[0] : days[2];
    const target = join(home, 'inbox', targetDay + '.jsonl');
    const original = fs.readFileSync(target, 'utf8');
    let fired = false, emissions = 0, before;
    const spy = trace(home, (op, path, active) => {
      if (!active || fired) return;
      const trigger = boundary === 'admit lookup' ? op === 'work' && path === 'admitLookup'
        : boundary.startsWith('duplicate') ? op === 'work' && path === 'duplicateLookup'
        : boundary.startsWith('append') ? op === 'work' && path === 'appendInboxLocked'
        : boundary === 'reservation read' ? op === 'readFileSync' && path === join(home, '.inbox-cursor.json')
        : op === 'renameSync' && path.includes('/..inbox-cursor.json.');
      if (!trigger) return;
      fired = true;
      const corruptDay = boundary.endsWith('target') ? targetDay : days[0];
      put(home, row(80, corruptDay, { cursor: 80 }));
      fs.writeFileSync(join(home, '.inbox-index', corruptDay + '.jsonl.json'), '{}\n');
      fs.chmodSync(join(home, 'inbox', (corruptDay === days[2] ? days[0] : days[2]) + '.jsonl'), 0o644);
    });
    const inbound = receiver(home, transport, spy, { inject() {
      if (legacy) updateHomeState(home, s => { delete s.transport.inbox_committed_cursor; });
      before = readHomeState(home);
    }, onRecord: () => emissions++ });
    const indexFirst = boundary === 'reservation read' || boundary.endsWith('target');
    await assert.rejects(inbound.receive(boundary === 'duplicate miss' ? { ...message, seq: 5 } : message, { receivedAt: targetDay + 'T12:00:00Z' }), {
      code: indexFirst ? 'corrupt_state' : 'insecure_permissions',
      message: indexFirst ? 'invalid inbox seek metadata' : 'thin home requires private regular files and directories'
    });
    assert.equal(fired, true); assert.equal(emissions, 0);
    assert.deepEqual(readHomeState(home), before);
    if (!boundary.endsWith('target')) assert.equal(fs.readFileSync(target, 'utf8'), original);
    assert.equal(JSON.parse(fs.readFileSync(join(home, '.inbox-cursor.json'))).cursor, boundary.endsWith('target') ? 4 : boundary.startsWith('duplicate') || boundary === 'append duplicate' ? 4 : 3);
  });
}

for (const target of ['unchanged', 'absent']) test(`${target} final target ignores paired faults in unrelated days as HEAD does`, async t => {
  const { home, transport } = setup(t); seed(home);
  let fired = false;
  const spy = trace(home, (op, path, active) => {
    if (active && !fired && op === 'renameSync' && path.includes('/..inbox-cursor.json.')) {
      fired = true; put(home, row(80, days[0], { cursor: 80 }));
      fs.writeFileSync(join(home, '.inbox-index', days[0] + '.jsonl.json'), '{}\n');
      fs.chmodSync(join(home, 'inbox', days[1] + '.jsonl'), 0o644);
    }
  });
  const emitted = [], targetDay = target === 'unchanged' ? days[2] : '2026-11-06';
  assert.equal((await receiver(home, transport, spy, { onRecord: record => emitted.push(record.cursor) }).receive(await delivery(transport, 4, sync('all')), { receivedAt: targetDay + 'T12:00:00Z' })).status, 'stored');
  assert.equal(fired, true); assert.deepEqual(emitted, [4]);
  assert.equal(readHomeState(home).transport.inbox_committed_cursor, 4);
  assert.equal(JSON.parse(fs.readFileSync(join(home, 'inbox', targetDay + '.jsonl'), 'utf8').trim().split('\n').at(-1)).cursor, 4);
  bounds(spy.transactions[0]);
});

for (const state of ['cold', 'missing', 'v1']) test(`standalone append reconstructs ${state} indexes and observes separate transactions`, t => {
  const { home } = setup(t); seed(home);
  const index = join(home, '.inbox-index', days[2] + '.jsonl.json');
  if (state === 'cold') fs.rmSync(join(home, '.inbox-index'), { recursive: true });
  if (state === 'missing') fs.unlinkSync(index);
  if (state === 'v1') fs.writeFileSync(index, '{"version":1}\n');
  fs.unlinkSync(join(home, '.inbox-cursor.json'));
  const spy = trace(home); spy.arm();
  const inbox = measured.createInbox(home, { fs: spy.fs });
  assert.equal(inbox.append(row(0)).inserted, true);
  bounds(spy.transactions[0], { indexes: state === 'cold' ? {} : Object.fromEntries(days.filter(day => state === 'v1' || day !== days[2]).map(day => [day + '.jsonl.json', 1])) });
  assert.equal(inboxLines(home).find(l => l.record.seq === 0).record.cursor, 4);
  put(home, row(80, days[1], { cursor: 80 }), '{"partial":');
  fs.writeFileSync(join(home, '.inbox-cursor.json'), '{"cursor":100}\n');
  assert.equal(inbox.append(row(1, days[2], { seq: 5 })).inserted, true);
  bounds(spy.transactions[1]);
  assert.equal(inboxLines(home).find(l => l.record.seq === 5).record.cursor, 101);
  assert.equal(inbox.append(row(5)).inserted, false);
  bounds(spy.transactions[2]);
  assert.equal(JSON.parse(fs.readFileSync(index)).version, 2);
});

test('locked append still compares parsed inner text against a reused sequence hit', t => {
  const { home } = setup(t); seed(home);
  const spy = trace(home); spy.arm();
  assert.throws(() => measured.createInbox(home, { fs: spy.fs }).append(row(3), { innerText: JSON.stringify(sync('all')) }), { code: 'invalid_state', message: 'inbox sequence conflict' });
  bounds(spy.transactions[0]); assert.equal(inboxLines(home).length, 3);
});

test('standalone reconciliation emits recovered rows once after a lock retry commits', async t => {
  const { home, transport } = setup(t); seed(home);
  const records = [identified(10), identified(11)];
  records[0].inner = sync('all');
  for (const record of records) put(home, record);
  const emitted = []; let commits = 0;
  const spy = trace(home, (op, path) => {
    if (op === 'renameSync' && path.includes('/.state.json.')) {
      commits++;
      assert.equal(emitted.length, 0);
      assert.equal(readHomeState(home).transport.inbox_committed_cursor, 3);
      if (commits === 1) throw Object.assign(new Error('fixture lock retry'), { code: 'home_locked' });
    }
  });
  const inbound = createThinInbound({ home, transport, self, now, fs: spy.fs, onRecord(record) {
    assert.equal(readHomeState(home).transport.inbox_committed_cursor, 11);
    assert.deepEqual(readHomeState(home).members.m_dev_1.scope, { read: 'none', write: 'none', seq: 11 });
    emitted.push(record);
  } });
  await inbound.reconcile();
  assert.equal(commits, 2);
  assert.deepEqual(emitted, records);
  await inbound.reconcile();
  assert.equal(commits, 2);
  assert.deepEqual(emitted, records);
});

test('an admission lock retry discards its recovery emissions and reconstructs its view', async t => {
  const { home, transport } = setup(t); seed(home);
  const original = identified(10); original.inner = sync('all');
  let injected = false, failed = false;
  const spy = trace(home, (op, path, active) => {
    if (active && op === 'renameSync' && path.includes('/.state.json.') && !failed) {
      failed = true; throw Object.assign(new Error('fixture lock retry'), { code: 'home_locked' });
    }
  });
  const emitted = [], inbound = receiver(home, transport, spy, { inject() {
    assert.equal(injected, false); injected = true; put(home, original, '{"partial":');
  }, onRecord: record => emitted.push(record) });
  assert.equal((await inbound.receive(await delivery(transport, 4, sync('none')))).status, 'duplicate');
  assert.equal(failed, true); assert.equal(spy.transactions.length, 2);
  for (const stats of spy.transactions) bounds(stats);
  assert.deepEqual(emitted.map(record => record.seq), [10, 4]);
  assert.deepEqual(emitted[0], original);
  assert.equal(inboxLines(home).filter(line => line.record.seq === 4).length, 1);
});

for (const legacy of [false, true]) test(`${legacy ? 'legacy' : 'committed'} refresh preserves paired stat/index fault ordering`, async t => {
  const { home, transport } = setup(t); seed(home); let fired = false, emissions = 0;
  const spy = trace(home, (op, name, active) => {
    if (active && !fired && op === 'work' && name === 'appendInboxLocked') {
      fired = true; put(home, row(80, days[0], { cursor: 80 }));
      fs.writeFileSync(join(home, '.inbox-index', days[0] + '.jsonl.json'), '{}\n');
      fs.chmodSync(join(home, 'inbox', days[2] + '.jsonl'), 0o644);
    }
  });
  const inbound = receiver(home, transport, spy, { inject() {
    if (legacy) updateHomeState(home, s => { delete s.transport.inbox_committed_cursor; });
  }, onRecord: () => emissions++ });
  await assert.rejects(inbound.receive(await delivery(transport, 4)), {
    code: 'insecure_permissions',
    message: 'thin home requires private regular files and directories'
  });
  assert.equal(fired, true); assert.equal(emissions, 0);
  assert.deepEqual(spy.transactions[0].indexes, Object.fromEntries(days.map(day => [day + '.jsonl.json', 1])));
  assert.equal(readHomeState(home).members.m_dev_1.scope, undefined);
});

for (const conflict of [false, true]) test(`duplicate freshness turns a cached hit into a ${conflict ? 'conflict' : 'miss'}`, async t => {
  const { home, transport } = setup(t); seed(home);
  const message = await delivery(transport, 4, sync('all'));
  await createThinInbound({ home, transport, self, now }).receive(message);
  let fired = false, emissions = 0;
  const spy = trace(home), path = join(home, 'inbox', days[2] + '.jsonl');
  const inbound = receiver(home, transport, spy, { clock() {
    if (!fired && spy.transactions.at(-1)?.calls.findInboxSequence === 1) {
      fired = true;
      const original = fs.readFileSync(path, 'utf8'), records = original.trim().split('\n').map(line => JSON.parse(line));
      if (conflict) records.at(-1).inner = sync('off'); else records.pop();
      const rewritten = records.map(record => JSON.stringify(record) + '\n').join('');
      if (conflict) assert.equal(Buffer.byteLength(rewritten), Buffer.byteLength(original));
      fs.writeFileSync(path, rewritten);
    }
    return now();
  }, onRecord: () => emissions++ });
  if (conflict) await assert.rejects(inbound.receive(message), { code: 'invalid_state', message: 'inbox sequence conflict' });
  else assert.equal((await inbound.receive(message)).status, 'duplicate');
  assert.equal(fired, true); assert.equal(emissions, 0);
  bounds(spy.transactions[0], { searches: 2, collections: 2, indexes: Object.fromEntries(days.map(day => [day + '.jsonl.json', day === days[2] ? 2 : 1])) });
  assert.equal(readHomeState(home).members.m_dev_1.scope.seq, 4);
});

for (const mode of ['append search', 'duplicate search', 'metadata traversal']) test(`work assertions reject a reintroduced ${mode} with cached indexes`, async t => {
  let changedInbox = inboxSource, changedInbound = fs.readFileSync(inboundUrl, 'utf8');
  if (mode === 'append search') changedInbox = changedInbox.replace('const existing = lookup();', 'const existing = lookup(); findInboxSequence(home, { ...record, inner }, { ...options, view });');
  if (mode === 'duplicate search') changedInbound = changedInbound.replace('const existing = admissionInboxSequence(home, record, { ...options, view });', 'const existing = admissionInboxSequence(home, record, { ...options, view }); findInboxSequence(home, record, { ...options, view });')
    .replace('appendInboxLocked, admissionInboxSequence,', 'appendInboxLocked, findInboxSequence, admissionInboxSequence,');
  if (mode === 'metadata traversal') changedInbox = changedInbox
    .replace('export function inboxMetadata(home, options = {}) {', 'export function inboxMetadata(home, options = {}) {\n  if (options.view) { work.hit("inboxMetadata"); return [...options.view.indexes].map(([name, index]) => ({ name, index })); }')
    .replace('const reserved = inboxCursor(home, options);', 'const reserved = inboxCursor(home, options); for (const { index } of inboxMetadata(home, { ...options, view })) Math.max(view.high, index.blocks.at(-1)?.last ?? -1);');
  assert.ok(changedInbox !== inboxSource || changedInbound !== fs.readFileSync(inboundUrl, 'utf8'));
  const mutantUrl = moduleUrl(instrument(changedInbox, inboxSourceUrl)), mutant = await import(mutantUrl);
  const { createThinInbound: factory } = await import(moduleUrl(instrument(changedInbound, inboundUrl, mutantUrl)));
  const { home, transport } = setup(t); seed(home);
  const message = await delivery(transport, 4, sync('all'));
  if (mode === 'duplicate search') await createThinInbound({ home, transport, self, now }).receive(message);
  const spy = trace(home, undefined, mutant.work);
  await receiver(home, transport, spy, { factory }).receive(message);
  assert.deepEqual(spy.transactions[0].indexes, Object.fromEntries(days.map(day => [day + '.jsonl.json', 1])));
  assert.throws(() => bounds(spy.transactions[0]), mode === 'metadata traversal' ? /whole-inbox metadata passes/ : /incoming sequence searches/);
});
