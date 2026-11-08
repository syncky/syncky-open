import { it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parseEnv } from "node:util";

const read = name => readFileSync(new URL("../../" + name, import.meta.url), "utf8");
it("packages the exact Node base, package-only context, non-root volume and no installed dependencies", () => {
  const docker = read("docker/Dockerfile");
  assert.match(docker, /^FROM node:22\.15\.0-bookworm-slim$/m);
  for (const expected of ["USER node", "VOLUME /data", "EXPOSE 3000", 'CMD ["node", "docker/server.js"]', "COPY package.json", "COPY src/", "COPY docker/"]) assert.ok(docker.includes(expected));
  assert.match(docker, /chown[^\n]*node:node[^\n]*\/data/);
  assert.doesNotMatch(docker, /npm |node_modules|ADMIN_PASSWORD|COPY \.|ADD |curl|wget/);
  const compose = read("docker/compose.yaml");
  for (const expected of ["context: ..", "dockerfile: docker/Dockerfile", '"127.0.0.1:3000:3000"', "ADMIN_PASSWORD:", "PUBLIC_URL:", ":/data", "/health", "127.0.0.1"]) assert.ok(compose.includes(expected));
  assert.doesNotMatch(compose, /privileged|network_mode|\/var\/run|image:.*latest/);
  for (const file of [".dockerignore", ".gitignore"]) for (const state of ["node_modules", ".wrangler", ".env", ".dev.vars", ".sqlite"]) assert.ok(read(file).includes(state));
});

it("Worker config declares local-only bindings and required secret validation", () => {
  const c = JSON.parse(read("wrangler.jsonc"));
  assert.equal(c.compatibility_date, "2026-08-01");
  assert.equal(c.workers_dev, true);
  assert.equal(c.send_metrics, false);
  assert.equal(c.observability.enabled, false);
  assert.deepEqual(c.secrets, { required: ["ADMIN_PASSWORD"] });
  assert.deepEqual(c.migrations, [{ tag: "v1", new_sqlite_classes: ["OwnServer"] }]);
  assert.deepEqual(c.durable_objects.bindings, [{ name: "OWN_SERVER", class_name: "OwnServer" }]);
  assert.equal(c.vars.DO_JURISDICTION, "eu");
  for (const key of ["account_id", "routes", "route", "triggers", "analytics_engine_datasets", "compatibility_flags"]) assert.equal(Object.hasOwn(c, key), false);
  assert.equal(Object.hasOwn(c.vars, "ADMIN_PASSWORD"), false);
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.scripts["build:worker"], "node worker/build.js");
  assert.match(read("worker/build.js"), /--dry-run/);
  assert.match(read("worker/build.js"), /warn/i);
});

it("Deploy discovers only the admin password from an empty secret example", () => {
  const secrets = parseEnv(read(".dev.vars.example"));
  assert.deepEqual(secrets, { ADMIN_PASSWORD: "" });
  assert.deepEqual(Object.keys(secrets), JSON.parse(read("wrangler.jsonc")).secrets.required);
});

it("Worker dry-run wrapper fails on a warning or child failure and never exposes child output", t => {
  const root = mkdtempSync(join(tmpdir(), "own-server-build-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "worker"));
  mkdirSync(join(root, "node_modules/wrangler/bin"), { recursive: true });
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  writeFileSync(join(root, "worker/build.js"), read("worker/build.js"));
  const cli = join(root, "node_modules/wrangler/bin/wrangler.js");
  for (const [script, status] of [["process.stdout.write('build finished')", 0], ["process.stderr.write('WARNING private_sentinel')", 1], ["process.stdout.write('private_sentinel'); process.exitCode=7", 7]]) {
    writeFileSync(cli, script);
    const child = spawnSync(process.execPath, [join(root, "worker/build.js")], { encoding: "utf8" });
    assert.equal(child.status, status);
    assert.ok(!child.stdout.includes("private_sentinel") && !child.stderr.includes("private_sentinel"), "build output does not disclose child values");
  }
});

it("all runtime imports stay local; only Worker entry dispatches; no egress, logging or private references", () => {
  for (const directory of ["src", "worker", "docker"]) for (const name of readdirSync(new URL("../../" + directory + "/", import.meta.url)).filter(f => f.endsWith(".js") && f !== "build.js")) {
    const source = read(directory + "/" + name);
    assert.doesNotMatch(source, /console\.|globalThis\.fetch|\b(?:await|return)\s+fetch\s*\(|https?:\/\/|setInterval|setTimeout|WebSocket|XMLHttpRequest|cloudflare:sockets|\.request\s*\(/);
    if (directory !== "worker" || name !== "index.js") assert.doesNotMatch(source, /\.fetch\s*\(|\.getByName\s*\(|\.jurisdiction\s*\(/);
    assert.doesNotMatch(source, /C\u00a7|docs\/(?:planning|plans)|syncky\.app/);
    for (const [, specifier] of source.matchAll(/(?:from\s*|import\s*)["']([^"']+)["']/g)) assert.ok(specifier.startsWith(".") || directory === "docker" && ["node:http", "node:events", "node:stream", "node:stream/promises", "node:url", "node:sqlite"].includes(specifier) || directory === "worker" && specifier === "cloudflare:workers");
    if (directory === "docker" && name === "server.js") assert.match(source, /import \{ createServer \} from "node:http"/);
    if (directory !== "docker") assert.doesNotMatch(source, /node:|\bBuffer\b|\brequire\s*\(/);
  }
});
