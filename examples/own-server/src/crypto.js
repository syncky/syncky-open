const encoder = new TextEncoder();
const bytes = (value) => typeof value === "string" ? encoder.encode(value) : value;
const hex = (value) => [...new Uint8Array(value)].map(b => b.toString(16).padStart(2, "0")).join("");
const fail = () => { throw new Error("invalid_configuration"); };
const reservedHeaders = new Set(["host", "content-type", "content-length", "user-agent", "authorization", "transfer-encoding", "upgrade", "connection", "keep-alive", "te", "trailer"]);

export const digest = async (value) => hex(await crypto.subtle.digest("SHA-256", bytes(value)));
export const base64url = (value) => btoa(String.fromCharCode(...new Uint8Array(value))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
export const random = () => base64url(crypto.getRandomValues(new Uint8Array(32)));
export const pkceChallenge = async (value) => base64url(await crypto.subtle.digest("SHA-256", bytes(value)));
export async function passwordHash(password, salt) {
  const key = await crypto.subtle.importKey("raw", bytes(password), "PBKDF2", false, ["deriveBits"]);
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: bytes(salt), iterations: 100_000 }, key, 256));
}
export const mac = async (key, value) => base64url(await crypto.subtle.sign("HMAC", await hmacKey(key), bytes(value)));
export function equal(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  let different = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) different |= (a.charCodeAt(i) || 0) ^ b.charCodeAt(i);
  return different === 0;
}

export function validAuth(auth) {
  if (!auth || !["bearer", "basic", "header"].includes(auth.kind)) return false;
  if (auth.kind === "basic") return typeof auth.user === "string" && /^[\x20-\x39\x3b-\x7e]{1,256}$/.test(auth.user);
  if (auth.kind === "header") {
    const name = auth.header_name;
    return typeof name === "string" && /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,256}$/.test(name) && !reservedHeaders.has(name.toLowerCase()) && !name.toLowerCase().startsWith("x-syncky-");
  }
  return true;
}

function credentialValue(auth, token) {
  if (!validAuth(auth) || typeof token !== "string" || !token || encoder.encode(token).length > 4096 || /[\r\n\0]/.test(token)) return fail();
  if (auth.kind === "header") return token;
  return auth.kind === "bearer" ? `Bearer ${token}` : `Basic ${btoa(String.fromCharCode(...encoder.encode(`${auth.user}:${token}`)))}`;
}

export async function createUploadCredentials({ auth, token, hmac = null }) {
  const value = credentialValue(auth, token);
  if (hmac !== null && (typeof hmac !== "string" || !hmac || encoder.encode(hmac).length > 4096)) return fail();
  return { initialized: true, auth: { ...auth }, verifier: await digest(value), hmac };
}

export const initializedCredentials = (c) => c?.initialized === true && validAuth(c.auth) && typeof c.verifier === "string" && /^[a-f0-9]{64}$/.test(c.verifier) && (c.hmac === null || typeof c.hmac === "string" && c.hmac.length > 0 && encoder.encode(c.hmac).length <= 4096);

export async function authorized(headers, credentials) {
  const given = headers.get(credentials.auth.kind === "header" ? credentials.auth.header_name : "authorization");
  const hashed = await digest(given ?? "");
  let different = 0;
  for (let i = 0; i < hashed.length; i++) different |= hashed.charCodeAt(i) ^ credentials.verifier.charCodeAt(i);
  return given !== null && different === 0;
}

async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

function prefixed(prefix, body) {
  const head = encoder.encode(prefix), tail = bytes(body);
  const all = new Uint8Array(head.length + tail.length);
  all.set(head);
  all.set(tail, head.length);
  return all;
}

export async function verifySignature({ secret, timestamp, signature, body, now }) {
  if (typeof timestamp !== "string" || !/^[0-9]{1,15}$/.test(timestamp) || typeof signature !== "string" || !/^v1=[0-9a-f]{64}$/.test(signature)) return "bad_signature";
  const given = Uint8Array.from(signature.slice(3).match(/../g), pair => Number.parseInt(pair, 16));
  const valid = await crypto.subtle.verify("HMAC", await hmacKey(secret), given, prefixed(`${timestamp}.`, body));
  if (!valid) return "bad_signature";
  return Number.isFinite(now) && Math.abs(now - Number(timestamp)) <= 300 ? "valid" : "stale";
}

export async function signReply(secret, delivery, timestamp, body) {
  return `t=${timestamp},v1=${hex(await crypto.subtle.sign("HMAC", await hmacKey(secret), prefixed(`${delivery}.${timestamp}.`, body)))}`;
}

export function percentEncode(value) {
  return [...encoder.encode(String(value))].map(b => /[A-Za-z0-9\-._~]/.test(String.fromCharCode(b)) ? String.fromCharCode(b) : `%${b.toString(16).toUpperCase().padStart(2, "0")}`).join("");
}

export function buildLink(destination, secrets = {}, scheme = "syncky") {
  if (!["syncky", "syncky-dev", "syncky-staging"].includes(scheme) || destination.format !== "native") return fail();
  credentialValue(destination.auth, destination.auth?.kind === "header" ? secrets.header_value : secrets.token);
  let url;
  try { url = new URL(destination.url); } catch { return fail(); }
  if (url.username || url.password || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) return fail();
  if (typeof destination.name !== "string" || !destination.name || destination.name.length > 64 || destination.url.length > 2048) return fail();
  const kind = destination.auth.kind;
  const parts = ["v=1", `name=${percentEncode(destination.name)}`, `url=${percentEncode(destination.url)}`, "format=native", `auth=${kind}`];
  if (kind === "header") parts.push(`header=${percentEncode(destination.auth.header_name)}`, `token=${percentEncode(secrets.header_value)}`);
  if (kind === "basic") parts.push(`user=${percentEncode(destination.auth.user)}`, `token=${percentEncode(secrets.token)}`);
  if (kind === "bearer") parts.push(`token=${percentEncode(secrets.token)}`);
  if (destination.signing) {
    if (typeof secrets.hmac !== "string" || !secrets.hmac) return fail();
    parts.push(`hmac=${percentEncode(secrets.hmac)}`);
  }
  if (destination.types) {
    if (!Array.isArray(destination.types) || !destination.types.every(t => typeof t === "string" && /^[a-z][a-z0-9_]{1,63}$/.test(t))) return fail();
    parts.push(`types=${destination.types.map(percentEncode).join(",")}`);
  }
  return `${scheme}://webhook?${parts.join("&")}`;
}
