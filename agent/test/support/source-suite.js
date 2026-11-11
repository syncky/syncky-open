import { spawn } from "node:child_process";
import { existsSync, globSync, realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

export const AGENT = fileURLToPath(new URL("../../", import.meta.url));
export const TEST_GLOBS = ["test/unit/**/*.test.js", "test/vectors/**/*.test.js"];
export const COVERAGE_FLAGS = ["--experimental-test-coverage", "--test-coverage-include=src/**/*.js", "--test-coverage-exclude=test/**", "--test-coverage-lines=85", "--test-coverage-branches=75", "--test-coverage-functions=85"];

export function discoverTests(patterns = TEST_GLOBS, cwd = AGENT) {
  return [...globSync(patterns, { cwd })].sort();
}

export function sourceArgs(coverage = process.env.SYNCKY_TEST_COVERAGE ?? "on") {
  if (!["on", "off"].includes(coverage)) throw new Error("SYNCKY_TEST_COVERAGE must be on or off");
  return ["--test", ...(coverage === "on" ? COVERAGE_FLAGS : []), ...TEST_GLOBS];
}

export async function runSourceSuite(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === "--list-test-files") {
    process.stdout.write(JSON.stringify(discoverTests()) + "\n");
    return 0;
  }
  if (args.length) throw new Error("unexpected source-suite arguments");
  const env = { ...process.env };
  delete env.NODE_V8_COVERAGE;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, sourceArgs(), { cwd: AGENT, env, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", code => resolve(code ?? 1));
  });
}

if (process.argv[1] && existsSync(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) process.exitCode = await runSourceSuite();
