import { it } from "node:test";
import assert from "node:assert/strict";

import { isUrlScheme, pairingSite } from "../../src/url-scheme.js";

it("accepts bare schemes using the same label grammar as pairing sites", () => {
  assert.equal(isUrlScheme("syncky"), true);
  for (const label of ["alpha", "beta", "a0", "alpha-2", "alpha-beta-3", "a".repeat(40)]) {
    assert.equal(isUrlScheme(`syncky-${label}`), true);
    assert.equal(pairingSite(`relay-${label}.syncky.app`), `${label}.syncky.app`);
  }
  for (const label of ["", "2alpha", "Alpha", "alpha-", "alpha--beta", "alpha.beta", "alpha_beta"]) {
    assert.equal(isUrlScheme(`syncky-${label}`), false);
    assert.equal(pairingSite(`relay-${label}.syncky.app.example`), "syncky.app");
  }
  for (const value of [null, undefined, 1, true, {}, [], "", "auto", "Syncky", "syncky://", "syncky-alpha ", "syncky-beta--extra"]) {
    assert.equal(isUrlScheme(value), false);
  }
});

it("binds labelled schemes within syncky.app and accepts other relay hosts", () => {
  assert.equal(isUrlScheme("syncky-alpha"), true);
  assert.equal(isUrlScheme("syncky-alpha", "relay-alpha.syncky.app"), true);
  assert.equal(isUrlScheme("syncky-alpha", "RELAY-ALPHA.SYNCKY.APP"), true);
  for (const host of ["syncky.app", "relay.syncky.app", "relay-beta.syncky.app", "nested.relay-alpha.syncky.app", "relay-alpha.syncky.app."]) {
    assert.equal(isUrlScheme("syncky-alpha", host), false);
    assert.equal(isUrlScheme("syncky", host), true);
  }
  for (const host of ["127.0.0.1", "localhost", "[::1]", "relay.example.test", "relay-alpha.syncky.app.evil.example"]) {
    assert.equal(isUrlScheme("syncky-alpha", host), true);
    assert.equal(isUrlScheme("syncky", host), true);
  }
});
