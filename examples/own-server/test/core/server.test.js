import { it } from "node:test";
import assert from "node:assert/strict";
import { createUploadCredentials, buildLink } from "../../src/crypto.js";
import { fixture, native, messageRequest, sample, rows, secret, destination, authHeader, signed } from "../support/helpers.js";

it("denies uploads before initialization and rejects unsafe credential configurations", async (t) => {
  const f = await fixture(t, { initialized: false });
  assert.equal((await f.send(native(f, { samples: [sample()] }))).status, 503);
  assert.equal(rows(f, "samples").length, 0);
  for (const auth of [{ kind: "none" }, { kind: "other" }, { kind: "header", header_name: "Host" }, { kind: "header", header_name: "x-syncky-future" }, { kind: "header", header_name: "bad\nheader" }, { kind: "basic", user: "bad:user" }]) await assert.rejects(createUploadCredentials({ auth, token: secret() }), /invalid_configuration/);
  f.sql.run("INSERT INTO settings(key, value_json) VALUES (?, ?)", "upload_credentials", JSON.stringify({ initialized: true, auth: { kind: "none" }, verifier: "", hmac: null }));
  assert.equal((await f.send(native(f))).status, 503);
});

it("routes health, methods and missing paths without disclosing state", async (t) => {
  const f = await fixture(t, { initialized: false });
  const response = await f.send(new Request("https://receiver.example/health"));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '{"ok":true}');
  assert.equal((await f.send(new Request("https://receiver.example/health", { method: "POST" }))).status, 405);
  assert.equal((await f.send(new Request("https://receiver.example/server"))).headers.get("allow"), "POST");
  assert.equal((await f.send(new Request("https://receiver.example/other"))).status, 404);
});

for (const auth of [{ kind: "bearer" }, { kind: "header", header_name: "X-Upload-Key" }, { kind: "basic", user: "phone" }]) {
  for (const signing of [false, true]) it(`${auth.kind} authenticates exclusively with HMAC ${signing ? "enabled" : "disabled"}`, async (t) => {
    const f = await fixture(t, { auth, hmac: signing ? secret() : null });
    const valid = native(f, { samples: [sample()] });
    const wrong = new Request(valid.clone());
    const name = auth.kind === "header" ? auth.header_name : "Authorization";
    wrong.headers.set(name, secret());
    wrong.headers.set(auth.kind === "header" ? "Authorization" : "X-Upload-Key", `Bearer ${f.config.token}`);
    assert.equal((await f.send(wrong)).status, 401);
    assert.equal((await f.send(valid)).status, 200);
    assert.equal(rows(f, "samples").length, 1);
    assert.ok(!JSON.stringify(f.store.credentials()).includes(f.config.token), "upload token is not stored");
    if (signing) {
      const missing = native(f);
      missing.headers.delete("X-Syncky-Signature");
      assert.equal((await f.send(missing)).status, 401);
    }
  });
}

it("enforces exact UTF-8 HMAC bytes and skew through the handler", async (t) => {
  const f = await fixture(t, { hmac: secret() });
  const original = native(f, { samples: [sample({ note: "Grüße 🏔" })] });
  const body = await original.text();
  for (const skew of [-301, -300, 300, 301]) {
    const headers = signed(Object.fromEntries(original.headers), body, f.config.hmac, f.deps.now() + skew);
    assert.equal((await f.send(new Request(original.url, { method: "POST", headers, body }))).status, Math.abs(skew) <= 300 ? 200 : 401);
  }
  for (const change of [h => h.set("X-Syncky-Signature", h.get("X-Syncky-Signature").toUpperCase()), h => h.set("X-Syncky-Timestamp", "not-a-time")]) {
    const request = new Request(original.url, { method: "POST", headers: original.headers, body });
    change(request.headers);
    assert.equal((await f.send(request)).status, 401);
  }
  assert.equal((await f.send(new Request(original.url, { method: "POST", headers: original.headers, body: body + " " }))).status, 401);
});

it("checks native target consistency and payload structure", async (t) => {
  const f = await fixture(t);
  for (const extra of [{ device: "" }, { v: 2 }, { type: "results" }, { samples: null }, { acks: ["x"] }]) assert.equal((await f.send(native(f, extra))).status, 400);
  const request = native(f, { samples: [sample()] });
  request.headers.set("X-Syncky-Destination", destination());
  assert.equal((await f.send(request)).status, 400);
  const mismatch = native(f);
  mismatch.headers.set("X-Syncky-Delivery", crypto.randomUUID());
  assert.equal((await f.send(mismatch)).status, 400);
  assert.equal(rows(f, "upload_targets").length, 0);
  assert.equal((await f.send(native(f, { samples: [sample({ uuid: "'); DROP TABLE samples; --" })] }))).status, 400);
  const noFormat = native(f);
  noFormat.headers.delete("X-Syncky-Format");
  assert.equal((await f.send(noFormat)).status, 415);
  const noType = native(f);
  noType.headers.delete("Content-Type");
  assert.equal((await f.send(noType)).status, 415);
  assert.equal((await f.send(native(f, { samples: [sample({ start: "2026-02-30T00:00:00Z", end: "2026-03-03T00:00:00Z" })] }))).status, 400);
});

it("probes store nothing, including nonempty forged probes", async (t) => {
  const f = await fixture(t);
  const m = await native(f).json();
  m.delivery.test = true;
  assert.equal((await f.send(native(f, m))).status, 200);
  m.samples.push(sample());
  assert.equal((await f.send(native(f, m))).status, 400);
  for (const table of ["samples", "summaries", "upload_targets", "results"]) assert.equal(rows(f, table).length, 0);
});

it("accepts validated results without a format, isolates destinations and deduplicates versions", async (t) => {
  const f = await fixture(t);
  const target = destination();
  const message = { v: 1, type: "results", results: [{ command_id: "c_1", version: 1, status: "applied" }, { command_id: "c_2", version: 2, status: "rejected", reason: "healthkit_denied" }] };
  const send = async (m, dest = target) => {
    const r = messageRequest(f, m, { "X-Syncky-Kind": "results", "X-Syncky-Destination": dest });
    r.headers.delete("X-Syncky-Format");
    return f.send(r);
  };
  for (let i = 0; i < 2; i++) {
    const response = await send(message);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "");
  }
  assert.equal(rows(f, "results").length, 2);
  await send(message, destination());
  assert.equal(rows(f, "results").length, 4);
  for (const result of [{ command_id: "c_1", version: 0, status: "applied" }, { command_id: "c_1", version: 1, status: "queued" }, { command_id: "c_1", version: 1, status: "rejected", reason: "arbitrary" }]) assert.equal((await send({ ...message, results: [result] })).status, 400);
});

it("rejects unknown kinds, non-native formats, malformed JSON/UTF-8 and oversized chunked bodies", async (t) => {
  const f = await fixture(t);
  for (const format of ["hae", "csv", "influx", "other", ""]) {
    const r = native(f);
    r.headers.set("X-Syncky-Format", format);
    assert.equal((await f.send(r)).status, 415);
  }
  const unknown = native(f);
  unknown.headers.set("X-Syncky-Kind", "other");
  assert.equal((await f.send(unknown)).status, 400);
  for (const body of ["{", new Uint8Array([0xff]), '{"v":1e400}', '['.repeat(100) + '0' + ']'.repeat(100)]) {
    const r = new Request("https://receiver.example/server", { method: "POST", headers: { ...authHeader(f.config), "Content-Type": "application/json", "X-Syncky-Format": "native" }, body });
    assert.equal((await f.send(r)).status, 400);
  }
  let cancelled = false;
  const stream = new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(400_001)); }, cancel() { cancelled = true; } });
  const r = new Request("https://receiver.example/server", { method: "POST", headers: authHeader(f.config), body: stream, duplex: "half" });
  assert.equal((await f.send(r)).status, 413);
  assert.ok(cancelled, "oversized input stopped");
});

it("distinguishes malformed and oversized Content-Length before storing any records", async (t) => {
  const f = await fixture(t);
  const original = native(f, { samples: [sample({ note: "Grüße" })] });
  const body = await original.text();
  for (const length of ["bad", "-1", "", "+1", "1.5", "1e3", "1, 2", "0x10"]) {
    const request = new Request(original.url, { method: "POST", headers: original.headers, body });
    request.headers.set("Content-Length", length);
    const response = await f.send(request);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { ok: false, code: "invalid_content_length" });
  }
  for (const length of ["1000001", "9".repeat(400)]) {
    const request = new Request(original.url, { method: "POST", headers: original.headers, body });
    request.headers.set("Content-Length", length);
    const response = await f.send(request);
    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), { ok: false, code: "payload_too_large" });
  }
  for (const table of ["samples", "summaries", "upload_targets"]) assert.equal(rows(f, table).length, 0);
  const valid = new Request(original.url, { method: "POST", headers: original.headers, body });
  valid.headers.set("Content-Length", String(new TextEncoder().encode(body).byteLength));
  assert.equal((await f.send(valid)).status, 200);
  assert.equal(rows(f, "samples").length, 1);
});

it("accepts the exact byte cap and rejects one byte more, including UTF-8", async (t) => {
  const f = await fixture(t);
  const original = native(f, { padding: "é" });
  const text = await original.text();
  const bytes = new TextEncoder().encode(text).length;
  for (const size of [1_000_000, 1_000_001]) {
    const body = text + " ".repeat(size - bytes);
    const r = new Request(original.url, { method: "POST", headers: original.headers, body });
    assert.equal((await f.send(r)).status, size === 1_000_000 ? 200 : 413);
  }
});

it("rejects aborted body streams without persisting any records", async (t) => {
  const f = await fixture(t);
  const r = new Request("https://receiver.example/server", { method: "POST", headers: authHeader(f.config), body: new ReadableStream({ start(c) { c.error(new Error(secret())); } }), duplex: "half" });
  const response = await f.send(r);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "invalid_body");
  assert.equal(rows(f, "samples").length, 0);
});

it("builds only authenticated native setup links for all supported schemes", () => {
  const token = secret();
  for (const scheme of ["syncky", "syncky-dev", "syncky-staging"]) {
    const link = new URL(buildLink({ name: "Local Grüße", url: "https://receiver.example/server", format: "native", auth: { kind: "bearer" }, signing: false }, { token }, scheme));
    assert.equal(link.protocol, scheme + ":");
    assert.equal(link.searchParams.get("format"), "native");
    assert.equal(link.searchParams.get("name"), "Local Grüße");
    assert.ok(link.searchParams.get("token") === token, "token encoded exactly");
    assert.ok(!link.searchParams.has("writes"));
  }
  assert.throws(() => buildLink({ name: "Local", url: "invalid", format: "native", auth: { kind: "bearer" } }, { token }), { message: "invalid_configuration" });
});
