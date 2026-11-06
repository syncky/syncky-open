import { sha256 } from "./crypto.js";
import { b64uDecode, toHex, utf8 } from "./encoding.js";

const LABEL = "syncky-fp-v1|";

export function fingerprint(agentPubB64u, devicePubB64u) {
  b64uDecode(agentPubB64u, { length: 32 });
  b64uDecode(devicePubB64u, { length: 32 });
  const digest = sha256(utf8(`${LABEL}${agentPubB64u}|${devicePubB64u}`));
  const groups = [];
  for (let i = 0; i < 8; i += 2) {
    groups.push(String(((digest[i] << 8) | digest[i + 1]) % 10000).padStart(4, "0"));
  }
  return { sha256Hex: toHex(digest), text: groups.join(" ") };
}

// The app shows the groups joined by " · "; accept that as typed or read out.
export function normalizeFingerprint(text) {
  const digits = String(text).replace(/[\s·]+/g, "");
  return /^[0-9]{16}$/.test(digits) ? digits : null;
}

export const confirmHint = (memberId) => `syncky-agent confirm ${memberId} <fingerprint from the phone>`;
