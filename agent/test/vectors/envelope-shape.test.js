import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { validateEnvelopeShape, validateEnvelopeText } from "../support/envelope.js";
import { loadVectors } from "../../src/protocol-files.js";

const { cases } = loadVectors("envelope-shape");
const base = cases.find((c) => c.name === "valid_one_recipient").envelope;
const CALLER = "m_dev_1";
const ACTIVE = ["m_agent_1", "m_dev_1", "m_dev_2"];

const withRecipients = (ids) => ({
  ...base,
  recipients: ids.map((member_id) => ({ ...base.recipients[0], member_id })),
});

describe("envelope-shape.json", () => {
  it("has at least 40 cases covering 201, 400 and 404", () => {
    assert.ok(cases.length >= 40);
    assert.deepEqual([...new Set(cases.map((c) => c.expect.status))].sort(), [201, 400, 404]);
  });

  for (const c of cases) {
    it(c.name, () => {
      const opts = { caller: c.caller, activeMembers: c.members };
      const result =
        c.raw === undefined ? validateEnvelopeShape(c.envelope, opts) : validateEnvelopeText(c.raw, opts);
      assert.deepStrictEqual(result, c.expect);
      if (c.raw === undefined) {
        assert.deepStrictEqual(validateEnvelopeText(JSON.stringify(c.envelope), opts), c.expect);
      }
    });
  }
});

describe("envelope shape extras", () => {
  const opts = { caller: CALLER, activeMembers: ACTIVE };

  it("lists three unknown recipients in recipient order, mixed with known ones", () => {
    const env = withRecipients(["m_dev_7", "m_agent_1", "m_dev_3", "m_dev_2", "m_dev_5"]);
    assert.deepStrictEqual(validateEnvelopeShape(env, opts), {
      status: 404,
      error: "unknown_recipient",
      member_ids: ["m_dev_7", "m_dev_3", "m_dev_5"],
    });
  });

  it("a duplicate unknown id is a 400 at the later occurrence, never a 404 listing it twice", () => {
    const env = withRecipients(["m_dev_3", "m_agent_1", "m_dev_3"]);
    assert.deepStrictEqual(validateEnvelopeShape(env, opts), {
      status: 400,
      error: "invalid_envelope",
      field: "/recipients/2/member_id",
    });
  });

  it("accepts a Set of active members", () => {
    assert.deepStrictEqual(validateEnvelopeShape(base, { caller: CALLER, activeMembers: new Set(ACTIVE) }), {
      status: 201,
    });
  });

  it("validateEnvelopeText accepts UTF-8 bytes and rejects malformed UTF-8", () => {
    const bytes = new TextEncoder().encode(JSON.stringify(base));
    assert.deepStrictEqual(validateEnvelopeText(bytes, opts), { status: 201 });
    assert.deepStrictEqual(validateEnvelopeText(new Uint8Array([0x7b, 0xff, 0x7d]), opts), {
      status: 400,
      error: "invalid_envelope",
      field: "",
    });
  });

  it("null and primitives fail at the root", () => {
    for (const value of [null, 1, "x", true, [], undefined]) {
      assert.deepStrictEqual(validateEnvelopeShape(value, opts), { status: 400, error: "invalid_envelope", field: "" });
    }
  });

  it("an unknown key inside a recipient is escaped as a JSON pointer", () => {
    const env = { ...base, recipients: [{ ...base.recipients[0], "x/~": 1 }] };
    assert.deepStrictEqual(validateEnvelopeShape(env, opts), {
      status: 400,
      error: "invalid_envelope",
      field: "/recipients/0/x~1~0",
    });
  });
});
