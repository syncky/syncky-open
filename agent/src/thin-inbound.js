import { completeResponseWaits, maintainResponseWaits } from "./response-waits.js";
import { join } from "node:path";
import { LocalStateError } from "./config.js";
import { b64uDecode, isB64u } from "./encoding.js";
import { EnvelopeError } from "./thin-transport.js";
import { cipherEntries, createCipherFiles, readHomeState, STATE_FILE, updateHomeState, validateHomeState } from "./home-state.js";
import { appendInboxLocked, admissionInboxSequence, createInboxAdmission, refreshInboxAdmission, iterateInbox, inboxMetadata, INBOX_SEEN_RETENTION_MS, INBOX_SEEN_CLOCK_SKEW_MS, INBOX_SEEN_MAX_IDS, INBOX_SEEN_PROTECTED_MS, INBOX_SEEN_MAX_RECENT_IDS } from "./inbox.js";
import { isMemberId, isUuidV7, uuidv7, uuidv7Timestamp } from "./ids.js";
import { createThinPairing, validateMemberPairing } from "./thin-pairing.js";
import { retryHomeLock } from "./thin-lock.js";
import { recordPairingReply } from './pairing-access.js';
import { settleScopeRelease } from './scope-release.js';
import { atomicPrivateWrite, privateDirectory, privateStat, removePrivateFile, syncDirectory, syncPrivateFile, withHomeLock } from "./protected-files.js";
import metadata from "../package.json" with { type: "json" };

export const THIN_HELD_LIMITS = Object.freeze({ rows: 2000, bytes: 64 * 1024 * 1024 });

export function createThinInbound({ home, transport, self, relay, fs, now = () => new Date(), heldLimits = THIN_HELD_LIMITS, onRecord, version = metadata.version }) {
  const options = { fs }, held = createCipherFiles(home, "held", options), outbox = createCipherFiles(home, "outbox", options), pairing = createThinPairing(home, { fs, now });
  const poison = code => ({ status: "poison", code });
  function check({ signal, deadline = Infinity } = {}) {
    signal?.throwIfAborted();
    if (now().getTime() >= deadline) throw new LocalStateError("timeout", "receive deadline reached");
  }
  const locked = (operation, context) => retryHomeLock(() => { check(context); return operation(); });
  const mutate = (change, context) => locked(() => updateHomeState(home, change, options), context);
  async function trimHeld(context) {
    if (!(await locked(() => cipherEntries(home, "held", options), context)).length) {
      if (privateStat(join(home, "held"), { ...options, directory: true, optional: true })) syncDirectory(join(home, "held"), options);
      return { dropped: [], entries: [] };
    }
    return locked(() => withHomeLock(home, () => {
      syncDirectory(join(home, "held"), options);
      const state = readHomeState(home, options), entries = cipherEntries(home, "held", options), groups = new Map(), dropped = [];
      for (const entry of entries) {
        const id = entry.from ?? entry.held_member;
        if (entry.kind === "system" || entry.legacy_state === "new" || state.members[id]?.state !== "joined") continue;
        if (!groups.has(id)) groups.set(id, []);
        groups.get(id).push(entry);
      }
      for (const [id, entries] of groups) {
        let bytes = entries.reduce((total, e) => total + Buffer.byteLength(e.body), 0), count = entries.length;
        for (const entry of entries) {
          if (count <= heldLimits.rows && bytes <= heldLimits.bytes) break;
          dropped.push({ ...entry, member_id: id }); count--; bytes -= Buffer.byteLength(entry.body);
        }
      }
      if (dropped.length) {
        const events = state.transport.events ?? [];
        for (const e of dropped) if (!events.some(prior => prior.seq === e.seq && prior.code === "held_overflow")) {
          events.push({ seq: e.seq, member_id: e.member_id, status: "poison", code: "held_overflow" });
        }
        state.transport.events = events.slice(-100);
        atomicPrivateWrite(join(home, STATE_FILE), JSON.stringify(validateHomeState(state)) + "\n", options);
        for (const entry of dropped) removePrivateFile(join(home, "held", `${entry.msg_id}.json`), options);
      }
      const removed = new Set(dropped.map(entry => entry.msg_id));
      return { dropped, entries: entries.filter(entry => !removed.has(entry.msg_id)) };
    }, options), context);
  }
  const bindingOf = record => `${record.from}:${record.public_key}`;
  function trusted(state, record) {
    const member = state.members[record.from];
    return member?.public_key === record.public_key && (member.state === "confirmed" || member.state === "joined" && !member.proof_invalidated)
      && ![true, "1"].includes(state.transport.hub_revoked) && ![true, "1"].includes(state.transport.hub_deleted);
  }
  function seenIds(state, record, receivedAt) {
    const seen = state.transport.inbox_seen ??= {}, at = Math.max(state.transport.inbox_seen_at ?? 0, receivedAt, now().getTime());
    state.transport.inbox_seen_at = at;
    const ageFloor = at - INBOX_SEEN_RETENTION_MS - INBOX_SEEN_CLOCK_SKEW_MS;
    const floors = state.transport.inbox_seen_floor ?? {};
    const stale = (binding, id) => uuidv7Timestamp(id) <= Math.max(floors[binding] ?? -1, ageFloor);
    for (const [binding, ids] of Object.entries(seen)) {
      for (const id of Object.keys(ids)) if (stale(binding, id)) delete ids[id];
      if (!Object.keys(ids).length) delete seen[binding];
    }
    const binding = bindingOf(record), ids = seen[binding] ??= {};
    return { ids, count: Object.keys(ids).length, stale: stale(binding, record.msg_id) };
  }
  function trimSeenIds(state, record) {
    const binding = bindingOf(record), ids = state.transport.inbox_seen[binding];
    const keys = Object.keys(ids);
    if (keys.length <= INBOX_SEEN_MAX_IDS) return;
    const times = keys.map(uuidv7Timestamp).sort((a, b) => a - b);
    const floor = Math.min(times[times.length - INBOX_SEEN_MAX_IDS - 1], state.transport.inbox_seen_at - INBOX_SEEN_PROTECTED_MS - 1);
    if (times[0] > floor) return;
    (state.transport.inbox_seen_floor ??= {})[binding] = Math.max(state.transport.inbox_seen_floor?.[binding] ?? -1, floor);
    for (const id of Object.keys(ids)) if (uuidv7Timestamp(id) <= floor) delete ids[id];
  }
  function applyRecord(state, record) {
    const { inner, from, public_key, seq, accepted_at } = record, member = state.members[from];
    if (member.state === "joined") {
      if (inner.type !== "pair_proof" || inner.v !== 1 || !isB64u(inner.proof, { length: 32 })) throw new LocalStateError("invalid_state", "inbox sender is unconfirmed");
      if (!pairing.confirmProofInState(state, from, inner.proof, new Date(accepted_at))) return false;
    }
    if (inner.type === "access_reply") recordPairingReply(state, from, public_key, inner);
    completeResponseWaits(state, from, public_key, inner, accepted_at, record);
    if (inner.type === "unpair" && inner.v === 1 && ["user", "reset", "replaced", "delete_relay_data"].includes(inner.reason)) {
      member.unpair_reason ??= inner.reason; maintainResponseWaits(state, accepted_at);
    }
    if (inner.type === "sync" && inner.scope && typeof inner.scope === "object") {
      const valid = side => side === "all" || side === "none" || (Array.isArray(side) && side.length <= 1000 && side.every(v => typeof v === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(v)));
      if (valid(inner.scope.read) && valid(inner.scope.write)) member.scope = { read: inner.scope.read, write: inner.scope.write, seq };
    }
    if (inner.type === "sync" && member.scope_release && !["applied", "failed"].includes(member.scope_release.state)) {
      settleScopeRelease(member, seq, cipherEntries(home, "outbox", options));
    }
    if (inner.type === "sync" && inner.more === false && state.transport.fast_poll?.devices) {
      state.transport.fast_poll.devices = state.transport.fast_poll.devices.filter(id => id !== from);
    }
    return true;
  }
  function* tail(state, view) {
    const legacy = state.transport.inbox_committed_cursor === undefined;
    if (legacy) {
      if (view) refreshInboxAdmission(home, view, options);
      state.transport.inbox_committed_cursor = view ? view.legacy : Math.max(-1, ...inboxMetadata(home, options).map(({ index }) => index.legacy));
    }
    for (const line of iterateInbox(home, { ...options, view, refresh: !legacy, afterSeq: state.transport.inbox_committed_cursor })) {
      if (line.record.msg_id !== undefined) yield line;
    }
  }
  function reconcileState(state, emitted, limit = Infinity, view) {
    let count = 0;
    for (const { record, name } of tail(state, view)) {
      syncPrivateFile(join(home, "inbox", name), options);
      if (trusted(state, record)) {
        const { ids, stale } = seenIds(state, record, record.accepted_at);
        if (!stale && ids[record.msg_id] === undefined) {
          if (applyRecord(state, record)) {
            ids[record.msg_id] = state.transport.inbox_seen_at; trimSeenIds(state, record); emitted.push(record);
          }
        }
      }
      state.transport.inbox_committed_cursor = record.cursor;
      if (++count >= limit) break;
    }
    return count;
  }
  async function reconcile(context) {
    for (;;) {
      const emitted = [];
      const count = await locked(() => {
        emitted.length = 0;
        const state = readHomeState(home, options), rows = tail(state);
        try { if (rows.next().done) return 0; } finally { rows.return(); }
        return updateHomeState(home, s => reconcileState(s, emitted, 128), options);
      }, context);
      for (const record of emitted) onRecord?.(record);
      if (count < 128) return;
    }
  }
  async function admit(record, innerText, context) {
    const emitted = [];
    const result = await mutate(state => {
      emitted.length = 0;
      const view = createInboxAdmission({ legacy: state.transport.inbox_committed_cursor === undefined });
      reconcileState(state, emitted, Infinity, view);
      if (!trusted(state, record)) return poison("unknown_sender");
      admissionInboxSequence(home, record, { ...options, view });
      record = { ...record, accepted_at: now().getTime() };
      const { ids, count, stale } = seenIds(state, record, record.accepted_at), at = state.transport.inbox_seen_at;
      if (stale) return poison("expired");
      if (ids[record.msg_id] !== undefined) {
        const existing = admissionInboxSequence(home, record, { ...options, view });
        if (existing) syncPrivateFile(join(home, "inbox", existing.name), options);
        ids[record.msg_id] = Math.max(ids[record.msg_id], at);
        return { status: "duplicate", type: record.type };
      }
      if (count >= INBOX_SEEN_MAX_RECENT_IDS) {
        trimSeenIds(state, record);
        if (Object.keys(ids).length >= INBOX_SEEN_MAX_RECENT_IDS) throw new LocalStateError("inbox_seen_limit", "sender replay protection capacity reached");
      }
      if (state.members[record.from].state === "joined" && (record.kind !== "control" || record.inner.type !== "pair_proof" || record.inner.v !== 1 || !isB64u(record.inner.proof, { length: 32 }))) return poison("unknown_sender");
      // A failed proof must invalidate trust without creating an accepted inbox row.
      if (state.members[record.from].state === "joined" && !pairing.confirmProofInState(state, record.from, record.inner.proof, new Date(record.accepted_at))) return poison("pair_proof_invalid");
      const appended = appendInboxLocked(home, record, { ...options, innerText, view }), accepted = appended.record;
      if (accepted.msg_id !== undefined && accepted.cursor > state.transport.inbox_committed_cursor) {
        applyRecord(state, accepted); emitted.push(accepted);
      }
      ids[record.msg_id] = Math.max(accepted.accepted_at ?? at, at);
      trimSeenIds(state, record);
      state.transport.inbox_committed_cursor = Math.max(state.transport.inbox_committed_cursor, accepted.cursor ?? accepted.seq);
      return { status: "stored", type: record.type };
    }, context);
    for (const accepted of emitted) onRecord?.(accepted);
    return result;
  }
  async function queueConfirmations(context) {
    check(context);
    const state = await locked(() => readHomeState(home, options), context);
    for (const member of Object.values(state.members).filter(m => m.state === "confirmed" && m.confirmation)) {
      const pending = member.confirmation;
      let entry = (await locked(() => outbox.list(), context)).find(e => e.msg_id === pending.msg_id);
      if (!entry) {
        const envelope = await locked(() => transport.sealMessage({ hubId: state.identity.hub_id, from: self.memberId, senderPrivateKey: self.privateKey,
          recipients: [{ memberId: member.member_id, publicKey: b64uDecode(member.public_key) }], innerText: '{"v":1,"type":"confirmed"}', msgId: pending.msg_id, createdAt: pending.created_at }), context);
        entry = await locked(() => ({ msg_id: envelope.msg_id, kind: envelope.kind, type: "confirmed", to: [member.member_id], lane: transport.lane(envelope), body: transport.serialize(envelope), state: "pending", attempts: 0, next_attempt_at: 0 }), context);
      }
      await locked(() => withHomeLock(home, () => {
        const current = readHomeState(home, options);
        if (current.members[member.member_id]?.confirmation?.msg_id !== pending.msg_id) return;
        const prior = cipherEntries(home, "outbox", options).find(e => e.msg_id === pending.msg_id);
        if (prior) syncPrivateFile(join(home, "outbox", `${prior.msg_id}.json`), options);
        else {
          privateDirectory(join(home, "outbox"), options);
          atomicPrivateWrite(join(home, "outbox", `${entry.msg_id}.json`), JSON.stringify(entry) + "\n", options);
        }
        delete current.members[member.member_id].confirmation;
        atomicPrivateWrite(join(home, STATE_FILE), JSON.stringify(validateHomeState(current)) + "\n", options);
      }, options), context);
    }
  }
  async function queueAgentInfo(context) {
    const eligible = (state, member) => member?.role === "device" && member.state === "confirmed" && member.unpair_reason == null
      && member.agent_info_version !== version && ![true, "1"].includes(state.transport.hub_revoked) && ![true, "1"].includes(state.transport.hub_deleted);
    const matches = (entry, id) => entry.type === "agent_info" && entry.agent_version === version && entry.to?.length === 1 && entry.to[0] === id;
    const state = await locked(() => readHomeState(home, options), context);
    for (const member of Object.values(state.members).filter(m => eligible(state, m))) {
      check(context);
      let entry = (await locked(() => outbox.list(), context)).find(e => matches(e, member.member_id));
      if (!entry) {
        const at = now();
        const envelope = await locked(() => transport.sealMessage({ hubId: state.identity.hub_id, from: self.memberId, senderPrivateKey: self.privateKey,
          recipients: [{ memberId: member.member_id, publicKey: b64uDecode(member.public_key) }],
          innerText: JSON.stringify({ v: 1, type: "agent_info", version }), msgId: uuidv7({ now: () => at.getTime() }), createdAt: at.toISOString() }), context);
        entry = await locked(() => ({ msg_id: envelope.msg_id, kind: envelope.kind, type: "agent_info", agent_version: version, to: [member.member_id], lane: transport.lane(envelope), body: transport.serialize(envelope), state: "pending", attempts: 0, next_attempt_at: 0 }), context);
      }
      await locked(() => withHomeLock(home, () => {
        const current = readHomeState(home, options);
        if (!eligible(current, current.members[member.member_id])) return;
        const prior = cipherEntries(home, "outbox", options).find(e => matches(e, member.member_id));
        if (prior) syncPrivateFile(join(home, "outbox", `${prior.msg_id}.json`), options);
        else {
          privateDirectory(join(home, "outbox"), options);
          atomicPrivateWrite(join(home, "outbox", `${entry.msg_id}.json`), JSON.stringify(entry) + "\n", options);
        }
        current.members[member.member_id].agent_info_version = version;
        atomicPrivateWrite(join(home, STATE_FILE), JSON.stringify(validateHomeState(current)) + "\n", options);
      }, options), context);
    }
  }
  async function system(message, context) {
    const body = message.body ?? {}, id = body.member_id;
    if (["hub_suspended", "hub_resumed", "hub_deleting"].includes(message.event)) {
      await mutate(s => { s.transport.hub_state_refresh = true; s.transport.hub_state_revision = (s.transport.hub_state_revision ?? 0) + 1; }, context);
      return { status: "metadata", code: "relay_event" };
    }
    if (!["member_joined", "member_revoked"].includes(message.event) || !isMemberId(id)) return { status: "metadata", code: "relay_event" };
    if (!relay?.listMembers) throw new LocalStateError("invalid_response", "member reconciliation is required");
    let listed;
    try { listed = await relay.listMembers({ retry: false, ...context }); }
    catch (e) {
      if (e.code !== "invalid_token" || id !== self.memberId) throw e;
      listed = { members: [] };
    }
    check(context);
    if (!Array.isArray(listed?.members) || listed.members.some(m => !isMemberId(m?.member_id))) throw new LocalStateError("invalid_response", "invalid member reconciliation");
    const member = listed.members.find(m => m.member_id === id);
    if (message.event === "member_joined" && member?.role === "device" && member.public_key === body.public_key && isB64u(member.public_key, { length: 32 })) {
      validateMemberPairing(body); validateMemberPairing(member);
      await locked(() => pairing.join({ ...member, pairing_id: member.pairing_id ?? body.pairing_id }, { verified: true }), context);
    }
    if (message.event === "member_revoked" && !member) {
      await releaseHeld({ ...context, beforeSeq: message.seq });
      if (id === self.memberId) await mutate(s => { s.transport.hub_revoked = true; }, context);
      else if ((await locked(() => readHomeState(home, options), context)).members[id]) await locked(() => pairing.revoke(id), context);
    }
    return { status: "metadata", code: "relay_event" };
  }
  async function receive(message, { receivedAt = now().toISOString(), releasing = false, signal, deadline } = {}) {
    const context = { signal, deadline }; check(context);
    await reconcile(context);
    if (!Number.isSafeInteger(message?.seq) || message.seq < 0) return poison("malformed");
    if (message.kind === "system") return (await locked(() => transport.hasMarker(message), context)) ? poison("malformed") : system(message, context);
    const { seq, ...envelope } = message;
    if (!isUuidV7(envelope.msg_id) || (await locked(() => transport.validateShape(envelope, { caller: envelope.from, allowUnknown: true }), context)).status !== 201) return poison("malformed");
    const state = await locked(() => readHomeState(home, options), context), member = state.members[envelope.from];
    if (!member || ["revoked", "rejected"].includes(member.state) || [true, "1"].includes(state.transport.hub_revoked) || [true, "1"].includes(state.transport.hub_deleted)) return poison("unknown_sender");
    let parsed;
    if (member.state === "joined") {
      if (envelope.kind === "control" && !member.proof_invalidated) {
        try { parsed = await locked(() => transport.receive({ envelope, hubId: state.identity.hub_id, self, senderKeyOf: id => id === member.member_id ? b64uDecode(member.public_key) : null }), context); }
        catch (e) { if (!(e instanceof EnvelopeError)) throw e; }
      }
      if (parsed?.inner.type === "pair_proof" && parsed.inner.v === 1 && isB64u(parsed.inner.proof, { length: 32 })) {
        const result = await admit({ seq, msg_id: envelope.msg_id, public_key: member.public_key, from: envelope.from,
          kind: envelope.kind, type: parsed.inner.type, received_at: receivedAt, inner: parsed.inner }, parsed.innerText, context);
        if (result.status === "stored") await releaseHeld({ ...context, beforeSeq: seq });
        return result;
      }

      await locked(() => {
        const prior = held.list().find(e => e.msg_id === envelope.msg_id), body = transport.serialize(envelope);
        if (prior && ((prior.body !== body && transport.serialize(JSON.parse(prior.body)) !== body) || prior.seq !== seq || prior.from !== envelope.from)) throw new LocalStateError("invalid_state", "held envelope conflict");
        held.put(prior ?? { msg_id: envelope.msg_id, seq, from: envelope.from, kind: envelope.kind, body, received_at: receivedAt });
        if (prior?.legacy_state === "new") held.update(prior.msg_id, { legacy_state: "held" });
      }, context);
      if ((await trimHeld(context)).dropped.some(e => e.msg_id === envelope.msg_id)) return poison("held_overflow");
      return { status: "held", code: "held_unconfirmed" };
    }
    try {
      const key = await locked(() => pairing.trustedKey(envelope.from), context);
      parsed = await locked(() => transport.receive({ envelope, hubId: state.identity.hub_id, self,
        senderKeyOf: id => id === envelope.from && key ? b64uDecode(key) : null }), context);
    } catch (e) { if (e instanceof EnvelopeError) return poison(e.code); throw e; }
    check(context);
    const { inner, innerText } = parsed;
    const fresh = (await locked(() => readHomeState(home, options), context)).members[envelope.from];
    if (fresh?.state !== "confirmed" || fresh.public_key !== member.public_key) return poison("unknown_sender");
    const result = await admit({ seq, msg_id: envelope.msg_id, public_key: member.public_key, from: envelope.from,
      kind: envelope.kind, type: inner.type, received_at: receivedAt, inner }, innerText, context);
    return result.status === "stored" ? { ...result, releasing } : result;
  }

  async function releaseHeld({ beforeSeq = Infinity, signal, deadline } = {}) {
    const context = { signal, deadline };
    await reconcile(context);
    await queueConfirmations(context);
    await queueAgentInfo(context);
    const { entries } = await trimHeld(context);
    for (const entry of entries) {
      check(context);
      if (entry.seq >= beforeSeq) continue;
      const state = await locked(() => readHomeState(home, options), context), member = state.members[entry.from];
      if (entry.kind !== "system" && entry.legacy_state !== "new" && member?.state === "joined") continue;
      let message, result;
      try { message = JSON.parse(entry.body); }
      catch { result = poison("malformed"); }
      result ??= await receive({ ...message, seq: entry.seq }, { ...context, receivedAt: entry.received_at ?? now().toISOString(), releasing: true });
      if (result.status === "held") continue;
      if (["poison", "metadata"].includes(result.status)) await mutate(s => {
        s.transport.events = [...(s.transport.events ?? []).filter(e => e.seq !== entry.seq), { seq: entry.seq, status: result.status, code: result.code }].slice(-100);
      }, context);
      await locked(() => held.remove(entry.msg_id), context);
    }
  }
  return { receive, releaseHeld, reconcile };
}
