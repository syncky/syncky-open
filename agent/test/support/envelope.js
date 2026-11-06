import { createThinTransport } from "../../src/thin-transport.js";
import { loadJson } from "../../src/protocol-files.js";

export { EnvelopeError } from "../../src/thin-transport.js";
const table = loadJson("messages.json"), transport = createThinTransport({ table });
export const ENVELOPE_KEYS = table.canonical.envelope_fields.filter(k => !Object.hasOwn(table.markers, k));
export const { open: openEnvelope, seal: sealEnvelope, serialize: serializeEnvelope,
  validateShape: validateEnvelopeShape, validateText: validateEnvelopeText } = transport;
export const envelopeAad = (hubId, msg_id, from, kind = "data", diagnostics, access) => transport.aad(hubId, {
  msg_id, from, kind, ...(diagnostics === undefined ? {} : { diagnostics }), ...(access === undefined ? {} : { access }),
});
