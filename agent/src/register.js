import nodeFs from "node:fs";
import { join } from "node:path";

import { CONFIG_FILE, LocalStateError, ensureHome, saveConfig, validateUrlScheme } from "./config.js";
import { generateKeyPair } from "./crypto.js";
import { b64uEncode } from "./encoding.js";
import { hubIdFromToken, isHubId, isMemberId, isWebhookSecret } from "./ids.js";
import { RelayError, createRelayClient } from "./relay-client.js";
import { registerSecret } from "./log.js";
import { PAIRING_FILE } from "./pairing.js";
import { SECRETS_FILE, saveSecrets } from "./secrets.js";
import { acquireHomeLock } from "./protected-files.js";
import { createHomeState, LEGACY_FILES } from "./home-state.js";

export const AGENT_FILES = [SECRETS_FILE, CONFIG_FILE, "state.json", PAIRING_FILE, ...LEGACY_FILES];

export function isInitialized(home, { fs = nodeFs } = {}) {
  return AGENT_FILES.some(f => fs.existsSync(join(home, f)));
}

export async function registerAgent({
  home,
  relayUrl,
  name,
  invite,
  urlScheme = null,
  fetch,
  sleep,
  random,
  now = () => new Date(),
  logger,
  fs = nodeFs,
  timers = globalThis,
}) {
  if (urlScheme !== null) validateUrlScheme(urlScheme);
  if (isInitialized(home, { fs })) {
    throw new LocalStateError("already_initialized", "agent home is already initialized; use its identity or a new home");
  }
  ensureHome(home, { fs });
  const lease = acquireHomeLock(home, 'receiver', { fs });
  try {
    if (isInitialized(home, { fs })) throw new LocalStateError('already_initialized', 'agent home is already initialized');
    registerSecret(invite);
    const keys = await generateKeyPair();
    const publicKey = b64uEncode(keys.publicKey);
    const relay = createRelayClient({ baseUrl: relayUrl, fetch, sleep, random, now: () => now().getTime(), logger, timers });
    const registered = await relay.register({ invite, name, publicKey });
    if (
      !isHubId(registered?.hub_id) ||
      hubIdFromToken(registered.token) !== registered.hub_id ||
      !isMemberId(registered.member_id) ||
      !isWebhookSecret(registered.webhook_secret)
    ) {
      throw new RelayError({ status: 200, code: "invalid_response", message: "the relay returned a malformed registration" });
    }

    ensureHome(home, { fs });
    saveSecrets(
      home,
      {
        private_key: b64uEncode(keys.privateKey),
        public_key: publicKey,
        token: registered.token,
        webhook_secret: registered.webhook_secret,
      },
      { fs },
    );
    saveConfig(home, { relay_url: relay.baseUrl, name, ...(urlScheme !== null && { url_scheme: urlScheme }) }, { fs });

    createHomeState(home, { hub_id: registered.hub_id, member_id: registered.member_id, public_key: publicKey }, { fs });
    logger?.info("registered", { hub_id: registered.hub_id, member_id: registered.member_id });
    return { hub_id: registered.hub_id, member_id: registered.member_id, relay: relay.baseUrl, public_key: publicKey };
  } finally { lease.release(); }
}
