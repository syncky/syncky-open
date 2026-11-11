import { it } from "node:test";
import assert from "node:assert/strict";

import { isUrlScheme, URL_SCHEMES } from "../../src/url-scheme.js";

it("accepts exactly the three bare URL schemes", () => {
  assert.deepEqual(URL_SCHEMES, ["syncky", "syncky-dev", "syncky-staging"]);
  for (const scheme of URL_SCHEMES) assert.equal(isUrlScheme(scheme), true);
  for (const value of [null, undefined, 1, true, {}, [], "", "auto", "Syncky", "syncky://", "syncky-dev ", "syncky-staging-extra"]) {
    assert.equal(isUrlScheme(value), false);
  }
});
