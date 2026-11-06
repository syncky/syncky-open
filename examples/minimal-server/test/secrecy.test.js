import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { exchangeCase, lines, requestCase, run, send, SERVER, signed, tempDir } from "./helpers.js";

const BEARER_CASES = ["native_bearer_signed_every_kind", "hae_bearer_signed_every_shape", "influx_bearer_signed_every_kind"];

function startServe(t, dir, env) {
  const child = spawn(process.execPath, [SERVER, "serve", "--data", dir, "--port", "0"], { env: { PATH: process.env.PATH, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const output = { stdout: "", stderr: "" };
  child.stdout.on("data", (chunk) => (output.stdout += chunk));
  child.stderr.on("data", (chunk) => (output.stderr += chunk));
  const exited = new Promise((done) => child.once("exit", (code, signal) => done({ code, signal })));
  t.after(() => child.kill("SIGKILL"));
  const port = new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error("serve did not start")), 10_000);
    child.stdout.on("data", () => {
      const m = /listening on 127\.0\.0\.1:([0-9]+)/.exec(output.stdout);
      if (m) {
        clearTimeout(timer);
        done(Number(m[1]));
      }
    });
    exited.then(() => fail(new Error("serve exited before listening")));
  });
  return { child, output, port, exited };
}

const fresh = (headers, body, hmac) => signed(headers, body, hmac, Math.floor(Date.now() / 1000));

describe("log secrecy", () => {
  it("serve's output and stored command files hold no secret, signature or full URL", async (t) => {
    const dir = tempDir(t);
    const first = requestCase(BEARER_CASES[0]);
    const { token, hmac } = first.secrets;
    for (const args of [["dietary_water", "0.25", "L"], ["apple_exercise_time", "30", "min"]]) assert.equal(run(["write", ...args, "--data", dir]).status, 0);
    const serve = startServe(t, dir, { SYNCKY_SERVER_TOKEN: token, SYNCKY_SERVER_HMAC: hmac });
    const port = await serve.port;

    const sentSignatures = [];
    const replySignatures = [];
    const deliver = async (headers, body) => {
      const h = fresh(headers, body, hmac);
      sentSignatures.push(h["X-Syncky-Signature"]);
      const reply = await send(port, { headers: h, body });
      if (reply.headers.get("x-syncky-signature")) replySignatures.push(reply.headers.get("x-syncky-signature"));
      return reply;
    };
    for (const name of BEARER_CASES) {
      for (const r of requestCase(name).requests) assert.equal((await deliver(r.headers, r.body)).status, 200);
    }
    const probe = exchangeCase("test_native");
    assert.equal((await deliver(probe.headers, probe.body)).status, 200);
    const results = exchangeCase("results_after_signed_http");
    assert.equal((await deliver(results.headers, results.body)).status, 200);
    const r0 = first.requests[0];
    assert.equal((await send(port, { headers: { ...fresh(r0.headers, r0.body, hmac), Authorization: `Bearer ${token}x` }, body: r0.body })).status, 401);
    assert.equal((await send(port, { headers: { ...r0.headers, "X-Syncky-Timestamp": "1" }, body: r0.body })).status, 401);
    assert.equal((await send(port, { headers: { ...fresh(r0.headers, r0.body, hmac), "X-Syncky-Format": `${token}` }, body: r0.body })).status, 400);
    assert.equal((await send(port, { method: "GET", path: `/health?token=${token}` })).status, 200);
    assert.ok(replySignatures.length > 0, "no signed reply was produced");

    serve.child.kill("SIGTERM");
    assert.deepEqual(await serve.exited, { code: 0, signal: null });

    const sources = {
      stdout: serve.output.stdout,
      stderr: serve.output.stderr,
      "results.jsonl": readFileSync(join(dir, "results.jsonl"), "utf8"),
      "outbox.jsonl": readFileSync(join(dir, "outbox.jsonl"), "utf8"),
    };
    assert.ok(lines(join(dir, "samples.jsonl")).length > 0, "nothing was stored");
    assert.ok(serve.output.stdout.split("\n").length > BEARER_CASES.length, "the server logged nothing");
    const leaks = {
      token: [token],
      "hmac secret": [hmac, "whsec_"],
      "request signature": sentSignatures.concat(["v1="]),
      "reply signature": replySignatures,
      "full URL": ["http://", "https://", "receiver.example", "?token="],
      "auth header": ["Bearer", "Basic "],
      body: ['"samples"', "a_positive", "heart_rate,", "dietary_water"],
    };
    for (const [where, text] of Object.entries(sources)) {
      for (const [kind, needles] of Object.entries(leaks)) {
        if (where === "outbox.jsonl" && kind === "body") continue;
        const found = needles.some((needle) => text.includes(needle));
        assert.equal(found, false, `${where} contains a ${kind}`);
      }
    }
  });

  it("init writes the secret files with mode 600 and the data dir with mode 700", (t) => {
    const dir = join(tempDir(t), "data");
    assert.equal(run(["init", "--data", dir]).status, 0);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    for (const name of ["token", "hmac"]) assert.equal(statSync(join(dir, name)).mode & 0o777, 0o600, `${name} has the wrong mode`);
  });
});
