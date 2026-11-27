# Syncky plugin: two-way Apple Health for your own agent

This folder is one plugin package for two hosts:

- **Hermes Agent**: a Portable Agent Plugins v1 package (`plugin.json`, `mcp.json`, `skills/`).
- **Claude Code**: a Claude Code plugin (`.claude-plugin/plugin.json`, `.mcp.json`, `skills/`).

With the [Syncky Health](https://apps.apple.com/app/id6827472070) iPhone app, your agent reads the Apple Health types you choose and can write entries back to Apple Health for the types you allow for writing on the iPhone. Health data is end-to-end encrypted between the iPhone and the Syncky agent on your own machine; Syncky Relay, which queues the sealed messages, sees delivery metadata but no health values. No Syncky account and no public URL are needed: the agent connects out to the relay over HTTPS.

## What it contains

- One stdio MCP server, `npx -y @syncky/agent@0.2.3 mcp`, with five tools: `syncky_status`, `syncky_inbox`, `syncky_skill` (read-only), and `syncky_send`, `syncky_ack`.
- One skill, `syncky`, with setup, pairing and operating rules.

## Setup in Hermes

1. Install the plugin, then start a new chat.
2. Ask Hermes to set up Syncky. The skill runs `init` and `pair` through `npx -y @syncky/agent@0.2.3` and Hermes replies with the pairing QR code, link, code and expiry in the chat where you asked.
3. Open the link or scan the QR code with Syncky Health on your iPhone and pick the code shown. If a terminal QR code does not scan, use the link.
4. When the skill asks, choose whether the agent receives continuously in the background or only when you ask. The MCP server alone does not receive.

The MCP server and the skill's commands use the agent home `~/.syncky-agent` of the user that runs them. If Hermes runs its terminal and its MCP servers with different home directories, as in some container setups, use the manual MCP setup with an explicit `SYNCKY_AGENT_HOME` from the [Hermes guide](https://syncky.app/guides/hermes) instead.

## What to know before installing

- **Network.** On first use, `npx` can download the pinned `@syncky/agent` package from npm. The agent sends and receives sealed messages over HTTPS to Syncky Relay (`relay.syncky.app`).
- **Health data reaches your model.** Health data you choose appears in tool results and command output, so the model provider your Hermes session uses sees it. Use a local model or one you trust with health data.
- **Writes to Apple Health.** `syncky_send` delivers write commands. The skill instructs Hermes to send a write only when you ask for that entry or approve a standing rule. The iPhone checks write permissions and does not prompt for each entry: it applies a write only for types you allowed for writing, at its next sync, and records the requesting agent in the entry's metadata. You can remove written entries on the iPhone.
- **Local files.** The agent home holds the agent's keys and received records. The receiver deletes records older than 30 days when it runs.
- **Shell commands.** The skill runs `npx -y @syncky/agent@0.2.3` commands (`init`, `pair`, `status`, `receive`, `inbox`).
- **Background process.** If you choose continuous receive, the skill installs the receiver locally and configures it to start at login and restart after a failure.
- **Daily version report.** By default, the receiver reports its agent version and operating-system family to Syncky Relay once a day. You can turn this off with `SYNCKY_HEARTBEAT=off`. The report contains no health values.

Source, protocol and test vectors: [syncky-open](https://github.com/syncky/syncky-open). Licence: Apache-2.0.
