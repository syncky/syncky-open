import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { startRelayDouble } from "../support/relay-double.js";

const AGENT = fileURLToPath(new URL("../../", import.meta.url));
const packages = [
  ["claude-code", "syncky-agent-claude-code.tar.gz", "plugins/syncky/skills/syncky"],
  ["codex", "syncky-agent-codex.tar.gz", "plugins/syncky/skills/syncky"],
  ["clawhub", "syncky-agent-clawhub.tar.gz", "syncky"],
  ["agent-skills", "syncky-agent-skills.tar.gz", "skills/syncky"],
];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
const json = (file) => JSON.parse(readFileSync(file, "utf8"));
const files = (dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  assert.ok(!lstatSync(path).isSymbolicLink(), "package contains a symlink");
  return lstatSync(path).isDirectory() ? files(path).map((p) => `${name}/${p}`) : [name];
}).sort();

function contained(root, path) {
  assert.equal(typeof path, "string");
  assert.ok(path.startsWith("./"), "manifest path must be relative");
  const target = resolve(root, path);
  assert.ok(target.startsWith(`${resolve(root)}${sep}`), "manifest escapes its root");
  assert.ok(existsSync(target), "manifest target is missing");
  return target;
}

function recipe(leaf) {
  const skill = readFileSync(join(leaf, "SKILL.md"), "utf8");
  const match = /```sh\n([^`]+)\n```/.exec(skill);
  assert.ok(match, "executable onboarding recipe missing");
  return match[1];
}

describe("carried distributions", () => {
  let root, dist, env, leaves, cwd;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "syncky distributions "));
    cwd = join(root, "unrelated cwd");
    mkdirSync(cwd);
    if (process.env.SYNCKY_AGENT_BUNDLE_FIXTURE) {
      dist = dirname(json(process.env.SYNCKY_AGENT_BUNDLE_FIXTURE).release.bundlePath);
    } else {
      const { buildAgent } = await import("../../build.mjs");
      dist = dirname((await buildAgent({ outdir: join(root, "build") })).bundlePath);
    }
    const bin = join(root, "runtime only");
    mkdirSync(bin);
    symlinkSync(process.execPath, join(bin, "node"));
    for (const command of ["npm", "npx", "curl", "wget", "git"]) writeFileSync(join(bin, command), `#!/bin/sh\nprintf invoked > ${quote(join(root, "forbidden-command"))}\nexit 99\n`, { mode: 0o755 });
    const guard = join(root, "local-fetch-only.mjs");
    writeFileSync(guard, `import { writeFileSync } from 'node:fs';\nconst fetch = globalThis.fetch;\nglobalThis.fetch = (input, options) => {\n  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);\n  if (url.origin !== process.env.SYNCKY_RELAY_URL) { writeFileSync(${JSON.stringify(join(root, "remote-fetch"))}, 'blocked'); throw new Error('non-local fetch blocked'); }\n  return fetch(input, options);\n};\n`);
    env = { HOME: root, PATH: bin, TMPDIR: tmpdir(), NODE_OPTIONS: `--import=${JSON.stringify(guard)}` };
    leaves = packages.map(([tree, archive, leaf]) => {
      const unpacked = join(root, `extracted ${tree}`);
      mkdirSync(unpacked);
      const run = spawnSync("/usr/bin/tar", ["-xzf", join(dist, archive), "-C", unpacked]);
      assert.ok(run.status === 0, "archive extraction failed");
      return { tree, archive, unpacked, leaf: join(unpacked, tree, leaf), relativeLeaf: leaf };
    });
  });
  after(() => {
    try {
      if (root) assert.ok(!existsSync(join(root, "forbidden-command")) && !existsSync(join(root, "remote-fetch")), "package invoked an installer, downloader or remote fetch");
    } finally { if (root) rmSync(root, { recursive: true, force: true }); }
  });

  function child(command, args, extraEnv = {}, input = "", onOutput) {
    return new Promise((resolveResult) => {
      const proc = spawn(command, args, { cwd, env: { ...env, ...extraEnv }, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "", stderr = "", timedOut = false;
      const timer = setTimeout(() => { timedOut = true; proc.kill("SIGKILL"); }, 20_000);
      proc.stdout.on("data", (chunk) => { stdout += chunk; onOutput?.(proc, stdout); });
      proc.stderr.on("data", (chunk) => { stderr += chunk; });
      proc.stdin.on("error", () => {});
      proc.on("error", () => { clearTimeout(timer); resolveResult({ code: -1, stdout: "", stderr: "spawn failed" }); });
      proc.on("close", (code, signal) => { clearTimeout(timer); resolveResult({ code, signal, stdout, stderr, timedOut }); });
      if (onOutput) proc.stdin.write(input);
      else proc.stdin.end(input);
    });
  }

  const launch = (leaf, args, extraEnv, input, onOutput) => child(join(leaf, "syncky-agent"), args, extraEnv, input, onOutput);
  const onboard = (leaf, extraEnv) => child("/bin/sh", ["-c", recipe(leaf)], { SYNCKY_RUNNER: join(leaf, "syncky-agent"), ...extraEnv });
  const copyLeaf = (name) => {
    const target = join(root, name);
    cpSync(leaves[0].leaf, target, { recursive: true });
    return target;
  };
  const hasPair = (run) => run.code === 0 && !run.timedOut && /[▀▄█]/.test(run.stdout) && /code: \d{3} \d{3} \d{3}/.test(run.stdout);

  it("contains only the four promised trees, archives, release payload, MCPB and checksum inventory", () => {
    assert.deepEqual(readdirSync(dist).sort(), ["syncky-agent.mjs", "syncky-agent.mjs.sha256", "syncky-health.mcpb", "syncky-health.mcpb.sha256", "SHA256SUMS", ...packages.flatMap(([tree, archive]) => [tree, archive])].sort());
    const sums = readFileSync(join(dist, "SHA256SUMS"), "utf8").trim().split("\n");
    assert.equal(sums.length, 6);
    assert.deepEqual(sums.map((s) => s.slice(66)).sort(), ["syncky-agent.mjs", "syncky-health.mcpb", ...packages.map((p) => p[1])].sort());
    for (const line of sums) assert.equal(line.slice(0, 64), digest(readFileSync(join(dist, line.slice(66)))));
    for (const { tree, unpacked, leaf, relativeLeaf } of leaves) {
      const treeRoot = join(unpacked, tree);
      const expectedLeaf = ["SKILL.md", "syncky-agent", "syncky-agent.mjs", "syncky-agent.mjs.sha256", "LICENSE", "NOTICE", "THIRD-PARTY-NOTICES"];
      assert.deepEqual(files(leaf), expectedLeaf.sort());
      const manifests = tree === "claude-code" ? [".claude-plugin/marketplace.json", "plugins/syncky/.claude-plugin/plugin.json", "plugins/syncky/.mcp.json"] : tree === "codex" ? [".agents/plugins/marketplace.json", "plugins/syncky/.codex-plugin/plugin.json"] : [];
      assert.deepEqual(files(treeRoot), [...expectedLeaf.map((f) => `${relativeLeaf}/${f}`), ...manifests].sort());
      for (const path of files(treeRoot)) {
        const expected = readFileSync(join(dist, tree, path));
        assert.ok(readFileSync(join(treeRoot, path)).equals(expected), "archive bytes differ from tree");
        assert.equal(lstatSync(join(treeRoot, path)).mode & 0o777, path.endsWith("/syncky-agent") || path.endsWith(".mjs") ? 0o755 : 0o644);
        assert.ok(!/node_modules|secrets\.json|config\.json|agent\.db|package\.json/.test(path), "runtime dependency or state in artifact");
      }
      assert.ok(readFileSync(join(leaf, "syncky-agent.mjs")).equals(readFileSync(join(dist, "syncky-agent.mjs"))), "bundle copy differs");
      assert.ok(readFileSync(join(leaf, "syncky-agent")).equals(readFileSync(join(leaves[0].leaf, "syncky-agent"))), "launcher template differs across packages");
      const hash = digest(readFileSync(join(leaf, "syncky-agent.mjs")));
      assert.ok(readFileSync(join(leaf, "syncky-agent"), "utf8").includes(hash), "launcher digest is not pinned");
      assert.equal(readFileSync(join(leaf, "syncky-agent.mjs.sha256"), "utf8"), `${hash}  syncky-agent.mjs\n`);
      assert.equal(readFileSync(join(leaf, "LICENSE"), "utf8"), readFileSync(join(AGENT, "LICENSE"), "utf8"));
      assert.match(readFileSync(join(leaf, "NOTICE"), "utf8"), /Copyright 2026 Syncky/);
      for (const name of ["@hpke/core", "qrcode-terminal"]) assert.ok(readFileSync(join(leaf, "THIRD-PARTY-NOTICES"), "utf8").includes(name));
      for (const notice of ["noble-hashes - MIT License (c) 2022 Paul Miller (paulmillr.com)", "noble-ciphers - MIT License (c) 2023 Paul Miller (paulmillr.com)"]) {
        assert.ok(readFileSync(join(leaf, "THIRD-PARTY-NOTICES"), "utf8").includes(notice), "vendored attribution missing from package");
      }
    }
    assert.ok(!existsSync(join(root, "node_modules")) && !existsSync(join(root, "protocol")));
  });

  it("uses separate local Claude and Codex manifest shapes with contained skill leaves and Apache licences", () => {
    for (const { tree, unpacked, leaf } of leaves.filter((p) => ["claude-code", "codex"].includes(p.tree))) {
      const base = join(unpacked, tree);
      const claude = tree === "claude-code";
      const market = json(join(base, claude ? ".claude-plugin/marketplace.json" : ".agents/plugins/marketplace.json"));
      assert.equal(market.name, "syncky-local");
      if (claude) assert.equal(market.owner.name, "Syncky");
      assert.equal(market.plugins.length, 1);
      assert.equal(market.plugins[0].name, "syncky");
      const source = market.plugins[0].source;
      if (!claude) assert.deepEqual(source, { source: "local", path: "./plugins/syncky" });
      else assert.equal(source, "./plugins/syncky");
      const pluginRoot = contained(base, claude ? source : source.path);
      const manifest = json(join(pluginRoot, claude ? ".claude-plugin/plugin.json" : ".codex-plugin/plugin.json"));
      assert.equal(manifest.name, "syncky");
      assert.equal(manifest.version, json(join(AGENT, "package.json")).version);
      assert.equal(manifest.license, "Apache-2.0");
      assert.equal(typeof manifest.description, "string");
      assert.ok(manifest.description.length > 40);
      if (!claude) assert.equal(manifest.skills, "./skills/");
      else {
        assert.equal(manifest.mcpServers, "./.mcp.json");
        assert.deepEqual(json(contained(pluginRoot, manifest.mcpServers)), {
          mcpServers: { syncky: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/skills/syncky/syncky-agent.mjs", "mcp"] } },
        });
      }
      assert.equal(join(contained(pluginRoot, manifest.skills ?? "./skills/"), "syncky"), leaf);
    }
    for (const bad of ["../escape", "/absolute", "./../escape", "./missing"]) assert.throws(() => contained(root, bad));
  });

  it("runs the generated Claude plugin MCP offline from its contained bundle", async () => {
    const pluginRoot = join(leaves.find(leaf => leaf.tree === 'claude-code').unpacked, 'claude-code/plugins/syncky');
    const server = json(join(pluginRoot, '.mcp.json')).mcpServers.syncky;
    const input = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n';
    const run = await child(process.execPath, server.args.map(arg => arg.replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginRoot)), {}, input);
    assert.equal(run.code, 0); assert.deepEqual(JSON.parse(run.stdout).result.tools.map(t => t.name), ['syncky_status','syncky_inbox','syncky_send','syncky_ack','syncky_skill']);
  });

  it("starts the extracted MCPB using its stdio manifest with only the Node runtime", async () => {
    const unpacked = join(root, "extracted MCPB with spaces");
    mkdirSync(unpacked);
    const extract = spawnSync("/usr/bin/unzip", ["-q", join(dist, "syncky-health.mcpb"), "-d", unpacked]);
    assert.equal(extract.status, 0, "MCPB extraction failed");
    assert.deepEqual(files(unpacked), ["LICENSE", "NOTICE", "THIRD-PARTY-NOTICES", "manifest.json", "syncky-agent.mjs"].sort());
    for (const name of files(unpacked)) assert.equal(lstatSync(join(unpacked, name)).mode & 0o777, name.endsWith(".mjs") ? 0o755 : 0o644);
    const manifest = json(join(unpacked, "manifest.json"));
    const server = manifest.server.mcp_config;
    const input = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "mcpb-test", version: "1" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ].map((request) => JSON.stringify(request)).join("\n") + "\n";
    const run = await child(server.command, server.args.map((arg) => arg.replaceAll("${__dirname}", unpacked)), { SYNCKY_AGENT_HOME: join(root, "mcpb home") }, input);
    assert.ok(run.code === 0 && !run.timedOut, "extracted MCPB stdio startup failed");
    const replies = run.stdout.trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(replies.map((reply) => [reply.jsonrpc, reply.id]), [["2.0", 1], ["2.0", 2]]);
    assert.equal(replies[0].result.serverInfo.version, json(join(AGENT, "package.json")).version);
    assert.deepEqual(replies[1].result.tools.map((tool) => tool.name).sort(), ["syncky_status", "syncky_inbox", "syncky_send", "syncky_ack", "syncky_skill"].sort());
    assert.ok(!existsSync(join(root, "mcpb home")), "MCP initialization created local state");
  });

  it("runs every extracted launcher independently from a path with spaces", async () => {
    for (const { leaf } of leaves) {
      const help = await launch(leaf, ["help"]);
      assert.ok(help.code === 0 && help.stdout.includes("inbox"), "isolated launcher help failed");
      const bad = await launch(leaf, ["nonexistent-command"]);
      assert.equal(bad.code, 1);
    }
  });

  it("runs sh syncky-agent from each skill directory without that directory on PATH", () => {
    for (const { leaf } of leaves) {
      const run = spawnSync("/bin/sh", ["syncky-agent", "help"], { cwd: leaf, env, encoding: "utf8", timeout: 20_000 });
      assert.ok(run.status === 0 && run.stdout.includes("inbox"), "bare shell launcher failed");
    }
  });

  it("refuses missing Node and versions before 22.15, while accepting 22.15 and later majors", async () => {
    const nodeDir = join(root, "node shim");
    mkdirSync(nodeDir);
    const missing = await launch(leaves[0].leaf, ["help"], { PATH: nodeDir });
    assert.ok(missing.code !== 0 && /Node\.js.*22\.15/.test(missing.stderr), "missing Node diagnostic absent");
    writeFileSync(join(nodeDir, "node"), `#!/bin/sh\nif [ "$1" = -e ]; then\n  exec ${quote(process.execPath)} -e 'Object.defineProperty(process.versions, "node", { value: process.env.TEST_NODE_VERSION }); eval(process.argv[1]);' "$2"\nfi\nexec ${quote(process.execPath)} "$@"\n`, { mode: 0o755 });
    for (const version of ["18.20.0", "20.99.0", "22.14.99", "22.15.0", "22.99.0", "23.0.0", "24.0.0", "100.0.0"]) {
      const run = await launch(leaves[0].leaf, ["help"], { PATH: `${nodeDir}:/usr/bin:/bin`, TEST_NODE_VERSION: version });
      const supported = !["18.20.0", "20.99.0", "22.14.99"].includes(version);
      assert.ok(supported ? run.code === 0 && run.stdout.includes("inbox") : run.code !== 0 && /Node\.js.*22\.15/.test(run.stderr), "Node version policy differs");
    }
  });

  it("refuses missing or tampered bundles before executing any code, even with a forged sidecar", async () => {
    const leaf = copyLeaf("tampering check");
    const bundle = join(leaf, "syncky-agent.mjs");
    rmSync(bundle);
    let run = await launch(leaf, ["help"]);
    assert.ok(run.code !== 0 && /bundle.*(missing|read)/i.test(run.stderr), "missing bundle diagnostic absent");
    const marker = join(root, "tampered-code-ran");
    writeFileSync(bundle, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'bad'); export function runCli() { process.exit(0); }\n`);
    for (const forged of [false, true]) {
      if (forged) writeFileSync(`${bundle}.sha256`, `${digest(readFileSync(bundle))}  syncky-agent.mjs\n`);
      run = await launch(leaf, ["help"]);
      assert.ok(run.code !== 0 && /checksum/i.test(run.stderr), "corrupt bundle diagnostic absent");
      assert.ok(!existsSync(marker), "corrupt bundle code executed");
    }
  });

  it("forwards arguments, exit codes and signals without consuming stdin", async () => {
    const leaf = copyLeaf("wrapper semantics");
    const payload = `export async function runCli(args) { if (process.umask() !== 0o077) process.exit(38); process.stdout.write(JSON.stringify(args)); process.exit(37); }\n`;
    writeFileSync(join(leaf, "syncky-agent.mjs"), payload);
    const template = readFileSync(join(AGENT, "distribution/syncky-agent.sh"), "utf8");
    writeFileSync(join(leaf, "syncky-agent"), template.replaceAll("@BUNDLE_SHA256@", digest(payload)), { mode: 0o755 });
    const args = ["a b", "", "'quoted'", "$literal", "--json", "line\nbreak"];
    const run = await launch(leaf, args);
    assert.equal(run.code, 37);
    assert.deepEqual(JSON.parse(run.stdout), args);
    for (const signal of ["SIGTERM", "SIGINT"]) {
      const waitPayload = `export async function runCli() { process.stdout.write('ready'); setInterval(() => {}, 1000); }\n`;
      writeFileSync(join(leaf, "syncky-agent.mjs"), waitPayload);
      writeFileSync(join(leaf, "syncky-agent"), template.replaceAll("@BUNDLE_SHA256@", digest(waitPayload)));
      const stopped = await launch(leaf, [], {}, "", (proc) => proc.kill(signal));
      assert.ok(!stopped.timedOut && stopped.signal === signal, "signal did not reach executed Node");
    }
  });

  for (const index of [0, 1, 2, 3]) it(`executes the exact ${packages[index][0]} onboarding recipe safely on fresh and existing homes`, async () => {
    const { leaf } = leaves[index];
    const relay = await startRelayDouble({ invite: "local-distribution-invite" });
    const other = await startRelayDouble();
    const home = join(root, `private home ${index}`);
    const local = { SYNCKY_AGENT_HOME: home, SYNCKY_RELAY_URL: relay.url, SYNCKY_INVITE: "local-distribution-invite", SYNCKY_AGENT_NAME: "Name with spaces ' and $literal" };
    try {
      const missingInvite = await onboard(leaf, { ...local, SYNCKY_INVITE: "" });
      assert.ok(missingInvite.code !== 0 && /invite/.test(missingInvite.stderr) && !existsSync(join(home, "secrets.json")), "missing invite did not stop safely");
      const first = await onboard(leaf, local);
      assert.ok(hasPair(first), "fresh recipe did not return QR and grouped code immediately");
      assert.ok(!/waiting for the phone|\[y\/n\]/i.test(first.stdout), "recipe waited or prompted");
      const secretsPath = join(home, "secrets.json");
      const originalSecrets = readFileSync(secretsPath);
      const registrations = relay.state.requests.filter((r) => r.route === "register").length;
      const second = await onboard(leaf, { ...local, SYNCKY_INVITE: "" });
      assert.ok(hasPair(second), "existing initialization was not reused");
      assert.ok(readFileSync(secretsPath).equals(originalSecrets), "initialized credentials changed");
      assert.equal(relay.state.requests.filter((r) => r.route === "register").length, registrations);
      assert.ok([...relay.state.hub().members.values()].every((m) => m.name === local.SYNCKY_AGENT_NAME), "name arguments changed");
      assert.ok(relay.state.requests.every((r) => ["register", "createPairing"].includes(r.route)), "recipe fetched unexpected data or waited");
      const request = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "distribution-test", version: "1" } } });
      const mcp = await launch(leaf, ["mcp"], local, `${request}\n`);
      assert.ok(mcp.code === 0 && mcp.stdout.trim().split("\n").every((line) => { try { return JSON.parse(line).jsonrpc === "2.0"; } catch { return false; } }), "MCP stdin/stdout contract failed");
      assert.ok(mcp.stdout.includes('"id":1'), "launcher consumed MCP stdin");
      const mismatch = await onboard(leaf, { ...local, SYNCKY_RELAY_URL: other.url });
      assert.ok(mismatch.code !== 0 && !hasPair(mismatch), "mismatched relay did not stop");
      assert.equal(other.state.requests.filter((r) => r.route === "register").length, 0);
      const state = json(secretsPath);
      writeFileSync(secretsPath, JSON.stringify({ ...state, public_key: Buffer.alloc(32, 7).toString("base64url") }));
      const before = relay.state.requests.length;
      const keys = await onboard(leaf, local);
      assert.ok(keys.code === 4 && !hasPair(keys), "mismatched keys did not stop");
      writeFileSync(secretsPath, "{broken-state");
      const corrupt = await onboard(leaf, local);
      assert.ok(corrupt.code === 4 && !hasPair(corrupt), "corrupt state did not stop");
      writeFileSync(secretsPath, originalSecrets);
      writeFileSync(join(home, "config.json"), "{broken-config");
      const config = await onboard(leaf, local);
      assert.ok(config.code === 4 && !hasPair(config), "corrupt configuration did not stop");
      rmSync(secretsPath);
      const partial = await onboard(leaf, local);
      assert.ok(partial.code === 4 && !hasPair(partial), "partial initialization was replaced");
      assert.equal(relay.state.requests.length, before);
      assert.ok(!/local-distribution-invite|\{broken-state/.test([missingInvite, mismatch, keys, corrupt, partial].map((r) => r.stderr).join("")), "failure output disclosed private input");
    } finally {
      await relay.stop();
      await other.stop();
    }
  });

  it("uses the documented default name for a fresh home", async () => {
    const relay = await startRelayDouble();
    try {
      const run = await onboard(leaves[0].leaf, { SYNCKY_AGENT_HOME: join(root, "default name home"), SYNCKY_RELAY_URL: relay.url, SYNCKY_INVITE: "test-invite" });
      assert.ok(hasPair(run), "default-name onboarding failed");
      assert.ok([...relay.state.hub().members.values()].every((m) => m.name === "Syncky agent"));
    } finally { await relay.stop(); }
  });
});
