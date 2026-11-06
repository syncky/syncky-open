import { createPublicKey, verify } from 'node:crypto';

export const SKILL_PUBLIC_KEY = '';
export const MAX_PAYLOAD_BYTES = 131072;
export const MAX_ENVELOPE_BYTES = 262144;
export const SKILL_DOCUMENT_ERROR_CODES = ['skill_key_unset', 'skill_key_invalid', 'skill_signature_invalid', 'skill_document_invalid'];
const failure = code => Object.assign(new Error(code), { code });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fields = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const positive = value => Number.isSafeInteger(value) && value > 0;
const text = value => typeof value === 'string' && value.trim().length > 0;

export function parseDocumentJSON(bytes, limit = MAX_PAYLOAD_BYTES) {
  try {
    if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > limit) throw new Error();
    const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    const value = JSON.parse(source), stack = [];
    let previous;
    for (const token of source.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]:,]|[^\s{}\[\]:,]+/g)) {
      const part = token[0];
      if (part === '{' || part === '[') {
        stack.push(part === '{' ? new Set() : null);
        if (stack.length > 20) throw new Error();
      } else if (part === '}' || part === ']') stack.pop();
      else if (part === ':') {
        const key = JSON.parse(previous), keys = stack.at(-1);
        if (!keys || keys.has(key)) throw new Error();
        keys.add(key);
      }
      previous = part;
    }
    return value;
  } catch { throw failure('skill_document_invalid'); }
}

export function validateSkillPayload(bytes) {
  try {
    const doc = parseDocumentJSON(bytes);
    if (!fields(doc, ['schema', 'skill_version', 'protocol', 'whats_new', 'skill', 'messages', 'schemas']) || doc.schema !== 1
      || !positive(doc.skill_version) || !fields(doc.protocol, ['protocol_version', 'message_table_schema'])
      || !positive(doc.protocol.protocol_version) || !positive(doc.protocol.message_table_schema)
      || !text(doc.whats_new) || doc.whats_new.length > 4096 || !text(doc.skill) || !text(doc.messages)
      || !object(doc.schemas) || Object.keys(doc.schemas).length < 1 || Object.keys(doc.schemas).length > 32) throw new Error();
    const table = parseDocumentJSON(Buffer.from(doc.messages));
    if (!object(table) || table.protocol_version !== doc.protocol.protocol_version || table.schema_version !== doc.protocol.message_table_schema) throw new Error();
    for (const [name, source] of Object.entries(doc.schemas)) {
      if (!/^inner-[a-z][a-z0-9-]{0,63}\.schema\.json$/.test(name) || !text(source) || !object(parseDocumentJSON(Buffer.from(source)))) throw new Error();
    }
    return doc;
  } catch { throw failure('skill_document_invalid'); }
}

function decodeBase64(value, length) {
  if (typeof value !== 'string' || !value.length) throw new Error();
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || (length !== undefined && bytes.length !== length)) throw new Error();
  return bytes;
}

function trust(pin) {
  const requireKey = () => {
    if (!pin) throw failure('skill_key_unset');
    try {
      const raw = decodeBase64(pin, 32);
      return createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' });
    } catch { throw failure('skill_key_invalid'); }
  };
  return Object.freeze({
    requireKey,
    verifyEnvelope(bytes) {
      const key = requireKey();
      let payloadBytes;
      try {
        const envelope = parseDocumentJSON(bytes, MAX_ENVELOPE_BYTES);
        if (!fields(envelope, ['payload', 'signature'])) throw new Error();
        payloadBytes = decodeBase64(envelope.payload);
        const signature = decodeBase64(envelope.signature, 64);
        if (!payloadBytes.length || payloadBytes.length > MAX_PAYLOAD_BYTES || !verify(null, payloadBytes, key, signature)) throw new Error();
      } catch { throw failure('skill_signature_invalid'); }
      return { payloadBytes, document: validateSkillPayload(payloadBytes) };
    },
  });
}

export const productionSkillTrust = trust(SKILL_PUBLIC_KEY);
export const skillTrustForTests = pin => trust(pin);
