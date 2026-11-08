import { it, beforeEach, afterEach, vi, expect } from "vitest";
import { reset, runInDurableObject } from "cloudflare:test";
import { workerRuntime, ownStub } from "../support/worker-runtime.js";
import { flow, lostReply, authorization } from "../support/runtime.js";
import { largeGrants, boundedReads, guardPayloadReads, renewedCommands, activityDates } from "../support/review.js";
import { loginAvailability, registrationAvailability, codeReplay } from "../support/oauth-review.js";

let logs;
beforeEach(async () => {
  await reset();
  vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("external_network_denied"); });
  logs = ["log", "error", "warn", "info", "debug", "trace"].map(name => vi.spyOn(console, name).mockImplementation(() => {}));
});
afterEach(() => { try { for (const log of logs) expect(log).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); } });
for (const manual of [false, true]) it("Worker+DO full flow with " + (manual ? "manual confidential" : "DCR public") + " client and no external egress", async () => flow(workerRuntime(), manual));
for (const action of ["revoke", "disable"]) it("Worker lost reply, " + action + ", DO eviction and late results", async () => lostReply(workerRuntime(), action));
it("Worker real routes enforce canonical origin, OAuth isolation, PKCE and rotation", async () => authorization(workerRuntime()));
it("Worker login remains available with a spent failed-login bucket", async () => loginAvailability(workerRuntime()));
it("Worker manual clients retain bounded capacity under DCR exhaustion", async () => registrationAvailability(workerRuntime()));
it("Worker code replay revokes the issued token family after DO restart", async () => codeReplay(workerRuntime()));
it("Worker status supports all 128 consented types within DO SQL limits", async () => largeGrants(workerRuntime()));
it("Worker query and export bound payload allocation before serialization", async () => boundedReads(workerRuntime(), () => runInDurableObject(ownStub(), instance => guardPayloadReads(instance.sql))));
it("Worker renewed consent can version completed own commands without reviving cancelled work", async () => renewedCommands(workerRuntime()));
it("Worker activity queries use persisted calendar dates and characteristics use receipt time", async () => activityDates(workerRuntime()));
