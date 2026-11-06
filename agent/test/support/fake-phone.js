import { createHash } from "node:crypto";

import { loadJson } from "../../src/protocol-files.js";
import { createValidator } from "./validator.js";
import { generateKeyPair } from "../../src/crypto.js";
import { b64uDecode, b64uEncode, constantTimeEqual, formatTimestamp, utf8, utf8Decode } from "../../src/encoding.js";
import { openEnvelope, sealEnvelope, serializeEnvelope } from "./envelope.js";
import { fingerprint as computeFingerprint } from "../../src/fingerprint.js";
import { pairProof as computePairProof } from "../../src/pair-code.js";
import { parsePairUri } from "../../src/pair-uri.js";
import { parseRawInner } from "../../src/thin-transport.js";

export const MAX_INNER_BYTES = 180000;
const validator = await createValidator();
const writable = new Set(loadJson("types.json").types.filter(t => t.write).map(t => t.name));

export class FakePhoneError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = "FakePhoneError";
    this.code = code;
    this.status = status;
  }
}

const HOUR_MS = 3_600_000;
const HEART_RATE_STEP_MS = 10 * 60_000;
const HEALTH_SOURCE = Object.freeze({ app: "com.apple.Health", device: null });

export function deterministicUuid(label) {
  const hex = createHash("sha256").update(label).digest("hex").toUpperCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-A${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function sevenDaysOfStepsAndHeartRate({ now = new Date(), days = 7 } = {}) {
  const endMs = Math.floor(new Date(now).getTime() / HOUR_MS) * HOUR_MS;
  const startMs = endMs - days * 24 * HOUR_MS;
  const samples = [];
  for (let t = startMs, i = 0; t < endMs; t += HOUR_MS, i++) {
    samples.push({
      uuid: deterministicUuid(`steps-${t}`),
      type: "steps",
      value: 200 + ((i * 37) % 900),
      unit: "count",
      start: formatTimestamp(t),
      end: formatTimestamp(t + HOUR_MS),
      source: HEALTH_SOURCE,
    });
  }
  for (let t = startMs, i = 0; t < endMs; t += HEART_RATE_STEP_MS, i++) {
    samples.push({
      uuid: deterministicUuid(`heart_rate-${t}`),
      type: "heart_rate",
      value: 55 + ((i * 7) % 60),
      unit: "count/min",
      start: formatTimestamp(t),
      end: formatTimestamp(t),
      source: HEALTH_SOURCE,
    });
  }
  return samples;
}

const byteLength = (value) => utf8(JSON.stringify(value)).length;

export function chunkSync({ device, samples = [], deleted = [], acks = [], scope, chunkBytes = MAX_INNER_BYTES }) {
  const inner = (part, more) => ({
    v: 1, type: "sync", device, samples: part.samples, deleted: part.deleted, acks: part.acks, more, ...(scope && { scope }),
  });
  const empty = () => ({ samples: [], deleted: [], acks: [] });
  const chunks = [];
  let current = empty();
  let size = byteLength(inner(current, false));
  const add = (key, item) => {
    const itemBytes = byteLength(item) + (current[key].length > 0 ? 1 : 0);
    if (size + itemBytes > chunkBytes && current.samples.length + current.deleted.length + current.acks.length > 0) {
      chunks.push(current);
      current = empty();
      size = byteLength(inner(current, false));
    }
    const added = byteLength(item) + (current[key].length > 0 ? 1 : 0);
    if (size + added > chunkBytes) throw new Error(`a single ${key} element does not fit in ${chunkBytes} bytes`);
    current[key].push(item);
    size += added;
  };
  for (const s of samples) add("samples", s);
  for (const d of deleted) add("deleted", d);
  for (const a of acks) add("acks", a);
  chunks.push(current);
  return chunks.map((part, i) => JSON.stringify(inner(part, i < chunks.length - 1)));
}

export function createFakePhone({
  relayUrl,
  name = "Test iPhone",
  allowInsecureRelay = true,
  policy = {},
  fetch = globalThis.fetch,
  random,
} = {}) {
  const answered = new Map();
  const phone = {
    name,
    policy,
    relayBase: relayUrl ?? null,
    hubId: null,
    memberId: null,
    token: null,
    keys: null,
    publicKey: null,
    agentMemberId: null,
    agentPublicKey: null,
    pairSecret: null,
    members: [],
    applyCount: 0,
    appliedById: new Map(),
    sent: [],
    openFailures: [],
    controlReceived: [],
  };

  async function call(method, path, { body, token } = {}) {
    const headers = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json; charset=utf-8";
    if (token) headers.Authorization = `Bearer ${token}`;
    const payload = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
    const res = await fetch(`${phone.relayBase}${path}`, { method, headers, body: payload });
    const text = await res.text();
    let json = null;
    try {
      json = text === "" ? null : JSON.parse(text);
    } catch {
      json = null;
    }
    if (!res.ok) throw new FakePhoneError(json?.error ?? "relay_error", `relay ${res.status} ${json?.error ?? ""}`, res.status);
    return json;
  }

  const requirePaired = () => {
    if (!phone.token) throw new Error("fake phone is not paired");
  };
  const agentKey = () => b64uDecode(phone.agentPublicKey, { length: 32 });

  phone.pair = async (uri) => {
    const parsed = parsePairUri(uri, { allowInsecureRelay });
    if (!parsed.ok) throw new FakePhoneError(parsed.code, `bad pairing URI: ${parsed.code}${parsed.param ? ` (${parsed.param})` : ""}`);
    const { relayBase, hubId, pairingToken, agentPublicKey } = parsed.value;
    phone.relayBase = relayUrl ?? relayBase;
    phone.keys = await generateKeyPair();
    phone.publicKey = b64uEncode(phone.keys.publicKey);
    const res = await call("POST", "/v1/pair", {
      body: { hub_id: hubId, pairing_token: pairingToken, public_key: phone.publicKey, device_name: name },
    });
    phone.hubId = res.hub_id;
    phone.memberId = res.member_id;
    phone.token = res.token;
    phone.members = res.members;
    const expected = b64uDecode(agentPublicKey, { length: 32 });
    const agent = res.members.find(
      (m) => m.role === "agent" && constantTimeEqual(b64uDecode(m.public_key, { length: 32 }), expected),
    );
    if (!agent) {
      await call("DELETE", "/v1/members/me", { token: phone.token });
      throw new FakePhoneError("agent_key_mismatch", "no member with the agent key from the pairing URI");
    }
    phone.agentMemberId = agent.member_id;
    phone.agentPublicKey = agentPublicKey;
    phone.pairSecret = parsed.value.pairSecret ?? null;
    return { memberId: phone.memberId, agentMemberId: phone.agentMemberId };
  };

  phone.fingerprint = () => {
    if (!phone.agentPublicKey) throw new Error("fake phone is not paired");
    return computeFingerprint(phone.agentPublicKey, phone.publicKey).text;
  };

  phone.pairProof = ({ pairSecret = phone.pairSecret, devicePublicKey = phone.publicKey } = {}) => {
    if (!phone.agentPublicKey) throw new Error("fake phone is not paired");
    if (!pairSecret) throw new Error("fake phone has no pairing secret (v1 link)");
    return computePairProof(pairSecret, phone.agentPublicKey, devicePublicKey);
  };

  phone.sendPairProof = async ({ proof, ...options } = {}) =>
    phone.sendControl({ type: "pair_proof", proof: proof ?? phone.pairProof() }, options);

  phone.seal = async (plaintext, { kind = "data", msgId } = {}) => {
    requirePaired();
    const envelope = await sealEnvelope({
      hubId: phone.hubId,
      from: phone.memberId,
      recipients: [{ memberId: phone.agentMemberId, publicKey: agentKey() }],
      senderPrivateKey: phone.keys.privateKey,
      plaintext,
      kind,
      ...(msgId && { msgId }),
      random,
    });
    return serializeEnvelope(envelope);
  };

  phone.sendControl = async (fields, options = {}) => {
    const body = await phone.seal(JSON.stringify({ v: 1, ...fields }), { ...options, kind: "control" });
    return { ...(await phone.postEnvelope(body)), body };
  };

  phone.postEnvelope = async (body) => {
    requirePaired();
    const res = await call("POST", "/v1/messages", { body, token: phone.token });
    phone.sent.push({ msg_id: res.msg_id, seq: res.seq });
    return res;
  };

  phone.sendSync = async ({ samples = [], deleted = [], acks = [], scope, chunkBytes = MAX_INNER_BYTES } = {}) => {
    requirePaired();
    const inners = chunkSync({ device: phone.memberId, samples, deleted, acks, scope, chunkBytes });
    const out = [];
    for (const inner of inners) {
      const res = await phone.postEnvelope(await phone.seal(inner));
      out.push({ msg_id: res.msg_id, seq: res.seq, bytes: utf8(inner).length });
    }
    return out;
  };

  phone.fetchCommands = async () => {
    requirePaired();
    const commands = [];
    for (;;) {
      const page = await call("GET", "/v1/messages", { token: phone.token });
      for (const m of page.messages) {
        if (m.kind !== "data" && m.kind !== "control") continue;
        let plaintext;
        try {
          plaintext = await openEnvelope({
            envelope: m,
            hubId: phone.hubId,
            self: { memberId: phone.memberId, privateKey: phone.keys.privateKey },
            senderKeyOf: (from) => (from === phone.agentMemberId ? agentKey() : null),
          });
        } catch (err) {
          phone.openFailures.push({ seq: m.seq, code: err.code ?? "error" });
          continue;
        }
        try {
          const { inner } = parseRawInner(plaintext);
          if (m.kind === "control") phone.controlReceived.push({ seq: m.seq, msg_id: m.msg_id, ...inner });
          else if (inner.type === "commands" && validator.validate("inner-commands.schema.json", "commands", inner).ok) commands.push(...inner.commands);
          else phone.openFailures.push({ seq: m.seq, code: "inner_invalid" });
        } catch { phone.openFailures.push({ seq: m.seq, code: "inner_invalid" }); }
        finally { plaintext.fill(0); }
      }
      if (page.messages.length > 0) await call("POST", "/v1/acks", { body: { up_to_seq: page.next_after }, token: phone.token });
      if (page.has_more !== true) return commands;
    }
  };

  function decide(command) {
    const custom = policy.decide?.(command);
    if (custom) return custom;
    if (command.op === "write" && !writable.has(command.type)) return { status: "rejected", reason: "type_not_allowed" };
    return { status: "applied" };
  }

  phone.answer = async (commands, { send = true } = {}) => {
    const acks = [];
    for (const command of commands) {
      const key = `${command.command_id}:${command.version}`;
      let outcome = answered.get(key);
      if (!outcome) {
        outcome = decide(command);
        answered.set(key, outcome);
        if (outcome.status === "applied") {
          phone.applyCount++;
          phone.appliedById.set(command.command_id, (phone.appliedById.get(command.command_id) ?? 0) + 1);
        }
      }
      acks.push({
        command_id: command.command_id,
        version: command.version,
        status: outcome.status,
        ...(outcome.status === "rejected" && { reason: outcome.reason }),
      });
    }
    if (send && acks.length > 0) await phone.sendSync({ acks });
    return acks;
  };

  phone.revokeSelf = async () => {
    requirePaired();
    await call("DELETE", "/v1/members/me", { token: phone.token });
  };

  return phone;
}
