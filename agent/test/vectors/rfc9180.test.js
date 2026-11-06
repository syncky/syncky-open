import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createAuthRecipientContext,
  createAuthSenderContext,
  deriveKeyPair,
  hpkeOpenAuth,
  hpkeSealAuth,
  publicKeyOf,
} from "../../src/crypto.js";
import { toHex } from "../../src/encoding.js";
import { loadVectors } from "../../src/protocol-files.js";

const v = loadVectors("rfc9180-auth-x25519-sha256-chacha20poly1305");
const hex = (s) => new Uint8Array(Buffer.from(s, "hex"));
const encryptions = v.encryptions.slice(0, 3);

describe("RFC 9180 A.2.3 (Auth, X25519, HKDF-SHA256, ChaCha20-Poly1305)", () => {
  it("pins the suite and mode", () => {
    assert.deepEqual([v.mode, v.kem_id, v.kdf_id, v.aead_id], [2, 32, 1, 3]);
    assert.equal(encryptions.length, 3);
  });

  it("single-shot seal with ekm = ikmE reproduces enc and the sequence-0 ct", async () => {
    const { enc, ciphertext } = await hpkeSealAuth({
      recipientPublicKey: hex(v.pkRm),
      senderPrivateKey: hex(v.skSm),
      info: hex(v.info),
      aad: hex(encryptions[0].aad),
      plaintext: hex(encryptions[0].pt),
      ekm: hex(v.ikmE),
    });
    assert.equal(toHex(enc), v.enc);
    assert.equal(toHex(ciphertext), encryptions[0].ct);
  });

  it("one sender context reproduces the ct of sequences 0, 1 and 2", async () => {
    const ctx = await createAuthSenderContext({
      recipientPublicKey: hex(v.pkRm),
      senderPrivateKey: hex(v.skSm),
      info: hex(v.info),
      ekm: hex(v.ikmE),
    });
    assert.equal(toHex(ctx.enc), v.enc);
    for (const e of encryptions) {
      assert.equal(toHex(await ctx.seal(hex(e.pt), hex(e.aad))), e.ct);
    }
  });

  it("single-shot open reproduces the sequence-0 pt", async () => {
    const pt = await hpkeOpenAuth({
      enc: hex(v.enc),
      recipientPrivateKey: hex(v.skRm),
      senderPublicKey: hex(v.pkSm),
      info: hex(v.info),
      aad: hex(encryptions[0].aad),
      ciphertext: hex(encryptions[0].ct),
    });
    assert.equal(toHex(pt), encryptions[0].pt);
  });

  it("one recipient context opens sequences 0, 1 and 2", async () => {
    const ctx = await createAuthRecipientContext({
      enc: hex(v.enc),
      recipientPrivateKey: hex(v.skRm),
      senderPublicKey: hex(v.pkSm),
      info: hex(v.info),
    });
    for (const e of encryptions) {
      assert.equal(toHex(await ctx.open(hex(e.ct), hex(e.aad))), e.pt);
    }
  });

  it("deriveKeyPair(ikmE) serializes to the unclamped skEm and pkEm", async () => {
    const { privateKey, publicKey } = await deriveKeyPair(hex(v.ikmE));
    assert.equal(toHex(privateKey), v.skEm);
    assert.equal(toHex(publicKey), v.pkEm);
  });

  it("deriveKeyPair reproduces the static sender and recipient keys", async () => {
    assert.equal(toHex((await deriveKeyPair(hex(v.ikmS))).privateKey), v.skSm);
    assert.equal(toHex((await deriveKeyPair(hex(v.ikmR))).privateKey), v.skRm);
  });

  it("publicKeyOf maps every RFC private key to its public key", () => {
    assert.equal(toHex(publicKeyOf(hex(v.skSm))), v.pkSm);
    assert.equal(toHex(publicKeyOf(hex(v.skRm))), v.pkRm);
    assert.equal(toHex(publicKeyOf(hex(v.skEm))), v.pkEm);
  });
});
