import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { gunzipSync } from "node:zlib";

import { loadJson, loadSchemas, loadVectors, VECTOR_FILES } from "../../src/protocol-files.js";
import { TOOLS } from "../../src/mcp.js";
import { createValidator } from "../support/validator.js";
import { startRelayDouble } from "../support/relay-double.js";
import { sourceArgs } from "../support/source-suite.js";

const AGENT = fileURLToPath(new URL("../../", import.meta.url));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const same = (actual, expected) => assert.ok(isDeepStrictEqual(actual, expected), "resource contents differ");
const pkg = JSON.parse(readFileSync(join(AGENT, "package.json"), "utf8"));
const SOURCE_TEST = "node --test --experimental-test-coverage --test-coverage-include='src/**/*.js' --test-coverage-exclude='test/**' --test-coverage-lines=85 --test-coverage-branches=75 --test-coverage-functions=85 'test/unit/**/*.test.js' 'test/vectors/**/*.test.js'";

describe("release bundle", () => {
  let root;
  let result;
  let bundle;
  let isolated;
  let cwd;
  let env;
  let buildAgent;
  let fixture;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "syncky-build-"));
    if (process.env.SYNCKY_AGENT_BUNDLE_FIXTURE) {
      fixture = JSON.parse(readFileSync(process.env.SYNCKY_AGENT_BUNDLE_FIXTURE, "utf8"));
      result = fixture.release;
    } else {
      ({ buildAgent } = await import("../../build.mjs"));
      result = await buildAgent({ outdir: join(root, "first") });
    }
    bundle = await import(pathToFileURL(result.bundlePath));
    isolated = join(root, "copied bundle with spaces");
    cwd = join(root, "unrelated cwd");
    mkdirSync(isolated);
    mkdirSync(cwd);
    copyFileSync(result.bundlePath, join(isolated, "syncky-agent.mjs"));
    env = { PATH: dirname(process.execPath), HOME: root, TMPDIR: tmpdir(), SYNCKY_AGENT_HOME: join(root, "home") };
  });
  after(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  function child(args, extraEnv = {}) {
    return new Promise((resolve) => {
      const proc = spawn(process.execPath, args, { cwd, env: { ...env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => proc.kill("SIGKILL"), 20_000);
      proc.stdout.on("data", (chunk) => { stdout += chunk; });
      proc.stderr.on("data", (chunk) => { stderr += chunk; });
      proc.on("error", () => { clearTimeout(timer); resolve({ code: -1, stdout: "", stderr: "spawn failed" }); });
      proc.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    });
  }

  const cli = (args, extraEnv) => child([join(isolated, "syncky-agent.mjs"), ...args], extraEnv);
  const program = (source, extraEnv) => child(["--input-type=module", "--eval", source], { SYNCKY_TEST_BUNDLE: join(isolated, "syncky-agent.mjs"), ...extraEnv });

  async function initialized(run) {
    const relay = await startRelayDouble({ invite: "bundle-local-test-invite" });
    const home = join(root, `home-${Math.random().toString(16).slice(2)}`);
    const localEnv = { SYNCKY_AGENT_HOME: home, SYNCKY_INVITE: "bundle-local-test-invite" };
    try {
      const init = await cli(["init", "--relay", relay.url, "--name", "Bundle test"], localEnv);
      assert.ok(init.code === 0, "isolated initialization failed");
      await run({ home, localEnv, relay });
    } finally {
      await relay.stop();
    }
  }

  it("pins the builder, keeps dependency pins/coverage and accepts Node >=22.15", () => {
    const lock = JSON.parse(readFileSync(join(AGENT, "package-lock.json"), "utf8"));
    assert.equal(pkg.devDependencies.esbuild, "0.28.1");
    assert.equal(lock.packages[""].devDependencies.esbuild, "0.28.1");
    assert.equal(lock.packages["node_modules/esbuild"].version, "0.28.1");
    assert.equal(pkg.devDependencies.ajv, "8.20.0");
    assert.equal(Object.hasOwn(pkg, "dependencies"), false);
    assert.deepEqual(pkg.devDependencies, {
      "@hpke/chacha20poly1305": "1.8.0", "@hpke/core": "1.9.0", "@hpke/dhkem-x25519": "1.8.0",
      "qrcode-terminal": "0.12.0", ajv: "8.20.0", esbuild: "0.28.1",
    });
    assert.equal(pkg.engines.node, ">=22.15");
    assert.equal(lock.packages[""].engines.node, ">=22.15");
    assert.equal(pkg.license, "Apache-2.0");
    assert.equal(pkg.scripts.test, "node test/support/source-suite.js");
    assert.equal(["node", ...sourceArgs("on").map(arg => arg.includes("*") ? arg.replace(/=(.*)/, "='$1'").replace(/^(test\/.*)$/, "'$1'") : arg)].join(" "), SOURCE_TEST);
    assert.equal(pkg.scripts.build, "node build.mjs");
    assert.equal(pkg.scripts.prepack, "npm run build");
    assert.ok(readFileSync(join(AGENT, ".gitignore"), "utf8").split("\n").includes("dist/"));
  });

  it("emits one ESM and its correct SHA-256 alongside the distribution packages, with the build-time version", () => {
    assert.deepEqual(readdirSync(dirname(result.bundlePath)).sort(), ["SHA256SUMS", "agent-skills", "claude-code", "clawhub", "codex", "syncky-agent-claude-code.tar.gz", "syncky-agent-clawhub.tar.gz", "syncky-agent-codex.tar.gz", "syncky-agent-skills.tar.gz", "syncky-agent.mjs", "syncky-agent.mjs.sha256", "syncky-health.mcpb", "syncky-health.mcpb.sha256"].sort());
    const hash = digest(readFileSync(result.bundlePath));
    assert.equal(result.hash, hash);
    assert.equal(readFileSync(`${result.bundlePath}.sha256`, "utf8"), `${hash}  syncky-agent.mjs\n`);
    assert.equal(bundle.modules["runtime.js"].AGENT_VERSION, pkg.version);
  });

  it("builds a standard MCPB ZIP with a contained Node stdio manifest and all licence notices", () => {
    const archive = join(dirname(result.bundlePath), "syncky-health.mcpb");
    const unzip = (args) => {
      const run = spawnSync("/usr/bin/unzip", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
      assert.equal(run.status, 0, "independent ZIP inspection failed");
      return run.stdout;
    };
    unzip(["-t", archive]);
    const names = ["manifest.json", "syncky-agent.mjs", "LICENSE", "NOTICE", "THIRD-PARTY-NOTICES"];
    assert.deepEqual(unzip(["-Z1", archive]).trim().split("\n"), names);
    const manifest = JSON.parse(unzip(["-p", archive, "manifest.json"]));
    assert.deepEqual(manifest, {
      manifest_version: "0.3", name: "syncky-health", display_name: "Syncky Health", version: pkg.version,
      description: pkg.description,
      author: { name: "Syncky" }, license: "Apache-2.0",
      server: { type: "node", entry_point: "syncky-agent.mjs", mcp_config: { command: "node", args: ["${__dirname}/syncky-agent.mjs", "mcp"] } },
      tools: TOOLS.map(({ name, description }) => ({ name, description })),
      compatibility: { runtimes: { node: pkg.engines.node } },
    });
    assert.deepEqual(manifest.tools.map((tool) => tool.name), ["syncky_status", "syncky_inbox", "syncky_send", "syncky_ack", "syncky_skill"]);
    assert.match(manifest.description, /Apple Health/);
    assert.match(manifest.description, /MCP/);
    assert.ok(names.includes(manifest.server.entry_point));
    assert.equal(unzip(["-p", archive, manifest.server.entry_point]), readFileSync(result.bundlePath, "utf8"));
    for (const name of ["LICENSE", "NOTICE"]) assert.equal(unzip(["-p", archive, name]), readFileSync(join(AGENT, name), "utf8"));
    const notices = unzip(["-p", archive, "THIRD-PARTY-NOTICES"]);
    for (const name of ["qrcode-terminal/LICENSE", "@hpke/core/LICENSE", "ajv/LICENSE"]) {
      assert.ok(notices.includes(readFileSync(join(AGENT, "node_modules", name), "utf8").trim()), "upstream licence missing from MCPB");
    }
    for (const name of ["noble-hashes", "noble-ciphers"]) assert.ok(notices.includes(`${name} - MIT License`));
    const hash = digest(readFileSync(archive));
    assert.equal(readFileSync(`${archive}.sha256`, "utf8"), `${hash}  syncky-health.mcpb\n`);
    assert.ok(readFileSync(join(dirname(archive), "SHA256SUMS"), "utf8").split("\n").includes(`${hash}  syncky-health.mcpb`));
    const bytes = readFileSync(archive);
    const end = bytes.length - 22;
    assert.equal(bytes.readUInt32LE(end), 0x06054b50);
    assert.equal(bytes.readUInt16LE(end + 8), names.length);
    assert.equal(bytes.readUInt16LE(end + 10), names.length);
    assert.equal(bytes.readUInt16LE(end + 20), 0);
    let offset = bytes.readUInt32LE(end + 16);
    const centralStart = offset;
    let localOffset = 0;
    for (const name of names) {
      assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
      assert.equal(bytes.readUInt16LE(offset + 4), 0x0314);
      for (const field of [8, 10, 12, 30, 32, 34, 36]) assert.equal(bytes.readUInt16LE(offset + field), 0);
      assert.equal(bytes.readUInt16LE(offset + 14), 33);
      assert.equal(bytes.readUInt32LE(offset + 20), bytes.readUInt32LE(offset + 24));
      assert.equal(bytes.readUInt32LE(offset + 38), (name.endsWith(".mjs") ? 0o100755 : 0o100644) * 65536);
      const nameLength = bytes.readUInt16LE(offset + 28);
      assert.equal(bytes.subarray(offset + 46, offset + 46 + nameLength).toString(), name);
      assert.equal(bytes.readUInt32LE(offset + 42), localOffset);
      assert.equal(bytes.readUInt32LE(localOffset), 0x04034b50);
      for (const field of [6, 8, 10, 28]) assert.equal(bytes.readUInt16LE(localOffset + field), 0);
      assert.equal(bytes.readUInt16LE(localOffset + 12), 33);
      assert.equal(bytes.readUInt32LE(localOffset + 14), bytes.readUInt32LE(offset + 16));
      assert.equal(bytes.readUInt32LE(localOffset + 18), bytes.readUInt32LE(offset + 20));
      assert.equal(bytes.readUInt32LE(localOffset + 22), bytes.readUInt32LE(offset + 24));
      assert.equal(bytes.readUInt16LE(localOffset + 26), nameLength);
      assert.equal(bytes.subarray(localOffset + 30, localOffset + 30 + nameLength).toString(), name);
      localOffset += 30 + nameLength + bytes.readUInt32LE(localOffset + 18);
      offset += 46 + nameLength;
    }
    assert.equal(localOffset, centralStart);
    assert.equal(offset, end);
    assert.equal(bytes.readUInt32LE(end + 12), end - centralStart);
  });

  it("bundles all runtime packages and transitives, leaving only built-ins external", () => {
    const inputs = Object.keys(result.metafile.inputs);
    for (const name of ["@hpke/chacha20poly1305", "@hpke/core", "@hpke/dhkem-x25519", "qrcode-terminal", "ajv"]) assert.ok(inputs.some((p) => p.startsWith(`node_modules/${name}/`)), `missing package ${name}`);
    assert.ok(inputs.some((p) => p.startsWith("node_modules/@hpke/common/")));
    assert.ok(inputs.some((p) => p.startsWith("node_modules/qrcode-terminal/vendor/QRCode/")));
    assert.ok(!inputs.some((p) => p.includes("node_modules/esbuild/")));
    for (const output of Object.values(result.metafile.outputs)) {
      for (const imp of output.imports) assert.ok(imp.external && isBuiltin(imp.path), "non-built-in runtime import");
    }
    const text = readFileSync(result.bundlePath, "utf8");
    for (const path of [AGENT, root, "/Volumes/Work/", "/Users/"]) assert.ok(!text.includes(path), "private absolute path in bundle");
    for (const license of ["qrcode-terminal/LICENSE", "@hpke/core/LICENSE", "ajv/LICENSE"]) {
      assert.ok(text.includes(readFileSync(join(AGENT, "node_modules", license), "utf8").trim()), "upstream license missing");
    }
    for (const notice of ["noble-hashes - MIT License (c) 2022 Paul Miller (paulmillr.com)", "noble-ciphers - MIT License (c) 2023 Paul Miller (paulmillr.com)"]) {
      assert.ok(text.includes(notice), "vendored attribution missing");
    }
  });

  it("exports every source module with the same public names and shared internal identity", async () => {
    const files = readdirSync(join(AGENT, "src")).filter((f) => f.endsWith(".js")).sort();
    assert.deepEqual(Object.keys(bundle.modules).sort(), files);
    for (const file of files) {
      const source = await import(pathToFileURL(join(AGENT, "src", file)));
      assert.deepEqual(Object.keys(bundle.modules[file]).sort(), Object.keys(source).sort(), file);
    }
    assert.throws(() => bundle.modules["thin-transport.js"].parseRawInner("[]"), bundle.modules["thin-transport.js"].EnvelopeError);
    assert.equal(typeof bundle.runCli, "function");
  });

  it("embeds exactly the catalog, units, message table, transport vector and complete schema inventories", async () => {
    const p = bundle.modules["protocol-files.js"];
    same(p.loadJson("types.json"), loadJson("types.json"));
    same(p.loadJson("units.json"), loadJson("units.json"));
    same(p.loadJson("messages.json"), loadJson("messages.json"));
    assert.equal(bundle.modules["embedded-protocol.js"].resources["messages.json"], readFileSync(new URL("../../../protocol/messages.json", import.meta.url), "utf8"));
    assert.deepEqual(p.VECTOR_FILES, VECTOR_FILES);
    for (const file of VECTOR_FILES) assert.ok(existsSync(new URL(`../../../protocol/test-vectors/${file}`, import.meta.url)));
    for (const file of VECTOR_FILES) same(p.loadVectors(file), loadVectors(file));
    same(p.loadSchemas(), loadSchemas());
    const keys = Object.keys(bundle.modules["embedded-protocol.js"].resources).sort();
    assert.deepEqual(keys, ["types.json", "units.json", "messages.json", ...VECTOR_FILES.map((f) => `test-vectors/${f}`), ...loadSchemas().map((s) => `schemas/${s.$id.split("/").pop()}`)].sort());
    const validator = await createValidator({ schemas: p.loadSchemas() });
    assert.equal(validator.validate("test-vectors.schema.json", "fingerprints_file", p.loadVectors("fingerprints")).ok, true);
    const broken = p.loadVectors("fingerprints");
    delete broken.cases[0].fingerprint;
    assert.equal(validator.validate("test-vectors.schema.json", "fingerprints_file", broken).ok, false);
    const types = p.loadJson("types.json");
    types.types.length = 0;
    same(p.loadJson("types.json"), loadJson("types.json"));
    const schemas = p.loadSchemas();
    schemas[0].$id = "mutated";
    same(p.loadSchemas(), loadSchemas());
    const messages = p.loadJson("messages.json");
    messages.messages = {};
    same(p.loadJson("messages.json"), loadJson("messages.json"));
    assert.throws(() => p.loadJson("missing.json"), /protocol file not readable: missing.json \(ENOENT\)/);
  });

  it("serves exact package bootstrap bytes from a copied bundle and refuses external updates before fetching", async () => {
    const bootstrap = readFileSync(join(AGENT, "skills/syncky/bootstrap.json"));
    const initial = JSON.parse(Buffer.from(JSON.parse(bootstrap).payload, "base64"));
    const run = await program(`
      import assert from 'node:assert/strict';
      import { createHash } from 'node:crypto';
      import { mkdirSync, readdirSync } from 'node:fs';
      import { pathToFileURL } from 'node:url';
      const { modules: m } = await import(pathToFileURL(process.env.SYNCKY_TEST_BUNDLE));
      const home = process.env.SYNCKY_AGENT_HOME + '-skill';
      mkdirSync(home, { mode: 0o700 });
      let fetches = 0;
      const updater = m['skill-update.js'].createSkillUpdater({ home, fetch: async () => { fetches++; throw new Error('unexpected fetch'); } });
      const initial = updater.read();
      assert.equal(createHash('sha256').update(initial.envelopeBytes).digest('hex'), ${JSON.stringify(digest(bootstrap))});
      assert.equal(initial.document.skill_version, ${initial.skill_version});
      assert.equal(initial.previous, null);
      assert.deepEqual(readdirSync(home), []);
      updater.observeHeartbeat({ skill_update: { skill_version: initial.document.skill_version + 1, url: 'https://dev.syncky.app/agent-skill.json' } });
      assert.equal((await updater.tick()).code, 'skill_key_unset');
      assert.equal(fetches, 0);
      process.stdout.write('offline bootstrap ok');
    `);
    assert.ok(run.code === 0 && run.stdout === "offline bootstrap ok", "isolated skill bootstrap failed");
    assert.ok(!existsSync(join(root, "skills")) && !existsSync(join(isolated, "skills")));
  });

  it("uses the copied bundle's message table and local schema validator without files, packages or fetching refs", async () => {
    const run = await program(`
      import assert from 'node:assert/strict';
      import { pathToFileURL } from 'node:url';
      const { modules: m } = await import(pathToFileURL(process.env.SYNCKY_TEST_BUNDLE));
      let fetches = 0;
      globalThis.fetch = () => { fetches++; throw new Error('unexpected fetch'); };
      const p = m['protocol-files.js'];
      const table = p.loadJson('messages.json');
      const transport = m['thin-transport.js'].createThinTransport({ table });
      assert.deepEqual(transport.rule('future'), table.default);
      assert.deepEqual(transport.rule('diagnostics_request'), table.messages.diagnostics_request);
      const validate = m['send.js'].createLocalValidator(p.loadSchemas());
      validate({ type: 'resumed', v: 1 });
      validate({ type: 'future', v: 999 });
      assert.throws(() => validate({ type: 'resumed', v: 999 }), { code: 'schema_invalid' });
      const local = m['send.js'].createLocalValidator([{ $defs: { future: {
        type: 'object', required: ['type', 'value'],
        properties: { type: { const: 'future' }, value: { type: 'integer' } }
      } } }]);
      local({ type: 'future', value: 1 });
      assert.throws(() => local({ type: 'future', value: 'bad' }), { code: 'schema_invalid' });
      const remote = m['send.js'].createLocalValidator([{ $id: 'https://example.invalid/local',
        properties: { type: { const: 'future' } }, $ref: 'https://example.invalid/remote'
      }]);
      assert.throws(() => remote({ type: 'future' }), { code: 'schema_invalid' });
      assert.equal(fetches, 0);
      process.stdout.write('local validation ok');
    `);
    assert.ok(run.code === 0 && run.stdout === "local validation ok", "isolated transport/schema validation failed");
    assert.ok(!existsSync(join(root, "node_modules")) && !existsSync(join(root, "protocol")));
  });

  it("honors explicit filesystem overrides, invalid JSON and missing-directory errors", async () => {
    const p = bundle.modules["protocol-files.js"];
    const override = join(root, "override");
    mkdirSync(override);
    writeFileSync(join(override, "types.json"), '{"override":true}');
    writeFileSync(join(override, "messages.json"), '{"override":true}');
    const dir = p.protocolDir({ SYNCKY_PROTOCOL_DIR: override });
    assert.deepEqual(p.loadJson("types.json", dir), { override: true });
    assert.deepEqual(p.loadJson("messages.json", dir), { override: true });
    assert.throws(() => p.loadVectors("keys", dir), /protocol file not readable: test-vectors\/keys.json \(ENOENT\)/);
    assert.throws(() => p.loadSchemas(dir), { code: "ENOENT" });
    writeFileSync(join(override, "types.json"), "{bad json");
    assert.throws(() => p.loadJson("types.json", dir), /protocol file is not valid JSON: types.json/);
    const missing = p.protocolDir({ SYNCKY_PROTOCOL_DIR: join(override, "missing") });
    assert.throws(() => p.loadJson("types.json", missing), /ENOENT/);
    assert.throws(() => p.loadSchemas(missing), { code: "ENOENT" });
    const check = await cli(["selftest", "--json"], { SYNCKY_PROTOCOL_DIR: override });
    assert.ok(check.code !== 0, "bad explicit directory unexpectedly used embedded resources");
  });

  it("imports a copied bundle without CLI output, home creation or umask changes", async () => {
    assert.deepEqual(readdirSync(isolated), ["syncky-agent.mjs"]);
    const run = await program(`
      import { pathToFileURL } from 'node:url';
      import { existsSync } from 'node:fs';
      const mask = process.umask();
      const bundle = await import(pathToFileURL(process.env.SYNCKY_TEST_BUNDLE));
      if (process.umask() !== mask || existsSync(process.env.SYNCKY_AGENT_HOME)) process.exit(1);
      if (typeof bundle.modules['cli.js'].main !== 'function') process.exit(2);
      process.stdout.write('import ok');
    `);
    assert.ok(run.code === 0 && run.stdout === "import ok", "import had side effects or failed in isolation");
    assert.ok(!existsSync(env.SYNCKY_AGENT_HOME));
  });

  it("runs isolated help and every existing semantic selftest without fallback files", async () => {
    const help = await cli(["help"]);
    assert.ok(help.code === 0 && help.stdout.includes("inbox") && help.stdout.includes("selftest"), "isolated help failed");
    const test = await cli(["selftest", "--json"]);
    assert.ok(test.code === 0, "isolated selftest failed");
    const actual = JSON.parse(test.stdout);
    const expected = await bundle.modules["selftest.js"].runSelftest();
    same(actual, expected);
    assert.equal(actual.ok, true);
    assert.deepEqual(actual.files.map(f => f.file), [
      "rfc9180-auth-x25519-sha256-chacha20poly1305.json", "keys.json", "envelopes.json", "envelopes-negative.json",
      "envelope-shape.json", "fingerprints.json", "pair-uris.json", "pair-codes.json",
    ]);
    assert.ok(!existsSync(join(root, "node_modules")) && !existsSync(join(root, "protocol")));
    assert.deepEqual(readdirSync(cwd), []);
  });

  it("reads raw local inbox offline and preserves private file modes", async () => {
    await initialized(async ({ home, localEnv, relay }) => {
      const seed = await program(`
        import { pathToFileURL } from 'node:url';
        const { modules: m } = await import(pathToFileURL(process.env.SYNCKY_TEST_BUNDLE));
        m['inbox.js'].createInbox(process.env.SYNCKY_AGENT_HOME).append({ seq: 1, from: 'm_dev_1', kind: 'data', type: 'future', received_at: new Date().toISOString(), inner: { type: 'future', extra: [1, 2] } });
      `, localEnv);
      assert.equal(seed.code, 0);
      const before = relay.state.requests.length, read = await cli(['inbox'], localEnv);
      assert.equal(read.code, 0); assert.deepEqual(JSON.parse(read.stdout).records[0].inner, { type: 'future', extra: [1, 2] });
      assert.equal(relay.state.requests.length, before);
      assert.equal(statSync(home).mode & 0o777, 0o700);
      for (const file of readdirSync(home).filter(f => statSync(join(home, f)).isFile())) assert.equal(statSync(join(home, file)).mode & 0o077, 0);
    });
  });

  it("renders terminal pairing QR and code from the isolated CLI", async () => {
    await initialized(async ({ localEnv }) => {
      const pair = await cli(["pair"], localEnv);
      assert.ok(pair.code === 0, "isolated terminal pairing failed");
      assert.ok(/[▀▄█]/.test(pair.stdout) && pair.stdout.split("\n").length > 10, "terminal QR missing");
      assert.ok(/code: \d{3} \d{3} \d{3}/.test(pair.stdout), "pairing code missing");
    });
  });

  it("rejects removed web/server commands without creating files", async () => {
    for (const command of ['serve', 'webhook', 'summary', 'cmd']) assert.equal((await cli([command])).code, 1);
  });

  it("produces the same release payload and hash on a repeat build", async () => {
    const again = fixture?.repeat ?? await buildAgent({ outdir: join(root, "second") });
    assert.equal(digest(readFileSync(again.bundlePath)), digest(readFileSync(result.bundlePath)));
    assert.equal(again.hash, result.hash);
    assert.equal(readFileSync(`${again.bundlePath}.sha256`, "utf8"), readFileSync(`${result.bundlePath}.sha256`, "utf8"));
    assert.equal(readFileSync(join(dirname(again.bundlePath), "SHA256SUMS"), "utf8"), readFileSync(join(dirname(result.bundlePath), "SHA256SUMS"), "utf8"));
    for (const name of ["syncky-health.mcpb", "syncky-health.mcpb.sha256"]) {
      assert.ok(readFileSync(join(dirname(result.bundlePath), name)).equals(readFileSync(join(dirname(again.bundlePath), name))), "MCPB bytes changed between builds");
    }
    for (const name of readdirSync(dirname(result.bundlePath)).filter((file) => file.endsWith(".tar.gz"))) {
      const first = readFileSync(join(dirname(result.bundlePath), name));
      const second = readFileSync(join(dirname(again.bundlePath), name));
      assert.equal(digest(first), digest(second), "archive changed between builds");
      assert.equal(first[3], 0, "gzip carries optional metadata");
      assert.equal(first.readUInt32LE(4), 0, "gzip carries a timestamp");
      const tar = gunzipSync(first);
      const entries = [];
      for (let offset = 0; tar[offset] !== 0;) {
        const header = tar.subarray(offset, offset + 512);
        const field = (start, size) => header.subarray(start, start + size).toString("utf8").replace(/\0.*$/s, "");
        const number = (start, size) => parseInt(field(start, size).trim(), 8);
        assert.ok(["0", "5"].includes(field(156, 1)), "archive carries extended metadata");
        assert.equal(number(108, 8), 0, "archive carries builder uid");
        assert.equal(number(116, 8), 0, "archive carries builder gid");
        assert.equal(number(136, 12), 0, "archive carries a timestamp");
        assert.equal(field(265, 32), "", "archive carries an owner name");
        assert.equal(field(297, 32), "", "archive carries a group name");
        assert.ok(!/com\.apple\.|__MACOSX|(^|\/)\._/.test(field(0, 100)), "archive carries macOS metadata");
        entries.push(field(0, 100).replace(/\/$/, ""));
        offset += 512 + Math.ceil(number(124, 12) / 512) * 512;
      }
      const tree = entries[0];
      assert.deepEqual(entries.sort(), [tree, ...readdirSync(join(dirname(result.bundlePath), tree), { recursive: true }).map((path) => `${tree}/${path}`)].sort());
    }
  });
});
