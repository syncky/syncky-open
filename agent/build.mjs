import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

import { build } from "esbuild";
import { TOOLS } from "./src/mcp.js";
import { VECTOR_FILES } from "./src/protocol-files.js";

const ROOT = fileURLToPath(new URL("./", import.meta.url));
const PROTOCOL = new URL("../protocol/", import.meta.url);

async function archiveTree(outdir, tree) {
  const blocks = [];
  async function append(path) {
    const full = join(outdir, path);
    const info = await stat(full);
    const directory = info.isDirectory();
    const content = directory ? Buffer.alloc(0) : await readFile(full);
    const name = `${path}${directory ? "/" : ""}`;
    if (Buffer.byteLength(name) > 100) throw new Error("distribution path exceeds tar name limit");
    const header = Buffer.alloc(512);
    const octal = (value, offset, length) => header.write(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length, "ascii");
    header.write(name);
    octal(directory ? 0o755 : info.mode & 0o777, 100, 8);
    octal(0, 108, 8);
    octal(0, 116, 8);
    octal(content.length, 124, 12);
    octal(0, 136, 12);
    header.fill(0x20, 148, 156);
    header.write(directory ? "5" : "0", 156);
    header.write("ustar\0" + "00", 257);
    octal(0, 329, 8);
    octal(0, 337, 8);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    blocks.push(header, content, Buffer.alloc((512 - content.length % 512) % 512));
    if (directory) {
      for (const child of (await readdir(full)).sort()) await append(`${path}/${child}`);
    }
  }
  await append(tree);
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks), { level: 9 });
}

function archiveZip(entries) {
  const blocks = [];
  const central = [];
  let offset = 0;
  for (const [name, content, mode = 0o644] of entries) {
    const filename = Buffer.from(name);
    const bytes = Buffer.from(content);
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(33, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(bytes.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(filename.length, 26);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50);
    header.writeUInt16LE(0x0314, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(33, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(bytes.length, 20);
    header.writeUInt32LE(bytes.length, 24);
    header.writeUInt16LE(filename.length, 28);
    header.writeUInt32LE((0o100000 | mode) * 65536, 38);
    header.writeUInt32LE(offset, 42);
    blocks.push(local, filename, bytes);
    central.push(header, filename);
    offset += local.length + filename.length + bytes.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...blocks, directory, end]);
}

async function writePayload(path, content, mode = 0o644) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, { mode });
  await chmod(path, mode);
}

async function distributions(outdir, payload, hash, notices) {
  const skill = await readFile(join(ROOT, "skills/syncky/SKILL.md"), "utf8");
  const header = /^---\n([\s\S]*?)\n---\n/.exec(skill);
  if (!header) throw new Error("skill frontmatter missing");
  const description = /^description: (.+)$/m.exec(header[1])?.[1];
  if (!description) throw new Error("skill description missing");
  const portable = `---\nname: syncky\ndescription: ${description}\nlicense: Apache-2.0\n---\n${skill.slice(header[0].length)}`;
  const launcher = (await readFile(join(ROOT, "distribution/syncky-agent.sh"), "utf8")).replaceAll("@BUNDLE_SHA256@", hash);
  const icon = await readFile(join(ROOT, "distribution/icon.png"));
  const license = await readFile(join(ROOT, "LICENSE"));
  const notice = await readFile(join(ROOT, "NOTICE"));
  const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
  const manifest = {
    manifest_version: "0.3", name: "syncky-health", display_name: "Syncky Health", version: pkg.version,
    description: pkg.description,
    author: { name: "Syncky" }, license: pkg.license,
    server: { type: "node", entry_point: "syncky-agent.mjs", mcp_config: { command: "node", args: ["${__dirname}/syncky-agent.mjs", "mcp"] } },
    tools: TOOLS.map(({ name, description }) => ({ name, description })),
    compatibility: { runtimes: { node: pkg.engines.node } },
  };
  const mcpb = archiveZip([
    ["manifest.json", `${JSON.stringify(manifest, null, 2)}\n`],
    ["syncky-agent.mjs", payload, 0o755], ["LICENSE", license], ["NOTICE", notice], ["THIRD-PARTY-NOTICES", `${notices}\n`],
  ]);
  const mcpbHash = createHash("sha256").update(mcpb).digest("hex");
  await writePayload(join(outdir, "syncky-health.mcpb"), mcpb);
  await writePayload(join(outdir, "syncky-health.mcpb.sha256"), `${mcpbHash}  syncky-health.mcpb\n`);
  const plugin = { name: "syncky", version: pkg.version, description, author: { name: "Syncky", email: "support@syncky.app", url: "https://syncky.app" }, license: "Apache-2.0" };
  const packages = [
    ["claude-code", "syncky-agent-claude-code.tar.gz", "plugins/syncky/skills/syncky"],
    ["codex", "syncky-agent-codex.tar.gz", "plugins/syncky/skills/syncky"],
    ["clawhub", "syncky-agent-clawhub.tar.gz", "syncky"],
    ["agent-skills", "syncky-agent-skills.tar.gz", "skills/syncky"],
  ];
  const sums = [`${hash}  syncky-agent.mjs`, `${mcpbHash}  syncky-health.mcpb`];
  for (const [tree, name, leafPath] of packages) {
    const base = join(outdir, tree);
    await rm(base, { recursive: true, force: true });
    const leaf = join(base, leafPath);
    for (const [file, content, mode] of [
      ["SKILL.md", tree === "clawhub" ? skill : portable],
      ["syncky-agent", launcher, 0o755],
      ["syncky-agent.mjs", payload, 0o755],
      ["syncky-agent.mjs.sha256", `${hash}  syncky-agent.mjs\n`],
      ["LICENSE", license], ["NOTICE", notice], ["THIRD-PARTY-NOTICES", `${notices}\n`],
    ]) await writePayload(join(leaf, file), content, mode);
    const writeManifest = async (path, value) => writePayload(join(base, path), `${JSON.stringify(value, null, 2)}\n`);
    if (tree === "claude-code") {
      await writeManifest(".claude-plugin/marketplace.json", { name: "syncky-local", owner: { name: "Syncky" }, plugins: [{ name: "syncky", source: "./plugins/syncky" }] });
      await writeManifest("plugins/syncky/.claude-plugin/plugin.json", { ...plugin, mcpServers: "./.mcp.json" });
      await writePayload(join(base, "plugins/syncky/.claude-plugin/icon.png"), icon);
      await writeManifest("plugins/syncky/.mcp.json", { mcpServers: { syncky: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/skills/syncky/syncky-agent.mjs", "mcp"] } } });
    }
    if (tree === "codex") {
      await writeManifest(".agents/plugins/marketplace.json", { name: "syncky-local", plugins: [{ name: "syncky", source: { source: "local", path: "./plugins/syncky" } }] });
      await writeManifest("plugins/syncky/.codex-plugin/plugin.json", { ...plugin, skills: "./skills/", interface: { displayName: "Syncky", composerIcon: "./assets/icon.png", logo: "./assets/icon.png" } });
      await writePayload(join(base, "plugins/syncky/assets/icon.png"), icon);
    }
    const archivePath = join(outdir, name);
    await writePayload(archivePath, await archiveTree(outdir, tree));
    sums.push(`${createHash("sha256").update(await readFile(archivePath)).digest("hex")}  ${name}`);
  }
  await writePayload(join(outdir, "SHA256SUMS"), `${sums.join("\n")}\n`);
}

async function embeddedResources() {
  const files = ["types.json", "units.json", "messages.json", ...VECTOR_FILES.map(file => `test-vectors/${file}`)];
  for (const file of (await readdir(new URL("schemas/", PROTOCOL))).sort()) {
    if (file.endsWith(".json")) files.push(`schemas/${file}`);
  }
  const resources = {};
  for (const file of files) {
    const text = await readFile(new URL(file, PROTOCOL), "utf8");
    JSON.parse(text);
    resources[file] = text;
  }
  return resources;
}

function entryPoint(files) {
  return `
import { existsSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
${files.map((file, i) => `import * as m${i} from './src/${file}';`).join("\n")}
export const modules = Object.freeze({
${files.map((file, i) => `${JSON.stringify(file)}: m${i},`).join("\n")}
});
export async function runCli(args = process.argv.slice(2)) {
  process.umask(0o077);
  const code = await modules['cli.js'].main(args);
  const flushed = (stream) => new Promise((resolve) => stream.write('', resolve));
  await Promise.all([flushed(process.stdout), flushed(process.stderr)]);
  process.exit(code);
}
if (process.argv[1] && existsSync(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await runCli();
`;
}

async function upstreamNotices(inputs) {
  const packages = new Set();
  const notices = [];
  for (const input of inputs) {
    const match = /^node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input);
    if (!match) continue;
    packages.add(match[1]);
    const source = await readFile(join(ROOT, input), "utf8");
    for (const [comment] of source.matchAll(/\/\*[\s\S]*?\*\//g)) {
      if (/\b(?:copyright|license)\b/i.test(comment)) notices.push(`/*! ${input}\n${comment.slice(2, -2).trim()}\n*/`);
    }
  }
  for (const name of [...packages].sort()) {
    const dir = join(ROOT, "node_modules", name);
    const metadata = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    for (const file of (await readdir(dir)).sort()) {
      if (!/^(license|notice|copying)([.-]|$)/i.test(file)) continue;
      const text = (await readFile(join(dir, file), "utf8")).trim();
      notices.push(`/*! ${name} ${metadata.version} — ${file}\n${text.replaceAll("*/", "* /")}\n*/`);
    }
  }
  return notices.join("\n\n");
}

export async function buildAgent({ outdir = join(ROOT, "dist") } = {}) {
  const reachable = new Set();
  async function visit(file) {
    if (reachable.has(file)) return;
    reachable.add(file);
    const source = await readFile(join(ROOT, "src", file), "utf8");
    for (const match of source.matchAll(/(?:from\s*|import\s*)["']\.\/([^"']+\.js)["']/g)) await visit(match[1]);
  }
  await visit("cli.js");
  const files = [...reachable].sort();
  const resources = await embeddedResources();
  const bootstrapBase64 = (await readFile(join(ROOT, "skills/syncky/bootstrap.json"))).toString("base64");
  const bundlePath = resolve(outdir, "syncky-agent.mjs");
  const result = await build({
    absWorkingDir: ROOT,
    stdin: { contents: entryPoint(files), resolveDir: ROOT, sourcefile: "bundle-entry.js" },
    outfile: bundlePath,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22.15",
    splitting: false,
    sourcemap: false,
    legalComments: "inline",
    metafile: true,
    write: false,
    banner: { js: "#!/usr/bin/env node\nimport { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);" },
    plugins: [{
      name: "embedded-protocol",
      setup(builder) {
        builder.onLoad({ filter: /[/\\]src[/\\]embedded-protocol\.js$/ }, () => ({
          contents: `export const resources = ${JSON.stringify(resources)};`,
          loader: "js",
        }));
        builder.onLoad({ filter: /[/\\]src[/\\]embedded-skill\.js$/ }, () => ({
          contents: `export const bootstrapBase64 = ${JSON.stringify(bootstrapBase64)};`,
          loader: "js",
        }));
      },
    }],
  });
  for (const output of Object.values(result.metafile.outputs)) {
    for (const imp of output.imports) {
      if (!imp.external || !isBuiltin(imp.path)) throw new Error("bundle contains a non-built-in runtime import");
    }
  }
  if (result.outputFiles.length !== 1) throw new Error("expected one release ESM output");
  const notices = await upstreamNotices(Object.keys(result.metafile.inputs));
  const payload = `${result.outputFiles[0].text}\n${notices}\n`;
  const hash = createHash("sha256").update(payload).digest("hex");
  await writePayload(bundlePath, payload, 0o755);
  await writePayload(`${bundlePath}.sha256`, `${hash}  syncky-agent.mjs\n`);
  await distributions(dirname(bundlePath), payload, hash, notices);
  return { bundlePath, hash, metafile: result.metafile };
}

if (process.argv[1] && existsSync(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await buildAgent();
