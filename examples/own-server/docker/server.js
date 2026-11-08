import { createServer } from "node:http";
import { once } from "node:events";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { openSqlite } from "./sql.js";
import { createStore } from "../src/store.js";
import { handle } from "../src/handler.js";
import { canonicalOrigin } from "../src/security.js";

const reject = (status, code) => Response.json({ ok: false, code }, { status, headers: { "Cache-Control": "no-store" } });
const invalid = () => { throw new Error("invalid_configuration"); };

function publicOrigin(value) {
  try {
    const parsed = new URL(value);
    if (parsed.pathname !== "/" || parsed.search || parsed.hash) return invalid();
    return canonicalOrigin(value);
  } catch { return invalid(); }
}

async function bodyOf(incoming, cap) {
  const length = incoming.headers["content-length"];
  if (length !== undefined && !/^[0-9]+$/.test(length)) throw Object.assign(new Error(), { status: 400, code: "invalid_content_length" });
  if (Number(length) > cap) throw Object.assign(new Error(), { status: 413, code: "payload_too_large" });
  let size = 0;
  const chunks = [];
  for await (const chunk of incoming.iterator({ destroyOnReturn: false })) {
    size += chunk.byteLength;
    if (size > cap) throw Object.assign(new Error(), { status: 413, code: "payload_too_large" });
    chunks.push(chunk);
  }
  return chunks.length ? Buffer.concat(chunks, size) : undefined;
}

async function writeResponse(response, outgoing) {
  outgoing.writeHead(response.status, Object.fromEntries(response.headers));
  if (response.body) await pipeline(Readable.fromWeb(response.body), outgoing);
  else outgoing.end();
}

export async function startServer(options = {}) {
  const origin = publicOrigin(options.publicUrl);
  if (typeof options.adminPassword !== "string" || !options.adminPassword || Buffer.byteLength(options.adminPassword) > 1024) invalid();
  const port = options.port ?? 3000;
  if (!Number.isInteger(port) || port < 0 || port > 65535) invalid();
  const sql = openSqlite(options.databasePath ?? "/data/own-server.sqlite");
  let store;
  try { store = createStore(sql); } catch { sql.close(); throw new Error("storage_unavailable"); }
  const server = createServer({ requestTimeout: 30_000, headersTimeout: 10_000, keepAliveTimeout: 5_000 }, async (incoming, outgoing) => {
    let response;
    try {
      if (!incoming.url?.startsWith("/") || incoming.url.startsWith("//")) {
        response = reject(400, "invalid_target");
      } else {
        const url = new URL(origin + incoming.url);
        const cap = url.pathname === "/server" ? 1_000_000 : url.pathname === "/mcp" ? 65_536 : 16_384;
        const body = await bodyOf(incoming, cap);
        const request = new Request(url, { method: incoming.method, headers: incoming.headers, body });
        response = await handle(request, { store, adminPassword: options.adminPassword, publicUrl: origin, ...(options.now ? { now: options.now } : {}) });
      }
    } catch (error) {
      response = ["payload_too_large", "invalid_content_length"].includes(error?.code) ? reject(error.status, error.code) : reject(400, "invalid_body");
    }
    if (outgoing.destroyed) return;
    if (!incoming.complete || response.status === 413 || response.status === 400) {
      incoming.pause();
      outgoing.shouldKeepAlive = false;
      response.headers.set("Connection", "close");
    }
    try { await writeResponse(response, outgoing); } catch { outgoing.destroy(); }
  });
  server.on("clientError", (_error, socket) => { socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); });
  try {
    server.listen(port, options.host ?? "0.0.0.0");
    await once(server, "listening");
  } catch { sql.close(); throw new Error("listener_unavailable"); }
  let closing;
  return {
    server, sql, port: server.address().port,
    close() {
      closing ??= new Promise((resolve, rejectClose) => {
        server.close(error => {
          try { sql.close(); } catch { rejectClose(new Error("storage_unavailable")); return; }
          if (error) rejectClose(new Error("shutdown_failed")); else resolve();
        });
        server.closeIdleConnections();
      });
      return closing;
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const port = process.env.PORT === undefined ? 3000 : Number(process.env.PORT);
    const runtime = await startServer({ publicUrl: process.env.PUBLIC_URL, adminPassword: process.env.ADMIN_PASSWORD, databasePath: process.env.DATABASE_PATH ?? "/data/own-server.sqlite", port });
    const shutdown = () => { runtime.close().catch(() => { process.exitCode = 1; }); };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  } catch {
    process.stderr.write("Server could not start.\n");
    process.exitCode = 1;
  }
}
