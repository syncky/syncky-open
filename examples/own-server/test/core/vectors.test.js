import { it } from "node:test";
import assert from "node:assert/strict";
import { buildLink, createUploadCredentials, signReply, verifySignature } from "../../src/crypto.js";
import { vectors, vectorFixture, vectorRequest, rows, equalJSON, secret, fixture, authHeader, signed } from "../support/helpers.js";

for (const c of vectors("webhook-requests")) {
  it(`request vector: ${c.name}`, async (t) => {
    if (c.destination.auth.kind === "none") await assert.rejects(createUploadCredentials({ auth: c.destination.auth, token: secret() }), /invalid_configuration/);
    const f = await vectorFixture(t, c);
    f.deps.now = () => Number(c.timestamp);
    const ordered = [...c.requests].reverse();
    for (const r of [...ordered, ...c.requests]) {
      const response = await f.send(vectorRequest(f, r));
      assert.equal(response.status, c.format === "native" ? 200 : 415);
      if (response.status === 200) assert.equal(await response.text(), "");
      else assert.equal((await response.json()).code, "unsupported_format");
    }
    if (c.format !== "native") {
      assert.equal(rows(f, "samples").length, 0);
      return;
    }
    const samples = new Map();
    const summaries = new Map();
    for (const r of [...ordered, ...c.requests]) {
      const m = JSON.parse(r.body);
      for (const s of m.samples) samples.set(`${m.device}|${s.uuid}|${s.part ?? -1}`, s);
      for (const s of m.deleted) for (const key of samples.keys()) if (key.startsWith(`${m.device}|${s.uuid}|`)) samples.delete(key);
      for (const s of m.summaries ?? []) summaries.set(JSON.stringify([m.device, s.type, s.unit, s.start, s.end, s.stat]), s);
    }
    assert.equal(rows(f, "samples").length, samples.size);
    assert.equal(rows(f, "summaries").length, summaries.size);
    for (const row of rows(f, "samples")) assert.ok(equalJSON(JSON.parse(row.payload_json), samples.get(`${row.device}|${row.uuid}|${row.part}`)), "sample payload preserved");
    for (const row of rows(f, "summaries")) assert.ok(row.value === summaries.get(JSON.stringify([row.device, row.type, row.unit, row.start, row.end, row.stat])).value, "summary replaced");
    if (c.destination.auth.kind !== "none" && c.format === "native") assert.ok(buildLink(c.destination, c.secrets, c.url_scheme) === c.link, "setup link matches vector bytes");
    else assert.throws(() => buildLink(c.destination, c.secrets), /invalid_configuration/);
  });
}

for (const c of vectors("webhook-signatures")) it(`signature vector: ${c.name}`, async (t) => {
  assert.equal(await verifySignature(c), c.expect);
  const f = await fixture(t, { hmac: c.secret });
  f.deps.now = () => c.now;
  const response = await f.send(new Request("https://receiver.example/server", { method: "POST", headers: { ...authHeader(f.config), "Content-Type": "application/json", "X-Syncky-Format": "native", "X-Syncky-Timestamp": c.timestamp, "X-Syncky-Signature": c.signature }, body: c.body }));
  assert.equal(response.status, c.expect === "valid" ? 400 : 401);
  if (c.expect !== "valid") assert.equal((await response.json()).code, c.expect);
});

it("the published follower replaces its activity-summary payload in the original store", async (t) => {
  const cases = vectors("webhook-requests");
  const follower = cases.find(c => c.follows);
  const leader = cases.find(c => c.name === follower.follows);
  const f = await vectorFixture(t, follower);
  for (const c of [leader, follower]) {
    f.deps.now = () => Number(c.timestamp);
    for (const r of c.requests) {
      const headers = f.config.hmac ? signed({ ...r.headers, ...authHeader(f.config) }, r.body, f.config.hmac, f.deps.now()) : { ...r.headers, ...authHeader(f.config) };
      assert.equal((await f.send(vectorRequest(f, { ...r, headers }))).status, 200);
    }
  }
  for (const r of follower.requests) for (const s of JSON.parse(r.body).samples) assert.ok(equalJSON(JSON.parse(rows(f, "samples").find(row => row.uuid === s.uuid).payload_json), s), "published replacement retained");
});

for (const c of vectors("webhook-exchanges")) {
  if (c.kind === "reply") {
    if (c.signature !== null) it(`reply signer: ${c.name}`, async () => {
      assert.equal((await signReply(c.secret, c.delivery, c.t, c.body)) === c.signature, c.signature_valid);
    });
  } else it(`exchange request: ${c.name}`, async (t) => {
    const f = await vectorFixture(t, c);
    f.deps.now = () => Number(c.timestamp);
    const response = await f.send(vectorRequest(f, c));
    assert.equal(response.status, c.kind === "results_request" || c.format === "native" ? 200 : 415);
    if (response.status === 200) assert.equal(await response.text(), "");
    assert.equal(rows(f, "samples").length, 0);
    assert.equal(rows(f, "summaries").length, 0);
    assert.equal(rows(f, "upload_targets").length, 0);
  });
}
