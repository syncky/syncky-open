import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("../server.mjs", import.meta.url));
const source = readFileSync(SERVER, "utf8");

function specifiers(text) {
  const found = [];
  for (const m of text.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/gms)) found.push(m[1]);
  for (const m of text.matchAll(/^\s*import\s*["']([^"']+)["']/gm)) found.push(m[1]);
  for (const m of text.matchAll(/\bimport\s*\(\s*([^)]*)\)/g)) found.push(m[1].trim().replace(/^["'`]|["'`]$/g, ""));
  for (const m of text.matchAll(/\brequire\s*\(\s*([^)]*)\)/g)) found.push(m[1].trim().replace(/^["'`]|["'`]$/g, ""));
  return found;
}

describe("server.mjs standalone imports", () => {
  it("is an executable node script", () => {
    assert.equal(source.split("\n")[0], "#!/usr/bin/env node");
  });

  it("imports only node: built-ins", () => {
    const found = specifiers(source);
    assert.ok(found.includes("node:http"), "the import scan found nothing; the pattern is broken");
    for (const spec of found) assert.ok(spec.startsWith("node:"), `server.mjs imports ${spec}`);
  });

  it("has no relative imports and never reaches into the repository", () => {
    assert.doesNotMatch(source, /from\s*["']\.{1,2}\/|e2e\/|agent\/src|\.\.\/\.\.\//);
  });

  it("the tests read nothing outside the package but protocol/test-vectors", () => {
    const dir = fileURLToPath(new URL(".", import.meta.url));
    for (const name of readdirSync(dir).filter((f) => f.endsWith(".js") && f !== "size.test.js")) {
      const text = readFileSync(new URL(name, import.meta.url), "utf8");
      for (const spec of specifiers(text)) {
        assert.ok(spec.startsWith("node:") || /^\.\.?\/[\w.-]+$/.test(spec), `${name} imports ${spec}`);
      }
      for (const m of text.matchAll(/\.\.\/\.\.\/[\w./-]*/g)) assert.match(m[0], /^\.\.\/\.\.\/\.\.\/protocol\/test-vectors\/$/, `${name} reaches ${m[0]}`);
    }
  });

});
