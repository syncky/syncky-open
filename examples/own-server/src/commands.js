import catalog from "./write-catalog.json" with { type: "json" };
import { activeGrant, fail } from "./security.js";
import { signReply } from "./crypto.js";

export const MAX_REPLY_BYTES = 60_000;
const encoder = new TextEncoder();
const bytes = value => encoder.encode(value).length;
const envelope = commands => JSON.stringify({ v: 1, type: "commands", commands });
const matches = (pattern, value) => typeof value === "string" && new RegExp(pattern).test(value);
const definitions = catalog.command_schema.$defs;
const canonical = value => Array.isArray(value) ? value.map(canonical) : value !== null && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;

export function canWrite(store, grant) {
  const current = activeGrant(store, grant.id, grant.client_id);
  return store.setting("writes_enabled") === true && current?.consented === 1 && current.revision === grant.revision && JSON.parse(current.write_types_json).length > 0;
}

function validateCommand(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || !matches(/^wh_[A-Za-z0-9_-]{22}$/.source, input.destination) || !matches(/^d_[A-Za-z0-9_-]{22}$/.source, input.device)) fail(400, "invalid_target");
  if (!matches(definitions.command_id.pattern, input.command_id) || !Number.isSafeInteger(input.version) || input.version < definitions.version.minimum || !["write", "delete"].includes(input.op)) fail(400, "invalid_command");
  const type = matches(definitions.type_name.pattern, input.type) && Object.hasOwn(catalog.types, input.type) && catalog.types[input.type];
  if (!type) fail(400, "type_not_writable");
  if (input.op === "write") {
    for (const name of ["start", "end"]) if (!matches(definitions.timestamp.pattern, input[name]) || !Number.isFinite(Date.parse(input[name])) || new Date(Date.parse(input[name])).toISOString().slice(0, 19) !== input[name].slice(0, 19)) fail(400, "invalid_command");
    const span = (Date.parse(input.end) - Date.parse(input.start)) / 1000;
    if (span < 0 || span > type.max_span_s) fail(400, "invalid_command");
    if (type.kind === "category") {
      if (!type.values.includes(input.value) || Object.hasOwn(input, "unit")) fail(400, "invalid_command");
    } else {
      const family = catalog.units.find(f => f.units.some(u => u.unit === type.unit));
      const unit = family?.units.find(u => u.unit === input.unit), target = family?.units.find(u => u.unit === type.unit);
      if (typeof input.value !== "number" || !Number.isFinite(input.value) || !unit) fail(400, "invalid_command");
      const value = (input.value * unit.factor + unit.offset - target.offset) / target.factor;
      if (!Number.isFinite(value) || value < type.min || value > type.max) fail(400, "value_out_of_range");
    }
  }
  const { destination, device, command_id, version, op, type: name, value, unit, start, end, ...extra } = input;
  const fields = op === "write" ? { value, ...(Object.hasOwn(input, "unit") ? { unit } : {}), start, end } : Object.fromEntries(["value", "unit", "start", "end"].filter(k => Object.hasOwn(input, k)).map(k => [k, input[k]]));
  const payload = { command_id, version, op, type: name, ...fields, ...canonical(extra) };
  if (bytes(envelope([payload])) > MAX_REPLY_BYTES) fail(400, "command_too_large");
  return { destination, device, payload };
}

function receipt(store, row) {
  const result = store.sql.all("SELECT status, reason, received_at FROM results WHERE destination = ? AND command_id = ? AND version = ?", row.destination, row.command_id, row.version)[0];
  return { destination: row.destination, device: row.device, command_id: row.command_id, version: row.version, state: row.state === "pending" ? "queued" : row.state, ...(result && row.state !== "pending" ? { result: { status: result.status, ...(result.reason === null ? {} : { reason: result.reason }), received_at: result.received_at } } : {}) };
}

export function queueCommand(store, grant, input, now) {
  if (!canWrite(store, grant)) fail(403, "write_denied");
  const { destination, device, payload } = validateCommand(input);
  if (!JSON.parse(grant.write_types_json).includes(payload.type)) fail(403, "type_not_consented");
  return store.sql.transaction(() => {
    if (!canWrite(store, grant)) fail(403, "write_denied");
    if (!store.sql.all("SELECT 1 FROM upload_targets WHERE destination = ? AND device = ?", destination, device).length) fail(400, "invalid_target");
    const latest = store.sql.all("SELECT * FROM commands WHERE destination = ? AND command_id = ? ORDER BY version DESC LIMIT 1", destination, payload.command_id)[0];
    if (latest && (latest.client_id !== grant.client_id || latest.grant_id !== grant.id && !["applied", "rejected"].includes(latest.state) || latest.device !== device || latest.type !== payload.type || latest.state === "cancelled")) fail(403, "command_not_owned");
    if (latest && payload.version <= latest.version) {
      if (payload.version !== latest.version || JSON.stringify(canonical(payload)) !== JSON.stringify(canonical(JSON.parse(latest.payload_json)))) fail(409, "version_conflict");
      return receipt(store, latest);
    }
    if (payload.op === "delete" && !latest) fail(403, "command_not_owned");
    if (!latest && payload.version !== 1 || payload.op === "delete" && payload.version !== latest.version + 1) fail(409, "version_conflict");
    store.sql.run("DELETE FROM results WHERE destination = ? AND command_id = ? AND version = ?", destination, payload.command_id, payload.version);
    store.sql.run("INSERT INTO commands(destination, command_id, version, device, client_id, grant_id, type, op, payload_json, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)", destination, payload.command_id, payload.version, device, grant.client_id, grant.id, payload.type, payload.op, JSON.stringify(payload), now);
    return receipt(store, { ...payload, destination, device, state: "pending" });
  });
}

function pendingReply(store, destination, device) {
  if (store.setting("writes_enabled") !== true) return "";
  const commands = [], allowed = store.setting("redirect_allowlist") ?? [];
  const rows = store.sql.all(`SELECT c.payload_json, g.redirect_uri FROM commands c JOIN grants g ON g.id = c.grant_id AND g.client_id = c.client_id
    JOIN clients a ON a.id = c.client_id
    WHERE c.destination = ? AND c.device = ? AND c.state = 'pending' AND g.consented = 1 AND g.revoked_at IS NULL
    AND EXISTS (SELECT 1 FROM json_each(g.write_types_json) WHERE value = c.type)
    AND EXISTS (SELECT 1 FROM json_each(a.redirects_json) WHERE value = g.redirect_uri)
    AND c.version = (SELECT MAX(n.version) FROM commands n WHERE n.destination = c.destination AND n.command_id = c.command_id)
    ORDER BY c.created_at, c.rowid LIMIT 1000`, destination, device);
  let size = bytes(envelope([]));
  for (const row of rows) {
    if (!allowed.includes(row.redirect_uri)) continue;
    const next = bytes(row.payload_json) + (commands.length ? 1 : 0);
    if (size + next > MAX_REPLY_BYTES) break;
    commands.push(JSON.parse(row.payload_json)); size += next;
  }
  return commands.length ? envelope(commands) : "";
}

export async function commandReply(store, message, credentials, now) {
  const { destination, id } = message.delivery;
  const body = pendingReply(store, destination, message.device);
  if (!body) return new Response(null, { headers: { "Cache-Control": "no-store" } });
  const signature = credentials.hmac === null ? null : await signReply(credentials.hmac, id, now, body);
  if (pendingReply(store, destination, message.device) !== body) return new Response(null, { headers: { "Cache-Control": "no-store" } });
  return new Response(body, { headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...(signature ? { "X-Syncky-Signature": signature } : {}) } });
}
