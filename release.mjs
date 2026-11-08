import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { checksumEntries, ensure, prepareRegistry, readJSON, registryAsset, registryDraft, REPOSITORY, sha256 } from "./prepare-registry.mjs";

const ROOT = fileURLToPath(new URL("./", import.meta.url));
export const MCP_PUBLISHER = Object.freeze({ version: "v1.8.7", asset: "mcp-publisher_linux_amd64.tar.gz",
  checksums: "registry_1.8.7_checksums.txt", sha256: "00b21004149a4ce66f0782508ae4a2bce67d1bea395a8da0bd8028159fb59579" });
export const ASSETS = ["syncky-agent.mjs", "syncky-agent.mjs.sha256", "syncky-health.mcpb", "syncky-health.mcpb.sha256", "SHA256SUMS", "server.json",
  ...["claude-code", "codex", "clawhub", "skills"].map((name) => `syncky-agent-${name}.tar.gz`)].sort();
const INVENTORY = ["LICENSE", "NOTICE", "README.md", "dist/syncky-agent.mjs", "dist/syncky-agent.mjs.sha256", "package.json"].map((name) => `package/${name}`).sort();
const digest = (path) => sha256(readFileSync(path));
const execute = (command, args, cwd, stdio = ["ignore", "pipe", "pipe"]) => execFileSync(command, args, { cwd, encoding: "utf8", stdio, maxBuffer: 8 * 1024 * 1024, timeout: 120_000 });

export function installPublisher(root, installDir, env = process.env, publisher = MCP_PUBLISHER) {
  const output = resolve(installDir);
  ensure(!existsSync(output), "publisher directory must be fresh");
  mkdirSync(output, { recursive: true });
  const base = `https://github.com/modelcontextprotocol/registry/releases/download/${publisher.version}`;
  for (const file of [publisher.asset, publisher.checksums]) {
    try {
      execute("curl", ["--fail", "--silent", "--show-error", "--location", "--max-time", "90", "--output", join(output, file), `${base}/${file}`], root);
    } catch { throw new Error(`publisher download failed: ${file}`); }
  }
  const entries = readFileSync(join(output, publisher.checksums), "utf8").split(/\r?\n/).filter((line) => line.endsWith(`  ${publisher.asset}`));
  ensure(entries.length === 1 && entries[0] === `${publisher.sha256}  ${publisher.asset}`, "publisher checksum entry mismatch");
  const archive = join(output, publisher.asset);
  ensure(digest(archive) === publisher.sha256, "publisher archive hash mismatch");
  execute("tar", ["-xzf", archive, "-C", output, "mcp-publisher"], root);
  chmodSync(join(output, "mcp-publisher"), 0o755);
  if (env.GITHUB_PATH) appendFileSync(env.GITHUB_PATH, `${output}\n`);
}

export function validateManifests(root, env) {
  ensure(env.GITHUB_REPOSITORY === REPOSITORY, "release repository mismatch");
  ensure(env.GITHUB_REF_TYPE === "tag", "release requires a tag");
  const pkg = readJSON(join(root, "agent/package.json"));
  ensure(env.GITHUB_REF_NAME === `v${pkg.version}`, "tag/package version mismatch");
  ensure(pkg.repository?.type === "git" && pkg.repository.url === `git+https://github.com/${REPOSITORY}.git` && pkg.repository.directory === "agent", "package repository mismatch");
  ensure(pkg.private === undefined && pkg.license === "Apache-2.0", "package publication metadata mismatch");
  const lock = readJSON(join(root, "agent/package-lock.json"));
  ensure(lock.name === pkg.name && lock.packages[""].name === pkg.name && lock.version === pkg.version && lock.packages[""].version === pkg.version, "package lock mismatch");
  registryDraft(readJSON(join(root, "server.json")), pkg);
  for (const file of ["plugins/syncky/.claude-plugin/plugin.json", "gemini-extension.json"]) {
    const manifest = readJSON(join(root, file));
    ensure(manifest.name === "syncky" && manifest.version === pkg.version, `${file} version mismatch`);
  }
  return pkg;
}

function validateBuild(root, pkg, dist = join(root, "agent/dist")) {
  const sums = checksumEntries(dist);
  const names = ASSETS.filter((name) => name.endsWith(".tar.gz") || name.endsWith(".mcpb") || name.endsWith(".mjs"));
  ensure(JSON.stringify([...sums.keys()].sort()) === JSON.stringify(names.sort()), "build checksum inventory mismatch");
  for (const name of names) ensure(sums.get(name) === digest(join(dist, name)), `${name} build hash mismatch`);
  for (const name of ["syncky-agent.mjs", "syncky-health.mcpb"]) ensure(readFileSync(join(dist, `${name}.sha256`), "utf8") === `${sums.get(name)}  ${name}\n`, `${name} sidecar mismatch`);
  const mcpb = JSON.parse(execute("unzip", ["-p", join(dist, "syncky-health.mcpb"), "manifest.json"], root));
  ensure(mcpb.version === pkg.version, "built MCPB version mismatch");
  for (const [tree, host] of [["claude-code", "claude"], ["codex", "codex"]]) {
    const manifest = JSON.parse(execute("tar", ["-xOzf", join(dist, `syncky-agent-${tree}.tar.gz`), `${tree}/plugins/syncky/.${host}-plugin/plugin.json`], root));
    ensure(manifest.version === pkg.version, "built plugin version mismatch");
  }
  return dist;
}

function validateTarball(root, tarball, pkg, dist, runSelftest = false) {
  const listing = execute("tar", ["-tzf", tarball], root).trim().split("\n").sort();
  ensure(JSON.stringify(listing) === JSON.stringify(INVENTORY), "npm tarball inventory mismatch");
  const packed = JSON.parse(execute("tar", ["-xOzf", tarball, "package/package.json"], root));
  ensure(JSON.stringify(packed) === JSON.stringify(pkg), "packed package metadata/repository mismatch");
  for (const name of INVENTORY.filter((name) => name !== "package/package.json")) {
    const bytes = execFileSync("tar", ["-xOzf", tarball, name], { maxBuffer: 8 * 1024 * 1024 });
    const reference = name.startsWith("package/dist/") ? join(dist, name.slice("package/dist/".length)) : join(root, "agent", name.slice(8));
    ensure(bytes.equals(readFileSync(reference)), "packed bytes differ from tested source/build");
  }
  if (!runSelftest) return;
  const runtime = mkdtempSync(join(tmpdir(), "syncky-packed-release-"));
  try {
    execute("tar", ["-xzf", tarball, "-C", runtime], root);
    const result = JSON.parse(execute(process.execPath, [join(runtime, "package/dist/syncky-agent.mjs"), "selftest", "--json"], runtime));
    ensure(result.ok === true, "packed runtime selftest failed");
  } finally { rmSync(runtime, { recursive: true, force: true }); }
}

export function prepareRelease(root, releaseDir, env = process.env) {
  const pkg = validateManifests(root, env);
  const dist = validateBuild(root, pkg);
  const output = resolve(releaseDir);
  ensure(!existsSync(output), "release directory must be fresh");
  mkdirSync(dirname(output), { recursive: true });
  const parent = realpathSync(dirname(output));
  ensure(relative(realpathSync(dist), parent).startsWith(".."), "release directory must be outside the build directory");
  mkdirSync(output);
  prepareRegistry(join(root, "server.json"), join(root, "agent/package.json"), dist, join(output, "server.json"));
  const cache = mkdtempSync(join(tmpdir(), "syncky-release-pack-cache-"));
  let report;
  try {
    report = JSON.parse(execute("npm", ["pack", "--offline", "--ignore-scripts", "--json", "--pack-destination", output, "--cache", cache], join(root, "agent")));
  } finally { rmSync(cache, { recursive: true, force: true }); }
  ensure(report.length === 1, "expected one npm tarball");
  const tarball = report[0].filename;
  ensure(tarball === `syncky-agent-${pkg.version}.tgz`, "npm tarball filename mismatch");
  validateTarball(root, join(output, tarball), pkg, dist, true);
  for (const name of ASSETS.filter((name) => name !== "server.json")) copyFileSync(join(dist, name), join(output, name));
  const receipt = { version: pkg.version, repository: REPOSITORY, tarball, tarballSha256: digest(join(output, tarball)),
    assets: Object.fromEntries(ASSETS.map((name) => [name, digest(join(output, name))])) };
  writeFileSync(join(output, "release.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  verifyRelease(root, output, env);
  return receipt;
}

export function verifyRelease(root, releaseDir, env = process.env) {
  const pkg = validateManifests(root, env);
  const dist = validateBuild(root, pkg, releaseDir);
  const receipt = readJSON(join(releaseDir, "release.json"));
  ensure(receipt.version === pkg.version && receipt.repository === REPOSITORY, "release receipt version/repository mismatch");
  ensure(receipt.tarball === `syncky-agent-${pkg.version}.tgz`, "release tarball path mismatch");
  ensure(JSON.stringify(Object.keys(receipt.assets).sort()) === JSON.stringify(ASSETS), "release asset inventory mismatch");
  ensure(JSON.stringify(readdirSync(releaseDir).sort()) === JSON.stringify([...ASSETS, receipt.tarball, "release.json"].sort()), "unexpected release files");
  for (const name of ASSETS) ensure(digest(join(releaseDir, name)) === receipt.assets[name], `${name} release hash mismatch`);
  ensure(digest(join(releaseDir, receipt.tarball)) === receipt.tarballSha256, "npm tarball hash mismatch");
  validateTarball(root, join(releaseDir, receipt.tarball), pkg, dist);
  ensure(readFileSync(join(releaseDir, "server.json"), "utf8") === registryAsset(join(root, "server.json"), join(root, "agent/package.json"), dist), "generated Registry asset mismatch");
  return receipt;
}

function remoteJSON(command, args, root, missing, emptyIsMissing = false) {
  try {
    const output = execute(command, args, root);
    return emptyIsMissing && !output.trim() ? null : JSON.parse(output);
  }
  catch (error) {
    let response;
    try { response = JSON.parse(error.stdout); } catch { throw error; }
    if (missing(response)) return null;
    throw error;
  }
}

export function publishRelease(root, releaseDir, env = process.env) {
  const receipt = verifyRelease(root, releaseDir, env);
  const pkg = readJSON(join(root, "agent/package.json"));
  const tarball = join(releaseDir, receipt.tarball);
  const published = remoteJSON("npm", ["view", `${pkg.name}@${receipt.version}`, "version", "dist.integrity", "--json", "--prefer-online"], root, (value) => value.error?.code === "E404", true);
  if (published === null) execute("npm", ["publish", tarball, "--access", "public", "--provenance", "--ignore-scripts"], root);
  else ensure(published.version === receipt.version && published["dist.integrity"] === `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`, "existing npm version/integrity mismatch");

  const tag = env.GITHUB_REF_NAME;
  let release = remoteJSON("gh", ["api", `repos/${REPOSITORY}/releases/tags/${tag}`], root, (value) => value.status === "404");
  if (release === null) release = JSON.parse(execute("gh", ["api", "--paginate", "--slurp", `repos/${REPOSITORY}/releases?per_page=100`], root))
    .flat().find((value) => value.tag_name === tag) ?? null;
  if (release === null) {
    execute("gh", ["release", "create", tag, "--repo", REPOSITORY, "--verify-tag", "--title", tag, "--generate-notes", "--draft"], root);
    release = { tag_name: tag, draft: true, assets: [] };
  }
  ensure(release.tag_name === tag && Array.isArray(release.assets), "existing release metadata mismatch");
  const existing = new Set(release.assets.map((asset) => asset.name));
  for (const asset of release.assets.filter((asset) => ASSETS.includes(asset.name) && asset.state === "starter" && asset.size === 0)) {
    ensure(Number.isSafeInteger(asset.id) && asset.id > 0, "starter asset ID mismatch");
    execute("gh", ["api", "--method", "DELETE", `repos/${REPOSITORY}/releases/assets/${asset.id}`], root);
    existing.delete(asset.name);
  }
  const downloaded = mkdtempSync(join(tmpdir(), "syncky-release-assets-"));
  try {
    for (const name of ASSETS.filter((name) => existing.has(name))) {
      const path = join(downloaded, name);
      execute("gh", ["release", "download", tag, "--repo", REPOSITORY, "--pattern", name, "--output", path], root);
      ensure(digest(path) === receipt.assets[name], `${name} existing release asset hash mismatch`);
    }
  } finally { rmSync(downloaded, { recursive: true, force: true }); }
  const missing = ASSETS.filter((name) => !existing.has(name));
  if (missing.length) execute("gh", ["release", "upload", tag, ...missing.map((name) => join(releaseDir, name)), "--repo", REPOSITORY], root);
  if (release.draft) execute("gh", ["release", "edit", tag, "--repo", REPOSITORY, "--draft=false"], root);
}

export function publishRegistry(root, releaseDir, env = process.env) {
  const output = resolve(releaseDir);
  verifyRelease(root, output, env);
  const file = join(output, "server.json");
  const { name, version } = readJSON(file);
  const url = `https://registry.modelcontextprotocol.io/v0/servers/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`;
  let status;
  try {
    status = execute("curl", ["--silent", "--show-error", "--output", "/dev/null", "--write-out", "%{http_code}", "--max-time", "30", url], root).trim();
  } catch { throw new Error("MCP Registry lookup failed"); }
  if (status === "200") {
    process.stdout.write(`MCP Registry ${name}@${version} already exists; skipping publish\n`);
    return;
  }
  ensure(status === "404", `MCP Registry lookup failed (HTTP ${status})`);
  for (const args of [["login", "github-oidc"], ["publish", file]]) {
    try { execute("mcp-publisher", args, root, args[0] === "publish" ? "inherit" : undefined); }
    catch { throw new Error(`MCP Registry ${args[0]} failed`); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [command, output] = process.argv.slice(2);
    ensure(process.argv.length === 4 && ["prepare", "verify", "publish", "install-publisher", "registry"].includes(command), "usage: node release.mjs <prepare|verify|publish|install-publisher|registry> <output-dir>");
    ({ prepare: prepareRelease, verify: verifyRelease, publish: publishRelease, "install-publisher": installPublisher, registry: publishRegistry })[command](ROOT, resolve(output));
  } catch (error) {
    process.stderr.write(`release: ${error.status === undefined ? error.message : "local command failed"}\n`);
    process.exitCode = 1;
  }
}
