import { createHash, createHmac, createPrivateKey, createPublicKey, getRandomValues } from "node:crypto";
import { CipherSuite, DeserializeError, HkdfSha256 } from "@hpke/core";
import { DhkemX25519HkdfSha256 } from "@hpke/dhkem-x25519";
import { Chacha20Poly1305 } from "@hpke/chacha20poly1305";

export const KEY_LENGTH = 32;
export const ENC_LENGTH = 32;
export const NONCE_LENGTH = 12;
export const TAG_LENGTH = 16;
export const WRAPPED_KEY_LENGTH = KEY_LENGTH + TAG_LENGTH;

export class CryptoError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CryptoError";
    this.code = code;
  }
}

export const suite = new CipherSuite({
  kem: new DhkemX25519HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Chacha20Poly1305(),
});

const X25519_PKCS8_PREFIX = Uint8Array.from(Buffer.from("302e020100300506032b656e04220420", "hex"));

const defaultRandom = (n) => getRandomValues(new Uint8Array(n));

const bytes = (data) => new Uint8Array(data);

function requireBytes(value, what, length) {
  if (!(value instanceof Uint8Array)) throw new CryptoError("malformed", `${what}: expected bytes`);
  if (length !== undefined && value.length !== length) {
    throw new CryptoError("malformed", `${what}: expected ${length} bytes, got ${value.length}`);
  }
  return value;
}

export function randomBytes(n, random = defaultRandom) {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError("randomBytes: invalid length");
  const out = random(n);
  if (!(out instanceof Uint8Array) || out.length !== n) throw new RangeError("randomBytes: source returned wrong length");
  return bytes(out);
}

export function sha256(data) {
  return bytes(createHash("sha256").update(requireBytes(data, "sha256 input")).digest());
}

export function hmacSha256(key, msg) {
  return bytes(createHmac("sha256", requireBytes(key, "hmac key")).update(requireBytes(msg, "hmac message")).digest());
}

export async function generateKeyPair() {
  const pair = await suite.kem.generateKeyPair();
  return serializeKeyPair(pair);
}

export async function deriveKeyPair(ikm) {
  requireBytes(ikm, "ikm");
  const pair = await suite.kem.deriveKeyPair(bytes(ikm).buffer);
  return serializeKeyPair(pair);
}

async function serializeKeyPair(pair) {
  return {
    privateKey: bytes(await suite.kem.serializePrivateKey(pair.privateKey)),
    publicKey: bytes(await suite.kem.serializePublicKey(pair.publicKey)),
  };
}

export function publicKeyOf(privateKey) {
  requireBytes(privateKey, "private key", KEY_LENGTH);
  const der = new Uint8Array(X25519_PKCS8_PREFIX.length + KEY_LENGTH);
  der.set(X25519_PKCS8_PREFIX);
  der.set(privateKey, X25519_PKCS8_PREFIX.length);
  const spki = createPublicKey(createPrivateKey({ key: Buffer.from(der), format: "der", type: "pkcs8" })).export({
    type: "spki",
    format: "der",
  });
  return bytes(spki.subarray(spki.length - KEY_LENGTH));
}

async function importPublicKey(raw, what) {
  requireBytes(raw, what, KEY_LENGTH);
  return suite.kem.deserializePublicKey(bytes(raw));
}

async function importPrivateKey(raw, what) {
  requireBytes(raw, what, KEY_LENGTH);
  return suite.kem.deserializePrivateKey(bytes(raw));
}

function hpkeFailure(err, what, fallbackCode) {
  if (err instanceof CryptoError) return err;
  if (err instanceof DeserializeError) return new CryptoError("malformed", `${what}: malformed key material`);
  return new CryptoError(fallbackCode, `${what}: failed`);
}

export async function createAuthSenderContext({ recipientPublicKey, senderPrivateKey, info, ekm }) {
  requireBytes(info, "hpke info");
  if (ekm !== undefined) requireBytes(ekm, "hpke ekm");
  let ctx;
  try {
    ctx = await suite.createSenderContext({
      recipientPublicKey: await importPublicKey(recipientPublicKey, "recipient public key"),
      senderKey: await importPrivateKey(senderPrivateKey, "sender private key"),
      info: bytes(info),
      ...(ekm === undefined ? {} : { ekm: bytes(ekm) }),
    });
  } catch (err) {
    throw hpkeFailure(err, "hpke seal", "malformed");
  }
  return {
    enc: bytes(ctx.enc),
    async seal(plaintext, aad) {
      requireBytes(plaintext, "hpke plaintext");
      requireBytes(aad, "hpke aad");
      try {
        return bytes(await ctx.seal(bytes(plaintext), bytes(aad)));
      } catch (err) {
        throw hpkeFailure(err, "hpke seal", "malformed");
      }
    },
  };
}

export async function createAuthRecipientContext({ enc, recipientPrivateKey, senderPublicKey, info }) {
  requireBytes(enc, "hpke enc", ENC_LENGTH);
  requireBytes(info, "hpke info");
  let ctx;
  try {
    ctx = await suite.createRecipientContext({
      recipientKey: await importPrivateKey(recipientPrivateKey, "recipient private key"),
      enc: bytes(enc),
      info: bytes(info),
      senderPublicKey: await importPublicKey(senderPublicKey, "sender public key"),
    });
  } catch (err) {
    throw hpkeFailure(err, "hpke open", "hpke_open_failed");
  }
  return {
    async open(ciphertext, aad) {
      requireBytes(ciphertext, "hpke ciphertext");
      requireBytes(aad, "hpke aad");
      try {
        return bytes(await ctx.open(bytes(ciphertext), bytes(aad)));
      } catch (err) {
        throw hpkeFailure(err, "hpke open", "hpke_open_failed");
      }
    },
  };
}

export async function hpkeSealAuth({ recipientPublicKey, senderPrivateKey, info, aad, plaintext, ekm }) {
  const ctx = await createAuthSenderContext({ recipientPublicKey, senderPrivateKey, info, ekm });
  return { enc: ctx.enc, ciphertext: await ctx.seal(plaintext, aad) };
}

export async function hpkeOpenAuth({ enc, recipientPrivateKey, senderPublicKey, info, aad, ciphertext }) {
  const ctx = await createAuthRecipientContext({ enc, recipientPrivateKey, senderPublicKey, info });
  return ctx.open(ciphertext, aad);
}

function aeadContext(key, nonce, aad) {
  requireBytes(key, "aead key", KEY_LENGTH);
  requireBytes(nonce, "aead nonce", NONCE_LENGTH);
  requireBytes(aad, "aead aad");
  return new Chacha20Poly1305().createEncryptionContext(bytes(key).buffer);
}

export async function aeadSeal(key, nonce, aad, plaintext) {
  const ctx = aeadContext(key, nonce, aad);
  requireBytes(plaintext, "aead plaintext");
  return bytes(await ctx.seal(bytes(nonce).buffer, bytes(plaintext).buffer, bytes(aad).buffer));
}

export async function aeadOpen(key, nonce, aad, ctAndTag) {
  const ctx = aeadContext(key, nonce, aad);
  requireBytes(ctAndTag, "aead ciphertext");
  if (ctAndTag.length < TAG_LENGTH) throw new CryptoError("malformed", "aead ciphertext: shorter than the tag");
  try {
    return bytes(await ctx.open(bytes(nonce).buffer, bytes(ctAndTag).buffer, bytes(aad).buffer));
  } catch {
    throw new CryptoError("aead_failed", "aead open: failed");
  }
}
