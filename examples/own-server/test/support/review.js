import { client, check } from "./runtime.js";
import { createStore } from "../../src/store.js";

export function guardPayloadReads(sql) {
  const all = sql.all;
  sql.all = (statement, ...bindings) => {
    const rows = all(statement, ...bindings);
    const bytes = rows.reduce((n, row) => n + new TextEncoder().encode(row.payload_json ?? "").length, 0);
    check(bytes <= 1_048_576, "payload materialization stays within one page budget");
    return rows;
  };
}

export async function largeGrants(runtime) {
  const b = client(runtime); await b.login();
  const scope = ["read:steps", ...Array.from({ length: 127 }, (_, n) => "read:future_" + n)].join(" ");
  const tokens = await b.access(await b.register(), scope);
  const sample = b.sample();
  await b.empty({ samples: [sample, { ...b.sample(), type: "heart_rate" }], summaries: [{ type: "future_126", unit: "count", start: sample.start, end: new Date(Date.parse(sample.end) + 3600000).toISOString(), stat: "sum", value: 0 }] });
  await b.empty({ device: "d_" + "x".repeat(22), samples: [b.sample()] });
  const first = await b.tool(tokens.access_token, "syncky_status", { limit: 1 });
  check(first.targets?.length === 1 && first.has_more, "large-grant status page");
  check(first.targets[0].available_types.join() === "future_126,steps", "large-grant raw and summary availability stays scoped");
  const last = await b.tool(tokens.access_token, "syncky_status", { limit: 1, cursor: first.next_cursor });
  check(last.targets?.length === 1 && !last.has_more && last.next_cursor === null, "large-grant final status page");
  check(last.targets[0].available_types.join() === "steps", "large-grant second target availability");
}

export async function boundedReads(runtime, guard) {
  const b = client(runtime); await b.login();
  const tokens = await b.access(await b.register());
  const expected = [];
  for (const note of ["界".repeat(300_000), "界".repeat(300_000), "界".repeat(300_000), "😀".repeat(80_000)]) {
    const sample = { ...b.sample(), note };
    expected.push(sample.uuid);
    await b.empty({ samples: [sample] });
  }
  await guard();
  const seen = [];
  let cursor;
  do {
    const response = await b.rpc(tokens.access_token, "tools/call", { name: "syncky_query", arguments: { type: "steps", limit: 200, ...(cursor ? { cursor } : {}) } });
    const text = await response.text();
    check(new TextEncoder().encode(text).length <= 1_048_576, "MCP serialized byte cap");
    const value = JSON.parse(text);
    check(!value.error, "bounded payload selection succeeds");
    const page = JSON.parse(value.result.content[0].text);
    for (const row of page.rows) {
      check(row.sample.note === (row.sample.uuid === expected[3] ? "😀".repeat(80_000) : "界".repeat(300_000)), "whole multibyte query rows");
      seen.push(row.sample.uuid);
    }
    cursor = page.next_cursor;
    check(page.has_more === Boolean(cursor), "query continuation agrees with cursor");
  } while (cursor);
  check(JSON.stringify(seen) === JSON.stringify(expected), "bounded query has no skipped or repeated records");
  const exported = [];
  do {
    const response = await b.get("/admin/export?limit=200" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""));
    const text = await response.text();
    check(response.status === 200 && new TextEncoder().encode(text).length <= 1_048_576, "bounded admin export succeeds");
    const page = JSON.parse(text);
    for (const row of page.rows) {
      const sample = JSON.parse(row.payload_json);
      check(sample.note.length === (sample.uuid === expected[3] ? 160_000 : 300_000), "whole export payload");
      exported.push(sample.uuid);
    }
    cursor = page.next_cursor;
  } while (cursor);
  check(JSON.stringify(exported) === JSON.stringify(expected), "bounded export has no skipped or repeated records");
  const device = "d_" + "z".repeat(22);
  await b.empty({ device, samples: [{ ...b.sample(), note: '"'.repeat(300_000) }] });
  check((await b.tool(tokens.access_token, "syncky_query", { type: "steps", device })).error === "row_too_large", "oversized MCP row fails safely");
}

export async function renewedCommands(runtime) {
  const b = client(runtime); await b.login();
  await b.post("/admin/settings", { writes_enabled: "true" });
  const registered = await b.register(), scope = "read:steps write:dietary_water";
  const tokens = await b.access(registered, scope);
  await b.empty();
  const applied = b.command(), rejected = b.command(), pending = b.command();
  for (const command of [applied, rejected, pending]) check((await b.tool(tokens.access_token, "syncky_write", command)).state === "queued", "original command queued");
  check((await (await b.upload()).response.json()).commands.length === 3, "original versions emitted");
  await b.upload({}, { results: [{ command_id: applied.command_id, version: 1, status: "applied" }, { command_id: rejected.command_id, version: 1, status: "rejected", reason: "healthkit_denied" }] });
  const renewed = await b.access(registered, scope);
  await runtime.restart();
  const deletion = { destination: applied.destination, device: applied.device, command_id: applied.command_id, type: applied.type, version: 2, op: "delete" };
  const other = await b.access(await b.register(), scope);
  check((await b.tool(other.access_token, "syncky_write", deletion)).error === "command_not_owned", "renewal preserves client isolation");
  check((await b.tool(renewed.access_token, "syncky_write", { ...deletion, device: "d_" + "z".repeat(22) })).error === "invalid_target", "unknown target remains denied");
  const narrowed = await b.access(registered, "read:steps write:sleep_analysis");
  check((await b.tool(narrowed.access_token, "syncky_write", deletion)).error === "type_not_consented", "renewed grant must still authorize original type");
  const current = await b.access(registered, scope);
  check((await b.tool(current.access_token, "syncky_write", pending)).error === "command_not_owned", "renewal never revives unfinished writes");
  check((await b.tool(current.access_token, "syncky_write", { ...deletion, version: 3 })).error === "version_conflict", "renewed deletion still requires next version");
  check((await b.tool(current.access_token, "syncky_write", deletion)).state === "queued", "same client deletes applied write across grants");
  check((await b.tool(current.access_token, "syncky_write", deletion)).state === "queued", "renewed delete is idempotent");
  const correction = { ...rejected, version: 2, value: 0.5 };
  check((await b.tool(current.access_token, "syncky_write", correction)).state === "queued", "same client corrects rejected write across grants");
  const reply = await (await b.upload()).response.json();
  check(reply.commands.length === 2 && reply.commands.every(c => c.version === 2), "only newly authorized versions delivered");
  await b.upload({}, { results: [{ command_id: applied.command_id, version: 1, status: "applied" }] });
  check((await b.tool(current.access_token, "syncky_write", deletion)).state === "queued", "old results cannot finish renewed version");
  await b.empty({}, { results: [{ command_id: applied.command_id, version: 2, status: "applied" }, { command_id: rejected.command_id, version: 2, status: "applied" }] });
  check((await b.tool(current.access_token, "syncky_write", deletion)).state === "applied", "renewed deletion completes only on current result");
}

export async function activityDates(runtime) {
  const receiptTimes = ["2026-11-07T12:01:55Z", "2026-11-07T12:06:22Z"].map(time => Date.parse(time) / 1000);
  runtime.setNow(receiptTimes[0]);
  const b = client(runtime); await b.login();
  const tokens = await b.access(await b.register(), "read:steps read:activity_summary read:characteristic");
  const activity = { uuid: "activity_summary:2020-02-02", type: "activity_summary", date: "2020-02-02", paused: false };
  const characteristic = { uuid: "characteristic:blood_type", type: "characteristic", name: "blood_type", value: "a_positive" };
  await b.empty({ samples: [activity] });
  await runtime.restart();
  check((await b.tool(tokens.access_token, "syncky_query", { type: "activity_summary" })).rows.length === 0, "old activity excluded from recent uploads");
  const bounds = { since: "2020-02-02T12:00:00Z", until: "2020-02-02T13:00:00Z" };
  const historical = await b.tool(tokens.access_token, "syncky_query", { type: "activity_summary", ...bounds });
  check(historical.rows.length === 1 && historical.rows[0].sample.date === activity.date, "activity uses inclusive calendar dates, independent of upload time");
  check((await b.tool(tokens.access_token, "syncky_query", { type: "activity_summary", since: "2020-02-03T00:00:00Z", until: "2020-02-04T00:00:00Z" })).rows.length === 0, "activity date boundaries");
  for (const receivedAt of receiptTimes) {
    runtime.setNow(receivedAt);
    await b.empty({ samples: [characteristic] });
    await runtime.restart();
    const recent = await b.tool(tokens.access_token, "syncky_query", { type: "characteristic" });
    check(recent.rows.length === 1 && recent.rows[0].received_at === receivedAt, "undated characteristic uses receipt time");
    const instant = new Date(receivedAt * 1000).toISOString();
    check((await b.tool(tokens.access_token, "syncky_query", { type: "characteristic", since: instant, until: instant })).rows.length === 1, "receipt time is included at both exact boundaries");
    for (const offset of [-1, 1]) {
      const adjacent = new Date(receivedAt * 1000 + offset).toISOString();
      check((await b.tool(tokens.access_token, "syncky_query", { type: "characteristic", since: adjacent, until: adjacent })).rows.length === 0, "receipt time is excluded beyond either exact boundary");
    }
  }
  check((await b.tool(tokens.access_token, "syncky_query", { type: "characteristic", ...bounds })).rows.length === 0, "undated characteristic is not assigned an activity date");
  await b.empty({ samples: [{ ...activity, date: "2020-02-03", paused: true }] });
  check((await b.tool(tokens.access_token, "syncky_query", { type: "activity_summary", ...bounds })).rows.length === 0, "activity replacement updates persisted date");
  check((await runtime.all("SELECT date FROM samples WHERE type = ?", "activity_summary"))[0].date === "2020-02-03", "activity calendar date persisted explicitly");
}

export function initialSchemaDates(sql) {
  check(sql.all("SELECT version FROM schema_version")[0].version === 1, "first deployment uses schema v1");
  check(sql.all("PRAGMA table_info(samples)").some(column => column.name === "date"), "initial schema includes activity dates");
  const payload = JSON.stringify({ uuid: "activity_summary:2020-02-02", type: "activity_summary", date: "2020-02-02" });
  sql.run("INSERT INTO samples(device, uuid, part, type, received_at, payload_json, date) VALUES (?, ?, -1, ?, ?, ?, ?)", "device", "activity_summary:2020-02-02", "activity_summary", 123, payload, "2020-02-02");
  createStore(sql);
  check(sql.all("SELECT version FROM schema_version")[0].version === 1, "reinitialization retains schema v1");
  const rows = sql.all("SELECT * FROM samples");
  check(rows.length === 1 && rows[0].date === "2020-02-02" && rows[0].payload_json === payload && rows[0].received_at === 123, "reinitialization preserves dates and native records");
  createStore(sql);
  check(sql.all("SELECT * FROM samples")[0].date === "2020-02-02", "date schema is idempotent");
}
