import { fail } from "./security.js";
import { base64url, equal, mac, digest } from "./crypto.js";
import { boundedRows } from "./pagination.js";

const encoder = new TextEncoder();
const day = 86400_000;
const object = v => v !== null && typeof v === "object" && !Array.isArray(v);
const keys = (v, allowed) => { if (!object(v) || Object.keys(v).some(k => !allowed.includes(k))) fail(400, "invalid_params"); };
const limit = (value, fallback, max) => {
  const n = value === undefined ? fallback : value;
  if (!Number.isInteger(n) || n < 1 || n > max) fail(400, "invalid_params");
  return n;
};
const time = value => {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(Date.parse(value)).toISOString().slice(0, 19) !== value.slice(0, 19)) fail(400, "invalid_params");
  return new Date(Date.parse(value)).toISOString();
};

async function cursorKey(store) {
  const material = await crypto.subtle.digest("SHA-256", encoder.encode("mcp-cursor:" + store.key("oauth")));
  return crypto.subtle.importKey("raw", material, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function decode(store, grant, cursor, tool) {
  if (cursor === undefined) return null;
  if (typeof cursor !== "string" || cursor.length > 4096) fail(400, "invalid_cursor");
  const [payload, signature, extra] = cursor.split(".");
  if (extra || !/^[A-Za-z0-9_-]+$/.test(payload ?? "") || !equal(signature, await mac(store.key("oauth"), payload))) fail(400, "invalid_cursor");
  let value;
  try {
    const bytes = Uint8Array.from(atob(payload.replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0));
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, await cursorKey(store), bytes.slice(12));
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext));
  } catch { fail(400, "invalid_cursor"); }
  if (!object(value) || value.tool !== tool || value.client !== grant.client_id || value.grant !== grant.id || value.revision !== grant.revision || !Number.isSafeInteger(value.last) || value.last < 0 || !Number.isSafeInteger(value.max) || value.max < value.last) fail(400, "invalid_cursor");
  return value;
}

async function encode(store, grant, tool, filters, last, max) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const value = encoder.encode(JSON.stringify({ tool, client: grant.client_id, grant: grant.id, revision: grant.revision, filters, last, max }));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await cursorKey(store), value));
  const sealed = new Uint8Array(iv.length + ciphertext.length);
  sealed.set(iv); sealed.set(ciphertext, iv.length);
  const payload = base64url(sealed);
  return payload + "." + await mac(store.key("oauth"), payload);
}

const sameFilters = (previous, filters) => { if (previous && JSON.stringify(previous.filters) !== JSON.stringify(filters)) fail(400, "invalid_cursor"); };
const readTypes = grant => {
  const types = JSON.parse(grant.read_types_json);
  if (!types.length) fail(403, "read_denied");
  return types;
};

async function page(store, grant, tool, filters, previous, rows, maximum, render, fits, hasMore = false) {
  const max = previous?.max ?? maximum;
  const selected = rows.slice(0, filters.limit);
  while (true) {
    const more = hasMore || rows.length > selected.length;
    const cursor = more && selected.length ? await encode(store, grant, tool, filters, selected.at(-1).page_id, max) : null;
    const result = { ...render(selected), has_more: more, next_cursor: cursor };
    if (fits(result)) return result;
    if (selected.length <= 1) fail(413, "row_too_large");
    selected.pop();
  }
}

export async function query(store, grant, args, now, fits) {
  keys(args, ["type", "kind", "since", "until", "device", "limit", "cursor"]);
  const types = readTypes(grant);
  if (typeof args.type !== "string" || !/^[a-z][a-z0-9_]{1,63}$/.test(args.type)) fail(400, "invalid_params");
  if (!types.includes(args.type)) fail(403, "type_not_consented");
  const kind = args.kind === undefined ? "samples" : args.kind;
  if (!["samples", "summaries"].includes(kind) || args.device !== undefined && (typeof args.device !== "string" || !/^d_[A-Za-z0-9_-]{22}$/.test(args.device))) fail(400, "invalid_params");
  const previous = await decode(store, grant, args.cursor, "query");
  const until = time(args.until === undefined ? previous?.filters.until ?? new Date(now * 1000).toISOString() : args.until);
  const since = time(args.since === undefined ? previous?.filters.since ?? new Date(Date.parse(until) - 7 * day).toISOString() : args.since);
  if (Date.parse(until) < Date.parse(since) || Date.parse(until) - Date.parse(since) > 31 * day) fail(400, "invalid_params");
  const filters = { type: args.type, kind, since, until, device: args.device ?? null, limit: limit(args.limit, 100, 200) };
  sameFilters(previous, filters);
  const maximum = previous?.max ?? store.sql.all(`SELECT COALESCE(MAX(rowid), 0) AS n FROM ${kind}`)[0].n;
  const dated = kind === "samples" ? "type = 'activity_summary'" : "0";
  const timestamp = kind === "samples" ? "CASE WHEN type = 'activity_summary' THEN julianday(date) ELSE COALESCE(julianday(start), julianday(received_at, 'unixepoch')) END" : "julianday(start)";
  const candidates = store.sql.all(`SELECT rowid AS page_id FROM ${kind} WHERE type = ? AND rowid <= ?
    AND ${timestamp} >= julianday(CASE WHEN ${dated} THEN date(?) ELSE ? END)
    AND ${timestamp} <= julianday(CASE WHEN ${dated} THEN date(?) ELSE ? END)
    AND (? IS NULL OR device = ?) AND rowid > ? ORDER BY rowid LIMIT ?`, filters.type, maximum, since, since, until, until, filters.device, filters.device, previous?.last ?? 0, filters.limit + 1);
  let next = 0;
  const { rows, more } = boundedRows(() => {
    const candidate = candidates[next++];
    return candidate && store.sql.all(`SELECT rowid AS page_id, * FROM ${kind} WHERE rowid = ?`, candidate.page_id)[0];
  }, previous?.last ?? 0, filters.limit);
  return page(store, grant, "query", filters, previous, rows, maximum, selected => ({
    provenance: kind === "samples" ? "native_samples" : "native_summaries",
    rows: selected.map(({ page_id, payload_json, ...row }) => kind === "samples" ? { device: row.device, received_at: row.received_at, sample: JSON.parse(payload_json) } : row),
  }), fits, more);
}

export async function status(store, grant, args, fits) {
  keys(args, ["limit", "cursor"]);
  const types = readTypes(grant), previous = await decode(store, grant, args.cursor, "status");
  const filters = { types: await digest(JSON.stringify(types)), limit: limit(args.limit, 50, 50) };
  sameFilters(previous, filters);
  const maximum = previous?.max ?? store.sql.all("SELECT COALESCE(MAX(rowid), 0) AS n FROM upload_targets")[0].n;
  const selectedTypes = JSON.stringify(types);
  const rows = store.sql.all(`SELECT rowid AS page_id, destination, device, received_at FROM upload_targets t WHERE rowid > ? AND rowid <= ? AND
    (EXISTS (SELECT 1 FROM samples s WHERE s.device = t.device AND s.type IN (SELECT value FROM json_each(?))) OR
    EXISTS (SELECT 1 FROM summaries s WHERE s.device = t.device AND s.type IN (SELECT value FROM json_each(?)))) ORDER BY rowid LIMIT ?`, previous?.last ?? 0, maximum, selectedTypes, selectedTypes, filters.limit + 1);
  return page(store, grant, "status", filters, previous, rows, maximum, selected => ({ targets: selected.map(row => {
    const available = store.sql.all(`SELECT DISTINCT type FROM
      (SELECT type, received_at FROM samples WHERE device = ? AND type IN (SELECT value FROM json_each(?)) UNION ALL
      SELECT type, received_at FROM summaries WHERE device = ? AND type IN (SELECT value FROM json_each(?))) ORDER BY type`, row.device, selectedTypes, row.device, selectedTypes);
    return { destination: row.destination, device: row.device, available_types: available.map(v => v.type), last_accepted_upload: row.received_at };
  }) }), fits);
}
