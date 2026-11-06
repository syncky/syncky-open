import { readFileSync } from "node:fs";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

if (!process.env.SYNCKY_AGENT_BUNDLE_FIXTURE) throw new Error("bundle fixture is required");
const fixture = JSON.parse(readFileSync(process.env.SYNCKY_AGENT_BUNDLE_FIXTURE, "utf8"));
register("./bundle-loader.js", import.meta.url, {
  data: {
    bundleUrl: pathToFileURL(fixture.release.bundlePath).href,
    sourceUrl: new URL("../../src/", import.meta.url).href,
    exports: fixture.exports,
  },
});
