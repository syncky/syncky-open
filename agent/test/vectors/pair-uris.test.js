import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildPairUri, parsePairUri } from "../../src/pair-uri.js";
import { loadVectors } from "../../src/protocol-files.js";
import { accessEnvelopeSizes, normalizeScopeNames } from '../../src/access-scope.js';

const { cases } = loadVectors("pair-uris");
const parseCases = cases.filter((c) => c.expect);
const buildCases = cases.filter((c) => c.input);

const fromVector = (v) => ({
  relayBase: v.relay_base,
  hubId: v.hub_id,
  pairingToken: v.pairing_token,
  agentPublicKey: v.agent_public_key,
  agentName: v.agent_name,
  ...(v.pair_secret !== undefined && { pairSecret: v.pair_secret }),
  ...(v.requested_scope !== undefined && { requestedScope: { ...v.requested_scope,
    read: normalizeScopeNames(v.requested_scope.read), write: normalizeScopeNames(v.requested_scope.write) } }),
});

describe("pair-uris.json parse cases", () => {
  it("has parse and build cases for every error code", () => {
    assert.ok(buildCases.length > 0);
    const codes = new Set(parseCases.filter((c) => !c.expect.ok).map((c) => c.expect.error));
    assert.deepEqual([...codes].sort(), ["insecure_relay", "invalid_uri", "unsupported_version"]);
  });

  for (const c of parseCases) {
    it(c.name, () => {
      const result = parsePairUri(c.uri, { allowInsecureRelay: c.allow_insecure });
      if (c.envelope_bytes) {
        const url = new URL(c.uri), fields = new URLSearchParams(url.hash.slice(1) || url.search.slice(1));
        assert.deepEqual(accessEnvelopeSizes({ request_ref: fields.get('request_ref'), read: JSON.parse(fields.get('read')),
          write: JSON.parse(fields.get('write')) }), c.envelope_bytes);
      }
      if (c.expect.ok) {
        assert.deepEqual(result, { ok: true, value: fromVector(c.expect) });
        const rebuilt = buildPairUri({ ...result.value, urlScheme: c.uri.startsWith("https://") ? null : c.uri.split(":")[0] });
        assert.deepEqual(parsePairUri(rebuilt, { allowInsecureRelay: true }), result);
      } else {
        const expected = { ok: false, code: c.expect.error };
        if (c.expect.param !== undefined) expected.param = c.expect.param;
        assert.deepEqual(result, expected);
      }
    });
  }
});

describe("pair-uris.json version 2", () => {
  it("has version 2 parse and build cases, and only version 2 carries pair_secret", () => {
    assert.ok(parseCases.filter((c) => c.expect.pair_secret !== undefined).length >= 2);
    const v2Builds = buildCases.filter((c) => c.input.pair_secret !== undefined);
    assert.ok(v2Builds.length >= 2);
    for (const c of buildCases) {
      const [scheme, rest] = c.uri.split("://");
      assert.equal(scheme, c.input.url_scheme ?? "https", c.name);
      assert.equal(/[?#]v=2&/.test(rest), c.input.pair_secret !== undefined, c.name);
    }
    for (const c of parseCases.filter((x) => x.expect.ok)) assert.equal(c.expect.pair_secret !== undefined, /[?#&]v=2(&|$)/.test(c.uri), c.name);
  });
});

describe("pair-uris.json build cases", () => {
  for (const c of buildCases) {
    it(c.name, () => {
      const input = fromVector(c.input);
      assert.equal(buildPairUri({ ...input, urlScheme: c.input.url_scheme }), c.uri);
      assert.deepEqual(parsePairUri(c.uri, { allowInsecureRelay: true }), { ok: true, value: input });
    });
  }
});
