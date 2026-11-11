import { createThinTransport } from "./thin-transport.js";
import { isDeepStrictEqual } from "node:util";

import { createAuthSenderContext, deriveKeyPair, hpkeOpenAuth, publicKeyOf } from "./crypto.js";
import { b64uDecode, b64uEncode, toHex, utf8 } from "./encoding.js";
import { fingerprint } from "./fingerprint.js";
import { pairCode, pairProof } from "./pair-code.js";
import { buildPairUri, parsePairUri } from "./pair-uri.js";
import { loadJson, loadVectors } from "./protocol-files.js";

const hex = (s) => new Uint8Array(Buffer.from(s, "hex"));
const key32 = (s) => b64uDecode(s, { length: 32 });
const transport = () => createThinTransport({ table: loadJson("messages.json") });

function expectEqual(actual, expected, what) {
  if (!isDeepStrictEqual(actual, expected)) throw new Error(`${what} differs`);
}

function rfc9180Cases(v) {
  const encryptions = v.encryptions.slice(0, 3);
  return [
    {
      name: "seal reproduces enc and ct",
      fn: async () => {
        const ctx = await createAuthSenderContext({
          recipientPublicKey: hex(v.pkRm),
          senderPrivateKey: hex(v.skSm),
          info: hex(v.info),
          ekm: hex(v.ikmE),
        });
        expectEqual(toHex(ctx.enc), v.enc, "enc");
        for (const e of encryptions) expectEqual(toHex(await ctx.seal(hex(e.pt), hex(e.aad))), e.ct, "ct");
      },
    },
    {
      name: "open reproduces pt",
      fn: async () => {
        const pt = await hpkeOpenAuth({
          enc: hex(v.enc),
          recipientPrivateKey: hex(v.skRm),
          senderPublicKey: hex(v.pkSm),
          info: hex(v.info),
          aad: hex(encryptions[0].aad),
          ciphertext: hex(encryptions[0].ct),
        });
        expectEqual(toHex(pt), encryptions[0].pt, "pt");
      },
    },
    {
      name: "key derivation",
      fn: async () => {
        expectEqual(toHex((await deriveKeyPair(hex(v.ikmE))).privateKey), v.skEm, "skEm");
        expectEqual(toHex(publicKeyOf(hex(v.skSm))), v.pkSm, "pkSm");
        expectEqual(toHex(publicKeyOf(hex(v.skRm))), v.pkRm, "pkRm");
      },
    },
  ];
}

function keysCases(keys) {
  return Object.entries(keys).map(([name, k]) => ({
    name,
    fn: () => expectEqual(b64uEncode(publicKeyOf(key32(k.sk))), k.pk, "pk"),
  }));
}

function envelopeCases({ cases }, keys) {
  const memberKey = Object.fromEntries(Object.values(keys).map((k) => [k.member_id, key32(k.pk)]));
  const senderKeyOf = (id) => memberKey[id] ?? null;
  return cases.map((c) => ({
    name: c.name,
    fn: async () => {
      for (const r of c.recipients) {
        const { innerText } = await transport().receive({
          envelope: c.envelope,
          hubId: c.hub_id,
          self: { memberId: r.member_id, privateKey: key32(keys[r.key].sk) },
          senderKeyOf,
        });
        expectEqual(innerText, c.plaintext, "plaintext");
      }
      const draws = { 32: b64uDecode(c.cek, { length: 32 }), 12: b64uDecode(c.nonce, { length: 12 }) };
      const ikm = Object.fromEntries(c.recipients.map((r) => [r.member_id, key32(r.ikm_e)]));
      const sender = keys[c.sender];
      const resealed = await transport().seal({
        hubId: c.hub_id,
        from: sender.member_id,
        recipients: c.recipients.map((r) => ({ memberId: r.member_id, publicKey: memberKey[r.member_id] })),
        senderPrivateKey: key32(sender.sk),
        plaintext: utf8(c.plaintext),
        kind: c.envelope.kind,
        diagnostics: c.envelope.diagnostics,
        access: c.envelope.access,
        msgId: c.envelope.msg_id,
        createdAt: c.envelope.created_at,
        random: (n) => new Uint8Array(draws[n]),
        ekmFor: (id) => ikm[id],
      });
      expectEqual(transport().serialize(resealed), JSON.stringify(c.envelope), "resealed envelope");
    },
  }));
}

function negativeCases({ cases }, keys) {
  return cases.map((c) => ({
    name: c.name,
    fn: async () => {
      const receiver = keys[c.receiver];
      const senderKeyOf = (id) => (Object.hasOwn(c.registry, id) ? key32(c.registry[id]) : null);
      let code = "opened";
      try {
        await createThinTransport({ table: loadJson("messages.json") }).receive({ envelope: c.envelope, hubId: c.hub_id,
          self: { memberId: receiver.member_id, privateKey: key32(receiver.sk) }, senderKeyOf });
      } catch (err) {
        code = err.code;
      }
      expectEqual(code, c.expect, "error code");
    },
  }));
}

function shapeCases({ cases }) {
  return cases.map((c) => ({
    name: c.name,
    fn: () => {
      const opts = { caller: c.caller, activeMembers: c.members };
      const result = c.raw === undefined ? transport().validateShape(c.envelope, opts) : transport().validateText(c.raw, opts);
      expectEqual(result, c.expect, "result");
    },
  }));
}


function fingerprintCases({ cases }) {
  return cases.map((c) => ({
    name: c.name,
    fn: () => {
      const fp = fingerprint(c.agent_pub, c.device_pub);
      expectEqual([fp.sha256Hex, fp.text], [c.sha256_hex, c.fingerprint], "fingerprint");
    },
  }));
}

const pairValue = (v) => ({
  relayBase: v.relay_base,
  hubId: v.hub_id,
  pairingToken: v.pairing_token,
  agentPublicKey: v.agent_public_key,
  agentName: v.agent_name,
  ...(v.pair_secret !== undefined && { pairSecret: v.pair_secret }),
  ...(v.requested_scope !== undefined && { requestedScope: v.requested_scope }),
});

function pairUriCases({ cases }) {
  return cases.map((c) => ({
    name: c.name,
    fn: () => {
      if (c.input) {
        const value = pairValue(c.input);
        expectEqual(buildPairUri({ ...value, urlScheme: c.input.url_scheme }), c.uri, "uri");
        const expected = { ...value, ...(value.requestedScope && { requestedScope: { ...value.requestedScope,
          read: [...new Set(value.requestedScope.read)].sort(), write: [...new Set(value.requestedScope.write)].sort() } }) };
        expectEqual(parsePairUri(c.uri, { allowInsecureRelay: true }), { ok: true, value: expected }, "built parse result");
        return;
      }
      const result = parsePairUri(c.uri, { allowInsecureRelay: c.allow_insecure });
      const expected = c.expect.ok ? { ok: true, value: pairValue(c.expect) } : { ok: false, code: c.expect.error };
      if (!c.expect.ok && c.expect.param !== undefined) expected.param = c.expect.param;
      expectEqual(result, expected, "parse result");
    },
  }));
}

function pairCodeCases({ cases }) {
  return cases.map((c) => ({
    name: c.name,
    fn: () => {
      expectEqual(pairCode(c.pair_secret), c.code, "code");
      expectEqual(pairProof(c.pair_secret, c.agent_public_key, c.device_public_key), c.proof, "proof");
    },
  }));
}

const BUILDERS = {
  "rfc9180-auth-x25519-sha256-chacha20poly1305.json": rfc9180Cases,
  "keys.json": keysCases,
  "envelopes.json": envelopeCases,
  "envelopes-negative.json": negativeCases,
  "envelope-shape.json": shapeCases,
  "fingerprints.json": fingerprintCases,
  "pair-uris.json": pairUriCases,
  "pair-codes.json": pairCodeCases,
};

export const SELFTEST_FILES = Object.freeze(Object.keys(BUILDERS));

export async function runSelftest({ dir } = {}) {
  const load = (file) => loadVectors(file, dir);
  const results = [];
  for (const file of SELFTEST_FILES) {
    const result = { file, ok: true, cases: 0, failures: [] };
    let cases;
    try {
      cases = BUILDERS[file](load(file), file === "keys.json" ? undefined : load("keys.json"), dir);
    } catch (err) {
      cases = [{ name: "load", fn: () => { throw err; } }];
    }
    for (const c of cases) {
      result.cases += 1;
      try {
        await c.fn();
      } catch (err) {
        result.ok = false;
        result.failures.push({ case: c.name, error: err?.message ?? String(err) });
      }
    }
    results.push(result);
  }
  return { ok: results.every((r) => r.ok), files: results };
}
