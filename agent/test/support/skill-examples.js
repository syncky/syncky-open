import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

export const skillText = readFileSync(new URL('../../skills/syncky/SKILL.md', import.meta.url), 'utf8');

export function skillExample(type, overrides = {}, text = skillText) {
  const examples = [...text.matchAll(/<<'JSON'\n([^\n]+)\nJSON/g)].map(match => JSON.parse(match[1]));
  const matches = examples.filter(inner => inner.type === type);
  assert.equal(matches.length, 1, 'one executable skill example per outgoing feature');
  return { ...matches[0], ...overrides };
}
