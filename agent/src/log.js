export const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40, silent: 100 });
export const REDACTED = "[redacted]";

const SECRET_PATTERNS = [
  /sk_hub_[A-Za-z0-9_-]*/g,
  /whsec_[A-Za-z0-9_-]*/g,
  /(?<![A-Za-z0-9])pt_[A-Za-z0-9_-]*/g,
  /Bearer\s+\S+/gi,
];

const DROPPED_FIELDS = new Set([
  "plaintext",
  "inner",
  "samples",
  "value",
  "private_key",
  "privateKey",
  "token",
  "webhook_secret",
  "cek",
  "invite",
  "pairing_token",
  "pair_secret",
  "pairSecret",
  "authorization",
  "secrets",
]);

// Very short values would mask ordinary words all over the log.
const MIN_SECRET_LENGTH = 8;
const MAX_DEPTH = 6;
const MAX_STRING = 2000;

const registered = new Set();

export function registerSecret(value) {
  if (typeof value === "string" && value.length >= MIN_SECRET_LENGTH) registered.add(value);
}

export function clearRegisteredSecrets() {
  registered.clear();
}

export function redact(str) {
  let out = String(str);
  for (const secret of registered) out = out.replaceAll(secret, REDACTED);
  for (const re of SECRET_PATTERNS) out = out.replace(re, REDACTED);
  return out.length > MAX_STRING ? `${out.slice(0, MAX_STRING)}…` : out;
}

function sanitize(value, depth, seen) {
  if (value === null || value === undefined) return value ?? null;
  switch (typeof value) {
    case "string":
      return redact(value);
    case "number":
    case "boolean":
      return value;
    case "bigint":
      return value.toString();
    case "function":
    case "symbol":
      return undefined;
  }
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return `[bytes ${value.byteLength}]`;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
  if (seen.has(value)) return "[circular]";
  if (depth >= MAX_DEPTH) return "[depth]";
  seen.add(value);
  try {
    if (value instanceof Error) {
      const out = { name: redact(value.name), message: redact(value.message) };
      if (typeof value.code === "string" || typeof value.code === "number") out.code = sanitize(value.code, depth + 1, seen);
      if (typeof value.status === "number") out.status = value.status;
      return out;
    }
    if (Array.isArray(value)) return value.map((v) => sanitize(v, depth + 1, seen) ?? null);
    const out = {};
    for (const [key, v] of Object.entries(value)) {
      if (DROPPED_FIELDS.has(key)) continue;
      const clean = sanitize(v, depth + 1, seen);
      if (clean !== undefined) out[redact(key)] = clean;
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

const defaultSink = (line) => process.stderr.write(`${line}\n`);

export function createLogger({ level = "info", sink = defaultSink, name, now = () => new Date() } = {}) {
  if (!Object.hasOwn(LEVELS, level)) throw new RangeError(`unknown log level: ${level}`);
  const threshold = LEVELS[level];

  const emit = (lvl, event, fields) => {
    if (LEVELS[lvl] < threshold) return;
    try {
      const body = fields instanceof Error ? { error: fields } : fields;
      const clean = body !== null && typeof body === "object" ? sanitize(body, 0, new WeakSet()) : {};
      const entry = { t: now().toISOString(), level: lvl };
      if (name) entry.name = redact(name);
      entry.event = redact(event);
      for (const [key, v] of Object.entries(clean)) if (!Object.hasOwn(entry, key)) entry[key] = v;
      sink(JSON.stringify(entry));
    } catch {
      // Logging must never take the caller down.
    }
  };

  return {
    level,
    debug: (event, fields) => emit("debug", event, fields),
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, fields) => emit("error", event, fields),
  };
}
