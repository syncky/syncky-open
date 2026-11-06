import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  CONFIG_DEFAULTS,
  CONFIG_FILE,
  LocalStateError,
  agentHome,
  ensureHome,
  isLoopbackHost,
  loadConfig,
  loadConfigFile,
  readJsonFile,
  resolveConfig,
  saveConfig,
  writeFileAtomic,
} from "../../src/config.js";
import { tempHome } from "../support/helpers.js";

const mode = (p) => fs.statSync(p).mode & 0o777;

function failThrow(method) {
  throw Object.assign(new Error(`${method} failed`), { code: "EIO" });
}

const failingFs = (method) => ({ ...fs, [method]: () => failThrow(method) });

describe("config", () => {
  let t;
  beforeEach(() => {
    t = tempHome();
  });
  afterEach(() => t.cleanup());

  describe("agentHome", () => {
    it("prefers the flag, then SYNCKY_AGENT_HOME, then ~/.syncky-agent", () => {
      assert.equal(agentHome({ flags: { home: "/a" }, env: { SYNCKY_AGENT_HOME: "/b" } }), "/a");
      assert.equal(agentHome({ flags: {}, env: { SYNCKY_AGENT_HOME: "/b" } }), "/b");
      assert.equal(agentHome({ env: { SYNCKY_AGENT_HOME: "" } }), join(homedir(), ".syncky-agent"));
      assert.equal(agentHome({ env: {} }), join(homedir(), ".syncky-agent"));
    });
  });

  describe("ensureHome", () => {
    it("creates the home with mode 0700 even under a permissive umask", () => {
      const old = process.umask(0o000);
      try {
        ensureHome(t.home);
      } finally {
        process.umask(old);
      }
      assert.ok(fs.statSync(t.home).isDirectory());
      assert.equal(mode(t.home), 0o700);
    });

    it("tightens an existing empty directory with broader permissions", () => {
      fs.mkdirSync(t.home, { mode: 0o755 });
      fs.chmodSync(t.home, 0o755);
      ensureHome(t.home);
      assert.equal(mode(t.home), 0o700);
    });

    it("accepts an existing 0700 directory with content untouched", () => {
      fs.mkdirSync(t.home, { mode: 0o700 });
      fs.chmodSync(t.home, 0o700);
      fs.writeFileSync(join(t.home, "x"), "1");
      assert.equal(ensureHome(t.home), t.home);
      assert.equal(fs.readFileSync(join(t.home, "x"), "utf8"), "1");
    });

    it("refuses a non-empty directory with broader permissions", () => {
      fs.mkdirSync(t.home);
      fs.chmodSync(t.home, 0o755);
      fs.writeFileSync(join(t.home, "secrets.json"), "{}");
      assert.throws(() => ensureHome(t.home), (err) => err instanceof LocalStateError && err.code === "insecure_permissions");
      assert.equal(mode(t.home), 0o755);
    });

    it("refuses a path that is a file", () => {
      fs.writeFileSync(t.home, "");
      assert.throws(() => ensureHome(t.home), { code: "insecure_permissions" });
    });

    it("rethrows stat errors other than ENOENT", () => {
      const fakeFs = { ...fs, statSync: () => failThrow("statSync") };
      assert.throws(() => ensureHome(t.home, { fs: fakeFs }), { code: "EIO" });
    });
  });

  describe("writeFileAtomic", () => {
    beforeEach(() => ensureHome(t.home));

    it("writes with mode 0600 and leaves no temp file", () => {
      const p = join(t.home, "f.json");
      const old = process.umask(0o000);
      try {
        writeFileAtomic(p, "hello");
      } finally {
        process.umask(old);
      }
      assert.equal(fs.readFileSync(p, "utf8"), "hello");
      assert.equal(mode(p), 0o600);
      assert.deepEqual(fs.readdirSync(t.home), ["f.json"]);
    });

    it("writes bytes and replaces existing content", () => {
      const p = join(t.home, "f.bin");
      writeFileAtomic(p, "old");
      writeFileAtomic(p, new Uint8Array([104, 105]));
      assert.equal(fs.readFileSync(p, "utf8"), "hi");
    });

    for (const method of ["writeSync", "fsyncSync", "renameSync", "fchmodSync"]) {
      it(`keeps the old content and removes the temp file when ${method} throws`, () => {
        const p = join(t.home, "f.json");
        writeFileAtomic(p, "old");
        assert.throws(() => writeFileAtomic(p, "new", { fs: failingFs(method) }), { code: "EIO" });
        assert.equal(fs.readFileSync(p, "utf8"), "old");
        assert.deepEqual(fs.readdirSync(t.home), ["f.json"]);
      });
    }

    it("still reports the original error when closing the temp file also fails", () => {
      const p = join(t.home, "f.json");
      const fakeFs = { ...fs, writeSync: () => failThrow("writeSync"), closeSync: (fd) => { fs.closeSync(fd); failThrow("closeSync"); } };
      assert.throws(() => writeFileAtomic(p, "new", { fs: fakeFs }), /writeSync failed/);
      assert.deepEqual(fs.readdirSync(t.home), []);
    });

    it("reports the open error when the temp file cannot be created", () => {
      assert.throws(() => writeFileAtomic(join(t.root, "missing", "f.json"), "x"), { code: "ENOENT" });
    });
  });

  describe("readJsonFile", () => {
    beforeEach(() => ensureHome(t.home));

    it("returns null for a missing file", () => {
      assert.equal(readJsonFile(join(t.home, "nope.json")), null);
    });

    it("rejects invalid JSON and non-objects with corrupt_state", () => {
      const p = join(t.home, "c.json");
      for (const body of ["{", "[]", "null", "3"]) {
        fs.writeFileSync(p, body);
        assert.throws(() => readJsonFile(p), { code: "corrupt_state" });
      }
    });

    it("rethrows read errors other than ENOENT", () => {
      assert.throws(() => readJsonFile(t.home), { code: "EISDIR" });
    });
  });

  describe("resolveConfig", () => {
    it("bounds cadence to whole seconds from 300 through 86400 in every source", () => {
      for (const value of [300, 86400]) {
        assert.equal(resolveConfig({ env: {}, file: { poll_interval_s: value } }).poll_interval_s, value);
      }
      for (const value of [null, 86401, Number.MAX_SAFE_INTEGER, "1e3", "+300", " 300", "300.0"]) {
        for (const source of [{ flags: { poll_interval_s: value } }, { file: { poll_interval_s: value } }, { env: { SYNCKY_POLL_INTERVAL_S: value } }]) {
          assert.throws(() => resolveConfig({ env: {}, ...source }), { code: "invalid_config" });
        }
      }
    });
    it("uses defaults when nothing is set", () => {
      assert.deepEqual(resolveConfig({ env: {} }), { ...CONFIG_DEFAULTS });
    });

    it("defaults the relay to production and lets the flag or the env pick another env", () => {
      assert.equal(CONFIG_DEFAULTS.relay_url, "https://relay.syncky.app");
      assert.equal(resolveConfig({ env: {} }).relay_url, "https://relay.syncky.app");
      assert.equal(resolveConfig({ env: { SYNCKY_RELAY_URL: "https://relay-staging.syncky.app" } }).relay_url, "https://relay-staging.syncky.app");
      assert.equal(resolveConfig({ env: {}, flags: { relay_url: "https://relay-dev.syncky.app" } }).relay_url, "https://relay-dev.syncky.app");
    });

    it("applies precedence flag > env > config file > default per key", () => {
      const file = { relay_url: "https://file", name: "file-name", poll_interval_s: 3600, heartbeat: "off" };
      const env = { SYNCKY_RELAY_URL: "https://env", SYNCKY_AGENT_NAME: "env-name", SYNCKY_POLL_INTERVAL_S: "600" };
      const flags = { relay_url: "https://flag" };
      const cfg = resolveConfig({ flags, env, file });
      assert.equal(cfg.relay_url, "https://flag");
      assert.equal(cfg.name, "env-name");
      assert.equal(cfg.poll_interval_s, 600);
      assert.equal(cfg.heartbeat, "off");
    });

    it("ignores empty env values and undefined flags", () => {
      const cfg = resolveConfig({ flags: { name: undefined }, env: { SYNCKY_AGENT_NAME: "" }, file: { name: "file" } });
      assert.equal(cfg.name, "file");
    });

    it("lets an explicit null in the file clear a value", () => {
      assert.equal(resolveConfig({ env: {}, file: { name: null } }).name, null);
    });

    it("refuses a poll interval under 300 s from the env and the file too, naming the relay's limit", () => {
      for (const source of [{ env: { SYNCKY_POLL_INTERVAL_S: "60" } }, { env: {}, file: { poll_interval_s: 30 } }]) {
        assert.throws(() => resolveConfig(source), (e) => e.code === "invalid_config" && /at least 300/.test(e.message));
      }
    });

    it("coerces numeric strings and rejects bad numbers", () => {
      assert.equal(resolveConfig({ env: { SYNCKY_POLL_INTERVAL_S: "300" } }).poll_interval_s, 300);
      assert.equal(resolveConfig({ env: {}, file: { poll_interval_s: 3600 } }).poll_interval_s, 3600);
      for (const [key, value] of [
        ["poll_interval_s", "0"],
        ["poll_interval_s", "299"],
        ["poll_interval_s", "abc"],
        ["poll_interval_s", 2.5],
      ]) {
        assert.throws(() => resolveConfig({ env: {}, flags: { [key]: value } }), { code: "invalid_config" }, `${key}=${value}`);
      }
    });

    it("ignores obsolete fields and environment controls without rewriting old config bytes", () => {
      const original = '{"name":"old","ui_port":-1,"command_interval_s":"obsolete","webhook_url":"retained"}';
      ensureHome(t.home); fs.writeFileSync(join(t.home, CONFIG_FILE), original, { mode: 0o600 });
      const cfg = loadConfig(t.home, { env: { SYNCKY_COMMAND_INTERVAL_S: 'bad', SYNCKY_UI_PORT: 'bad' } });
      assert.equal(cfg.name, 'old'); assert.equal(Object.hasOwn(cfg, 'ui_port'), false);
      assert.equal(fs.readFileSync(join(t.home, CONFIG_FILE), 'utf8'), original);
    });

    it("heartbeat defaults to on, takes on/off or a boolean, and the env wins over the file", () => {
      assert.equal(CONFIG_DEFAULTS.heartbeat, "on");
      assert.equal(resolveConfig({ env: {} }).heartbeat, "on");
      assert.equal(resolveConfig({ env: { SYNCKY_HEARTBEAT: "off" }, file: { heartbeat: "on" } }).heartbeat, "off");
      for (const [value, expected] of [["off", "off"], ["on", "on"], [false, "off"], [true, "on"]]) {
        assert.equal(resolveConfig({ env: {}, file: { heartbeat: value } }).heartbeat, expected, String(value));
      }
      for (const value of ["no", "OFF", "", 0, null]) {
        assert.throws(() => resolveConfig({ env: {}, file: { heartbeat: value } }), { code: "invalid_config" }, String(value));
      }
      assert.throws(() => resolveConfig({ env: { SYNCKY_HEARTBEAT: "false" } }), { code: "invalid_config" });
    });

    it("rejects non-string values for string keys", () => {
      assert.throws(() => resolveConfig({ env: {}, file: { relay_url: 42 } }), { code: "invalid_config" });
    });
  });

  describe("load/save", () => {
    beforeEach(() => ensureHome(t.home));

    it("round-trips config.json atomically with mode 0600 and drops unknown keys", () => {
      const doc = saveConfig(t.home, { relay_url: "https://relay.example", name: "box", poll_interval_s: 3600, extra: "x" });
      assert.deepEqual(doc, { relay_url: "https://relay.example", name: "box", poll_interval_s: 3600 });
      const p = join(t.home, CONFIG_FILE);
      assert.equal(mode(p), 0o600);
      assert.deepEqual(loadConfigFile(t.home), doc);
      const cfg = loadConfig(t.home, { env: { SYNCKY_AGENT_NAME: "env" }, flags: { poll_interval_s: 600 } });
      assert.equal(cfg.relay_url, "https://relay.example");
      assert.equal(cfg.name, "env");
      assert.equal(cfg.poll_interval_s, 600);
    });

    it("writes the heartbeat setting normalized", () => {
      assert.deepEqual(saveConfig(t.home, { name: "box", heartbeat: false }), { name: "box", heartbeat: "off" });
      assert.equal(loadConfig(t.home, { env: {} }).heartbeat, "off");
    });

    it("loads defaults when config.json is missing", () => {
      assert.deepEqual(loadConfigFile(t.home), {});
      assert.deepEqual(loadConfig(t.home, { env: {} }), { ...CONFIG_DEFAULTS });
    });

    it("validates values before writing", () => {
      assert.throws(() => saveConfig(t.home, { poll_interval_s: 1e6 }), { code: "invalid_config" });
      assert.deepEqual(fs.readdirSync(t.home), []);
    });
  });
});

describe("URL scheme configuration", () => {
  it("keeps unset and null overrides nullable, and ignores an empty environment variable", () => {
    assert.equal(CONFIG_DEFAULTS.url_scheme, null);
    assert.equal(resolveConfig({ env: {} }).url_scheme, null);
    assert.equal(resolveConfig({ env: {}, file: { url_scheme: null } }).url_scheme, null);
    assert.equal(resolveConfig({ env: { SYNCKY_URL_SCHEME: "" }, file: { url_scheme: "syncky-dev" } }).url_scheme, "syncky-dev");
    assert.throws(() => resolveConfig({ env: {}, flags: { url_scheme: null } }), { code: "invalid_url_scheme" });
    assert.throws(() => resolveConfig({ env: { SYNCKY_URL_SCHEME: null } }), { code: "invalid_url_scheme" });
  });

  it("selects flag over environment over file without inferring from the relay", () => {
    const file = { url_scheme: "syncky", relay_url: "https://relay-dev.syncky.app" };
    const env = { SYNCKY_URL_SCHEME: "syncky-staging" };
    assert.equal(resolveConfig({ flags: { url_scheme: "syncky-dev" }, env, file }).url_scheme, "syncky-dev");
    assert.equal(resolveConfig({ env, file }).url_scheme, "syncky-staging");
    assert.equal(resolveConfig({ env: {}, file }).url_scheme, "syncky");
    assert.equal(resolveConfig({ env: {}, file: { relay_url: file.relay_url } }).url_scheme, null);
  });

  it("rejects invalid selected overrides with a fixed error and validates before saving", () => {
    const t = tempHome();
    try {
      ensureHome(t.home);
      for (const value of ["", "auto", "syncky://", "Syncky", "syncky-dev ", "syncky-staging-extra", 1, true, [], {}]) {
        for (const source of ["flags", "file", ...(value === "" ? [] : ["env"])]) {
          const input = source === "env" ? { env: { SYNCKY_URL_SCHEME: value } } : { env: {}, [source]: { url_scheme: value } };
          assert.throws(() => resolveConfig(input), { code: "invalid_url_scheme", message: "url scheme must be syncky, syncky-dev or syncky-staging" });
        }
        assert.throws(() => saveConfig(t.home, { url_scheme: value }), { code: "invalid_url_scheme" });
        assert.deepEqual(fs.readdirSync(t.home), []);
      }
      for (const value of [null, "syncky", "syncky-dev", "syncky-staging"]) {
        saveConfig(t.home, { url_scheme: value });
        assert.equal(loadConfig(t.home, { env: {} }).url_scheme, value);
      }
    } finally {
      t.cleanup();
    }
  });
});

describe("isLoopbackHost", () => {
  it("accepts localhost, 127.x.y.z and ::1, and nothing else", () => {
    for (const host of ["localhost", "LOCALHOST", "localhost.", "127.0.0.1", "127.1.2.3", "127.255.255.255", "::1", "[::1]"]) {
      assert.equal(isLoopbackHost(host), true, host);
    }
    for (const host of ["0.0.0.0", "::", "[::]", "192.168.1.10", "10.0.0.1", "relay.test", "127.1", "127.0.0.256", "128.0.0.1", "::ffff:127.0.0.1",
      "0:0:0:0:0:0:0:1", "fe80::1%lo0", "localhost.example", "", null, undefined]) {
      assert.equal(isLoopbackHost(host), false, String(host));
    }
  });
});
