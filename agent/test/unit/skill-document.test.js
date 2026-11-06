import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { MAX_ENVELOPE_BYTES, MAX_PAYLOAD_BYTES, SKILL_PUBLIC_KEY, parseDocumentJSON, productionSkillTrust, skillTrustForTests, validateSkillPayload } from '../../src/skill-document.js';

const encode = v => Buffer.from(JSON.stringify(v));
const payload = () => ({ schema: 1, skill_version: 1, protocol: { protocol_version: 1, message_table_schema: 1 }, whats_new: 'Initial skill', skill: '# Skill\n', messages: '{"schema_version":1,"protocol_version":1}', schemas: { 'inner-example.schema.json': '{"type":"object"}' } });
function fixture() {
  const pair = generateKeyPairSync('ed25519'), pin = Buffer.from(pair.publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64');
  const envelope = bytes => encode({ payload: bytes.toString('base64'), signature: sign(null, bytes, pair.privateKey).toString('base64') });
  return { pin, envelope, trust: skillTrustForTests(pin) };
}
const rejects = (fn, code) => assert.throws(fn, e => e.code === code && e.message === code && e.cause === undefined);

test('production pin is empty and unsigned package format is never external trust', () => {
  assert.equal(SKILL_PUBLIC_KEY, '');
  const bytes = readFileSync(new URL('../../skills/syncky/bootstrap.json', import.meta.url));
  rejects(() => productionSkillTrust.requireKey(), 'skill_key_unset');
  rejects(() => productionSkillTrust.verifyEnvelope(bytes), 'skill_key_unset');
  rejects(() => fixture().trust.verifyEnvelope(bytes), 'skill_signature_invalid');
  rejects(() => skillTrustForTests('CANARY').requireKey(), 'skill_key_invalid');
});

test('verifier authenticates exact decoded bytes before parsing the document', () => {
  const f = fixture(), bytes = Buffer.from(` \r\n${JSON.stringify(payload(), null, 3)}\n`), feed = f.envelope(bytes);
  const result = f.trust.verifyEnvelope(feed);
  assert.ok(result.payloadBytes.equals(bytes)); assert.deepEqual(result.document, payload());
  rejects(() => fixture().trust.verifyEnvelope(feed), 'skill_signature_invalid');
  const tampered = JSON.parse(feed); tampered.payload = Buffer.concat([bytes, Buffer.from(' ')]).toString('base64');
  rejects(() => f.trust.verifyEnvelope(encode(tampered)), 'skill_signature_invalid');
  const doc = payload(); doc.whats_new = 'Different authoritative changes';
  tampered.payload = encode(doc).toString('base64');
  rejects(() => f.trust.verifyEnvelope(encode(tampered)), 'skill_signature_invalid');
  rejects(() => f.trust.verifyEnvelope(f.envelope(Buffer.from('{"CANARY":'))), 'skill_document_invalid');
});

test('envelope bounds, UTF-8, canonical base64, fields and duplicates are strict', () => {
  const f = fixture(), feed = f.envelope(encode(payload())), env = JSON.parse(feed);
  const invalid = [Buffer.alloc(0), Buffer.alloc(MAX_ENVELOPE_BYTES + 1), Buffer.from([0xff]), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), feed]), encode([]), encode(null), encode({ ...env, extra: true }),
    Buffer.from(`{"payload":"${env.payload}","payload":"${env.payload}","signature":"${env.signature}"}`),
    Buffer.from(`{"payl\\u006fad":"${env.payload}","payload":"${env.payload}","signature":"${env.signature}"}`)];
  for (const field of ['payload', 'signature']) for (const bad of ['', null, 42, {}, env[field].replace(/=+$/, ''), `${env[field]}\n`, env[field].replace(/.$/, '!')]) invalid.push(encode({ ...env, [field]: bad }));
  invalid.push(encode({ ...env, signature: Buffer.alloc(63).toString('base64') }));
  invalid.push(f.envelope(Buffer.alloc(MAX_PAYLOAD_BYTES + 1, 32)));
  for (const bytes of invalid) rejects(() => f.trust.verifyEnvelope(bytes), 'skill_signature_invalid');
  const padded = Buffer.concat([feed, Buffer.alloc(MAX_ENVELOPE_BYTES - feed.length, 32)]);
  assert.equal(f.trust.verifyEnvelope(padded).document.skill_version, 1);
});

test('payload shape, nested duplicate fields, bounds and compatibility declarations are checked', () => {
  const bad = [null, [], { ...payload(), extra: true }];
  for (const skill_version of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1']) bad.push({ ...payload(), skill_version });
  for (const skill of ['', null]) bad.push({ ...payload(), skill });
  for (const protocol of [{}, { protocol_version: 0, message_table_schema: 1 }, { protocol_version: 2, message_table_schema: 1 }]) bad.push({ ...payload(), protocol });
  for (const messages of ['[]', '{}', '{"schema_version":1,"schema_version":1,"protocol_version":1}']) bad.push({ ...payload(), messages });
  for (const schemas of [{}, { '../inner-bad.schema.json': '{}' }, { 'inner-bad.schema.json': 'null' }, { 'inner-bad.schema.json': '{"type":"object","type":"object"}' }]) bad.push({ ...payload(), schemas });
  for (const doc of bad) rejects(() => validateSkillPayload(encode(doc)), 'skill_document_invalid');
  rejects(() => validateSkillPayload(Buffer.alloc(MAX_PAYLOAD_BYTES + 1)), 'skill_document_invalid');
  rejects(() => parseDocumentJSON(Buffer.from('{"a":{"x":1,"x":2}}')), 'skill_document_invalid');
  rejects(() => parseDocumentJSON(Buffer.from('['.repeat(21) + '0' + ']'.repeat(21))), 'skill_document_invalid');
  const bytes = encode(payload()), padded = Buffer.concat([bytes, Buffer.alloc(MAX_PAYLOAD_BYTES - bytes.length, 32)]);
  assert.equal(validateSkillPayload(padded).skill_version, 1);
});
