import { it } from "node:test";
import assert from "node:assert/strict";

import { generateKeyPair } from "../../src/crypto.js";
import { b64uEncode } from "../../src/encoding.js";
import { sealEnvelope, serializeEnvelope } from "../support/envelope.js";
import { createRelayClient } from "../../src/relay-client.js";
import { startRelayDouble } from "../support/relay-double.js";

it("the relay fixture delivers a paired phone envelope and applies the agent ACK", async t => {
  const invite = "double-invite";
  const relay = await startRelayDouble({ invite });
  t.after(() => relay.stop());
  const anonymous = createRelayClient({ baseUrl: relay.url });
  const agentKeys = await generateKeyPair();
  const phoneKeys = await generateKeyPair();
  const registered = await anonymous.register({ invite, name: "Agent", publicKey: b64uEncode(agentKeys.publicKey) });
  const agent = createRelayClient({ baseUrl: relay.url, token: registered.token });
  const pairing = await agent.createPairing();
  const response = await fetch(new URL("/v1/pair", relay.url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      hub_id: registered.hub_id,
      pairing_token: pairing.pairing_token,
      public_key: b64uEncode(phoneKeys.publicKey),
      device_name: "Phone",
    }),
  });
  assert.equal(response.status, 201);
  const joined = await response.json();
  const phone = createRelayClient({ baseUrl: relay.url, token: joined.token });
  const envelope = await sealEnvelope({
    hubId: registered.hub_id,
    from: joined.member_id,
    recipients: [{ memberId: registered.member_id, publicKey: agentKeys.publicKey }],
    senderPrivateKey: phoneKeys.privateKey,
    plaintext: '{"v":1,"type":"sync","device":"m_dev_1","samples":[]}',
  });
  const accepted = await phone.postMessage(serializeEnvelope(envelope));
  relay.failNext("getMessages", "reset");
  await assert.rejects(agent.getMessages(), { code: "network_error" });
  const received = await agent.getMessages();
  assert.deepEqual(received.messages.find(message => message.seq === accepted.seq), { ...envelope, seq: accepted.seq });
  await agent.ack(received.next_after);
  assert.deepEqual((await agent.getMessages()).messages, []);
});
