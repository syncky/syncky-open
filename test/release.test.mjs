import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PUBLIC = fileURLToPath(new URL("../", import.meta.url));
const SOURCE = existsSync(join(PUBLIC, "agent/package.json")) ? PUBLIC : dirname(PUBLIC);
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const config = { command: "npx", args: ["-y", "@syncky/agent", "mcp"] };
const offline = { npm_config_offline: "true", npm_config_audit: "false", npm_config_fund: "false", npm_config_update_notifier: "false" };
const assets = ["syncky-agent.mjs", "syncky-agent.mjs.sha256", "syncky-health.mcpb", "syncky-health.mcpb.sha256", "SHA256SUMS", "server.json",
  ...["claude-code", "codex", "clawhub", "skills"].map((name) => `syncky-agent-${name}.tar.gz`)].sort();

function run(args, cwd, env = {}) {
  return spawnSync(process.execPath, args, { cwd, env: { ...process.env, ...offline, ...env }, encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
}

function manifests(root) {
  const pkg = json(join(SOURCE, "agent/package.json"));
  const marketplace = json(join(root, ".claude-plugin/marketplace.json"));
  assert.equal(marketplace.name, "syncky");
  assert.deepEqual(marketplace.plugins, [{ name: "syncky", source: "./plugins/syncky", description: "Apple Health data through your local Syncky agent." }]);
  const pluginRoot = resolve(root, marketplace.plugins[0].source);
  assert.ok(!relative(root, pluginRoot).startsWith(".."));
  const plugin = json(join(pluginRoot, ".claude-plugin/plugin.json"));
  assert.equal(plugin.name, "syncky");
  assert.equal(plugin.version, pkg.version);
  assert.equal(plugin.mcpServers, "./.mcp.json");
  assert.equal(plugin.skills, "./skills/");
  assert.deepEqual(json(join(pluginRoot, plugin.mcpServers)).mcpServers, { syncky: config });
  assert.ok(!relative(pluginRoot, resolve(pluginRoot, plugin.skills)).startsWith(".."));
  const skill = readFileSync(join(root, "SKILL.md"), "utf8");
  assert.equal(readFileSync(join(pluginRoot, plugin.skills, "syncky/SKILL.md"), "utf8"), skill);
  for (const phrase of ['npx -y @syncky/agent mcp','Use Syncky and start onboarding with a QR code.','SYNCKY_INVITE','Scanning alone does not confirm trust','one receiver per home','untrusted data','Never force registration','exclusive creation','relay sees delivery metadata','Needs attention','uploads wait']) assert.ok(skill.includes(phrase), `skill missing ${phrase}`);
  for (const pattern of [/Without an answer, wait before installing services or schedules/, /continuous explicitly authorizes installation\/start/, /login startup and restart on failure/, /receive --once/, /Do not automatically schedule writes or reports/, /never quote the token-bearing URI/, /explicit owner approval/, /Never overwrite or append/, /permission to write Health values/i]) assert.match(skill,pattern);
  const recipe = /```sh\nset -eu\n([\s\S]*?)\n```/.exec(skill)?.[1];
  assert.ok(recipe); assert.match(recipe, /syncky_run pair/); assert.doesNotMatch(recipe, /SYNCKY_RUNNER|--force|--wait|--no-qr|--json|--v1/);
  assert.match(skill, /syncky_run\(\) \{ npx -y @syncky\/agent/);
  const gemini = json(join(root, "gemini-extension.json"));
  assert.equal(gemini.name, "syncky");
  assert.equal(gemini.version, pkg.version);
  assert.deepEqual(gemini.mcpServers, { syncky: config });
  assert.equal(gemini.contextFileName, "SKILL.md");
  const registry = json(join(root, "server.json"));
  assert.equal(registry.$schema, "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json");
  assert.equal(registry.name, pkg.mcpName);
  assert.equal(registry.version, pkg.version);
  assert.equal(registry.repository.url, "https://github.com/syncky/syncky-open");
  assert.equal(registry.websiteUrl, "https://syncky.app/agents");
  assert.equal(registry.packages.length, 2);
  const [npm, mcpb] = registry.packages;
  assert.deepEqual(npm, { registryType: "npm", registryBaseUrl: "https://registry.npmjs.org", identifier: pkg.name, version: pkg.version,
    runtimeHint: "npx", packageArguments: [{ type: "positional", value: "mcp" }], transport: { type: "stdio" } });
  assert.deepEqual(mcpb, { registryType: "mcpb", identifier: `https://github.com/syncky/syncky-open/releases/download/v${pkg.version}/syncky-health.mcpb`, transport: { type: "stdio" } });
}

describe("public installation manifests", () => {
  it("registers contained plugin/skill paths, canonical MCP commands and both Registry distributions", () => manifests(PUBLIC));

  it("passes command arrays unchanged to a stub npx", (t) => {
    const dir = mkdtempSync(join(tmpdir(), "syncky-command-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const stub = join(dir, "npx");
    writeFileSync(stub, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n`);
    chmodSync(stub, 0o755);
    for (const server of [json(join(PUBLIC, "plugins/syncky/.mcp.json")).mcpServers.syncky, json(join(PUBLIC, "gemini-extension.json")).mcpServers.syncky]) {
      const result = spawnSync(join(dir, server.command), server.args, { encoding: "utf8" });
      assert.equal(result.status, 0);
      assert.deepEqual(JSON.parse(result.stdout), ["-y", "@syncky/agent", "mcp"]);
    }
  });

  it("pins a tag-only, repository-guarded OIDC workflow with all local gates before publication", () => {
    const workflow = readFileSync(join(PUBLIC, ".github/workflows/release.yml"), "utf8");
    assert.match(workflow, /on:\n  push:\n    tags: \['v\*'\]/);
    assert.match(workflow, /if: github.repository == 'syncky\/syncky-open'/);
    assert.match(workflow, /permissions:\n  contents: read/);
    assert.match(workflow, /permissions:\n      contents: write\n      id-token: write/);
    assert.match(workflow, /runs-on: ubuntu-24\.04/);
    const refs = [...workflow.matchAll(/uses: ([^\s]+)@([^\s]+)/g)];
    assert.deepEqual(refs.map((m) => m[1]), ["actions/checkout", "actions/setup-node", "actions/upload-artifact", "actions/checkout", "actions/setup-node", "actions/download-artifact"]);
    for (const ref of refs) assert.match(ref[2], /^[a-f0-9]{40}$/);
    assert.match(workflow, /persist-credentials: false/);
    assert.match(workflow, /node-version: '22\.18\.0'/);
    assert.match(workflow, /npm install --global npm@11\.5\.2/);
    const commands = ["npm ci", "npm run build", "npm test", "npm run test:bundle", "node --test test/*.test.mjs", 'node release.mjs prepare "$RUNNER_TEMP/syncky-release"', 'node release.mjs publish "$RUNNER_TEMP/syncky-release"'];
    const [build, publish] = workflow.split("\n  build:\n")[1].split("\n  publish:\n");
    assert.match(build, /permissions:\n      contents: read/);
    assert.doesNotMatch(build, /id-token:|contents: write|GH_TOKEN|release\.mjs publish/);
    assert.match(publish, /needs: build/);
    assert.match(publish, /permissions:\n      contents: write\n      id-token: write/);
    assert.deepEqual([...build.matchAll(/^ +run: (.+)$/gm)].map((match) => match[1]), ["npm ci --no-audit --no-fund", ...commands.slice(1, -1)]);
    assert.deepEqual([...publish.matchAll(/^ +run: (.+)$/gm)].map((match) => match[1]), ["npm install --global npm@11.5.2 --ignore-scripts --no-audit --no-fund", commands.at(-1)]);
    for (const job of [build, publish]) {
      assert.match(job, /if: github.repository == 'syncky\/syncky-open'/);
      assert.match(job, /name: syncky-release\n +path: \$\{\{ runner.temp \}\}\/syncky-release/);
    }
    assert.match(build, /if-no-files-found: error/);
    let previous = -1;
    for (const command of commands) {
      const at = workflow.indexOf(command);
      assert.ok(at > previous, `missing or misplaced workflow gate: ${command}`);
      previous = at;
    }
    assert.match(workflow, /working-directory: agent/);
    assert.match(workflow, /GH_TOKEN: \$\{\{ github.token \}\}/);
    assert.ok(!/NODE_AUTH_TOKEN|NPM_TOKEN|secrets\.|workflow_dispatch|pull_request|mcp-publisher|deploy|public\/agent/.test(workflow));
  });
});

describe("Registry generation and release gates", () => {
  let base, source, env;
  before(async () => {
    base = mkdtempSync(join(tmpdir(), "syncky-release-contract-"));
    source = join(base, "source");
    assert.equal(existsSync(join(SOURCE, "agent-go")), false, "the Go agent must be deleted");
    cpSync(PUBLIC, source, { recursive: true, filter: (path) => ![join(PUBLIC, "agent"), join(PUBLIC, "protocol"), join(PUBLIC, "examples")].includes(path) });
    assert.equal(existsSync(join(source, "agent-go")), false, "release sources must not include the Go agent");
    for (const dir of ["agent", "protocol"]) cpSync(join(SOURCE, dir), join(source, dir), { recursive: true,
      filter: (path) => ![join(SOURCE, dir, "node_modules"), join(SOURCE, dir, "dist")].includes(path) });
    const pkg = json(join(source, "agent/package.json"));
    const lock = json(join(source, "agent/package-lock.json"));
    for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
      assert.equal(lock.packages[`node_modules/${name}`].version, version);
      assert.equal(json(join(SOURCE, "agent/node_modules", name, "package.json")).version, version);
    }
    cpSync(join(SOURCE, "agent/node_modules"), join(source, "agent/node_modules"), { recursive: true });
    const { buildAgent } = await import(pathToFileURL(join(source, "agent/build.mjs")));
    await buildAgent();
    env = { GITHUB_REPOSITORY: "syncky/syncky-open", GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: `v${pkg.version}` };
  });
  after(() => { if (base) rmSync(base, { recursive: true, force: true }); });

  function fixture(t) {
    const root = mkdtempSync(join(base, "case-"));
    cpSync(source, root, { recursive: true, filter: (path) => path !== join(source, "agent/node_modules") });
    const bin = join(root, "stub-bin");
    mkdirSync(bin);
    const log = join(root, "side-effects.jsonl");
    const state = join(root, "remote.json");
    writeFileSync(state, JSON.stringify({ npm: null, release: null, immutable: true }));
    const stub = `#!${process.execPath}
import { appendFileSync, copyFileSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
const command = basename(process.argv[1]), args = process.argv.slice(2);
appendFileSync(process.env.EFFECTS, JSON.stringify([command, ...args]) + '\\n');
const file = process.env.REMOTE, state = JSON.parse(readFileSync(file, 'utf8'));
const save = () => writeFileSync(file, JSON.stringify(state));
const reply = (value) => process.stdout.write(JSON.stringify(value));
const fail = (value) => { reply(value); process.exit(1); };
const once = (point) => { if (state.fail === point) { delete state.fail; save(); fail({ message: 'simulated timeout' }); } };
const upload = (paths) => {
  if (state.immutable && !state.release.draft) fail({ message: 'release is immutable' });
  for (const path of paths) {
    const name = basename(path);
    if (state.release.assets.some((asset) => asset.name === name)) fail({ message: 'asset already exists' });
    const id = state.nextAssetId = (state.nextAssetId ?? 0) + 1;
    if (state.fail === 'upload-starter' && state.release.assets.length) {
      state.release.assets.push({ id, name, state: 'starter', size: 0 });
      save();
      once('upload-starter');
    }
    copyFileSync(path, join(dirname(file), 'remote-' + name));
    state.release.assets.push({ id, name, state: 'uploaded', size: statSync(path).size });
    save();
    once('upload');
  }
};
if (command === 'npm' && args[0] === 'view') {
  if (state.npmError) fail({ error: { code: state.npmError } });
  if (Object.hasOwn(state, 'npmEmpty') && !state.npm) { process.stdout.write(state.npmEmpty); process.exit(0); }
  if (!state.npm) fail({ error: { code: 'E404' } });
  reply(state.npm);
} else if (command === 'npm' && args[0] === 'publish') {
  if (state.npm) fail({ error: { code: 'EPUBLISHCONFLICT' } });
  state.npm = { version: JSON.parse(readFileSync('agent/package.json')).version,
    'dist.integrity': 'sha512-' + createHash('sha512').update(readFileSync(args[1])).digest('base64') };
  save();
} else if (command === 'gh' && args[0] === 'api') {
  if (state.githubError) fail({ status: state.githubError });
  if (args.includes('DELETE')) {
    if (state.immutable && !state.release.draft) fail({ message: 'release is immutable' });
    const id = Number(args.at(-1).split('/').at(-1));
    if (!state.release.assets.some((asset) => asset.id === id)) fail({ status: '404' });
    state.release.assets = state.release.assets.filter((asset) => asset.id !== id);
    save();
  } else if (args.at(-1).endsWith('/releases?per_page=100')) {
    reply([state.release ? [state.release] : []]);
  } else {
    if (!state.release || state.release.draft) fail({ status: '404' });
    reply(state.release);
  }
} else if (command === 'gh' && args[1] === 'create') {
  once('create-before');
  if (state.release) fail({ message: 'release already exists' });
  state.release = { tag_name: args[2], draft: args.includes('--draft'), assets: [] };
  save();
  once('create-after');
} else if (command === 'gh' && args[1] === 'upload') {
  upload(args.slice(3, args.indexOf('--repo')));
} else if (command === 'gh' && args[1] === 'edit') {
  once('publish-before');
  if (!args.includes('--draft=false') || !state.release.draft) fail({ message: 'unexpected release edit' });
  if (!${JSON.stringify(assets)}.every((name) => state.release.assets.some((asset) => asset.name === name && asset.state === 'uploaded'))) fail({ message: 'incomplete release' });
  state.release.draft = false;
  save();
  once('publish-after');
} else if (command === 'gh' && args[1] === 'download') {
  copyFileSync(join(dirname(file), 'remote-' + args[args.indexOf('--pattern') + 1]), args[args.indexOf('--output') + 1]);
} else fail({ message: 'unexpected stub command' });
`;
    for (const name of ["npm", "gh"]) {
      writeFileSync(join(bin, name), stub);
      chmodSync(join(bin, name), 0o755);
    }
    t.after(() => rmSync(root, { recursive: true, force: true }));
    return { root, release: join(root, "release"), log, state, env: { ...env, PATH: `${bin}:${process.env.PATH}`, EFFECTS: log, REMOTE: state } };
  }

  const prepare = (fx) => run(["release.mjs", "prepare", fx.release], fx.root, env);
  const publish = (fx) => run(["release.mjs", "publish", fx.release], fx.root, fx.env);
  const calls = (fx) => readFileSync(fx.log, "utf8").trim().split("\n").map(JSON.parse);
  const updateRemote = (fx, patch) => writeFileSync(fx.state, JSON.stringify({ ...json(fx.state), ...patch }));

  it("generates deterministic Registry bytes from actual MCPB bytes outside the build output", (t) => {
    const fx = fixture(t);
    const output = join(fx.root, "generated/server.json");
    const args = ["prepare-registry.mjs", "server.json", "agent/package.json", "agent/dist", output];
    assert.equal(run(args, fx.root).status, 0);
    const first = readFileSync(output);
    assert.equal(run(args, fx.root).status, 0);
    assert.ok(first.equals(readFileSync(output)));
    const generated = json(output);
    assert.equal(generated.packages.length, 2);
    assert.equal(generated.packages[0].version, generated.version);
    assert.equal(generated.packages[1].fileSha256, hash(join(fx.root, "agent/dist/syncky-health.mcpb")));
    assert.equal(Object.hasOwn(json(join(fx.root, "server.json")).packages[1], "fileSha256"), false);
    for (const bad of ["server.json", "agent/dist/server.json", "agent/dist/nested/server.json"]) {
      const result = run([...args.slice(0, -1), bad], fx.root);
      assert.notEqual(result.status, 0, `unsafe output accepted: ${bad}`);
    }
  });

  for (const [label, mutate] of [
    ["draft version", (fx) => { const file = join(fx.root, "server.json"); const value = json(file); value.version = "9.0.0"; writeFileSync(file, JSON.stringify(value)); }],
    ["npm version", (fx) => { const file = join(fx.root, "server.json"); const value = json(file); value.packages[0].version = "9.0.0"; writeFileSync(file, JSON.stringify(value)); }],
    ["release URL", (fx) => { const file = join(fx.root, "server.json"); const value = json(file); value.packages[1].identifier = value.packages[1].identifier.replace("/v", "/wrong-v"); writeFileSync(file, JSON.stringify(value)); }],
    ["sidecar", (fx) => writeFileSync(join(fx.root, "agent/dist/syncky-health.mcpb.sha256"), "invalid\n")],
    ["checksum list", (fx) => writeFileSync(join(fx.root, "agent/dist/SHA256SUMS"), "invalid\n")],
    ["MCPB bytes", (fx) => writeFileSync(join(fx.root, "agent/dist/syncky-health.mcpb"), "tampered")],
  ]) {
    it(`rejects ${label} before writing a Registry asset or running side effects`, (t) => {
      const fx = fixture(t);
      mutate(fx);
      const output = join(fx.root, "generated/server.json");
      assert.notEqual(run(["prepare-registry.mjs", "server.json", "agent/package.json", "agent/dist", output], fx.root).status, 0);
      assert.equal(existsSync(output), false);
      assert.notEqual(publish(fx).status, 0);
      assert.equal(existsSync(fx.log), false);
    });
  }

  it("publishes only the tested tarball and attaches exactly the verified release assets", (t) => {
    const fx = fixture(t);
    const prepared = prepare(fx);
    assert.equal(prepared.status, 0, prepared.stderr);
    const receipt = json(join(fx.release, "release.json"));
    assert.deepEqual(Object.keys(receipt.assets).sort(), assets);
    for (const [name, digest] of Object.entries(receipt.assets)) assert.equal(hash(join(fx.release, name)), digest);
    const published = publish(fx);
    assert.equal(published.status, 0, published.stderr);
    assert.deepEqual(calls(fx), [
      ["npm", "view", `@syncky/agent@${receipt.version}`, "version", "dist.integrity", "--json", "--prefer-online"],
      ["npm", "publish", join(fx.release, receipt.tarball), "--access", "public", "--provenance", "--ignore-scripts"],
      ["gh", "api", `repos/syncky/syncky-open/releases/tags/${env.GITHUB_REF_NAME}`],
      ["gh", "api", "--paginate", "--slurp", "repos/syncky/syncky-open/releases?per_page=100"],
      ["gh", "release", "create", env.GITHUB_REF_NAME, "--repo", "syncky/syncky-open", "--verify-tag", "--title", env.GITHUB_REF_NAME, "--generate-notes", "--draft"],
      ["gh", "release", "upload", env.GITHUB_REF_NAME, ...assets.map((name) => join(fx.release, name)), "--repo", "syncky/syncky-open"],
      ["gh", "release", "edit", env.GITHUB_REF_NAME, "--repo", "syncky/syncky-open", "--draft=false"],
    ]);
    const packed = spawnSync("tar", ["-xOzf", join(fx.release, receipt.tarball), "package/package.json"], { encoding: "utf8" });
    assert.equal(packed.status, 0);
    assert.equal(JSON.parse(packed.stdout).repository.url, "git+https://github.com/syncky/syncky-open.git");
    assert.equal(json(join(fx.release, "server.json")).packages[1].fileSha256, receipt.assets["syncky-health.mcpb"]);
  });

  for (const output of ["", " \n\t"]) {
    it(`publishes a missing version when npm view succeeds with ${JSON.stringify(output)} output`, (t) => {
      const fx = fixture(t);
      assert.equal(prepare(fx).status, 0);
      updateRemote(fx, { npmEmpty: output });
      const result = publish(fx);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(calls(fx).filter((call) => call[0] === "npm" && call[1] === "publish").length, 1);
      assert.equal(json(fx.state).release.draft, false);
    });
  }

  it("publishes downloaded prepared assets without dependencies, a build tree or executing the bundle", (t) => {
    const fx = fixture(t);
    assert.equal(prepare(fx).status, 0);
    rmSync(join(fx.root, "agent/dist"), { recursive: true });
    assert.equal(existsSync(join(fx.root, "agent/node_modules")), false);
    const audit = join(fx.root, "audit.cjs"), log = join(fx.root, "executions.jsonl");
    writeFileSync(audit, `require('node:fs').appendFileSync(process.env.EXEC_LOG, JSON.stringify(process.argv) + '\\n');\n`);
    fx.env.NODE_OPTIONS = `--require=${audit}`;
    fx.env.EXEC_LOG = log;
    const result = publish(fx);
    assert.equal(result.status, 0, result.stderr);
    const executions = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
    assert.ok(executions.some((args) => args.includes("publish")));
    assert.ok(executions.every((args) => !args[1]?.endsWith("syncky-agent.mjs")));
  });

  for (const failure of ["create-before", "create-after", "upload", "upload-starter", "publish-before", "publish-after"]) {
    it(`resumes an immutable release after ${failure} failure without republishing npm or replacing existing assets`, (t) => {
      const fx = fixture(t);
      const prepared = prepare(fx);
      assert.equal(prepared.status, 0, prepared.stderr);
      updateRemote(fx, { fail: failure });
      assert.notEqual(publish(fx).status, 0);
      const failed = json(fx.state);
      assert.ok(failed.npm, "npm publication must succeed before the failure");
      if (failed.release) assert.equal(failed.release.draft, failure !== "publish-after");
      const existing = failed.release?.assets.filter((asset) => asset.state === "uploaded").map((asset) => asset.name) ?? [];
      const placeholders = failed.release?.assets.filter((asset) => asset.state === "starter") ?? [];
      assert.equal(placeholders.length, failure === "upload-starter" ? 1 : 0);
      const offset = calls(fx).length;
      const resumed = publish(fx);
      assert.equal(resumed.status, 0, resumed.stderr);
      assert.equal(calls(fx).filter((call) => call[0] === "npm" && call[1] === "publish").length, 1);
      const uploads = calls(fx).slice(offset).filter((call) => call[2] === "upload").flatMap((call) => call.slice(4, call.indexOf("--repo")));
      assert.deepEqual(uploads, assets.filter((name) => !existing.includes(name)).map((name) => join(fx.release, name)));
      assert.deepEqual(calls(fx).slice(offset).filter((call) => call.includes("DELETE")), placeholders.map((asset) =>
        ["gh", "api", "--method", "DELETE", `repos/syncky/syncky-open/releases/assets/${asset.id}`]));
      assert.deepEqual(json(fx.state).release.assets.map((asset) => asset.name).sort(), assets);
      assert.equal(json(fx.state).release.draft, false);
      for (const name of assets) assert.equal(hash(join(fx.root, `remote-${name}`)), hash(join(fx.release, name)));
      const completed = calls(fx).length;
      assert.equal(publish(fx).status, 0);
      assert.equal(calls(fx).slice(completed).filter((call) => call[1] === "publish" || ["create", "upload", "edit"].includes(call[2]) || call.includes("DELETE")).length, 0);
    });
  }

  for (const [label, metadata] of [
    ["integrity mismatch", { "dist.integrity": "sha512-different" }],
    ["missing integrity", { "dist.integrity": undefined }],
    ["version mismatch", { version: "9.0.0" }],
  ]) {
    it(`refuses an existing npm ${label} before GitHub writes`, (t) => {
      const fx = fixture(t);
      assert.equal(prepare(fx).status, 0);
      const receipt = json(join(fx.release, "release.json"));
      updateRemote(fx, { npm: { version: receipt.version,
        "dist.integrity": `sha512-${createHash("sha512").update(readFileSync(join(fx.release, receipt.tarball))).digest("base64")}`, ...metadata } });
      const result = publish(fx);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /existing npm version\/integrity mismatch/);
      assert.equal(calls(fx).length, 1);
    });
  }

  for (const patch of [{ npmError: "E403" }, { npmError: "ETIMEDOUT" }, { githubError: "403" }, { githubError: "500" }]) {
    it(`does not treat lookup error ${JSON.stringify(patch)} as a missing publication`, (t) => {
      const fx = fixture(t);
      assert.equal(prepare(fx).status, 0);
      if (patch.githubError) assert.equal(publish(fx).status, 0);
      updateRemote(fx, patch);
      const offset = existsSync(fx.log) ? calls(fx).length : 0;
      assert.notEqual(publish(fx).status, 0);
      assert.ok(calls(fx).slice(offset).every((call) => call[1] === "view" || call[1] === "api"));
    });
  }

  for (const metadata of [{}, { state: "uploaded", size: 0 }, { state: "starter", size: 1 }, { state: "starter", size: undefined }]) {
    it(`rejects a different existing asset ${JSON.stringify(metadata)} before deleting or uploading assets`, (t) => {
      const fx = fixture(t);
      assert.equal(prepare(fx).status, 0);
      updateRemote(fx, { fail: "upload" });
      assert.notEqual(publish(fx).status, 0);
      const remote = json(fx.state);
      Object.assign(remote.release.assets[0], metadata);
      updateRemote(fx, remote);
      const name = remote.release.assets[0].name;
      writeFileSync(join(fx.root, `remote-${name}`), "different bytes");
      const offset = calls(fx).length;
      const result = publish(fx);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /existing release asset hash mismatch/);
      assert.equal(calls(fx).slice(offset).filter((call) => ["upload", "edit"].includes(call[2]) || call.includes("DELETE")).length, 0);
    });
  }

  for (const [label, mutate] of [
    ["tag", (fx) => { fx.env.GITHUB_REF_NAME = "v9.0.0"; }],
    ["repository", (fx) => { fx.env.GITHUB_REPOSITORY = "someone/fork"; }],
    ["branch", (fx) => { fx.env.GITHUB_REF_TYPE = "branch"; }],
    ["plugin version", (fx) => { const file = join(fx.root, "plugins/syncky/.claude-plugin/plugin.json"); const value = json(file); value.version = "9.0.0"; writeFileSync(file, JSON.stringify(value)); }],
    ["Gemini version", (fx) => { const file = join(fx.root, "gemini-extension.json"); const value = json(file); value.version = "9.0.0"; writeFileSync(file, JSON.stringify(value)); }],
    ["packed repository", (fx) => { const file = join(fx.root, "agent/package.json"); const value = json(file); value.repository.url = "git+https://github.com/someone/fork.git"; writeFileSync(file, JSON.stringify(value)); }],
    ["tarball hash", (fx) => { const receipt = json(join(fx.release, "release.json")); writeFileSync(join(fx.release, receipt.tarball), "tampered"); }],
    ["MCPB hash", (fx) => writeFileSync(join(fx.release, "syncky-health.mcpb"), "tampered")],
    ["Registry asset", (fx) => writeFileSync(join(fx.release, "server.json"), "{}")],
    ["release sidecar", (fx) => writeFileSync(join(fx.release, "syncky-health.mcpb.sha256"), "invalid\n")],
    ["release checksum list", (fx) => writeFileSync(join(fx.release, "SHA256SUMS"), "invalid\n")],
  ]) {
    it(`rejects ${label} before npm publication and release creation`, (t) => {
      const fx = fixture(t);
      const prepared = prepare(fx);
      assert.equal(prepared.status, 0, prepared.stderr);
      mutate(fx);
      const result = publish(fx);
      assert.notEqual(result.status, 0);
      assert.equal(existsSync(fx.log), false);
    });
  }

  for (const field of ["repository", "version"]) {
    it(`rejects a repacked ${field} mismatch even with an updated receipt hash`, (t) => {
      const fx = fixture(t);
      const prepared = prepare(fx);
      assert.equal(prepared.status, 0, prepared.stderr);
      const receiptPath = join(fx.release, "release.json");
      const receipt = json(receiptPath);
      const tarball = join(fx.release, receipt.tarball);
      const unpack = join(fx.root, "unpack");
      mkdirSync(unpack);
      assert.equal(spawnSync("tar", ["-xzf", tarball, "-C", unpack]).status, 0);
      const metadata = join(unpack, "package/package.json");
      const pkg = json(metadata);
      if (field === "repository") pkg.repository.url = "git+https://github.com/someone/fork.git";
      else pkg.version = "9.0.0";
      writeFileSync(metadata, `${JSON.stringify(pkg, null, 2)}\n`);
      assert.equal(spawnSync("tar", ["-czf", tarball, "-C", unpack, ...["package/LICENSE", "package/NOTICE", "package/README.md", "package/dist/syncky-agent.mjs", "package/dist/syncky-agent.mjs.sha256", "package/package.json"]]).status, 0);
      receipt.tarballSha256 = hash(tarball);
      writeFileSync(receiptPath, JSON.stringify(receipt));
      const result = publish(fx);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /packed package metadata\/repository mismatch/);
      assert.equal(existsSync(fx.log), false);
    });
  }
});
