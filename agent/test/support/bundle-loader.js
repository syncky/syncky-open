const PREFIX = "syncky-bundle:";
let sourceUrl;
let facades;

const sameNames = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

export function createFacades(modules, inventory, bundleUrl) {
  if (!modules || !sameNames(Object.keys(modules), Object.keys(inventory))) throw new Error("bundle module mapping differs");
  return Object.fromEntries(Object.entries(inventory).map(([file, names]) => {
    if (!modules[file] || !sameNames(Object.keys(modules[file]), names)) throw new Error(`bundle export mapping differs: ${file}`);
    const exports = names.map((name, i) => `const e${i} = namespace[${JSON.stringify(name)}]; export { e${i} as ${JSON.stringify(name)} };`).join("\n");
    return [file, `import { modules } from ${JSON.stringify(bundleUrl)};\nconst namespace = modules[${JSON.stringify(file)}];\n${exports}\n`];
  }));
}

export async function initialize(data) {
  sourceUrl = data.sourceUrl;
  const { modules } = await import(data.bundleUrl);
  facades = createFacades(modules, data.exports, data.bundleUrl);
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("file:")) {
    const mapped = sourceFacade(new URL(specifier, context.parentURL).href);
    if (mapped) return mapped;
  }
  const resolved = await nextResolve(specifier, context);
  return sourceFacade(resolved.url) ?? resolved;
}

function sourceFacade(url) {
  const candidate = new URL(url);
  candidate.search = "";
  candidate.hash = "";
  if (candidate.href.startsWith(sourceUrl)) {
    const file = candidate.href.slice(sourceUrl.length);
    if (!Object.hasOwn(facades, file)) throw new Error(`unmapped bundle source module: ${file}`);
    return { url: `${PREFIX}${file}`, shortCircuit: true };
  }
}

export async function load(url, context, nextLoad) {
  if (url.startsWith(PREFIX)) {
    const file = url.slice(PREFIX.length);
    if (!Object.hasOwn(facades, file)) throw new Error(`unmapped bundle source module: ${file}`);
    return { format: "module", source: facades[file], shortCircuit: true };
  }
  return nextLoad(url, context);
}
