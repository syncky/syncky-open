import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { tempHome } from "../../../agent/test/support/helpers.js";
import { loadState, parseCommand, pollDue, saveState, uuidv7 } from "../agent.mjs";

const AGENT = fileURLToPath(new URL("../agent.mjs", import.meta.url));
const mode = (path) => statSync(path).mode & 0o777;

function run(args, { home, cwd } = {}) {
  const env = { ...process.env };
  delete env.SYNCKY_HOME;
  if (home) env.SYNCKY_HOME = home;
  return spawnSync(process.execPath, [AGENT, ...args], { env, cwd, encoding: "utf8" });
}

function withHome(t) {
  const h = tempHome();
  t.after(h.cleanup);
  return h;
}

describe("argument errors exit 2", () => {
  const cases = [
    [[], /missing command/],
    [["frobnicate"], /unknown command: frobnicate/],
    [["init"], /--relay is required/],
    [["init", "--invite", "dev-invite"], /--relay is required/],
    [["init", "--relay", "ftp://relay.example", "--invite", "x"], /http\(s\) URL/],
    [["init", "--relay", "not a url", "--invite", "x"], /http\(s\) URL/],
    [["init", "--relay", "http://127.0.0.1:8787", "--invite", "x", "--bogus"], /Unknown option '--bogus'/],
    [["init", "--relay", "http://127.0.0.1:8787", "--invite", "x", "extra"], /unexpected arguments/],
    [["init", "--relay", "http://127.0.0.1:8787", "--invite", "x", "--name", "a".repeat(65)], /--name must be 1 to 64 characters/],
    [["init", "--relay", "http://127.0.0.1:8787", "--invite", "x", "--name", "  "], /--name must be 1 to 64 characters/],
    [["init", "--relay", "http://127.0.0.1:8787", "--invite", "x", "--name", "a\nb"], /--name must be 1 to 64 characters/],
    [["pair", "--wait", "0"], /--wait must be a whole number/],
    [["pair", "--wait", "soon"], /--wait must be a whole number/],
    [["pair", "--yes"], /Unknown option '--yes'/],
    [["poll", "--once", "now"], /unexpected arguments/],
    [["send-water", "--to", "m_dev_2"], /unexpected arguments/],
    [["send-water", "0.25"], /--to <member_id> is required/],
    [["send-water", "0.25", "--to", "m_agent_1x"], /--to <member_id> is required/],
    [["send-water", "-1", "--to", "m_dev_2"], /Unknown option '-1'/],
    [["send-water", "1e1", "--to", "m_dev_2"], /must be a decimal number, 0 or more/],
    [["send-water", ".5", "--to", "m_dev_2"], /must be a decimal number, 0 or more/],
    [["send-water", "0.25L", "--to", "m_dev_2"], /must be a decimal number, 0 or more/],
    [["send-water", "9".repeat(400), "--to", "m_dev_2"], /must be a decimal number, 0 or more/],
    [["status", "--verbose"], /Unknown option '--verbose'/],
  ];
  for (const [args, message] of cases) {
    it(`${JSON.stringify(args)}`, (t) => {
      const h = withHome(t);
      const r = run(args, { home: h.home });
      assert.equal(r.status, 2, r.stderr);
      assert.match(r.stderr, message);
      assert.match(r.stderr, /usage: agent\.mjs/);
      assert.equal(r.stdout, "");
      assert.equal(existsSync(h.home), false, "a rejected command must not create state");
    });
  }
});

describe("argument bounds", () => {
  it("parses any non-negative liters, leaving the catalog bounds (min 0, max 100) to the phone, and a 64-character name", () => {
    const water = JSON.parse(readFileSync(new URL("../../../protocol/types.json", import.meta.url), "utf8")).types.find((t) => t.name === "dietary_water");
    assert.deepEqual([water.min, water.max, water.unit], [0, 100, "L"]);
    assert.equal(parseCommand(["send-water", "0", "--to", "m_dev_1"]).values.liters, 0);
    assert.equal(parseCommand(["send-water", "10.0001", "--to", "m_dev_1"]).values.liters, 10.0001);
    assert.equal(parseCommand(["send-water", "250", "--to", "m_dev_1"]).values.liters, 250);
    const name = "n".repeat(64);
    assert.equal(parseCommand(["init", "--relay", "http://127.0.0.1:8787", "--invite", "x", "--name", name]).values.name, name);
  });
});

describe("commands before init exit 3", () => {
  for (const args of [["pair"], ["pair", "--wait", "5"], ["poll", "--once"], ["poll"], ["send-water", "0.25", "--to", "m_dev_2"], ["status"]]) {
    it(`${args.join(" ")}`, (t) => {
      const h = withHome(t);
      const r = run(args, { home: h.home });
      assert.equal(r.status, 3, r.stderr);
      assert.match(r.stderr, /not initialized: run init first/);
      assert.ok(r.stderr.includes(join(h.home, "state.json")));
      assert.equal(existsSync(h.home), false);
    });
  }

  it("defaults SYNCKY_HOME to ./.syncky-minimal in the working directory", (t) => {
    const h = withHome(t);
    const r = run(["status"], { cwd: h.root });
    assert.equal(r.status, 3);
    assert.ok(r.stderr.includes(join(h.root, ".syncky-minimal", "state.json")), r.stderr);
  });

  it("argument errors win over the missing state", (t) => {
    const h = withHome(t);
    assert.equal(run(["send-water", "0.25"], { home: h.home }).status, 2);
  });

  it("a corrupt state file is a local error, not 'not initialized'", (t) => {
    const h = withHome(t);
    mkdirSync(h.home, { mode: 0o700 });
    writeFileSync(join(h.home, "state.json"), "{not json", { mode: 0o600 });
    const r = run(["status"], { home: h.home });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /^error: /);
  });

  it("a corrupt state file prints a fixed error that never quotes the file", (t) => {
    const h = withHome(t);
    const marker = "secret-marker-7f3a9c";
    mkdirSync(h.home, { mode: 0o700 });
    for (const text of [`{"token":"${marker}"`, `{"token":${marker}}`, `${marker}`]) {
      writeFileSync(join(h.home, "state.json"), text, { mode: 0o600 });
      const r = run(["status"], { home: h.home });
      assert.equal(r.status, 1, r.stderr);
      assert.equal(r.stderr, "error: state.json is not valid JSON; restore it or remove it and run init again\n");
      assert.ok(!r.stdout.includes(marker) && !r.stderr.includes(marker));
    }
  });
});

describe("state file", () => {
  it("is written with mode 600 inside a directory with mode 700 and reads back", (t) => {
    const h = withHome(t);
    const state = { relay: "http://127.0.0.1:8787", last_seq: 0 };
    saveState(h.home, state);
    assert.equal(mode(h.home), 0o700);
    assert.equal(mode(join(h.home, "state.json")), 0o600);
    assert.deepEqual(loadState(h.home), state);
    assert.deepEqual(readdirSync(h.home), ["state.json"]);
  });

  it("tightens an existing directory and file that were too open", (t) => {
    const h = withHome(t);
    mkdirSync(h.home, { mode: 0o755 });
    chmodSync(h.home, 0o755);
    writeFileSync(join(h.home, "state.json"), "{}", { mode: 0o644 });
    chmodSync(join(h.home, "state.json"), 0o644);
    saveState(h.home, { last_seq: 7 });
    assert.equal(mode(h.home), 0o700);
    assert.equal(mode(join(h.home, "state.json")), 0o600);
    assert.deepEqual(JSON.parse(readFileSync(join(h.home, "state.json"), "utf8")), { last_seq: 7 });
  });

  it("keeps the modes when the process umask is permissive", (t) => {
    const h = withHome(t);
    const previous = process.umask(0);
    t.after(() => process.umask(previous));
    saveState(join(h.home, "nested"), { last_seq: 1 });
    assert.equal(mode(join(h.home, "nested")), 0o700);
    assert.equal(mode(join(h.home, "nested", "state.json")), 0o600);
  });

  it("refuses a state file that group or others can read, on every command", (t) => {
    const h = withHome(t);
    saveState(h.home, { relay: "http://127.0.0.1:8787", last_seq: 0 });
    chmodSync(join(h.home, "state.json"), 0o644);
    assert.throws(() => loadState(h.home), /state\.json must be private \(chmod 600\)/);
    for (const args of [["status"], ["poll", "--once"], ["pair"], ["init", "--relay", "http://127.0.0.1:9"]]) {
      const r = run(args, { home: h.home });
      assert.equal(r.status, 1, `${args.join(" ")}: ${r.stderr}`);
      assert.match(r.stderr, /^error: state\.json must be private \(chmod 600\)/);
    }
    chmodSync(join(h.home, "state.json"), 0o600);
    assert.deepEqual(loadState(h.home), { relay: "http://127.0.0.1:8787", last_seq: 0 });
  });

  it("loadState returns null when there is no state yet", (t) => {
    const h = withHome(t);
    assert.equal(loadState(h.home), null);
  });

  it("runs through a symlinked bin like npm installs it", (t) => {
    const h = withHome(t);
    const link = join(h.root, "syncky-minimal-agent");
    symlinkSync(AGENT, link);
    const env = { ...process.env, SYNCKY_HOME: h.home };
    const r = spawnSync(link, ["status"], { env, encoding: "utf8" });
    assert.equal(r.status, 3, r.stderr);
  });
});

describe("poll schedule", () => {
  const at = Date.parse("2030-01-01T12:00:00Z");
  const withCommand = (state, minutesAgo) => ({ commands: { c_1: { to: "m_dev_1", version: 1, msg_id: uuidv7(at - minutesAgo * 60_000), state } } });

  it("polls on every sixth 5-minute tick, so every 30 minutes", () => {
    const idle = { commands: {} };
    assert.deepEqual([0, 1, 5, 6, 7, 12].map((tick) => pollDue(idle, tick, at)), [true, false, false, true, false, true]);
  });

  it("polls on every tick while a command sent in the last 15 minutes waits for its result", () => {
    for (const state of ["pending", "sent"]) {
      assert.equal(pollDue(withCommand(state, 14), 1, at), true, state);
      assert.equal(pollDue(withCommand(state, 15), 1, at), false, state);
    }
    assert.equal(pollDue(withCommand("applied", 1), 1, at), false);
  });
});
