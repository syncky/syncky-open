import { maintainResponseWaits } from "./response-waits.js";
import nodeFs from 'node:fs';
import { join, resolve } from 'node:path';
import { LocalStateError, validateUrlScheme } from './config.js';
import { randomBytes } from './crypto.js';
import { b64uEncode, deviceName, isB64u, isTimestamp } from './encoding.js';
import { isHubId, isPairingId, isPairingToken } from './ids.js';
import { pairCode } from './pair-code.js';
import { buildPairUri, isPairUriName, parsePairUri, PAIR_SECRET_BYTES } from './pair-uri.js';
import { registerSecret } from './log.js';
import { RelayError } from './relay-client.js';
import { readHomeState, updateHomeState, forgetThinMember, STATE_FILE, validateHomeState } from './home-state.js';
import { createThinPairing, validateMemberPairing } from './thin-pairing.js';
import { atomicPrivateWrite, parsePrivateJson, privateStat, readPrivateFile, removePrivateFile, withHomeLock } from './protected-files.js';
import { retryHomeLock } from './thin-lock.js';
import { accessRequestFits, isStoredRequestedScope, validateAccessScope } from './access-scope.js';
import { cancelPairingAccess, maintainPairingAccess, validV1Scope } from './pairing-access.js';
import { cleanupPairingQr, createPairingQrFiles } from './pair-qr.js';
import { sealPairingScope } from './pairing-scope-blob.js';
import { errorHint, PAIRING_SIZE_HINT } from './error-guidance.js';

export const PAIRING_FILE = 'pairing.json';
export { renderTerminalQr } from './pair-qr.js';

export function readPairingFile(home, { fs = nodeFs } = {}) {
  const doc = (() => { const bytes = readPrivateFile(join(home, PAIRING_FILE), { fs, optional: true }); return bytes ? parsePrivateJson(bytes) : null; })();
  if (doc === null) return null;
  const badSecret = doc.pair_secret !== undefined && !isB64u(doc.pair_secret, { length: PAIR_SECRET_BYTES });
  if (!isPairingId(doc.pairing_id) || !isPairingToken(doc.pairing_token) || typeof doc.uri !== "string" || badSecret
    || !isTimestamp(doc.expires_at) || (doc.requested_scope !== undefined && !isStoredRequestedScope(doc.requested_scope))
    || (doc.v1_scope !== undefined && (doc.pair_secret !== undefined || doc.requested_scope !== undefined || !validV1Scope(doc.v1_scope)))) {
    throw new LocalStateError("corrupt_state", `${PAIRING_FILE} is malformed; run syncky-agent pair again`);
  }
  if (doc.pair_secret !== undefined) registerSecret(doc.pair_secret);
  registerSecret(doc.pairing_token); registerSecret(doc.uri);
  return doc;
}

export function createPairingService({ home, relay, publicKey, agentName, urlScheme, now = () => new Date(), fs = nodeFs }) {
  const options = { fs }, pairing = createThinPairing(home, { fs, now });
  const view = (doc, images = {}) => {
    const directory = resolve(home, 'pairing-qr'), paths = {};
    try {
      if (privateStat(directory, { ...options, directory: true, optional: true })) {
        for (const format of ['png', 'svg']) {
          const path = join(directory, `${doc.pairing_id}.${format}`);
          try { if (privateStat(path, { ...options, optional: true })) paths['qr_' + format] = path; } catch {}
        }
      }
    } catch {}
    return { pairing_id: doc.pairing_id, uri: doc.uri, expires_at: doc.expires_at, ...paths, ...images,
      ...(doc.pair_secret === undefined ? { version: 1 } : { version: 2, code: pairCode(doc.pair_secret) }) };
  };
  function snapshot() {
    const state = readHomeState(home, options), doc = readPairingFile(home, options);
    cleanupPairingQr(home, doc && state.pairings[doc.pairing_id]?.status === 'pending' && Date.parse(doc.expires_at) > now().getTime() ? doc.pairing_id : null, options);
    return { state, doc };
  }
  const publicMember = m => m && ({ member_id: m.member_id, role: m.role, name: deviceName(m.name ?? m.device_name), state: m.state, fingerprint: m.fingerprint, pairing_id: m.pairing_id });
  const memberView = id => publicMember(readHomeState(home, options).members[id]);
  function completedMember(state, id) {
    const row = Object.hasOwn(state.pairings, id) ? state.pairings[id] : null, member = Object.hasOwn(state.members, row?.member_id) ? state.members[row.member_id] : null;
    if (row?.status !== 'completed' || member?.role !== 'device' || member.pairing_id !== id
      || !['joined', 'confirmed'].includes(member.state) || member.unpair_reason != null
      || (row.public_key !== undefined && row.public_key !== member.public_key)
      || [true, '1'].includes(state.transport.hub_revoked) || [true, '1'].includes(state.transport.hub_deleted)) return null;
    return member;
  }
  const completedResult = id => {
    const member = completedMember(readHomeState(home, options), id);
    return member ? { status: 'completed', member: publicMember(member) } : null;
  };
  function expire(id) {
    withHomeLock(home, () => {
      const state = readHomeState(home, options);
      if (state.pairings[id]?.status === 'completed') return;
      if (state.pairings[id]) { state.pairings[id].status = 'expired'; cancelPairingAccess(state.pairings[id]); }
      maintainResponseWaits(state, now().getTime());
      atomicPrivateWrite(join(home, STATE_FILE), JSON.stringify(validateHomeState(state)) + '\n', options);
      const doc = readPairingFile(home, options);
      if (doc?.pairing_id === id) { cleanupPairingQr(home, null, options); removePrivateFile(join(home, PAIRING_FILE), options); }
    }, options);
  }
  return {
    async startPairing({ v1 = false, read, write, qrPng, qrSvg } = {}) {
      const { identity } = await retryHomeLock(() => readHomeState(home, options));
      if (urlScheme != null) validateUrlScheme(urlScheme, relay.baseUrl);
      if (!isPairUriName(agentName)) throw new LocalStateError('invalid_config', 'agent name cannot fit pairing URI');
      if (publicKey !== identity.public_key) throw new LocalStateError('key_mismatch', 'home identity and pairing key disagree');
      const pairSecret = v1 ? undefined : b64uEncode(randomBytes(PAIR_SECRET_BYTES));
      let requestedScope;
      if (read !== undefined || write !== undefined) {
        const scope = { request_ref: Buffer.from(randomBytes(16)).toString('hex'), read: read ?? [], write: write ?? [] };
        const result = validateAccessScope(scope, { normalize: true });
        if (!result.ok) throw new LocalStateError('invalid_input', result.detail === 'too_large' ? PAIRING_SIZE_HINT : `invalid requested scope: ${result.detail}`, { detail: result.detail, ...(result.detail === 'not_writable' && { types: result.types }) });
        requestedScope = result.value;
        if (v1 && !accessRequestFits(requestedScope, { v: 1, type: 'access_request', ...requestedScope,
          created_at: '9999-12-30T23:59:59.999Z', expires_at: '9999-12-31T23:59:59.999Z' })) {
          throw new LocalStateError('invalid_input', PAIRING_SIZE_HINT, { detail: 'too_large' });
        }
      }
      let blob;
      if (requestedScope && !v1) {
        try { blob = await sealPairingScope(requestedScope, { pairSecret, hubId: identity.hub_id, agentPublicKey: identity.public_key }); }
        catch (error) {
          if (error.detail !== 'too_large') throw error;
          throw new LocalStateError('invalid_input', PAIRING_SIZE_HINT, { detail: 'too_large' });
        }
      }
      const result = await relay.createPairing(blob);
      const hubId = result?.hub_id ?? identity.hub_id;
      if (!isHubId(hubId) || hubId !== identity.hub_id || !isPairingId(result?.pairing_id) || !isPairingToken(result.pairing_token) || !isTimestamp(result.expires_at)) throw new RelayError({ status: 200, code: 'invalid_response', message: 'malformed pairing response' });
      if (blob && result.pairing_scope_stored !== true) throw new LocalStateError('pairing_scope_relay_unsupported', errorHint('pairing_scope_relay_unsupported'));
      const currentIdentity = (await retryHomeLock(() => readHomeState(home, options))).identity;
      if (JSON.stringify(currentIdentity) !== JSON.stringify(identity)) throw new LocalStateError('key_mismatch', 'home identity changed during pairing');
      registerSecret(pairSecret); registerSecret(result.pairing_token);
      const uri = buildPairUri({ relayBase: relay.baseUrl, hubId, pairingToken: result.pairing_token, agentPublicKey: publicKey, agentName,
        pairSecret, scopeOnRelay: blob !== undefined, urlScheme: urlScheme == null ? null : validateUrlScheme(urlScheme) });
      const v1Scope = v1 && requestedScope ? { read: requestedScope.read, write: requestedScope.write } : undefined;
      const doc = { pairing_id: result.pairing_id, pairing_token: result.pairing_token, expires_at: result.expires_at, uri,
        ...(pairSecret && { pair_secret: pairSecret }), ...(v1Scope && { v1_scope: v1Scope }), ...(!v1 && requestedScope && { requested_scope: requestedScope }) };
      const images = await retryHomeLock(() => withHomeLock(home, () => {
        const current = readHomeState(home, options);
        for (const row of Object.values(current.pairings)) cancelPairingAccess(row);
        current.pairings[doc.pairing_id] = { pairing_id: doc.pairing_id, status: 'pending', expires_at: doc.expires_at, version: v1 ? 1 : 2,
          ...(v1Scope && { v1_scope: v1Scope }), ...(doc.requested_scope && { requested_scope: requestedScope, access: { state: 'awaiting', deadline_at: doc.expires_at } }) };
        maintainResponseWaits(current, now().getTime());
        atomicPrivateWrite(join(home, PAIRING_FILE), JSON.stringify(doc) + '\n', options);
        atomicPrivateWrite(join(home, STATE_FILE), JSON.stringify(validateHomeState(current)) + '\n', options);
        cleanupPairingQr(home, doc.pairing_id, options);
        return createPairingQrFiles(home, doc, { qrPng, qrSvg }, options);
      }, options));
      return view(doc, images);
    },
    showPairing({ qrPng, qrSvg } = {}) {
      const pending = this.currentPairing();
      if (!pending) throw new LocalStateError('pairing_expired', 'no live pending pairing; start a new pairing');
      return withHomeLock(home, () => {
        const { doc, state } = snapshot();
        if (!doc || doc.pairing_id !== pending.pairing_id || state.pairings[doc.pairing_id]?.status !== 'pending' || Date.parse(doc.expires_at) <= now().getTime()) throw new LocalStateError('pairing_expired', 'no live pending pairing');
        const info = parsePairUri(doc.uri, { allowInsecureRelay: true }).value;
        if (info?.requestedScope || (doc.requested_scope && !info?.scopeOnRelay)) {
          throw new LocalStateError('pairing_previous_access_format', errorHint('pairing_previous_access_format'));
        }
        return view(doc, createPairingQrFiles(home, doc, { qrPng, qrSvg }, options));
      }, options);
    },
    currentPairing({ includeCompleted = false, includeExpired = false, graceMs = 0 } = {}) {
      const original = readHomeState(home, options);
      if (maintainPairingAccess(original, now().getTime())) updateHomeState(home, s => { maintainPairingAccess(s, now().getTime()); }, options);
      let doc = readPairingFile(home, options), qrDirectory = false;
      try { qrDirectory = fs.lstatSync(join(home, 'pairing-qr')).isDirectory(); } catch {}
      if (qrDirectory) ({ doc } = withHomeLock(home, snapshot, options));
      const bound = doc && completedMember(original, doc.pairing_id);
      if (bound) {
        pairing.join(bound, { verified: true });
        doc = null;
      }
      if (doc && original.pairings[doc.pairing_id]?.status === 'expired') {
        // Keep the current-link guard when removal would expose another phone.
        if (!Object.values(original.pairings).some(row => completedMember(original, row.pairing_id))) expire(doc.pairing_id);
        return null;
      }
      if (doc && original.pairings[doc.pairing_id]?.status === 'pending'
        && (includeExpired || Date.parse(doc.expires_at) + graceMs > now().getTime())) return view(doc);
      if (doc) return null;
      if (includeCompleted) {
        const state = readHomeState(home, options);
        const completed = Object.values(state.pairings).filter(p => completedMember(state, p.pairing_id))
          .sort((a, b) => Date.parse(b.expires_at) - Date.parse(a.expires_at))[0];
        if (completed) return { pairing_id: completed.pairing_id, expires_at: completed.expires_at, version: completed.version ?? 2 };
      }
      return null;
    },
    async refreshPairing(id, { signal, deadline } = {}) {
      signal?.throwIfAborted();
      if (!isPairingId(id)) throw new LocalStateError("invalid_input", "invalid pairing id");
      const saved = await retryHomeLock(() => readHomeState(home, options));
      if (completedMember(saved, id)) return await retryHomeLock(() => completedResult(id)) ?? { status: 'expired' };
      let result;
      try { result = await relay.getPairing(id, { signal, deadline }); }
      catch (e) { if (e.status !== 404) throw e; await retryHomeLock(() => expire(id)); return await retryHomeLock(() => completedResult(id)) ?? { status: 'expired' }; }
      if (result.status === 'expired') { await retryHomeLock(() => expire(id)); return await retryHomeLock(() => completedResult(id)) ?? result; }
      if (result.status !== 'completed') return { status: 'pending' };
      const listed = await relay.listMembers({ signal, deadline });
      const member = listed?.members?.find(m => m.member_id === result.member_id && m.role === 'device' && m.public_key === result.public_key);
      if (!member) throw new LocalStateError('invalid_response', 'pairing requires current relay membership');
      validateMemberPairing(member);
      await retryHomeLock(() => pairing.join({ ...member, pairing_id: id, joined_at: result.completed_at ?? member.joined_at }, { verified: true }));
      const completed = await retryHomeLock(() => completedResult(id));
      return completed ? { ...completed, completed_at: result.completed_at } : { status: 'expired' };
    },
    confirmWithFingerprint(id, fingerprint) { pairing.confirmFingerprint(id, fingerprint); return { member: memberView(id), state: memberView(id).state }; },
    async rejectMember(id) {
      await retryHomeLock(() => pairing.revoke(id, { rejected: true }));
      try { await relay.revokeMember(id); } catch (e) { if (e.status !== 404) throw e; }
      return { member: memberView(id), state: 'rejected' };
    },
    async revokeMember(id) {
      if (memberView(id)?.role !== 'device') throw new LocalStateError('unknown_member', 'unknown phone member');
      let revokedOnRelay = true;
      try { await relay.revokeMember(id); }
      catch (e) { if (e.status !== 404) throw e; revokedOnRelay = false; }
      await retryHomeLock(() => pairing.revoke(id, { rejected: memberView(id).state === 'rejected' }));
      const member = memberView(id);
      return { member, state: member.state, revoked_on_relay: revokedOnRelay };
    },
    forgetMember: (id, options) => ({ counts: forgetThinMember(home, id, options), dry_run: !options?.yes }),
  };
}
