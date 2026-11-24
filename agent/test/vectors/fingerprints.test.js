import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { fingerprint } from "../../src/fingerprint.js";
import { loadVectors } from "../../src/protocol-files.js";

const { cases } = loadVectors("fingerprints");

describe("fingerprints.json", () => {
  for (const c of cases) {
    it(c.name, () => {
      const fp = fingerprint(c.agent_pub, c.device_pub);
      assert.equal(fp.sha256Hex, c.sha256_hex);
      assert.equal(fp.text, c.fingerprint);
      assert.match(fp.text, /^\d{4} \d{4} \d{4} \d{4}$/);
    });
  }

  it("depends on the order of the two keys", () => {
    const c = cases[0];
    assert.notEqual(fingerprint(c.device_pub, c.agent_pub).sha256Hex, c.sha256_hex);
  });
});
