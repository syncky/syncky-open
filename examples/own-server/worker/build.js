import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const result = spawnSync(process.execPath, [fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url)), "deploy", "--dry-run", "--outdir", "dist/worker"], {
  cwd: fileURLToPath(new URL("../", import.meta.url)),
  env: { ...process.env, WRANGLER_SEND_METRICS: "false", WRANGLER_LOG_PATH: ".wrangler/logs/build.log" },
  encoding: "utf8",
});
const warned = /\bwarn(?:ing)?\b/i.test((result.stdout ?? "") + (result.stderr ?? ""));
if (result.error || result.status !== 0 || warned) {
  process.stderr.write(warned ? "Worker dry run failed: warnings present.\n" : "Worker dry run failed.\n");
  process.exitCode = result.status || 1;
} else {
  process.stdout.write("Worker dry run passed without warnings.\n");
}
