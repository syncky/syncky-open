import { it } from "node:test";
import { fixture } from "../support/helpers.js";
import { historyQueries } from "../support/query-history.js";

for (const kind of ["samples", "summaries"]) it("Node SQLite selects " + kind + " pages once across 50,000 historical rows", async t => {
  const f = await fixture(t);
  await historyQueries(f.sql, kind);
});
