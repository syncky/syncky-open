import { chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";


export function tempDir(prefix = "syncky-agent-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function tempHome() {
  const { dir, cleanup } = tempDir();
  return { root: dir, home: join(dir, "home"), cleanup };
}

// fs.cpSync on Linux (Node 22.18) creates copied directories with the umask mode, which privateStat rejects.
export function copyPrivateHome(source, target) {
  const st = lstatSync(source);
  if (st.isDirectory()) {
    mkdirSync(target, { mode: 0o700 });
    chmodSync(target, 0o700);
    for (const name of readdirSync(source)) copyPrivateHome(join(source, name), join(target, name));
  } else if (st.isFile()) copyFileSync(source, target);
  else throw new Error(`unexpected entry in home: ${source}`);
  chmodSync(target, st.mode & 0o7777);
}

export const fileMode = (st) => st.mode & 0o777;

export function captureStream() {
  const chunks = [];
  return {
    write(chunk) {
      chunks.push(String(chunk));
      return true;
    },
    get text() {
      return chunks.join("");
    },
  };
}

export async function runCli(argv, { env = {}, ...opts } = {}) {
  const { main } = await import("../../src/cli.js");
  const stdout = captureStream();
  const stderr = captureStream();
  const sleeps = [];
  const code = await main(argv, {
    env,
    stdout,
    stderr,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
    ...opts,
  });
  return { code, stdout: stdout.text, stderr: stderr.text, sleeps };
}

export async function waitFor(check, { timeoutMs = 5000, intervalMs = 10, what = "condition", sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now } = {}) {
  const deadline = now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(intervalMs);
  }
}

export async function freePort() {
  const { createServer } = await import("node:net");
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}
