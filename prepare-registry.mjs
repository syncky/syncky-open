import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const REPOSITORY = "syncky/syncky-open";
export const MCP_NAME = "io.github.syncky/syncky-health";
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const readJSON = (path) => JSON.parse(readFileSync(path, "utf8"));
export const ensure = (condition, message) => { if (!condition) throw new Error(message); };

export function registryDraft(draft, pkg) {
  ensure(pkg.name === "@syncky/agent" && pkg.mcpName === MCP_NAME, "package identity mismatch");
  ensure(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(pkg.version), "invalid package version");
  ensure(draft.$schema === "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json", "Registry schema mismatch");
  ensure(typeof draft.description === "string" && [...draft.description].length <= 100, "Registry description must be at most 100 characters");
  ensure(draft.name === MCP_NAME && draft.version === pkg.version, "Registry version or identity mismatch");
  ensure(draft.repository?.url === `https://github.com/${REPOSITORY}` && draft.repository.source === "github", "Registry repository mismatch");
  ensure(draft.websiteUrl === "https://syncky.app/agents", "Registry website mismatch");
  ensure(draft.packages?.length === 2, "expected npm and MCPB distributions");
  const [npm, mcpb] = draft.packages;
  ensure(npm.registryType === "npm" && npm.identifier === pkg.name && npm.version === pkg.version, "Registry npm version or identity mismatch");
  ensure(npm.registryBaseUrl === "https://registry.npmjs.org" && npm.runtimeHint === "npx", "Registry npm runtime mismatch");
  ensure(JSON.stringify(npm.packageArguments) === JSON.stringify([{ type: "positional", value: "mcp" }]), "Registry npm arguments mismatch");
  ensure(mcpb.registryType === "mcpb" && mcpb.identifier === `https://github.com/${REPOSITORY}/releases/download/v${pkg.version}/syncky-health.mcpb`, "MCPB release URL mismatch");
  ensure(npm.transport?.type === "stdio" && mcpb.transport?.type === "stdio", "Registry transport mismatch");
  ensure(!Object.hasOwn(mcpb, "fileSha256"), "source draft must omit MCPB hash");
  return draft;
}

export function checksumEntries(dist) {
  const entries = new Map();
  for (const line of readFileSync(join(dist, "SHA256SUMS"), "utf8").trimEnd().split("\n")) {
    const match = /^([a-f0-9]{64})  ([a-z0-9.-]+)$/.exec(line);
    ensure(match && !entries.has(match[2]), "invalid or duplicate checksum entry");
    entries.set(match[2], match[1]);
  }
  return entries;
}

export function registryAsset(draftPath, packagePath, dist) {
  const draft = registryDraft(readJSON(draftPath), readJSON(packagePath));
  const name = "syncky-health.mcpb";
  const hash = sha256(readFileSync(join(dist, name)));
  ensure(readFileSync(join(dist, `${name}.sha256`), "utf8") === `${hash}  ${name}\n`, "MCPB sidecar mismatch");
  ensure(checksumEntries(dist).get(name) === hash, "MCPB checksum list mismatch");
  draft.packages[1].fileSha256 = hash;
  return `${JSON.stringify(draft, null, 2)}\n`;
}

function canonical(path) {
  if (existsSync(path)) return realpathSync(path);
  return join(canonical(dirname(path)), relative(dirname(path), path));
}

export function prepareRegistry(draftPath, packagePath, dist, output) {
  const target = canonical(resolve(output));
  const build = canonical(resolve(dist));
  const rel = relative(build, target);
  ensure(target !== canonical(resolve(draftPath)) && rel !== "" && (rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)), "Registry output must be separate from the source draft and build directory");
  const text = registryAsset(draftPath, packagePath, dist);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text);
  return target;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    ensure(process.argv.length === 6, "usage: node prepare-registry.mjs <draft> <package> <dist> <output>");
    prepareRegistry(...process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`prepare-registry: ${error.message}\n`);
    process.exitCode = 1;
  }
}
