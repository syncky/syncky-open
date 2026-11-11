#!/usr/bin/env node
import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { build } from "esbuild";

const HERE = fileURLToPath(new URL(".", import.meta.url));
export const STATIC_FILES = ["index.html", "demo.css"];

export function relayOrigin(value) {
  const url = URL.parse(value ?? "");
  if (!url || !/^https?:$/.test(url.protocol) || url.origin !== value.replace(/\/$/, "")) throw new Error("--relay must be an http(s) origin, for example https://relay.syncky.app");
  return url.origin;
}

export async function buildDemo({ relay = "https://relay.syncky.app", out = join(HERE, "dist") } = {}) {
  const origin = relayOrigin(relay);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  await build({
    entryPoints: [join(HERE, "src/main.mjs")],
    outfile: join(out, "demo.js"),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: ["safari17", "chrome120"],
    minify: true,
    legalComments: "eof",
    logLevel: "warning",
    define: { __SYNCKY_RELAY__: JSON.stringify(origin) },
  });
  for (const file of STATIC_FILES) copyFileSync(join(HERE, file), join(out, file));
  return { out, files: ["demo.js", ...STATIC_FILES], relay: origin, size: readFileSync(join(out, "demo.js")).length };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { values } = parseArgs({ options: { relay: { type: "string" }, out: { type: "string" } }, strict: true });
  try {
    const result = await buildDemo(values);
    console.log(`browser demo: ${result.files.join(", ")} in ${result.out} (relay ${result.relay}, demo.js ${result.size} bytes)`);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 2;
  }
}
