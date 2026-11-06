import { before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { generateKeyPair } from "../../src/crypto.js";
import { b64uDecode, b64uEncode, isTimestamp, utf8 } from "../../src/encoding.js";
import {
  ENVELOPE_KEYS,
  EnvelopeError,
  envelopeAad,
  openEnvelope,
  sealEnvelope,
  serializeEnvelope,
  validateEnvelopeShape,
} from "../support/envelope.js";
import { isUuidV7 } from "../../src/ids.js";

const HUB = "hub_AAAAAAAAAAAAAAAAAAAAAA";
const OTHER_HUB = "hub_BBBBBBBBBBBBBBBBBBBBBB";
const AGENT = "m_agent_1";
const PLAINTEXT = '{"v":1,"type":"sync","device":"m_dev_1","samples":[]}';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const members = {};
const registry = (memberId) => members[memberId]?.publicKey ?? null;
const selfOf = (memberId) => ({ memberId, privateKey: members[memberId].privateKey });
const recipientsOf = (ids) => ids.map((memberId) => ({ memberId, publicKey: members[memberId].publicKey }));

async function seal(ids, extra = {}) {
  return sealEnvelope({
    hubId: HUB,
    from: AGENT,
    recipients: recipientsOf(ids),
    senderPrivateKey: members[AGENT].privateKey,
    plaintext: utf8(PLAINTEXT),
    ...extra,
  });
}

function open(envelope, memberId, extra = {}) {
  return openEnvelope({ envelope, hubId: HUB, self: selfOf(memberId), senderKeyOf: registry, ...extra });
}

async function rejectsWith(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof EnvelopeError, `expected EnvelopeError, got ${err?.name}: ${err?.message}`);
    if (code !== undefined) assert.equal(err.code, code);
    return true;
  });
}

const clone = (value) => structuredClone(value);

function flipB64u(value, rng) {
  const bytes = b64uDecode(value);
  bytes[Math.floor(rng() * bytes.length)] ^= 1 << Math.floor(rng() * 8);
  return b64uEncode(bytes);
}

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_-";

function flipString(value, rng) {
  const i = Math.floor(rng() * value.length);
  let ch;
  do ch = ALPHABET[Math.floor(rng() * ALPHABET.length)];
  while (ch === value[i]);
  return value.slice(0, i) + ch + value.slice(i + 1);
}

before(async () => {
  for (const id of [AGENT, ...Array.from({ length: 8 }, (_, i) => `m_dev_${i + 1}`)]) {
    members[id] = await generateKeyPair();
  }
});

describe("sealEnvelope", () => {
  it("round-trips for 1 recipient and emits the canonical key order", async () => {
    const env = await seal(["m_dev_1"]);
    assert.deepEqual(Object.keys(env), [...ENVELOPE_KEYS]);
    assert.deepEqual(Object.keys(env.recipients[0]), ["member_id", "enc", "wrapped_key"]);
    assert.ok(isUuidV7(env.msg_id));
    assert.ok(isTimestamp(env.created_at));
    assert.equal(env.kind, "data");
    assert.equal(env.from, AGENT);
    assert.equal(b64uDecode(env.recipients[0].enc).length, 32);
    assert.equal(b64uDecode(env.recipients[0].wrapped_key).length, 48);
    assert.equal(b64uDecode(env.nonce).length, 12);
    assert.equal(b64uDecode(env.ciphertext).length, utf8(PLAINTEXT).length + 16);
    assert.deepEqual(await open(env, "m_dev_1"), utf8(PLAINTEXT));
    assert.deepStrictEqual(validateEnvelopeShape(env, { caller: AGENT, activeMembers: Object.keys(members) }), {
      status: 201,
    });
  });

  it("round-trips for 7 recipients and every recipient opens it", async () => {
    const ids = Array.from({ length: 7 }, (_, i) => `m_dev_${i + 1}`);
    const env = await seal(ids);
    assert.deepEqual(
      env.recipients.map((r) => r.member_id),
      ids,
    );
    for (const id of ids) assert.deepEqual(await open(env, id), utf8(PLAINTEXT));
    await rejectsWith(open(env, "m_dev_8"), "not_a_recipient");
  });

  it("accepts a string plaintext and serializes compactly", async () => {
    const env = await seal(["m_dev_1"], { plaintext: PLAINTEXT });
    assert.deepEqual(await open(env, "m_dev_1"), utf8(PLAINTEXT));
    const text = serializeEnvelope(env);
    assert.equal(text, JSON.stringify(env));
    assert.ok(!text.includes("\n") && !text.includes(": "));
  });

  it("draws the CEK first and then the nonce from the injected random source", async () => {
    const draws = [];
    const random = (n) => {
      draws.push(n);
      return new Uint8Array(n).fill(draws.length);
    };
    const env = await seal(["m_dev_1"], { random });
    assert.deepEqual(draws, [32, 12]);
    assert.deepEqual(b64uDecode(env.nonce), new Uint8Array(12).fill(2));
  });

  it("rejects bad recipient lists before drawing any randomness", async () => {
    let drawn = 0;
    const random = (n) => {
      drawn += 1;
      return new Uint8Array(n);
    };
    const eight = Array.from({ length: 8 }, (_, i) => `m_dev_${i + 1}`);
    for (const ids of [eight, ["m_dev_1", AGENT], [AGENT], [], ["m_dev_1", "m_dev_1"]]) {
      const recipients = ids.map((memberId) => ({ memberId, publicKey: members[memberId].publicKey }));
      await rejectsWith(
        sealEnvelope({
          hubId: HUB,
          from: AGENT,
          recipients,
          senderPrivateKey: members[AGENT].privateKey,
          plaintext: PLAINTEXT,
          random,
        }),
        "invalid_input",
      );
    }
    assert.equal(drawn, 0);
  });

  it("rejects invalid inputs with invalid_input", async () => {
    const good = {
      hubId: HUB,
      from: AGENT,
      recipients: recipientsOf(["m_dev_1"]),
      senderPrivateKey: members[AGENT].privateKey,
      plaintext: PLAINTEXT,
    };
    const bad = [
      { hubId: "hub_short" },
      { from: "agent" },
      { msgId: "not-a-uuid" },
      { createdAt: "2026-10-11 08:00:00Z" },
      { senderPrivateKey: new Uint8Array(31) },
      { senderPrivateKey: "key" },
      { plaintext: 42 },
      { recipients: "m_dev_1" },
      { recipients: [{ memberId: "dev", publicKey: members.m_dev_1.publicKey }] },
      { recipients: [{ memberId: "m_dev_1", publicKey: new Uint8Array(33) }] },
      { recipients: [null] },
    ];
    for (const override of bad) {
      await rejectsWith(sealEnvelope({ ...good, ...override }), "invalid_input");
    }
  });

  it("maps a crypto failure during sealing to an EnvelopeError", async () => {
    await rejectsWith(seal(["m_dev_1"], { ekmFor: () => "not bytes" }), "malformed");
  });
});

describe("openEnvelope", () => {
  let env;
  before(async () => {
    env = await seal(["m_dev_1", "m_dev_2", "m_dev_3"]);
  });

  it("a confirmed but different sender key gives hpke_open_failed", async () => {
    await rejectsWith(
      open(env, "m_dev_1", { senderKeyOf: (id) => (id === AGENT ? members.m_dev_8.publicKey : null) }),
      "hpke_open_failed",
    );
  });

  it("senderKeyOf returning null gives unknown_sender, and the sender key never comes from the envelope", async () => {
    let asked;
    await rejectsWith(
      open(env, "m_dev_1", {
        senderKeyOf: (id) => {
          asked = id;
          return null;
        },
      }),
      "unknown_sender",
    );
    assert.equal(asked, AGENT);
  });

  it("opens under the hub it was sealed for only", async () => {
    await rejectsWith(open(env, "m_dev_1", { hubId: OTHER_HUB }), "hpke_open_failed");
  });

  it("opens the delivered form that carries seq", async () => {
    assert.deepEqual(await open({ ...env, seq: 42 }, "m_dev_2"), utf8(PLAINTEXT));
  });

  it("measures only submitted fields for 4096-byte control deliveries", async () => {
    for (const markers of [{}, { diagnostics: "request" }, { diagnostics: "reply" }, { access: "request" }, { access: "reply" }]) {
      let options, length;
      for (const createdAt of ["2026-11-04T12:00:00Z", "2026-11-04T12:00:00.0Z", "2026-11-04T12:00:00.00Z"]) {
        options = { kind: "control", ...markers, createdAt };
        const empty = await seal(["m_dev_1"], { ...options, plaintext: "" });
        const overhead = utf8(serializeEnvelope(empty)).length - empty.ciphertext.length;
        length = Array.from({ length: 3000 }, (_, n) => n).find(n => overhead + Math.ceil((n + 16) * 4 / 3) === 4096);
        if (length !== undefined) break;
      }
      assert.notEqual(length, undefined);
      const plaintext = "x".repeat(length);
      const envelope = await seal(["m_dev_1"], { ...options, plaintext });
      assert.equal(utf8(serializeEnvelope(envelope)).length, 4096);
      assert.deepEqual(await open({ ...envelope, seq: Number.MAX_SAFE_INTEGER, extra: "metadata".repeat(1024) }, "m_dev_1"), utf8(plaintext));
      await rejectsWith(open({ ...envelope, ciphertext: envelope.ciphertext + "AAAA" }, "m_dev_1"), "malformed");
      await rejectsWith(seal(["m_dev_1"], { ...options, plaintext: plaintext + "xxx" }), "invalid_input");
    }
  });

  it("opens delivered envelopes with unknown metadata for ordinary and marked traffic", async () => {
    for (const [kind, diagnostics] of [["data", undefined], ["control", undefined], ["control", "request"], ["control", "reply"], ["data", "archive"]]) {
      const envelope = await seal(["m_dev_1"], { kind, diagnostics });
      assert.deepEqual(await open({ ...envelope, seq: 42, extra: true }, "m_dev_1"), utf8(PLAINTEXT));
    }
  });

  it("a corrupt wrapped_key of recipient 2 does not affect recipients 1 and 3", async () => {
    const mutated = clone(env);
    mutated.recipients[1].wrapped_key = flipB64u(mutated.recipients[1].wrapped_key, () => 0.5);
    assert.deepEqual(await open(mutated, "m_dev_1"), utf8(PLAINTEXT));
    assert.deepEqual(await open(mutated, "m_dev_3"), utf8(PLAINTEXT));
    await rejectsWith(open(mutated, "m_dev_2"), "hpke_open_failed");
  });

  it("rejects structural problems as malformed before any crypto", async () => {
    const cases = [
      null,
      [],
      "envelope",
      { ...env, v: 2 },
      { ...env, msg_id: "x" },
      { ...env, kind: "system" },
      { ...env, from: "" },
      { ...env, from: 7 },
      { ...env, created_at: "yesterday" },
      { ...env, recipients: [] },
      { ...env, recipients: {} },
      { ...env, recipients: [null] },
      { ...env, recipients: [{ ...env.recipients[0], member_id: 1 }] },
      { ...env, recipients: [{ ...env.recipients[0], enc: 5 }] },
      { ...env, nonce: `${env.nonce}=` },
      { ...env, ciphertext: b64uEncode(new Uint8Array(15)) },
    ];
    for (const envelope of cases) {
      await rejectsWith(
        open(envelope, "m_dev_1", {
          senderKeyOf: () => assert.fail("senderKeyOf must not be called for a malformed envelope"),
        }),
        "malformed",
      );
    }
  });

  it("random fuzz: dependent-field flips and deletions never open, other recipients' flips still open", async () => {
    const rng = mulberry32(0x5eed);
    const ids = ["m_dev_1", "m_dev_2", "m_dev_3"];
    const hits = { dependent: 0, deletion: 0, other: 0 };
    for (let iter = 0; iter < 500; iter += 1) {
      const selfIndex = Math.floor(rng() * ids.length);
      const self = ids[selfIndex];
      const mutated = clone(env);
      let hubId = HUB;
      const category = ["dependent", "deletion", "other"][Math.floor(rng() * 3)];
      hits[category] += 1;
      let label;
      if (category === "dependent") {
        const field = ["nonce", "ciphertext", "enc", "wrapped_key", "msg_id", "from", "hub"][Math.floor(rng() * 7)];
        label = field;
        if (field === "nonce" || field === "ciphertext") mutated[field] = flipB64u(mutated[field], rng);
        else if (field === "enc" || field === "wrapped_key") {
          mutated.recipients[selfIndex][field] = flipB64u(mutated.recipients[selfIndex][field], rng);
        } else if (field === "hub") hubId = `hub_${flipString(HUB.slice(4), rng)}`;
        else mutated[field] = flipString(mutated[field], rng);
      } else if (category === "deletion") {
        if (rng() < 0.5) {
          label = ENVELOPE_KEYS[Math.floor(rng() * ENVELOPE_KEYS.length)];
          delete mutated[label];
        } else {
          const r = Math.floor(rng() * ids.length);
          label = `recipients/${r}/${["member_id", "enc", "wrapped_key"][Math.floor(rng() * 3)]}`;
          delete mutated.recipients[r][label.split("/")[2]];
        }
      } else {
        const others = [0, 1, 2].filter((i) => i !== selfIndex);
        const r = others[Math.floor(rng() * others.length)];
        const field = rng() < 0.5 ? "enc" : "wrapped_key";
        label = `other ${field}`;
        mutated.recipients[r][field] = flipB64u(mutated.recipients[r][field], rng);
      }
      const attempt = open(mutated, self, { hubId });
      if (category === "other") {
        assert.deepEqual(await attempt, utf8(PLAINTEXT), `iteration ${iter} (${label}) must still open`);
      } else {
        await rejectsWith(attempt);
      }
    }
    for (const [category, n] of Object.entries(hits)) assert.ok(n > 100, `${category} hit only ${n} times`);
  });
});

describe("envelopeAad", () => {
  it("joins the fields with |", () => {
    assert.equal(envelopeAad(HUB, "m", "f"), `syncky-v1|${HUB}|m|f`);
  });
});

describe("diagnostics marker", () => {
  for (const [diagnostics, kind] of [["request", "control"], ["reply", "control"], ["archive", "data"]]) {
    it(`${diagnostics} binds both crypto layers and canonical serialization`, async () => {
      const env = await seal(["m_dev_1"], { diagnostics, kind });
      assert.equal(env.diagnostics, diagnostics);
      assert.deepEqual(Object.keys(env), ["v", "msg_id", "kind", "diagnostics", ...ENVELOPE_KEYS.slice(3)]);
      assert.equal(envelopeAad(HUB, env.msg_id, AGENT, kind, diagnostics),
        `syncky-v1|${HUB}|${env.msg_id}|${AGENT}${kind === "control" ? "|control" : ""}|diagnostics=${diagnostics}`);
      assert.deepEqual(await open(env, "m_dev_1"), utf8(PLAINTEXT));
      assert.equal(serializeEnvelope(Object.fromEntries(Object.entries(env).reverse())), JSON.stringify(env));
      const stripped = { ...env }; delete stripped.diagnostics;
      await rejectsWith(open(stripped, "m_dev_1"), "hpke_open_failed");
      const legacy = await seal(["m_dev_1"], { kind });
      await rejectsWith(open({ ...legacy, diagnostics }, "m_dev_1"), "hpke_open_failed");
      if (kind === "control") await rejectsWith(open({ ...env, diagnostics: diagnostics === "request" ? "reply" : "request" }, "m_dev_1"), "hpke_open_failed");
    });
  }

  it("rejects invalid optional values and kind combinations before crypto, and unexpected keys on submission", async () => {
    for (const [diagnostics, kind] of [[null, "data"], ["", "data"], [true, "data"], ["unknown", "data"], ["request", "data"], ["reply", "data"], ["archive", "control"]]) {
      await rejectsWith(seal(["m_dev_1"], { diagnostics, kind }), "invalid_input");
      const env = { ...await seal(["m_dev_1"], { kind }), diagnostics };
      await rejectsWith(open(env, "m_dev_1"), "malformed");
      assert.equal(validateEnvelopeShape(env, { caller: AGENT }).field, "/diagnostics");
    }
    const env = await seal(["m_dev_1"]);
    await rejectsWith(open({ ...env, diagnostics: undefined }, "m_dev_1"), "malformed");
    assert.deepEqual(validateEnvelopeShape({ ...env, extra: true }, { caller: AGENT }), {
      status: 400, error: "invalid_envelope", field: "/extra",
    });
  });
});
