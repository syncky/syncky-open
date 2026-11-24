import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { b64uDecode } from "../../src/encoding.js";
import { EnvelopeError } from "../support/envelope.js";
import { createThinTransport } from "../../src/thin-transport.js";
import { loadJson, loadVectors } from "../../src/protocol-files.js";

const keys = loadVectors("keys");
const { cases } = loadVectors("envelopes-negative");

describe("envelopes-negative.json", () => {
  for (const c of cases) {
    it(`${c.name} → ${c.expect}`, async () => {
      const receiver = keys[c.receiver];
      assert.ok(receiver, `unknown receiver ${c.receiver}`);
      const senderKeyOf = (memberId) =>
        Object.hasOwn(c.registry, memberId) ? b64uDecode(c.registry[memberId], { length: 32 }) : null;
      await assert.rejects(
        createThinTransport({ table: loadJson("messages.json") }).receive({
          envelope: c.envelope, hubId: c.hub_id,
          self: { memberId: receiver.member_id, privateKey: b64uDecode(receiver.sk, { length: 32 }) }, senderKeyOf,
        }),
        (err) => {
          assert.ok(err instanceof EnvelopeError, `expected EnvelopeError, got ${err?.name}: ${err?.message}`);
          assert.equal(err.code, c.expect);
          return true;
        },
      );
    });
  }
});
