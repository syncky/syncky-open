import { b64u, buildPairUri, clean, generateKeys, isPublicKey, MEMBER_ID_RE, nowText, openEnvelope, pairCode, pairProof, proofMatches, randomBytes, sealEnvelope, uuidv7 } from "./protocol.mjs";

export const PAIR_STATUS_MS = 2_000;
export const PROOF_WAIT_MS = 2_000;
export const POLL_MS = 5_000;
export const HUB_STATE_MS = 60_000;
export const MAX_SAMPLES = 500;
const MAX_BACKOFF_MS = 60_000;
const ENDED_NOTICE = "Demo ended. The agent left the hub, so the iPhone shows it left. Nothing was kept in this tab.";

export const WRITES = {
  water: { label: "250 mL water", type: "dietary_water", command: (at) => ({ type: "dietary_water", value: 0.25, unit: "L", start: nowText(at), end: nowText(at) }) },
  mindful: { label: "10-minute mindful session", type: "mindful_session", command: (at) => ({ type: "mindful_session", value: "not_applicable", start: nowText(at - 600_000), end: nowText(at) }) },
};

const relayError = (status, code, retryAfterS) => Object.assign(new Error(`relay ${status} ${code}`), { status, code, retryAfterS });

function parseRetryAfter(header, details, at) {
  const value = header?.trim() ?? "";
  if (/^[0-9]{1,10}$/.test(value)) return Number(value);
  if (/^[A-Za-z]/.test(value)) {
    const date = Date.parse(value);
    if (Number.isFinite(date)) return Math.max(0, Math.ceil((date - at) / 1000));
  }
  const seconds = details?.retry_after_s;
  return Number.isSafeInteger(seconds) && seconds >= 0 && Number.isSafeInteger(seconds * 1000) ? seconds : undefined;
}

function sampleRow(s) {
  const type = /^[a-z0-9_]{1,64}$/.test(s?.type) ? s.type : "unknown";
  const time = typeof s?.start === "string" ? s.start : typeof s?.date === "string" ? s.date : "";
  let value = "";
  if (typeof s?.value === "number" && Number.isFinite(s.value)) value = `${s.value}${typeof s.unit === "string" ? ` ${clean(s.unit)}` : ""}`;
  else if (typeof s?.value === "string") value = clean(s.value);
  else if (type === "workout" && typeof s.activity === "string") value = `${clean(s.activity)}${typeof s.duration_s === "number" ? `, ${Math.round(s.duration_s / 60)} min` : ""}`;
  else if (Array.isArray(s?.points)) value = `${s.points.length} points`;
  return { uuid: typeof s?.uuid === "string" ? s.uuid : "", type, time: clean(time), value };
}

export class DemoSession {
  constructor({ relay, scheme = "syncky", name = "Syncky browser demo", fetch = (...a) => globalThis.fetch(...a), sleep, now = () => Date.now(), onChange = () => {} }) {
    Object.assign(this, { relay, scheme, name, fetchFn: fetch, now, onChange });
    this.sleep = sleep ?? (async (ms) => {
      const due = this.now() + ms;
      do {
        await new Promise((done) => setTimeout(done, Math.min(Math.max(0, due - this.now()), 2_147_483_647)));
      } while (!this.stopped && this.now() < due);
    });
    this.state = { phase: "idle", hubId: null, hubState: null, pairing: null, phone: null, samples: [], commands: [], countdown: null, notice: null, error: null };
    this.lastSeq = 0;
    this.stopped = false;
  }

  emit(change) {
    if (this.state.phase === "ended") return;
    Object.assign(this.state, change);
    this.onChange(this.state);
  }

  async call(method, path, body, keepalive = false) {
    const headers = { Accept: "application/json" };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json; charset=utf-8";
    let res;
    try {
      res = await this.fetchFn(`${this.relay}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), keepalive, cache: "no-store", credentials: "omit" });
    } catch {
      throw relayError(0, "network_error");
    }
    if (path === "/v1/agents/register" && res.ok) {
      this.registrationReceivedAt = this.now();
    }
    const json = res.status === 204 ? null : await res.json().catch(() => undefined);
    if (this.state.phase === "ended") throw relayError(401, "invalid_token");
    if (res.ok && json !== undefined) return json;
    const retryAfterS = parseRetryAfter(res.headers.get("retry-after"), json?.details, this.now());
    throw relayError(res.status, typeof json?.error === "string" ? clean(json.error) : "relay_error", retryAfterS);
  }

  async start() {
    this.emit({ phase: "starting" });
    try {
      this.registration = generateKeys().then(async (keys) => {
        if (this.stopped) return;
        this.keys = keys;
        const reg = await this.call("POST", "/v1/agents/register", { name: this.name, public_key: keys.pk, demo: true });
        if (!/^hub_[\w-]{22}$/.test(reg?.hub_id) || !MEMBER_ID_RE.test(reg.member_id) || !reg.token?.startsWith(`sk_${reg.hub_id}_`)) throw relayError(200, "invalid_response");
        Object.assign(this, { hubId: reg.hub_id, memberId: reg.member_id, token: reg.token });
        const endsAt = Date.parse(reg.demo_ends_at);
        if (!Number.isFinite(endsAt) || !Number.isFinite(reg.demo_remaining_s) || reg.demo_remaining_s < 0) throw relayError(201, "invalid_response");
        this.endsAt = this.registrationReceivedAt + reg.demo_remaining_s * 1000;
        this.tick();
        if (this.state.phase !== "ended") this.countdownTimer = setInterval(() => this.tick(), 1000);
      });
      await this.registration;
      if (this.stopped) return;
      this.emit({ hubId: this.hubId });
    } catch (err) {
      if (!this.stopped) return this.fail(err);
      return;
    }
    return this.run();
  }

  tick() {
    if (this.endsAt === undefined || this.state.phase === "ended") return;
    const seconds = Math.max(0, Math.ceil((this.endsAt - this.now()) / 1000));
    this.emit({ countdown: `Demo ends in ${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}` });
    if (seconds === 0) this.finish();
  }

  async newPairing() {
    const p = await this.call("POST", "/v1/pairings", {});
    if (this.stopped) return;
    if (!/^p_[\w-]{22}$/.test(p?.pairing_id) || !/^pt_[\w-]{43}$/.test(p.pairing_token)) throw relayError(201, "invalid_response");
    const c = b64u(randomBytes(16));
    const uri = buildPairUri({ relay_base: this.relay, hub_id: this.hubId, pairing_token: p.pairing_token, agent_public_key: this.keys.pk, agent_name: this.name, pair_secret: c, url_scheme: this.scheme });
    this.pairing = { id: p.pairing_id, c };
    this.emit({ phase: "pairing", phone: null, pairing: { uri, code: await pairCode(c), expiresAt: p.expires_at }, notice: null });
  }

  run() {
    if (!this.runner) this.runner = this.runLoop().finally(() => { this.runner = null; });
    return this.runner;
  }

  async runLoop() {
    let backoffMs = POLL_MS;
    while (!this.stopped) {
      let wait = POLL_MS;
      try {
        if (this.state.phase === "starting") {
          await this.checkHubState();
          if (this.stopped) return;
          await this.newPairing();
        }
        const phase = this.state.phase;
        if (phase === "pairing") wait = (await this.checkPairing()) ?? PAIR_STATUS_MS;
        else if (phase === "joined" || phase === "confirmed") {
          await this.poll();
          wait = this.state.phase === "joined" ? PROOF_WAIT_MS : POLL_MS;
        } else return;
        await this.checkHubState();
        backoffMs = POLL_MS;
        if (this.state.error) this.emit({ error: null });
      } catch (err) {
        if (err.code === "invalid_token") return this.finish();
        if (err.status === 429) {
          wait = err.retryAfterS === undefined ? backoffMs : err.retryAfterS * 1000;
          backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
        } else if (err.status === 0 || err.status >= 500) wait = POLL_MS;
        else return this.fail(err);
        this.emit({ error: err.status === 429 ? `The relay asked to wait ${wait / 1000} s.` : "The relay is not reachable; retrying." });
      }
      if (!this.stopped) await this.sleep(wait);
    }
  }

  async checkHubState() {
    if (this.stopped || !this.token || this.now() < (this.nextHubStateAt ?? 0)) return;
    this.nextHubStateAt = this.now() + HUB_STATE_MS;
    const hub = await this.call("GET", "/v1/hub/state").catch((err) => {
      if (err.status === 429) {
        this.nextHubStateAt = 0;
        throw err;
      }
      return null;
    });
    if (this.stopped || !hub) return;
    const fields = ["state", "reason", "expires_at", "deleting_at", "notice"].flatMap((key) => {
      if (typeof hub[key] !== "string") return [];
      const value = hub[key].replace(/[\p{C}\p{Zl}\p{Zp}]/gu, " ").trim().slice(0, 500);
      return value ? [`${key}: ${value}`] : [];
    });
    this.emit({ hubState: fields.join(" · ") || null });
  }

  async checkPairing() {
    const s = await this.call("GET", `/v1/pairings/${this.pairing.id}`);
    if (this.stopped) return;
    if (s?.status === "completed") {
      if (!MEMBER_ID_RE.test(s.member_id) || !isPublicKey(s.public_key)) throw relayError(200, "invalid_response");
      const proof = await pairProof(this.pairing.c, this.keys.pk, s.public_key);
      if (this.stopped) return;
      this.pairing = null;
      this.emit({ phase: "joined", pairing: { code: this.state.pairing.code }, phone: { id: s.member_id, pk: s.public_key, name: clean(s.device_name ?? "iPhone"), proof } });
      return PROOF_WAIT_MS;
    }
    if (s?.status !== "pending") {
      this.pairing = null;
      this.emit({ phase: "expired", pairing: null });
    }
    return null;
  }

  async poll() {
    for (;;) {
      const page = await this.call("GET", `/v1/messages?after=${this.lastSeq}&limit=100`);
      if (this.stopped) return;
      if (!Array.isArray(page?.messages)) throw relayError(200, "invalid_response");
      let done = this.lastSeq;
      for (const msg of page.messages) {
        if (!Number.isSafeInteger(msg?.seq) || msg.seq <= done) throw relayError(200, "invalid_response");
        if (!(await this.handle(msg))) break;
        if (this.stopped) return;
        done = msg.seq;
      }
      if (done > this.lastSeq) {
        await this.call("POST", "/v1/acks", { up_to_seq: done });
        this.lastSeq = done;
      }
      const held = done !== (page.messages.at(-1)?.seq ?? done);
      if (this.stopped || held || page.has_more !== true || page.messages.length === 0) return;
    }
  }

  // Returns false to stop before this message: data from a phone that has not proved the code is held, never acked.
  async handle(msg) {
    const phone = this.state.phone;
    const fromPhone = phone !== null && msg.from === phone.id;
    if (msg.kind === "system") return Object.hasOwn(msg, "access") || Object.hasOwn(msg, "diagnostics") ? true : this.handleSystem(msg);
    if (!fromPhone) return true;
    const confirmed = this.state.phase === "confirmed";
    if (msg.kind === "data" && !confirmed) return false;
    if (msg.kind === "control" && confirmed && !Object.hasOwn(msg, "access")) return true;
    const opened = await openEnvelope(msg, { hubId: this.hubId, memberId: this.memberId, sk: this.keys.sk, registry: { [phone.id]: phone.pk }, kind: msg.kind })
      .then(JSON.parse)
      .catch(() => null);
    if (this.stopped) return true;
    if (opened === null) return true;
    if (msg.kind === "control") return Object.hasOwn(msg, "access") || confirmed ? true : this.checkProof(phone, opened);
    if (opened.v !== 1 || opened.type !== "sync" || opened.device !== msg.from) return true;
    this.applySync(opened);
    return true;
  }

  async handleSystem(msg) {
    const b = msg.body ?? {};
    if (msg.event === "message_expired") {
      this.updateCommands((c) => (c.msgId === b.msg_id && ["pending", "sent", "uncertain"].includes(c.state) ? { state: "expired", reason: undefined } : null));
    }
    if (msg.event === "member_revoked" && this.state.phone?.id === b.member_id) {
      const members = (await this.call("GET", "/v1/members"))?.members;
      if (Array.isArray(members) && !members.some((m) => m?.member_id === b.member_id)) {
        this.emit({ phase: "phone_left", pairing: null, phone: null, notice: "The iPhone left the demo (unpaired, or a wrong code was picked)." });
      }
    }
    return true;
  }

  async checkProof(phone, inner) {
    if (inner?.v !== 1 || inner.type !== "pair_proof") return true;
    if (!proofMatches(phone.proof, inner.proof)) {
      await this.call("DELETE", `/v1/members/${phone.id}`).catch((err) => (err.code === "not_found" ? null : Promise.reject(err)));
      this.emit({ phase: "phone_left", pairing: null, phone: null, notice: "The iPhone picked a code that does not match; it was removed. Start a new pairing to try again." });
      return true;
    }
    const envelope = await sealEnvelope({ hubId: this.hubId, from: this.memberId, sk: this.keys.sk, recipients: [{ member_id: phone.id, pk: phone.pk }], plaintext: '{"v":1,"type":"confirmed"}', kind: "control" });
    if (this.stopped) return true;
    await this.call("POST", "/v1/messages", envelope);
    this.emit({ phase: "confirmed", pairing: null, phone: { ...phone, proof: null } });
    return true;
  }

  applySync(inner) {
    const list = (x) => (Array.isArray(x) ? x : []);
    const rows = list(inner.samples).map(sampleRow);
    if (rows.length > 0) this.emit({ samples: [...rows.reverse(), ...this.state.samples].slice(0, MAX_SAMPLES) });
    for (const a of list(inner.acks)) {
      this.updateCommands((c) => {
        if (c.id !== a?.command_id || (a.version ?? 1) !== 1 || !["pending", "sent", "uncertain", "expired"].includes(c.state)) return null;
        if (a.status === "applied") return { state: "applied", reason: undefined };
        if (a.status === "rejected") return { state: "rejected", reason: /^[a-z_]{1,32}$/.test(a.reason) ? a.reason : "unknown" };
        return null;
      });
    }
  }

  updateCommands(change) {
    let changed = false;
    const commands = this.state.commands.map((c) => {
      const update = change(c);
      if (update === null) return c;
      changed = true;
      return { ...c, ...update };
    });
    if (changed) this.emit({ commands });
  }

  async write(kind) {
    const spec = WRITES[kind];
    const phone = this.state.phone;
    if (!spec || this.state.phase !== "confirmed" || !phone) return;
    const id = `c_${this.state.commands.length + 1}`;
    const msgId = uuidv7(this.now());
    this.emit({ commands: [...this.state.commands, { id, label: spec.label, msgId, state: "pending" }] });
    const plaintext = JSON.stringify({ v: 1, type: "commands", commands: [{ command_id: id, version: 1, op: "write", ...spec.command(this.now()) }] });
    try {
      const envelope = await sealEnvelope({ hubId: this.hubId, from: this.memberId, sk: this.keys.sk, recipients: [{ member_id: phone.id, pk: phone.pk }], plaintext, msgId });
      if (this.stopped) return;
      await this.call("POST", "/v1/messages", envelope);
      this.updateCommands((c) => (c.id === id && c.state === "pending" ? { state: "sent" } : null));
    } catch (err) {
      const reason = err.status === 429 ? `rate_limited, retry in ${err.retryAfterS ?? "a few"} s` : err.code;
      const state = err.status === 0 || err.status >= 500 || (err.status >= 200 && err.status < 300) ? "uncertain" : "not_sent";
      this.updateCommands((c) => (c.id === id && c.state === "pending" ? { state, reason } : null));
    }
  }

  async pairAgain() {
    if (!["expired", "phone_left"].includes(this.state.phase)) return;
    try {
      await this.newPairing();
    } catch (err) {
      return this.fail(err);
    }
    return this.run();
  }

  end() {
    if (this.ending) return this.ending;
    if (this.state.phase === "ended") return;
    this.stopped = true;
    this.emit({ phase: "ending", pairing: null, phone: null, notice: null, error: null });
    this.ending = (async () => {
      try {
        await this.registration?.catch(() => {});
        if (this.token) await this.call("DELETE", "/v1/members/me", { purge: true });
        this.finish();
      } catch (err) {
        if (err.code === "invalid_token") return this.finish();
        this.emit({ phase: "leave_failed", error: "The relay did not confirm that the agent left. Press End demo to retry." });
      }
    })().finally(() => { this.ending = null; });
    return this.ending;
  }

  leaveOnUnload() {
    if (!this.token) return;
    this.stopped = true;
    this.unloading ??= this.call("DELETE", "/v1/members/me", { purge: true }, true).catch(() => null).finally(() => {
      this.token = null;
      this.unloading = null;
    });
    return this.unloading;
  }

  finish() {
    this.stopped = true;
    clearInterval(this.countdownTimer);
    this.keys = null;
    this.token = null;
    this.pairing = null;
    this.emit({ phase: "ended", pairing: null, phone: null, samples: [], commands: [], error: null, notice: ENDED_NOTICE });
  }

  async fail(err) {
    const wait = err.status === 429 && err.retryAfterS ? ` Try again in ${Math.ceil(err.retryAfterS / 60)} min.` : "";
    this.stopped = true;
    await this.leaveOnUnload();
    this.keys = null;
    this.token = null;
    this.pairing = null;
    this.emit({ phase: "error", pairing: null, phone: null, error: `The relay refused the demo (${err.code ?? "error"}).${wait}` });
  }
}
