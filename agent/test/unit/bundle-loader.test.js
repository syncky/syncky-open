import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { LocalStateError } from "../../src/config.js";
import { resources } from "../../src/embedded-protocol.js";
import { agentBin } from "../support/agent-bin.js";
import { createFacades } from "../support/bundle-loader.js";
import { discoverTests, sourceModuleExports, suiteFiles } from "../support/bundle-suite.js";

const AGENT = fileURLToPath(new URL("../../", import.meta.url));
const REGISTER = fileURLToPath(new URL("../support/register-bundle.js", import.meta.url));

describe("bundle test harness", () => {
  let root;
  let fixture;
  let manifest;
  let bundle;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "syncky-loader-"));
    if (process.env.SYNCKY_AGENT_BUNDLE_FIXTURE) {
      fixture = JSON.parse(readFileSync(process.env.SYNCKY_AGENT_BUNDLE_FIXTURE, "utf8"));
    } else {
      const { buildAgent } = await import("../../build.mjs");
      fixture = { release: await buildAgent({ outdir: join(root, "release with spaces") }), exports: await sourceModuleExports() };
    }
    manifest = join(root, "fixture.json");
    writeFileSync(manifest, JSON.stringify(fixture));
    symlinkSync(join(AGENT, "src"), join(root, "source link"), "dir");
    bundle = await import(pathToFileURL(fixture.release.bundlePath));
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  function child(source, fixturePath = manifest) {
    const env = { ...process.env, SYNCKY_AGENT_BUNDLE_FIXTURE: fixturePath, SYNCKY_AGENT_BIN: fixture.release.bundlePath };
    delete env.NODE_OPTIONS;
    return spawnSync(process.execPath, ["--import", REGISTER, "--input-type=module", "--eval", source], {
      env, encoding: "utf8", timeout: 20_000,
    });
  }

  it("selects the source binary by default and honors the single override", () => {
    assert.equal(agentBin({}), join(AGENT, "bin", "syncky-agent.js"));
    assert.equal(agentBin({ SYNCKY_AGENT_BIN: "/local bundle/agent.mjs" }), "/local bundle/agent.mjs");
    assert.equal(agentBin({ SYNCKY_AGENT_BIN: "" }), agentBin({}));
    assert.equal(agentBin(), process.env.SYNCKY_AGENT_BIN || agentBin({}));
  });

  it("discovers exactly the source command's complete unit/vector inventory", () => {
    const files = suiteFiles();
    assert.deepEqual(files, discoverTests());
    for (const file of ["test/unit/build.test.js", "test/unit/distribution.test.js", "test/unit/npm-package.test.js", "test/unit/bundle-loader.test.js", "test/unit/agents-doc.test.js", "test/vectors/schemas.test.js", "test/vectors/inner-messages.test.js", "test/vectors/envelopes-negative.test.js"]) assert.ok(files.includes(file), file);
    const nested = join(root, "inventory");
    for (const file of ["test/unit/a.test.js", "test/unit/nested/b.test.js", "test/vectors/c.test.js", "test/e2e/excluded.test.js", "test/unit/support.js"]) {
      const path = join(nested, file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "");
    }
    assert.deepEqual(discoverTests(undefined, nested), ["test/unit/a.test.js", "test/unit/nested/b.test.js", "test/vectors/c.test.js"]);
    const pkg = JSON.parse(readFileSync(join(AGENT, "package.json"), "utf8"));
    assert.throws(() => suiteFiles({ ...pkg, scripts: { ...pkg.scripts, test: "node --test test/vectors/schemas.test.js" } }), /test inventories differ/);
  });

  it("maps every module/export and rejects missing, extra or mismatched mappings", async () => {
    assert.deepEqual(await sourceModuleExports(), fixture.exports);
    const facades = createFacades(bundle.modules, fixture.exports, pathToFileURL(fixture.release.bundlePath).href);
    assert.deepEqual(Object.keys(facades).sort(), Object.keys(fixture.exports).sort());
    const missingModule = { ...bundle.modules };
    delete missingModule["config.js"];
    assert.throws(() => createFacades(missingModule, fixture.exports, "file:///bundle.mjs"), /bundle module mapping differs/);
    assert.throws(() => createFacades({ ...bundle.modules, "extra.js": {} }, fixture.exports, "file:///bundle.mjs"), /bundle module mapping differs/);
    const missingExport = { ...bundle.modules, "config.js": { ...bundle.modules["config.js"] } };
    delete missingExport["config.js"].LocalStateError;
    assert.throws(() => createFacades(missingExport, fixture.exports, "file:///bundle.mjs"), /bundle export mapping differs: config.js/);
    assert.throws(() => createFacades({ ...bundle.modules, "config.js": { ...bundle.modules["config.js"], extra: true } }, fixture.exports, "file:///bundle.mjs"), /bundle export mapping differs: config.js/);
  });

  it("redirects static/dynamic imports and shares classes, functions and state with the release", () => {
    const sourceUrl = (file) => JSON.stringify(pathToFileURL(join(AGENT, "src", file)).href);
    const check = child(`
      import assert from 'node:assert/strict';
      import { modules } from ${JSON.stringify(pathToFileURL(fixture.release.bundlePath).href)};
      import { LocalStateError } from ${sourceUrl("config.js")};
      import { main } from ${sourceUrl("cli.js")};
      import { resources } from ${sourceUrl("embedded-protocol.js")};
      const dynamic = await import(${sourceUrl("config.js")});
      const alias = await import(${JSON.stringify(new URL("../../src/config.js?identity", import.meta.url).href)});
      const symlink = await import(${JSON.stringify(pathToFileURL(join(root, "source link", "config.js")).href)});
      assert.equal(LocalStateError, modules['config.js'].LocalStateError);
      assert.equal(dynamic, alias);
      assert.equal(dynamic, symlink);
      assert.equal(main, modules['cli.js'].main);
      assert.equal(resources, modules['embedded-protocol.js'].resources);
      assert.ok(resources['test-vectors/envelopes.json']);
      for (const [file, namespace] of Object.entries(modules)) {
        const facade = await import(new URL(file, ${JSON.stringify(new URL("../../src/", import.meta.url).href)}));
        assert.deepEqual(Object.keys(facade).sort(), Object.keys(namespace).sort());
        for (const name of Object.keys(namespace)) assert.equal(facade[name], namespace[name]);
      }
      const { runCli } = await import(${JSON.stringify(new URL("../support/helpers.js", import.meta.url).href)});
      const res = await runCli(['--help']);
      assert.equal(res.code, 0);
      assert.match(res.stdout, /^usage: syncky-agent/);
      process.stdout.write('bundle provenance ok');
    `);
    assert.ok(check.status === 0 && check.stdout === "bundle provenance ok", "bundle import provenance/identity check failed");
    if (process.env.SYNCKY_AGENT_BUNDLE_FIXTURE) {
      assert.equal(LocalStateError, bundle.modules["config.js"].LocalStateError);
      assert.equal(resources, bundle.modules["embedded-protocol.js"].resources);
    } else {
      assert.equal(resources, null);
      assert.notEqual(LocalStateError, bundle.modules["config.js"].LocalStateError);
    }
  });

  it("fails closed for unmapped source imports and unknown exports", () => {
    const unmapped = child(`await import(${JSON.stringify(new URL("../../src/unmapped.js", import.meta.url).href)});`);
    assert.notEqual(unmapped.status, 0);
    assert.match(unmapped.stderr, /unmapped bundle source module/);
    const unknown = child(`import { notAnExport } from ${JSON.stringify(new URL("../../src/config.js", import.meta.url).href)};`);
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.stderr, /does not provide an export named 'notAnExport'/);
    const broken = join(root, "broken.json");
    writeFileSync(broken, JSON.stringify({ ...fixture, exports: { ...fixture.exports, "missing.js": [] } }));
    const mismatch = child("process.stdout.write('must not execute')", broken);
    assert.notEqual(mismatch.status, 0);
    assert.equal(mismatch.stdout, "");
    assert.match(mismatch.stderr, /bundle module mapping differs/);
  });

  it("refuses a nested suite before building or spawning tests", () => {
    const result = child(`
      import assert from 'node:assert/strict';
      import { runBundleSuite } from ${JSON.stringify(new URL("../support/bundle-suite.js", import.meta.url).href)};
      await assert.rejects(runBundleSuite(), /nested bundle suite/);
      process.stdout.write('recursion blocked');
    `);
    assert.ok(result.status === 0 && result.stdout === "recursion blocked", "bundle runner recursed");
  });
});
