import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createUuidV7Generator,
  hubIdFromToken,
  isCommandId,
  isHubId,
  isMemberId,
  isPairingId,
  isPairingToken,
  isSampleUuid,
  isToken,
  isUuidV7,
  isWebhookSecret,
  isX25519KeyString,
  uuidv7,
  uuidv7Timestamp,
} from "../../src/ids.js";

const B22 = "AbCdEfGhIjKlMnOpQr_-01";
const B40 = "abcdefghijklmnopqrstuvwxyz0123456789_-AB";
const B43 = "abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE";
const HUB = `hub_${B22}`;
const TOKEN = `sk_${HUB}_${B40}`;

function cases(predicate, valid, invalid) {
  for (const v of valid) assert.equal(predicate(v), true, `expected valid: ${JSON.stringify(v)}`);
  for (const v of invalid) assert.equal(predicate(v), false, `expected invalid: ${JSON.stringify(v)}`);
}

describe("identifier formats", () => {
  it("hub_id", () => {
    cases(isHubId, [HUB], [`hub_${B22}x`, `hub_${B22.slice(1)}`, `hub_${B22.slice(1)}=`, `Hub_${B22}`, `hub_${B22.slice(1)}+`, "", null, 7]);
  });

  it("member_id", () => {
    cases(
      isMemberId,
      ["m_agent_1", "m_dev_1", "m_dev_999999", "m_agent_10"],
      ["m_agent_0", "m_dev_01", "m_dev_1000000", "m_device_1", "m_agent_", "m_agent_-1", " m_dev_1", undefined],
    );
  });

  it("token", () => {
    cases(isToken, [TOKEN], [`sk_${HUB}_${B40}x`, `sk_${HUB}_${B40.slice(1)}`, `sk_hub_${B22.slice(1)}_${B40}`, `pk_${HUB}_${B40}`, `sk_${HUB}${B40}`, {}]);
  });

  it("webhook_secret", () => {
    cases(isWebhookSecret, [`whsec_${B43}`], [`whsec_${B43.slice(1)}`, `whsec_${B43}A`, `whsec_${B43.slice(1)}=`, `whsk_${B43}`]);
  });

  it("pairing_id and pairing_token", () => {
    cases(isPairingId, [`p_${B22}`], [`p_${B22}A`, `p_${B22.slice(1)}`, `pt_${B22}`]);
    cases(isPairingToken, [`pt_${B43}`], [`pt_${B43}A`, `pt_${B43.slice(1)}`, `p_${B43}`, `pt_${B43.slice(1)}!`]);
  });

  it("command_id", () => {
    cases(
      isCommandId,
      ["c1", "cmd.water:2026-10-11_1", "A".repeat(64), "-"],
      ["", "A".repeat(65), "has space", "slash/no", "ümlaut", "a+b"],
    );
  });

  it("sample uuid", () => {
    cases(
      isSampleUuid,
      ["F2A1C9E4-7B3D-4C6E-9A1B-2D3E4F5A6B7C", "characteristic:date_of_birth", "x".repeat(64)],
      ["", "x".repeat(65), "dotted.uuid", "with space", "a/b"],
    );
  });

  it("X25519 key strings and lowercase UUIDv7 msg ids", () => {
    cases(isX25519KeyString, [B43], [B43.slice(1), `${B43}A`, `${B43.slice(1)}=`]);
    cases(isUuidV7, ["01890a5d-ac96-774b-bcce-b302099a8057"], ["01890A5D-AC96-774B-BCCE-B302099A8057"]);
  });

  it("extracts the hub id from a token", () => {
    assert.equal(hubIdFromToken(TOKEN), HUB);
    assert.equal(hubIdFromToken(`${TOKEN}x`), null);
    assert.equal(hubIdFromToken(`sk_hub_short_${B40}`), null);
    assert.equal(hubIdFromToken(""), null);
    assert.equal(hubIdFromToken(undefined), null);
  });
});

describe("uuidv7", () => {
  it("default generator emits valid, unique, ordered ids", () => {
    const ids = Array.from({ length: 10_000 }, () => uuidv7());
    assert.equal(new Set(ids).size, ids.length);
    for (let i = 0; i < ids.length; i++) {
      assert.ok(isUuidV7(ids[i]), ids[i]);
      if (i > 0) assert.ok(ids[i] > ids[i - 1]);
    }
    const ms = uuidv7Timestamp(ids[0]);
    assert.ok(Math.abs(ms - Date.now()) < 60_000);
  });

  it("embeds the injected clock in the first 48 bits", () => {
    const gen = createUuidV7Generator();
    let t = 1_760_000_000_000;
    for (let i = 0; i < 100; i++) {
      t += 1 + (i % 7);
      const id = gen({ now: () => t });
      assert.equal(uuidv7Timestamp(id), t);
      assert.equal(id.slice(0, 13).replace("-", ""), t.toString(16).padStart(12, "0"));
    }
  });

  it("sets the version and variant bits", () => {
    const gen = createUuidV7Generator({ random: (n) => new Uint8Array(n).fill(0xff) });
    const id = gen({ now: () => 0 });
    assert.equal(id, "00000000-0000-7fff-bfff-ffffffffffff");
    const zero = createUuidV7Generator({ random: (n) => new Uint8Array(n) })({ now: () => 1 });
    assert.equal(zero, "00000000-0001-7000-8000-000000000000");
    for (let i = 0; i < 200; i++) {
      const v = uuidv7();
      assert.equal(v[14], "7");
      assert.ok("89ab".includes(v[19]));
    }
  });

  it("is strictly increasing under a frozen clock and keeps the timestamp", () => {
    const now = 1_760_000_000_123;
    const gen = createUuidV7Generator({ now: () => now });
    const ids = Array.from({ length: 10_000 }, () => gen());
    assert.equal(new Set(ids).size, ids.length);
    for (let i = 0; i < ids.length; i++) {
      assert.ok(isUuidV7(ids[i]));
      assert.equal(uuidv7Timestamp(ids[i]), now);
      if (i > 0) assert.ok(ids[i] > ids[i - 1], `${ids[i - 1]} !< ${ids[i]}`);
    }
  });

  it("stays monotonic when the clock goes backwards", () => {
    let t = 2_000_000_000_000;
    const gen = createUuidV7Generator({ now: () => t });
    const a = gen();
    t -= 5_000;
    const b = gen();
    assert.ok(b > a);
    assert.equal(uuidv7Timestamp(b), 2_000_000_000_000);
  });

  it("moves to the next millisecond when the random tail overflows", () => {
    const gen = createUuidV7Generator({ now: () => 5, random: (n) => new Uint8Array(n).fill(0xff) });
    const a = gen();
    assert.equal(a, "00000000-0005-7fff-bfff-ffffffffffff");
    const b = gen();
    assert.equal(uuidv7Timestamp(b), 6);
    assert.ok(b > a);
  });

  it("refuses an out-of-range clock", () => {
    const gen = createUuidV7Generator();
    assert.throws(() => gen({ now: () => -1 }), RangeError);
    assert.throws(() => gen({ now: () => 2 ** 48 }), RangeError);
    assert.throws(() => gen({ now: () => NaN }), RangeError);
  });

  it("reads no timestamp from a non-v7 string", () => {
    assert.equal(uuidv7Timestamp("not-a-uuid"), null);
  });
});
