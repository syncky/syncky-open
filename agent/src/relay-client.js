import { CONFIG_DEFAULTS, isLoopbackHost, resolveConfig } from "./config.js";
import { printable } from "./encoding.js";
import { redact, REDACTED } from "./log.js";
import { RETRY_POLICY, abortableSleep } from "./transport-time.js";

export { RETRY_POLICY } from "./transport-time.js";

export const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
export const DEFAULT_TIMEOUT_MS = 15_000;
export const MAX_RESPONSE_BYTES = 1024 * 1024;
// The relay caps a page at 8 MiB of messages but still returns one larger message alone, plus the framing.
export const MAX_PAGE_RESPONSE_BYTES = 9 * 1024 * 1024;
export const RELAY_ERROR_CODES = Object.freeze([
  "invalid_request",
  "invalid_envelope",
  "invalid_plan_proof",
  "invalid_attestation",
  "invalid_token",
  "plan_insufficient",
  "hub_unpaid",
  "hub_suspended",
  "invalid_invite",
  "invalid_assertion",
  "attestation_required",
  "forbidden",
  "not_found",
  "pairing_not_found",
  "unknown_recipient",
  "method_not_allowed",
  "msg_id_conflict",
  "plan_in_use",
  "hub_full",
  "pairing_expired",
  "payload_too_large",
  "unsupported_media_type",
  "client_outdated",
  "rate_limited",
  "internal_error",
  "plan_verifier_unavailable",
]);
export const PLAN_REFUSAL_CODES = Object.freeze(["hub_unpaid", "hub_suspended"]);
export const RELAY_CLIENT_ERROR_CODES = Object.freeze(["network_error", "timeout", "relay_error", "invalid_response"]);

export class RelayError extends Error {
  constructor({ status, code, message, details, retryAfterS }) {
    super(message);
    this.name = "RelayError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryAfterS = retryAfterS;
  }
}

const RETRY_AFTER_SECONDS_RE = /^[0-9]{1,10}$/;
const QUERY_INT_RE = /^[0-9]{1,16}$/;

const defaultSleep = (ms, signal) => new Promise((resolve, reject) => {
  signal?.throwIfAborted();
  const abort = () => {
    clearTimeout(timer);
    reject(signal.reason);
  };
  const timer = setTimeout(() => {
    signal?.removeEventListener("abort", abort);
    resolve();
  }, ms);
  signal?.addEventListener("abort", abort, { once: true });
});
const noopLogger = { debug() {}, info() {}, warn() {}, error() {} };

function isRetryableStatus(status) {
  return status === 429 || status >= 500;
}

function parseRetryAfter(header, details, nowMs) {
  if (typeof header === "string" && header.trim() !== "") {
    const value = header.trim();
    if (RETRY_AFTER_SECONDS_RE.test(value)) return Number(value);
    const at = Date.parse(value);
    if (!Number.isNaN(at)) return Math.max(0, Math.ceil((at - nowMs) / 1000));
  }
  const fromDetails = details?.retry_after_s;
  if (Number.isSafeInteger(fromDetails) && fromDetails >= 0) return fromDetails;
  return undefined;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function queryInt(name, value) {
  const text = typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : "";
  if (!QUERY_INT_RE.test(text)) throw new TypeError(`${name} must be a non-negative safe integer`);
  return text;
}

// poll alone builds several clients for the same relay; one warning per host is enough.
const warnedInsecureHosts = new Set();

function warnIfInsecure(baseUrl, logger) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    return;
  }
  if (url.protocol !== "http:" || isLoopbackHost(url.hostname) || warnedInsecureHosts.has(url.hostname)) return;
  warnedInsecureHosts.add(url.hostname);
  logger.warn("relay_url_insecure", { host: url.hostname });
}

export function createRelayClient({
  baseUrl,
  token,
  fetch = globalThis.fetch,
  sleep,
  random = Math.random,
  now = Date.now,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  logger = noopLogger,
  retry = RETRY_POLICY,
  pollIntervalS = CONFIG_DEFAULTS.poll_interval_s,
  timers = globalThis,
} = {}) {
  if (typeof baseUrl !== "string" || !/^https?:\/\//.test(baseUrl)) throw new TypeError("baseUrl must be an http(s) URL");
  const base = baseUrl.replace(/\/+$/, "");
  pollIntervalS = resolveConfig({ env: {}, flags: { poll_interval_s: pollIntervalS } }).poll_interval_s;
  warnIfInsecure(base, logger);

  function effectivePollIntervalS() {
    return pollIntervalS;
  }

  const scrub = (text, extra = []) => {
    let out = String(text);
    for (const secret of [token, ...extra]) {
      if (typeof secret === "string" && secret !== "") out = out.replaceAll(secret, REDACTED);
    }
    return redact(out);
  };

  function errorFromResponse(status, headers, text, secrets) {
    const json = parseJson(text);
    const shaped = json !== null && typeof json === "object" && typeof json.error === "string";
    const details = shaped && json.details !== null && typeof json.details === "object" ? json.details : undefined;
    const code = shaped && RELAY_ERROR_CODES.includes(json.error) ? json.error : "relay_error";
    const relayMessage = shaped && typeof json.message === "string" ? json.message : `HTTP ${status}`;
    return new RelayError({
      status,
      code,
      message: printable(scrub(`relay ${status} ${code}: ${relayMessage}`, secrets)),
      details,
      retryAfterS: parseRetryAfter(headers.get("retry-after"), details, now()),
    });
  }

  function backoffMs(attempt) {
    const ceiling = Math.min(retry.capMs, retry.baseMs * retry.factor ** (attempt - 1));
    return Math.floor(random() * ceiling);
  }

  async function readCapped(res, maxBytes) {
    if (res.body === null) return { text: "" };
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let read = 0;
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return { text: text + decoder.decode() };
      read += value.byteLength;
      if (read > maxBytes) {
        await reader.cancel().catch(() => {});
        return { tooLarge: true };
      }
      text += decoder.decode(value, { stream: true });
    }
  }

  async function attemptOnce(method, url, init, secrets, maxBytes, signal, requestTimeoutMs) {
    const controller = new AbortController();
    const timer = timers.setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const res = await fetch(url, { ...init, method, signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal });
      return { res, ...(await readCapped(res, maxBytes)) };
    } catch (err) {
      signal?.throwIfAborted();
      const timedOut = controller.signal.aborted;
      return {
        error: new RelayError({
          status: 0,
          code: timedOut ? "timeout" : "network_error",
          message: scrub(timedOut ? `relay request timed out after ${timeoutMs} ms` : `relay unreachable: ${err?.message ?? err}`, secrets),
        }),
      };
    } finally {
      timers.clearTimeout(timer);
    }
  }

  async function request(
    method,
    path,
    {
      body,
      auth = true,
      headers: extraHeaders = {},
      secrets = [],
      beforeRetry,
      attempts = retry.maxAttempts,
      maxBytes = MAX_RESPONSE_BYTES,
      quiet = false,
      onFailure,
      signal,
      deadline = Infinity,
      requestTimeoutMs = timeoutMs,
    } = {},
  ) {
    const logFailure = onFailure ?? ((fields) => (quiet ? logger.debug : logger.warn).call(logger, "relay_request_failed", fields));
    if (auth && typeof token !== "string") throw new TypeError("relay client has no token");
    const headers = { Accept: "application/json", ...extraHeaders };
    if (auth) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers["Content-Type"] = JSON_CONTENT_TYPE;
    const url = `${base}${path}`;
    const init = { headers, body };
    for (let attempt = 1; ; attempt += 1) {
      signal?.throwIfAborted();
      if (now() >= deadline) throw new RelayError({ status: 0, code: "timeout", message: "relay request deadline reached" });
      const outcome = await attemptOnce(method, url, init, secrets, maxBytes, signal, Math.min(requestTimeoutMs, deadline - now()));
      let error = outcome.error;
      if (outcome.tooLarge) {
        logFailure({ method, path, status: outcome.res.status, code: "invalid_response", attempt });
        throw new RelayError({ status: outcome.res.status, code: "invalid_response", message: `relay response over ${maxBytes} bytes` });
      }
      if (!error) {
        const { res, text } = outcome;
        if (res.status >= 200 && res.status < 300) {
          logger.debug("relay_request", { method, path, status: res.status, attempt });
          return { status: res.status, body: text === "" ? null : parseJson(text) };
        }
        error = errorFromResponse(res.status, res.headers, text, secrets);
      }
      const retryable = error.status === 0 || isRetryableStatus(error.status);
      const tooLong = error.retryAfterS !== undefined && error.retryAfterS * 1000 > retry.capMs;
      if (!retryable || tooLong || attempt >= attempts || now() >= deadline) {
        logFailure({ method, path, status: error.status, code: error.code, attempt });
        throw error;
      }
      const delayMs = error.retryAfterS !== undefined ? error.retryAfterS * 1000 : backoffMs(attempt);
      logger.debug("relay_retry", { method, path, status: error.status, code: error.code, attempt, delay_ms: delayMs });
      const waitMs = Math.max(0, Math.min(delayMs, deadline - now()));
      await (sleep ? abortableSleep(waitMs, sleep, signal) : defaultSleep(waitMs, signal));
      if (beforeRetry) await beforeRetry();
    }
  }

  const json = (value) => JSON.stringify(value);
  const bodyOf = async (promise) => (await promise).body;

  return {
    baseUrl: base,
      get pollIntervalS() { return effectivePollIntervalS(); },

    health: () => bodyOf(request("GET", "/v1/health", { auth: false })),

    register({ invite, name, publicKey, webhookUrl } = {}) {
      if (invite !== undefined && (typeof invite !== "string" || invite === "")) throw new TypeError("invite must be a non-empty string");
      const payload = { name, public_key: publicKey };
      if (webhookUrl !== undefined) payload.webhook_url = webhookUrl;
      return bodyOf(
        request("POST", "/v1/agents/register", {
          auth: false,
          body: json(payload),
          headers: invite === undefined ? {} : { "X-Syncky-Invite": invite },
          secrets: invite === undefined ? [] : [invite],
        }),
      );
    },

    createPairing: () => bodyOf(request("POST", "/v1/pairings", { body: "{}" })),
    getPairing: (pairingId, { signal, deadline } = {}) => bodyOf(request("GET", `/v1/pairings/${encodeURIComponent(pairingId)}`, { signal, deadline })),
    listMembers: ({ retry: retrying = true, signal, deadline } = {}) => bodyOf(request("GET", "/v1/members", { attempts: retrying ? retry.maxAttempts : 1, signal, deadline })),
    getHubState: ({ attempts = 1, quiet, signal, deadline } = {}) => bodyOf(request("GET", "/v1/hub/state", { attempts, quiet, signal, deadline })),
    heartbeat: async ({ version, platform }, { signal, deadline } = {}) => {
      const { body } = await request("POST", "/v1/agents/heartbeat", { body: json({ version, platform }), attempts: 1, quiet: true, signal, deadline });
      return body ?? undefined;
    },
    deleteSelf: async () => {
      await request("DELETE", "/v1/members/me");
    },
    revokeMember: async (memberId) => {
      await request("DELETE", `/v1/members/${encodeURIComponent(memberId)}`);
    },

    async postMessage(rawBodyString, { beforeRetry, attempts, signal, deadline } = {}) {
      if (typeof rawBodyString !== "string") throw new TypeError("postMessage needs the serialized envelope string");
      const { status, body } = await request("POST", "/v1/messages", { body: rawBodyString, beforeRetry, attempts, signal, deadline });
      return { ...body, duplicate: status === 200 || body?.duplicate === true };
    },

    getMessages({ after, limit } = {}, { signal, deadline, pollIntervalS: interval = effectivePollIntervalS() } = {}) {
      const query = new URLSearchParams();
      if (after !== undefined) query.set("after", queryInt("after", after));
      if (limit !== undefined) query.set("limit", queryInt("limit", limit));
      query.set("poll_interval_s", String(interval));
      return bodyOf(request("GET", `/v1/messages?${query}`, {
        maxBytes: MAX_PAGE_RESPONSE_BYTES, attempts: 1, signal, deadline,
      })).then(page => {
      if (!Array.isArray(page?.messages) || (page.messages.length && (!Number.isSafeInteger(page.next_after) || page.next_after < 0))) {
        throw new RelayError({ status: 200, code: "invalid_response", message: "invalid relay page metadata" });
      }
      return page;
      });
    },

    ack(upToSeq, { signal, deadline } = {}) {
      return bodyOf(request("POST", "/v1/acks", {
        body: json({ up_to_seq: upToSeq }), attempts: 1, signal, deadline,
      }));
    },
  };
}
