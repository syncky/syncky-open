import { it, expect, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import worker from "../../worker/index.js";
import { ownStub, workerRuntime } from "../support/worker-runtime.js";
import { client, check } from "../support/runtime.js";
import { conformance } from "../support/conformance.js";

beforeEach(() => reset());
afterEach(() => vi.restoreAllMocks());
it("Worker+DO replays all request, signature and exchange request vectors", async () => conformance(workerRuntime(), JSON.parse(env.WEBHOOK_VECTORS)));
it("Worker dispatch uses one fixed object with default EU and explicit unrestricted option", async () => {
  for (const jurisdiction of [undefined, "eu", "", "invalid"]) {
    const calls = [];
    const namespace = { jurisdiction(value) { calls.push(value); return this; }, getByName(name) { calls.push(name); return { fetch: async () => Response.json({ ok: true }) }; } };
    const response = await worker.fetch(new Request("https://receiver.example/health"), { OWN_SERVER: namespace, DO_JURISDICTION: jurisdiction });
    expect(response.status).toBe(jurisdiction === "invalid" ? 503 : 200);
    expect(calls).toEqual(jurisdiction === "invalid" ? [] : jurisdiction === "" ? ["own-server"] : ["eu", "own-server"]);
  }
});

it("Worker chunked oversize, aborted stream and thrown SQL errors stay bounded and silent", async () => {
  const runtime = workerRuntime(), b = client(runtime); await b.login();
  const logs = ["log", "error", "warn", "info"].map(name => vi.spyOn(console, name).mockImplementation(() => {}));
  vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("external_network_denied"); });
  const big = new ReadableStream({ start(controller) { for (let n = 0; n < 17; n++) controller.enqueue(new Uint8Array(65536)); controller.close(); } });
  const response = await runtime.send(new Request(runtime.origin + "/server", { method: "POST", headers: { Authorization: "Bearer " + b.token }, body: big }));
  check(response.status === 413 && (await response.json()).code === "payload_too_large", "Worker chunked cap");
  const aborted = new ReadableStream({ pull(controller) { controller.error(new Error("private_body_sentinel")); } }, { highWaterMark: 0 });
  // The local service-binding bridge drops pre-aborted streams before dispatch.
  const stopped = await worker.fetch(new Request(runtime.origin + "/server", { method: "POST", headers: { Authorization: "Bearer " + b.token }, body: aborted }), env);
  const stoppedCode = (await stopped.json()).code;
  check(stopped.status === 400 && stoppedCode === "invalid_body", "Worker body abort safe: " + stopped.status + " " + stoppedCode);
  await runInDurableObject(ownStub(), instance => { instance.sql.run = () => { throw new Error("private_sql_sentinel"); }; });
  const failure = await b.get("/admin");
  check(failure.status === 500 && (await failure.json()).code === "internal", "Worker runtime safe error");
  for (const log of logs) expect(log).not.toHaveBeenCalled();
});

it("Worker storage failure never acknowledges or partially persists an upload", async () => {
  const runtime = workerRuntime(), b = client(runtime); await b.login();
  await runtime.run("CREATE TRIGGER reject_samples BEFORE INSERT ON samples BEGIN SELECT RAISE(ABORT, 'private_storage_sentinel'); END");
  const { response } = await b.upload({ samples: [b.sample()] });
  check(response.status === 500 && (await response.json()).code === "internal", "failed upload not acknowledged");
  expect(await runtime.all("SELECT * FROM upload_targets")).toEqual([]);
  expect(await runtime.all("SELECT * FROM samples")).toEqual([]);
});
