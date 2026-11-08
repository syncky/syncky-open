import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createInbox } from "../../src/inbox.js";
import { diagnosticsFixture } from "../support/diagnostics.js";
import { startRelayDouble } from "../support/relay-double.js";

const AGENT = fileURLToPath(new URL("../../", import.meta.url));
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const INVENTORY = [
  "package/LICENSE", "package/NOTICE", "package/README.md", "package/dist/syncky-agent.mjs",
  "package/dist/syncky-agent.mjs.sha256", "package/package.json",
];
const ALLOWLIST = ["dist/syncky-agent.mjs", "dist/syncky-agent.mjs.sha256", "LICENSE", "NOTICE", "README.md"];
const REPOSITORY = { type: "git", url: "git+https://github.com/syncky/syncky-open.git", directory: "agent" };

describe("public npm package", () => {
  let root, staging, unpacked, packed, release, env, cwd, bin;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "syncky npm package "));
    staging = join(root, "source");
    cpSync(AGENT, staging, { recursive: true, filter: (path) => path !== join(AGENT, "node_modules") && path !== join(AGENT, "dist") });
    if (process.env.SYNCKY_AGENT_BUNDLE_FIXTURE) {
      release = json(process.env.SYNCKY_AGENT_BUNDLE_FIXTURE).release;
      cpSync(dirname(release.bundlePath), join(staging, "dist"), { recursive: true });
    } else {
      const { buildAgent } = await import("../../build.mjs");
      release = await buildAgent({ outdir: join(staging, "dist") });
    }
    for (const parts of [
      [".run", "sentinel"], [".env"], [".dev.vars"], ["secrets.json"], ["config.json"], ["agent.db"],
      [".syncky-agent", "sentinel"], ["cache", "sentinel"], ["src", "sentinel.js"], ["bin", "sentinel.js"],
      ["test", "sentinel.test.js"], ["node_modules", "sentinel", "index.js"],
      ["dist", "unlisted.mjs"], ["dist", "unlisted.tar.gz"], ["dist", "unlisted.mcpb"],
    ]) {
      const path = join(staging, ...parts);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "excluded npm fixture\n");
    }
    const destination = join(root, "packed");
    mkdirSync(destination);
    const pack = spawnSync("npm", ["pack", "--offline", "--ignore-scripts", "--json", "--pack-destination", destination, "--cache", join(root, "npm-cache")], {
      cwd: staging, encoding: "utf8", timeout: 60_000,
      env: { ...process.env, npm_config_offline: "true", npm_config_audit: "false", npm_config_fund: "false", npm_config_update_notifier: "false" },
    });
    assert.equal(pack.status, 0, "actual offline npm pack failed");
    const report = JSON.parse(pack.stdout);
    assert.equal(report.length, 1);
    const artifact = join(destination, report[0].filename);
    const listing = spawnSync("/usr/bin/tar", ["-tzf", artifact], { encoding: "utf8" });
    assert.equal(listing.status, 0, "npm archive inspection failed");
    assert.deepEqual(listing.stdout.trim().split("\n").sort(), INVENTORY);
    assert.deepEqual(report[0].files.map((file) => `package/${file.path}`).sort(), INVENTORY);
    assert.deepEqual(report[0].bundled, []);
    unpacked = join(root, "runtime");
    mkdirSync(unpacked);
    const extract = spawnSync("/usr/bin/tar", ["-xzf", artifact, "-C", unpacked]);
    assert.equal(extract.status, 0, "npm archive extraction failed");
    packed = json(join(unpacked, "package/package.json"));
    cwd = join(root, "unrelated cwd");
    mkdirSync(cwd);
    bin = join(root, "runtime bin");
    mkdirSync(bin);
    symlinkSync(process.execPath, join(bin, "node"));
    for (const name of ["syncky-agent", "syncky"]) symlinkSync(join(unpacked, "package", packed.bin[name]), join(bin, name));
    env = { PATH: bin, HOME: join(root, "home"), TMPDIR: tmpdir(), SYNCKY_AGENT_HOME: join(root, "agent home") };
  });
  after(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  function cli(args, extraEnv = {}, input = "", executable = "syncky-agent") {
    return new Promise((resolve) => {
      const child = spawn(join(bin, executable), args, { cwd, env: { ...env, ...extraEnv }, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "", stderr = "", timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 20_000);
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.stdin.on("error", () => {});
      child.on("error", () => { clearTimeout(timer); resolve({ code: -1, stdout: "", stderr: "spawn failed", timedOut }); });
      child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
      child.stdin.end(input);
    });
  }

  it("packs exactly six files and matches source identity, pins and public repository metadata", () => {
    const source = json(join(AGENT, "package.json"));
    const lock = json(join(AGENT, "package-lock.json"));
    assert.equal(source.name, "@syncky/agent");
    assert.equal(lock.name, source.name);
    assert.equal(lock.packages[""].name, source.name);
    assert.equal(lock.version, source.version);
    assert.equal(lock.packages[""].version, source.version);
    assert.deepEqual(lock.packages[""].dependencies, source.dependencies);
    assert.deepEqual(lock.packages[""].devDependencies, source.devDependencies);
    assert.deepEqual(lock.packages[""].engines, source.engines);
    assert.deepEqual(lock.packages[""].bin, source.bin);
    for (const metadata of [source, packed]) {
      assert.equal(metadata.name, "@syncky/agent");
      assert.equal(Object.hasOwn(metadata, "private"), false);
      assert.equal(metadata.version, source.version);
      assert.equal(metadata.mcpName, "io.github.syncky/syncky-health");
      assert.match(metadata.description, /Apple Health/);
      assert.match(metadata.description, /MCP/);
      assert.match(metadata.description, /AI agent/);
      assert.match(metadata.description, /end-to-end encrypted between your iPhone and the local Syncky agent/);
      assert.ok(metadata.description.length <= 200);
      assert.equal(metadata.description, source.description);
      assert.deepEqual(metadata.keywords, ["apple-health", "healthkit", "mcp", "mcp-server", "model-context-protocol", "ai-agent", "quantified-self", "e2ee", "hpke"]);
      assert.equal(metadata.homepage, "https://syncky.app/agents");
      assert.deepEqual(metadata.repository, REPOSITORY);
      assert.deepEqual(metadata.bin, { "syncky-agent": "dist/syncky-agent.mjs", "syncky": "dist/syncky-agent.mjs" });
      assert.deepEqual(metadata.files, ALLOWLIST);
      assert.equal(Object.hasOwn(metadata, "dependencies"), false);
      assert.deepEqual(metadata.devDependencies, source.devDependencies);
      assert.deepEqual(metadata.engines, { node: ">=22.15" });
      assert.equal(metadata.license, "Apache-2.0");
      assert.equal(metadata.scripts.prepack, "npm run build");
      assert.ok(!Object.keys(metadata.scripts).some((name) => name.includes("publish")), "local publication script");
    }
    assert.ok(existsSync(join(AGENT, "bin/syncky-agent.js")), "source CLI entry point removed");
    assert.equal(existsSync(join(unpacked, "node_modules")), false);
    assert.equal(existsSync(join(unpacked, "protocol")), false);
    assert.deepEqual(readdirSync(join(unpacked, "package")).sort(), ["LICENSE", "NOTICE", "README.md", "dist", "package.json"]);
    assert.deepEqual(readdirSync(join(unpacked, "package/dist")).sort(), ["syncky-agent.mjs", "syncky-agent.mjs.sha256"]);
  });

  it("both npm executable names expose generic inbox with identical help", () => {
    const outputs = ["syncky-agent", "syncky"].map(name => {
      const result = spawnSync(join(bin, name), ["inbox", "--help"], { cwd, env, encoding: "utf8" });
      assert.equal(result.status, 0);
      assert.match(result.stdout, /inbox/);
      assert.match(result.stdout, /--after-seq/);
      return result.stdout;
    });
    assert.equal(outputs[0], outputs[1]);
  });

  it("carries the exact executable bundle, matching checksum, Apache files and embedded upstream notices", () => {
    const path = join(unpacked, "package", packed.bin["syncky-agent"]);
    const payload = readFileSync(path);
    assert.ok(payload.equals(readFileSync(release.bundlePath)), "packed bundle differs from the build");
    assert.equal(digest(payload), release.hash);
    assert.equal(readFileSync(`${path}.sha256`, "utf8"), `${release.hash}  syncky-agent.mjs\n`);
    assert.equal(statSync(path).mode & 0o777, 0o755);
    for (const name of ["LICENSE", "NOTICE", "README.md"]) {
      assert.ok(readFileSync(join(unpacked, "package", name)).equals(readFileSync(join(AGENT, name))), "packed document differs");
    }
    const readme = readFileSync(join(unpacked, "package/README.md"), "utf8");
    for (const link of readme.matchAll(/\]\(([^)]+)\)/g)) assert.match(link[1], /^(?:https:\/\/|#)/, "npm README link depends on an unpacked source file");
    const text = payload.toString();
    for (const name of ["qrcode-terminal/LICENSE", "@hpke/core/LICENSE"]) {
      assert.ok(text.includes(readFileSync(join(AGENT, "node_modules", name), "utf8").trim()), "upstream licence missing from npm bundle");
    }
    for (const name of ["noble-hashes", "noble-ciphers"]) assert.ok(text.includes(`${name} - MIT License`));
    assert.ok(!text.includes("excluded npm fixture"), "contamination reached the bundle");
  });

  it("runs the unpacked bin and embedded selftests with only Node and no sibling resources", async () => {
    const help = await cli(["help"]);
    assert.ok(help.code === 0 && !help.timedOut && help.stdout.includes("mcp") && help.stdout.includes("selftest"), "unpacked npm bin help failed");
    const selftest = await cli(["selftest", "--json"]);
    assert.ok(selftest.code === 0 && !selftest.timedOut, "unpacked npm selftest failed");
    assert.equal(JSON.parse(selftest.stdout).ok, true);
    assert.deepEqual(readdirSync(cwd), []);
    assert.equal(existsSync(env.SYNCKY_AGENT_HOME), false);
  });

  it("initializes against a loopback relay and serves stdio MCP from the unpacked bin", async () => {
    const relay = await startRelayDouble({ invite: "npm-local-fixture" });
    try {
      const init = await cli(["init", "--relay", relay.url, "--name", "Npm fixture"], { SYNCKY_INVITE: "npm-local-fixture" });
      assert.ok(init.code === 0 && !init.timedOut, "unpacked npm initialization failed");
      const archive = diagnosticsFixture();
      createInbox(env.SYNCKY_AGENT_HOME).append({ seq: 1, from: 'm_dev_1', kind: 'data', type: 'diagnostics', received_at: new Date().toISOString(), inner: archive });
      for (const name of ['syncky-agent', 'syncky']) {
        const page = await cli(['inbox', '--type', 'diagnostics'], {}, '', name);
        assert.equal(page.code, 0); assert.deepEqual(JSON.parse(page.stdout).records[0].inner, archive);
      }
      const input = [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "npm-test", version: "1" } } },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "syncky_status", arguments: {} } },
        { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "syncky_inbox", arguments: { type: "diagnostics" } } },
      ].map((request) => JSON.stringify(request)).join("\n") + "\n";
      const run = await cli(["mcp"], {}, input);
      assert.ok(run.code === 0 && !run.timedOut, "unpacked npm MCP startup failed");
      const replies = run.stdout.trim().split("\n").map((line) => JSON.parse(line));
      assert.deepEqual(replies.map((reply) => [reply.jsonrpc, reply.id]), [["2.0", 1], ["2.0", 2], ["2.0", 3], ["2.0", 4]]);
      assert.equal(replies[0].result.serverInfo.version, packed.version);
      assert.deepEqual(replies[1].result.tools.map((tool) => tool.name).sort(), ["syncky_status", "syncky_inbox", "syncky_send", "syncky_ack", "syncky_skill"].sort());
      assert.equal(replies[2].result.isError, false);
      assert.equal(replies[2].result.content[0].type, "text");
      assert.deepEqual(replies[3].result.structuredContent.records[0].inner, archive);
      assert.equal(run.stderr.includes("window_start"), false);
      assert.ok(!replies.some((reply) => reply.error), "unpacked MCP returned an error");
    } finally { await relay.stop(); }
  });
});
