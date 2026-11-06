import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  b64u,
  buildPairUri,
  envelopeAad,
  generateKeys,
  openEnvelope,
  pairCode,
  pairProof,
  parsePairUri,
  sealEnvelope,
  unb64u,
  uuidv7,
} from "../agent.mjs";

const vectors = (name) => JSON.parse(readFileSync(new URL(`../../../protocol/test-vectors/${name}.json`, import.meta.url), "utf8"));
const keys = vectors("keys");
const HUB = "hub_AAAAAAAAAAAAAAAAAAAAAA";
const self = (name) => ({ hubId: HUB, memberId: keys[name].member_id, sk: keys[name].sk });
const registryOf = (...names) => Object.fromEntries(names.map((n) => [keys[n].member_id, keys[n].pk]));
const recipientsOf = (...names) => names.map((n) => ({ member_id: keys[n].member_id, pk: keys[n].pk }));

async function rejects(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.code, code, err.message);
    return true;
  });
}

describe("envelopes.json", () => {
  const { cases } = vectors("envelopes");
  it("has data and control cases", () => {
    assert.ok(cases.filter((c) => c.envelope.kind === "data").length >= 6);
    assert.ok(cases.filter((c) => c.envelope.kind === "control").length >= 2);
  });
  for (const c of cases) {
    it(`${c.name}: every recipient opens it to the exact inner bytes`, async () => {
      assert.equal(envelopeAad(c.hub_id, c.envelope.msg_id, c.envelope.from, c.envelope.kind, c.envelope.diagnostics, c.envelope.access), c.aad);
      for (const r of c.recipients) {
        const text = await openEnvelope(c.envelope, {
          hubId: c.hub_id,
          memberId: r.member_id,
          sk: keys[r.key].sk,
          registry: registryOf(c.sender),
          kind: c.envelope.kind,
        });
        assert.deepEqual(Buffer.from(text, "utf8"), Buffer.from(c.plaintext, "utf8"));
      }
    });
  }
});

describe("envelopes-negative.json", () => {
  const { cases } = vectors("envelopes-negative");
  it("has cases, including both relabelled kinds", () => {
    assert.ok(cases.length >= 16);
    assert.ok(cases.some((c) => c.name === "kind_data_relabelled_as_control") && cases.some((c) => c.name === "kind_control_relabelled_as_data"));
  });
  for (const c of cases) {
    it(`${c.name}: rejected with ${c.expect}`, async () => {
      const receiver = { hubId: c.hub_id, memberId: keys[c.receiver].member_id, sk: keys[c.receiver].sk, registry: c.registry, kind: c.envelope.kind };
      await rejects(openEnvelope(c.envelope, receiver).then(text => {
        const inner = JSON.parse(text);
        if (Object.hasOwn(c.envelope, "diagnostics") && (inner?.v !== 1 || inner.type !== ({ archive: "diagnostics", request: "diagnostics_request", reply: "diagnostics_reply" })[c.envelope.diagnostics])) {
          throw Object.assign(new Error("invalid marked inner"), { code: "inner_invalid" });
        }
      }), c.expect);
    });
  }
});

describe("seal and open round trip", () => {
  it("one recipient", async () => {
    const plaintext = '{"v":1,"type":"commands","commands":[]}';
    const envelope = await sealEnvelope({ hubId: HUB, from: "m_agent_1", sk: keys.agent.sk, recipients: recipientsOf("dev1"), plaintext });
    assert.deepEqual(Object.keys(envelope), ["v", "msg_id", "kind", "from", "created_at", "recipients", "nonce", "ciphertext"]);
    assert.equal(envelope.kind, "data");
    assert.match(envelope.msg_id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.match(envelope.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.equal(await openEnvelope(envelope, { ...self("dev1"), registry: registryOf("agent") }), plaintext);
  });

  it("a control envelope binds its kind in the AAD: it opens only as control", async () => {
    const plaintext = '{"v":1,"type":"confirmed"}';
    const envelope = await sealEnvelope({ hubId: HUB, from: "m_agent_1", sk: keys.agent.sk, recipients: recipientsOf("dev1"), plaintext, kind: "control" });
    assert.equal(envelope.kind, "control");
    assert.equal(envelopeAad(HUB, envelope.msg_id, "m_agent_1", "control"), `syncky-v1|${HUB}|${envelope.msg_id}|m_agent_1|control`);
    const asDev1 = { ...self("dev1"), registry: registryOf("agent") };
    assert.equal(await openEnvelope(envelope, { ...asDev1, kind: "control" }), plaintext);
    await rejects(openEnvelope(envelope, asDev1), "malformed");
    await rejects(openEnvelope({ ...envelope, kind: "data" }, asDev1), "hpke_open_failed");
    const data = await sealEnvelope({ hubId: HUB, from: "m_agent_1", sk: keys.agent.sk, recipients: recipientsOf("dev1"), plaintext });
    await rejects(openEnvelope({ ...data, kind: "control" }, { ...asDev1, kind: "control" }), "hpke_open_failed");
  });

  it("three recipients, each opens it; a non-recipient cannot", async () => {
    const plaintext = "unicode ✓ 🙂 ".repeat(500);
    const envelope = await sealEnvelope({
      hubId: HUB,
      from: "m_agent_1",
      sk: keys.agent.sk,
      recipients: recipientsOf("dev1", "dev2", "mallory"),
      plaintext,
    });
    assert.deepEqual(envelope.recipients.map((r) => r.member_id), ["m_dev_1", "m_dev_2", "m_dev_9"]);
    for (const r of envelope.recipients) {
      assert.equal(unb64u(r.enc).length, 32);
      assert.equal(unb64u(r.wrapped_key).length, 48);
    }
    assert.equal(new Set(envelope.recipients.map((r) => r.enc)).size, 3);
    assert.equal(unb64u(envelope.nonce).length, 12);
    assert.equal(unb64u(envelope.ciphertext).length, Buffer.byteLength(plaintext) + 16);
    for (const name of ["dev1", "dev2", "mallory"]) {
      assert.equal(await openEnvelope(envelope, { ...self(name), registry: registryOf("agent") }), plaintext);
    }
    await rejects(openEnvelope(envelope, { ...self("agent"), registry: registryOf("agent") }), "not_a_recipient");
  });

  it("generated keys seal and open, and two messages never share a msg_id, CEK wrap or nonce", async () => {
    const a = await generateKeys();
    const b = await generateKeys();
    assert.equal(unb64u(a.sk, 32).length, 32);
    assert.notEqual(a.pk, b.pk);
    const seal = () =>
      sealEnvelope({ hubId: HUB, from: "m_agent_1", sk: a.sk, recipients: [{ member_id: "m_dev_1", pk: b.pk }], plaintext: "{}" });
    const [x, y] = [await seal(), await seal()];
    assert.notEqual(x.msg_id, y.msg_id);
    assert.notEqual(x.nonce, y.nonce);
    assert.notEqual(x.recipients[0].wrapped_key, y.recipients[0].wrapped_key);
    const opener = { hubId: HUB, memberId: "m_dev_1", sk: b.sk, registry: { m_agent_1: a.pk } };
    assert.equal(await openEnvelope(x, opener), "{}");
  });
});

describe("open error paths on freshly sealed envelopes", () => {
  const plaintext = '{"v":1,"type":"sync"}';
  const sealed = () => sealEnvelope({ hubId: HUB, from: "m_dev_1", sk: keys.dev1.sk, recipients: recipientsOf("agent"), plaintext });
  const asAgent = { ...self("agent"), registry: registryOf("dev1") };

  it("wrong recipient private key", async () => {
    await rejects(openEnvelope(await sealed(), { ...asAgent, sk: keys.mallory.sk }), "hpke_open_failed");
  });

  it("wrong sender key in the registry", async () => {
    await rejects(openEnvelope(await sealed(), { ...asAgent, registry: { m_dev_1: keys.mallory.pk } }), "hpke_open_failed");
  });

  it("tampered AAD: other hub, other msg_id, other registered sender", async () => {
    const envelope = await sealed();
    await rejects(openEnvelope(envelope, { ...asAgent, hubId: "hub_BBBBBBBBBBBBBBBBBBBBBB" }), "hpke_open_failed");
    await rejects(openEnvelope({ ...envelope, msg_id: uuidv7() }, asAgent), "hpke_open_failed");
    await rejects(
      openEnvelope({ ...envelope, from: "m_dev_2" }, { ...asAgent, registry: registryOf("dev1", "dev2") }),
      "hpke_open_failed",
    );
  });

  it("sender not in the registry", async () => {
    await rejects(openEnvelope(await sealed(), { ...asAgent, registry: {} }), "unknown_sender");
    await rejects(openEnvelope({ ...(await sealed()), from: "__proto__" }, asAgent), "unknown_sender");
  });

  it("truncated ciphertext: below the tag is malformed, otherwise the tag fails", async () => {
    const envelope = await sealed();
    const ct = unb64u(envelope.ciphertext);
    await rejects(openEnvelope({ ...envelope, ciphertext: b64u(ct.subarray(0, 15)) }, asAgent), "malformed");
    await rejects(openEnvelope({ ...envelope, ciphertext: b64u(ct.subarray(0, ct.length - 1)) }, asAgent), "aead_failed");
    await rejects(openEnvelope({ ...envelope, ciphertext: b64u(ct.subarray(1)) }, asAgent), "aead_failed");
  });

  it("checks recipient and sender before decoding, and decodes only its own entry", async () => {
    const envelope = await sealed();
    const broken = { ...envelope, nonce: "AQ==", ciphertext: "!" };
    await rejects(openEnvelope(broken, { ...asAgent, memberId: "m_agent_2" }), "not_a_recipient");
    await rejects(openEnvelope(broken, { ...asAgent, registry: {} }), "unknown_sender");
    const other = { member_id: "m_dev_2", enc: "AQ==", wrapped_key: "x" };
    assert.equal(await openEnvelope({ ...envelope, recipients: [other, ...envelope.recipients] }, asAgent), plaintext);
  });

  it("not an envelope at all", async () => {
    for (const bad of [null, "x", {}, { v: 2 }, { ...(await sealed()), recipients: [] }, { ...(await sealed()), nonce: undefined }]) {
      await rejects(openEnvelope(bad, asAgent), "malformed");
    }
  });
});

describe("base64url", () => {
  it("accepts only canonical unpadded base64url", () => {
    assert.deepEqual([...unb64u("AQID")], [1, 2, 3]);
    assert.deepEqual([...unb64u("-_8")], [0xfb, 0xff]);
    for (const bad of ["AQID=", "AQ==", "A", "AQ+/", "AQ D", "AR", 7]) assert.throws(() => unb64u(bad), { code: "malformed" });
    assert.throws(() => unb64u("AQID", 4), { code: "malformed" });
  });
});

describe("uuidv7", () => {
  it("carries the millisecond timestamp, version 7 and the RFC 9562 variant", () => {
    const id = uuidv7(0x0192_3456_789a);
    assert.match(id, /^01923456-789a-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("pair-codes.json", () => {
  const { cases } = vectors("pair-codes");
  it("has cases", () => assert.ok(cases.length >= 4));
  for (const c of cases) {
    it(`${c.name}: code and proof`, () => {
      assert.equal(pairCode(c.pair_secret), c.code);
      assert.equal(pairProof(c.pair_secret, c.agent_public_key, c.device_public_key), c.proof);
    });
  }
  it("a code is three groups of three digits; the proof changes with either key", () => {
    const [c] = cases;
    assert.match(pairCode(c.pair_secret), /^\d{3} \d{3} \d{3}$/);
    assert.notEqual(pairProof(c.pair_secret, c.agent_public_key, keys.mallory.pk), c.proof);
    assert.notEqual(pairProof(c.pair_secret, keys.mallory.pk, c.device_public_key), c.proof);
    assert.equal(unb64u(c.proof, 32).length, 32);
  });
  it("the proof key must be 16 bytes of base64url", () => {
    const [c] = cases;
    assert.throws(() => pairProof(c.pair_secret.slice(1), c.agent_public_key, c.device_public_key), { code: "malformed" });
    assert.throws(() => pairProof(`${c.pair_secret}=`, c.agent_public_key, c.device_public_key), { code: "malformed" });
  });
});

describe("pair-uris.json", () => {
  const { cases } = vectors("pair-uris");
  const parseCases = cases.filter((c) => c.expect);
  const buildCases = cases.filter((c) => c.input);
  it("supports all three schemes in v1/v2 helpers, with a production default and no builder-only parse field", () => {
    for (const c of buildCases) {
      for (const urlScheme of ["syncky", "syncky-dev", "syncky-staging"]) {
        const { url_scheme, ...expected } = c.input;
        const uri = buildPairUri({ ...expected, url_scheme: urlScheme });
        assert.equal(uri, c.uri.replace(/^syncky(?:-dev|-staging)?:/, `${urlScheme}:`));
        assert.deepEqual(parsePairUri(uri, true), { ok: true, ...expected });
      }
    }
    for (const scheme of ["Syncky", "syncky-dev-extra", "syncky-staging-extra", "https", "auto"]) {
      assert.deepEqual(parsePairUri(`${scheme}://pair`), { ok: false, error: "invalid_uri", param: "scheme" });
    }
    for (const url_scheme of [null, "", "auto", "syncky://", "syncky-dev ", 42, true]) {
      assert.throws(() => buildPairUri({ ...buildCases[0].input, url_scheme }));
    }
    const { url_scheme, ...input } = buildCases[0].input;
    assert.ok(buildPairUri({ ...input, relay_base: "https://relay-dev.syncky.app" }).startsWith("syncky://pair?"));
  });
  it("has parse ok, parse error and build cases, for v1 and v2", () => {
    assert.ok(parseCases.some((c) => c.expect.ok && c.expect.pair_secret === undefined));
    assert.ok(parseCases.some((c) => c.expect.ok && c.expect.pair_secret !== undefined));
    assert.ok(parseCases.some((c) => !c.expect.ok && c.expect.param === "c"));
    assert.ok(buildCases.length >= 6);
    assert.ok(buildCases.some((c) => c.input.pair_secret !== undefined) && buildCases.some((c) => c.input.pair_secret === undefined));
  });
  for (const c of parseCases) {
    it(`parse ${c.name}`, () => assert.deepEqual(parsePairUri(c.uri, c.allow_insecure), c.expect));
  }
  for (const c of buildCases) {
    it(`build ${c.name}`, () => {
      assert.equal(buildPairUri(c.input), c.uri);
      const parsed = parsePairUri(c.uri, true);
      const { url_scheme, ...expected } = c.input;
      assert.deepEqual(parsed, { ok: true, ...expected });
    });
  }
  it("rejects a raw lone surrogate in a value", () => {
    const uri = buildPairUri(buildCases[0].input).replace(/&n=[^&]*/, "&n=Mac\udc00");
    assert.deepEqual(parsePairUri(uri), { ok: false, error: "invalid_uri", param: "encoding" });
  });
});


describe("access marker authentication", () => {
  for (const access of ["request", "reply"]) it(`authenticates ${access}, rejects tampering, dual markers and mismatched inners`, async () => {
    const plaintext = JSON.stringify({ v: 1, type: `access_${access}` });
    const make = extra => sealEnvelope({ hubId: HUB, from: keys.agent.member_id, sk: keys.agent.sk, recipients: [{ member_id: keys.dev1.member_id, pk: keys.dev1.pk }], kind: "control", access, plaintext, ...extra });
    const me = { hubId: HUB, memberId: keys.dev1.member_id, sk: keys.dev1.sk, registry: { [keys.agent.member_id]: keys.agent.pk }, kind: "control" };
    const e = await make();
    assert.equal(await openEnvelope({ ...e, seq: 1, future: {} }, me), plaintext);
    assert.ok(envelopeAad(HUB, e.msg_id, e.from, "control", undefined, access).endsWith(`|control|access=${access}`));
    const stripped = { ...e }; delete stripped.access;
    await rejects(openEnvelope(stripped, me), "hpke_open_failed");
    await rejects(openEnvelope({ ...e, access: access === "request" ? "reply" : "request" }, me), "hpke_open_failed");
    const legacy = await make({ access: undefined });
    await rejects(openEnvelope({ ...legacy, access }, me), "hpke_open_failed");
    await rejects(openEnvelope(legacy, me), "inner_invalid");
    for (const bad of [null, "archive", "", true, [], {}]) {
      await rejects(openEnvelope({ ...e, access: bad }, me), "malformed");
      await rejects(make({ access: bad }), "invalid_input");
    }
    await rejects(openEnvelope({ ...e, diagnostics: "reply" }, me), "malformed");
    await rejects(make({ diagnostics: "reply" }), "invalid_input");
    await rejects(make({ kind: "data" }), "invalid_input");
    for (const plaintext of ['{"v":1,"type":"pair_proof"}', '{"v":2,"type":"access_reply"}', 'null', 'bad']) await rejects(openEnvelope(await make({ plaintext }), me), "inner_invalid");
  });
});
