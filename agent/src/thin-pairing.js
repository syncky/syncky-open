import nodeFs from "node:fs";
import { join } from "node:path";
import { LocalStateError } from "./config.js";
import { isB64u } from "./encoding.js";
import { isMemberId, uuidv7 } from "./ids.js";
import { fingerprint, normalizeFingerprint } from "./fingerprint.js";
import { pairCode, pairProof, pairProofMatches } from "./pair-code.js";
import { readHomeState, updateHomeState, createCipherFiles } from "./home-state.js";
import { parsePrivateJson, privateStat, readPrivateFile, removePrivateFile, syncDirectory, withHomeLock } from "./protected-files.js";
import { joinGraceUntil } from "./transport-time.js";

export function startThinFastPoll(state, memberId, graceUntil, at) {
  const fast = state.transport.fast_poll, active = fast?.until > at && fast.devices?.length;
  const until = Math.max(active ? fast.until : 0, graceUntil - 60000);
  if (!(until > at)) return;
  state.transport.fast_poll = { devices: [...new Set([...(active ? fast.devices : []), memberId])], until };
  state.transport.next_poll_at = Math.min(state.transport.next_poll_at ?? Infinity, (state.transport.last_poll_at ?? 0) + 25000);
}

export function recoverPairProof(home, state, member, { fs = nodeFs } = {}) {
  if (member.state !== "joined" || member.proof_invalidated || member.pair_proof || !member.pairing_id || !state.pairings[member.pairing_id]) return;
  const bytes = readPrivateFile(join(home, "pairing.json"), { fs, optional: true });
  if (!bytes) return;
  const doc = parsePrivateJson(bytes);
  if (doc.pairing_id !== member.pairing_id || doc.pair_secret === undefined) return;
  if (!isB64u(doc.pair_secret, { length: 16 })) throw new LocalStateError("corrupt_state", "invalid pending pairing state");
  member.pair_code = pairCode(doc.pair_secret);
  member.pair_proof = pairProof(doc.pair_secret, state.identity.public_key, member.public_key);
}

export function createThinPairing(home, { fs = nodeFs, now = () => new Date() } = {}) {
  const options = { fs };
  function requireMember(state, id) {
    const member = state.members[id];
    if (!member || member.role !== "device") throw new LocalStateError("unknown_member", "unknown phone member");
    return member;
  }
  function confirmed(state, member, method) {
    if (member.state === "confirmed") return { member_id: member.member_id, state: member.state };
    const at = now();
    member.confirmation_method = method; member.state = "confirmed"; member.confirmed_at = at.toISOString(); member.pair_code = null; member.pair_proof = null;
    member.confirmation = { msg_id: uuidv7({ now: () => at.getTime() }), created_at: at.toISOString() };
    startThinFastPoll(state, member.member_id, member.join_grace_until ?? Number(state.transport.join_grace?.[`join_grace:${member.member_id}`] ?? 0), at.getTime());
    return { member_id: member.member_id, state: member.state };
  }
  function confirm(id, check, method) {
    return updateHomeState(home, state => {
      const member = requireMember(state, id);
      if (!["joined", "confirmed"].includes(member.state)) throw new LocalStateError("invalid_transition", "phone cannot be confirmed");
      recoverPairProof(home, state, member, options); check(state, member);
      return confirmed(state, member, method);
    }, options);
  }
  return {
    join(fields, { verified = false } = {}) {
      if (!verified || !isMemberId(fields?.member_id) || fields.role !== "device" || !isB64u(fields.public_key, { length: 32 })) throw new LocalStateError("invalid_state", "join requires verified relay membership");
      const result = updateHomeState(home, state => {
        const existing = state.members[fields.member_id];
        if (existing) {
          if (existing.public_key !== fields.public_key) throw new LocalStateError("key_conflict", "phone key changed");
          recoverPairProof(home, state, existing, options);
          const grace = joinGraceUntil(fields.joined_at, now().getTime());
          if (grace > 0) existing.join_grace_until = Math.min(existing.join_grace_until || Number(state.transport.join_grace?.[`join_grace:${fields.member_id}`]) || Infinity, grace);
          return { member_id: existing.member_id, state: existing.state };
        }
        const member = { member_id: fields.member_id, role: "device", name: fields.name ?? fields.device_name ?? null, public_key: fields.public_key, pairing_id: fields.pairing_id ?? null, state: "joined", joined_at: now().toISOString(), join_grace_until: joinGraceUntil(fields.joined_at, now().getTime()), fingerprint: fingerprint(state.identity.public_key, fields.public_key).text };
        recoverPairProof(home, state, member, options);
        state.members[member.member_id] = member;
        startThinFastPoll(state, member.member_id, member.join_grace_until, now().getTime());
        if (state.pairings[member.pairing_id]) Object.assign(state.pairings[member.pairing_id], { status: "completed", member_id: member.member_id });
        return { member_id: member.member_id, state: member.state };
      }, options);
      withHomeLock(home, () => {
        const path = join(home, "pairing.json"), bytes = readPrivateFile(path, { ...options, optional: true });
        if (bytes && fields.pairing_id && parsePrivateJson(bytes).pairing_id === fields.pairing_id) removePrivateFile(path, options);
      }, options);
      return result;
    },
    trustedKey(id) {
      const state = readHomeState(home, options), member = state.members[id];
      return ![true, "1"].includes(state.transport.hub_revoked) && ![true, "1"].includes(state.transport.hub_deleted) && member?.state === "confirmed" ? member.public_key : null;
    },
    confirmProof(id, proof) {
      const result = updateHomeState(home, state => {
        const member = requireMember(state, id);
        if (member.state !== "joined") throw new LocalStateError("invalid_transition", "only a joined phone can supply proof");
        recoverPairProof(home, state, member, options);
        if (!member.pair_proof || !pairProofMatches(member.pair_proof, proof)) {
          member.pair_proof = null; member.proof_invalidated = true;
          return false;
        }
        return confirmed(state, member, "proof");
      }, options);
      if (!result) throw new LocalStateError("pair_proof_invalid", "phone proof did not match; compare fingerprints");
      return result;
    },
    confirmFingerprint(id, supplied) {
      return confirm(id, (state, member) => {
        const expected = fingerprint(state.identity.public_key, member.public_key).text;
        if (!normalizeFingerprint(supplied) || normalizeFingerprint(supplied) !== normalizeFingerprint(expected)) throw new LocalStateError("fingerprint_mismatch", "phone fingerprint did not match");
      }, "fingerprint");
    },
    revoke(id, { rejected = false } = {}) {
      const result = updateHomeState(home, state => {
        const member = requireMember(state, id);
        if (rejected && member.state !== "joined" && member.state !== "rejected") throw new LocalStateError("invalid_transition", "only a joined phone can be rejected");
        member.state = rejected ? "rejected" : "revoked"; member.revoked_at ??= now().toISOString(); member.pair_code = null; member.pair_proof = null;
        delete member.confirmation;
        if (state.transport.fast_poll?.devices) state.transport.fast_poll.devices = state.transport.fast_poll.devices.filter(device => device !== id);
      }, options);
      const held = createCipherFiles(home, "held", options);
      for (const entry of held.list().filter(e => e.from === id || e.held_member === id)) held.remove(entry.msg_id);
      const outbox = createCipherFiles(home, "outbox", options);
      for (const entry of outbox.list().filter(e => e.to?.includes(id) && e.state === "pending")) outbox.update(entry.msg_id, { state: "failed", code: "target_revoked" });
      for (const area of ["held", "outbox"]) if (privateStat(join(home, area), { ...options, directory: true, optional: true })) syncDirectory(join(home, area), options);
      return result;
    },
  };
}
