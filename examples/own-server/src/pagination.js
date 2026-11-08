import { fail } from "./security.js";

const encoder = new TextEncoder();

export function boundedRows(read, last, limit) {
  const rows = [];
  let bytes = 0;
  while (true) {
    const row = read(last);
    if (!row) return { rows, more: false };
    if (rows.length === limit) return { rows, more: true };
    const size = encoder.encode(JSON.stringify(row)).length;
    if (bytes + size > 1_040_000) {
      if (!rows.length) fail(413, "row_too_large");
      return { rows, more: true };
    }
    rows.push(row);
    bytes += size;
    last = row.page_id;
  }
}
