import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { b64u, buildPairUri, envelopeAad, generateKeys, openEnvelope, pairCode, pairProof, proofMatches, sealEnvelope, unb64u, uuidTime, uuidv7 } from "../src/protocol.mjs";

const vectors = (name) => JSON.parse(readFileSync(new URL(`../../../protocol/test-vectors/${name}.json`, import.meta.url), "utf8"));
const keys = vectors("keys");
const HUB = "hub_AAAAAAAAAAAAAAAAAAAAAA";
const registryOf = (...names) => Object.fromEntries(names.map((n) => [keys[n].member_id, keys[n].pk]));

async function rejects(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.code, code, err.message);
    return true;
  });
}

describe("envelopes.json", () => {
  const { cases } = vectors("envelopes");
  for (const c of cases) {
    it(`${c.name}: every recipient opens it to the exact inner bytes`, async () => {
      assert.equal(envelopeAad(c.hub_id, c.envelope.msg_id, c.envelope.from, c.envelope.kind, c.envelope.diagnostics, c.envelope.access), c.aad);
      for (const r of c.recipients) {
        const text = await openEnvelope(c.envelope, { hubId: c.hub_id, memberId: r.member_id, sk: keys[r.key].sk, registry: registryOf(c.sender), kind: c.envelope.kind });
        assert.equal(text, c.plaintext);
      }
    });
  }
});

describe("envelopes-negative.json", () => {
  const { cases } = vectors("envelopes-negative");
  it("has cases", () => assert.ok(cases.length >= 16));
  for (const c of cases) {
    it(`${c.name}: rejected with ${c.expect}`, async () => {
      await rejects(openEnvelope(c.envelope, { hubId: c.hub_id, memberId: keys[c.receiver].member_id, sk: keys[c.receiver].sk, registry: c.registry, kind: c.envelope.kind }), c.expect);
    });
  }
});

describe("seal and open", () => {
  it("round-trips data and control envelopes and binds the kind", async () => {
    for (const kind of ["data", "control"]) {
      const plaintext = kind === "data" ? '{"v":1,"type":"commands","commands":[]}' : '{"v":1,"type":"confirmed"}';
      const e = await sealEnvelope({ hubId: HUB, from: "m_agent_1", sk: keys.agent.sk, recipients: [{ member_id: keys.dev1.member_id, pk: keys.dev1.pk }], plaintext, kind });
      assert.deepEqual(Object.keys(e), ["v", "msg_id", "kind", "from", "created_at", "recipients", "nonce", "ciphertext"]);
      assert.match(e.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      const me = { hubId: HUB, memberId: keys.dev1.member_id, sk: keys.dev1.sk, registry: registryOf("agent") };
      assert.equal(await openEnvelope(e, { ...me, kind }), plaintext);
      assert.equal(await openEnvelope({ ...e, seq: 42, future: true }, { ...me, kind }), plaintext);
      await rejects(openEnvelope({ ...e, kind: kind === "data" ? "control" : "data" }, { ...me, kind: kind === "data" ? "control" : "data" }), "hpke_open_failed");
    }
  });

  for (const [diagnostics, kind, type] of [["request", "control", "diagnostics_request"], ["reply", "control", "diagnostics_reply"], ["archive", "data", "diagnostics"]]) {
    it(`round-trips ${diagnostics} with canonical fields and ordered AAD suffixes`, async () => {
      const plaintext = JSON.stringify({ v: 1, type });
      const e = await sealEnvelope({ hubId: HUB, from: keys.agent.member_id, sk: keys.agent.sk, recipients: [{ member_id: keys.dev1.member_id, pk: keys.dev1.pk }], plaintext, kind, diagnostics });
      assert.deepEqual(Object.keys(e), ["v", "msg_id", "kind", "diagnostics", "from", "created_at", "recipients", "nonce", "ciphertext"]);
      assert.equal(e.diagnostics, diagnostics);
      assert.equal(envelopeAad(HUB, e.msg_id, e.from, kind, diagnostics), `syncky-v1|${HUB}|${e.msg_id}|${e.from}${kind === "control" ? "|control" : ""}|diagnostics=${diagnostics}`);
      const me = { hubId: HUB, memberId: keys.dev1.member_id, sk: keys.dev1.sk, registry: registryOf("agent"), kind };
      assert.equal(await openEnvelope(e, me), plaintext);
      const delivered = { ...e, seq: 42, future: {}, recipients: e.recipients.map(r => ({ ...r, future: true })) };
      assert.equal(await openEnvelope(delivered, me), plaintext);
      const stripped = { ...e };
      delete stripped.diagnostics;
      await rejects(openEnvelope(stripped, me), "hpke_open_failed");
    });

    it(`rejects authenticated ${diagnostics} with a mismatched or invalid inner`, async () => {
      for (const plaintext of ['{"v":1,"type":"sync"}', JSON.stringify({ v: 2, type }), "null", "not json"]) {
        const e = await sealEnvelope({ hubId: HUB, from: keys.agent.member_id, sk: keys.agent.sk, recipients: [{ member_id: keys.dev1.member_id, pk: keys.dev1.pk }], plaintext, kind, diagnostics });
        await rejects(openEnvelope(e, { hubId: HUB, memberId: keys.dev1.member_id, sk: keys.dev1.sk, registry: registryOf("agent"), kind }), "inner_invalid");
      }
    });
  }

  it("rejects invalid marker values and kind combinations before opening or sealing", async () => {
    for (const kind of ["data", "control"]) {
      const e = vectors("envelopes").cases.find(c => c.envelope.kind === kind && !Object.hasOwn(c.envelope, "diagnostics")).envelope;
      for (const diagnostics of [undefined, null, "", "unknown", true, 1, [], {}, ...(kind === "data" ? ["request", "reply"] : ["archive"])]) {
        await rejects(openEnvelope({ ...e, diagnostics }, { kind }), "malformed");
        if (diagnostics !== undefined) await rejects(sealEnvelope({ kind, diagnostics }), "invalid_input");
      }
    }
    for (const kind of ["system", "", null]) {
      await rejects(openEnvelope({ v: 1, kind, msg_id: "m", from: "f" }, { kind }), "malformed");
      await rejects(sealEnvelope({ kind }), "invalid_input");
    }
  });

  it("generates distinct 32-byte keys", async () => {
    const [a, b] = [await generateKeys(), await generateKeys()];
    assert.equal(unb64u(a.sk, 32).length, 32);
    assert.notEqual(a.pk, b.pk);
  });
});

describe("pair-codes.json", () => {
  const { cases } = vectors("pair-codes");
  for (const c of cases) {
    it(`${c.name}: code and proof`, async () => {
      assert.equal(await pairCode(c.pair_secret), c.code);
      const proof = await pairProof(c.pair_secret, c.agent_public_key, c.device_public_key);
      assert.equal(proof, c.proof);
      assert.ok(proofMatches(proof, c.proof));
      assert.ok(!proofMatches(proof, await pairProof(c.pair_secret, c.agent_public_key, (await generateKeys()).pk)));
      assert.ok(!proofMatches(proof, `${c.proof}=`));
      assert.ok(!proofMatches(proof, 42));
    });
  }
  it("refuses a malformed secret", async () => {
    await rejects(pairProof("short", keys.agent.pk, keys.dev1.pk), "malformed");
  });
});

describe("pair-uris.json", () => {
  const buildCases = vectors("pair-uris").cases.filter((c) => c.input);
  it("has v1 and v2 build cases", () => {
    assert.ok(buildCases.some((c) => c.input.pair_secret) && buildCases.some((c) => !c.input.pair_secret));
  });
  for (const c of buildCases) {
    it(`build ${c.name}, in each scheme`, () => {
      assert.equal(buildPairUri(c.input), c.uri);
      for (const url_scheme of ["syncky", "syncky-dev", "syncky-staging"]) {
        assert.equal(buildPairUri({ ...c.input, url_scheme }), `${url_scheme}://pair?${c.uri.split(/[?#]/)[1]}`);
      }
    });
  }
  it("normalizes requested types and appends the encoded triple after existing fields", () => {
    const input = buildCases[0].input;
    const requested_scope = { request_ref: "0123456789abcdef0123456789abcdef", read: ["heart_rate", "body_mass", "heart_rate"], write: [] };
    for (const pair_secret of [undefined, "AAECAwQFBgcICQoLDA0ODw"]) {
      const base = { ...input, relay_base: "http://localhost:8790", pair_secret, url_scheme: null };
      const uri = buildPairUri({ ...base, requested_scope });
      assert.equal(uri, buildPairUri(base) + "&request_ref=" + requested_scope.request_ref + "&read=%5B%22body_mass%22%2C%22heart_rate%22%5D&write=%5B%5D");
      assert.equal(new URL(uri).search, "");
      for (const url_scheme of ["syncky", "syncky-dev", "syncky-staging"]) assert.equal(buildPairUri({ ...base, requested_scope, url_scheme }), `${url_scheme}://pair?${new URL(uri).hash.slice(1)}`);
    }
    assert.deepEqual(requested_scope.read, ["heart_rate", "body_mass", "heart_rate"]);
  });
  it("refuses another scheme", () => {
    for (const url_scheme of ["https", "", "syncky://"]) assert.throws(() => buildPairUri({ ...buildCases[0].input, url_scheme }), TypeError);
  });
});

describe("encodings", () => {
  it("base64url is strict", () => {
    const bytes = Uint8Array.from({ length: 33 }, (_, i) => i * 7);
    assert.deepEqual(unb64u(b64u(bytes)), bytes);
    for (const bad of ["AAA=", "A", "AB", "AA+A", "AA/A", "A A", 7]) assert.throws(() => unb64u(bad), { code: "malformed" });
    assert.throws(() => unb64u(b64u(bytes), 32), { code: "malformed" });
  });

  it("uuidv7 carries the time and the version bits", () => {
    const id = uuidv7(1_700_000_000_123);
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(uuidTime(id), 1_700_000_000_123);
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


describe("HTTPS producer inference", () => {
  const input = vectors("pair-uris").cases.find(c => c.input).input;
  for (const [relay_base, site] of [
    ["https://relay.syncky.app", "syncky.app"],
    ["https://relay-dev.syncky.app:8443", "dev.syncky.app"],
    ["https://RELAY-DEV.SYNCKY.APP:443", "dev.syncky.app"],
    ["https://relay-staging.syncky.app", "staging.syncky.app"],
    ["http://relay-staging.syncky.app:8790", "staging.syncky.app"],
    ["https://relay-dev.syncky.app.example", "syncky.app"],
    ["https://relay-staging.syncky.app.", "syncky.app"],
    ["https://dev.example", "syncky.app"],
    ["http://localhost:8790", "syncky.app"],
    ["http://127.0.0.1:8790", "syncky.app"],
    ["http://[::1]:8790", "syncky.app"],
  ]) it(relay_base, () => {
    for (const url_scheme of [undefined, null]) for (const pair_secret of [undefined, "AAECAwQFBgcICQoLDA0ODw"]) {
      const value = { ...input, relay_base, pair_secret, url_scheme };
      const uri = buildPairUri(value), url = new URL(uri);
      assert.equal(url.origin, `https://${site}`); assert.equal(url.pathname, "/pair"); assert.equal(url.search, "");
      const params = new URLSearchParams(url.hash.slice(1));
      assert.deepEqual([...params.keys()], ["v", "r", "h", "t", "k", "n", ...(pair_secret ? ["c"] : []), ...(relay_base.startsWith("http://") ? ["s"] : [])]);
      assert.equal(params.get("r"), relay_base.replace(/^https?:\/\//, ""));
      assert.equal(params.get("t"), input.pairing_token); assert.equal(params.get("c"), pair_secret ?? null);
      assert.equal(params.get("v"), pair_secret ? "2" : "1");
      const legacy = buildPairUri({ ...value, url_scheme: "syncky" });
      assert.ok(legacy === `syncky://pair?${url.hash.slice(1)}`, "explicit scheme changed the payload");
    }
  });
});
