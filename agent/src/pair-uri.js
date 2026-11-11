import { isB64u, utf8, utf8Decode } from "./encoding.js";
import { isHubId, isPairingToken } from "./ids.js";
import { isUrlScheme, URL_SCHEMES } from "./url-scheme.js";
import { validateAccessScope } from './access-scope.js';

export const PAIR_URI_ERROR_CODES = Object.freeze(["invalid_uri", "unsupported_version", "insecure_relay"]);

const PREFIXES = URL_SCHEMES.map((scheme) => `${scheme}://`);
const HTTPS = "https://";
const HTTP = "http://";
const SITES = new Set(["syncky.app", "dev.syncky.app", "staging.syncky.app"]);
const SCOPE_KEYS = ['request_ref', 'read', 'write'];
const KNOWN = new Set(["v", "r", "h", "t", "k", "n", "c", "s", ...SCOPE_KEYS]);
const REQUIRED = ["r", "h", "t", "k", "n"];
const RELAY_RE = /^(?:[A-Za-z0-9.-]{1,253}|\[[0-9A-Fa-f:.]{2,45}\])(?::([1-9][0-9]{0,4}))?$/;
const HEX_PAIR_RE = /^[0-9A-Fa-f]{2}$/;

const invalid = (param) => ({ ok: false, code: "invalid_uri", param });

export const MAX_PAIR_URI_NAME_UNITS = 64;
export const PAIR_SECRET_BYTES = 16;

export function isPairUriName(name) {
  return typeof name === "string" && name.length >= 1 && name.length <= MAX_PAIR_URI_NAME_UNITS;
}

function isRelay(r) {
  const match = RELAY_RE.exec(r);
  if (!match) return false;
  return match[1] === undefined || Number(match[1]) <= 65535;
}

function percentEncode(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function percentDecode(value) {
  const bytes = [];
  for (let i = 0; i < value.length; ) {
    if (value[i] === "%") {
      const hex = value.slice(i + 1, i + 3);
      if (!HEX_PAIR_RE.test(hex)) return null;
      bytes.push(parseInt(hex, 16));
      i += 3;
      continue;
    }
    const cp = value.codePointAt(i);
    if (cp >= 0xd800 && cp <= 0xdfff) return null;
    const ch = String.fromCodePoint(cp);
    bytes.push(...utf8(ch));
    i += ch.length;
  }
  try {
    return utf8Decode(Uint8Array.from(bytes));
  } catch {
    return null;
  }
}

export function parsePairUri(uri, { allowInsecureRelay = false } = {}) {
  let payload;
  if (typeof uri === "string" && uri.startsWith(HTTPS)) {
    const rest = uri.slice(HTTPS.length), end = rest.search(/[/?#]/);
    const authorityEnd = end < 0 ? rest.length : end;
    if (!SITES.has(rest.slice(0, authorityEnd))) return invalid("host");
    const path = rest.slice(authorityEnd).split(/[?#]/, 1)[0], pathEnd = authorityEnd + path.length;
    if (path !== "/pair") return invalid("path");
    if (rest[pathEnd] === "?") return invalid("query");
    payload = rest.slice(pathEnd + 1);
  } else {
    const prefix = typeof uri === "string" && PREFIXES.find((p) => uri.startsWith(p));
    if (!prefix) return invalid("scheme");
    const rest = uri.slice(prefix.length), end = rest.search(/[?#]/);
    const authorityEnd = end < 0 ? rest.length : end;
    if (rest.slice(0, authorityEnd) !== "pair") return invalid("host");
    if (rest.includes("#")) return invalid("fragment");
    payload = rest.slice(authorityEnd + 1);
  }

  const params = new Map();
  for (const segment of payload.split("&")) {
    const eq = segment.indexOf("=");
    if (eq < 0) continue;
    const key = segment.slice(0, eq);
    if (!KNOWN.has(key)) continue;
    if (params.has(key)) return invalid(key);
    const decoded = percentDecode(segment.slice(eq + 1));
    if (decoded === null) return invalid("encoding");
    params.set(key, decoded);
  }

  if (!params.has("v")) return invalid("v");
  const version = params.get("v");
  if (version !== "1" && version !== "2") return { ok: false, code: "unsupported_version" };
  for (const key of REQUIRED) if (!params.has(key)) return invalid(key);
  if (version === "2" && !params.has("c")) return invalid("c");
  const c = version === "2" ? params.get("c") : undefined;

  const [r, h, t, k, n] = REQUIRED.map((key) => params.get(key));
  const s = params.get("s");
  if (!isRelay(r)) return invalid("r");
  if (!isHubId(h)) return invalid("h");
  if (!isPairingToken(t)) return invalid("t");
  if (!isB64u(k, { length: 32 })) return invalid("k");
  if (!isPairUriName(n)) return invalid("n");
  if (c !== undefined && !isB64u(c, { length: PAIR_SECRET_BYTES })) return invalid("c");
  if (s !== undefined && s !== "http") return invalid("s");
  if (s !== undefined && !allowInsecureRelay) return { ok: false, code: "insecure_relay" };
  let requestedScope;
  if (SCOPE_KEYS.some(key => params.has(key))) {
    for (const key of SCOPE_KEYS) if (!params.has(key)) return invalid(key);
    const scope = { request_ref: params.get('request_ref') };
    if (!/^[0-9a-f]{32}$/.test(scope.request_ref)) return invalid('request_ref');
    for (const side of ['read', 'write']) {
      try { scope[side] = JSON.parse(params.get(side)); } catch { return invalid(side); }
      if (!Array.isArray(scope[side]) || scope[side].some((v, i, a) => typeof v !== 'string' || (i > 0 && a[i - 1] >= v))) return invalid(side);
    }
    const result = validateAccessScope(scope);
    if (!result.ok) return invalid(result.param);
    requestedScope = result.value;
  }

  return {
    ok: true,
    value: {
      relayBase: (s === undefined ? HTTPS : HTTP) + r,
      hubId: h,
      pairingToken: t,
      agentPublicKey: k,
      agentName: n,
      ...(c !== undefined && { pairSecret: c }),
      ...(requestedScope !== undefined && { requestedScope }),
    },
  };
}

function relayHostOf(relayBase) {
  if (typeof relayBase !== "string") throw new TypeError("relay URL must be a string");
  const insecure = relayBase.startsWith(HTTP);
  if (!insecure && !relayBase.startsWith(HTTPS)) throw new TypeError("relay URL must start with http:// or https://");
  return { host: relayBase.slice((insecure ? HTTP : HTTPS).length), insecure };
}

export function buildPairUri({ relayBase, hubId, pairingToken, agentPublicKey, agentName, pairSecret, requestedScope, urlScheme = null }) {
  if (urlScheme !== null && !isUrlScheme(urlScheme)) throw new TypeError("url scheme must be syncky, syncky-dev or syncky-staging");
  const { host, insecure } = relayHostOf(relayBase);
  const relayHost = host.split(":")[0].toLowerCase();
  const site = relayHost === "relay-dev.syncky.app" ? "dev.syncky.app" : relayHost === "relay-staging.syncky.app" ? "staging.syncky.app" : "syncky.app";
  const v2 = pairSecret !== undefined && pairSecret !== null;
  let uri = `${urlScheme === null ? `https://${site}/pair#` : `${urlScheme}://pair?`}v=${v2 ? 2 : 1}`;
  const params = [
    ["r", host],
    ["h", hubId],
    ["t", pairingToken],
    ["k", agentPublicKey],
    ["n", agentName],
  ];
  if (v2) params.push(["c", pairSecret]);
  for (const [key, value] of params) {
    if (typeof value !== "string") throw new TypeError(`pair URI parameter ${key} must be a string`);
    uri +=`&${key}=${percentEncode(value)}`;
  }
  if (insecure) uri += "&s=http";
  if (requestedScope !== undefined) {
    const result = validateAccessScope(requestedScope, { normalize: true });
    if (!result.ok) throw new TypeError(`invalid pairing scope (${result.param})`);
    for (const key of SCOPE_KEYS) uri += `&${key}=${percentEncode(key === 'request_ref' ? result.value[key] : JSON.stringify(result.value[key]))}`;
  }
  const check = parsePairUri(uri, { allowInsecureRelay: true });
  if (!check.ok) throw new TypeError(`pairing info does not form a valid pair URI (${check.code}${check.param ? `: ${check.param}` : ""})`);
  return uri;
}
