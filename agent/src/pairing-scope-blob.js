import { aeadOpen, aeadSeal, hkdfSha256, NONCE_LENGTH, randomBytes, TAG_LENGTH } from './crypto.js';
import { b64uDecode, b64uEncode, concatBytes, utf8, utf8Decode } from './encoding.js';
import { isHubId } from './ids.js';
import { validateAccessScope } from './access-scope.js';
import { LocalStateError } from './config.js';

export const MAX_PAIRING_SCOPE_BLOB_BYTES = 12000;
export const MAX_PAIRING_SCOPE_BLOB_CHARS = 16000;
export const MAX_PAIRING_REQUEST_BODY_BYTES = 16384;
const domain = 'syncky-pairing-scope-v1';
const overhead = NONCE_LENGTH + TAG_LENGTH;
const invalid = () => new LocalStateError('pairing_scope_invalid', 'invalid encrypted pairing access request');

function parameters({ pairSecret, hubId, agentPublicKey }) {
  try {
    if (!isHubId(hubId)) throw invalid();
    b64uDecode(agentPublicKey, { length: 32 });
    const secret = b64uDecode(pairSecret, { length: 16 });
    try {
      return { key: hkdfSha256(secret, utf8(domain), utf8(`${domain}/key`)), aad: utf8(`${domain}|${hubId}|${agentPublicKey}`) };
    } finally { secret.fill(0); }
  } catch { throw invalid(); }
}

export async function sealPairingScope(scope, binding, { random } = {}) {
  const checked = validateAccessScope(scope, { normalize: true });
  if (!checked.ok) throw invalid();
  const plaintext = utf8(JSON.stringify(checked.value));
  if (plaintext.length + overhead > MAX_PAIRING_SCOPE_BLOB_BYTES) {
    plaintext.fill(0);
    throw new LocalStateError('pairing_scope_invalid', 'encrypted pairing access request exceeds its size limit', { detail: 'too_large' });
  }
  let key;
  try {
    const params = parameters(binding);
    key = params.key;
    const nonce = randomBytes(NONCE_LENGTH, random);
    return b64uEncode(concatBytes(nonce, await aeadSeal(key, nonce, params.aad, plaintext)));
  } finally { key?.fill(0); plaintext.fill(0); }
}

export async function openPairingScope(blob, binding) {
  let bytes;
  try {
    if (typeof blob !== 'string' || blob.length > MAX_PAIRING_SCOPE_BLOB_CHARS) throw invalid();
    bytes = b64uDecode(blob);
    if (bytes.length <= overhead || bytes.length > MAX_PAIRING_SCOPE_BLOB_BYTES) throw invalid();
  } catch { throw invalid(); }
  const { key, aad } = parameters(binding);
  let plaintext;
  try { plaintext = await aeadOpen(key, bytes.subarray(0, NONCE_LENGTH), aad, bytes.subarray(NONCE_LENGTH)); }
  catch { throw new LocalStateError('pairing_scope_auth_failed', 'encrypted pairing access request authentication failed'); }
  finally { key.fill(0); }
  try {
    const text = utf8Decode(plaintext), checked = validateAccessScope(JSON.parse(text));
    if (!checked.ok || JSON.stringify(checked.value) !== text) throw invalid();
    return checked.value;
  } catch { throw invalid(); }
  finally { plaintext.fill(0); }
}
