import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadVectors } from '../../src/protocol-files.js';
import { parseRawInner } from '../../src/thin-transport.js';
import { createValidator } from '../support/validator.js';

const { cases } = loadVectors('inner-messages');
const validator = await createValidator();
for (const c of cases) test(`raw inner transport: ${c.name}`, () => {
  let json;
  try { json = JSON.parse(c.json); } catch {}
  if (!json || Array.isArray(json) || typeof json.type !== 'string') {
    assert.throws(() => parseRawInner(c.json), { code: 'inner_invalid' }); return;
  }
  const result = parseRawInner(c.json);
  assert.deepEqual(result.inner, json); assert.equal(result.innerText, c.json);
  if (c.normalized) {
    const type = c.normalized.type;
    const schema = type === 'sync' ? 'inner-sync.schema.json' : type === 'commands' ? 'inner-commands.schema.json' : type === 'diagnostics' ? 'inner-diagnostics.schema.json' : 'inner-system.schema.json';
    if ((type === 'sync' && typeof c.normalized.device === 'string') || type === 'diagnostics' || (c.kind === 'control' && type !== 'future_notice')) assert.equal(validator.validate(schema, type, c.normalized).ok, true, c.name);
  }
});
