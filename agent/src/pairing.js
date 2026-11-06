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
import { inferUrlScheme } from './url-scheme.js';
import { readHomeState, updateHomeState, forgetThinMember } from './home-state.js';
import { createThinPairing } from './thin-pairing.js';
import { atomicPrivateWrite, parsePrivateJson, readPrivateFile, removePrivateFile, withHomeLock } from './protected-files.js';
import { retryHomeLock } from './thin-lock.js';

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
  if (!isPairingId(doc.pairing_id) || !isPairingToken(doc.pairing_token) || typeof doc.uri !== "string" || badSecret) {
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
    updateHomeState(home, s => { if (s.pairings[id]) s.pairings[id].status = 'expired'; }, options);
    const doc = readPairingFile(home, options);
    if (doc?.pairing_id === id) removePrivateFile(join(home, PAIRING_FILE), options);
  }
  return {
    async startPairing({ v1 = false } = {}) {
      if (!isPairUriName(agentName)) throw new LocalStateError('invalid_config', 'agent name cannot fit pairing URI');
      const result = await relay.createPairing(), hubId = result?.hub_id ?? readHomeState(home, options).identity.hub_id;
      if (!isHubId(hubId) || hubId !== readHomeState(home, options).identity.hub_id || !isPairingId(result?.pairing_id) || !isPairingToken(result.pairing_token) || !isTimestamp(result.expires_at)) throw new RelayError({ status: 200, code: 'invalid_response', message: 'malformed pairing response' });
      const pairSecret = v1 ? undefined : b64uEncode(randomBytes(PAIR_SECRET_BYTES));
      registerSecret(pairSecret); registerSecret(result.pairing_token);
      const uri = buildPairUri({ relayBase: relay.baseUrl, hubId, pairingToken: result.pairing_token, agentPublicKey: publicKey, agentName,
        pairSecret, urlScheme: urlScheme == null ? inferUrlScheme(relay.baseUrl) : validateUrlScheme(urlScheme) });
      const doc = { pairing_id: result.pairing_id, pairing_token: result.pairing_token, expires_at: result.expires_at, uri, ...(pairSecret && { pair_secret: pairSecret }) };
      await retryHomeLock(() => withHomeLock(home, () => atomicPrivateWrite(join(home, PAIRING_FILE), JSON.stringify(doc) + '\n', options), options));
      await retryHomeLock(() => updateHomeState(home, s => { s.pairings[doc.pairing_id] = { pairing_id: doc.pairing_id, status: 'pending', expires_at: doc.expires_at, version: v1 ? 1 : 2 }; }, options));
      return view(doc);
    },
    currentPairing({ includeCompleted = false, graceMs = 0 } = {}) {
      const doc = readPairingFile(home, options);
      if (!doc && includeCompleted) {
        const state = readHomeState(home, options);
        const completed = Object.values(state.pairings).filter(p => p.status === 'completed' && Date.parse(p.expires_at) + graceMs > now().getTime())
          .sort((a, b) => Date.parse(b.expires_at) - Date.parse(a.expires_at))[0];
        if (completed) return { pairing_id: completed.pairing_id, expires_at: completed.expires_at, version: completed.version ?? 2 };
      }
      if (!doc || Date.parse(doc.expires_at) + graceMs <= now().getTime() || !(["pending", ...(includeCompleted ? ["completed"] : [])].includes(readHomeState(home, options).pairings[doc.pairing_id]?.status))) return null;
      return view(doc);
    },
    async refreshPairing(id, { signal, deadline } = {}) {
      let result;
      try { result = await relay.getPairing(id, { signal, deadline }); }
      catch (e) { if (e.status !== 404) throw e; await retryHomeLock(() => expire(id)); return { status: 'expired' }; }
      if (result.status === 'expired') { await retryHomeLock(() => expire(id)); return result; }
      if (result.status !== 'completed') return { status: 'pending' };
      const listed = await relay.listMembers({ signal, deadline });
      const member = listed?.members?.find(m => m.member_id === result.member_id && m.role === 'device' && m.public_key === result.public_key);
      if (!member) throw new LocalStateError('invalid_response', 'pairing requires current relay membership');
      await retryHomeLock(() => pairing.join({ ...member, pairing_id: id, joined_at: result.completed_at ?? member.joined_at }, { verified: true }));
      return { status: 'completed', completed_at: result.completed_at, member: memberView(member.member_id) };
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
