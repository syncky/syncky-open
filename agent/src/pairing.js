import { maintainResponseWaits } from "./response-waits.js";
import nodeFs from 'node:fs';
import { join } from 'node:path';
import qrcodeTerminal from 'qrcode-terminal';
import QRErrorCorrectLevel from 'qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel.js';
import { LocalStateError, validateUrlScheme } from './config.js';
import { randomBytes } from './crypto.js';
import { b64uEncode, isB64u, isTimestamp } from './encoding.js';
import { isHubId, isPairingId, isPairingToken } from './ids.js';
import { pairCode } from './pair-code.js';
import { buildPairUri, isPairUriName, PAIR_SECRET_BYTES } from './pair-uri.js';
import { registerSecret } from './log.js';
import { RelayError } from './relay-client.js';
import { readHomeState, updateHomeState, forgetThinMember, STATE_FILE, validateHomeState } from './home-state.js';
import { createThinPairing } from './thin-pairing.js';
import { atomicPrivateWrite, parsePrivateJson, readPrivateFile, removePrivateFile, withHomeLock } from './protected-files.js';
import { retryHomeLock } from './thin-lock.js';
import { isStoredRequestedScope, validateAccessScope } from './access-scope.js';
import { cancelPairingAccess, maintainPairingAccess } from './pairing-access.js';

export const PAIRING_FILE = 'pairing.json';
export function renderTerminalQr(uri) {
  let out = "";
  qrcodeTerminal.error = QRErrorCorrectLevel.M;
  qrcodeTerminal.generate(uri, { small: true }, (text) => {
    out = text;
  });
  return out;
}

export function readPairingFile(home, { fs = nodeFs } = {}) {
  const doc = (() => { const bytes = readPrivateFile(join(home, PAIRING_FILE), { fs, optional: true }); return bytes ? parsePrivateJson(bytes) : null; })();
  if (doc === null) return null;
  const badSecret = doc.pair_secret !== undefined && !isB64u(doc.pair_secret, { length: PAIR_SECRET_BYTES });
  if (!isPairingId(doc.pairing_id) || !isPairingToken(doc.pairing_token) || typeof doc.uri !== "string" || badSecret
    || !isTimestamp(doc.expires_at) || (doc.requested_scope !== undefined && !isStoredRequestedScope(doc.requested_scope))) {
    throw new LocalStateError("corrupt_state", `${PAIRING_FILE} is malformed; run syncky-agent pair again`);
  }
  if (doc.pair_secret !== undefined) registerSecret(doc.pair_secret);
  registerSecret(doc.pairing_token);
  return doc;
}

export function createPairingService({ home, relay, publicKey, agentName, urlScheme, now = () => new Date(), fs = nodeFs }) {
  const options = { fs }, pairing = createThinPairing(home, { fs, now });
  const view = doc => ({ pairing_id: doc.pairing_id, uri: doc.uri, expires_at: doc.expires_at,
    ...(doc.pair_secret === undefined ? { version: 1 } : { version: 2, code: pairCode(doc.pair_secret) }) });
  const memberView = id => {
    const m = readHomeState(home, options).members[id];
    return m && { member_id: id, role: m.role, name: m.name, state: m.state, fingerprint: m.fingerprint, pairing_id: m.pairing_id };
  };
  function expire(id) {
    withHomeLock(home, () => {
      const state = readHomeState(home, options);
      if (state.pairings[id]) { state.pairings[id].status = 'expired'; cancelPairingAccess(state.pairings[id]); }
      maintainResponseWaits(state, now().getTime());
      atomicPrivateWrite(join(home, STATE_FILE), JSON.stringify(validateHomeState(state)) + '\n', options);
      const doc = readPairingFile(home, options);
      if (doc?.pairing_id === id) removePrivateFile(join(home, PAIRING_FILE), options);
    }, options);
  }
  return {
    async startPairing({ v1 = false, read, write } = {}) {
      if (!isPairUriName(agentName)) throw new LocalStateError('invalid_config', 'agent name cannot fit pairing URI');
      let requestedScope;
      if (read !== undefined || write !== undefined) {
        const scope = { request_ref: Buffer.from(randomBytes(16)).toString('hex'), read: read ?? [], write: write ?? [] };
        const result = validateAccessScope(scope, { normalize: true });
        if (!result.ok) throw new LocalStateError('invalid_input', `invalid requested scope: ${result.detail}`);
        requestedScope = result.value;
      }
      const result = await relay.createPairing(), state = await retryHomeLock(() => readHomeState(home, options));
      const hubId = result?.hub_id ?? state.identity.hub_id;
      if (!isHubId(hubId) || hubId !== state.identity.hub_id || !isPairingId(result?.pairing_id) || !isPairingToken(result.pairing_token) || !isTimestamp(result.expires_at)) throw new RelayError({ status: 200, code: 'invalid_response', message: 'malformed pairing response' });
      const pairSecret = v1 ? undefined : b64uEncode(randomBytes(PAIR_SECRET_BYTES));
      registerSecret(pairSecret); registerSecret(result.pairing_token);
      const uri = buildPairUri({ relayBase: relay.baseUrl, hubId, pairingToken: result.pairing_token, agentPublicKey: publicKey, agentName,
        pairSecret, requestedScope, urlScheme: urlScheme == null ? null : validateUrlScheme(urlScheme) });
      const doc = { pairing_id: result.pairing_id, pairing_token: result.pairing_token, expires_at: result.expires_at, uri,
        ...(pairSecret && { pair_secret: pairSecret }), ...(requestedScope && { requested_scope: requestedScope }) };
      await retryHomeLock(() => withHomeLock(home, () => {
        const current = readHomeState(home, options);
        for (const row of Object.values(current.pairings)) cancelPairingAccess(row);
        current.pairings[doc.pairing_id] = { pairing_id: doc.pairing_id, status: 'pending', expires_at: doc.expires_at, version: v1 ? 1 : 2,
          ...(requestedScope && { requested_scope: requestedScope, access: { state: 'awaiting', deadline_at: doc.expires_at } }) };
        maintainResponseWaits(current, now().getTime());
        atomicPrivateWrite(join(home, PAIRING_FILE), JSON.stringify(doc) + '\n', options);
        atomicPrivateWrite(join(home, STATE_FILE), JSON.stringify(validateHomeState(current)) + '\n', options);
      }, options));
      return view(doc);
    },
    currentPairing({ includeCompleted = false, includeExpired = false, graceMs = 0 } = {}) {
      const original = readHomeState(home, options);
      if (maintainPairingAccess(original, now().getTime())) updateHomeState(home, s => { maintainPairingAccess(s, now().getTime()); }, options);
      let doc = readPairingFile(home, options);
      const completed = original.pairings[doc?.pairing_id], bound = original.members[completed?.member_id];
      if (completed?.requested_scope && completed.status === 'completed' && bound?.public_key === completed.public_key && bound.pairing_id === doc.pairing_id) {
        pairing.join(bound, { verified: true });
        doc = null;
      }
      if (doc && original.pairings[doc.pairing_id]?.status === 'expired') {
        expire(doc.pairing_id);
        return null;
      }
      if (!doc && includeCompleted) {
        const state = readHomeState(home, options);
        const completed = Object.values(state.pairings).filter(p => p.status === 'completed' && (Date.parse(p.expires_at) + graceMs > now().getTime() || (p.access?.state === 'awaiting' && Date.parse(p.access.deadline_at) > now().getTime())))
          .sort((a, b) => Date.parse(b.expires_at) - Date.parse(a.expires_at))[0];
        if (completed) return { pairing_id: completed.pairing_id, expires_at: completed.expires_at, version: completed.version ?? 2 };
      }
      if (!doc || (!includeExpired && Date.parse(doc.expires_at) + graceMs <= now().getTime()) || !(["pending", ...(includeCompleted ? ["completed"] : [])].includes(readHomeState(home, options).pairings[doc.pairing_id]?.status))) return null;
      return view(doc);
    },
    async refreshPairing(id, { signal, deadline } = {}) {
      signal?.throwIfAborted();
      const saved = await retryHomeLock(() => readHomeState(home, options));
      const row = saved.pairings[id], bound = saved.members[row?.member_id];
      if (row?.requested_scope && row.status === 'completed' && bound?.pairing_id === id && bound.public_key === row.public_key
        && ['joined', 'confirmed'].includes(bound.state)) return { status: 'completed', member: await retryHomeLock(() => memberView(bound.member_id)) };
      let result;
      try { result = await relay.getPairing(id, { signal, deadline }); }
      catch (e) { if (e.status !== 404) throw e; await retryHomeLock(() => expire(id)); return { status: 'expired' }; }
      if (result.status === 'expired') { await retryHomeLock(() => expire(id)); return result; }
      if (result.status !== 'completed') return { status: 'pending' };
      const listed = await relay.listMembers({ signal, deadline });
      const member = listed?.members?.find(m => m.member_id === result.member_id && m.role === 'device' && m.public_key === result.public_key);
      if (!member) throw new LocalStateError('invalid_response', 'pairing requires current relay membership');
      await retryHomeLock(() => pairing.join({ ...member, pairing_id: id, joined_at: result.completed_at ?? member.joined_at }, { verified: true }));
      return { status: 'completed', completed_at: result.completed_at, member: await retryHomeLock(() => memberView(member.member_id)) };
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
