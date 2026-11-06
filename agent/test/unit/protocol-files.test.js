import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadJson, loadSchemas, loadVectors, protocolDir, protocolPath } from "../../src/protocol-files.js";
import { createValidator } from "../support/validator.js";

const REPO_PROTOCOL = fileURLToPath(new URL("../../../protocol/", import.meta.url));

describe("protocol-files", () => {
  let tmp;
  before(() => {
    tmp = mkdtempSync(join(tmpdir(), "syncky-protocol-"));
    cpSync(join(REPO_PROTOCOL, "schemas"), join(tmp, "schemas"), { recursive: true });
    writeFileSync(join(tmp, "types.json"), "{not json");
    writeFileSync(join(tmp, "units.json"), '{"override":true}');
  });
  after(() => rmSync(tmp, { recursive: true, force: true }));

  it("defaults to the repo protocol directory", () => {
    const dir = protocolDir({});
    assert.equal(fileURLToPath(dir), REPO_PROTOCOL);
    assert.equal(protocolPath("types.json", dir), join(REPO_PROTOCOL, "types.json"));
  });

  it("honors SYNCKY_PROTOCOL_DIR with or without a trailing slash", () => {
    for (const value of [tmp, `${tmp}/`]) {
      const dir = protocolDir({ SYNCKY_PROTOCOL_DIR: value });
      assert.equal(protocolPath("types.json", dir), join(tmp, "types.json"));
    }
  });

  it("loads vectors by name with or without the .json suffix", () => {
    assert.deepEqual(loadVectors("fingerprints"), loadVectors("fingerprints.json"));
    assert.equal(loadVectors("keys").agent.member_id, "m_agent_1");
  });

  it("reports a missing file and invalid JSON by relative path", () => {
    const dir = protocolDir({ SYNCKY_PROTOCOL_DIR: tmp });
    assert.throws(() => loadJson("test-vectors/keys.json", dir), /protocol file not readable: test-vectors\/keys\.json \(ENOENT\)/);
    assert.throws(() => loadJson("types.json", dir), /protocol file is not valid JSON: types\.json/);
  });

  it("reads explicit filesystem contents and returns a fresh object on every load", () => {
    const dir = protocolDir({ SYNCKY_PROTOCOL_DIR: tmp });
    const first = loadJson("units.json", dir);
    assert.deepEqual(first, { override: true });
    first.override = false;
    assert.deepEqual(loadJson("units.json", dir), { override: true });
    const defaults = loadJson("units.json");
    defaults.families.length = 0;
    assert.ok(loadJson("units.json").families.length > 0);
  });

  it("reports an explicit missing schema directory without falling back", () => {
    const dir = protocolDir({ SYNCKY_PROTOCOL_DIR: join(tmp, "missing") });
    assert.throws(() => loadSchemas(dir), { code: "ENOENT" });
  });

  it("loads every schema in a stable order and compiles them from another directory", async () => {
    const dir = protocolDir({ SYNCKY_PROTOCOL_DIR: tmp });
    const schemas = loadSchemas(dir);
    assert.deepEqual(
      schemas.map((s) => s.$id.split("/").pop()),
      [
        "envelope.schema.json",
        "inner-commands.schema.json",
        "inner-diagnostics.schema.json",
        "inner-sync.schema.json",
        "inner-system.schema.json",
        "messages.schema.json",
        "system-event.schema.json",
        "test-vectors.schema.json",
        "types.schema.json",
        "units.schema.json",
      ],
    );
    const validator = await createValidator({ dir });
    const result = validator.validate("inner-commands.schema.json", "commands", { v: 1, type: "commands", commands: [] });
    assert.equal(result.ok, true);
    const bad = validator.validate("inner-commands.schema.json", "commands", { v: 2 });
    assert.equal(bad.ok, false);
    assert.ok(bad.errors.length >= 1);
    const messages = loadJson("messages.json");
    assert.equal(validator.validate("messages.schema.json", "messages_file", messages).ok, true);
    messages.default.kind = "data";
    assert.equal(validator.validate("messages.schema.json", "messages_file", messages).ok, false);
  });

  it("formats root-level errors with a slash path", async () => {
    const validator = await createValidator();
    const result = validator.validate("types.schema.json", "types_file", []);
    assert.equal(result.ok, false);
    assert.ok(result.errors.every((e) => e.startsWith("/ ")), result.errors.join("\n"));
  });
});
