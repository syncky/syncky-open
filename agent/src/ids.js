import { getRandomValues } from "node:crypto";

export const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const HUB_ID_RE = /^hub_[A-Za-z0-9_-]{22}$/;
export const MEMBER_ID_RE = /^m_(agent|dev)_[1-9][0-9]{0,5}$/;
export const TOKEN_RE = /^sk_(hub_[A-Za-z0-9_-]{22})_([A-Za-z0-9_-]{40})$/;
export const WEBHOOK_SECRET_RE = /^whsec_[A-Za-z0-9_-]{43}$/;
export const PAIRING_ID_RE = /^p_[A-Za-z0-9_-]{22}$/;
export const PAIRING_TOKEN_RE = /^pt_[A-Za-z0-9_-]{43}$/;
export const COMMAND_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
export const SAMPLE_UUID_RE = /^[A-Za-z0-9:_-]{1,64}$/;
export const X25519_KEY_RE = /^[A-Za-z0-9_-]{43}$/;

const tester = (re) => (value) => typeof value === "string" && re.test(value);

export const isUuidV7 = tester(UUID_V7_RE);
export const isHubId = tester(HUB_ID_RE);
export const isMemberId = tester(MEMBER_ID_RE);
export const isToken = tester(TOKEN_RE);
export const isWebhookSecret = tester(WEBHOOK_SECRET_RE);
export const isPairingId = tester(PAIRING_ID_RE);
export const isPairingToken = tester(PAIRING_TOKEN_RE);
export const isCommandId = tester(COMMAND_ID_RE);
export const isSampleUuid = tester(SAMPLE_UUID_RE);
export const isX25519KeyString = tester(X25519_KEY_RE);

export function hubIdFromToken(token) {
  if (typeof token !== "string") return null;
  return TOKEN_RE.exec(token)?.[1] ?? null;
}

const TAIL_BITS = 74n;
const TAIL_MAX = (1n << TAIL_BITS) - 1n;
const MAX_MS = 2 ** 48 - 1;
const defaultRandom = (n) => getRandomValues(new Uint8Array(n));

function randomTail(random) {
  const bytes = random(10);
  let tail = 0n;
  for (const b of bytes) tail = (tail << 8n) | BigInt(b);
  return tail & TAIL_MAX;
}

function formatUuidV7(ms, tail) {
  const randA = (tail >> 62n) & 0xfffn;
  const randB = tail & ((1n << 62n) - 1n);
  const hex =
    ms.toString(16).padStart(12, "0") +
    (0x7000n | randA).toString(16).padStart(4, "0") +
    ((2n << 62n) | randB).toString(16).padStart(16, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createUuidV7Generator(defaults = {}) {
  let lastMs = -1;
  let lastTail = 0n;
  return ({ now = defaults.now ?? Date.now, random = defaults.random ?? defaultRandom } = {}) => {
    let ms = Math.floor(now());
    if (!Number.isSafeInteger(ms) || ms < 0 || ms > MAX_MS) throw new RangeError("uuidv7: clock out of range");
    let tail;
    if (ms <= lastMs) {
      ms = lastMs;
      tail = lastTail + 1n;
      if (tail > TAIL_MAX) {
        ms += 1;
        tail = randomTail(random);
      }
    } else {
      tail = randomTail(random);
    }
    lastMs = ms;
    lastTail = tail;
    return formatUuidV7(ms, tail);
  };
}

export const uuidv7 = createUuidV7Generator();

export function uuidv7Timestamp(id) {
  if (!isUuidV7(id)) return null;
  return parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
}
