import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { qrPath } from "../src/qr.mjs";
import { pairView } from "../src/view.mjs";

describe("pair block", () => {
  const pairing = { code: "pairing-code", uri: "https://dev.syncky.app/pair#v=2" };

  for (const phase of ["confirmed", "phone_left", "expired"]) {
    it(`keeps the code through joining and clears it on ${phase}`, () => {
      assert.deepEqual(pairView({ phase: "pairing", pairing }), {
        showPair: true, showQr: true, showLink: true, code: pairing.code, uri: pairing.uri,
      });
      assert.deepEqual(pairView({ phase: "joined", pairing }), {
        showPair: true, showQr: false, showLink: false, code: pairing.code, uri: null,
      });
      for (const value of [pairing, null]) {
        assert.deepEqual(pairView({ phase, pairing: value }), {
          showPair: false, showQr: false, showLink: false, code: "", uri: null,
        });
      }
    });
  }

  it("shows a joined code without a URI or pairing expiry", () => {
    assert.deepEqual(pairView({ phase: "joined", pairing: { code: pairing.code } }), {
      showPair: true, showQr: false, showLink: false, code: pairing.code, uri: null,
    });
  });

  it("clears the rendered QR and link on joining and rebuilds them when pairing again", async () => {
    const { outputFiles } = await build({
      entryPoints: [fileURLToPath(new URL("../src/main.mjs", import.meta.url))],
      bundle: true,
      write: false,
      format: "iife",
      define: { __SYNCKY_RELAY__: '"https://relay.example"' },
      plugins: [{ name: "session-fixture", setup(builder) {
        builder.onLoad({ filter: /[/\\]session\.mjs$/ }, () => ({
          contents: "export const DemoSession = globalThis.DemoSession; export const WRITES = {};",
        }));
      } }],
    });
    const element = () => ({
      children: [],
      replaceChildren(...children) { this.children = children; },
      append(...children) { this.children.push(...children); },
      attributes: {},
      setAttribute(key, value) { this.attributes[key] = value; },
      addEventListener(event, handler) { this[event] = handler; },
    });
    const elements = new Map();
    const get = id => {
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id);
    };
    let session;
    runInNewContext(outputFiles[0].text, {
      assert,
      document: { getElementById: get, createElementNS: element },
      TextEncoder,
      isSecureContext: true,
      crypto: { subtle: {}, getRandomValues() {} },
      addEventListener() {},
      DemoSession: class {
        constructor(options) {
          assert.equal(Object.hasOwn(options, "scheme"), false);
          const { onChange } = options;
          session = this;
          this.state = { phase: "idle", samples: [], commands: [] };
          this.emit = change => onChange(Object.assign(this.state, change));
        }
        pairAgain() { this.emit({ phase: "pairing", pairing: this.nextPairing }); }
      },
    });
    session.emit({ phase: "pairing", pairing });
    for (const nextPairing of [pairing, { code: "next-code", uri: "https://dev.syncky.app/pair#v=2&next" }]) {
      const previousQr = get("qr").children[0];
      assert.ok(previousQr);
      const code = session.state.pairing.code;
      session.emit({ phase: "joined", pairing: { code } });
      assert.equal(get("pair").hidden, false);
      assert.equal(get("code").textContent, code);
      for (const id of ["pair-title", "qr", "pair-link"]) assert.equal(get(id).hidden, true);
      assert.equal(get("qr").children.length, 0);
      assert.equal(get("link").href, "#");
      assert.equal(get("link").textContent, "pairing link");
      session.emit({ phase: "phone_left", pairing: null });
      assert.equal(get("again").hidden, false);
      session.nextPairing = nextPairing;
      get("again-button").click();
      for (const id of ["pair", "pair-title", "qr", "pair-link"]) assert.equal(get(id).hidden, false);
      assert.equal(get("code").textContent, nextPairing.code);
      assert.equal(get("link").href, nextPairing.uri);
      assert.equal(get("link").textContent, nextPairing.uri);
      assert.equal(get("qr").children.length, 1);
      const { d } = qrPath(get("link").textContent);
      assert.ok(get("qr").children[0].children[1].attributes.d === d, "QR differs from printed link");
      assert.notEqual(get("qr").children[0], previousQr);
    }
  });

  for (const phase of ["idle", "starting", "ending", "leave_failed", "ended", "error"]) {
    it(`hides the pair block and clears its code in ${phase}`, () => {
      assert.deepEqual(pairView({ phase, pairing }), {
        showPair: false, showQr: false, showLink: false, code: "", uri: null,
      });
    });
  }
});
