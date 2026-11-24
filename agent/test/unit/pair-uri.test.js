import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { fingerprint } from "../../src/fingerprint.js";
import { buildPairUri, issuedHttpsPairUri, parseIssuedPairUri, parsePairUri } from "../../src/pair-uri.js";
import { loadVectors } from "../../src/protocol-files.js";

const keys = loadVectors("keys");
const info = {
  relayBase: "https://relay.syncky.app",
  hubId: "hub_AAAAAAAAAAAAAAAAAAAAAA",
  pairingToken: "pt_3gPoOIYU79WNUntyiFCMAh9dM8jn9EGrq6qbPfZCB54",
  agentPublicKey: keys.agent.pk,
  agentName: "Kitchen Mac",
};

it("normalizes requested scope without changing unscoped bytes in either version or envelope", () => {
  for (const pairSecret of [undefined, "AAECAwQFBgcICQoLDA0ODw"]) for (const urlScheme of [null, "syncky-alpha"]) {
    const base = { ...info, relayBase: "https://relay-alpha.syncky.app", pairSecret, urlScheme }, plain = buildPairUri(base);
    const requestedScope = { request_ref: "a".repeat(32), read: ["steps", "body_mass", "steps"], write: [] };
    const uri = buildPairUri({ ...base, requestedScope });
    assert.ok(uri.startsWith(plain + "&request_ref="));
    assert.ok(uri.endsWith("&read=%5B%22body_mass%22%2C%22steps%22%5D&write=%5B%5D"));
    assert.deepEqual(parsePairUri(uri).value.requestedScope, { ...requestedScope, read: ["body_mass", "steps"] });
    assert.equal(buildPairUri(base), plain);
    assert.equal(new URL(uri).search, "");
  }
});

describe("buildPairUri", () => {
  it("infers HTTPS by exact relay hostname, retaining ports, payload and explicit fallbacks", () => {
    for (const [relayBase, site] of [
      ["https://relay.syncky.app", "syncky.app"],
      ["https://relay-alpha.syncky.app:9443", "alpha.syncky.app"],
      [`https://RELAY-ALPHA.SYNCKY.APP:443`, "alpha.syncky.app"],
      ["http://relay-beta.syncky.app:8790", "beta.syncky.app"],
      ["https://relay-beta.syncky.app", "beta.syncky.app"],
      ["https://relay-alpha.syncky.app.example", "syncky.app"],
      ["https://relay-beta.syncky.app.", "syncky.app"],
      ["https://dev.example", "syncky.app"],
      ["http://localhost:8790", "syncky.app"],
      ["http://127.0.0.1:8790", "syncky.app"],
      ["http://[::1]:8790", "syncky.app"],
    ]) for (const pairSecret of [undefined, "AAECAwQFBgcICQoLDA0ODw"]) {
      const value = { ...info, relayBase, ...(pairSecret && { pairSecret }) };
      for (const urlScheme of [undefined, null]) {
        const uri = buildPairUri({ ...value, urlScheme }), url = new URL(uri);
        assert.equal(url.origin, `https://${site}`); assert.equal(url.pathname, "/pair"); assert.equal(url.search, "");
        assert.deepEqual(parsePairUri(uri, { allowInsecureRelay: true }), { ok: true, value });
      }
      assert.ok(buildPairUri({ ...value, urlScheme: "syncky" }).startsWith("https://syncky.app/pair#"));
    }
  });
  it("builds an explicit scheme as its HTTPS site and parses v1/v2 without adding the scheme", () => {
    for (const urlScheme of ["syncky", "syncky-alpha", "syncky-beta"]) {
      for (const pairSecret of [undefined, "AAECAwQFBgcICQoLDA0ODw"]) {
        const value = { ...info, relayBase: urlScheme === "syncky" ? info.relayBase : `https://relay-${urlScheme.slice(7)}.syncky.app`, ...(pairSecret !== undefined && { pairSecret }) };
        const uri = buildPairUri({ ...value, urlScheme });
        assert.ok(uri.startsWith(`https://${urlScheme === "syncky" ? "" : `${urlScheme.slice(7)}.`}syncky.app/pair#v=${pairSecret ? 2 : 1}&`));
        assert.deepEqual(parsePairUri(uri), { ok: true, value });
      }
    }
    for (const urlScheme of ["", "auto", "Syncky", "syncky://", "syncky-alpha--extra", true, 42]) {
      assert.throws(() => buildPairUri({ ...info, urlScheme }), TypeError);
    }
  });
  it("orders parameters v,r,h,t,k,n and appends s=http only for http relays", () => {
    const secure = buildPairUri(info);
    assert.deepEqual([...new URLSearchParams(new URL(secure).hash.slice(1)).keys()], ["v", "r", "h", "t", "k", "n"]);
    const insecure = buildPairUri({ ...info, relayBase: "http://127.0.0.1:8787" });
    assert.ok(insecure.endsWith("&s=http"));
    assert.ok(insecure.includes("&r=127.0.0.1%3A8787&"));
    assert.equal(parsePairUri(insecure).code, "insecure_relay");
    assert.equal(parsePairUri(insecure, { allowInsecureRelay: true }).value.relayBase, "http://127.0.0.1:8787");
  });

  it("writes v=2 with c after n and before s only when given a secret", () => {
    const pairSecret = "AAECAwQFBgcICQoLDA0ODw";
    const v2 = buildPairUri({ ...info, pairSecret, relayBase: "http://127.0.0.1:8787" });
    assert.ok(v2.startsWith("https://syncky.app/pair#v=2&"));
    assert.deepEqual([...new URLSearchParams(new URL(v2).hash.slice(1)).keys()], ["v", "r", "h", "t", "k", "n", "c", "s"]);
    assert.deepEqual(parsePairUri(v2, { allowInsecureRelay: true }).value, { ...info, relayBase: "http://127.0.0.1:8787", pairSecret });
    for (const none of [undefined, null]) assert.ok(buildPairUri({ ...info, pairSecret: none }).startsWith("https://syncky.app/pair#v=1&"));
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
    for (const scheme of ["Syncky", "syncky-alpha--extra", "syncky-beta--extra", "syncky-2alpha", "http"]) {
      assert.deepEqual(parsePairUri(`${scheme}://pair?v=2`), { ok: false, code: "invalid_uri", param: "scheme" });
    }
    for (const scheme of ["syncky", "syncky-alpha", "syncky-beta", "syncky-alpha-2"]) {
      assert.deepEqual(parsePairUri(`${scheme}://webhook#x`), { ok: false, code: "invalid_uri", param: "host" });
      assert.deepEqual(parsePairUri(`${scheme}://pair#x`), { ok: false, code: "invalid_uri", param: "fragment" });
      assert.deepEqual(parsePairUri(`${scheme}://pair`), { ok: false, code: "invalid_uri", param: "v" });
    }
  });
  it("rejects a non-string input as a scheme error", () => {
    assert.deepEqual(parsePairUri(undefined), { ok: false, code: "invalid_uri", param: "scheme" });
  });

  it("binds labelled HTTPS sites to the matching relay host", () => {
    for (const label of ["alpha", "beta", "alpha-2"]) {
      const value = { ...info, relayBase: `https://relay-${label}.syncky.app:9443` };
      const uri = buildPairUri(value);
      assert.deepEqual(parsePairUri(uri), { ok: true, value });
      assert.deepEqual(parsePairUri(uri.replace(`https://${label}.syncky.app`, "https://other.syncky.app")), { ok: false, code: "invalid_uri", param: "host" });
      assert.deepEqual(parsePairUri(uri.replace(`relay-${label}.syncky.app`, "relay.example.test")), { ok: false, code: "invalid_uri", param: "host" });
      assert.deepEqual(parsePairUri(uri.replace(`https://${label}.syncky.app`, "https://syncky.app")), { ok: true, value });
    }
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

it('derives a labelled pairing site only from its matching relay host', () => {
  const value = { ...info, relayBase: 'https://relay-lab.syncky.app:9443' };
  const uri = buildPairUri(value);
  assert.ok(uri.startsWith('https://lab.syncky.app/pair#'));
  assert.deepEqual(parsePairUri(uri), { ok: true, value });
  for (const host of ['lab.syncky.app.evil.example', 'www.syncky.app', 'other.syncky.app', 'lab.syncky.app:443']) assert.deepEqual(parsePairUri(uri.replace('lab.syncky.app/pair', `${host}/pair`)), { ok: false, code: 'invalid_uri', param: 'host' });
});

const legacy = (uri, scheme = "syncky") => `${scheme}://pair?${uri.slice(uri.indexOf("#") + 1)}`;

it("refuses mismatched labelled schemes on syncky.app at build and parse", () => {
  for (const relayBase of ["https://syncky.app", "https://relay.syncky.app", "https://relay-beta.syncky.app", "https://nested.relay-alpha.syncky.app", "https://relay-alpha.syncky.app."]) {
    assert.throws(() => buildPairUri({ ...info, relayBase, urlScheme: "syncky-alpha" }), { code: "invalid_url_scheme", message: "unsupported URL scheme" });
    const uri = buildPairUri({ ...info, relayBase, urlScheme: "syncky" });
    assert.deepEqual(parsePairUri(legacy(uri, "syncky-alpha")), { ok: false, code: "invalid_uri", param: "scheme" });
    assert.deepEqual(parsePairUri(uri.replace("https://syncky.app/", "https://alpha.syncky.app/")), { ok: false, code: "invalid_uri", param: "host" });
  }
});

it("builds a labelled scheme as its site beside its own relay or a relay outside syncky.app", () => {
  for (const relayBase of ["https://relay-alpha.syncky.app:9443", "https://RELAY-ALPHA.SYNCKY.APP", "http://127.0.0.1:8787", "http://localhost:8787", "http://[::1]:8787", "https://relay.example.test", "https://relay-alpha.syncky.app.evil.example"]) {
    const own = /relay-alpha\.syncky\.app(?::\d+)?$/i.test(relayBase);
    for (const pairSecret of [undefined, "AAECAwQFBgcICQoLDA0ODw"]) {
      const value = { ...info, relayBase, ...(pairSecret && { pairSecret }) };
      const uri = buildPairUri({ ...value, urlScheme: "syncky-alpha" });
      assert.equal(uri, buildPairUri({ ...value, urlScheme: "syncky" }).replace("https://syncky.app/", "https://alpha.syncky.app/"));
      assert.deepEqual(parseIssuedPairUri(uri), { ok: true, value });
      assert.deepEqual(parsePairUri(uri, { allowInsecureRelay: true }), own ? { ok: true, value } : { ok: false, code: "invalid_uri", param: "host" });
      const canonical = buildPairUri({ ...value, urlScheme: "syncky" });
      assert.deepEqual(parsePairUri(legacy(canonical, "syncky-alpha"), { allowInsecureRelay: true }), { ok: true, value });
      if (relayBase.startsWith("http://")) assert.deepEqual(parsePairUri(legacy(canonical, "syncky-alpha")), { ok: false, code: "insecure_relay" });
    }
  }
});

it("refuses an issued link whose labelled site the builder would refuse for its relay", () => {
  for (const relayBase of ["https://relay.syncky.app", "https://relay-beta.syncky.app"]) {
    const uri = buildPairUri({ ...info, relayBase }).replace(/^https:\/\/(?:beta\.)?syncky\.app\//, "https://alpha.syncky.app/");
    assert.deepEqual(parseIssuedPairUri(uri), { ok: false, code: "invalid_uri", param: "host" });
  }
  assert.deepEqual(parseIssuedPairUri(buildPairUri({ ...info, relayBase: "https://relay-alpha.syncky.app", urlScheme: "syncky-alpha" })).ok, true);
});

it("keeps rejecting www.syncky.app beside a relay outside syncky.app", () => {
  for (const relayBase of ["https://relay.example.test", "http://127.0.0.1:8787"]) {
    const uri = buildPairUri({ ...info, relayBase }).replace("https://syncky.app/", "https://www.syncky.app/");
    assert.deepEqual(parsePairUri(uri, { allowInsecureRelay: true }), { ok: false, code: "invalid_uri", param: "host" });
  }
});

it("shows a stored custom-scheme link as the matching HTTPS link and leaves other links unchanged", () => {
  const https = buildPairUri({ ...info, relayBase: "http://127.0.0.1:8787", pairSecret: "AAECAwQFBgcICQoLDA0ODw" });
  const payload = https.slice(https.indexOf("#") + 1);
  assert.equal(issuedHttpsPairUri(`syncky://pair?${payload}`), https);
  assert.equal(issuedHttpsPairUri(`syncky-alpha://pair?${payload}`), `https://alpha.syncky.app/pair#${payload}`);
  assert.equal(issuedHttpsPairUri(https), https);
  assert.deepEqual(parseIssuedPairUri(issuedHttpsPairUri(`syncky-alpha://pair?${payload}`)), parsePairUri(`syncky-alpha://pair?${payload}`, { allowInsecureRelay: true }));
});
