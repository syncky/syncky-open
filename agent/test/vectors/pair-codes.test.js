import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { pairCode, pairProof, pairProofMatches } from "../../src/pair-code.js";
import { loadVectors } from "../../src/protocol-files.js";

const keys = loadVectors("keys");
const { cases } = loadVectors("pair-codes");

describe("pair-codes.json", () => {
  it("pairs the agent key with every device key under one secret", () => {
    const shared = cases.filter((c) => c.pair_secret === cases[0].pair_secret);
    const devices = new Set(shared.map((c) => c.device_public_key));
    for (const name of ["dev1", "dev2", "mallory"]) assert.ok(devices.has(keys[name].pk), name);
    assert.ok(cases.every((c) => c.agent_public_key === keys.agent.pk));
    assert.ok(cases.length >= 4);
  });

  for (const c of cases) {
    it(c.name, () => {
      assert.equal(pairCode(c.pair_secret), c.code);
      assert.match(pairCode(c.pair_secret), /^\d{3} \d{3} \d{3}$/);
      assert.equal(pairProof(c.pair_secret, c.agent_public_key, c.device_public_key), c.proof);
      assert.ok(c.choices.includes(c.code.split(" ")[2]));
      assert.ok(pairProofMatches(c.proof, pairProof(c.pair_secret, c.agent_public_key, c.device_public_key)));
    });
  }

  it("a swapped device key gives the same code and a proof that does not match", () => {
    const [a, b] = cases.filter((c) => c.pair_secret === cases[0].pair_secret);
    assert.equal(a.code, b.code);
    assert.equal(pairProofMatches(a.proof, pairProof(b.pair_secret, b.agent_public_key, b.device_public_key)), false);
  });
});
