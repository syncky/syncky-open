import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";

import { SCHEMA_ID_BASE, loadSchemas, protocolPath } from "../../src/protocol-files.js";
import { loadJson, loadVectors } from "../support/protocol-files.js";
import { createValidator } from "../support/validator.js";

const FILE_DEFS = {
  "types.json": ["types.schema.json", "types_file"],
  "units.json": ["units.schema.json", "units_file"],
  "messages.json": ["messages.schema.json", "messages_file"],
  "test-vectors/rfc9180-auth-x25519-sha256-chacha20poly1305.json": ["test-vectors.schema.json", "rfc9180_file"],
  "test-vectors/keys.json": ["test-vectors.schema.json", "keys_file"],
  "test-vectors/envelopes.json": ["test-vectors.schema.json", "envelopes_file"],
  "test-vectors/envelopes-negative.json": ["test-vectors.schema.json", "envelopes_negative_file"],
  "test-vectors/envelope-shape.json": ["test-vectors.schema.json", "envelope_shape_file"],
  "test-vectors/inner-messages.json": ["test-vectors.schema.json", "inner_messages_file"],
  "test-vectors/series-parts.json": ["test-vectors.schema.json", "series_parts_file"],
  "test-vectors/fingerprints.json": ["test-vectors.schema.json", "fingerprints_file"],
  "test-vectors/pair-uris.json": ["test-vectors.schema.json", "pair_uris_file"],
  "test-vectors/pair-codes.json": ["test-vectors.schema.json", "pair_codes_file"],
  "test-vectors/app-attest-client-data.json": ["test-vectors.schema.json", "app_attest_client_data_file"],
  "test-vectors/webhook-signatures.json": ["test-vectors.schema.json", "webhook_signatures_file"],
  "test-vectors/webhook-requests.json": ["test-vectors.schema.json", "webhook_requests_file"],
  "test-vectors/webhook-exchanges.json": ["test-vectors.schema.json", "webhook_exchanges_file"],
  "test-vectors/bridge-json.json": ["test-vectors.schema.json", "bridge_json_file"],
  "test-vectors/command-policy.json": ["test-vectors.schema.json", "command_policy_file"],
};

const SUBSCHEMA = new Set([
  "not", "if", "then", "else", "items", "contains", "additionalProperties", "propertyNames",
  "unevaluatedItems", "unevaluatedProperties", "additionalItems",
]);
const SUBSCHEMA_ARRAY = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const SUBSCHEMA_MAP = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);

function formatKeywordPointers(schema, pointer = "") {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) return [];
  const found = [];
  for (const [key, value] of Object.entries(schema)) {
    const here = `${pointer}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
    if (key === "format") found.push(here);
    if (SUBSCHEMA.has(key)) {
      if (Array.isArray(value)) value.forEach((s, i) => found.push(...formatKeywordPointers(s, `${here}/${i}`)));
      else found.push(...formatKeywordPointers(value, here));
    } else if (SUBSCHEMA_ARRAY.has(key) && Array.isArray(value)) {
      value.forEach((s, i) => found.push(...formatKeywordPointers(s, `${here}/${i}`)));
    } else if (SUBSCHEMA_MAP.has(key) && value && typeof value === "object") {
      for (const [name, s] of Object.entries(value)) {
        found.push(...formatKeywordPointers(s, `${here}/${name.replaceAll("~", "~0").replaceAll("/", "~1")}`));
      }
    }
  }
  return found;
}

describe("protocol files validate against protocol/schemas", () => {
  let validator;
  before(async () => {
    validator = await createValidator();
  });

  it("every listed protocol file exists and every vector file has a schema mapping", () => {
    const present = readdirSync(protocolPath("test-vectors/")).filter((f) => f.endsWith(".json")).sort();
    assert.deepEqual(present, Object.keys(FILE_DEFS).filter(f => f.startsWith("test-vectors/")).map(f => f.slice("test-vectors/".length)).sort());
    for (const f of present) assert.ok(FILE_DEFS[`test-vectors/${f}`], `no schema mapping for ${f}`);
  });

  for (const [file, [schemaFile, def]] of Object.entries(FILE_DEFS)) {
    it(`${file} validates against ${schemaFile}#/$defs/${def}`, () => {
      const result = validator.validate(schemaFile, def, loadJson(file));
      assert.deepEqual(result.errors, []);
      assert.equal(result.ok, true);
    });
  }

  it("a broken vector copy fails with an error naming the path and the problem", () => {
    const broken = structuredClone(loadVectors("fingerprints"));
    delete broken.cases[1].fingerprint;
    broken.cases[2].sha256_hex = 42;
    const result = validator.validate("test-vectors.schema.json", "fingerprints_file", broken);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.startsWith("/cases/1 ") && e.includes("fingerprint")), result.errors.join("\n"));
    assert.ok(result.errors.some((e) => e.startsWith("/cases/2/sha256_hex ")), result.errors.join("\n"));
  });

  it("bridge fixtures allow only explicit webhook mirror kinds", () => {
    const file = structuredClone(loadVectors("bridge-json"));
    file.cases = [file.cases[0]];
    for (const kind of ["webhook_url_policy", "webhook_link_preview", "webhook_save_result", "webhook_delivery_report"]) {
      file.cases[0].kind = kind;
      assert.equal(validator.validate("test-vectors.schema.json", "bridge_json_file", file).ok, true);
    }
    for (const kind of ["webhook_other", "webhook_url_policy_extra", "webhook_link_preview_extra", "webhook_delivery_report_extra"]) {
      file.cases[0].kind = kind;
      assert.equal(validator.validate("test-vectors.schema.json", "bridge_json_file", file).ok, false);
    }
  });

  it("summary vector inputs are native-only, strict, and separately counted", () => {
    const file = structuredClone(loadVectors("webhook-requests"));
    const c = file.cases.find((x) => x.format === "native" && x.requests.length > 0);
    file.cases = [c];
    c.resend = true;
    c.summaries = [{ type: "steps", unit: "count", start: "2024-01-01T00:00:00Z", end: "2024-01-02T00:00:00Z", stat: "sum", value: 0 }];
    c.requests[0].groups = [];
    c.requests[0].summaries = 1;
    c.report.summaries = 1;
    const valid = () => validator.validate("test-vectors.schema.json", "webhook_requests_file", file).ok;
    assert.equal(valid(), true);
    c.summaries[0].extra = true;
    assert.equal(valid(), false);
    delete c.summaries[0].extra;
    c.summaries[0].stat = "min";
    assert.equal(valid(), false);
    c.summaries[0].stat = "avg";
    c.format = "csv";
    assert.equal(valid(), false);
    c.format = "native";
    c.requests[0].summaries = 0;
    assert.equal(valid(), false);
  });

  it("a broken types.json copy fails", () => {
    const broken = structuredClone(loadJson("types.json"));
    const water = broken.types.find((t) => t.name === "dietary_water");
    delete water.max;
    const result = validator.validate("types.schema.json", "types_file", broken);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.includes("max")), result.errors.join("\n"));
  });

  it("types.json carries the read-only object kinds and the workout enums, and the schema guards them", () => {
    const doc = loadJson("types.json");
    const objectKinds = doc.types.filter((t) => !["quantity", "category"].includes(t.kind));
    assert.deepEqual(
      objectKinds.map((t) => t.name).sort(),
      ["activity_summary", "audiogram", "gad7_assessment", "heartbeat_series", "phq9_assessment", "state_of_mind", "workout_route"],
    );
    for (const t of objectKinds) assert.equal(t.write, false, t.name);
    assert.deepEqual(Object.keys(doc.workout.enums), ["event_type", "location", "swimming_location"]);
    const mutations = [
      (d) => { d.types.find((t) => t.name === "state_of_mind").write = true; },
      (d) => { delete d.types.find((t) => t.name === "workout_route").enums; },
      (d) => { d.types.find((t) => t.name === "audiogram").enums.side = []; },
      (d) => { d.types.find((t) => t.name === "audiogram").kind = "electrocardiogram"; },
      (d) => { delete d.workout.enums; },
    ];
    for (const mutate of mutations) {
      const broken = structuredClone(doc);
      mutate(broken);
      assert.equal(validator.validate("types.schema.json", "types_file", broken).ok, false, mutate.toString());
    }
  });

  it("an unknown schema ref throws", () => {
    assert.throws(() => validator.validate("types.schema.json", "no_such_def", {}), /unknown schema ref/);
  });
});

describe("schemas use no format keyword", () => {
  it("no schema has format in keyword position", () => {
    const schemas = loadSchemas();
    assert.deepEqual(schemas.map((schema) => schema.$id).sort(), [
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
    ].map((file) => SCHEMA_ID_BASE + file).sort());
    for (const schema of schemas) assert.deepEqual(formatKeywordPointers(schema), [], schema.$id);
  });

  it("format as a property name or as data is allowed", () => {
    assert.deepEqual(formatKeywordPointers({ properties: { format: {} }, required: ["format"] }), []);
    assert.deepEqual(
      formatKeywordPointers({
        type: "object",
        properties: { a: { enum: ["format"], const: { format: "x" }, examples: [{ format: 1 }], default: { format: "y" } } },
      }),
      [],
    );
  });

  it("format as a keyword is flagged wherever a subschema sits", () => {
    assert.deepEqual(formatKeywordPointers({ type: "string", format: "date-time" }), ["/format"]);
    assert.deepEqual(
      formatKeywordPointers({
        $defs: { a: { type: "array", items: { format: "uri" } } },
        oneOf: [{ type: "string" }, { format: "email" }],
        properties: { format: { type: "string", format: "date" } },
        if: { not: { format: "x" } },
      }).sort(),
      ["/$defs/a/items/format", "/if/not/format", "/oneOf/1/format", "/properties/format/format"],
    );
  });
});
