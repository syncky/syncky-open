import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import {
  EncodingError,
  b64uDecode,
  b64uEncode,
  concatBytes,
  constantTimeEqual,
  deviceName,
  formatTimestamp,
  isB64u,
  isSafeInt,
  isTimestamp,
  parseTimestamp,
  printable,
  toHex,
  utf8,
  utf8Decode,
} from "../../src/encoding.js";

const malformed = (fn) => assert.throws(fn, (err) => err instanceof EncodingError && err.code === "malformed");

describe("base64url", () => {
  it("round trips every length from 0 to 64", () => {
    for (let len = 0; len <= 64; len++) {
      for (let round = 0; round < 8; round++) {
        const bytes = new Uint8Array(randomBytes(len));
        const text = b64uEncode(bytes);
        assert.match(text, /^[A-Za-z0-9_-]*$/);
        assert.equal(text.length % 4 === 1, false);
        assert.deepEqual(b64uDecode(text), bytes);
        assert.deepEqual(b64uDecode(text, { length: len }), bytes);
      }
    }
  });

  it("encodes a subarray view, not the whole backing buffer", () => {
    const backing = new Uint8Array([0xff, 0x00, 0x01, 0x02, 0xff]);
    assert.equal(b64uEncode(backing.subarray(1, 4)), "AAEC");
  });

  it("returns a plain Uint8Array that owns its buffer", () => {
    const out = b64uDecode("AAEC");
    assert.equal(Object.getPrototypeOf(out), Uint8Array.prototype);
    assert.equal(out.buffer.byteLength, 3);
  });

  it("rejects padding, non-alphabet characters and whitespace", () => {
    for (const bad of ["AA==", "AAE=", "AB+C", "AB/C", "AB C", "ABC\n", " ABC", "AB\tC", "ÄBCD"]) {
      malformed(() => b64uDecode(bad));
      assert.equal(isB64u(bad), false);
    }
  });

  it("rejects non-strings", () => {
    malformed(() => b64uDecode(undefined));
    malformed(() => b64uDecode(42));
  });

  it("rejects a length of 4k+1", () => {
    for (const bad of ["A", "AAAAA", "AAAAAAAAA"]) malformed(() => b64uDecode(bad));
  });

  it("rejects non-canonical trailing bits", () => {
    assert.deepEqual(b64uDecode("AA"), new Uint8Array([0]));
    malformed(() => b64uDecode("AB"));
    malformed(() => b64uDecode("AP"));
    assert.deepEqual(b64uDecode("AAE"), new Uint8Array([0, 1]));
    malformed(() => b64uDecode("AAF"));
    malformed(() => b64uDecode("AAH"));
    assert.equal(isB64u("AAE"), true);
    assert.equal(isB64u("AAF"), false);
  });

  it("checks a fixed decoded length", () => {
    const key = b64uEncode(new Uint8Array(32).fill(7));
    assert.equal(key.length, 43);
    assert.equal(b64uDecode(key, { length: 32 }).length, 32);
    malformed(() => b64uDecode(key, { length: 31 }));
    malformed(() => b64uDecode(key.slice(0, 42), { length: 32 }));
    assert.equal(isB64u(key, { length: 33 }), false);
  });
});

describe("bytes helpers", () => {
  it("utf8 encodes and strictly decodes", () => {
    assert.deepEqual(utf8("syncky-cek-v1"), new Uint8Array(Buffer.from("syncky-cek-v1")));
    assert.equal(utf8Decode(utf8("héllo ✓")), "héllo ✓");
    malformed(() => utf8Decode(new Uint8Array([0xc3, 0x28])));
  });

  it("concatenates byte arrays", () => {
    assert.deepEqual(concatBytes(), new Uint8Array());
    assert.deepEqual(
      concatBytes(new Uint8Array([1]), new Uint8Array(), new Uint8Array([2, 3])),
      new Uint8Array([1, 2, 3]),
    );
  });

  it("hex encodes a view", () => {
    assert.equal(toHex(new Uint8Array([0, 15, 255]).subarray(1)), "0fff");
  });

  it("compares in constant time with a length check first", () => {
    assert.equal(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2])), true);
    assert.equal(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3])), false);
    assert.equal(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3])), false);
    assert.equal(constantTimeEqual("abc", "abc"), true);
    assert.equal(constantTimeEqual("abc", "abd"), false);
    assert.equal(constantTimeEqual("abc", "abcd"), false);
  });
});

describe("timestamps", () => {
  it("emits seconds precision when the milliseconds are zero", () => {
    assert.equal(formatTimestamp(new Date(Date.UTC(2026, 9, 11, 8, 5, 3))), "2026-10-11T08:05:03Z");
    assert.equal(formatTimestamp(Date.UTC(2026, 9, 11, 8, 5, 3, 0)), "2026-10-11T08:05:03Z");
  });

  it("emits exactly three fraction digits otherwise", () => {
    assert.equal(formatTimestamp(new Date(Date.UTC(2026, 9, 11, 8, 5, 3, 7))), "2026-10-11T08:05:03.007Z");
    assert.equal(formatTimestamp(Date.UTC(2026, 0, 1, 0, 0, 0, 120)), "2026-01-01T00:00:00.120Z");
  });

  it("refuses an invalid date", () => {
    assert.throws(() => formatTimestamp(new Date(NaN)), RangeError);
  });

  it("round trips emitted timestamps", () => {
    for (const ms of [0, 1, 999, 1_760_000_000_000, 1_760_000_000_123]) {
      assert.equal(parseTimestamp(formatTimestamp(ms)), ms);
    }
  });

  it("accepts offsets, 0 to 9 fraction digits and lowercase t/z", () => {
    const base = Date.UTC(2026, 9, 11, 8, 0, 0);
    assert.equal(parseTimestamp("2026-10-11T08:00:00Z"), base);
    assert.equal(parseTimestamp("2026-10-11T10:00:00+02:00"), base);
    assert.equal(parseTimestamp("2026-10-11T05:30:00-02:30"), base);
    assert.equal(parseTimestamp("2026-10-11T08:00:00+00:00"), base);
    assert.equal(parseTimestamp("2026-10-11t08:00:00z"), base);
    assert.equal(parseTimestamp("2026-10-11t08:00:00Z"), base);
    assert.equal(parseTimestamp("2026-10-11T08:00:00.5Z"), base + 500);
    assert.equal(parseTimestamp("2026-10-11T08:00:00.123456789Z"), base + 123);
    assert.equal(parseTimestamp("2026-10-11T08:00:00.000000000Z"), base);
    assert.equal(parseTimestamp("2024-02-29T00:00:00Z"), Date.UTC(2024, 1, 29));
    assert.equal(parseTimestamp("2000-02-29T00:00:00Z"), Date.UTC(2000, 1, 29));
    assert.equal(parseTimestamp("1969-12-31T23:59:59Z"), -1000);
    assert.equal(isTimestamp("2026-10-11T08:00:00Z"), true);
  });

  it("rejects everything else", () => {
    for (const bad of [
      "2026-10-11 08:00:00Z",
      "2026-10-1108:00:00Z",
      "2026-10-11T08:00:00",
      "2026-10-11T08:00Z",
      "2026-10-11T24:00:00Z",
      "2026-10-11T23:60:00Z",
      "2026-10-11T23:59:60Z",
      "2026-02-30T00:00:00Z",
      "2026-02-29T00:00:00Z",
      "1900-02-29T00:00:00Z",
      "2026-04-31T00:00:00Z",
      "2026-13-01T00:00:00Z",
      "2026-00-01T00:00:00Z",
      "2026-01-00T00:00:00Z",
      "2026-10-11T08:00:00+0200",
      "2026-10-11T08:00:00+02",
      "2026-10-11T08:00:00+24:00",
      "2026-10-11T08:00:00+02:60",
      "2026-10-11T08:00:00.1234567890Z",
      "2026-10-11T08:00:00.Z",
      "2026-10-11T08:00:00,5Z",
      "26-10-11T08:00:00Z",
      " 2026-10-11T08:00:00Z",
      "2026-10-11T08:00:00Z ",
      "",
      "1760000000",
    ]) {
      assert.equal(parseTimestamp(bad), null, bad);
      assert.equal(isTimestamp(bad), false, bad);
    }
    assert.equal(parseTimestamp(1_760_000_000_000), null);
    assert.equal(parseTimestamp(null), null);
  });
});

describe("integers", () => {
  it("are value-based within 1..2^53-1 by default", () => {
    assert.equal(isSafeInt(1), true);
    assert.equal(isSafeInt(JSON.parse("1.0")), true);
    assert.equal(isSafeInt(JSON.parse("1e0")), true);
    assert.equal(isSafeInt(2 ** 53 - 1), true);
    assert.equal(isSafeInt(2 ** 53), false);
    assert.equal(isSafeInt(0), false);
    assert.equal(isSafeInt(-1), false);
    assert.equal(isSafeInt(1.5), false);
    assert.equal(isSafeInt("1"), false);
    assert.equal(isSafeInt(true), false);
    assert.equal(isSafeInt(null), false);
    assert.equal(isSafeInt(NaN), false);
    assert.equal(isSafeInt(Infinity), false);
    assert.equal(isSafeInt(1n), false);
  });

  it("honors a custom minimum", () => {
    assert.equal(isSafeInt(0, { min: 0 }), true);
    assert.equal(isSafeInt(-1, { min: 0 }), false);
    assert.equal(isSafeInt(2 ** 53, { min: 0 }), false);
  });
});

describe("printable", () => {
  it("escapes terminal control and bidi characters and keeps the rest", () => {
    assert.equal(printable("a\u001b[8mb\rc\u009bd"), "a\\u{1b}[8mb\\u{d}c\\u{9b}d");
    assert.equal(printable("x\u202ey\u2067z\u2028"), "x\\u{202e}y\\u{2067}z\\u{2028}");
    assert.equal(printable("Anna's iPhone 👨‍👩‍👧 ü"), "Anna's iPhone 👨‍👩‍👧 ü");
  });
});

describe("deviceName", () => {
  it("accepts what the relay accepts and nothing else", () => {
    assert.equal(deviceName("  Phone "), "Phone");
    assert.equal(deviceName("😀".repeat(64)), "😀".repeat(64));
    assert.equal(deviceName("😀".repeat(65)), null);
    assert.equal(deviceName("   "), null);
    assert.equal(deviceName("ok\u001b[2Kfake"), null);
    assert.equal(deviceName("ok\u0085"), null);
    for (const name of ["a\u200eb", "a\u200db", "a\ufeffb", "\ufeffPhone", "Phone\ufeff", "a\u00adb", "a\u{e0001}b", "\u{1f469}\u200d\u{1f4bb}"]) {
      assert.equal(deviceName(name), null);
    }
    assert.equal(deviceName(7), null);
    assert.equal(deviceName(undefined), null);
  });
});
