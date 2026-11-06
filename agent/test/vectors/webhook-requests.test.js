import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseRawInner } from "../../src/thin-transport.js";
import { createValidator } from "../support/validator.js";
import { loadVectors } from "../support/protocol-files.js";
const validator = await createValidator();
import { verifyWebhook } from "../support/webhook-signature.js";

const { cases } = loadVectors("webhook-requests");

describe("webhook-requests.json", () => {
  it("has a split delivery, an unsigned one and an empty one", () => {
    assert.ok(cases.some((c) => c.requests.length > 1));
    assert.ok(cases.some((c) => !c.destination.signing && c.requests.length > 0));
    assert.ok(cases.some((c) => c.requests.length === 0));
  });

  it("re-sends an activity summary of an earlier case with new values", () => {
    const resent = cases.filter((c) => c.follows);
    assert.ok(resent.length > 0);
    for (const c of resent) {
      const earlier = cases.find((x) => x.name === c.follows);
      assert.deepEqual(earlier.destination, c.destination);
      const summaries = [earlier, c].map((x) => x.requests.flatMap((r) => parseRawInner(r.body).inner.samples).find((s) => s.type === "activity_summary"));
      assert.equal(summaries[0].uuid, summaries[1].uuid);
      assert.notDeepEqual(summaries[0], summaries[1]);
    }
  });

  it("preserves direct-only summaries verbatim for consumers", () => {
    const body = { v: 1, type: "sync", samples: [], summaries: [{ type: "steps", value: 0 }] };
    assert.deepEqual(parseRawInner(JSON.stringify(body)).inner, body);
  });

  for (const c of cases) {
    it(c.name, () => {
      c.requests.forEach((request, i) => {
        const headers = request.headers;
        assert.equal(headers["X-Syncky-Format"], c.format);
        assert.equal(headers["X-Syncky-Destination"], c.destination.id);
        if (c.destination.signing) {
          const args = { secret: c.secrets.hmac, timestampHeader: headers["X-Syncky-Timestamp"], signatureHeader: headers["X-Syncky-Signature"] };
          assert.equal(verifyWebhook({ ...args, rawBody: request.body, now: Number(c.timestamp) }), "valid");
          assert.equal(verifyWebhook({ ...args, rawBody: `${request.body} `, now: Number(c.timestamp) }), "bad_signature");
        } else {
          assert.equal(headers["X-Syncky-Signature"], undefined);
        }
        if (c.format !== "native") return;
        const result = parseRawInner(request.body);
        assert.equal(result.inner.device, c.device);
        assert.equal(result.inner.more, i < c.requests.length - 1);
        const { delivery, summaries = [], ...inner } = JSON.parse(request.body);
        assert.equal(summaries.length, request.summaries ?? 0);
        assert.equal(delivery.resend, c.resend === true ? true : undefined);
        assert.equal(delivery.test, undefined);
        assert.deepEqual(result.inner, JSON.parse(request.body));
        assert.equal(validator.validate("inner-sync.schema.json", "sync", inner).ok, true);
        assert.deepEqual(
          [delivery.destination, delivery.id, delivery.index, delivery.count, delivery.sent_at],
          [c.destination.id, headers["X-Syncky-Delivery"], i, c.requests.length, c.sent_at],
        );
      });
    });
  }
});
