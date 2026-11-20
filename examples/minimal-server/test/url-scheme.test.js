import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { buildLink } from "../server.mjs";
import { run, tempDir } from "./helpers.js";

const ERROR = "unsupported URL scheme";
const destination = { name: "Minimal server", url: "http://box.local:3000/syncky", format: "native", auth: { kind: "none" }, signing: false, types: null };
const expectedLink = "https://syncky.app/connect#v=1&name=Minimal%20server&url=http%3A%2F%2Fbox.local%3A3000%2Fsyncky&format=native&auth=none";
const args = (dir) => ["link", "--data", dir, "--auth", "none", "--host", "box.local"];
const config = (dir, value) => writeFileSync(join(dir, "config.json"), JSON.stringify(value));

function output(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout === expectedLink + "\n", "CLI link differs from the canonical bytes");
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
    assert.equal(buildLink(destination), expectedLink);
  });

  it("accepts the explicit syncky label", () => {
    assert.equal(buildLink(destination, {}, "syncky"), expectedLink);
  });

  it("rejects every unsupported shape with a fixed error", () => {
    for (const value of [null, "", "auto", "SYNCKY", "syncky://", " syncky", "syncky ", "syncky-alpha", "syncky-lab", "syncky-preview", "syncky-lab-extra", "syncky-preview.evil", "https://do-not-print.invalid/?token=do-not-print", 0, false, [], {}]) {
      assert.throws(() => buildLink(destination, {}, value), { message: ERROR });
    }
  });

  it("uses the production site for every receiver hostname", () => {
    for (const host of ["relay-alpha.syncky.app", "relay-beta.syncky.app", "relay.syncky.app", "localhost", "custom.invalid"]) {
      const d = { ...destination, url: `http://${host}:3000/syncky` };
      assert.equal(new URL(buildLink(d)).origin, "https://syncky.app");
      assert.equal(new URL(buildLink(d, {}, "syncky")).origin, "https://syncky.app");
    }
  });
});

describe("link URL scheme selection", () => {
  it("accepts syncky from config, environment and flag", (t) => {
    const dir = tempDir(t);
    config(dir, { url_scheme: "syncky" });
    output(run(args(dir)));
    output(run(args(dir), { env: { SYNCKY_URL_SCHEME: "syncky" } }));
    output(run([...args(dir), "--url-scheme", "syncky"]));
  });

  it("selects flag before environment before config before production", (t) => {
    const dir = tempDir(t);
    output(run(args(dir)));
    refused(run(args(dir), { env: { SYNCKY_URL_SCHEME: "syncky-alpha" } }));
    assert.equal(existsSync(join(dir, "config.json")), false);
    config(dir, { url_scheme: "syncky-alpha" });
    refused(run(args(dir)));
    output(run(args(dir), { env: { SYNCKY_URL_SCHEME: "syncky" } }));
    refused(run(args(dir), { env: { SYNCKY_URL_SCHEME: "" } }));
    output(run([...args(dir), "--url-scheme", "syncky"], { env: { SYNCKY_URL_SCHEME: "syncky-other" } }));
  });

  it("treats absent and null config settings as unset", (t) => {
    const dir = tempDir(t);
    for (const value of [{}, { url_scheme: null }]) {
      config(dir, value);
      output(run(args(dir)));
    }
  });

  it("uses production for every receiver host without an override", (t) => {
    const dir = tempDir(t);
    for (const host of ["relay-alpha.syncky.app", "relay-beta.syncky.app", "relay.syncky.app", "localhost", "custom.invalid"]) {
      const result = run(["link", "--data", dir, "--auth", "none", "--host", host]);
      assert.equal(result.status, 0, result.stderr);
      const link = new URL(result.stdout.trim());
      assert.equal(link.origin, "https://syncky.app");
      assert.equal(link.pathname, "/connect");
      assert.equal(link.search, "");
      assert.equal(new URLSearchParams(link.hash.slice(1)).get("url"), `http://${host}:3000/syncky`);
    }
  });

  it("rejects invalid flag and environment values without echoing inputs", (t) => {
    const dir = tempDir(t);
    const env = { SYNCKY_SERVER_TOKEN: "srv_do-not-print", SYNCKY_SERVER_HMAC: "whsec_mgHtkTuuLB_wsJa221vi031K8GmN9QbtPNq_RV8uD8c" };
    for (const value of ["", "auto", "SYNCKY", "syncky://", " syncky", "syncky ", "syncky-alpha", "syncky-lab", "syncky-preview", "syncky-lab-extra", "syncky-preview.evil", "https://do-not-print.invalid/?token=do-not-print", "--do-not-print"]) {
      refused(run([...args(dir), "--url-scheme", value], { env }));
      if (value !== "") refused(run(args(dir), { env: { ...env, SYNCKY_URL_SCHEME: value } }));
    }
    refused(run([...args(dir), "--url-scheme"], { env }));
  });

  it("rejects invalid config settings without echoing inputs", (t) => {
    const dir = tempDir(t);
    for (const value of ["", "auto", "SYNCKY", "syncky://", "syncky-alpha", "syncky-lab", "syncky-preview", "syncky-lab-extra", "https://do-not-print.invalid/?token=do-not-print", 1, false, [], {}]) {
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
      refused(run([command, "--data", dir, "--url-scheme", "syncky-lab"], { env }), "--url-scheme is only valid for link");
    }
  });

  it("documents the override, precedence and a public example in usage", () => {
    const result = run([]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--url-scheme <scheme>/);
    assert.match(result.stderr, /--url-scheme > SYNCKY_URL_SCHEME > .*config\.json.*url_scheme.* > syncky/);
    assert.match(result.stderr, /example: server.mjs link/);
  });
});
