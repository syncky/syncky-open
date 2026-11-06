import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadVectors } from '../../src/protocol-files.js';
import { createInbox } from '../../src/inbox.js';
import { fixture } from '../support/thin-home.js';

for (const c of loadVectors('series-parts').cases) test(`raw series arrivals stay separate, including conflicts: ${c.name}`, t => {
  const inbox = createInbox(fixture(t));
  const arrivals = c.arrival.map(a => Object.hasOwn(a, 'part') ? c.parts[a.part] : c.conflicts[a.conflict]);
  arrivals.forEach((part, i) => inbox.append({ seq: i + 1, from: 'm_dev_1', kind: 'data', type: 'sync', received_at: '2026-11-05T12:00:00Z', inner: { v: 1, type: 'sync', samples: [part] } }));
  assert.deepEqual(inbox.read().map(r => r.inner.samples[0]), arrivals);
  assert.equal(inbox.read().length, c.arrival.length);
});
