import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resources } from "./embedded-protocol.js";

const DEFAULT_PROTOCOL_DIR = new URL("../../protocol/", import.meta.url);

export const SCHEMA_ID_BASE = "https://syncky.app/protocol/schemas/";

export const VECTOR_FILES = Object.freeze([
  "rfc9180-auth-x25519-sha256-chacha20poly1305.json",
  "keys.json",
  "envelopes.json",
  "envelopes-negative.json",
  "envelope-shape.json",
  "inner-messages.json",
  "series-parts.json",
  "fingerprints.json",
  "pair-uris.json",
  "pair-codes.json",
]);

export function protocolDir(env = process.env) {
  const override = env.SYNCKY_PROTOCOL_DIR;
  if (!override) return DEFAULT_PROTOCOL_DIR;
  return pathToFileURL(override.endsWith("/") ? override : `${override}/`);
}

export function protocolPath(relPath, dir = protocolDir()) {
  return fileURLToPath(new URL(relPath, dir));
}

export function loadJson(relPath, dir = protocolDir()) {
  let text;
  try {
    if (resources !== null && dir === DEFAULT_PROTOCOL_DIR) {
      if (!Object.hasOwn(resources, relPath)) throw Object.assign(new Error(), { code: "ENOENT" });
      text = resources[relPath];
    } else {
      text = readFileSync(protocolPath(relPath, dir), "utf8");
    }
  } catch (err) {
    throw new Error(`protocol file not readable: ${relPath} (${err.code ?? err.message})`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`protocol file is not valid JSON: ${relPath} (${err.message})`);
  }
}

export function loadVectors(name, dir = protocolDir()) {
  const file = name.endsWith(".json") ? name : `${name}.json`;
  return loadJson(`test-vectors/${file}`, dir);
}

export function loadSchemas(dir = protocolDir()) {
  if (resources !== null && dir === DEFAULT_PROTOCOL_DIR) {
    return Object.keys(resources)
      .filter((f) => f.startsWith("schemas/") && f.endsWith(".schema.json"))
      .sort()
      .map((f) => loadJson(f, dir));
  }
  const schemaDir = protocolPath("schemas/", dir);
  return readdirSync(schemaDir)
    .filter((f) => f.endsWith(".schema.json"))
    .sort()
    .map((f) => loadJson(`schemas/${f}`, dir));
}
