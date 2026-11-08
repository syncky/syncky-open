import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseCommand } from "../agent.mjs";

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(DIR, "../..");
const README = readFileSync(join(DIR, "README.md"), "utf8");

const linkTargets = (markdown) =>
  [...markdown.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]).filter((t) => !/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(t));

describe("README.md", () => {
  it("every relative link resolves", () => {
    const targets = linkTargets(README);
    assert.ok(targets.length >= 4);
    assert.deepEqual(targets.filter((t) => !existsSync(resolve(DIR, decodeURIComponent(t.split("#")[0])))), []);
  });

  it("every repo path in backticks exists", () => {
    const refs = [...README.matchAll(/`((?:scripts|protocol|agent|test)\/[\w./-]*\w)/g)].map((m) => m[1]);
    assert.ok(refs.length >= 4);
    const exists = (ref) => existsSync(join(REPO_ROOT, ref)) || existsSync(join(DIR, ref));
    assert.deepEqual(refs.filter((ref) => !exists(ref)), []);
  });

  it("documents every command and the exit codes", () => {
    for (const command of ["init", "pair", "poll", "send-water", "status"]) {
      assert.throws(() => parseCommand([command, "--no-such-option"]), { exit: 2 });
      assert.ok(README.includes(`./agent.mjs ${command}`), `README misses ${command}`);
    }
    assert.throws(() => parseCommand(["serve"]), /unknown command/);
    assert.match(README, /0 ok, 1 relay or protocol error, 2 bad arguments, 3 not initialized/);
    assert.match(README, /`send-water` does not resend/);
    assert.match(README, /`send-water` posts one command per call/);
    assert.match(README, /burst of up to 60 data envelopes per agent, then about one a minute \(about 60 data envelopes per hour per agent sustained\)/);
    assert.match(README, /per-token limit of 60 requests a minute.*polling, ACKs and heartbeats/);
    assert.match(README, /send several entries in ONE `send` with a `commands` array/);
    assert.match(README, /complete serialized UTF-8 JSON.*base64 ciphertext and recipient metadata/);
    assert.match(README, /inner `commands` JSON.*roughly 191 KiB for one recipient, less with more recipients/);
    assert.match(README, /429 `rate_limited` from either limit.*retried automatically by the outbox after `Retry-After`/);
    assert.match(README, /status --json.*send_lanes.*pending entries/);
  });

  it("links the integration guide and cites no planning documents", () => {
    assert.ok(README.includes("../../agent/AGENTS.md"));
    assert.ok(!README.includes("docs/planning") && !README.includes("C§"));
  });
});
