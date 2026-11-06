import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { fingerprint } from "../../src/fingerprint.js";
import { buildPairUri, parsePairUri } from "../../src/pair-uri.js";
import { loadVectors } from "../../src/protocol-files.js";

const keys = loadVectors("keys");
const info = {
  relayBase: "https://relay.syncky.app",
  hubId: "hub_AAAAAAAAAAAAAAAAAAAAAA",
  pairingToken: "pt_3gPoOIYU79WNUntyiFCMAh9dM8jn9EGrq6qbPfZCB54",
  agentPublicKey: keys.agent.pk,
  agentName: "Kitchen Mac",
};

describe("buildPairUri", () => {
  it("builds and parses v1/v2 in every scheme without adding scheme to the parsed result", () => {
    for (const urlScheme of ["syncky", "syncky-dev", "syncky-staging"]) {
      for (const pairSecret of [undefined, "AAECAwQFBgcICQoLDA0ODw"]) {
        const value = { ...info, ...(pairSecret !== undefined && { pairSecret }) };
        const uri = buildPairUri({ ...value, urlScheme });
        assert.ok(uri.startsWith(`${urlScheme}://pair?v=${pairSecret ? 2 : 1}&`));
        assert.deepEqual(parsePairUri(uri), { ok: true, value });
      }
    }
    assert.ok(buildPairUri({ ...info, relayBase: "https://relay-dev.syncky.app" }).startsWith("syncky://"));
    for (const urlScheme of [null, "", "auto", "Syncky", "syncky://", "syncky-dev-extra", true, 42]) {
      assert.throws(() => buildPairUri({ ...info, urlScheme }), TypeError);
    }
  });
  it("orders parameters v,r,h,t,k,n and appends s=http only for http relays", () => {
    const secure = buildPairUri(info);
    assert.deepEqual([...new URLSearchParams(secure.split("?")[1]).keys()], ["v", "r", "h", "t", "k", "n"]);
    const insecure = buildPairUri({ ...info, relayBase: "http://127.0.0.1:8787" });
    assert.ok(insecure.endsWith("&s=http"));
    assert.ok(insecure.includes("&r=127.0.0.1%3A8787&"));
    assert.equal(parsePairUri(insecure).code, "insecure_relay");
    assert.equal(parsePairUri(insecure, { allowInsecureRelay: true }).value.relayBase, "http://127.0.0.1:8787");
  });

  it("writes v=2 with c after n and before s only when given a secret", () => {
    const pairSecret = "AAECAwQFBgcICQoLDA0ODw";
    const v2 = buildPairUri({ ...info, pairSecret, relayBase: "http://127.0.0.1:8787" });
    assert.ok(v2.startsWith("syncky://pair?v=2&"));
    assert.deepEqual([...new URLSearchParams(v2.split("?")[1]).keys()], ["v", "r", "h", "t", "k", "n", "c", "s"]);
    assert.deepEqual(parsePairUri(v2, { allowInsecureRelay: true }).value, { ...info, relayBase: "http://127.0.0.1:8787", pairSecret });
    for (const none of [undefined, null]) assert.ok(buildPairUri({ ...info, pairSecret: none }).startsWith("syncky://pair?v=1&"));
    assert.equal(Object.hasOwn(parsePairUri(buildPairUri(info)).value, "pairSecret"), false);
  });

  for (const [name, overrides] of [
    ["15-byte pair secret", { pairSecret: "AAECAwQFBgcICQoLDA0O" }],
    ["padded pair secret", { pairSecret: "AAECAwQFBgcICQoLDA0ODw==" }],
    ["non-string pair secret", { pairSecret: 42 }],
    ["relay URL without a scheme", { relayBase: "relay.syncky.app" }],
    ["relay URL with another scheme", { relayBase: "ftp://relay.syncky.app" }],
    ["relay URL with a path", { relayBase: "https://relay.syncky.app/v1" }],
    ["relay URL with a trailing slash", { relayBase: "https://relay.syncky.app/" }],
    ["relay URL with userinfo", { relayBase: "https://u@relay.syncky.app" }],
    ["relay URL not a string", { relayBase: 42 }],
    ["malformed hub id", { hubId: "hub_short" }],
    ["malformed pairing token", { pairingToken: "pt_x" }],
    ["31-byte agent key", { agentPublicKey: "A".repeat(42) }],
    ["empty agent name", { agentName: "" }],
    ["agent name of 65 UTF-16 units", { agentName: "a".repeat(65) }],
    ["missing agent name", { agentName: undefined }],
  ]) {
    it(`throws for ${name}`, () => {
      assert.throws(() => buildPairUri({ ...info, ...overrides }), TypeError);
    });
  }

  it("throws for a lone surrogate in the agent name", () => {
    assert.throws(() => buildPairUri({ ...info, agentName: "a\ud800" }));
  });
});

describe("parsePairUri", () => {
  it("rejects unknown schemes and keeps host, fragment and version error order in supported schemes", () => {
    for (const scheme of ["Syncky", "syncky-dev-extra", "syncky-staging-extra", "syncky-prod", "https"]) {
      assert.deepEqual(parsePairUri(`${scheme}://pair?v=2`), { ok: false, code: "invalid_uri", param: "scheme" });
    }
    for (const scheme of ["syncky", "syncky-dev", "syncky-staging"]) {
      assert.deepEqual(parsePairUri(`${scheme}://webhook#x`), { ok: false, code: "invalid_uri", param: "host" });
      assert.deepEqual(parsePairUri(`${scheme}://pair#x`), { ok: false, code: "invalid_uri", param: "fragment" });
      assert.deepEqual(parsePairUri(`${scheme}://pair`), { ok: false, code: "invalid_uri", param: "v" });
    }
  });
  it("rejects a non-string input as a scheme error", () => {
    assert.deepEqual(parsePairUri(undefined), { ok: false, code: "invalid_uri", param: "scheme" });
  });

  it("treats a URI without a query as missing v", () => {
    assert.deepEqual(parsePairUri("syncky://pair"), { ok: false, code: "invalid_uri", param: "v" });
  });

  it("rejects a raw lone surrogate in a value as an encoding error", () => {
    const uri = buildPairUri(info).replace("n=Kitchen%20Mac", "n=Kitchen\udc00");
    assert.deepEqual(parsePairUri(uri), { ok: false, code: "invalid_uri", param: "encoding" });
  });

  it("keeps a leading byte order mark in a decoded value", () => {
    const uri = buildPairUri({ ...info, agentName: "﻿Mac" });
    assert.equal(parsePairUri(uri).value.agentName, "﻿Mac");
  });
});

describe("fingerprint", () => {
  it("rejects keys that are not 32-byte base64url", () => {
    assert.throws(() => fingerprint(keys.agent.pk, keys.dev1.pk.slice(1)));
    assert.throws(() => fingerprint(keys.agent.pk + "=", keys.dev1.pk));
  });
});
