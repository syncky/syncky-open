import { query } from "../../src/query.js";
import { createStore } from "../../src/store.js";
import { random } from "../../src/crypto.js";
import { check } from "./runtime.js";

export async function historyQueries(sql, kind) {
  const store = createStore(sql);
  sql.run("INSERT INTO crypto_secrets(name, value) VALUES (?, ?)", "oauth", random());
  const device = "d_" + "a".repeat(22), other = "d_" + "b".repeat(22);
  const seed = `WITH RECURSIVE history(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM history WHERE n < 50000),
    records AS (SELECT n, CASE WHEN n % 2 = 0 THEN ? ELSE ? END AS device,
      strftime('%Y-%m-%dT%H:%M:%SZ', CASE WHEN n > 49550 THEN '2026-10-14' ELSE '2020-01-01' END, '+' || n || ' seconds') AS start FROM history)`;
  if (kind === "samples") sql.run(seed + ` INSERT INTO samples(device, uuid, part, type, start, end, received_at, payload_json)
    SELECT device, 'history-' || n, -1, 'steps', start, start, 1791961200,
      json_object('uuid', 'history-' || n, 'type', 'steps', 'start', start, 'value', n, 'unit', 'count') FROM records`, device, other);
  else sql.run(seed + ` INSERT INTO summaries(device, type, unit, start, end, stat, value, received_at)
    SELECT device, 'steps', 'count', start, start, 'sum', n, 1791961200 FROM records`, device, other);
  const grant = { client_id: "history-client", id: "history-grant", revision: 1, read_types_json: '["steps"]' };
  let scans = 0, payloadReads = 0;
  const traced = { ...store, sql: { ...sql, all(statement, ...bindings) {
    const rows = sql.all(statement, ...bindings);
    if (new RegExp(`FROM ${kind}\\b`).test(statement) && !statement.includes("MAX(rowid)")) {
      const plan = sql.all("EXPLAIN QUERY PLAN " + statement, ...bindings);
      const point = plan.some(row => /USING INTEGER PRIMARY KEY \(rowid=\?\)/.test(row.detail));
      if (!point) {
        scans++;
        check(rows.length <= 201 && rows.every(row => Object.keys(row).length === 1 && Number.isSafeInteger(row.page_id)), "history selection loads only bounded candidate rowids");
      } else {
        payloadReads++;
        check(rows.length <= 1, "payloads use individual primary-key lookups");
      }
    }
    return rows;
  } } };
  for (const filter of [{}, { device }]) {
    let cursor, pages = 0;
    const seen = [];
    do {
      scans = 0; payloadReads = 0;
      const page = await query(traced, grant, { type: "steps", kind, since: "2026-10-14T00:00:00Z", until: "2026-10-15T00:00:00Z", limit: 200, ...filter, ...(cursor ? { cursor } : {}) }, 1791961200, () => true);
      check(scans === 1 && payloadReads <= 201, "each page scans history once and bounds primary-key lookups");
      check(page.rows.length === (pages === 0 ? 200 : filter.device ? 25 : pages === 1 ? 200 : 50), "full history pages retain the requested row limit");
      seen.push(...page.rows.map(row => kind === "samples" ? row.sample.value : row.value));
      cursor = page.next_cursor;
      check(page.has_more === Boolean(cursor), "history continuation agrees with cursor");
      check(++pages <= 3, "history pagination terminates");
    } while (cursor);
    const expected = Array.from({ length: 450 }, (_, n) => n + 49551).filter(n => !filter.device || n % 2 === 0);
    check(JSON.stringify(seen) === JSON.stringify(expected), "history pages preserve order, time/device filters and complete coverage");
  }
}
