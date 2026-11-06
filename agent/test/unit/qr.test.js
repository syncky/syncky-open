import { describe, it } from "node:test";
import assert from "node:assert/strict";

import qrcodeTerminal from "qrcode-terminal";
import QRErrorCorrectLevel from "qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel.js";

import { renderTerminalQr } from "../../src/pairing.js";
import { buildPairUri } from "../../src/pair-uri.js";

function renderAt(level, text) {
  let out = "";
  qrcodeTerminal.error = QRErrorCorrectLevel[level];
  qrcodeTerminal.generate(text, { small: true }, (s) => {
    out = s;
  });
  return out;
}

const URI = buildPairUri({
  relayBase: "https://relay.syncky.app",
  hubId: `hub_${"a".repeat(22)}`,
  pairingToken: `pt_${"B".repeat(43)}`,
  agentPublicKey: "--gxExbiebFCpy5o1_uW7TgEiI4k3wn_O9EKOctYNBU",
  agentName: "Lab agent",
});

describe("renderTerminalQr", () => {
  it("renders a non-empty multi-line block", () => {
    const qr = renderTerminalQr(URI);
    const lines = qr.split("\n");
    assert.ok(lines.length > 10);
    const rows = lines.slice(1, -1);
    assert.ok(rows.every((l) => l.length === rows[0].length));
    assert.match(qr, /^[▀▄█ \n]+$/);
  });

  it("uses error correction level M", () => {
    const qr = renderTerminalQr(URI);
    assert.equal(qr, renderAt("M", URI));
    for (const other of ["L", "Q", "H"]) assert.notEqual(qr, renderAt(other, URI), other);
  });

  it("is deterministic for a fixed URI, whatever error level another caller left set", () => {
    const first = renderTerminalQr(URI);
    qrcodeTerminal.setErrorLevel("L");
    assert.equal(renderTerminalQr(URI), first);
    qrcodeTerminal.setErrorLevel("H");
    assert.equal(renderTerminalQr(URI), first);
    assert.notEqual(renderTerminalQr(`${URI}x`), first);
  });

  it("renders a ~250-character URI without error", () => {
    const long = buildPairUri({
      relayBase: "https://relay-eu-west-1.syncky.example.com:8443",
      hubId: `hub_${"Z".repeat(22)}`,
      pairingToken: `pt_${"q".repeat(43)}`,
      agentPublicKey: "--gxExbiebFCpy5o1_uW7TgEiI4k3wn_O9EKOctYNBU",
      agentName: "Home server (rack 2) — Ünïcode name, 64 chars max!!",
    });
    assert.ok(long.length >= 240 && long.length <= 320, String(long.length));
    const qr = renderTerminalQr(long);
    assert.ok(qr.split("\n").length > renderTerminalQr(URI).split("\n").length / 2);
    assert.ok(qr.length > 0);
  });
});
