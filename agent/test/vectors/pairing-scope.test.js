import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pairingScopeCases } from '../../src/selftest.js';
import { loadVectors } from '../support/protocol-files.js';

const cases = pairingScopeCases(loadVectors('pairing-scope'));
assert.ok(cases.length > 0, 'pairing scope vectors are missing');
for (const { name, fn } of cases) test(name, fn);
