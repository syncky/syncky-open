import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { Readable } from "node:stream";
import { random } from "../../src/crypto.js";
import { startServer } from "../../docker/server.js";

export async function dockerRuntime(t) {
  t.mock?.method(globalThis, "fetch", () => { throw new Error("external_network_denied"); });
  const dir = await mkdtemp(join(tmpdir(), "own-server-http-"));
  const runtime = { origin: "https://receiver.example", password: random(), now: () => Math.floor(Date.now() / 1000) };
  const options = { host: "127.0.0.1", port: 0, publicUrl: runtime.origin, adminPassword: runtime.password, databasePath: join(dir, "own-server.sqlite"), now: () => runtime.now() };
  let active;
  runtime.restart = async () => { if (active) await active.close(); active = await startServer(options); runtime.active = active; };
  await runtime.restart();
  runtime.all = (statement, ...bindings) => active.sql.all(statement, ...bindings);
  runtime.run = (statement, ...bindings) => active.sql.run(statement, ...bindings);
  runtime.setNow = seconds => { runtime.now = () => seconds; };
  runtime.send = async request => {
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    if (!headers.has("host")) headers.set("host", url.host);
    return new Promise((resolve, reject) => {
      const outgoing = httpRequest({ host: "127.0.0.1", port: active.port, path: url.pathname + url.search, method: request.method, headers: Object.fromEntries(headers) }, incoming => {
        const chunks = [];
        incoming.on("data", chunk => chunks.push(chunk));
        incoming.on("error", reject);
        incoming.on("end", () => resolve(new Response([204, 205, 304].includes(incoming.statusCode) ? null : Buffer.concat(chunks), { status: incoming.statusCode, headers: incoming.headers })));
      });
      outgoing.on("error", reject);
      if (request.body) Readable.fromWeb(request.body).on("error", reject).pipe(outgoing);
      else outgoing.end();
    });
  };
  t.after(async () => { await active.close(); await rm(dir, { recursive: true, force: true }); });
  return runtime;
}
