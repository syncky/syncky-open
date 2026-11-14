import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { AGENT, discoverTests, sourceArgs, UNIT_SYNC_PRELOAD, unitTestEnv } from "../support/source-suite.js";

test("unit sync inheritance is confined to the runner's child environment", () => {
  const env = { NODE_OPTIONS: "--disable-warning=ExperimentalWarning", SYNCKY_HOME: "fixture" };
  assert.deepEqual(unitTestEnv(env), { ...env, NODE_OPTIONS: `${env.NODE_OPTIONS} --import=${UNIT_SYNC_PRELOAD}` });
  assert.equal(env.NODE_OPTIONS, "--disable-warning=ExperimentalWarning");
  assert.deepEqual(unitTestEnv({}), { NODE_OPTIONS: `--import=${UNIT_SYNC_PRELOAD}` });
});

test("source suite preserves exact full coverage gates, defaults and complete scoped inventory", () => {
  const flags = ["--experimental-test-coverage", "--test-coverage-include=src/**/*.js", "--test-coverage-exclude=test/**", "--test-coverage-lines=85", "--test-coverage-branches=75", "--test-coverage-functions=85"];
  const globs = ["test/unit/**/*.test.js", "test/vectors/**/*.test.js"];
  assert.deepEqual(sourceArgs("on"), ["--test", ...flags, ...globs]);
  assert.deepEqual(sourceArgs("off"), ["--test", ...globs]);
  assert.deepEqual(sourceArgs(undefined), sourceArgs(process.env.SYNCKY_TEST_COVERAGE ?? "on"));
  assert.throws(() => sourceArgs("invalid"), /SYNCKY_TEST_COVERAGE/);
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.scripts.test, "node test/support/source-suite.js");
  const result = spawnSync(process.execPath, ["test/support/source-suite.js", "--list-test-files"], { cwd: AGENT, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), discoverTests(globs));
  assert.ok(JSON.parse(result.stdout).length > 0);
});
