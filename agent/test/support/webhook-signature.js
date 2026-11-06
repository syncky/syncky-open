import { hmacSha256 } from "../../src/crypto.js";
import { concatBytes, constantTimeEqual, toHex, utf8 } from "../../src/encoding.js";

export const MAX_SKEW_S = 300;
export const WEBHOOK_SIGNATURE_ERROR_CODES = Object.freeze(["bad_signature", "stale"]);

const SIGNATURE_RE = /^v1=[0-9a-f]{64}$/;
const TIMESTAMP_RE = /^[0-9]{1,15}$/;

function bodyBytes(rawBody) {
  if (rawBody instanceof Uint8Array) return rawBody;
  if (typeof rawBody === "string") return utf8(rawBody);
  throw new TypeError("webhook body must be a Uint8Array or a string");
}

export function signWebhook(secret, timestamp, rawBody) {
  if (typeof secret !== "string" || secret === "") throw new TypeError("webhook secret must be a non-empty string");
  const message = concatBytes(utf8(`${timestamp}.`), bodyBytes(rawBody));
  return `v1=${toHex(hmacSha256(utf8(secret), message))}`;
}

export function verifyWebhook({ secret, timestampHeader, signatureHeader, rawBody, now = Math.floor(Date.now() / 1000) }) {
  if (typeof secret !== "string" || secret === "") return "bad_signature";
  if (typeof timestampHeader !== "string" || !TIMESTAMP_RE.test(timestampHeader)) return "bad_signature";
  if (typeof signatureHeader !== "string" || !SIGNATURE_RE.test(signatureHeader)) return "bad_signature";
  const expected = signWebhook(secret, timestampHeader, rawBody);
  if (!constantTimeEqual(expected, signatureHeader)) return "bad_signature";
  if (Math.abs(now - Number(timestampHeader)) > MAX_SKEW_S) return "stale";
  return "valid";
}
