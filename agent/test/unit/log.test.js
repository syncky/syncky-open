import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { REDACTED, clearRegisteredSecrets, createLogger, redact, registerSecret } from "../../src/log.js";

const TOKEN = "sk_hub_AbCdEfGhIjKlMnOpQr_-01_abcdefghijklmnopqrstuvwxyz0123456789_-AB";
const WHSEC = "whsec_abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE";
const PAIRING = "pt_abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE";
const PRIVATE_KEY = "Xq3vB1nM8kL0pZ7wR2tY5uI9oA4sD6fG1hJ3kL5zX7c";

function capture(options = {}) {
  const lines = [];
  const logger = createLogger({ level: "debug", sink: (line) => lines.push(line), ...options });
  return { logger, lines, entries: () => lines.map((l) => JSON.parse(l)) };
}

describe("log", () => {
  afterEach(() => clearRegisteredSecrets());

  it("writes one JSON line per event with level, name and event", () => {
    const { logger, lines, entries } = capture({ name: "agent", now: () => new Date(Date.UTC(2026, 9, 11)) });
    logger.info("serve_started", { port: 8790, mode: "webhook" });
    assert.equal(lines.length, 1);
    assert.ok(!lines[0].includes("\n"));
    assert.deepEqual(entries()[0], {
      t: "2026-10-11T00:00:00.000Z",
      level: "info",
      name: "agent",
      event: "serve_started",
      port: 8790,
      mode: "webhook",
    });
  });

  it("does not let fields override the reserved keys", () => {
    const { logger, entries } = capture();
    logger.warn("real_event", { level: "debug", event: "fake", t: "x" });
    const [e] = entries();
    assert.equal(e.level, "warn");
    assert.equal(e.event, "real_event");
    assert.notEqual(e.t, "x");
  });

  it("redacts every credential pattern in event names, nested fields and error messages", () => {
    const { logger, lines } = capture();
    for (const secret of [TOKEN, WHSEC, PAIRING]) {
      logger.error(`failed_${secret}`, {
        url: `https://relay.example/v1/x?t=${secret}`,
        nested: { deeper: [{ note: `prefix ${secret} suffix` }] },
        err: new Error(`bad ${secret}`),
        [`key_${secret}`]: 1,
      });
    }
    logger.info("auth", { header: "Bearer abc.def-ghi" });
    const text = lines.join("\n");
    for (const secret of [TOKEN, WHSEC, PAIRING, "abc.def-ghi"]) assert.ok(!text.includes(secret), secret);
    assert.ok(text.includes(REDACTED));
    assert.ok(text.includes("prefix [redacted] suffix"));
  });

  it("masks partial tokens and leaves ordinary words alone", () => {
    assert.equal(redact("x sk_hub_ y"), `x ${REDACTED} y`);
    assert.equal(redact("t=pt_abc"), `t=${REDACTED}`);
    assert.equal(redact("receipt_count attempt_no"), "receipt_count attempt_no");
    assert.equal(redact(42), "42");
  });

  it("redacts registered secrets wherever they appear", () => {
    registerSecret(PRIVATE_KEY);
    registerSecret("dev-invite-value");
    const { logger, lines } = capture();
    logger.debug(`event ${PRIVATE_KEY}`, {
      a: `x${PRIVATE_KEY}y`,
      list: ["dev-invite-value"],
      err: Object.assign(new Error(`invite dev-invite-value rejected`), { code: "invalid_invite", status: 403 }),
    });
    const text = lines.join("\n");
    assert.ok(!text.includes(PRIVATE_KEY));
    assert.ok(!text.includes("dev-invite-value"));
    const [e] = lines.map((l) => JSON.parse(l));
    assert.deepEqual(e.err, { name: "Error", message: `invite ${REDACTED} rejected`, code: "invalid_invite", status: 403 });
  });

  it("ignores registrations that are too short or not strings", () => {
    registerSecret("");
    registerSecret("abc");
    registerSecret(undefined);
    assert.equal(redact("abc def"), "abc def");
  });

  it("drops policy fields at every depth", () => {
    const { logger, lines, entries } = capture();
    logger.info("sync_received", {
      count: 3,
      plaintext: "73.123456",
      inner: { samples: [{ value: 73.123456 }] },
      samples: [1],
      nested: { value: 73.123456, private_key: "k", token: "t", webhook_secret: "w", cek: "c", kept: true },
    });
    const text = lines.join("\n");
    assert.ok(!text.includes("73.123456"));
    for (const field of ["plaintext", "inner", "samples", "value", "private_key", "token", "webhook_secret", "cek"]) {
      assert.ok(!text.includes(`"${field}"`), field);
    }
    assert.deepEqual(entries()[0].nested, { kept: true });
  });

  it("never serializes byte contents", () => {
    const { logger, entries } = capture();
    logger.info("bytes", { key: new Uint8Array([1, 2, 3]), buf: Buffer.from("secret"), ab: new ArrayBuffer(4) });
    const [e] = entries();
    assert.equal(e.key, "[bytes 3]");
    assert.equal(e.buf, "[bytes 6]");
    assert.equal(e.ab, "[bytes 4]");
  });

  it("renders other value types safely", () => {
    const { logger, entries } = capture();
    logger.info("types", {
      big: 12n,
      fn: () => 1,
      sym: Symbol("s"),
      nil: null,
      undef: undefined,
      flag: false,
      when: new Date(Date.UTC(2026, 0, 1)),
      bad: new Date(NaN),
      arr: [1, undefined, () => 2],
    });
    const [e] = entries();
    assert.equal(e.big, "12");
    assert.equal("fn" in e, false);
    assert.equal("sym" in e, false);
    assert.equal(e.nil, null);
    assert.equal(e.undef, null);
    assert.equal(e.flag, false);
    assert.equal(e.when, "2026-01-01T00:00:00.000Z");
    assert.equal(e.bad, "Invalid Date");
    assert.deepEqual(e.arr, [1, null, null]);
  });

  it("filters by level", () => {
    const { logger, entries } = capture({ level: "warn" });
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    assert.deepEqual(entries().map((e) => e.event), ["w", "e"]);

    const silent = capture({ level: "silent" });
    silent.logger.error("nothing");
    assert.equal(silent.lines.length, 0);
  });

  it("refuses an unknown level", () => {
    assert.throws(() => createLogger({ level: "verbose" }), RangeError);
  });

  it("does not throw on cyclic data, deep data, a bare Error or a broken sink", () => {
    const { logger, entries } = capture();
    const cyclic = { name: "a" };
    cyclic.self = cyclic;
    cyclic.list = [cyclic];
    let deep = {};
    const root = deep;
    for (let i = 0; i < 20; i++) deep = deep.next = {};
    const err = new Error("boom");
    err.cause = err;
    assert.doesNotThrow(() => logger.info("cyclic", { cyclic, root }));
    assert.doesNotThrow(() => logger.error("failure", err));
    assert.doesNotThrow(() => logger.info("no_fields"));
    assert.doesNotThrow(() => logger.info("scalar_fields", "just a string"));
    const [c, f, n, s] = entries();
    assert.equal(c.cyclic.self, "[circular]");
    assert.deepEqual(c.cyclic.list, ["[circular]"]);
    assert.ok(JSON.stringify(c.root).includes("[depth]"));
    assert.deepEqual(f.error, { name: "Error", message: "boom" });
    assert.equal(n.event, "no_fields");
    assert.equal(s.event, "scalar_fields");

    const broken = createLogger({ sink: () => { throw new Error("disk full"); } });
    assert.doesNotThrow(() => broken.error("x", { a: 1 }));
    const hostile = { get boom() { throw new Error("getter"); } };
    assert.doesNotThrow(() => logger.info("hostile", hostile));
  });

  it("allows a repeated non-cyclic reference", () => {
    const { logger, entries } = capture();
    const shared = { k: 1 };
    logger.info("shared", { a: shared, b: shared });
    const [e] = entries();
    assert.deepEqual(e.a, { k: 1 });
    assert.deepEqual(e.b, { k: 1 });
  });


  it("writes to stderr by default", () => {
    const original = process.stderr.write;
    const written = [];
    process.stderr.write = (chunk) => {
      written.push(String(chunk));
      return true;
    };
    try {
      createLogger().info("to_stderr", { n: 1 });
    } finally {
      process.stderr.write = original;
    }
    assert.equal(written.length, 1);
    assert.ok(written[0].endsWith("\n"));
    assert.equal(JSON.parse(written[0]).event, "to_stderr");
  });
});
