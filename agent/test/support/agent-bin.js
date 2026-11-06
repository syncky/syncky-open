import { fileURLToPath } from "node:url";

export function agentBin(env = process.env) {
  return env.SYNCKY_AGENT_BIN || fileURLToPath(new URL("../../bin/syncky-agent.js", import.meta.url));
}
