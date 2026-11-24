import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "syncky shipped bundle "));
try {
  const bundle = join(root, "syncky-agent.mjs");
  copyFileSync(new URL("../../dist/syncky-agent.mjs", import.meta.url), bundle);
  const result = spawnSync(process.execPath, [bundle, "help"], {
    cwd: root,
    env: { HOME: root, TMPDIR: root, PATH: "" },
    encoding: "utf8",
    timeout: 15_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.trim(), "shipped CLI launched without displaying help");
} finally {
  rmSync(root, { recursive: true, force: true });
}
