import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { b64uEncode } from "../../src/encoding.js";
import { pairCode, pairProof, pairProofMatches } from "../../src/pair-code.js";

const secret = b64uEncode(Uint8Array.from({ length: 16 }, (_, i) => i));
const agent = b64uEncode(Uint8Array.from({ length: 32 }, (_, i) => i));
const device = b64uEncode(Uint8Array.from({ length: 32 }, (_, i) => i + 32));

describe("pairCode", () => {
  it("matches a hand-computed code", () => {
    assert.equal(pairCode(secret), "927 106 864");
  });

  for (const bad of ["", `${secret}=`, b64uEncode(new Uint8Array(15)), b64uEncode(new Uint8Array(17)), `${secret.slice(0, -1)}B`, `+${secret.slice(1)}`, undefined]) {
    it(`throws for the secret ${JSON.stringify(bad)}`, () => {
      assert.throws(() => pairCode(bad));
    });
  }
});

describe("pairProof", () => {
  it("is the HMAC of both keys keyed by the raw secret", () => {
    assert.equal(pairProof(secret, agent, device), "KvuAQU6JxuaG7oUrqNMqb-BJ_8SXJBaMPPfzkzPdoz0");
    assert.notEqual(pairProof(secret, device, agent), pairProof(secret, agent, device));
  });

  it("throws for a malformed key", () => {
    assert.throws(() => pairProof(secret, b64uEncode(new Uint8Array(31)), device));
    assert.throws(() => pairProof(secret, agent, `${device}=`));
    assert.throws(() => pairProof(agent, agent, device));
  });
});

describe("pairProofMatches", () => {
  const proof = pairProof(secret, agent, device);

  it("accepts the same proof and refuses another", () => {
    assert.equal(pairProofMatches(proof, proof), true);
    assert.equal(pairProofMatches(proof, pairProof(secret, agent, agent)), false);
  });

  for (const bad of [undefined, null, 42, "", `${proof}=`, proof.slice(0, -1), b64uEncode(new Uint8Array(31)), b64uEncode(new Uint8Array(33))]) {
    it(`returns false instead of throwing for ${JSON.stringify(bad)}`, () => {
      assert.equal(pairProofMatches(proof, bad), false);
      assert.equal(pairProofMatches(bad, proof), false);
    });
  }
});
