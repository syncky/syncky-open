import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { buildLink, createServer, signReply, verifySignature } from "../server.mjs";
import { caseOptions, exchangeCase, hmacHex, inbox, lines, queue, requestCase, run, send, signed, tempDir, vectors, water } from "./helpers.js";

const GENERATED_REQUESTS = vectors("webhook-requests");
const base = GENERATED_REQUESTS.find((c) => c.requests.length > 0 && !c.follows);
const REQUESTS = [...GENERATED_REQUESTS, ...["syncky-dev", "syncky-staging"].map((url_scheme) => ({
  ...base, name: `${url_scheme} local replay`, url_scheme, link: base.link.replace(/^[^:]+:/, `${url_scheme}:`),
}))];
const EXCHANGES = vectors("webhook-exchanges");
const EXTENSIONS = { hae: "json", csv: "csv", influx: "lp" };

async function replay(t, c, dir, now = Number(c.timestamp)) {
  const server = await createServer({ ...caseOptions(c, dir), now: () => now, log: () => {} });
  t.after(() => server.close());
  const replies = [];
  for (const request of c.requests) replies.push(await send(server.port, { headers: request.headers, body: request.body }));
  return replies;
}

describe("webhook-requests.json", () => {
  it("replaying a native resend twice keeps UUID deduplication", async (t) => {
    const c = requestCase("native_resend_signed_every_kind");
    assert.ok(c, "regenerate webhook request vectors to include native resends");
    assert.equal(c.resend, true);
    assert.ok(c.requests.every((r) => JSON.parse(r.body).delivery.resend === true));
    const dir = tempDir(t);
    const first = await replay(t, c, dir);
    const samples = lines(join(dir, "samples.jsonl"));
    const deleted = lines(join(dir, "deleted.jsonl"));
    const second = await replay(t, c, dir);
    assert.ok([...first, ...second].every((r) => r.status === 200));
    assert.equal(samples.length, c.report.samples);
    assert.equal(deleted.length, c.report.deleted);
    assert.deepEqual(lines(join(dir, "samples.jsonl")), samples);
    assert.deepEqual(lines(join(dir, "deleted.jsonl")), deleted);
  });

  it("an older native receiver accepts unknown summaries without changing its raw store", async (t) => {
    const original = requestCase("native_resend_signed_every_kind");
    const c = structuredClone(original);
    c.destination.signing = false;
    c.requests = c.requests.map((request) => {
      const headers = { ...request.headers };
      delete headers["X-Syncky-Signature"];
      delete headers["X-Syncky-Timestamp"];
      const body = JSON.parse(request.body);
      body.summaries = [{ type: "steps", unit: "count", start: "2024-01-01T00:00:00Z", end: "2024-01-02T00:00:00Z", stat: "sum", value: 0 }];
      return { ...request, headers, body: JSON.stringify(body) };
    });
    const dir = tempDir(t);
    assert.ok((await replay(t, c, dir)).every((r) => r.status === 200));
    assert.equal(lines(join(dir, "samples.jsonl")).length, c.report.samples);
    assert.equal(lines(join(dir, "deleted.jsonl")).length, c.report.deleted);
  });

  for (const c of REQUESTS) {
    it(`${c.name}: every request is accepted and stored as reported`, async (t) => {
      const dir = tempDir(t);
      const replies = await replay(t, c, dir);
      assert.equal(replies.length, c.report.requests);
      for (const reply of replies) {
        assert.equal(reply.status, 200);
        assert.equal(reply.body, "");
      }
      if (c.format === "native") {
        assert.equal(lines(join(dir, "samples.jsonl")).length, c.report.samples);
        assert.equal(lines(join(dir, "deleted.jsonl")).length, c.report.deleted);
        assert.deepEqual(inbox(dir), []);
      } else {
        const expected = c.requests.map((r) => `${r.headers["X-Syncky-Delivery"]}.${EXTENSIONS[c.format]}`).sort();
        assert.deepEqual(inbox(dir), expected);
        for (const r of c.requests) {
          assert.equal(readFileSync(join(dir, "inbox", `${r.headers["X-Syncky-Delivery"]}.${EXTENSIONS[c.format]}`), "utf8"), r.body);
        }
      }
    });

    it(`${c.name}: buildLink reproduces the link`, () => {
      assert.ok(buildLink(c.destination, c.secrets, c.url_scheme) === c.link, "built link differs from the vector bytes");
    });
  }

  it("a case that follows another upserts its activity summary in the same data dir", async (t) => {
    const follower = REQUESTS.find((c) => c.follows);
    const leader = requestCase(follower.follows);
    const dir = tempDir(t);
    await replay(t, leader, dir);
    const before = lines(join(dir, "samples.jsonl"));
    const replies = await replay(t, follower, dir);
    assert.ok(replies.every((r) => r.status === 200));
    const after = lines(join(dir, "samples.jsonl"));
    assert.equal(after.length, before.length);
    for (const request of follower.requests) {
      const message = JSON.parse(request.body);
      for (const sample of message.samples) {
        const stored = after.map((line) => JSON.parse(line)).filter((r) => r.uuid === sample.uuid);
        assert.deepEqual(stored, [{ device: message.device, ...sample }]);
      }
    }
  });
});

describe("webhook-signatures.json", () => {
  for (const c of vectors("webhook-signatures")) {
    it(`${c.name} is ${c.expect}`, () => {
      assert.equal(verifySignature({ secret: c.secret, timestamp: c.timestamp, signature: c.signature, body: c.body, now: c.now }), c.expect);
    });
  }
});

describe("webhook-exchanges.json", () => {
  for (const c of EXCHANGES.filter((x) => x.kind === "reply" && x.signature !== null)) {
    it(`reply ${c.name}: signReply ${c.signature_valid ? "reproduces" : "does not reproduce"} the signature`, () => {
      assert.equal(signReply(c.secret, c.delivery, c.t, c.body) === c.signature, c.signature_valid);
    });
  }

  it("the queued writes, their results and a delete give the vector replies byte for byte", async (t) => {
    const c = requestCase("native_bearer_signed_every_kind");
    const write = exchangeCase("signed_http");
    const results = exchangeCase("results_after_signed_http");
    const remove = exchangeCase("signed_http_delete");
    const dir = tempDir(t);
    for (const args of [["dietary_water", "0.25", "L"], ["apple_exercise_time", "30", "min"]]) {
      assert.equal(run(["write", ...args, "--at", "2026-10-14T07:00:00Z", "--data", dir]).status, 0);
    }
    let clock = Number(write.t);
    const server = await createServer({ ...caseOptions(c, dir), now: () => clock, log: () => {} });
    t.after(() => server.close());

    assert.equal(c.requests[0].headers["X-Syncky-Delivery"], write.delivery);
    const first = await send(server.port, { headers: c.requests[0].headers, body: c.requests[0].body });
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("content-type"), write.content_type);
    assert.equal(first.body, write.body);
    assert.equal(first.headers.get("x-syncky-signature"), write.signature);

    clock = Number(results.timestamp);
    const done = await send(server.port, { headers: results.headers, body: results.body });
    assert.equal(done.status, 200);
    assert.equal(done.body, "");
    assert.deepEqual(lines(join(dir, "results.jsonl")).map((l) => JSON.parse(l)).map((r) => `${r.command_id}/${r.version}/${r.status}`), ["c_1/1/applied", "c_2/1/rejected"]);

    assert.equal(run(["delete", "c_1", "--data", dir]).status, 0);
    clock = Number(remove.t);
    const body = c.requests[0].body;
    const headers = signed({ ...c.requests[0].headers, "X-Syncky-Delivery": remove.delivery }, body, c.secrets.hmac, remove.t);
    const second = await send(server.port, { headers, body });
    assert.equal(second.status, 200);
    assert.equal(second.body, remove.body);
    assert.equal(second.headers.get("x-syncky-signature"), remove.signature);
    assert.equal(second.headers.get("x-syncky-signature"), `t=${remove.t},v1=${hmacHex(c.secrets.hmac, `${remove.delivery}.${remove.t}.${remove.body}`)}`);
  });

  it("results_after_signed_http marks c_1 and c_2 done", async (t) => {
    const results = exchangeCase("results_after_signed_http");
    const c = requestCase("native_bearer_signed_every_kind");
    const dir = tempDir(t);
    queue(dir, [water(1), { ...water(2), type: "apple_exercise_time", value: 30, unit: "min" }]);
    const server = await createServer({ ...caseOptions(results, dir), now: () => Number(results.timestamp), log: () => {} });
    t.after(() => server.close());
    assert.equal((await send(server.port, { headers: results.headers, body: results.body })).status, 200);
    const next = await send(server.port, { headers: c.requests[0].headers, body: c.requests[0].body });
    assert.equal(next.status, 200);
    assert.equal(next.body, "");
    assert.equal(lines(join(dir, "results.jsonl")).length, 2);
  });

  for (const c of EXCHANGES.filter((x) => x.kind === "test_request")) {
    it(`${c.name} is 200, stores nothing and gets no commands`, async (t) => {
      const dir = tempDir(t);
      queue(dir, [water(1)]);
      const server = await createServer({ ...caseOptions(c, dir), now: () => Number(c.timestamp), log: () => {} });
      t.after(() => server.close());
      const reply = await send(server.port, { headers: c.headers, body: c.body });
      assert.equal(reply.status, 200);
      assert.equal(reply.body, "");
      assert.equal(reply.headers.get("x-syncky-signature"), null);
      assert.deepEqual(lines(join(dir, "samples.jsonl")), []);
      assert.deepEqual(lines(join(dir, "deleted.jsonl")), []);
      assert.deepEqual(inbox(dir), []);
    });
  }
});
