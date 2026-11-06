import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { deriveKeyPair, publicKeyOf } from "../../src/crypto.js";
import { b64uDecode, b64uEncode, utf8 } from "../../src/encoding.js";
import { envelopeAad, openEnvelope, sealEnvelope, serializeEnvelope } from "../support/envelope.js";
import { loadVectors } from "../../src/protocol-files.js";

const keys = loadVectors("keys");
const { cases } = loadVectors("envelopes");
const memberKey = Object.fromEntries(Object.values(keys).map((k) => [k.member_id, b64uDecode(k.pk, { length: 32 })]));
const senderKeyOf = (memberId) => memberKey[memberId] ?? null;
const keyNameOf = (memberId) => Object.keys(keys).find((name) => keys[name].member_id === memberId);

function roleRandom(c) {
  const byLength = { 32: b64uDecode(c.cek, { length: 32 }), 12: b64uDecode(c.nonce, { length: 12 }) };
  return (n) => {
    if (!byLength[n]) throw new Error(`unexpected random draw of ${n} bytes`);
    return new Uint8Array(byLength[n]);
  };
}

describe("envelopes.json", () => {
  it("covers the required positive cases", () => {
    assert.deepEqual([...new Set(cases.map(c => c.envelope.diagnostics).filter(Boolean))].sort(), ["archive", "reply", "request"]);
    const names = cases.map((c) => c.name);
    for (const required of [
      "sync_steps_to_agent",
      "sync_with_deleted_and_acks",
      "commands_water_to_dev1",
      "commands_to_two_devices",
      "unicode_and_large_payload",
      "empty_sync",
      "control_unpair_to_agent",
      "control_confirmed_to_dev1",
    ]) {
      assert.ok(names.includes(required), required);
    }
  });

  for (const c of cases) {
    describe(c.name, () => {
      const sender = keys[c.sender];

      it("every recipient opens it to exactly the plaintext", async () => {
        assert.ok(c.recipients.length >= 1);
        for (const r of c.recipients) {
          const plaintext = await openEnvelope({
            envelope: c.envelope,
            hubId: c.hub_id,
            self: { memberId: r.member_id, privateKey: b64uDecode(keys[r.key].sk, { length: 32 }) },
            senderKeyOf,
          });
          assert.deepEqual(plaintext, utf8(c.plaintext));
        }
      });

      it("re-seals byte for byte", async () => {
        const ikmFor = Object.fromEntries(c.recipients.map((r) => [r.member_id, b64uDecode(r.ikm_e, { length: 32 })]));
        const envelope = await sealEnvelope({
          hubId: c.hub_id,
          from: sender.member_id,
          recipients: c.recipients.map((r) => ({ memberId: r.member_id, publicKey: memberKey[r.member_id] })),
          senderPrivateKey: b64uDecode(sender.sk, { length: 32 }),
          plaintext: utf8(c.plaintext),
          kind: c.envelope.kind,
          diagnostics: c.envelope.diagnostics,
        access: c.envelope.access,
          msgId: c.envelope.msg_id,
          createdAt: c.envelope.created_at,
          random: roleRandom(c),
          ekmFor: (memberId) => ikmFor[memberId],
        });
        assert.equal(serializeEnvelope(envelope), JSON.stringify(c.envelope));
        assert.deepEqual(envelope, c.envelope);
      });

      it("the aad string matches", () => {
        assert.equal(c.envelope.from, sender.member_id);
        assert.equal(envelopeAad(c.hub_id, c.envelope.msg_id, c.envelope.from, c.envelope.kind, c.envelope.diagnostics, c.envelope.access), c.aad);
      });

      it("sk_e derives pk_e, and pk_e is the envelope enc", async () => {
        for (const [i, r] of c.recipients.entries()) {
          const derived = await deriveKeyPair(b64uDecode(r.ikm_e, { length: 32 }));
          assert.equal(b64uEncode(derived.privateKey), r.sk_e);
          assert.equal(b64uEncode(derived.publicKey), r.pk_e);
          assert.equal(b64uEncode(publicKeyOf(b64uDecode(r.sk_e, { length: 32 }))), r.pk_e);
          assert.equal(c.envelope.recipients[i].member_id, r.member_id);
          assert.equal(c.envelope.recipients[i].enc, r.pk_e);
          assert.equal(keyNameOf(r.member_id), r.key);
        }
      });
    });
  }
});
