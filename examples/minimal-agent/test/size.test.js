import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const AGENT = fileURLToPath(new URL("../agent.mjs", import.meta.url));
const source = readFileSync(AGENT, "utf8");
const ALLOWED = new Set(["@hpke/core", "@hpke/dhkem-x25519", "@hpke/chacha20poly1305", "qrcode-terminal"]);

function specifiers(text) {
  const found = [];
  for (const m of text.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/gms)) found.push(m[1]);
  for (const m of text.matchAll(/^\s*import\s*["']([^"']+)["']/gm)) found.push(m[1]);
  for (const m of text.matchAll(/\bimport\s*\(\s*([^)]*)\)/g)) found.push(m[1].trim().replace(/^["'`]|["'`]$/g, ""));
  for (const m of text.matchAll(/\brequire\s*\(\s*([^)]*)\)/g)) found.push(m[1].trim().replace(/^["'`]|["'`]$/g, ""));
  return found;
}

describe("agent.mjs size and imports", () => {
  it("has at most 450 lines (counted as newline-separated lines, trailing newline excluded)", () => {
    const lines = source.replace(/\n$/, "").split("\n").length;
    assert.ok(lines <= 450, `agent.mjs has ${lines} lines`);
  });

  it("is an executable node script", () => {
    assert.equal(source.split("\n")[0], "#!/usr/bin/env node");
  });

  it("imports only node: built-ins, the three @hpke packages and qrcode-terminal", () => {
    const found = specifiers(source);
    assert.ok(found.includes("node:fs"), "the import scan found nothing; the pattern is broken");
    for (const spec of found) {
      assert.ok(spec.startsWith("node:") || ALLOWED.has(spec), `agent.mjs imports ${spec}`);
    }
  });

  it("never reaches into the full agent", () => {
    assert.doesNotMatch(source, /agent\/src|\.\.\/\.\.\/agent|from\s*["']\.{1,2}\//);
  });

  it("the import scan catches every import form", () => {
    const sample = [
      'import { a } from "./x.js";',
      'import b from "../../agent/src/crypto.js";',
      'import "side-effect";',
      'export { c } from "lodash";',
      'const d = await import("left-pad");',
      'const e = require("fs");',
      'import {\n  f,\n  g,\n} from "node:path";',
    ].join("\n");
    assert.deepEqual(specifiers(sample).sort(), ["../../agent/src/crypto.js", "./x.js", "fs", "left-pad", "lodash", "node:path", "side-effect"].sort());
  });
});
