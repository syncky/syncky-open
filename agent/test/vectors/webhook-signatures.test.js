import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { signWebhook, verifyWebhook } from "../support/webhook-signature.js";
import { loadVectors } from "../support/protocol-files.js";

const { cases } = loadVectors("webhook-signatures");

describe("webhook-signatures.json", () => {
  it("covers every verification result", () => {
    assert.deepEqual([...new Set(cases.map((c) => c.expect))].sort(), ["bad_signature", "stale", "valid"]);
  });

  for (const c of cases) {
    it(c.name, () => {
      const args = { secret: c.secret, timestampHeader: c.timestamp, signatureHeader: c.signature, now: c.now };
      assert.equal(verifyWebhook({ ...args, rawBody: c.body }), c.expect);
      assert.equal(verifyWebhook({ ...args, rawBody: new TextEncoder().encode(c.body) }), c.expect);
      if (c.expect === "valid") assert.equal(signWebhook(c.secret, c.timestamp, c.body), c.signature);
    });
  }
});
