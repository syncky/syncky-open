import { afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";

import { ensureHome } from "../../src/config.js";
import { generateKeyPair } from "../../src/crypto.js";
import { b64uEncode, toHex } from "../../src/encoding.js";
import { REDACTED, clearRegisteredSecrets, createLogger } from "../../src/log.js";
import { SECRETS_FILE, createWebhookSecretReader, hasSecrets, loadSecrets, saveSecrets, updateSecrets, validateSecrets } from "../../src/secrets.js";
import { tempHome } from "../support/helpers.js";

const TOKEN = "sk_hub_AbCdEfGhIjKlMnOpQr_-01_abcdefghijklmnopqrstuvwxyz0123456789_-AB";
const WHSEC = "whsec_abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE";
const WHSEC2 = "whsec_ZYXWVUTSRQPONMLKJIHGFEDCBA9876543210_-abcde";

const mode = (p) => fs.statSync(p).mode & 0o777;

describe("secrets", () => {
  let t;
  let keys;
  let other;
  let valid;

  before(async () => {
    keys = await generateKeyPair();
    other = await generateKeyPair();
  });

  beforeEach(() => {
    t = tempHome();
    ensureHome(t.home);
    valid = {
      private_key: b64uEncode(keys.privateKey),
      public_key: b64uEncode(keys.publicKey),
      token: TOKEN,
      webhook_secret: WHSEC,
    };
  });

  afterEach(() => {
    clearRegisteredSecrets();
    t.cleanup();
  });

  it("saves secrets.json with mode 0600 inside a 0700 home and loads it back", () => {
    assert.equal(hasSecrets(t.home), false);
    saveSecrets(t.home, { ...valid, extra: "dropped" });
    const p = join(t.home, SECRETS_FILE);
    assert.equal(mode(p), 0o600);
    assert.equal(mode(t.home), 0o700);
    assert.equal(hasSecrets(t.home), true);
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(p, "utf8"))), ["private_key", "public_key", "token", "webhook_secret"]);
    const loaded = loadSecrets(t.home);
    assert.equal(loaded.private_key, valid.private_key);
    assert.equal(loaded.public_key, valid.public_key);
    assert.equal(loaded.token, TOKEN);
    assert.equal(loaded.webhook_secret, WHSEC);
    assert.deepEqual(loaded.privateKeyBytes, keys.privateKey);
    assert.deepEqual(loaded.publicKeyBytes, keys.publicKey);
    assert.deepEqual(fs.readdirSync(t.home), [SECRETS_FILE]);
  });

  it("refuses a secrets file with mode 0644", () => {
    saveSecrets(t.home, valid);
    fs.chmodSync(join(t.home, SECRETS_FILE), 0o644);
    assert.throws(() => loadSecrets(t.home), { code: "insecure_permissions" });
  });

  it("refuses a home directory with mode 0755", () => {
    saveSecrets(t.home, valid);
    fs.chmodSync(t.home, 0o755);
    assert.throws(() => loadSecrets(t.home), { code: "insecure_permissions" });
  });

  it("reports not_initialized when secrets.json is missing", () => {
    assert.throws(() => loadSecrets(t.home), { code: "not_initialized" });
  });

  it("rejects a public key that does not belong to the private key", () => {
    assert.throws(() => saveSecrets(t.home, { ...valid, public_key: b64uEncode(other.publicKey) }), { code: "key_mismatch" });
    assert.equal(hasSecrets(t.home), false);
    fs.writeFileSync(join(t.home, SECRETS_FILE), JSON.stringify({ ...valid, public_key: b64uEncode(other.publicKey) }), { mode: 0o600 });
    fs.chmodSync(join(t.home, SECRETS_FILE), 0o600);
    assert.throws(() => loadSecrets(t.home), { code: "key_mismatch" });
  });

  it("rejects malformed tokens, webhook secrets and keys", () => {
    const cases = [
      { token: "sk_hub_short" },
      { token: undefined },
      { token: TOKEN.replace("sk_", "pk_") },
      { webhook_secret: "whsec_tooShort" },
      { webhook_secret: null },
      { private_key: "not-a-key" },
      { private_key: `${valid.private_key.slice(0, 42)}B` },
      { public_key: 12 },
    ];
    for (const patch of cases) {
      assert.throws(() => validateSecrets({ ...valid, ...patch }), { code: "invalid_secrets" }, JSON.stringify(patch));
    }
    assert.throws(() => validateSecrets(null), { code: "invalid_secrets" });
  });

  it("rejects a malformed token found on disk", () => {
    fs.writeFileSync(join(t.home, SECRETS_FILE), JSON.stringify({ ...valid, token: "sk_bad" }));
    fs.chmodSync(join(t.home, SECRETS_FILE), 0o600);
    assert.throws(() => loadSecrets(t.home), { code: "invalid_secrets" });
  });

  it("registers every loaded secret with the logger so it is redacted", () => {
    saveSecrets(t.home, valid);
    clearRegisteredSecrets();
    loadSecrets(t.home);
    const lines = [];
    const logger = createLogger({ level: "debug", sink: (l) => lines.push(l) });
    const hex = toHex(keys.privateKey);
    logger.info("dump", { note: `k=${valid.private_key} h=${hex} t=${TOKEN.slice(-40)} w=${WHSEC} p=${valid.public_key}` });
    const out = lines.join("\n");
    assert.ok(!out.includes(valid.private_key));
    assert.ok(!out.includes(hex));
    assert.ok(!out.includes(TOKEN.slice(-40)));
    assert.ok(!out.includes(WHSEC));
    assert.ok(out.includes(REDACTED));
    assert.ok(out.includes(valid.public_key), "public keys are not secrets");
  });

  it("updates one secret and keeps the rest", () => {
    saveSecrets(t.home, valid);
    updateSecrets(t.home, { webhook_secret: WHSEC2 });
    const loaded = loadSecrets(t.home);
    assert.equal(loaded.webhook_secret, WHSEC2);
    assert.equal(loaded.token, TOKEN);
    assert.equal(mode(join(t.home, SECRETS_FILE)), 0o600);
    assert.deepEqual(fs.readdirSync(t.home), [SECRETS_FILE]);
  });

  describe("webhook secret reader", () => {
    const countingFs = () => {
      const counter = { reads: 0 };
      counter.fs = { ...fs, readFileSync: (...args) => (counter.reads++, fs.readFileSync(...args)) };
      return counter;
    };

    it("reads and validates secrets.json once for many calls while the file is unchanged", () => {
      saveSecrets(t.home, valid);
      const counter = countingFs();
      const read = createWebhookSecretReader(t.home, { fs: counter.fs });
      for (let i = 0; i < 5; i++) assert.equal(read(), WHSEC);
      assert.equal(counter.reads, 1);
    });

    it("picks up a rotated secret of the same length on the next call", () => {
      saveSecrets(t.home, valid);
      const read = createWebhookSecretReader(t.home);
      assert.equal(read(), WHSEC);
      updateSecrets(t.home, { webhook_secret: WHSEC2 });
      assert.equal(read(), WHSEC2);
    });

    it("fails with a warm cache once the file or the home is opened up", () => {
      saveSecrets(t.home, valid);
      const p = join(t.home, SECRETS_FILE);
      const read = createWebhookSecretReader(t.home);
      assert.equal(read(), WHSEC);
      fs.chmodSync(p, 0o644);
      assert.throws(read, { code: "insecure_permissions" });
      fs.chmodSync(p, 0o600);
      assert.equal(read(), WHSEC);
      fs.chmodSync(t.home, 0o755);
      assert.throws(read, { code: "insecure_permissions" });
      fs.chmodSync(t.home, 0o700);
      assert.equal(read(), WHSEC);
    });

    it("fails with not_initialized once the file is removed", () => {
      saveSecrets(t.home, valid);
      const read = createWebhookSecretReader(t.home);
      assert.equal(read(), WHSEC);
      fs.rmSync(join(t.home, SECRETS_FILE));
      assert.throws(read, { code: "not_initialized" });
    });

    it("keeps failing while the file is corrupt and recovers when it is valid again", () => {
      saveSecrets(t.home, valid);
      const p = join(t.home, SECRETS_FILE);
      const read = createWebhookSecretReader(t.home);
      assert.equal(read(), WHSEC);
      fs.writeFileSync(p, "{not json", { mode: 0o600 });
      assert.throws(read);
      assert.throws(read);
      saveSecrets(t.home, { ...valid, webhook_secret: WHSEC2 });
      assert.equal(read(), WHSEC2);
    });
  });
});
