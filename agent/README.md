# Syncky agent

A Node.js ≥22.15 encrypted transport with a 30-day raw JSON inbox and a verified skill. The iPhone enforces Health policy and consent. The agent has no local Health database, command ledger, summaries, HTTP server or binary auto-update.

Use `syncky-agent` or its `syncky` alias. The source-kit runner is `node bin/syncky-agent.js` from this directory. Carried skill packages include a checksum-verifying launcher and an offline bundle; use its absolute path. npm uses `npx -y @syncky/agent`.

```sh
syncky-agent selftest
syncky-agent init --name 'My agent'
syncky-agent pair
syncky-agent receive >/dev/null
```

Pairing credentials and QR/code output are private. V2 proof confirms the owner's code pick; v1 requires fingerprint comparison and explicit `confirm`. `confirm <member_id> <fingerprint>` refuses mismatches; `reject <member_id>` discards held ciphertext and revokes the phone. `wait` or `pair --wait` waits for joining/proof. Keep one receiver per home; MCP starts none.

`status` returns minimal local JSON: identity, member confirmation/fingerprint metadata, last reported scope, poll/ACK progress, send receipts, skill/update versions and legacy filenames. No Health bodies or values. Status and inbox reads work offline and do not fetch updates. Scope is explanatory, never a local admission policy.

```sh
syncky-agent status --json
syncky-agent inbox --type sync --member m_dev_1 --limit 100
syncky-agent inbox --after-seq 100 --since 2026-11-01 --limit 100
syncky-agent receive --once >/dev/null
syncky-agent send --type resync_request --json request.json --validate
syncky-agent ack --up-to-seq 100
syncky-agent skill
syncky-agent skill --diff
syncky-agent mcp
```

`send --json <file|->` selects **input**, and always returns metadata JSON. The caller supplies all JSON fields. Optional local schema validation uses the bundled/verified schemas; an absent schema passes through. Unlisted inner types use unmarked control envelopes. The phone gates writes, diagnostics and access requests. Explicit owner intent is required before sending any of these. Relay delivery is not phone application; correlate every raw reply by command_id and version.

The inbox contains `{seq, cursor, from, kind, type, received_at, inner}` records in `inbox/YYYY-MM-DD.jsonl`, retaining authentic JSON and unknown fields verbatim without feature normalization. Local pagination uses `next_after_seq` and `has_more`: the cursor follows durable append order, including delayed held releases; `seq` remains the relay sequence for ACKs. `.inbox-cursor.json` retains the high-water mark across pruning and forgetting. Reads never delete or ACK. Authentic messages or held ciphertext are durable before relay ACK. Explicit ACK cannot exceed the durable checkpoint. Poison messages record safe metadata and allow progress. Raw receive stdout and inbox/MCP responses are deliberate private data channels, never logs. Services discard stdout and log only stderr metadata.

Homes use 0700 directories and 0600 files: `secrets.json`, `config.json`, `state.json`, `pairing.json`, `inbox/`, `outbox/`, `held/`, `installed-bundle.json`, `skill-update.json`. Same-home owner-assisted offline migration preserves secrets, config, pairing and trust. A legacy home without exported state returns `migration_required`. Init refuses initialized homes. Never open or delete legacy `agent.db`, `diagnostics.db`, `access.db`, WAL or SHM through this runtime. Status names retained legacy files for the owner's manual handling. Old config/secret fields remain readable.

Receive prunes only thin inbox history older than 30 days on startup and daily. Unpair, Delete Relay data, token revocation and re-pairing retain earlier raw history under its original sender. `forget <member_id>` previews thin inbox/held/outbox counts; only explicit owner approval authorizes `forget <member_id> --yes`, after revocation. The trust tombstone and legacy files remain.

If the phone says the relay was not told, only with explicit owner approval run `revoke <member_id>` to revoke it on the relay and locally, then use `forget` if deletion is approved. Relay 404 succeeds with `revoked_on_relay: false`; other relay failures leave local state unchanged for retry.

Receive advertises the poll interval (default 1800 seconds; 300–86400), honors Retry-After, first-sync fast polling and independent ciphertext outbox lanes. It sends a daily heartbeat when enabled. A separately started receiver is required for poll liveness and background retries. Offline skill/diff uses the bundled skill or verified installed bundle. HTTPS pinned-origin Ed25519 updates activate skill/table/schemas atomically, reject downgrade and fail closed with `skill_key_unset` while the production pin is empty. Relay hint text is untrusted. No binary download/install controls exist.

Configuration: `SYNCKY_AGENT_HOME`, `SYNCKY_RELAY_URL`, `SYNCKY_AGENT_NAME`, `SYNCKY_URL_SCHEME`, `SYNCKY_INVITE`, `SYNCKY_LOG_LEVEL`, `SYNCKY_POLL_INTERVAL_S`, `SYNCKY_HEARTBEAT`. Global CLI flags are `--home`, `--relay`, `--url-scheme`, `--log-level`, `--help`. Invites belong in the environment, never logs/command arguments. Use `help` for the full current surface and [REFERENCE](https://github.com/syncky/syncky-open/blob/main/agent/docs/REFERENCE.md) for errors.

MCP tools: `syncky_status`, `syncky_inbox`, `syncky_send`, `syncky_ack`, `syncky_skill`; resource `syncky://skill`. Disable send and ack for read-only clients. Only send carries generic Health writes/requests. Stdio stdout is protocol only; MCP starts no receiver, heartbeat or retry loop.

See [SETUP](https://github.com/syncky/syncky-open/blob/main/agent/SETUP.md), [integration guide](https://github.com/syncky/syncky-open/blob/main/agent/AGENTS.md), [skill](https://github.com/syncky/syncky-open/blob/main/agent/skills/syncky/SKILL.md) and [cookbook](https://github.com/syncky/syncky-open/blob/main/agent/cookbook/README.md). Build with `npm run build`; `npm test` runs source unit/vector checks and `npm run test:bundle` checks the extracted bundle. The build embeds the message table, schemas, bootstrap skill and transport vectors. Runtime modules are file/crypto/relay transport; feature-specific interpretation belongs to the skill and phone.

Command inventory: `syncky-agent init`, `syncky-agent pair`, `syncky-agent wait`, `syncky-agent confirm`, `syncky-agent reject`, `syncky-agent revoke`, `syncky-agent forget`, `syncky-agent status`, `syncky-agent send`, `syncky-agent inbox`, `syncky-agent receive`, `syncky-agent ack`, `syncky-agent skill`, `syncky-agent mcp`, `syncky-agent selftest`, `syncky-agent help`.

Canonical MCP: `npx -y @syncky/agent mcp`. Use the same home. The model can see what you supply; the relay sees delivery metadata and plaintext system notices, but no health values. The release MCPB `syncky-health.mcpb` uses manifest format `0.3`, an assumption requiring owner host verification. Carried packages need no runtime npm installation, with no upper version cap on Node ≥22.15. Use `dist/agent-skills/skills/syncky/syncky-agent` after a local build; the checksum detects corruption, but does not protect against a writable installation. Embedded protocol resources can be explicitly overridden with SYNCKY_PROTOCOL_DIR.

Access requests use generic `send --type access_request`; explicit owner approval is separate from permission to write Health values. Read actual `access_reply` item outcomes (`allowed`, `declined`, `needs_health_settings`) through inbox, then effective scope from the next ordinary sync. The phone enforces one pending slot, one admission per rolling 24 hours, 24-hour expiry and a seven-day declined-type wait. There is no item-count cap; each request/reply must fit 4096 serialized bytes.

Allow adds only approved types to Health selection, without selecting their categories. Existing selected categories and individually allowed types are preserved. **Choose Health data** shows partial selection as **Individually allowed: …** under an unchecked category; Allow texts name the exact types. Existing read `all` stays `all` and follows later Health selection changes. Approved reads turn `none` into a chosen list and are unioned into existing read lists.

Allowed writes turn on the global **Allow writing to Health** toggle for all selected writable types; agent scope and iOS write permission still apply. If writing was off or the agent's effective write allowance was empty, its write scope becomes only the approved write types, even from `all` or an absent scope; otherwise existing write scope is unioned as before. Decline revokes nothing. The reply alone never updates cached scope; wait for the next ordinary sync. Health read authorization is unobservable. No local admission/cooldown policy exists.
