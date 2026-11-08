import { it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject, reset } from "cloudflare:test";
import { ownStub, workerRuntime } from "../support/worker-runtime.js";
import { createStore } from "../../src/store.js";
import { SCHEMA_VERSION } from "../../src/schema.js";
import { initialSchemaDates } from "../support/review.js";
import { historyQueries } from "../support/query-history.js";
import { client, check } from "../support/runtime.js";

beforeEach(() => reset());
it("real DO SQLite schema equals Node SQLite and binds values with atomic rollback", async () => {
  await runInDurableObject(ownStub(), instance => {
    const sql = instance.sql;
    const schema = sql.all("SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name");
    expect(schema).toEqual(JSON.parse(env.NODE_SCHEMA));
    const value = "'); DROP TABLE settings; --";
    sql.run("INSERT INTO settings(key, value_json) VALUES (?, ?)", "bound", JSON.stringify(value));
    expect(JSON.parse(sql.all("SELECT value_json FROM settings WHERE key = ?", "bound")[0].value_json)).toBe(value);
    expect(() => sql.transaction(() => {
      sql.run("INSERT INTO settings(key, value_json) VALUES (?, ?)", "rolled_back", "true");
      sql.run("INSERT INTO results(destination, command_id, version, status, received_at) VALUES (?, ?, ?, ?, ?)", "a", "b", 1, "invalid", 1);
    })).toThrow();
    expect(sql.all("SELECT * FROM settings WHERE key = ?", "rolled_back")).toEqual([]);
    expect(() => sql.transaction(() => Promise.resolve())).toThrow("async_transaction");
    createStore(sql);
    expect(sql.all("SELECT version FROM schema_version")).toEqual([{ version: SCHEMA_VERSION }]);
    sql.run("UPDATE schema_version SET version = ?", SCHEMA_VERSION + 1);
    expect(() => createStore(sql)).toThrow("unsupported_schema");
    expect(sql.all("SELECT version FROM schema_version")).toEqual([{ version: SCHEMA_VERSION + 1 }]);
  });
});

it("DO SQLite includes activity dates in the initial schema and preserves native records", async () => {
  await runInDurableObject(ownStub(), instance => initialSchemaDates(instance.sql));
});

it("DO SQLite enforces its 100 bound parameter limit", async () => {
  await runInDurableObject(ownStub(), instance => {
    const statement = count => "SELECT 1 AS n WHERE 1 IN (" + Array(count).fill("?").join(",") + ")";
    expect(instance.sql.all(statement(100), ...Array(100).fill(1))).toEqual([{ n: 1 }]);
    expect(() => instance.sql.all(statement(101), ...Array(101).fill(1))).toThrow(/too many SQL variables/i);
  });
});

for (const kind of ["samples", "summaries"]) it("DO SQLite selects " + kind + " pages once across 50,000 historical rows", async () => {
  await runInDurableObject(ownStub(), instance => historyQueries(instance.sql, kind));
});

it("DO constructor restart preserves bootstrap and concurrent login initializes once", async () => {
  const runtime = workerRuntime();
  const sessions = [client(runtime), client(runtime)];
  const links = await Promise.all(sessions.map(b => b.login()));
  check(links.filter(Boolean).length === 1, "one concurrent setup disclosure");
  const keys = await runtime.all("SELECT name, value FROM crypto_secrets ORDER BY name");
  await runtime.restart();
  expect(await runtime.all("SELECT name, value FROM crypto_secrets ORDER BY name")).toEqual(keys);
  check(!await client(runtime).login(), "restart does not redisplay credentials");
});
