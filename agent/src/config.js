import nodeFs from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { isUrlScheme } from "./url-scheme.js";

export const CONFIG_FILE = "config.json";
export const DEFAULT_HOME_DIR = ".syncky-agent";

export const PRODUCTION_RELAY_URL = "https://relay.syncky.app";

export const CONFIG_DEFAULTS = Object.freeze({
  relay_url: PRODUCTION_RELAY_URL,
  url_scheme: null,
  name: null,
  poll_interval_s: 1800,
  heartbeat: "on",
});

export const POLL_INTERVAL_MIN_S = 300;
export const POLL_INTERVAL_MAX_S = 86_400;

const LOOPBACK_V4_RE = /^127(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

export function isLoopbackHost(host) {
  const h = String(host ?? "").toLowerCase().replace(/^\[(.*)\]$/, "$1");
  return h === "localhost" || h === "localhost." || h === "::1" || LOOPBACK_V4_RE.test(h);
}

export const CONFIG_ENV = Object.freeze({
  relay_url: "SYNCKY_RELAY_URL",
  url_scheme: "SYNCKY_URL_SCHEME",
  name: "SYNCKY_AGENT_NAME",
  poll_interval_s: "SYNCKY_POLL_INTERVAL_S",
  heartbeat: "SYNCKY_HEARTBEAT",
});

export const LOCAL_STATE_ERROR_CODES = Object.freeze([
  "already_initialized",
  "not_initialized",
  "insecure_permissions",
  "invalid_config",
  "invalid_url_scheme",
  "invalid_secrets",
  "key_mismatch",
  "corrupt_state",
  "schema_too_new",
  "migration_failed",
  "migration_required",
  "migration_source_changed",
  "migration_conflict",
  "home_locked",
  "ambiguous_target",
  "target_not_confirmed",
  "schema_invalid",
  "unsafe_ack",
  "invalid_response",
  "invalid_input",
  "invalid_state",
  "invalid_transition",
  "unknown_member",
  "key_conflict",
  "pairing_expired",
  "pair_proof_invalid",
  "fingerprint_mismatch",
  "timeout",
  "tx_async",
]);


export class LocalStateError extends Error {
  constructor(code, message, { detail, types } = {}) {
    super(message);
    this.name = "LocalStateError";
    this.code = code;
    if (detail !== undefined) this.detail = detail;
    if (types !== undefined) this.types = types;
  }
}

export function errorDetail(error) {
  if (!(error instanceof LocalStateError) || typeof error.detail !== "string" || !/^[a-z_]{1,64}$/.test(error.detail)) return {};
  const types = Array.isArray(error.types) && error.types.every(n => typeof n === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(n)) ? error.types : undefined;
  return { detail: error.detail, ...(types && { types }) };
}

export function validateUrlScheme(value) {
  if (!isUrlScheme(value)) throw new LocalStateError("invalid_url_scheme", "url scheme must be syncky, syncky-dev or syncky-staging");
  return value;
}

export function agentHome({ flags = {}, env = process.env } = {}) {
  return flags.home ?? (env.SYNCKY_AGENT_HOME || join(homedir(), DEFAULT_HOME_DIR));
}

export function checkHome(home, { fs = nodeFs } = {}) {
  let st;
  try {
    st = fs.statSync(home);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    return null;
  }
  if (!st.isDirectory()) throw new LocalStateError("insecure_permissions", `agent home is not a directory: ${home}`);
  if ((st.mode & 0o777) !== 0o700 && fs.readdirSync(home).length > 0) {
    throw new LocalStateError(
      "insecure_permissions",
      `agent home ${home} has mode ${(st.mode & 0o777).toString(8)}; run chmod 700 on it`,
    );
  }
  return st;
}

export function ensureHome(home, { fs = nodeFs } = {}) {
  const st = checkHome(home, { fs });
  if (st === null) {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    fs.chmodSync(home, 0o700);
  } else if ((st.mode & 0o777) !== 0o700) {
    fs.chmodSync(home, 0o700);
  }
  return home;
}

export function writeFileAtomic(path, data, { fs = nodeFs } = {}) {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  let fd = null;
  try {
    fd = fs.openSync(tmp, "wx", 0o600);
    fs.fchmodSync(fd, 0o600);
    fs.writeSync(fd, typeof data === "string" ? data : Buffer.from(data));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, path);
  } catch (err) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw err;
  }
}

export function readJsonFile(path, { fs = nodeFs } = {}) {
  let text;
  try {
    text = fs.readFileSync(path, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new LocalStateError("corrupt_state", `${basename(path)} is not valid JSON`);
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    throw new LocalStateError("corrupt_state", `${basename(path)} is not a JSON object`);
  }
  return doc;
}

const HEARTBEAT_VALUES = new Map([
  [true, "on"],
  ["on", "on"],
  [false, "off"],
  ["off", "off"],
]);

function coerce(key, value, source) {
  if (key === "url_scheme") {
    return value === null && (source === CONFIG_FILE || source === "config") ? null : validateUrlScheme(value);
  }
  if (key === "heartbeat") {
    if (!HEARTBEAT_VALUES.has(value)) throw new LocalStateError("invalid_config", `${key} from ${source}: expected "on" or "off"`);
    return HEARTBEAT_VALUES.get(value);
  }
  if (key === "poll_interval_s") {
    const n = typeof value === "number" ? value : typeof value === "string" && /^[0-9]+$/.test(value) ? Number(value) : NaN;
    if (!Number.isSafeInteger(n) || n < POLL_INTERVAL_MIN_S || n > POLL_INTERVAL_MAX_S) {
      throw new LocalStateError("invalid_config", `${key} from ${source}: must be at least ${POLL_INTERVAL_MIN_S} and at most ${POLL_INTERVAL_MAX_S} whole seconds`);
    }
    return n;
  }
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new LocalStateError("invalid_config", `${key} from ${source}: expected a string`);
  return value;
}

function pick(obj, key) {
  return obj != null && Object.hasOwn(obj, key) && obj[key] !== undefined ? obj[key] : undefined;
}

export function resolveConfig({ flags = {}, env = process.env, file = {} } = {}) {
  const out = {};
  for (const key of Object.keys(CONFIG_DEFAULTS)) {
    const envValue = env[CONFIG_ENV[key]];
    if (pick(flags, key) !== undefined) out[key] = coerce(key, flags[key], "flag");
    else if (envValue !== undefined && envValue !== "") out[key] = coerce(key, envValue, "env");
    else if (pick(file, key) !== undefined) out[key] = coerce(key, file[key], CONFIG_FILE);
    else out[key] = CONFIG_DEFAULTS[key];
  }
  return out;
}

export function loadConfigFile(home, { fs = nodeFs } = {}) {
  return readJsonFile(join(home, CONFIG_FILE), { fs }) ?? {};
}

export function loadConfig(home, { flags = {}, env = process.env, fs = nodeFs } = {}) {
  return resolveConfig({ flags, env, file: loadConfigFile(home, { fs }) });
}

export function saveConfig(home, config, { fs = nodeFs } = {}) {
  const doc = {};
  for (const key of Object.keys(CONFIG_DEFAULTS)) {
    const value = pick(config, key);
    if (value !== undefined) doc[key] = coerce(key, value, "config");
  }
  writeFileAtomic(join(home, CONFIG_FILE), `${JSON.stringify(doc, null, 2)}\n`, { fs });
  return doc;
}
