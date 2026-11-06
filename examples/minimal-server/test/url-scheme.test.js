import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { buildLink } from "../server.mjs";
import { run, tempDir } from "./helpers.js";

const SCHEMES = ["syncky", "syncky-dev", "syncky-staging"];
const ERROR = "url_scheme must be syncky, syncky-dev or syncky-staging";
const destination = { name: "Minimal server", url: "http://box.local:3000/syncky", format: "native", auth: { kind: "none" }, signing: false, types: null };
const query = "webhook?v=1&name=Minimal%20server&url=http%3A%2F%2Fbox.local%3A3000%2Fsyncky&format=native&auth=none";
const args = (dir) => ["link", "--data", dir, "--auth", "none", "--host", "box.local"];
const config = (dir, value) => writeFileSync(join(dir, "config.json"), JSON.stringify(value));

function output(result, scheme) {
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout === `${scheme}://${query}\n`, "CLI link differs from the canonical bytes");
  assert.match(result.stderr, /QR/);
}

function refused(result, message = ERROR) {
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.split("\n")[0], message);
  assert.match(result.stderr, /usage: server\.mjs/);
  assert.doesNotMatch(result.stderr, /do-not-print|https?:\/\/|srv_|whsec_/);
}

describe("URL scheme builder", () => {
  it("keeps the production bytes by default", () => {
    assert.equal(buildLink(destination), `syncky://${query}`);
  });

  for (const scheme of SCHEMES) {
    it(`builds ${scheme} explicitly`, () => {
      assert.equal(buildLink(destination, {}, scheme), `${scheme}://${query}`);
    });
  }

  it("rejects every unsupported shape with a fixed error", () => {
    for (const value of [null, "", "auto", "SYNCKY", "syncky://", " syncky", "syncky ", "syncky-dev-extra", "syncky-staging.evil", "https://do-not-print.invalid/?token=do-not-print", 0, false, [], {}]) {
      assert.throws(() => buildLink(destination, {}, value), { message: ERROR });
    }
  });

  it("does not infer an environment from the receiver hostname", () => {
    for (const host of ["relay-dev.syncky.app", "relay-staging.syncky.app", "relay.syncky.app", "localhost", "custom.invalid"]) {
      const d = { ...destination, url: `http://${host}:3000/syncky` };
      assert.equal(new URL(buildLink(d)).protocol, "syncky:");
      for (const scheme of SCHEMES) assert.equal(new URL(buildLink(d, {}, scheme)).protocol, `${scheme}:`);
    }
  });
});

describe("link URL scheme selection", () => {
  for (const scheme of SCHEMES) {
    it(`prints ${scheme} from flag, environment and config`, (t) => {
      const dir = tempDir(t);
      config(dir, { url_scheme: scheme });
      output(run(args(dir)), scheme);
      output(run(args(dir), { env: { SYNCKY_URL_SCHEME: scheme } }), scheme);
      output(run([...args(dir), "--url-scheme", scheme]), scheme);
    });
  }

  it("selects flag before environment before config before production", (t) => {
    const dir = tempDir(t);
    output(run(args(dir)), "syncky");
    output(run([...args(dir), "--url-scheme", "syncky-dev"]), "syncky-dev");
    output(run(args(dir), { env: { SYNCKY_URL_SCHEME: "syncky-staging" } }), "syncky-staging");
    output(run(args(dir), { env: { SYNCKY_URL_SCHEME: "" } }), "syncky");
    assert.equal(existsSync(join(dir, "config.json")), false);
    config(dir, { url_scheme: "syncky-staging" });
    output(run(args(dir)), "syncky-staging");
    const env = { SYNCKY_URL_SCHEME: "syncky-dev" };
    output(run(args(dir), { env }), "syncky-dev");
    output(run([...args(dir), "--url-scheme", "syncky"], { env }), "syncky");
    output(run(args(dir), { env: { SYNCKY_URL_SCHEME: "" } }), "syncky-staging");
  });

  it("treats absent and null config settings as unset", (t) => {
    const dir = tempDir(t);
    for (const value of [{}, { url_scheme: null }]) {
      config(dir, value);
      output(run(args(dir)), "syncky");
    }
  });

  it("uses production for every receiver host without an override", (t) => {
    const dir = tempDir(t);
    for (const host of ["relay-dev.syncky.app", "relay-staging.syncky.app", "relay.syncky.app", "localhost", "custom.invalid"]) {
      const result = run(["link", "--data", dir, "--auth", "none", "--host", host]);
      assert.equal(result.status, 0, result.stderr);
      const link = new URL(result.stdout.trim());
      assert.equal(link.protocol, "syncky:");
      assert.equal(link.searchParams.get("url"), `http://${host}:3000/syncky`);
    }
  });

  it("rejects invalid flag and environment values without echoing inputs", (t) => {
    const dir = tempDir(t);
    const env = { SYNCKY_SERVER_TOKEN: "srv_do-not-print", SYNCKY_SERVER_HMAC: "whsec_mgHtkTuuLB_wsJa221vi031K8GmN9QbtPNq_RV8uD8c" };
    for (const value of ["", "auto", "SYNCKY", "syncky://", " syncky", "syncky ", "syncky-dev-extra", "syncky-staging.evil", "https://do-not-print.invalid/?token=do-not-print", "--do-not-print"]) {
      refused(run([...args(dir), "--url-scheme", value], { env }));
      if (value !== "") refused(run(args(dir), { env: { ...env, SYNCKY_URL_SCHEME: value } }));
    }
    refused(run([...args(dir), "--url-scheme"], { env }));
  });

  it("rejects invalid config settings without echoing inputs", (t) => {
    const dir = tempDir(t);
    for (const value of ["", "auto", "SYNCKY", "syncky://", "syncky-dev-extra", "https://do-not-print.invalid/?token=do-not-print", 1, false, [], {}]) {
      config(dir, { url_scheme: value });
      refused(run(args(dir)));
    }
  });

  it("rejects malformed config and non-object JSON with a fixed error", (t) => {
    const dir = tempDir(t);
    for (const text of ['{"url_scheme":"https://do-not-print.invalid/?token=do-not-print"', "null", "[]", '"do-not-print"', "false", "1"]) {
      writeFileSync(join(dir, "config.json"), text);
      refused(run(args(dir)), "config.json must contain a JSON object");
    }
  });

  it("reads environment and config only for link and rejects the flag on other commands", (t) => {
    const dir = tempDir(t);
    writeFileSync(join(dir, "config.json"), "do-not-print");
    const env = { SYNCKY_URL_SCHEME: "do-not-print" };
    for (const command of ["init", "status"]) assert.equal(run([command, "--data", dir], { env }).status, 0);
    for (const command of ["init", "serve", "status", "write", "delete"]) {
      refused(run([command, "--data", dir, "--url-scheme", "syncky-dev"], { env }), "--url-scheme is only valid for link");
    }
  });

  it("documents the override, precedence and an explicit Dev example in usage", () => {
    const result = run([]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--url-scheme syncky\|syncky-dev\|syncky-staging/);
    assert.match(result.stderr, /--url-scheme > SYNCKY_URL_SCHEME > .*config\.json.*url_scheme.* > syncky/);
    assert.match(result.stderr, /link --url-scheme syncky-dev/);
  });
});
