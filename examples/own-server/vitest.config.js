import { defineConfig } from "vitest/config";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { openSqlite } from "./docker/sql.js";
import { createStore } from "./src/store.js";

process.env.ADMIN_PASSWORD = randomBytes(32).toString("base64url");
process.env.WRANGLER_LOG_PATH = new URL(".wrangler/logs/test.log", import.meta.url).pathname;
const { cloudflareTest } = await import("@cloudflare/vitest-pool-workers");
const vectors = Object.fromEntries(["requests", "signatures", "exchanges"].map(name => [name, JSON.parse(readFileSync(new URL("../../protocol/test-vectors/webhook-" + name + ".json", import.meta.url))).cases]));

const sql = openSqlite(":memory:");
createStore(sql);
const schema = sql.all("SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name");
sql.close();

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: "./wrangler.jsonc" },
    miniflare: {
      bindings: { ADMIN_PASSWORD: process.env.ADMIN_PASSWORD, NODE_SCHEMA: JSON.stringify(schema), WEBHOOK_VECTORS: JSON.stringify(vectors), DO_JURISDICTION: "" },
      outboundService: () => { throw new Error("external_network_denied"); },
    },
  })],
  test: { include: ["test/worker/*.test.js"], testTimeout: 30_000 },
});
