# Syncky: open protocol, reference agent and reference server

Syncky Health sends the Apple Health data you choose from your iPhone to your own AI agent (local MCP server) or your own server. The AI agent route is end-to-end encrypted. Your agent and your server can both write entries back into Health once you allow writing on the iPhone.

Client health-data envelopes are end-to-end encrypted (HPKE Auth + ChaCha20-Poly1305): the relay sees delivery metadata and emits plaintext hub notices, but sees no health values. The app can also send straight to a server the user runs, with no relay at all. The user's agent or server receives plaintext, and a chosen model sees what the agent supplies.

Get [Syncky Health on the App Store](https://apps.apple.com/app/id6827472070) or visit [syncky.app](https://syncky.app).

## Install for an MCP client

Requires Node.js ≥22.15 and npm. The npm package embeds its runtime packages and has no runtime dependencies. Start the local stdio server with:

```sh
npx -y @syncky/agent mcp
```

For a client whose JSON configuration uses `mcpServers`:

```json
{"mcpServers":{"syncky":{"command":"npx","args":["-y","@syncky/agent","mcp"]}}}
```

Pair first using `SKILL.md` or the [operator guide](agent/SETUP.md). Use the same `SYNCKY_AGENT_HOME` during setup and in the MCP client's environment when selecting a custom home. Grant only the read/write types you want to share. iOS background scheduling and an unlocked phone govern delivery; this is not a real-time feed.

### Cursor

[Add to Cursor](https://cursor.com/en/install-mcp?name=syncky&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBzeW5ja3kvYWdlbnQiLCJtY3AiXX0%3D)

The default home is `~/.syncky-agent`; add `env.SYNCKY_AGENT_HOME` only for a custom home, using the absolute path of the same initialized/paired home used by your receiver. JSON environment values do not expand `$HOME` or `~`; use your actual path, including on Windows.

For manual configuration, merge this server into global `~/.cursor/mcp.json` or project `.cursor/mcp.json`, preserving other servers:

```json
{"mcpServers":{"syncky":{"command":"npx","args":["-y","@syncky/agent","mcp"]}}}
```

Cursor enables MCP tool approval by default. Do not auto-allow `syncky_send` or `syncky_ack`; approve only writes, diagnostics requests and access requests you intend. Cursor's `mcp.json` cannot disable individual tools, so this recipe leaves both mutating tools available and is not a read-only setup. You can toggle the whole server in **Customize**. Pairing, selected types, agent write scope, **Allow writing to Health**, iOS permissions and the [operator guide's security rules](https://github.com/syncky/syncky-open/blob/main/agent/SETUP.md#6-security-rules) still apply. A queued write is not an applied write. MCP does not start a receiver or complete pairing; keep one receiver per home.

### Claude Desktop

For manual local setup, the [official MCP tutorial](https://modelcontextprotocol.io/docs/develop/connect-local-servers), linked through [Anthropic's local-server documentation](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop), specifies **Settings → Developer → Edit Config**. On macOS the file is `~/Library/Application Support/Claude/claude_desktop_config.json`; on Windows it is `%APPDATA%\Claude\claude_desktop_config.json`. Merge this server, preserving other entries:

```json
{"mcpServers":{"syncky":{"command":"npx","args":["-y","@syncky/agent","mcp"]}}}
```

Save, fully quit and restart Desktop to start the local stdio server. It runs under your user account. Inspect tools through **+ → Connectors** or Local MCP servers settings; current Anthropic Help describes **Settings → Desktop app → Manage** Extensions and the older **Settings → Extensions** layout. Review permission requests and approve only intended operations. This registration does not disable writes. Use the same paired home and a separate receiver; MCP neither pairs nor starts one. For a custom home, the manual server entry can add `env.SYNCKY_AGENT_HOME` with an absolute paired-home path.

Anthropic documents custom `.mcpb` import under Extensions → **Advanced settings → Install Extension** and publishes the [manifest specification](https://github.com/anthropics/mcpb/blob/main/MANIFEST.md), currently `0.3`. This documents the schema and import mechanism; local packaging tests do not establish Claude Desktop acceptance of Syncky's archive. Keep the MCPB compatibility caveat below. The shipped bundle has no custom-home UI field; use the manual environment configuration for a custom home.

### VS Code Copilot

For a local project, Microsoft's [configuration reference](https://code.visualstudio.com/docs/agents/reference/mcp-configuration) specifies workspace `.vscode/mcp.json` with `servers` and explicit stdio type:

```json
{"servers":{"syncky":{"type":"stdio","command":"npx","args":["-y","@syncky/agent","mcp"]}}}
```

The [current setup guide](https://code.visualstudio.com/docs/agent-customization/mcp-servers) retains this as a compatibility format, deprecated in the guided add-server flow. Eligible entries are forwarded to Copilot sessions; the harness does not read this file directly, and configurations requiring interactive input are excluded. This example has no interactive inputs. The command runs on the machine hosting the process; this recipe uses a local project on the paired database's machine. Remote workspaces and containers need their own runtime/storage checks.

Review the configuration before trusting the workspace: Restricted Mode blocks workspace servers, while trusted workspaces can start them without a separate MCP trust prompt. Use **MCP: List Servers → Start Server**, **Restart Server** after changes, or **Show Output** for diagnosis; see [server management](https://code.visualstudio.com/docs/agents/run/manage-mcp-servers). In a Copilot agent session, **Chat: Open Customizations → Tools** controls tool availability; the Local harness uses **Configure Tools**. Leave both `syncky_send` and `syncky_ack` unselected for read-only work. Select **Manual permissions** and review auto-approval settings; [tool selection](https://code.visualstudio.com/docs/agents/run/tools#manage-available-tools) and [approvals](https://code.visualstudio.com/docs/agents/run/approvals) are client policy, not fields in this JSON. The registration does not disable writes or start a receiver. Optional `env.SYNCKY_AGENT_HOME` takes the absolute path of the same paired home used by your receiver.

### Windsurf

The vendor's [Windsurf Cascade MCP configuration](https://docs.devin.ai/windsurf/plugins/cascade/mcp) documents local stdio and `mcpServers`. In Cascade's MCP menu choose **Open MCP config file** and merge this server into the file it opens, preserving other entries:

```json
{"mcpServers":{"syncky":{"command":"npx","args":["-y","@syncky/agent","mcp"]}}}
```

Current defaults are macOS/Linux `~/.config/devin/mcp_config.json`, or `$XDG_CONFIG_HOME/devin/mcp_config.json` when set; Windows `%AppData%/devin/mcp_config.json`. Use the file opened by your installation, including isolated builds. The older `~/.codeium/windsurf/mcp_config.json` is a separate stable-editor discovery source, not necessarily Cascade's active file.

After saving the manual configuration, press the refresh button in the MCP panel. The vendor's **+ Add Server** action belongs to the plugin/template flow. Team policy may restrict MCP or server configurations. This recipe claims no approval default or per-tool disabling field; it does not disable writes. Keep writing off on the iPhone unless intended, and follow the [operator security rules](agent/SETUP.md#6-security-rules). Local MCP reads the same paired home and needs a separate receiver. For a custom home, `env.SYNCKY_AGENT_HOME` uses its absolute paired-home path. No remote-session storage equivalence is implied.

### Other MCP clients

ChatGPT desktop (Mac and Windows), Codex CLI and IDE extension use the [shared read-only setup](https://github.com/syncky/syncky-open/blob/main/agent/SETUP.md#chatgpt-desktop-mac-and-windows).

Claude Code can install the marketplace and its MCP/skill plugin:

```text
/plugin marketplace add syncky/syncky-open
/plugin install syncky@syncky
```

Alternatively register just the server:

```sh
claude mcp add --transport stdio syncky -- npx -y @syncky/agent mcp
```

Gemini CLI's [extension reference](https://geminicli.com/docs/extensions/reference/) documents GitHub installation (requires Git), root `gemini-extension.json`, startup MCP registration and context loading through `contextFileName`. Syncky's manifest names `SKILL.md` as extension context and registers local stdio with `command: "npx"` and `args: ["-y", "@syncky/agent", "mcp"]`. Run this in a terminal outside the interactive session:

```sh
gemini extensions install https://github.com/syncky/syncky-open
```

Review the installation confirmation, then restart the Gemini CLI session; extension management changes take effect after restart. Use `/extensions list` in the session to check installation. This registration does not disable writes or start a receiver: use the same paired home and a separate receiver, inspect scope first with `syncky_status`, and request only deliberate writes under the [operator security rules](agent/SETUP.md#6-security-rules). Tool approvals depend on client policy; see the [official MCP reference](https://geminicli.com/docs/tools/mcp-server/).

Other skill-capable agents can use the root `SKILL.md`. The plugin's `plugins/syncky/skills/syncky/SKILL.md` has the same instructions. These repository skills use npm; they do not carry an executable. For hosts without npm access, the release's four carried skill archives include a local launcher and bundle. Their carried Claude Code MCP registration uses the local bundle offline; the repository plugin uses npm.

MCPB is the alternative: download `syncky-health.mcpb`, its `.sha256` sidecar and `SHA256SUMS` from the matching [GitHub release](https://github.com/syncky/syncky-open/releases), check the digest and import the bundle into a compatible client. Node ≥22.15 is still required. A checksum detects damage; it does not authenticate a compromised release. The same release also carries the standalone bundle and its sidecar.

## Registry and release preparation

The root `server.json` is an **unpublishable source draft** listing npm and MCPB. Its MCPB hash is deliberately absent. After building, generate the release asset outside the build directory, for example into a fresh temporary directory:

```sh
(cd agent && npm ci && npm run build)
release_dir=$(mktemp -d)
node prepare-registry.mjs server.json agent/package.json agent/dist "$release_dir/server.json"
node --test test/*.test.mjs
```

The helper computes the actual MCPB SHA-256 and requires agreement with its sidecar and checksum list. The tag workflow builds, tests and prepares the release with read-only repository permissions, then uploads the prepared directory as an artifact. A separate publish job with OIDC and release-write permissions downloads it, rechecks versions, manifests, package metadata, inventories and hashes using `release.mjs`, publishes the tested tarball with npm OIDC/provenance and attaches the verified assets. The read-only build job also runs `npm ci`, `npm test` and `npm run build:worker` in `examples/own-server` before preparing or uploading release assets. Only the build job runs agent/template dependencies and the packed runtime selftest; the publish job neither installs those dependencies nor executes their runtime code. The own-server template remains source in the tag, without a separate npm or Registry package or release asset. An empty successful npm version lookup means the version is unpublished; lookup failures remain errors. The build job validates the generated `server.json` with a pinned, checksum-verified `mcp-publisher`. After npm publication and the GitHub release, the publish job publishes that generated file to the MCP Registry through GitHub OIDC without a stored token, skipping a version the Registry already has.

The Registry schema `2025-12-11` and package fields were used for the manual publication of version `0.1.1`. MCPB format `0.3` is a compatibility assumption; local ZIP/manifest/runtime tests do not prove Claude Desktop acceptance. Only the generated release `server.json` is published to the Registry.

`@syncky/agent` is published on npm; later versions are published only by the tag workflow through npm trusted publishing (OIDC) with provenance and no stored token. The owner must keep npm trusted publishing bound to `syncky/syncky-open` / `release.yml`, with no token bootstrap. Actual desktop-client verification and extension/plugin client acceptance remain owner checks.

This repository holds everything a developer needs to build the other end:

| Folder | What it is |
| --- | --- |
| [`protocol/`](protocol/README.md) | the schemas, the type catalog `types.json`, the unit table `units.json` and the test vectors every implementation checks itself against; the [server integration guide](protocol/server.md); the [HealthKit data kind inventory](protocol/healthkit-inventory.md) |
| [`agent/`](agent/README.md) | `syncky-agent`, the Syncky agent (Node 22): pairing, end-to-end encryption, a 30-day local inbox of what the iPhone sends, sending messages to the iPhone (a Health write, applied at the next sync when the owner has allowed writing for that type and iOS Health permits it, or a diagnostics or access request, which the owner approves on the phone) and an MCP server for local clients. The integration guide for your own agent in any language is [`agent/AGENTS.md`](agent/AGENTS.md), the operator guide for an AI agent that runs it is [`agent/SETUP.md`](agent/SETUP.md), and every error code and limit is in [`agent/docs/REFERENCE.md`](agent/docs/REFERENCE.md) |
| [`examples/minimal-agent/`](examples/minimal-agent/README.md) | one Node file that walks the whole relay flow, from registration to the phone's acknowledgement of a write |
| [`examples/browser-demo/`](examples/browser-demo/README.md) | the demo agent that runs only in a browser tab, served at https://demo.syncky.app: pair the app, watch decrypted samples arrive, send a write; it stores nothing |
| [`examples/own-server/`](examples/own-server/README.md) | self-hosted Worker or Docker storage, server-local OAuth consent and bounded remote MCP over the direct-server route |
| [`examples/minimal-server/`](examples/minimal-server/README.md) | one Node file, no dependencies, that receives the app's direct deliveries in every format, checks auth and signatures and writes back |

Not in this repository: the iOS app, the Syncky core that generates `types.json`, `units.json` and the vectors, and the relay. The generated files are not edited by hand here; when a vector and prose disagree, the vector wins.

## What this repository does and does not promise

The code and documents here describe what the Syncky app and relay do today; they are published as is under the Apache License 2.0 (see `NOTICE`) and are not a guarantee of any security, privacy or medical property. The relay cannot read the sealed envelopes, but an agent or a server built from this repository receives health data in clear, and whoever runs it is responsible for that data under the laws that apply to them; Syncky's privacy policy (https://syncky.app/privacy) and terms (https://syncky.app/terms) cover the app and the relay only. Syncky is a data-transfer tool, not a medical device: nothing it moves is medical advice.

## Tests

Node 22.15 or later in the 22 line.

```bash
(cd agent && npm ci && npm test)
(cd examples/minimal-agent && npm ci && npm test)    # its tests use agent/ helpers: install agent/ first
(cd examples/minimal-server && npm test)             # no dependencies
(cd examples/browser-demo && npm ci && npm test)
(cd examples/own-server && npm ci && npm test && npm run build:worker)
```

## Licence and security

Apache License 2.0, see [LICENSE](LICENSE). Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

The current thin runtime exposes exactly `syncky_status`, `syncky_inbox`, `syncky_send`, `syncky_ack` and `syncky_skill`, plus the verified `syncky://skill` resource. Status, inbox and skill read local state offline without contacting the relay or fetching updates. Read-only clients disable both send and ack. Only generic send carries Health writes, diagnostics requests and access requests. A write is applied at the next sync when the owner has allowed writing for that type and iOS Health permits it. Diagnostics reports and access requests require explicit owner approval on the phone; Health selection, the app's write allowance, agent scope and iOS permissions remain authoritative. Request approval is separate from permission to write Health values. Raw results and every per-version phone outcome are read through inbox; queued/sent is not applied. Start one receive service per home separately; MCP starts no receiver, heartbeat or background retries. History is raw JSONL retained for 30 days, with no local policy, ledger, summary, unit conversion or series reassembly. A requested report needs explicit destination approval. See the [operator security rules](https://github.com/syncky/syncky-open/blob/main/agent/SETUP.md#6-security-rules).

## You operate it

You operate the template in your own hosting account, under your provider contract and chosen location, including possible United States processing. The EU Durable Object setting limits its execution/storage, not the edge Worker, object metadata/logs or AI providers. It does not guarantee EU-only processing. The template has no telemetry and no update channel: review a new source tag, back up and redeploy manually.

Keep upload/HMAC credentials private; rotate them in the admin page and re-import the one-time setup link on the phone. The server requires explicit OAuth consent identifying the client, exact Health types and health/fitness purpose before AI disclosure. Review training/privacy settings and revoke access on Granted clients. Revocation cannot recall an emitted reply or erase AI-provider copies. Use local export pages, erase server data and remove the Worker plus Durable Object storage, or Docker volume, and all exports/backups/recovery copies under your provider's retention rules. Deleting code or a container alone does not delete storage.

The template is outside the Syncky service, freely available without a subscription gate, with best-effort help through support@syncky.app and no SLA. Hosting and AI-provider accounts/costs are yours. Other people's data requires your own legal basis. Mandatory consumer rights and statutory liability remain unaffected.
