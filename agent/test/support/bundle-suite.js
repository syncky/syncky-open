import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";
import { discoverTests } from "./source-suite.js";
export { discoverTests } from "./source-suite.js";

const AGENT = fileURLToPath(new URL("../../", import.meta.url));

export function suiteFiles(pkg = JSON.parse(readFileSync(join(AGENT, "package.json"), "utf8"))) {
  assert.equal(pkg.scripts.test, "node test/support/source-suite.js", "source/bundle test inventories differ: unexpected source runner");
  const source = spawnSync(process.execPath, [join(AGENT, "test/support/source-suite.js"), "--list-test-files"], { encoding: "utf8" });
  assert.equal(source.status, 0, source.stderr);
  const files = discoverTests();
  assert.ok(files.length > 0, "empty bundle test inventory");
  assert.deepEqual(JSON.parse(source.stdout), files, "source/bundle test inventories differ");
  return files;
}

export async function sourceModuleExports() {
  const files = readdirSync(join(AGENT, "src")).filter((file) => file.endsWith(".js")).sort();
  const result = await build({
    absWorkingDir: AGENT,
    entryPoints: files.map((file) => `src/${file}`),
    outdir: "export-inventory",
    bundle: false,
    platform: "node",
    format: "esm",
    metafile: true,
    write: false,
  });
  return Object.fromEntries(Object.values(result.metafile.outputs).map((output) => [basename(output.entryPoint), output.exports.sort()]));
}

export async function runBundleSuite() {
  if (process.env.SYNCKY_AGENT_BUNDLE_FIXTURE) throw new Error("nested bundle suite is forbidden");
  const files = suiteFiles();
  const root = mkdtempSync(join(tmpdir(), "syncky-bundle-suite-"));
  try {
    const { buildAgent } = await import("../../build.mjs");
    const release = await buildAgent();
    const repeat = await buildAgent({ outdir: join(root, "repeat") });
    const fixture = join(root, "fixture.json");
    writeFileSync(fixture, JSON.stringify({ release, repeat, exports: await sourceModuleExports() }));
    const args = ["--import", fileURLToPath(new URL("./register-bundle.js", import.meta.url)), "--test", ...files];
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, args, {
        cwd: AGENT,
        env: { ...process.env, SYNCKY_AGENT_BIN: release.bundlePath, SYNCKY_AGENT_BUNDLE_FIXTURE: fixture },
        stdio: "inherit",
      });
      child.on("error", reject);
      child.on("close", (code) => resolve(code ?? 1));
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && existsSync(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) process.exitCode = await runBundleSuite();
