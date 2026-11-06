import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import { MAX_SKEW_S, signWebhook, verifyWebhook } from "../support/webhook-signature.js";

const secret = "whsec_fYkCEgFHSpi-f9oHitNckyST7Apwn7zcGWEcU_Nk8mM";
const ts = 1791705600;
const body = '{"hub_id":"hub_AAAAAAAAAAAAAAAAAAAAAA","messages":[]}';

const reference = (key, timestamp, bytes) =>
  "v1=" + createHmac("sha256", Buffer.from(key, "utf8")).update(Buffer.concat([Buffer.from(`${timestamp}.`), bytes])).digest("hex");

const verify = (overrides = {}) =>
  verifyWebhook({
    secret,
    timestampHeader: String(ts),
    signatureHeader: signWebhook(secret, ts, body),
    rawBody: body,
    now: ts,
    ...overrides,
  });

describe("verifyWebhook", () => {
  it("matches an independent HMAC computation", () => {
    assert.equal(signWebhook(secret, ts, body), reference(secret, ts, Buffer.from(body)));
    assert.equal(verify(), "valid");
  });

  it("accepts exactly ±300 s and rejects ±301 s as stale", () => {
    assert.equal(MAX_SKEW_S, 300);
    assert.equal(verify({ now: ts + 300 }), "valid");
    assert.equal(verify({ now: ts - 300 }), "valid");
    assert.equal(verify({ now: ts + 301 }), "stale");
    assert.equal(verify({ now: ts - 301 }), "stale");
  });

  it("checks the signature before the timestamp window", () => {
    assert.equal(verify({ now: ts + 10_000, signatureHeader: "v1=" + "0".repeat(64) }), "bad_signature");
  });

  it("uses the current time by default", () => {
    const now = Math.floor(Date.now() / 1000);
    const args = { secret, timestampHeader: String(now), signatureHeader: signWebhook(secret, now, body), rawBody: body };
    assert.equal(verifyWebhook(args), "valid");
    const old = now - 3600;
    assert.equal(
      verifyWebhook({ ...args, timestampHeader: String(old), signatureHeader: signWebhook(secret, old, body) }),
      "stale",
    );
  });

  for (const [name, overrides] of [
    ["missing signature header", { signatureHeader: undefined }],
    ["missing timestamp header", { timestampHeader: undefined }],
    ["array header", { signatureHeader: [signWebhook(secret, ts, body)] }],
    ["v0= prefix", { signatureHeader: signWebhook(secret, ts, body).replace("v1=", "v0=") }],
    ["no prefix", { signatureHeader: signWebhook(secret, ts, body).slice(3) }],
    ["uppercase hex", { signatureHeader: "v1=" + signWebhook(secret, ts, body).slice(3).toUpperCase() }],
    ["63 hex chars", { signatureHeader: signWebhook(secret, ts, body).slice(0, -1) }],
    ["65 hex chars", { signatureHeader: signWebhook(secret, ts, body) + "0" }],
    ["whitespace around the signature", { signatureHeader: ` ${signWebhook(secret, ts, body)}` }],
    ["non-numeric timestamp", { timestampHeader: "abc" }],
    ["negative timestamp", { timestampHeader: `-${ts}`, signatureHeader: signWebhook(secret, `-${ts}`, body) }],
    ["fractional timestamp", { timestampHeader: `${ts}.0`, signatureHeader: signWebhook(secret, `${ts}.0`, body) }],
    ["empty timestamp", { timestampHeader: "" }],
    ["wrong value with the right length", { signatureHeader: "v1=" + "a".repeat(64) }],
    ["different secret", { secret: "whsec_" + "A".repeat(43) }],
    ["missing secret", { secret: undefined }],
    ["empty secret", { secret: "" }],
  ]) {
    it(`${name} → bad_signature`, () => {
      assert.equal(verify(overrides), "bad_signature");
    });
  }

  it("signs the raw body bytes, not a re-encoded string", () => {
    const text = '{"n":"Café 健康 📱"}';
    const nfd = Buffer.from(text.normalize("NFD"), "utf8");
    const signature = reference(secret, ts, nfd);
    assert.equal(signWebhook(secret, ts, new Uint8Array(nfd)), signature);
    const args = { secret, timestampHeader: String(ts), signatureHeader: signature, now: ts };
    assert.equal(verifyWebhook({ ...args, rawBody: new Uint8Array(nfd) }), "valid");
    assert.equal(verifyWebhook({ ...args, rawBody: text.normalize("NFC") }), "bad_signature");

    const invalidUtf8 = Uint8Array.from([0x7b, 0xc3, 0x28, 0x7d]);
    const raw = reference(secret, ts, Buffer.from(invalidUtf8));
    assert.equal(verifyWebhook({ ...args, signatureHeader: raw, rawBody: invalidUtf8 }), "valid");
    assert.equal(
      verifyWebhook({ ...args, signatureHeader: raw, rawBody: new TextDecoder().decode(invalidUtf8) }),
      "bad_signature",
    );
  });

  it("rejects bodies that are neither bytes nor strings", () => {
    assert.throws(() => signWebhook(secret, ts, { a: 1 }), TypeError);
    assert.throws(() => signWebhook("", ts, body), TypeError);
  });
});
