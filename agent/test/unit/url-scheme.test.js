import { it } from "node:test";
import assert from "node:assert/strict";

import { inferUrlScheme, isUrlScheme, URL_SCHEMES } from "../../src/url-scheme.js";

it("accepts exactly the three bare URL schemes", () => {
  assert.deepEqual(URL_SCHEMES, ["syncky", "syncky-dev", "syncky-staging"]);
  for (const scheme of URL_SCHEMES) assert.equal(isUrlScheme(scheme), true);
  for (const value of [null, undefined, 1, true, {}, [], "", "auto", "Syncky", "syncky://", "syncky-dev ", "syncky-staging-extra"]) {
    assert.equal(isUrlScheme(value), false);
  }
});

it("maps only exact URL-normalized relay hostnames, independently of port and path", () => {
  for (const [relay, expected] of [
    ["https://relay-dev.syncky.app", "syncky-dev"],
    ["https://RELAY-DEV.SYNCKY.APP:8443/", "syncky-dev"],
    ["https://relay-staging.syncky.app:443", "syncky-staging"],
    ["http://relay-staging.syncky.app:8790", "syncky-staging"],
    ["https://relay.syncky.app", "syncky"],
    ["http://localhost:8793", "syncky"],
    ["http://127.0.0.1:8793", "syncky"],
    ["http://[::1]:8793", "syncky"],
    ["https://relay-dev.syncky.app.example", "syncky"],
    ["https://example/relay-staging.syncky.app", "syncky"],
    ["https://dev.example", "syncky"],
  ]) assert.equal(inferUrlScheme(relay), expected);
});
