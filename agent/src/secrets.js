import nodeFs from "node:fs";
import { join } from "node:path";

import { LocalStateError, readJsonFile, writeFileAtomic } from "./config.js";
import { publicKeyOf } from "./crypto.js";
import { b64uDecode, constantTimeEqual, toHex } from "./encoding.js";
import { TOKEN_RE, isToken, isWebhookSecret, isX25519KeyString } from "./ids.js";
import { registerSecret } from "./log.js";

export const SECRETS_FILE = "secrets.json";
export const SECRET_KEYS = Object.freeze(["private_key", "public_key", "token", "webhook_secret"]);

function decodeKey(value, what) {
  if (!isX25519KeyString(value)) throw new LocalStateError("invalid_secrets", `${what} is not a 32-byte base64url key`);
  try {
    return b64uDecode(value, { length: 32 });
  } catch {
    throw new LocalStateError("invalid_secrets", `${what} is not a 32-byte base64url key`);
  }
}

export function validateSecrets(secrets) {
  if (secrets === null || typeof secrets !== "object") throw new LocalStateError("invalid_secrets", "secrets must be an object");
  const privateKey = decodeKey(secrets.private_key, "private_key");
  const publicKey = decodeKey(secrets.public_key, "public_key");
  if (!isToken(secrets.token)) throw new LocalStateError("invalid_secrets", "token has the wrong format");
  if (!isWebhookSecret(secrets.webhook_secret)) throw new LocalStateError("invalid_secrets", "webhook_secret has the wrong format");
  if (!constantTimeEqual(publicKeyOf(privateKey), publicKey)) {
    throw new LocalStateError("key_mismatch", "public_key does not belong to private_key");
  }
  return { privateKey, publicKey };
}

function registerAll(secrets, privateKey) {
  registerSecret(secrets.private_key);
  registerSecret(toHex(privateKey));
  registerSecret(secrets.token);
  registerSecret(TOKEN_RE.exec(secrets.token)[2]);
  registerSecret(secrets.webhook_secret);
}

function checkMode(path, expected, what, fs) {
  const mode = fs.statSync(path).mode & 0o777;
  if (mode !== expected) {
    throw new LocalStateError(
      "insecure_permissions",
      `${what} has mode ${mode.toString(8)}, expected ${expected.toString(8)}`,
    );
  }
}

export function saveSecrets(home, secrets, { fs = nodeFs } = {}) {
  const { privateKey } = validateSecrets(secrets);
  const doc = Object.fromEntries(SECRET_KEYS.map((k) => [k, secrets[k]]));
  registerAll(doc, privateKey);
  writeFileAtomic(join(home, SECRETS_FILE), `${JSON.stringify(doc, null, 2)}\n`, { fs });
  return doc;
}

export function hasSecrets(home, { fs = nodeFs } = {}) {
  return fs.existsSync(join(home, SECRETS_FILE));
}

export function loadSecrets(home, { fs = nodeFs } = {}) {
  const path = join(home, SECRETS_FILE);
  if (!fs.existsSync(path)) throw new LocalStateError("not_initialized", "no secrets.json; run syncky-agent init");
  checkMode(home, 0o700, "agent home", fs);
  checkMode(path, 0o600, SECRETS_FILE, fs);
  const doc = readJsonFile(path, { fs });
  const { privateKey, publicKey } = validateSecrets(doc);
  const secrets = Object.fromEntries(SECRET_KEYS.map((k) => [k, doc[k]]));
  registerAll(secrets, privateKey);
  return { ...secrets, privateKeyBytes: privateKey, publicKeyBytes: publicKey };
}

export function createWebhookSecretReader(home, { fs = nodeFs } = {}) {
  const path = join(home, SECRETS_FILE);
  let cached = null;
  return () => {
    checkMode(home, 0o700, "agent home", fs);
    if (!fs.existsSync(path)) return loadSecrets(home, { fs }).webhook_secret;
    checkMode(path, 0o600, SECRETS_FILE, fs);
    const st = fs.statSync(path);
    const key = `${st.ino}:${st.mtimeMs}:${st.ctimeMs}:${st.size}:${st.mode}`;
    if (cached?.key !== key) {
      cached = null;
      cached = { key, value: loadSecrets(home, { fs }).webhook_secret };
    }
    return cached.value;
  };
}

export function updateSecrets(home, patch, { fs = nodeFs } = {}) {
  const current = loadSecrets(home, { fs });
  const next = Object.fromEntries(SECRET_KEYS.map((k) => [k, patch[k] ?? current[k]]));
  return saveSecrets(home, next, { fs });
}
