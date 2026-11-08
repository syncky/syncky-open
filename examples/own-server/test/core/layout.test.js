import { it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const root = new URL("../../", import.meta.url);
export function sources(dir = new URL("src/", root)) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? sources(new URL(`${e.name}/`, dir)) : e.name.endsWith(".js") ? [new URL(e.name, dir)] : []);
}

it("has exact dev pins, Apache metadata, no runtime dependencies and public commands", () => {
  const p = JSON.parse(readFileSync(new URL("package.json", root)));
  assert.equal(p.license, "Apache-2.0");
  assert.equal(p.type, "module");
  assert.equal(p.engines.node, ">=22.15");
  assert.deepEqual(p.dependencies ?? {}, {});
  assert.deepEqual(p.devDependencies, { "@cloudflare/vitest-pool-workers": "0.22.0", vitest: "4.1.11", wrangler: "4.124.0" });
  for (const name of ["test:core", "test:worker", "test:docker", "test"]) assert.equal(typeof p.scripts[name], "string");
  const lock = JSON.parse(readFileSync(new URL("package-lock.json", root)));
  assert.deepEqual(lock.packages[""].devDependencies, p.devDependencies);
  for (const [name, version] of Object.entries(p.devDependencies)) assert.equal(lock.packages[`node_modules/${name}`].version, version);
  for (const name of [".gitignore", ".dockerignore"]) {
    const text = readFileSync(new URL(name, root), "utf8");
    for (const state of ["node_modules", ".wrangler", ".env", ".dev.vars", ".sqlite"]) assert.ok(text.includes(state), "local state excluded");
  }
});

it("keeps shared source platform-neutral with relative package-local imports", () => {
  for (const path of sources()) {
    const source = readFileSync(path, "utf8");
    assert.ok(!/node:|\bBuffer\b|\brequire\s*\(|\bprocess\b|\bDeno\b|\bBun\b|\bimport\s*\(/.test(source), "shared source has no runtime platform branch");
    for (const m of source.matchAll(/(?:from\s*|import\s*)["']([^"']+)["']/g)) {
      assert.ok(m[1].startsWith("./"), "shared imports stay within the shared directory");
      assert.ok(new URL(m[1], path).href.startsWith(new URL("src/", root).href), "import stays local");
    }
  }
});

it("has a compact local write contract with bounds, units and category names", () => {
  const c = JSON.parse(readFileSync(new URL("src/write-catalog.json", root)));
  assert.equal(c.protocol_version, 1);
  assert.equal(c.types.dietary_water.kind, "quantity");
  assert.equal(c.types.dietary_water.unit, "L");
  assert.equal(typeof c.types.dietary_water.max, "number");
  assert.ok(c.types.sleep_analysis.values.includes("asleep_core"));
  assert.ok(!Object.hasOwn(c.types, "workout"));
  assert.equal(c.command_schema.$defs.version.minimum, 1);
  assert.ok(c.units.some(f => f.units.some(u => u.unit === "L")));
});
