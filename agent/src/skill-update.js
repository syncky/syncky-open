import fs from 'node:fs';
import { join } from 'node:path';
import Ajv from 'ajv/dist/2020.js';
import { bootstrapBase64 } from './embedded-skill.js';
import { MAX_ENVELOPE_BYTES, parseDocumentJSON, productionSkillTrust, validateSkillPayload } from './skill-document.js';
import { createThinTransport } from './thin-transport.js';
import { atomicPrivateWrite, privateStat, readPrivateFile, withHomeLock } from './protected-files.js';
import { retryHomeLock } from './thin-lock.js';

export const SKILL_UPDATE_ERROR_CODES = ['skill_url_invalid', 'skill_fetch_failed', 'skill_fetch_timeout', 'skill_response_invalid', 'skill_version_mismatch', 'skill_downgrade', 'skill_version_conflict', 'skill_state_invalid', 'skill_write_failed'];
const failure = code => Object.assign(new Error(code), { code });
const positive = n => Number.isSafeInteger(n) && n > 0;
const bootstrapBytes = bootstrapBase64 === null ? fs.readFileSync(new URL('../skills/syncky/bootstrap.json', import.meta.url)) : Buffer.from(bootstrapBase64, 'base64');
const bootstrapPayload = Buffer.from(parseDocumentJSON(bootstrapBytes, MAX_ENVELOPE_BYTES).payload, 'base64');
const MAX_STATE_BYTES = MAX_ENVELOPE_BYTES * 3;
const MAX_CACHE_BYTES = 8192;

function checkedURL(raw) {
  try {
    if (typeof raw !== 'string' || raw.length > 2048 || /[\s\\\p{Cc}\p{Cf}\p{Cs}]/u.test(raw)
      || !/^https:\/\/(?:syncky\.app|dev\.syncky\.app)(?::443)?(?:[/?]|$)/.test(raw)) throw new Error();
    const url = new URL(raw);
    if (url.protocol !== 'https:' || !['syncky.app', 'dev.syncky.app'].includes(url.hostname) || url.port || url.username || url.password || url.hash) throw new Error();
    return raw;
  } catch { throw failure('skill_url_invalid'); }
}

function capabilities(document) {
  try {
    if (document.protocol.protocol_version !== 1 || document.protocol.message_table_schema !== 1) throw new Error();
    createThinTransport({ table: parseDocumentJSON(Buffer.from(document.messages)) });
    const ajv = new Ajv({ strict: true, strictTypes: false, strictTuples: false, validateFormats: false, logger: false });
    const schemas = Object.values(document.schemas).map(source => parseDocumentJSON(Buffer.from(source)));
    schemas.forEach((schema, i) => ajv.addSchema(schema, `urn:syncky:skill:${i}`));
    function compile(node, root, pointer = '') {
      if (!node || typeof node !== 'object') return;
      for (const [vocabulary, required] of Object.entries(node.$vocabulary ?? {})) {
        if (required && !/^https:\/\/json-schema\.org\/draft\/2020-12\/vocab\/(?:core|applicator|validation|unevaluated|meta-data|format-annotation|content)$/.test(vocabulary)) throw new Error();
      }
      if (node.properties?.type?.const || /\/\$defs\/[^/]+$/.test(pointer)) ajv.compile({ $ref: `${root}#${pointer}` });
      for (const [key, child] of Object.entries(node)) compile(child, root, `${pointer}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`);
    }
    schemas.forEach((schema, i) => { const root = `urn:syncky:skill:${i}`; ajv.getSchema(root); compile(schema, root); });
  } catch { throw failure('protocol_incompatible'); }
}

const bootstrap = { payloadBytes: bootstrapPayload, document: validateSkillPayload(bootstrapPayload), envelopeBytes: bootstrapBytes };
capabilities(bootstrap.document);

export function createSkillUpdater({ home, trust = productionSkillTrust, fetch = globalThis.fetch, now = Date.now, timeoutMs = 15000, fs: io = fs, maxAttempts = 5 } = {}) {
  const options = { fs: io }, bundlePath = join(home, 'installed-bundle.json'), statusPath = join(home, 'skill-update.json');
  const mutate = fn => withHomeLock(home, fn, options);
  let pending, installedBytes, installedBundle;
  const bundled = () => ({ ...bootstrap, high_water: bootstrap.document.skill_version, previous: null });
  const emptyCache = () => ({ schema: 1, state: 'idle', attempts: 0, next_attempt_at: 0, hint: null, protocol_incompatible: null });
  function readFile(path, limit) {
    const stat = privateStat(path, { ...options, optional: true });
    if (!stat) return null;
    if (stat.size > limit) throw failure('skill_state_invalid');
    const bytes = readPrivateFile(path, options);
    if (bytes.length > limit) throw failure('skill_state_invalid');
    return bytes;
  }
  function verified(bytes) {
    if (bytes.equals(bootstrapBytes)) return bootstrap;
    const result = trust.verifyEnvelope(bytes);
    capabilities(result.document);
    return { ...result, envelopeBytes: bytes };
  }
  function installed() {
    try {
      const bytes = readFile(bundlePath, MAX_STATE_BYTES);
      if (!bytes) return bundled();
      if (installedBytes?.equals(bytes)) return installedBundle;
      const state = parseDocumentJSON(bytes, MAX_STATE_BYTES);
      if (state.schema !== 1 || !positive(state.high_water) || typeof state.active !== 'string' || typeof state.previous !== 'string') throw new Error();
      if (state.high_water < bootstrap.document.skill_version) return { ...bundled(), fallback: true };
      const decode = source => {
        const bytes = Buffer.from(source, 'base64');
        if (bytes.toString('base64') !== source || bytes.length > MAX_ENVELOPE_BYTES) throw new Error();
        return verified(bytes);
      };
      const active = decode(state.active), previous = decode(state.previous);
      if (active.document.skill_version !== state.high_water || previous.document.skill_version >= state.high_water) throw new Error();
      installedBundle = { ...active, high_water: state.high_water, previous }; installedBytes = bytes;
      return installedBundle;
    } catch (error) {
      if (error.code === 'home_locked') throw error;
      return { ...bundled(), fallback: true, code: 'skill_state_invalid' };
    }
  }
  function cache() {
    try {
      const bytes = readFile(statusPath, MAX_CACHE_BYTES);
      if (!bytes) return emptyCache();
      const s = parseDocumentJSON(bytes, MAX_CACHE_BYTES);
      if (s.schema !== 1 || !Number.isSafeInteger(s.attempts) || s.attempts < 0 || !Number.isSafeInteger(s.next_attempt_at) || s.next_attempt_at < 0) throw new Error();
      return s;
    } catch (error) {
      if (error.code === 'home_locked') throw error;
      return { ...emptyCache(), state: 'failed', code: 'skill_state_invalid' };
    }
  }
  const save = s => {
    const bytes = Buffer.from(JSON.stringify(s));
    if (bytes.length > MAX_CACHE_BYTES) throw failure('skill_state_invalid');
    atomicPrivateWrite(statusPath, bytes, options);
  };
  function status() {
    const active = installed(), s = cache();
    return { skill_version: active.document.skill_version, high_water: active.high_water, protocol: { ...active.document.protocol },
      state: pending ? 'fetching' : active.fallback ? 'bootstrap' : s.state, code: active.code ?? s.code ?? null, hint_version: s.hint?.skill_version ?? null,
      attempts: s.attempts, next_attempt_at: s.next_attempt_at, protocol_incompatible: s.protocol_incompatible };
  }
  function observeHeartbeat(reply) {
    reply ??= {};
    if (typeof reply !== 'object' || Array.isArray(reply)) return;
    mutate(() => {
      const s = cache(), hint = reply.skill_update;
      const minimum = reply.protocol_incompatible?.minimum_protocol_version;
      s.protocol_incompatible = positive(minimum) ? { minimum_protocol_version: minimum } : null;
      if (positive(hint?.skill_version) && typeof hint.url === 'string') {
        const active = installed();
        if (hint.skill_version < active.high_water) {
          s.state = 'stale';
          s.hint = null;
        } else {
          let url = '';
          try { url = checkedURL(hint.url); } catch {}
          s.attempts = 0; s.next_attempt_at = 0; s.code = null; s.state = 'available';
          s.hint = { skill_version: hint.skill_version, url };
        }
      }
      save(s);
    });
  }
  async function download(url, signal) {
    const controller = new AbortController(), combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
    let reader, stop;
    const aborted = new Promise((_, reject) => {
      stop = () => { reader?.cancel().catch(() => {}); reject(failure('skill_fetch_timeout')); };
      combined.addEventListener('abort', stop, { once: true });
    });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      combined.throwIfAborted();
      const work = (async () => {
        const response = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' }, redirect: 'error', credentials: 'omit', signal: combined });
        if (combined.aborted) { response.body?.cancel().catch(() => {}); throw failure('skill_fetch_timeout'); }
        if (response.status !== 200 || response.redirected || Number(response.headers.get('content-length')) > MAX_ENVELOPE_BYTES) {
          response.body?.cancel().catch(() => {}); throw failure('skill_response_invalid');
        }
        if (!response.body) throw failure('skill_response_invalid');
        reader = response.body.getReader();
        const chunks = []; let size = 0;
        for (;;) {
          const { value, done } = await reader.read();
          combined.throwIfAborted();
          if (done) return Buffer.concat(chunks, size);
          size += value.byteLength;
          if (size > MAX_ENVELOPE_BYTES) { reader.cancel().catch(() => {}); throw failure('skill_response_invalid'); }
          chunks.push(Buffer.from(value));
        }
      })();
      return await Promise.race([work, aborted]);
    } finally { clearTimeout(timer); combined.removeEventListener('abort', stop); }
  }
  async function run({ signal } = {}) {
    let hint;
    try {
      const s = await retryHomeLock(() => { signal?.throwIfAborted(); return cache(); }); hint = s.hint;
      if (!hint) return { state: s.state === 'stale' ? 'stale' : 'idle' };
      if (s.next_attempt_at > now() || s.attempts >= maxAttempts) return { state: 'backoff' };
      trust.requireKey();
      checkedURL(hint.url);
      const bytes = await download(hint.url, signal), next = trust.verifyEnvelope(bytes);
      if (next.document.skill_version !== hint.skill_version) throw failure('skill_version_mismatch');
      capabilities(next.document);
      signal?.throwIfAborted();
      return await retryHomeLock(() => mutate(() => {
        const current = installed();
        if (next.document.skill_version < current.high_water) throw failure('skill_downgrade');
        let state = 'applied';
        if (next.document.skill_version === current.high_water) {
          if (!next.payloadBytes.equals(current.payloadBytes)) throw failure('skill_version_conflict');
          state = 'unchanged';
        }
        try {
          if (state === 'applied') atomicPrivateWrite(bundlePath, JSON.stringify({ schema: 1, high_water: next.document.skill_version, active: bytes.toString('base64'), previous: current.envelopeBytes.toString('base64') }), options);
          const latest = cache();
          if (latest.hint?.skill_version === hint.skill_version && latest.hint?.url === hint.url) {
            latest.state = state; latest.code = null; latest.attempts = 0; latest.next_attempt_at = 0; save(latest);
          }
        } catch { throw failure('skill_write_failed'); }
        return { state };
      }));
    } catch (error) {
      const codes = [...SKILL_UPDATE_ERROR_CODES, 'skill_key_unset', 'skill_key_invalid', 'skill_signature_invalid', 'skill_document_invalid', 'protocol_incompatible'];
      const code = codes.includes(error.code) ? error.code : 'skill_fetch_failed';
      try {
        await retryHomeLock(() => mutate(() => {
          const s = cache();
          if (s.hint?.skill_version !== hint?.skill_version || s.hint?.url !== hint?.url) return;
          s.state = 'failed'; s.code = code; s.attempts++; s.next_attempt_at = now() + Math.min(3600000, 1000 * 2 ** Math.min(s.attempts, 12)); save(s);
        }));
      } catch {}
      return { state: 'failed', code };
    }
  }
  return {
    observeHeartbeat, status,
    read() {
      const current = installed();
      const copy = value => value && { document: structuredClone(value.document), payloadBytes: Buffer.from(value.payloadBytes), envelopeBytes: Buffer.from(value.envelopeBytes) };
      return { ...copy(current), previous: copy(current.previous) };
    },
    tick(options) {
      if (pending) return Promise.resolve({ state: 'pending' });
      pending = run(options).finally(() => { pending = null; });
      return pending;
    },
  };
}
