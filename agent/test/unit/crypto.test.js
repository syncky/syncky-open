import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  CryptoError,
  aeadOpen,
  aeadSeal,
  createAuthRecipientContext,
  createAuthSenderContext,
  generateKeyPair,
  hmacSha256,
  hpkeOpenAuth,
  hpkeSealAuth,
  publicKeyOf,
  randomBytes,
  sha256,
} from "../../src/crypto.js";
import { b64uDecode, b64uEncode, toHex, utf8 } from "../../src/encoding.js";
import { loadVectors } from "../../src/protocol-files.js";

const keys = loadVectors("keys");
const INFO = utf8("syncky-cek-v1");
const AAD = utf8("syncky-v1|hub_AAAAAAAAAAAAAAAAAAAAAA|0190f0d8-0000-7000-8000-000000000000|m_dev_1");

const flip = (bytes, index = 0) => {
  const out = new Uint8Array(bytes);
  out[index] ^= 0x01;
  return out;
};

async function rejectsWith(promise, code, secrets = []) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof CryptoError, `expected CryptoError, got ${err?.constructor?.name}: ${err?.message}`);
    assert.equal(err.code, code);
    for (const s of secrets) {
      if (s.length === 0) continue;
      assert.ok(!err.message.includes(toHex(s)), "message leaks hex input");
      assert.ok(!err.message.includes(b64uEncode(s)), "message leaks base64url input");
    }
    return true;
  });
}

function throwsWith(fn, code) {
  assert.throws(fn, (err) => err instanceof CryptoError && err.code === code);
}

async function fixture() {
  const sender = await generateKeyPair();
  const recipient = await generateKeyPair();
  const cek = randomBytes(32);
  const { enc, ciphertext } = await hpkeSealAuth({
    recipientPublicKey: recipient.publicKey,
    senderPrivateKey: sender.privateKey,
    info: INFO,
    aad: AAD,
    plaintext: cek,
  });
  const openArgs = {
    enc,
    recipientPrivateKey: recipient.privateKey,
    senderPublicKey: sender.publicKey,
    info: INFO,
    aad: AAD,
    ciphertext,
  };
  return { sender, recipient, cek, enc, ciphertext, openArgs };
}

describe("keys", () => {
  it("publicKeyOf maps every keys.json sk to its pk", () => {
    for (const [name, k] of Object.entries(keys)) {
      assert.equal(b64uEncode(publicKeyOf(b64uDecode(k.sk, { length: 32 }))), k.pk, name);
    }
  });

  it("generateKeyPair returns raw 32-byte Uint8Arrays whose public half matches publicKeyOf", async () => {
    const a = await generateKeyPair();
    const b = await generateKeyPair();
    for (const key of [a.privateKey, a.publicKey]) {
      assert.equal(Object.getPrototypeOf(key), Uint8Array.prototype);
      assert.equal(key.length, 32);
    }
    assert.deepEqual(publicKeyOf(a.privateKey), a.publicKey);
    assert.notDeepEqual(a.privateKey, b.privateKey);
  });

  it("publicKeyOf rejects wrong lengths and non-bytes as malformed", () => {
    throwsWith(() => publicKeyOf(new Uint8Array(31)), "malformed");
    throwsWith(() => publicKeyOf(new Uint8Array(33)), "malformed");
    throwsWith(() => publicKeyOf("x".repeat(32)), "malformed");
  });
});

describe("hashes and randomness", () => {
  it("sha256 matches the FIPS 180-2 'abc' digest", () => {
    const d = sha256(utf8("abc"));
    assert.equal(Object.getPrototypeOf(d), Uint8Array.prototype);
    assert.equal(toHex(d), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("hmacSha256 matches RFC 4231 test case 2", () => {
    const mac = hmacSha256(utf8("Jefe"), utf8("what do ya want for nothing?"));
    assert.equal(Object.getPrototypeOf(mac), Uint8Array.prototype);
    assert.equal(toHex(mac), "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
  });

  it("hash inputs must be bytes", () => {
    throwsWith(() => sha256("abc"), "malformed");
    throwsWith(() => hmacSha256("k", utf8("m")), "malformed");
  });

  it("randomBytes uses the injected RandomSource deterministically", () => {
    const calls = [];
    const source = (n) => {
      calls.push(n);
      return Uint8Array.from({ length: n }, (_, i) => (i * 7) & 0xff);
    };
    const a = randomBytes(12, source);
    const b = randomBytes(12, source);
    assert.deepEqual(a, b);
    assert.deepEqual(calls, [12, 12]);
    assert.equal(toHex(a), "00070e151c232a31383f464d");
  });

  it("randomBytes defaults to the platform source and returns distinct fresh bytes", () => {
    const a = randomBytes(32);
    assert.equal(a.length, 32);
    assert.notDeepEqual(a, randomBytes(32));
    assert.equal(randomBytes(0).length, 0);
  });

  it("randomBytes rejects bad lengths and a misbehaving source", () => {
    assert.throws(() => randomBytes(-1), RangeError);
    assert.throws(() => randomBytes(1.5), RangeError);
    assert.throws(() => randomBytes(4, () => new Uint8Array(3)), RangeError);
    assert.throws(() => randomBytes(4, () => [0, 0, 0, 0]), RangeError);
  });
});

describe("HPKE Auth seal/open", () => {
  it("round trips with fresh keys; enc is 32 bytes and the wrap 48", async () => {
    const { cek, enc, ciphertext, openArgs } = await fixture();
    assert.equal(enc.length, 32);
    assert.equal(ciphertext.length, 48);
    assert.equal(Object.getPrototypeOf(enc), Uint8Array.prototype);
    assert.deepEqual(await hpkeOpenAuth(openArgs), cek);
  });

  it("fresh seals of the same CEK differ (random ephemeral)", async () => {
    const { sender, recipient, cek, enc } = await fixture();
    const again = await hpkeSealAuth({
      recipientPublicKey: recipient.publicKey,
      senderPrivateKey: sender.privateKey,
      info: INFO,
      aad: AAD,
      plaintext: cek,
    });
    assert.notDeepEqual(again.enc, enc);
  });

  it("opening with the wrong sender key fails as hpke_open_failed", async () => {
    const { openArgs } = await fixture();
    const mallory = await generateKeyPair();
    await rejectsWith(hpkeOpenAuth({ ...openArgs, senderPublicKey: mallory.publicKey }), "hpke_open_failed", [
      openArgs.recipientPrivateKey,
      mallory.publicKey,
    ]);
  });

  it("opening with the wrong recipient key fails as hpke_open_failed", async () => {
    const { openArgs } = await fixture();
    const other = await generateKeyPair();
    await rejectsWith(hpkeOpenAuth({ ...openArgs, recipientPrivateKey: other.privateKey }), "hpke_open_failed", [
      other.privateKey,
    ]);
  });

  it("a flipped wrap byte, wrong AAD, wrong info or a flipped enc fails as hpke_open_failed", async () => {
    const { openArgs } = await fixture();
    const secrets = [openArgs.recipientPrivateKey, openArgs.enc, openArgs.ciphertext];
    await rejectsWith(hpkeOpenAuth({ ...openArgs, ciphertext: flip(openArgs.ciphertext, 0) }), "hpke_open_failed", secrets);
    await rejectsWith(hpkeOpenAuth({ ...openArgs, ciphertext: flip(openArgs.ciphertext, 47) }), "hpke_open_failed", secrets);
    await rejectsWith(hpkeOpenAuth({ ...openArgs, aad: flip(AAD, 3) }), "hpke_open_failed", secrets);
    await rejectsWith(hpkeOpenAuth({ ...openArgs, info: utf8("syncky-cek-v2") }), "hpke_open_failed", secrets);
    await rejectsWith(hpkeOpenAuth({ ...openArgs, enc: flip(openArgs.enc, 5) }), "hpke_open_failed", secrets);
  });

  it("a degenerate all-zero enc fails as hpke_open_failed, not a raw library error", async () => {
    const { openArgs } = await fixture();
    await rejectsWith(hpkeOpenAuth({ ...openArgs, enc: new Uint8Array(32) }), "hpke_open_failed");
  });

  it("a truncated wrap fails as hpke_open_failed", async () => {
    const { openArgs } = await fixture();
    await rejectsWith(hpkeOpenAuth({ ...openArgs, ciphertext: openArgs.ciphertext.slice(0, 10) }), "hpke_open_failed");
  });

  it("31/33-byte keys or enc fail as malformed", async () => {
    const { sender, recipient, cek, openArgs } = await fixture();
    for (const len of [31, 33]) {
      const bad = randomBytes(len);
      await rejectsWith(hpkeOpenAuth({ ...openArgs, enc: bad }), "malformed", [bad]);
      await rejectsWith(hpkeOpenAuth({ ...openArgs, recipientPrivateKey: bad }), "malformed", [bad]);
      await rejectsWith(hpkeOpenAuth({ ...openArgs, senderPublicKey: bad }), "malformed", [bad]);
      const sealArgs = {
        recipientPublicKey: recipient.publicKey,
        senderPrivateKey: sender.privateKey,
        info: INFO,
        aad: AAD,
        plaintext: cek,
      };
      await rejectsWith(hpkeSealAuth({ ...sealArgs, recipientPublicKey: bad }), "malformed", [bad]);
      await rejectsWith(hpkeSealAuth({ ...sealArgs, senderPrivateKey: bad }), "malformed", [bad]);
    }
  });

  it("non-byte inputs fail as malformed", async () => {
    const { sender, recipient, cek, openArgs } = await fixture();
    const sealArgs = {
      recipientPublicKey: recipient.publicKey,
      senderPrivateKey: sender.privateKey,
      info: INFO,
      aad: AAD,
      plaintext: cek,
    };
    await rejectsWith(hpkeSealAuth({ ...sealArgs, info: "syncky-cek-v1" }), "malformed");
    await rejectsWith(hpkeSealAuth({ ...sealArgs, aad: "aad" }), "malformed");
    await rejectsWith(hpkeSealAuth({ ...sealArgs, plaintext: [1, 2, 3] }), "malformed");
    await rejectsWith(hpkeSealAuth({ ...sealArgs, ekm: "seed" }), "malformed");
    await rejectsWith(hpkeOpenAuth({ ...openArgs, ciphertext: undefined }), "malformed");
    await rejectsWith(hpkeOpenAuth({ ...openArgs, aad: null }), "malformed");
    await rejectsWith(hpkeOpenAuth({ ...openArgs, info: undefined }), "malformed");
  });

  it("a low-order recipient public key fails to seal as malformed", async () => {
    const { sender, cek } = await fixture();
    await rejectsWith(
      hpkeSealAuth({
        recipientPublicKey: new Uint8Array(32),
        senderPrivateKey: sender.privateKey,
        info: INFO,
        aad: AAD,
        plaintext: cek,
      }),
      "malformed",
    );
  });

  it("an explicit ekm makes the seal deterministic", async () => {
    const { sender, recipient, cek } = await fixture();
    const ekm = randomBytes(32);
    const args = {
      recipientPublicKey: recipient.publicKey,
      senderPrivateKey: sender.privateKey,
      info: INFO,
      aad: AAD,
      plaintext: cek,
      ekm,
    };
    const a = await hpkeSealAuth(args);
    const b = await hpkeSealAuth(args);
    assert.deepEqual(a, b);
  });

  it("contexts expose the same operations as the single-shot helpers", async () => {
    const { sender, recipient, cek } = await fixture();
    const send = await createAuthSenderContext({
      recipientPublicKey: recipient.publicKey,
      senderPrivateKey: sender.privateKey,
      info: INFO,
    });
    const wrapped = await send.seal(cek, AAD);
    const recv = await createAuthRecipientContext({
      enc: send.enc,
      recipientPrivateKey: recipient.privateKey,
      senderPublicKey: sender.publicKey,
      info: INFO,
    });
    assert.deepEqual(await recv.open(wrapped, AAD), cek);
    await rejectsWith(recv.open(wrapped, AAD), "hpke_open_failed");
    await rejectsWith(send.seal("x", AAD), "malformed");
  });
});

describe("payload AEAD", () => {
  const key = randomBytes(32);
  const nonce = randomBytes(12);
  const plaintext = utf8('{"v":1,"type":"sync","samples":[{"value":73.123456}]}');

  it("seal returns ct || tag and open round trips", async () => {
    const sealed = await aeadSeal(key, nonce, AAD, plaintext);
    assert.equal(Object.getPrototypeOf(sealed), Uint8Array.prototype);
    assert.equal(sealed.length, plaintext.length + 16);
    assert.deepEqual(await aeadOpen(key, nonce, AAD, sealed), plaintext);
  });

  it("empty plaintext seals to a bare tag and opens", async () => {
    const sealed = await aeadSeal(key, nonce, new Uint8Array(0), new Uint8Array(0));
    assert.equal(sealed.length, 16);
    assert.deepEqual(await aeadOpen(key, nonce, new Uint8Array(0), sealed), new Uint8Array(0));
  });

  it("a flipped tag or ciphertext byte, wrong nonce, wrong AAD or wrong key fails as aead_failed", async () => {
    const sealed = await aeadSeal(key, nonce, AAD, plaintext);
    const secrets = [key, nonce, sealed];
    await rejectsWith(aeadOpen(key, nonce, AAD, flip(sealed, 0)), "aead_failed", secrets);
    await rejectsWith(aeadOpen(key, nonce, AAD, flip(sealed, sealed.length - 1)), "aead_failed", secrets);
    await rejectsWith(aeadOpen(key, flip(nonce, 11), AAD, sealed), "aead_failed", secrets);
    await rejectsWith(aeadOpen(key, nonce, flip(AAD, 0), sealed), "aead_failed", secrets);
    await rejectsWith(aeadOpen(flip(key, 31), nonce, AAD, sealed), "aead_failed", secrets);
  });

  it("wrong key or nonce lengths, a ciphertext shorter than the tag and non-bytes fail as malformed", async () => {
    const sealed = await aeadSeal(key, nonce, AAD, plaintext);
    for (const badKey of [randomBytes(31), randomBytes(33), randomBytes(16)]) {
      await rejectsWith(aeadSeal(badKey, nonce, AAD, plaintext), "malformed", [badKey]);
      await rejectsWith(aeadOpen(badKey, nonce, AAD, sealed), "malformed", [badKey]);
    }
    for (const badNonce of [randomBytes(11), randomBytes(13), randomBytes(24)]) {
      await rejectsWith(aeadSeal(key, badNonce, AAD, plaintext), "malformed", [badNonce]);
      await rejectsWith(aeadOpen(key, badNonce, AAD, sealed), "malformed", [badNonce]);
    }
    await rejectsWith(aeadOpen(key, nonce, AAD, sealed.slice(0, 15)), "malformed");
    await rejectsWith(aeadSeal(key, nonce, AAD, "text"), "malformed");
    await rejectsWith(aeadSeal(key, nonce, "aad", plaintext), "malformed");
    await rejectsWith(aeadOpen(key, nonce, AAD, "ct"), "malformed");
  });

  it("CryptoError messages never contain key material", async () => {
    const sealed = await aeadSeal(key, nonce, AAD, plaintext);
    const secrets = [key, key.slice(0, 31), nonce, sealed, plaintext];
    await rejectsWith(aeadOpen(key, nonce, AAD, flip(sealed, 2)), "aead_failed", secrets);
    await rejectsWith(aeadOpen(key.slice(0, 31), nonce, AAD, sealed), "malformed", secrets);
    await rejectsWith(aeadOpen(key, nonce.slice(0, 11), AAD, sealed), "malformed", secrets);
  });
});
