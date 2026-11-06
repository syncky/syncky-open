import fs from "node:fs";
import { createHomeState, readHomeState, updateHomeState } from "../../src/home-state.js";
import { createThinPairing } from "../../src/thin-pairing.js";
import { createThinTransport } from "../../src/thin-transport.js";
import { b64uDecode } from "../../src/encoding.js";
import { fixture, identity, keys, messageId } from "./thin-home.js";
import metadata from "../../package.json" with { type: "json" };

export { identity, keys, messageId };
export const tablePath = new URL("../../../protocol/messages.json", import.meta.url);
export const table = () => JSON.parse(fs.readFileSync(tablePath));
export const self = { memberId: keys.agent.member_id, privateKey: b64uDecode(keys.agent.sk) };
export const now = () => new Date("2026-11-05T12:00:00Z");
export function setup(t, { confirmed = true } = {}) {
  const home = fixture(t); createHomeState(home, identity);
  const pairing = createThinPairing(home, { now });
  pairing.join({ member_id: keys.dev1.member_id, public_key: keys.dev1.pk, role: "device" }, { verified: true });
  if (confirmed) {
    pairing.confirmFingerprint(keys.dev1.member_id, readHomeState(home).members[keys.dev1.member_id].fingerprint);
    updateHomeState(home, s => { delete s.members[keys.dev1.member_id].confirmation; s.members[keys.dev1.member_id].agent_info_version = metadata.version; });
  }
  return { home, pairing, transport: createThinTransport({ tablePath }) };
}
export async function delivery(transport, seq, inner = { type: "future", extra: { value: 1 } }, options = {}) {
  const envelope = await transport.sealMessage({ hubId: identity.hub_id, from: keys.dev1.member_id,
    senderPrivateKey: b64uDecode(keys.dev1.sk), recipients: [{ memberId: self.memberId, publicKey: b64uDecode(keys.agent.pk) }],
    innerText: typeof inner === "string" ? inner : JSON.stringify(inner), msgId: messageId(seq), ...options });
  return { ...envelope, seq };
}
