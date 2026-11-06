import { createHash, createHmac, randomBytes } from "node:crypto";
import { createServer } from "node:http";

import { b64uEncode, formatTimestamp, isB64u } from "../../src/encoding.js";
import { validateEnvelopeText } from "./envelope.js";
import { HUB_ID_RE, PAIRING_TOKEN_RE, TOKEN_RE, uuidv7 } from "../../src/ids.js";

const STATUS_CODES = {
  invalid_request: 400,
  invalid_envelope: 400,
  invalid_token: 401,
  hub_unpaid: 402,
  hub_suspended: 402,
  invalid_invite: 403,
  forbidden: 403,
  not_found: 404,
  pairing_not_found: 404,
  unknown_recipient: 404,
  method_not_allowed: 405,
  msg_id_conflict: 409,
  hub_full: 409,
  pairing_expired: 410,
  payload_too_large: 413,
  unsupported_media_type: 415,
  rate_limited: 429,
  internal_error: 500,
};

const DEFAULT_CODE_FOR_STATUS = {
  400: "invalid_request",
  401: "invalid_token",
  403: "forbidden",
  404: "not_found",
  405: "method_not_allowed",
  409: "msg_id_conflict",
  410: "pairing_expired",
  413: "payload_too_large",
  415: "unsupported_media_type",
  429: "rate_limited",
};

const ROUTES = [
  { name: "health", method: "GET", re: /^\/v1\/health$/, auth: false },
  { name: "register", method: "POST", re: /^\/v1\/agents\/register$/, auth: false },
  { name: "createPairing", method: "POST", re: /^\/v1\/pairings$/, auth: true },
  { name: "getPairing", method: "GET", re: /^\/v1\/pairings\/([^/]+)$/, auth: true },
  { name: "pair", method: "POST", re: /^\/v1\/pair$/, auth: false },
  { name: "listMembers", method: "GET", re: /^\/v1\/members$/, auth: true },
  { name: "updateWebhook", method: "PATCH", re: /^\/v1\/members\/me$/, auth: true },
  { name: "deleteSelf", method: "DELETE", re: /^\/v1\/members\/me$/, auth: true },
  { name: "rotateWebhookSecret", method: "POST", re: /^\/v1\/members\/me\/webhook-secret$/, auth: true },
  { name: "revokeMember", method: "DELETE", re: /^\/v1\/members\/([^/]+)$/, auth: true },
  { name: "postMessage", method: "POST", re: /^\/v1\/messages$/, auth: true },
  { name: "getMessages", method: "GET", re: /^\/v1\/messages$/, auth: true },
  { name: "ack", method: "POST", re: /^\/v1\/acks$/, auth: true },
  { name: "hubState", method: "GET", re: /^\/v1\/hub\/state$/, auth: true },
  { name: "heartbeat", method: "POST", re: /^\/v1\/agents\/heartbeat$/, auth: true },
];

const ROUTE_ALIASES = {
  E0: "health",
  E1: "register",
  E2: "createPairing",
  E3: "getPairing",
  E4: "pair",
  E5: "listMembers",
  E6: "updateWebhook",
  E7: "rotateWebhookSecret",
  E8: "deleteSelf",
  E9: "revokeMember",
  E10: "postMessage",
  E11: "getMessages",
  E12: "ack",
  E14: "hubState",
  E15: "heartbeat",
};

const MAX_ENVELOPE_BYTES = 262_144;
const MAX_CONTROL_BODY_BYTES = 16_384;
const MAX_PAGE_LIMIT = 100;
const UNPAID_DELETE_AFTER_MS = 7 * 86_400_000;
const MAX_NAME_CODE_POINTS = 64;
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f-\u009f]/;
const FORMAT_CHAR_RE = /\p{Cf}/u;
const QUERY_INT_RE = /^[0-9]+$/;

class ApiError extends Error {
  constructor(code, details, headers) {
    super(code);
    this.code = code;
    this.status = STATUS_CODES[code];
    this.details = details;
    this.headers = headers;
  }
}

const b64uRandom = (n) => b64uEncode(new Uint8Array(randomBytes(n)));
const sha256Hex = (text) => createHash("sha256").update(text).digest("hex");
const routeName = (route) => ROUTE_ALIASES[route] ?? route;

function invalid(field) {
  return new ApiError("invalid_request", { field });
}

function parseObject(text, code) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ApiError(code, code === "invalid_envelope" ? { field: "" } : undefined);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(code, code === "invalid_envelope" ? { field: "" } : undefined);
  }
  return value;
}

function validateName(value, field) {
  if (typeof value !== "string") throw invalid(field);
  const trimmed = value.trim();
  const length = [...trimmed].length;
  if (length < 1 || length > MAX_NAME_CODE_POINTS || CONTROL_CHAR_RE.test(trimmed) || FORMAT_CHAR_RE.test(value)) throw invalid(field);
  return trimmed;
}

function validatePublicKey(value, field) {
  if (!isB64u(value, { length: 32 })) throw invalid(field);
  return value;
}

function validateWebhookUrl(value, allowHttp) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > 2048) throw invalid("webhook_url");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw invalid("webhook_url");
  }
  const schemeOk = url.protocol === "https:" || (allowHttp && url.protocol === "http:");
  if (!schemeOk || url.username !== "" || url.password !== "") throw invalid("webhook_url");
  return value;
}

function parseQueryInt(raw, field, min, max) {
  const value = QUERY_INT_RE.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw invalid(field);
  return value;
}

function memberJson(m, nowToIso) {
  return {
    member_id: m.memberId,
    role: m.role,
    name: m.name,
    public_key: m.publicKey,
    joined_at: nowToIso(m.joinedAt),
    has_webhook: m.webhookUrl !== null,
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export async function startRelayDouble({
  invite = "test-invite",
  now = () => Date.now(),
  allowHttpWebhooks = true,
  pairingTtlS = 600,
  messageTtlS = 604_800,
  maxMembers = 8,
  maxPageBytes = 8 * 1024 * 1024,
  webhookBatch = 50,
  plans = "off",
} = {}) {
  const iso = (ms) => formatTimestamp(new Date(ms));
  const state = {
    hubs: new Map(),
    tokens: new Map(),
    requests: [],
    webhookDeliveries: [],
    operatorNotice: null,
    hub(hubId) {
      if (hubId !== undefined) return this.hubs.get(hubId);
      if (this.hubs.size !== 1) throw new Error(`relay double has ${this.hubs.size} hubs`);
      return this.hubs.values().next().value;
    },
    member(memberId, hubId) {
      return this.hub(hubId).members.get(memberId);
    },
    pendingSeqs(memberId, hubId) {
      return [...(this.hub(hubId).deliveries.get(memberId) ?? [])].sort((a, b) => a - b);
    },
  };
  const failures = new Map();
  const delays = new Map();
  const gates = new Map(), releases = new Set();

  const activeMembers = (hub) =>
    [...hub.members.values()].filter((m) => m.revokedAt === null).sort((a, b) => a.joinedAt - b.joinedAt || (a.memberId < b.memberId ? -1 : 1));

  function newHub() {
    const hub = {
      hubId: `hub_${b64uRandom(16)}`,
      lastSeq: 0,
      nextAgentN: 1,
      nextDevN: 1,
      members: new Map(),
      pairings: new Map(),
      messages: new Map(),
      msgIds: new Map(),
      deliveries: new Map(),
      plan: { state: plans === "mock" ? "unpaid" : "active", reason: null, expiresAt: null, deletingAt: null },
    };
    state.hubs.set(hub.hubId, hub);
    return hub;
  }

  function addMember(hub, { role, name, publicKey, webhookUrl = null }) {
    const n = role === "agent" ? hub.nextAgentN++ : hub.nextDevN++;
    const member = {
      memberId: `m_${role === "agent" ? "agent" : "dev"}_${n}`,
      role,
      name,
      publicKey,
      token: `sk_${hub.hubId}_${b64uRandom(30)}`,
      webhookUrl,
      webhookSecret: `whsec_${b64uRandom(32)}`,
      joinedAt: now(),
      revokedAt: null,
      cursor: 0,
    };
    hub.members.set(member.memberId, member);
    hub.deliveries.set(member.memberId, new Set());
    state.tokens.set(member.token, { hubId: hub.hubId, memberId: member.memberId });
    return member;
  }

  function append(hub, { kind, sender, msgId, body, recipients }) {
    const seq = ++hub.lastSeq;
    hub.messages.set(seq, { seq, msgId, kind, sender, body, expiresAt: now() + messageTtlS * 1000 });
    for (const id of recipients) hub.deliveries.get(id).add(seq);
    return seq;
  }

  function emit(hub, event, body, recipients) {
    if (recipients.length === 0) return null;
    const msgId = uuidv7({ now });
    const text = JSON.stringify({ v: 1, kind: "system", msg_id: msgId, from: "relay", created_at: iso(now()), event, body });
    return append(hub, { kind: "system", sender: "relay", msgId, body: text, recipients });
  }

  function dropOrphans(hub, seqs) {
    for (const seq of seqs) {
      const stillWanted = [...hub.deliveries.values()].some((set) => set.has(seq));
      if (!stillWanted) hub.messages.delete(seq);
    }
  }

  function expire(hub, message) {
    const undelivered = [];
    for (const [memberId, set] of hub.deliveries) {
      if (set.delete(message.seq)) undelivered.push(memberId);
    }
    hub.messages.delete(message.seq);
    const sender = hub.members.get(message.sender);
    if (message.kind === "data" && sender && sender.revokedAt === null) {
      emit(hub, "message_expired", { msg_id: message.msgId, seq: message.seq, undelivered_to: undelivered }, [sender.memberId]);
    }
  }

  function sweep() {
    const at = now();
    for (const hub of state.hubs.values()) {
      for (const message of [...hub.messages.values()]) if (message.expiresAt <= at) expire(hub, message);
    }
  }

  function revoke(hub, targetId, by) {
    const target = hub.members.get(targetId);
    if (!target || target.revokedAt !== null) throw new ApiError("not_found");
    target.revokedAt = now();
    state.tokens.delete(target.token);
    if (target.role === "device") {
      for (const [seq, message] of hub.messages) {
        if (message.sender !== targetId || JSON.parse(message.body).kind === "control") continue;
        hub.messages.delete(seq);
        hub.msgIds.delete(message.msgId);
        for (const deliveries of hub.deliveries.values()) deliveries.delete(seq);
      }
    }
    const dropped = [...hub.deliveries.get(targetId)];
    hub.deliveries.get(targetId).clear();
    dropOrphans(hub, dropped);
    const remaining = activeMembers(hub).map((m) => m.memberId);
    emit(hub, "member_revoked", { member_id: targetId, revoked_by: by, self: targetId === by }, remaining);
    if (remaining.length === 0) {
      for (const m of hub.members.values()) state.tokens.delete(m.token);
      state.hubs.delete(hub.hubId);
    }
  }

  function authenticate(req) {
    const header = req.headers.authorization ?? "";
    const m = /^Bearer (\S+)$/.exec(header);
    if (!m || !TOKEN_RE.test(m[1])) throw new ApiError("invalid_token");
    const entry = state.tokens.get(m[1]);
    const hub = entry && state.hubs.get(entry.hubId);
    const member = hub?.members.get(entry.memberId);
    if (!member || member.revokedAt !== null) throw new ApiError("invalid_token");
    return { hub, member };
  }

  const requireAgent = (member) => {
    if (member.role !== "agent") throw new ApiError("forbidden");
  };

  function pageFor(hub, member, after, limit) {
    const effectiveAfter = after ?? member.cursor;
    const seqs = [...hub.deliveries.get(member.memberId)].filter((s) => s > effectiveAfter).sort((a, b) => a - b);
    const messages = [];
    let bytes = 2;
    let nextAfter = effectiveAfter;
    let hasMore = false;
    for (const seq of seqs) {
      if (messages.length === limit) {
        hasMore = true;
        break;
      }
      const json = delivered(hub.messages.get(seq));
      const size = Buffer.byteLength(json) + (messages.length > 0 ? 1 : 0);
      if (messages.length > 0 && bytes + size > maxPageBytes) {
        hasMore = true;
        break;
      }
      messages.push(json);
      bytes += size;
      nextAfter = seq;
    }
    return `{"messages":[${messages.join(",")}],"next_after":${nextAfter},"has_more":${hasMore}}`;
  }

  const delivered = (message) => `${message.body.slice(0, -1)},"seq":${message.seq}}`;

  const handlers = {
    health: () => ({ status: 200, body: { ok: true, service: "syncky-relay", api: 1 } }),

    register: ({ req, text }) => {
      if (invite !== null && req.headers["x-syncky-invite"] !== invite) throw new ApiError("invalid_invite");
      const json = parseObject(text, "invalid_request");
      const name = validateName(json.name, "name");
      const publicKey = validatePublicKey(json.public_key, "public_key");
      const webhookUrl = validateWebhookUrl(json.webhook_url, allowHttpWebhooks);
      const hub = newHub();
      const agent = addMember(hub, { role: "agent", name, publicKey, webhookUrl });
      return {
        status: 201,
        body: { hub_id: hub.hubId, member_id: agent.memberId, token: agent.token, webhook_secret: agent.webhookSecret },
      };
    },

    createPairing: ({ hub, member }) => {
      requireAgent(member);
      const pairing = {
        pairingId: `p_${b64uRandom(16)}`,
        token: `pt_${b64uRandom(32)}`,
        createdBy: member.memberId,
        expiresAt: now() + pairingTtlS * 1000,
        completedAt: null,
        memberId: null,
        deviceName: null,
        publicKey: null,
      };
      hub.pairings.set(pairing.pairingId, pairing);
      return {
        status: 201,
        body: { pairing_id: pairing.pairingId, pairing_token: pairing.token, expires_at: iso(pairing.expiresAt), hub_id: hub.hubId },
      };
    },

    getPairing: ({ hub, member, params }) => {
      requireAgent(member);
      const pairing = hub.pairings.get(decodeURIComponent(params[0]));
      if (!pairing) throw new ApiError("not_found");
      const status = pairing.completedAt !== null ? "completed" : now() >= pairing.expiresAt ? "expired" : "pending";
      const body = { pairing_id: pairing.pairingId, status, expires_at: iso(pairing.expiresAt) };
      if (status === "completed") {
        Object.assign(body, {
          completed_at: iso(pairing.completedAt),
          member_id: pairing.memberId,
          device_name: pairing.deviceName,
          public_key: pairing.publicKey,
        });
      }
      return { status: 200, body };
    },

    pair: ({ text }) => {
      const json = parseObject(text, "invalid_request");
      if (typeof json.hub_id !== "string" || !HUB_ID_RE.test(json.hub_id)) throw invalid("hub_id");
      if (typeof json.pairing_token !== "string" || !PAIRING_TOKEN_RE.test(json.pairing_token)) throw invalid("pairing_token");
      const publicKey = validatePublicKey(json.public_key, "public_key");
      const deviceName = validateName(json.device_name, "device_name");
      const hub = state.hubs.get(json.hub_id);
      const pairing = hub && [...hub.pairings.values()].find((p) => p.token === json.pairing_token);
      if (!pairing) throw new ApiError("pairing_not_found");
      if (pairing.completedAt !== null || now() >= pairing.expiresAt) throw new ApiError("pairing_expired");
      if (activeMembers(hub).length >= maxMembers) throw new ApiError("hub_full");
      const device = addMember(hub, { role: "device", name: deviceName, publicKey });
      Object.assign(pairing, { completedAt: now(), memberId: device.memberId, deviceName, publicKey });
      const members = activeMembers(hub);
      emit(
        hub,
        "member_joined",
        { member_id: device.memberId, role: "device", device_name: deviceName, public_key: publicKey, pairing_id: pairing.pairingId },
        members.filter((m) => m !== device).map((m) => m.memberId),
      );
      if (hub.plan.state === "unpaid" && hub.plan.deletingAt === null) {
        hub.plan.deletingAt = now() + UNPAID_DELETE_AFTER_MS;
        emit(hub, "hub_deleting", { at: iso(hub.plan.deletingAt) }, members.map((m) => m.memberId));
      }
      return {
        status: 201,
        body: { hub_id: hub.hubId, member_id: device.memberId, token: device.token, members: members.map((m) => memberJson(m, iso)) },
      };
    },

    listMembers: ({ hub }) => ({ status: 200, body: { members: activeMembers(hub).map((m) => memberJson(m, iso)) } }),

    updateWebhook: ({ member, text }) => {
      const json = parseObject(text, "invalid_request");
      if (json.webhook_url === undefined) throw invalid("webhook_url");
      member.webhookUrl = validateWebhookUrl(json.webhook_url, allowHttpWebhooks);
      return { status: 200, body: { member_id: member.memberId, webhook_url: member.webhookUrl } };
    },

    rotateWebhookSecret: ({ member }) => {
      member.webhookSecret = `whsec_${b64uRandom(32)}`;
      return { status: 200, body: { webhook_secret: member.webhookSecret } };
    },

    deleteSelf: ({ hub, member }) => {
      revoke(hub, member.memberId, member.memberId);
      return { status: 204 };
    },

    revokeMember: ({ hub, member, params }) => {
      const target = decodeURIComponent(params[0]);
      if (target !== member.memberId) requireAgent(member);
      revoke(hub, target, member.memberId);
      return { status: 204 };
    },

    postMessage: ({ hub, member, text }) => {
      const active = activeMembers(hub).map((m) => m.memberId);
      const result = validateEnvelopeText(text, { caller: member.memberId, activeMembers: active });
      if (result.status === 400) throw new ApiError("invalid_envelope", { field: result.field });
      if (result.status === 404) throw new ApiError("unknown_recipient", { member_ids: result.member_ids });
      if (result.status === 413) throw new ApiError("payload_too_large");
      const envelope = JSON.parse(text);
      if (envelope.kind === "data" && hub.plan.state !== "active") throw new ApiError(hub.plan.state === "unpaid" ? "hub_unpaid" : "hub_suspended");
      const bodyHash = sha256Hex(text);
      const known = hub.msgIds.get(envelope.msg_id);
      if (known) {
        if (known.bodyHash !== bodyHash) throw new ApiError("msg_id_conflict");
        return { status: 200, body: { seq: known.seq, msg_id: envelope.msg_id, duplicate: true } };
      }
      const seq = append(hub, {
        kind: "data",
        sender: member.memberId,
        msgId: envelope.msg_id,
        body: JSON.stringify(envelope),
        recipients: envelope.recipients.map((r) => r.member_id),
      });
      hub.msgIds.set(envelope.msg_id, { bodyHash, seq });
      return { status: 201, body: { seq, msg_id: envelope.msg_id } };
    },

    hubState: ({ hub }) => ({
      status: 200,
      body: {
        state: hub.plan.state,
        reason: hub.plan.reason,
        expires_at: hub.plan.expiresAt === null ? null : iso(hub.plan.expiresAt),
        deleting_at: hub.plan.deletingAt === null ? null : iso(hub.plan.deletingAt),
        ...(state.operatorNotice !== null && { notice: state.operatorNotice }),
      },
    }),

    heartbeat: ({ member, text }) => {
      requireAgent(member);
      const { version, platform } = parseObject(text, "invalid_request");
      if (typeof version !== "string" || version === "") throw invalid("version");
      if (!["darwin", "linux", "win32", "other"].includes(platform)) throw invalid("platform");
      return { status: 204 };
    },

    getMessages: ({ hub, member, query }) => {
      const after = query.has("after") ? parseQueryInt(query.get("after"), "after", 0, Number.MAX_SAFE_INTEGER) : null;
      const limit = query.has("limit") ? parseQueryInt(query.get("limit"), "limit", 1, MAX_PAGE_LIMIT) : MAX_PAGE_LIMIT;
      if (member.role === "agent") {
        if (query.getAll("poll_interval_s").length > 1) throw invalid("poll_interval_s");
        member.pollIntervalS = query.has("poll_interval_s") ? parseQueryInt(query.get("poll_interval_s"), "poll_interval_s", 300, 86400) : 1800;
      }
      return { status: 200, raw: pageFor(hub, member, after, limit) };
    },

    ack: ({ hub, member, text }) => {
      const upTo = parseObject(text, "invalid_request").up_to_seq;
      if (typeof upTo !== "number" || !Number.isSafeInteger(upTo) || upTo < 0 || upTo > hub.lastSeq) throw invalid("up_to_seq");
      const set = hub.deliveries.get(member.memberId);
      const removed = [...set].filter((s) => s <= upTo);
      for (const s of removed) set.delete(s);
      dropOrphans(hub, removed);
      member.cursor = Math.max(member.cursor, upTo);
      return { status: 200, body: { acked: removed.length, cursor: member.cursor } };
    },
  };

  function send(res, status, { body, raw, headers = {} } = {}) {
    const text = raw ?? (body === undefined ? "" : JSON.stringify(body));
    const out = { ...headers };
    if (status !== 204) out["Content-Type"] = "application/json; charset=utf-8";
    res.writeHead(status, out);
    res.end(status === 204 ? undefined : text);
  }

  function sendError(res, code, details, headers) {
    const body = { error: code, message: `relay double: ${code}` };
    if (details !== undefined) body.details = details;
    send(res, STATUS_CODES[code] ?? 500, { body, headers });
  }

  async function handle(req, res) {
    const url = new URL(req.url, "http://relay.double");
    const raw = await readBody(req);
    const text = raw.toString("utf8");
    const byPath = ROUTES.filter((r) => r.re.test(url.pathname));
    const route = byPath.find((r) => r.method === req.method);
    state.requests.push({
      route: route?.name ?? null,
      method: req.method,
      path: url.pathname + url.search,
      headers: { ...req.headers },
      body: text,
    });
    if (byPath.length === 0) return sendError(res, "not_found");
    if (!route) {
      return sendError(res, "method_not_allowed", undefined, { Allow: [...new Set(byPath.map((r) => r.method))].join(", ") });
    }

    const gate = gates.get(route.name)?.shift();
    if (gate) { gate.entered.resolve(); await gate.pending.promise; }
    const delay = delays.get(route.name);
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    const injected = failures.get(route.name)?.shift();
    if (injected) {
      if (injected.status === "reset") return req.socket.destroy();
      const code = DEFAULT_CODE_FOR_STATUS[injected.status] ?? "internal_error";
      const body = injected.body ?? { error: code, message: `injected ${injected.status}` };
      const status = injected.status;
      const headers = { "Content-Type": "application/json; charset=utf-8", ...injected.headers };
      res.writeHead(status, headers);
      return res.end(typeof body === "string" ? body : JSON.stringify(body));
    }

    if (raw.length > 0) {
      const type = req.headers["content-type"] ?? "";
      if (!/^application\/json\s*(;|$)/i.test(type)) return sendError(res, "unsupported_media_type");
      const cap = route.name === "postMessage" ? MAX_ENVELOPE_BYTES : MAX_CONTROL_BODY_BYTES;
      if (raw.length > cap) return sendError(res, "payload_too_large");
    }

    sweep();
    try {
      const params = route.re.exec(url.pathname).slice(1);
      const ctx = { req, text, params, query: url.searchParams };
      if (route.auth) Object.assign(ctx, authenticate(req));
      const result = handlers[route.name](ctx);
      send(res, result.status, result);
    } catch (err) {
      if (err instanceof ApiError) return sendError(res, err.code, err.details, err.headers);
      sendError(res, "internal_error");
    }
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) sendError(res, "internal_error");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  async function deliverTo(hub, member) {
    const results = [];
    for (;;) {
      if (member.revokedAt !== null || member.webhookUrl === null) return results;
      const seqs = state.pendingSeqs(member.memberId, hub.hubId).slice(0, webhookBatch);
      if (seqs.length === 0) return results;
      const body = `{"hub_id":"${hub.hubId}","messages":[${seqs.map((s) => delivered(hub.messages.get(s))).join(",")}]}`;
      const timestamp = String(Math.floor(now() / 1000));
      const signature = `v1=${createHmac("sha256", Buffer.from(member.webhookSecret, "utf8")).update(`${timestamp}.${body}`).digest("hex")}`;
      let status = 0;
      try {
        const res = await fetch(member.webhookUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "syncky-relay/1",
            "X-Syncky-Timestamp": timestamp,
            "X-Syncky-Signature": signature,
            "X-Syncky-Delivery": uuidv7({ now }),
          },
          body,
          signal: AbortSignal.timeout(10_000),
        });
        await res.arrayBuffer();
        status = res.status;
      } catch {
        status = 0;
      }
      const record = { hubId: hub.hubId, memberId: member.memberId, url: member.webhookUrl, status, seqs };
      state.webhookDeliveries.push(record);
      results.push(record);
      if (status < 200 || status >= 300) return results;
      const set = hub.deliveries.get(member.memberId);
      for (const s of seqs) set.delete(s);
      dropOrphans(hub, seqs);
      member.cursor = Math.max(member.cursor, seqs[seqs.length - 1]);
    }
  }

  return {
    url: `http://127.0.0.1:${port}`,
    state,

    stop: () => {
      for (const release of releases) release();
      return new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },

    async deliverWebhooks() {
      sweep();
      const results = [];
      for (const hub of [...state.hubs.values()]) {
        for (const member of activeMembers(hub)) results.push(...(await deliverTo(hub, member)));
      }
      return results;
    },

    failNext(route, status, headers = {}, body) {
      const name = routeName(route);
      if (!handlers[name]) throw new Error(`relay double: unknown route ${route}`);
      if (!failures.has(name)) failures.set(name, []);
      failures.get(name).push({ status, headers, body });
    },

    setDelay(route, ms) {
      const name = routeName(route);
      if (!handlers[name]) throw new Error(`relay double: unknown route ${route}`);
      if (ms > 0) delays.set(name, ms);
      else delays.delete(name);
    },

    gateNext(route) {
      const name = routeName(route);
      if (!handlers[name]) throw new Error(`relay double: unknown route ${route}`);
      const entered = Promise.withResolvers(), pending = Promise.withResolvers();
      const release = () => { releases.delete(release); pending.resolve(); };
      if (!gates.has(name)) gates.set(name, []);
      gates.get(name).push({ entered, pending }); releases.add(release);
      return { entered: entered.promise, release };
    },

    setPlan({ state, reason = null, expiresAt = null, hubId } = {}) {
      const hub = this.state.hub(hubId);
      const before = hub.plan.state;
      const dateChanged = reason === "launch" && hub.plan.reason === "launch" && expiresAt !== hub.plan.expiresAt;
      hub.plan = { state, reason, expiresAt, deletingAt: state === "unpaid" ? hub.plan.deletingAt : null };
      const everyone = activeMembers(hub).map((m) => m.memberId);
      if (state === "active" && (before !== "active" || dateChanged)) emit(hub, "hub_resumed", {}, everyone);
      if (state === "suspended" && before !== "suspended") emit(hub, "hub_suspended", { reason: reason ?? "subscription_expired" }, everyone);
    },

    expireMessage(msgId) {
      for (const hub of state.hubs.values()) {
        const message = [...hub.messages.values()].find((m) => m.msgId === msgId);
        if (message) {
          expire(hub, message);
          return true;
        }
      }
      return false;
    },
  };
}
