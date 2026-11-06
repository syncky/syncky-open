import nodeFs from "node:fs";
import { join } from "node:path";
import { LocalStateError } from "./config.js";
import { isHubId, isMemberId, isPairingId, isUuidV7 } from "./ids.js";
import { isB64u } from "./encoding.js";
import { atomicPrivateWrite, parsePrivateJson, privateDirectory, privateStat, readPrivateFile, removePrivateFile, syncDirectory, syncPrivateFile, withHomeLock } from "./protected-files.js";
import { rewriteInbox, inboxLines } from "./inbox.js";

export const STATE_FILE = "state.json";
export const MIGRATION_FILE = "migration.json";
export const LEGACY_FILES = ["agent.db", "diagnostics.db", "access.db"].flatMap(n => [n, `${n}-wal`, `${n}-shm`]);
const object = v => v !== null && typeof v === "object" && !Array.isArray(v);
const corrupt = () => new LocalStateError("corrupt_state", "invalid thin home state");

export function detectLegacyFiles(home, { fs = nodeFs } = {}) {
  privateStat(home, { fs, directory: true });
  return LEGACY_FILES.filter(n => {
    try { fs.lstatSync(join(home, n)); return true; } catch (e) { if (e.code === "ENOENT") return false; throw e; }
  });
}

export function validateHomeState(state) {
  if (!object(state) || state.version !== 1 || !object(state.identity) || !isHubId(state.identity.hub_id)
    || !isMemberId(state.identity.member_id) || !state.identity.member_id.startsWith("m_agent_")
    || !isB64u(state.identity.public_key, { length: 32 }) || !object(state.members) || !object(state.pairings) || !object(state.transport)) throw corrupt();
  if (Object.keys(state.identity).some(k => !["hub_id", "member_id", "public_key"].includes(k))) throw corrupt();
  const self = state.members[state.identity.member_id];
  if (!self || self.state !== "self" || self.public_key !== state.identity.public_key || self.role !== "agent") throw corrupt();
  for (const [id, member] of Object.entries(state.members)) {
    if (!isMemberId(id) || !object(member) || member.member_id !== id || !isB64u(member.public_key, { length: 32 })
      || !["self", "joined", "confirmed", "rejected", "revoked"].includes(member.state)
      || !["device", "agent"].includes(member.role) || (member.state === "self" && id !== state.identity.member_id)
      || (member.pair_proof != null && !isB64u(member.pair_proof, { length: 32 }))) throw corrupt();
    if (member.confirmation != null && (!object(member.confirmation) || !isUuidV7(member.confirmation.msg_id)
      || typeof member.confirmation.created_at !== "string" || !Number.isFinite(Date.parse(member.confirmation.created_at)))) throw corrupt();
  }
  for (const [id, pairing] of Object.entries(state.pairings)) {
    if (!isPairingId(id) || !object(pairing) || pairing.pairing_id !== id || !["pending", "completed", "expired"].includes(pairing.status)
      || !Number.isFinite(Date.parse(pairing.expires_at))) throw corrupt();
  }
  for (const key of ["cursor", "acked_seq"]) if (!Number.isSafeInteger(state.transport[key]) || state.transport[key] < 0) throw corrupt();
  if (state.transport.acked_seq > state.transport.cursor) throw corrupt();
  for (const pending of [state.transport.pending_ack, state.transport.poll_progress?.pending_ack]) {
    if (pending != null && (!object(pending) || !Number.isSafeInteger(pending.up_to_seq) || pending.up_to_seq < 0 || pending.up_to_seq > state.transport.cursor)) throw corrupt();
  }
  if (state.transport.poll_progress != null && !object(state.transport.poll_progress)) throw corrupt();
  for (const key of ["tracking_started_at", "last_poll_at", "last_ack_at", "retry_after_until", "retry_at", "next_poll_at"]) {
    const value = state.transport.poll_progress?.[key];
    if (value != null && (!Number.isSafeInteger(value) || value < 0)) throw corrupt();
  }
  if (state.migration != null && (!object(state.migration) || !/^[a-f0-9]{64}$/.test(state.migration.source_hash))) throw corrupt();
  return state;
}

export function newHomeState(identity) {
  return validateHomeState({ version: 1, identity: { ...identity }, members: { [identity.member_id]: { member_id: identity.member_id, public_key: identity.public_key, role: "agent", state: "self" } }, pairings: {}, transport: { cursor: 0, acked_seq: 0, pending_ack: null } });
}

export function readHomeState(home, { fs = nodeFs } = {}) {
  const bytes = readPrivateFile(join(home, STATE_FILE), { fs, optional: true });
  if (!bytes) throw new LocalStateError(detectLegacyFiles(home, { fs }).length ? "migration_required" : "not_initialized", "thin home state is required");
  const state = validateHomeState(parsePrivateJson(bytes));
  if (state.migration) {
    const marker = readPrivateFile(join(home, MIGRATION_FILE), { fs, optional: true });
    if (!marker) throw new LocalStateError("migration_required", "offline migration has not activated");
    const doc = parsePrivateJson(marker);
    if (doc.source_hash !== state.migration.source_hash || JSON.stringify(doc.identity) !== JSON.stringify(state.identity)) throw corrupt();
  }
  return state;
}

export function createHomeState(home, identity, { fs = nodeFs } = {}) {
  return withHomeLock(home, () => {
    if (readPrivateFile(join(home, STATE_FILE), { fs, optional: true })) throw new LocalStateError("already_initialized", "thin home is initialized");
    if (detectLegacyFiles(home, { fs }).length) throw new LocalStateError("migration_required", "offline legacy export is required");
    const state = newHomeState(identity);
    atomicPrivateWrite(join(home, STATE_FILE), JSON.stringify(state) + "\n", { fs });
    return state;
  }, { fs });
}

export function updateHomeState(home, change, { fs = nodeFs } = {}) {
  return withHomeLock(home, () => {
    const state = readHomeState(home, { fs }), identity = JSON.stringify(state.identity);
    const result = change(state);
    if (result && typeof result.then === "function") throw new LocalStateError("tx_async", "home mutation must be synchronous");
    if (JSON.stringify(state.identity) !== identity) throw new LocalStateError("key_mismatch", "thin home identity cannot change");
    validateHomeState(state);
    atomicPrivateWrite(join(home, STATE_FILE), JSON.stringify(state) + "\n", { fs });
    return result;
  }, { fs });
}

function validateCipher(entry, area) {
  if (!object(entry) || !isUuidV7(entry.msg_id) || typeof entry.body !== "string" || entry.body.length === 0
    || !["data", "control", "system"].includes(entry.kind)
    || (area === "held" && (!Number.isSafeInteger(entry.seq) || entry.seq < 0))
    || (entry.from != null && entry.from !== "relay" && !isMemberId(entry.from))
    || (entry.to != null && (!Array.isArray(entry.to) || !entry.to.every(isMemberId)))
    || (entry.state != null && !["pending", "sent", "failed"].includes(entry.state))
    || (entry.attempts != null && (!Number.isSafeInteger(entry.attempts) || entry.attempts < 0))
    || (entry.seq != null && (!Number.isSafeInteger(entry.seq) || entry.seq < 0))) throw corrupt();
  return entry;
}

export function cipherEntries(home, area, { fs = nodeFs } = {}) {
  const dir = join(home, area);
  privateStat(home, { fs, directory: true });
  if (!privateStat(dir, { fs, directory: true, optional: true })) return [];
  return fs.readdirSync(dir).filter(n => !n.startsWith(".")).sort().map(n => {
    if (!isUuidV7(n.slice(0, -5)) || !n.endsWith(".json")) throw corrupt();
    let bytes;
    try { bytes = readPrivateFile(join(dir, n), { fs, optional: true }); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
    if (!bytes) return null;
    const entry = validateCipher(parsePrivateJson(bytes), area);
    if (`${entry.msg_id}.json` !== n) throw corrupt();
    return entry;
  }).filter(Boolean).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
}

export function createCipherFiles(home, area, { fs = nodeFs } = {}) {
  if (!["held", "outbox"].includes(area)) throw new LocalStateError("invalid_input", "unknown ciphertext area");
  const options = { fs };
  const filename = id => {
    if (!isUuidV7(id)) throw new LocalStateError("invalid_input", "invalid ciphertext id");
    return join(home, area, `${id}.json`);
  };
  return {
    list: () => withHomeLock(home, () => cipherEntries(home, area, options), options),
    put(entry) {
      return withHomeLock(home, () => {
        validateCipher(entry, area); privateDirectory(join(home, area), options);
        const path = filename(entry.msg_id), prior = readPrivateFile(path, { fs, optional: true });
        if (prior) {
          if (JSON.stringify(validateCipher(parsePrivateJson(prior), area)) !== JSON.stringify(entry)) throw new LocalStateError("invalid_state", "ciphertext id already exists");
          syncPrivateFile(path, options);
          return false;
        }
        atomicPrivateWrite(path, JSON.stringify(entry) + "\n", options); return true;
      }, options);
    },
    update(id, patch, { when = () => true } = {}) {
      const allowed = ["attempts", "failures", "next_attempt_at", "retry_after_until", "state", "code", "seq", "sent_at", "lease_owner", "lease_until", ...(area === "held" ? ["legacy_state"] : [])];
      if (!object(patch) || Object.keys(patch).some(k => !allowed.includes(k))) throw new LocalStateError("invalid_input", "sealed ciphertext is immutable");
      if (Object.hasOwn(patch, "legacy_state") && patch.legacy_state !== "held") throw new LocalStateError("invalid_input", "invalid held transition");
      return withHomeLock(home, () => {
        const path = filename(id), prior = validateCipher(parsePrivateJson(readPrivateFile(path, options)), area);
        if (!when(prior)) return null;
        const entry = validateCipher({ ...prior, ...patch }, area);
        atomicPrivateWrite(path, JSON.stringify(entry) + "\n", options);
        return entry;
      }, options);
    },
    remove(id) { return withHomeLock(home, () => removePrivateFile(filename(id), options), options); },
  };
}

export function forgetThinMember(home, memberId, { yes = false, fs = nodeFs } = {}) {
  return withHomeLock(home, () => {
    const state = readHomeState(home, { fs }), member = state.members[memberId];
    if (!member || member.role !== "device") throw new LocalStateError("unknown_member", "unknown phone member");
    if (!["revoked", "rejected"].includes(member.state)) throw new LocalStateError("invalid_transition", "phone must have left the hub or been rejected; for a confirmed phone, run revoke <member_id>");
    const lines = inboxLines(home, { fs }), held = cipherEntries(home, "held", { fs }), outbox = cipherEntries(home, "outbox", { fs });
    const belongs = e => e.from === memberId || e.to?.includes(memberId);
    const counts = { inbox: lines.filter(l => l.record.from === memberId).length, held: held.filter(belongs).length, outbox: outbox.filter(belongs).length };
    if (!yes) return counts;
    member.state = "revoked"; member.pair_code = null; member.pair_proof = null;
    atomicPrivateWrite(join(home, STATE_FILE), JSON.stringify(state) + "\n", { fs });
    rewriteInbox(home, l => l.record.from !== memberId, { fs });
    for (const [area, entries] of [["held", held], ["outbox", outbox]]) {
      for (const e of entries.filter(belongs)) removePrivateFile(join(home, area, `${e.msg_id}.json`), { fs });
      if (privateStat(join(home, area), { fs, directory: true, optional: true })) syncDirectory(join(home, area), { fs });
    }
    return counts;
  }, { fs });
}
