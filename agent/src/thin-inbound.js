import { join } from "node:path";
import { LocalStateError } from "./config.js";
import { b64uDecode, isB64u } from "./encoding.js";
import { EnvelopeError } from "./thin-transport.js";
import { cipherEntries, createCipherFiles, readHomeState, STATE_FILE, updateHomeState, validateHomeState } from "./home-state.js";
import { createInbox } from "./inbox.js";
import { isMemberId, isUuidV7, uuidv7 } from "./ids.js";
import { createThinPairing } from "./thin-pairing.js";
import { retryHomeLock } from "./thin-lock.js";
import { atomicPrivateWrite, privateDirectory, privateStat, removePrivateFile, syncDirectory, syncPrivateFile, withHomeLock } from "./protected-files.js";
import metadata from "../package.json" with { type: "json" };

export const THIN_HELD_LIMITS = Object.freeze({ rows: 2000, bytes: 64 * 1024 * 1024 });

export function createThinInbound({ home, transport, self, relay, fs, now = () => new Date(), heldLimits = THIN_HELD_LIMITS, onRecord, version = metadata.version }) {
  const options = { fs }, inbox = createInbox(home, options), held = createCipherFiles(home, "held", options), outbox = createCipherFiles(home, "outbox", options), pairing = createThinPairing(home, { fs, now });
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
  async function appendRecord(record, innerText, context) {
    const result = await locked(() => inbox.append(record, { innerText }), context);
    if (result.inserted) onRecord?.(record);
  }
  async function queueConfirmations(context) {
    check(context);
    const state = readHomeState(home, options);
    for (const member of Object.values(state.members).filter(m => m.state === "confirmed" && m.confirmation)) {
      const pending = member.confirmation;
      let entry = (await locked(() => outbox.list(), context)).find(e => e.msg_id === pending.msg_id);
      if (entry) {
        await locked(() => withHomeLock(home, () => syncPrivateFile(join(home, "outbox", `${pending.msg_id}.json`), options), options), context);
      } else {
        const envelope = await transport.sealMessage({ hubId: state.identity.hub_id, from: self.memberId, senderPrivateKey: self.privateKey,
          recipients: [{ memberId: member.member_id, publicKey: b64uDecode(member.public_key) }], innerText: '{"v":1,"type":"confirmed"}', msgId: pending.msg_id, createdAt: pending.created_at });
        entry = { msg_id: envelope.msg_id, kind: envelope.kind, type: "confirmed", to: [member.member_id], lane: transport.lane(envelope), body: transport.serialize(envelope), state: "pending", attempts: 0, next_attempt_at: 0 };
        await locked(() => outbox.put(entry), context);
      }
      await mutate(s => { if (s.members[member.member_id]?.confirmation?.msg_id === pending.msg_id) delete s.members[member.member_id].confirmation; }, context);
    }
  }
  async function queueAgentInfo(context) {
    const eligible = (state, member) => member?.role === "device" && member.state === "confirmed" && member.unpair_reason == null
      && member.agent_info_version !== version && ![true, "1"].includes(state.transport.hub_revoked) && ![true, "1"].includes(state.transport.hub_deleted);
    const matches = (entry, id) => entry.type === "agent_info" && entry.agent_version === version && entry.to?.length === 1 && entry.to[0] === id;
    const state = readHomeState(home, options);
    for (const member of Object.values(state.members).filter(m => eligible(state, m))) {
      check(context);
      let entry = (await locked(() => outbox.list(), context)).find(e => matches(e, member.member_id));
      if (!entry) {
        const at = now();
        const envelope = await transport.sealMessage({ hubId: state.identity.hub_id, from: self.memberId, senderPrivateKey: self.privateKey,
          recipients: [{ memberId: member.member_id, publicKey: b64uDecode(member.public_key) }],
          innerText: JSON.stringify({ v: 1, type: "agent_info", version }), msgId: uuidv7({ now: () => at.getTime() }), createdAt: at.toISOString() });
        entry = { msg_id: envelope.msg_id, kind: envelope.kind, type: "agent_info", agent_version: version, to: [member.member_id], lane: transport.lane(envelope), body: transport.serialize(envelope), state: "pending", attempts: 0, next_attempt_at: 0 };
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
      await locked(() => pairing.join({ ...member, pairing_id: member.pairing_id ?? body.pairing_id }, { verified: true }), context);
    }
    if (message.event === "member_revoked" && !member) {
      await releaseHeld({ ...context, beforeSeq: message.seq });
      if (id === self.memberId) await mutate(s => { s.transport.hub_revoked = true; }, context);
      else if (readHomeState(home, options).members[id]) await locked(() => pairing.revoke(id), context);
    }
    return { status: "metadata", code: "relay_event" };
  }
  async function receive(message, { receivedAt = now().toISOString(), releasing = false, signal, deadline } = {}) {
    const context = { signal, deadline }; check(context);
    if (!Number.isSafeInteger(message?.seq) || message.seq < 0) return poison("malformed");
    if (message.kind === "system") return transport.hasMarker(message) ? poison("malformed") : system(message, context);
    const { seq, ...envelope } = message;
    if (!isUuidV7(envelope.msg_id) || transport.validateShape(envelope, { caller: envelope.from, allowUnknown: true }).status !== 201) return poison("malformed");
    const state = readHomeState(home, options), member = state.members[envelope.from];
    if (!member || ["revoked", "rejected"].includes(member.state) || [true, "1"].includes(state.transport.hub_revoked) || [true, "1"].includes(state.transport.hub_deleted)) return poison("unknown_sender");
    let parsed;
    if (member.state === "joined") {
      if (envelope.kind === "control" && !member.proof_invalidated) {
        try { parsed = await transport.receive({ envelope, hubId: state.identity.hub_id, self, senderKeyOf: id => id === member.member_id ? b64uDecode(member.public_key) : null }); }
        catch (e) { if (!(e instanceof EnvelopeError)) throw e; }
      }
      if (parsed?.inner.type === "pair_proof" && parsed.inner.v === 1 && isB64u(parsed.inner.proof, { length: 32 })) {
        try { await locked(() => pairing.confirmProof(envelope.from, parsed.inner.proof), context); }
        catch (e) { if (e.code === "pair_proof_invalid") return poison(e.code); throw e; }
        await appendRecord({ seq, from: envelope.from, kind: envelope.kind, type: parsed.inner.type, received_at: receivedAt, inner: parsed.inner }, parsed.innerText, context);
        await releaseHeld({ ...context, beforeSeq: seq });
        return { status: "stored", type: "pair_proof" };
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
      parsed = await transport.receive({ envelope, hubId: state.identity.hub_id, self, senderKeyOf: id => {
        const key = pairing.trustedKey(id); return key ? b64uDecode(key) : null;
      } });
    } catch (e) { if (e instanceof EnvelopeError) return poison(e.code); throw e; }
    check(context);
    const { inner, innerText } = parsed;
    const fresh = readHomeState(home, options).members[envelope.from];
    if (fresh?.state !== "confirmed" || fresh.public_key !== member.public_key) return poison("unknown_sender");
    await appendRecord({ seq, from: envelope.from, kind: envelope.kind, type: inner.type, received_at: receivedAt, inner }, innerText, context);
    if (inner.type === "unpair" && inner.v === 1 && ["user", "reset", "replaced", "delete_relay_data"].includes(inner.reason)) {
      await mutate(s => { s.members[envelope.from].unpair_reason ??= inner.reason; }, context);
    }
    if (inner.type === "sync" && inner.scope && typeof inner.scope === "object") {
      const valid = side => side === "all" || side === "none" || (Array.isArray(side) && side.length <= 1000 && side.every(v => typeof v === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(v)));
      if (valid(inner.scope.read) && valid(inner.scope.write)) await mutate(s => { s.members[envelope.from].scope = { read: inner.scope.read, write: inner.scope.write, seq }; }, context);
    }
    if (inner.type === "sync" && inner.more === false) await mutate(s => {
      const fast = s.transport.fast_poll;
      if (fast?.devices) fast.devices = fast.devices.filter(id => id !== envelope.from);
    }, context);
    return { status: "stored", type: inner.type, releasing };
  }
  async function releaseHeld({ beforeSeq = Infinity, signal, deadline } = {}) {
    const context = { signal, deadline };
    await queueConfirmations(context);
    await queueAgentInfo(context);
    const { entries } = await trimHeld(context);
    for (const entry of entries) {
      check(context);
      if (entry.seq >= beforeSeq) continue;
      const state = readHomeState(home, options), member = state.members[entry.from];
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
  return { receive, releaseHeld };
}
