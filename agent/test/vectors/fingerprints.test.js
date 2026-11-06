import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { fingerprint } from "../../src/fingerprint.js";
import { loadVectors } from "../../src/protocol-files.js";

const keys = loadVectors("keys");
const { cases } = loadVectors("fingerprints");

describe("fingerprints.json", () => {
  it("covers the agent paired with every device key", () => {
    const names = cases.map((c) => c.name);
    for (const required of ["agent_dev1", "agent_dev2", "agent_mallory"]) assert.ok(names.includes(required), required);
    const devicePubs = new Set(cases.map((c) => c.device_pub));
    for (const name of ["dev1", "dev2", "mallory"]) assert.ok(devicePubs.has(keys[name].pk), name);
    assert.ok(cases.filter((c) => c.name.startsWith("agent_")).every((c) => c.agent_pub === keys.agent.pk));
  });

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
