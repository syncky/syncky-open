export const MAX_BODY_BYTES = 1_000_000;
const typeName = /^[a-z][a-z0-9_]{1,63}$/;
const deviceId = /^d_[A-Za-z0-9_-]{22}$/;
const destinationId = /^wh_[A-Za-z0-9_-]{22}$/;
const deliveryId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const recordId = /^[A-Za-z0-9_.:-]{1,128}$/;
const time = /^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]{1,3})?Z$/;
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const matches = (re, value) => typeof value === "string" && re.test(value);
const instant = (v) => matches(time, v) && Number.isFinite(Date.parse(v)) && new Date(Date.parse(v)).toISOString().slice(0, 19) === v.slice(0, 19);
const interval = (s) => instant(s.start) && instant(s.end) && Date.parse(s.start) <= Date.parse(s.end);
export const badRequest = (code, status = 400) => Object.assign(new Error(code), { code, status });

export async function readBody(request, cap = MAX_BODY_BYTES) {
  const length = request.headers.get("content-length");
  if (length !== null && !/^[0-9]+$/.test(length)) throw badRequest("invalid_content_length");
  if (length !== null && Number(length) > cap) throw badRequest("payload_too_large", 413);
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) {
        await reader.cancel();
        throw badRequest("payload_too_large", 413);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error?.code === "payload_too_large") throw error;
    throw badRequest("invalid_body");
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}

export function parseBody(body) {
  try {
    const message = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    const stack = [[message, 0]];
    while (stack.length) {
      const [value, depth] = stack.pop();
      if (depth > 64 || typeof value === "number" && !Number.isFinite(value)) throw new Error();
      if (value !== null && typeof value === "object") for (const item of Object.values(value)) stack.push([item, depth + 1]);
    }
    return message;
  } catch { throw badRequest("invalid_json"); }
}

export function validateHeaders(headers) {
  if (!matches(destinationId, headers.get("x-syncky-destination")) || !matches(deliveryId, headers.get("x-syncky-delivery"))) throw badRequest("invalid_target");
}

export function validateNative(m, headers) {
  if (!object(m) || m.v !== 1 || m.type !== "sync" || !matches(deviceId, m.device) || !Array.isArray(m.samples) || !Array.isArray(m.deleted) || !Array.isArray(m.acks) || m.acks.length || typeof m.more !== "boolean") throw badRequest("not_sync");
  const d = m.delivery;
  if (!object(d) || d.id !== headers.get("x-syncky-delivery") || d.destination !== headers.get("x-syncky-destination") || !Number.isSafeInteger(d.index) || !Number.isSafeInteger(d.count) || d.index < 0 || d.count < 1 || d.index >= d.count || m.more !== (d.index < d.count - 1) || !instant(d.sent_at) || (Object.hasOwn(d, "test") && d.test !== true) || (Object.hasOwn(d, "resend") && d.resend !== true) || d.test && d.resend) throw badRequest("invalid_delivery");
  for (const s of m.samples) {
    if (!object(s) || !matches(recordId, s.uuid) || !matches(typeName, s.type)) throw badRequest("invalid_sample");
    if (s.type !== "characteristic" && s.type !== "activity_summary" && !interval(s)) throw badRequest("invalid_sample");
    if (Object.hasOwn(s, "part") && (!Number.isSafeInteger(s.part) || !Number.isSafeInteger(s.parts) || s.part < 0 || s.parts < 1 || s.part >= s.parts)) throw badRequest("invalid_sample");
  }
  for (const d of m.deleted) if (!object(d) || !matches(recordId, d.uuid) || !matches(typeName, d.type)) throw badRequest("invalid_deletion");
  if (Object.hasOwn(m, "summaries") && !Array.isArray(m.summaries)) throw badRequest("invalid_summary");
  for (const s of m.summaries ?? []) if (!object(s) || !matches(typeName, s.type) || typeof s.unit !== "string" || !s.unit || s.unit.length > 128 || !interval(s) || Date.parse(s.start) === Date.parse(s.end) || !["sum", "avg"].includes(s.stat) || typeof s.value !== "number" || !Number.isFinite(s.value)) throw badRequest("invalid_summary");
  if (d.test && (m.samples.length || m.deleted.length || (m.summaries?.length ?? 0))) throw badRequest("invalid_probe");
  return m;
}

const reasons = new Set(["type_not_allowed", "type_not_in_scope", "value_out_of_range", "healthkit_denied", "invalid"]);
export function validateResults(m) {
  if (!object(m) || m.v !== 1 || m.type !== "results" || !Array.isArray(m.results)) throw badRequest("not_results");
  for (const r of m.results) {
    if (!object(r) || !matches(/^[A-Za-z0-9_.:-]{1,64}$/, r.command_id) || !Number.isSafeInteger(r.version) || r.version < 1 || !["applied", "rejected"].includes(r.status) || (r.status === "rejected" ? !reasons.has(r.reason) : Object.hasOwn(r, "reason"))) throw badRequest("not_results");
  }
  return m.results;
}
