import { it } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../../src/store.js";
import { openSqlite } from "../../docker/sql.js";
import { createUploadCredentials } from "../../src/crypto.js";
import { initialSchemaDates } from "../support/review.js";
import { fixture, sample, summary, native, rows, equalJSON, databasePath, secret, messageRequest, destination } from "../support/helpers.js";

it("Node SQLite includes activity dates in the initial schema and preserves native records", async t => {
  const f = await fixture(t);
  initialSchemaDates(f.sql);
});

it("deduplicates regular samples and replaces characteristics/activity summaries with device isolation", async (t) => {
  const f = await fixture(t);
  const regular = sample({ extra: { origin: "future" }, source: { app: "local", device: "watch" } });
  const characteristic = { uuid: "characteristic:blood_type", type: "characteristic", name: "blood_type", value: "a_positive" };
  const activity = { uuid: "activity_summary:2026-10-14", type: "activity_summary", date: "2026-10-14", paused: false };
  const m = await native(f, { samples: [regular, characteristic, activity] }).json();
  assert.equal((await f.send(native(f, m))).status, 200);
  const changed = structuredClone(m);
  changed.samples[0].value = 2;
  changed.samples[1].value = "b_positive";
  changed.samples[2].paused = true;
  assert.equal((await f.send(native(f, changed))).status, 200);
  const saved = rows(f, "samples");
  assert.equal(saved.length, 3);
  assert.ok(equalJSON(JSON.parse(saved.find(r => r.uuid === regular.uuid).payload_json), regular), "regular retry retains original payload/provenance");
  for (const s of changed.samples.slice(1)) assert.ok(equalJSON(JSON.parse(saved.find(r => r.uuid === s.uuid).payload_json), s), "mutable record replaced");
  assert.equal((await f.send(native(f, { samples: [regular] }))).status, 200);
  assert.equal(rows(f, "samples").length, 4);
});

it("retains all series parts and deletes every part only on the matching device", async (t) => {
  const f = await fixture(t);
  const s = sample({ type: "workout_route", part: 0, parts: 2, points: [] });
  const m = await native(f, { samples: [s, { ...s, part: 1 }] }).json();
  await f.send(native(f, m));
  await f.send(native(f, { samples: [s] }));
  assert.equal(rows(f, "samples").length, 3);
  await f.send(native(f, { ...m, samples: [], deleted: [{ uuid: s.uuid, type: s.type }] }));
  assert.equal(rows(f, "samples").length, 1);
});

it("summary keys preserve zero, replace instead of add, and keep raw coverage separate", async (t) => {
  const f = await fixture(t);
  const m = await native(f, { samples: [sample()], summaries: [summary({ value: 9 }), summary({ stat: "avg", value: 3 })] }).json();
  await f.send(native(f, m));
  const next = { ...m, samples: [], summaries: [summary()] };
  await f.send(native(f, next));
  await f.send(native(f, next));
  assert.equal(rows(f, "samples").length, 1);
  assert.equal(rows(f, "summaries").length, 2);
  assert.ok(rows(f, "summaries").find(s => s.stat === "sum").value === 0, "zero replacement retained");
  assert.equal(rows(f, "upload_targets").length, 1);
});

it("rejects a partially invalid batch without persisting its valid prefix or target", async (t) => {
  const f = await fixture(t);
  for (const extra of [{ samples: [sample(), {}] }, { samples: [sample()], deleted: [{}] }, { samples: [sample()], summaries: [summary({ value: "bad" })] }]) {
    assert.equal((await f.send(native(f, extra))).status, 400);
    for (const table of ["samples", "summaries", "upload_targets"]) assert.equal(rows(f, table).length, 0);
  }
});

it("rolls back a whole upload when SQLite fails and never acknowledges before commit", async (t) => {
  const f = await fixture(t);
  f.sql.run("CREATE TRIGGER reject_summary BEFORE INSERT ON summaries BEGIN SELECT RAISE(ABORT, 'storage_failure'); END");
  const request = native(f, { samples: [sample()], summaries: [summary()] });
  assert.equal((await f.send(request)).status, 500);
  for (const table of ["samples", "summaries", "upload_targets"]) assert.equal(rows(f, table).length, 0);
  f.sql.run("DROP TRIGGER reject_summary");
  const transaction = f.sql.transaction;
  f.sql.transaction = (fn) => transaction(() => { fn(); throw new Error("commit_failure"); });
  assert.equal((await f.send(native(f, { samples: [sample()] }))).status, 500);
  assert.equal(rows(f, "samples").length, 0);
});

it("persists credentials, targets, samples and summaries across restart and concurrent initialization", async (t) => {
  const path = databasePath(t);
  const f = await fixture(t, { path });
  const m = await native(f, { samples: [sample()], summaries: [summary()] }).json();
  await Promise.all([f.send(native(f, m)), f.send(native(f, m))]);
  const sql = openSqlite(path);
  t.after(() => sql.close());
  const restarted = createStore(sql);
  assert.ok(equalJSON(restarted.credentials(), f.store.credentials()), "credentials survive restart");
  assert.equal(restarted.initializeCredentials({ different: true }), false);
  assert.ok(equalJSON(restarted.credentials(), f.store.credentials()), "initialization is insert-once");
  for (const table of ["samples", "summaries", "upload_targets"]) assert.equal(sql.all(`SELECT * FROM ${table}`).length, 1);
});

it("binds SQL values and preserves additive unknown native data", async (t) => {
  const f = await fixture(t);
  const s = sample({ type: "future_quantity", source: { app: "'); DROP TABLE samples; --" }, additive: { foo: [1, "x"] } });
  assert.equal((await f.send(native(f, { samples: [s] }))).status, 200);
  assert.ok(equalJSON(JSON.parse(rows(f, "samples")[0].payload_json), s), "bound payload round-trips");
});

it("concurrent initialization on independent connections persists only the winning credentials", async (t) => {
  const f = await fixture(t, { path: databasePath(t), initialized: false });
  const sql = openSqlite(f.config.path);
  t.after(() => sql.close());
  const other = createStore(sql);
  const configs = await Promise.all([0, 1].map(() => createUploadCredentials({ auth: { kind: "bearer" }, token: secret(), hmac: secret() })));
  const outcomes = await Promise.all([Promise.resolve().then(() => f.store.initializeCredentials(configs[0])), Promise.resolve().then(() => other.initializeCredentials(configs[1]))]);
  assert.equal(outcomes.filter(Boolean).length, 1);
  assert.ok(equalJSON(f.store.credentials(), configs[outcomes[0] ? 0 : 1]), "only one credential set persisted");
  assert.ok(equalJSON(f.store.credentials(), other.credentials()), "both connections see the same initialization");
});

it("SQLite result failures roll back the valid prefix without affecting other target state", async (t) => {
  const f = await fixture(t);
  f.sql.run("CREATE TRIGGER reject_second_result BEFORE INSERT ON results WHEN NEW.command_id = 'c_2' BEGIN SELECT RAISE(ABORT, 'storage_failure'); END");
  const request = messageRequest(f, { v: 1, type: "results", results: [{ command_id: "c_1", version: 1, status: "applied" }, { command_id: "c_2", version: 1, status: "applied" }] }, { "X-Syncky-Kind": "results", "X-Syncky-Destination": destination() });
  assert.equal((await f.send(request)).status, 500);
  assert.equal(rows(f, "results").length, 0);
});

it("SQLite transactions reject asynchronous work and restore the previous state", async (t) => {
  const f = await fixture(t);
  assert.throws(() => f.sql.transaction(() => {
    f.sql.run("INSERT INTO settings(key, value_json) VALUES (?, ?)", "rollback", "true");
    return Promise.resolve();
  }), /async_transaction/);
  assert.equal(f.sql.all("SELECT * FROM settings WHERE key = ?", "rollback").length, 0);
});
