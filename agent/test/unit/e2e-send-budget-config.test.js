import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const stage = fileURLToPath(new URL('../e2e/send-budget.e2e.test.js', import.meta.url));
function run(vars = {}) {
  const env = { ...process.env };
  for (const key of ['NODE_TEST_CONTEXT', 'SYNCKY_E2E_RELAY', 'SYNCKY_E2E_SEND_INTERVAL_S', 'SYNCKY_E2E_SEND_BURST', 'SYNCKY_AGENT_SEND_BURST']) delete env[key];
  return spawnSync(process.execPath, ['--test', '--test-reporter=tap', stage], { env: { ...env, ...vars }, encoding: 'utf8', timeout: 15_000 });
}

test('budget stage fails when its interval is set without a valid e2e burst', () => {
  for (const burst of [undefined, '', '0', '-1', '1.5', 'bad']) {
    const result = run({ SYNCKY_E2E_SEND_INTERVAL_S: '10', SYNCKY_AGENT_SEND_BURST: '3', ...(burst === undefined ? {} : { SYNCKY_E2E_SEND_BURST: burst }) });
    assert.equal(result.status, 1);
    assert.match(result.stdout + result.stderr, /SYNCKY_E2E_SEND_BURST must be a positive integer/);
  }
});

test('budget stage accepts its own burst variable and skips without a relay', () => {
  const result = run({ SYNCKY_E2E_SEND_INTERVAL_S: '10', SYNCKY_E2E_SEND_BURST: '3' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /SKIP/);
});

test('budget stage remains optional when no interval is set', () => {
  const result = run();
  assert.equal(result.status, 0);
  assert.match(result.stdout, /SKIP/);
});
