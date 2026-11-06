import { hmacSha256, sha256 } from "./crypto.js";
import { b64uDecode, b64uEncode, constantTimeEqual, isB64u, utf8 } from "./encoding.js";
import { PAIR_SECRET_BYTES } from "./pair-uri.js";
export const PAIR_PROOF_BYTES = 32;

const CODE_LABEL = "syncky-code-v2|";
const PROOF_LABEL = "syncky-pair-v2|";

export function pairCode(pairSecretB64u) {
  b64uDecode(pairSecretB64u, { length: PAIR_SECRET_BYTES });
  const d = sha256(utf8(`${CODE_LABEL}${pairSecretB64u}`));
  const groups = [];
  for (let i = 0; i < 6; i += 2) groups.push(String(((d[i] << 8) | d[i + 1]) % 1000).padStart(3, "0"));
  return groups.join(" ");
}

export function pairProof(pairSecretB64u, agentPubB64u, devicePubB64u) {
  const key = b64uDecode(pairSecretB64u, { length: PAIR_SECRET_BYTES });
  b64uDecode(agentPubB64u, { length: 32 });
  b64uDecode(devicePubB64u, { length: 32 });
  return b64uEncode(hmacSha256(key, utf8(`${PROOF_LABEL}${agentPubB64u}|${devicePubB64u}`)));
}

export function pairProofMatches(expectedB64u, receivedB64u) {
  if (!isB64u(expectedB64u, { length: PAIR_PROOF_BYTES }) || !isB64u(receivedB64u, { length: PAIR_PROOF_BYTES })) return false;
  return constantTimeEqual(b64uDecode(expectedB64u), b64uDecode(receivedB64u));
}
