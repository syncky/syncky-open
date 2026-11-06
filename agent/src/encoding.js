import { timingSafeEqual } from "node:crypto";

export class EncodingError extends Error {
  constructor(message) {
    super(message);
    this.name = "EncodingError";
    this.code = "malformed";
  }
}

// Relay-sourced text printed to a terminal: control and bidi characters could hide or rewrite a fingerprint.
const UNPRINTABLE_RE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/gu;
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f-\u009f]/u;
const FORMAT_CHAR_RE = /\p{Cf}/u;
export const MAX_DEVICE_NAME_CODE_POINTS = 64;

export function printable(str) {
  return String(str).replace(UNPRINTABLE_RE, (c) => `\\u{${c.codePointAt(0).toString(16)}}`);
}

export function deviceName(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const length = [...trimmed].length;
  if (length < 1 || length > MAX_DEVICE_NAME_CODE_POINTS || CONTROL_CHAR_RE.test(trimmed) || FORMAT_CHAR_RE.test(value)) return null;
  return trimmed;
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64URL_RE = /^[A-Za-z0-9_-]*$/;

export function b64uEncode(bytes) {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64url");
}

function hasCanonicalTail(str) {
  const rem = str.length % 4;
  if (rem === 0) return true;
  const last = ALPHABET.indexOf(str[str.length - 1]);
  return (last & (rem === 2 ? 0x0f : 0x03)) === 0;
}

export function b64uDecode(str, { length } = {}) {
  if (typeof str !== "string" || !B64URL_RE.test(str)) throw new EncodingError("base64url: non-alphabet character");
  if (str.length % 4 === 1) throw new EncodingError("base64url: invalid length");
  if (!hasCanonicalTail(str)) throw new EncodingError("base64url: non-canonical trailing bits");
  // Copy out of Buffer: small Buffers share one pooled ArrayBuffer, which leaks into libraries reading `.buffer`.
  const out = new Uint8Array(Buffer.from(str, "base64url"));
  if (length !== undefined && out.length !== length) {
    throw new EncodingError(`base64url: expected ${length} bytes, got ${out.length}`);
  }
  return out;
}

export function isB64u(str, { length } = {}) {
  try {
    b64uDecode(str, { length });
    return true;
  } catch {
    return false;
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function utf8(str) {
  return encoder.encode(str);
}

export function utf8Decode(bytes) {
  try {
    return decoder.decode(bytes);
  } catch {
    throw new EncodingError("utf-8: malformed input");
  }
}

export function concatBytes(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export function toHex(bytes) {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("hex");
}

export function constantTimeEqual(a, b) {
  const x = typeof a === "string" ? utf8(a) : a;
  const y = typeof b === "string" ? utf8(b) : b;
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

const RFC3339_RE =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/;

export function formatTimestamp(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) throw new RangeError("formatTimestamp: invalid date");
  const iso = d.toISOString();
  return iso.endsWith(".000Z") ? `${iso.slice(0, -5)}Z` : iso;
}

export function parseTimestamp(str) {
  if (typeof str !== "string") return null;
  const m = RFC3339_RE.exec(str);
  if (!m) return null;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  let offsetMinutes = 0;
  if (m[8] !== undefined) {
    const offsetHours = Number(m[9]);
    const offsetMins = Number(m[10]);
    if (offsetHours > 23 || offsetMins > 59) return null;
    offsetMinutes = (m[8] === "-" ? -1 : 1) * (offsetHours * 60 + offsetMins);
  }
  const fractionMs = m[7] === undefined ? 0 : Number(m[7].padEnd(3, "0").slice(0, 3));
  const epochMinutes = daysFromCivil(year, month, day) * 1440 + hour * 60 + minute - offsetMinutes;
  return (epochMinutes * 60 + second) * 1000 + fractionMs;
}

export function isTimestamp(str) {
  return parseTimestamp(str) !== null;
}

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year, month) {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

function daysFromCivil(year, month, day) {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const monthIndex = month > 2 ? month - 3 : month + 9;
  const dayOfYear = Math.floor((153 * monthIndex + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146_097 + dayOfEra - 719_468;
}

export function isSafeInt(n, { min = 1 } = {}) {
  return typeof n === "number" && Number.isInteger(n) && n >= min && n <= Number.MAX_SAFE_INTEGER;
}

export const MAX_JSON_DEPTH = 128;

// Iterative: a 256 KiB body can nest far deeper than the call stack allows. The KMP StrictJson
// rejects the same depth, so both cores treat a deeply nested document alike.
export function exceedsJsonDepth(root, maxDepth = MAX_JSON_DEPTH) {
  const stack = [[root, 1]];
  while (stack.length > 0) {
    const [node, depth] = stack.pop();
    if (depth > maxDepth) return true;
    for (const child of Array.isArray(node) ? node : Object.values(node)) {
      if (typeof child === "object" && child !== null) stack.push([child, depth + 1]);
    }
  }
  return false;
}
