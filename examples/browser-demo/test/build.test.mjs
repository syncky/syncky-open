import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildDemo, relayOrigin } from "../build.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const SOURCES = readdirSync(new URL("../src/", import.meta.url)).map((f) => `src/${f}`);
const STORAGE = /localStorage|sessionStorage|indexedDB|document\.cookie|\bcaches\b|navigator\.storage|serviceWorker|\bconsole\./;

async function built(t, options) {
  const out = mkdtempSync(join(tmpdir(), "syncky-demo-build-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const result = await buildDemo({ ...options, out });
  return { ...result, file: (name) => readFileSync(join(out, name), "utf8") };
}

describe("stores nothing and calls only the relay", () => {
  it("no source touches browser storage, cookies, caches or the console", () => {
    assert.ok(SOURCES.length >= 4);
    for (const file of SOURCES) assert.doesNotMatch(read(file), STORAGE, file);
  });

  it("sources import only the pinned packages and each other", () => {
    const allowed = new Set(["@hpke/core", "@hpke/dhkem-x25519", "@hpke/chacha20poly1305", "qrcode"]);
    for (const file of SOURCES) {
      for (const [, spec] of read(file).matchAll(/\bfrom\s*["']([^"']+)["']/g)) assert.ok(spec.startsWith("./") || allowed.has(spec), `${file} imports ${spec}`);
      assert.doesNotMatch(read(file), /\bimport\s*\(|\brequire\s*\(/, file);
    }
  });

  it("the bundle names no origin but the relay it was built for, and runs no eval", async (t) => {
    const { file } = await built(t, { relay: "https://relay-dev.syncky.app" });
    const js = file("demo.js");
    assert.match(js, /"https:\/\/relay-dev\.syncky\.app"/);
    assert.match(js, /"syncky-dev"/);
    assert.doesNotMatch(js, /__SYNCKY_/);
    const urls = new Set(js.match(/https?:\/\/[A-Za-z0-9.-]+/g));
    assert.deepEqual([...urls].sort(), ["https://relay-dev.syncky.app", "http://www.w3.org"].sort());
    assert.doesNotMatch(js, /\beval\(|new Function\(/);
    assert.doesNotMatch(js, STORAGE);
  });

  it("the page has no inline script, inline style or event handler, and links only to Syncky", async (t) => {
    const { files, file } = await built(t, {});
    assert.deepEqual(files.sort(), ["demo.css", "demo.js", "index.html"]);
    const html = file("index.html");
    assert.equal(html, read("index.html"));
    assert.equal((html.match(/<script\b/g) ?? []).length, 1);
    assert.match(html, /<script type="module" src="demo\.js"><\/script>/);
    assert.doesNotMatch(html, /<style\b|\sstyle=|\son[a-z]+=/i);
    for (const [, href] of html.matchAll(/href="([^"]+)"/g)) {
      assert.ok(["demo.css", "#"].includes(href) || /^https:\/\/(syncky\.app(\/[a-z-]*)?|github\.com\/syncky\/syncky-open\/)/.test(href), href);
    }
    assert.doesNotMatch(file("demo.css"), /@import|url\(/);
  });

  it("says plainly that it stores nothing, and how it ends", () => {
    const html = read("index.html");
    assert.ok(html.includes("Your browser keeps nothing: close or reload the tab and everything is gone."));
    assert.ok(html.includes("What Relay keeps: the demo hub with its sealed messages"));
    assert.ok(html.includes("Remove everything it wrote to Health"));
    assert.match(html, /End demo/);
    assert.match(html, /about 1 hour from the start/);
    assert.match(html, /Safari 17/);
    assert.match(html, /id="countdown"/);
    assert.match(read("src/main.mjs"), /text\("countdown", state.countdown/);
  });
});

describe("build options", () => {
  it("accepts an http(s) origin and refuses anything else", () => {
    assert.equal(relayOrigin("https://relay.syncky.app"), "https://relay.syncky.app");
    assert.equal(relayOrigin("http://127.0.0.1:8787/"), "http://127.0.0.1:8787");
    for (const bad of ["relay.syncky.app", "https://relay.syncky.app/v1", "ftp://x", "", undefined]) assert.throws(() => relayOrigin(bad));
  });

  it("refuses the removed URL scheme option for every scheme value", (t) => {
    const out = mkdtempSync(join(tmpdir(), "syncky-demo-option-"));
    t.after(() => rmSync(out, { recursive: true, force: true }));
    for (const scheme of ["syncky", "syncky-dev", "syncky-staging", "https"]) {
      const result = spawnSync(process.execPath, [fileURLToPath(new URL("../build.mjs", import.meta.url)), "--scheme", scheme, "--out", out], { encoding: "utf8" });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Unknown option '--scheme'/);
    }
  });

  it("defaults to the production relay and the production app", async (t) => {
    const result = await built(t, {});
    const { relay, file } = result;
    assert.equal(relay, "https://relay.syncky.app");
    assert.equal(Object.hasOwn(result, "scheme"), false);
    assert.match(file("demo.js"), /"https:\/\/relay\.syncky\.app"/);
  });
});
