import { it } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { dockerRuntime } from "../support/docker-runtime.js";
import { lostReply, authorization, client, check } from "../support/runtime.js";
import { startServer } from "../../docker/server.js";
import { conformance, representativeVectors } from "../support/conformance.js";
import { boundedReads, guardPayloadReads } from "../support/review.js";
import { codeReplay } from "../support/oauth-review.js";

for (const action of ["revoke", "disable"]) it("Node lost reply, " + action + ", real DB restart and late results", async t => lostReply(await dockerRuntime(t), action));
it("Node real routes enforce canonical origin, OAuth isolation, PKCE and rotation", async t => authorization(await dockerRuntime(t)));
it("Node code replay revokes the issued token family after listener restart", async t => codeReplay(await dockerRuntime(t)));
it("Node query and export bound payload allocation before serialization", async t => {
  const runtime = await dockerRuntime(t);
  await boundedReads(runtime, () => guardPayloadReads(runtime.active.sql));
});
it("Node HTTP accepts a signed native upload and rejects a bad signature", async t => {
  await conformance(await dockerRuntime(t), representativeVectors(name =>
    JSON.parse(readFileSync(new URL("../../../../protocol/test-vectors/webhook-" + name + ".json", import.meta.url))).cases));
});

it("Node completes the confidential-client flow and reports failures without emitting secrets", () => {
  const code = [
    "import { dockerRuntime } from './test/support/docker-runtime.js';",
    "import { flow, client } from './test/support/runtime.js';",
    "const cleanups = [];",
    "globalThis.fetch = () => { throw new Error('external_network_denied'); };",
    "const runtime = await dockerRuntime({ after: f => cleanups.push(f) });",
    "try { await flow(runtime, true); const b = client(runtime); await b.login(); runtime.active.sql.close(); const failed = await b.get('/admin'); if (failed.status !== 500 || (await failed.json()).code !== 'internal') throw new Error('unsafe_error'); } finally { for (const cleanup of cleanups) await cleanup(); }",
  ].join("\n");
  const child = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", code], { cwd: new URL("../../", import.meta.url), encoding: "utf8" });
  assert.ok(child.status === 0, "Node secrecy subprocess passed");
  assert.ok(child.stdout === "" && child.stderr === "", "no output from normal or exceptional flows");
});

it("Node SQLite upload rollback survives a real listener restart", async t => {
  const runtime = await dockerRuntime(t), b = client(runtime); await b.login();
  runtime.run("CREATE TRIGGER reject_samples BEFORE INSERT ON samples BEGIN SELECT RAISE(ABORT, 'private_storage_sentinel'); END");
  const { response } = await b.upload({ samples: [b.sample()] });
  check(response.status === 500 && (await response.json()).code === "internal", "Node failed upload not acknowledged");
  await runtime.restart();
  assert.equal(runtime.all("SELECT * FROM upload_targets").length, 0);
  assert.equal(runtime.all("SELECT * FROM samples").length, 0);
});

it("Node refuses missing/invalid public configuration before listening", async () => {
  for (const publicUrl of [undefined, "http://public.example", "https://receiver.example/path", "https://receiver.example/?secret=ignored"]) await assert.rejects(startServer({ publicUrl, adminPassword: "unused" }), /invalid_configuration/);
  await assert.rejects(startServer({ publicUrl: "https://receiver.example" }), /invalid_configuration/);
});

it("Node caps chunked bodies per route, handles aborts and continues serving", async t => {
  const runtime = await dockerRuntime(t);
  for (const [path, cap] of [["/server", 1_000_000], ["/mcp", 65_536], ["/oauth/register", 16_384]]) {
    const response = await new Promise((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: runtime.active.port, method: "POST", path, headers: { Host: "receiver.example", "Content-Type": "application/json" } }, res => {
        let body = ""; res.on("data", chunk => { body += chunk; }); res.on("end", () => resolve({ status: res.statusCode, body }));
      });
      req.on("error", reject);
      for (let n = 0; n <= cap; n += 8192) req.write("x".repeat(8192));
      req.end();
    });
    assert.equal(response.status, 413);
    assert.equal(JSON.parse(response.body).code, "payload_too_large");
  }
  const accepted = once(runtime.active.server, "request");
  await new Promise(resolve => {
    const req = request({ host: "127.0.0.1", port: runtime.active.port, method: "POST", path: "/server", headers: { Host: "receiver.example", "Content-Length": 1000 } });
    req.on("error", () => {}); req.on("close", resolve);
    req.write("partial"); accepted.then(() => req.destroy());
  });
  const health = await runtime.send(new Request(runtime.origin + "/health"));
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);
});

it("Node runtime failures and malformed targets return fixed errors without logging", async t => {
  const runtime = await dockerRuntime(t);
  const messages = [];
  for (const name of ["log", "error", "warn", "info"]) t.mock.method(console, name, (...values) => messages.push(values));
  const b = client(runtime); await b.login();
  for (const path of [runtime.origin + "/admin", "//receiver.example/admin"]) {
    const rejected = await new Promise((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: runtime.active.port, path, headers: { Host: "receiver.example" } }, res => {
        let body = ""; res.on("data", chunk => { body += chunk; }); res.on("end", () => resolve({ status: res.statusCode, body }));
      });
      req.on("error", reject); req.end();
    });
    check(rejected.status === 400 && JSON.parse(rejected.body).code === "invalid_target", "Node malformed target safe");
  }
  runtime.active.sql.close();
  const response = await b.get("/admin");
  check(response.status === 500 && (await response.json()).code === "internal", "Node safe SQL failure");
  assert.equal(messages.length, 0);
});
