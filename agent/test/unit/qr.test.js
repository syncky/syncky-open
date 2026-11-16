import { describe, it } from "node:test";
import assert from "node:assert/strict";

import qrcodeTerminal from "qrcode-terminal";
import QRCode from 'qrcode-terminal/vendor/QRCode/index.js';
import { pairingQr, QR_QUIET_ZONE, QR_TERMINAL_QUIET_ZONE } from '../../src/pair-qr.js';
import QRErrorCorrectLevel from "qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel.js";

import { renderTerminalQr } from "../../src/pairing.js";
import { buildPairUri } from "../../src/pair-uri.js";

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

  it("uses the smallest L matrix and preserves every module with a two-module terminal quiet zone", () => {
    const expected = new QRCode(-1, QRErrorCorrectLevel.L); expected.addData(URI); expected.make();
    const matrix = pairingQr(URI);
    assert.deepEqual(matrix, expected.modules);
    const rows = renderTerminalQr(URI).trimEnd().split("\n");
    const modules = rows.flatMap(row => [Array.from(row, c => c === ' ' || c === '▄'), Array.from(row, c => c === ' ' || c === '▀')]);
    assert.equal(QR_QUIET_ZONE, 4); assert.equal(QR_TERMINAL_QUIET_ZONE, 2);
    assert.equal(rows[0].length, matrix.length + 4);
    assert.equal(rows.length, Math.ceil((matrix.length + 4) / 2));
    for (let y = 0; y < modules.length; y++) for (let x = 0; x < rows[0].length; x++) {
      assert.equal(modules[y][x], matrix[y - 2]?.[x - 2] === true, `module ${x},${y}`);
    }
    const shipped = new QRCode(-1, QRErrorCorrectLevel.M); shipped.addData(URI); shipped.make();
    assert.ok(rows[0].length < shipped.getModuleCount() + 2, 'narrower than the shipped rendering');
    const previous = new QRCode(-1, QRErrorCorrectLevel.M); previous.addData(URI); previous.make();
    assert.ok(matrix.length < previous.getModuleCount());
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
      relayBase: "https://relay-eu-west-1.syncky.example.com:9443",
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

for (const [name, extra, expected] of [
  ['v1', {}, [183, 10, 8, 59, 30, 53, 27]],
  ['v2', { pairSecret: 'A'.repeat(22) }, [208, 10, 9, 59, 30, 57, 29]],
  ['v2 read/write', { pairSecret: 'A'.repeat(22), requestedScope: { request_ref: 'a'.repeat(32), read: ['body_mass', 'heart_rate'], write: ['dietary_water'] } }, [331, 13, 12, 71, 36, 69, 35]],
]) it(`${name} uses the minimum L version for the unchanged protocol URI`, () => {
  const uri = buildPairUri({ relayBase: 'https://relay.syncky.app', hubId: 'hub_' + 'A'.repeat(22), pairingToken: 'pt_' + 'T'.repeat(43), agentPublicKey: 'A'.repeat(43), agentName: 'My agent', ...extra });
  const previous = new QRCode(-1, QRErrorCorrectLevel.M); previous.addData(uri); previous.make();
  const matrix = pairingQr(uri), n = previous.getModuleCount(), rows = renderTerminalQr(uri).trimEnd().split('\n');
  assert.deepEqual([Buffer.byteLength(uri), previous.typeNumber, (matrix.length - 17) / 4, n + 2, (n + 3) / 2, rows[0].length, rows.length], expected);
  const smaller = new QRCode(expected[2] - 1, QRErrorCorrectLevel.L); smaller.addData(uri);
  assert.throws(() => smaller.make(), /overflow/);
});
