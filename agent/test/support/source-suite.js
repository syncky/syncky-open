import { spawn } from "node:child_process";
import { existsSync, globSync, realpathSync } from "node:fs";
import { availableParallelism } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const AGENT = fileURLToPath(new URL("../../", import.meta.url));
const UNIT_SYNC_PRELOAD = new URL("./unit-sync.mjs", import.meta.url).href;
const TEST_GLOBS = ["test/unit/**/*.test.js", "test/vectors/**/*.test.js"];

function runNode(args, env, file) {
  return new Promise((resolve, reject) => {
    const stdio = file ? ["ignore", "pipe", "pipe"] : "inherit";
    const child = spawn(process.execPath, args, { cwd: AGENT, env, stdio });
    const output = [];
    child.stdout?.on("data", chunk => output.push(chunk));
    child.stderr?.on("data", chunk => output.push(chunk));
    child.once("error", reject);
    child.once("close", code => {
      if (file) process.stdout.write(Buffer.concat([Buffer.from(`\n${file}\n`), ...output]));
      resolve(code ?? 1);
    });
  });
}

async function runSourceSuite(args = process.argv.slice(2)) {
  if (args.length) throw new Error("unexpected source-suite arguments");
  const coverage = process.env.SYNCKY_TEST_COVERAGE ?? "off";
  if (!["on", "off"].includes(coverage)) throw new Error("SYNCKY_TEST_COVERAGE must be on or off");
  const env = { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${UNIT_SYNC_PRELOAD}`.trim() };
  delete env.NODE_V8_COVERAGE;
  delete env.NODE_TEST_CONTEXT;
  if (coverage === "on") return runNode(["--test", "--experimental-test-coverage", "--test-coverage-include=src/**/*.js", ...TEST_GLOBS], env);

  // Node 22 can spin at EOF while draining an incomplete V8 test report.
  // Run each file in its own process and collect its text report and exit status.
  const files = globSync(TEST_GLOBS, { cwd: AGENT }).sort();
  if (!files.length) throw new Error("no agent unit or vector tests found");
  let next = 0, failed = 0;
  async function worker() {
    while (next < files.length) {
      const file = files[next++];
      const code = await runNode(["--test-reporter=spec", file], env, file);
      if (code !== 0) failed++;
    }
  }
  const jobs = Math.min(files.length, Math.max(1, availableParallelism() - 1));
  await Promise.all(Array.from({ length: jobs }, worker));
  process.stdout.write(`\nAgent source tests: ${files.length} files, ${failed} failed\n`);
  return failed ? 1 : 0;
}

if (process.argv[1] && existsSync(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) process.exitCode = await runSourceSuite();
