# Agent reference

The CLI surface is init, pair, wait, confirm, reject, revoke, forget, status, send, inbox, receive, ack, skill, mcp, selftest and help. The `syncky` alias is identical. All data responses are JSON except private pair QR/code and plain skill/diff. Global flags: --home, --relay, --url-scheme, --log-level, --help. For send only, --json selects a file or stdin (-); it is never an output flag. See [README](../README.md) and [SETUP](../SETUP.md).

## Limits and transport

One receiver lease per home; receive --once performs one bounded cycle. Poll interval defaults to 1800 seconds, configurable 300–86400. Preserve Retry-After, daily heartbeat and first-sync fast polling. A missed expected poll can show Needs attention on the phone. MCP starts no receiver/heartbeat/background retry loop. Read-only calls fetch no updates and mutate no Health data.

Envelope maximum: 256 KiB (262144 serialized UTF-8 bytes, including base64 ciphertext and recipient metadata); controls 4096; diagnostics inner 180000. The CLI separately caps raw JSON input at 262144 bytes; input below that cap can still exceed the sealed envelope limit. The signed skill-update JSON envelope has an independent 262144-byte cap and a 131072-byte decoded payload cap. Seven recipients maximum. Marker and both AAD operations follow the bundled/verified table. Unknown types use unmarked control; authenticated incoming JSON is preserved without feature-schema validation. --validate checks available local schemas without fetching refs. Phone policy/consent remains authoritative.

`end` must not be later than now + 1 h; the phone rejects a later `end` with `invalid`. For a running daily total, set `start` to local day start and `end` to now or the last diary entry time. Never use the end of the day. When a total changes, resend the same `command_id` with `version` + 1.

Put all nutrients of one day in one `send` with several `commands`. Send several entries in ONE `send` with a `commands` array; the transport does not combine separate calls. The 256 KiB (262144 bytes) data-envelope cap counts the complete serialized UTF-8 JSON, including base64 ciphertext and recipient metadata. The inner `commands` JSON can be up to roughly 191 KiB for one recipient, less with more recipients. The relay allows a burst of up to 60 data envelopes per agent, then about one a minute (about 60 data envelopes per hour per agent sustained), within the per-token limit of 60 requests a minute shared with polling, ACKs and heartbeats. A 429 `rate_limited` from either limit is retried automatically by the outbox after `Retry-After` when the receiver runs, so the caller does not resend. `status --json` shows `transport.send_lanes` (lane id to next allowed Unix time in milliseconds, including any legacy data-lane deadline) and pending `sends` with `code`, `next_attempt_at` and `retry_after_until`.

Inbox pagination: limit 1–1000 (default 100), member/type/after-seq/since/until filters, at most 1 MiB per page. Continue from next_after_seq while has_more. Explicit ACK cannot exceed the durable receive checkpoint. Raw stdout/inbox/MCP responses are private channels, never logs; services discard stdout. Stdio MCP has bounded requests/results and resource errors. Tools: syncky_status, syncky_inbox, syncky_send, syncky_ack, syncky_skill; resource syncky://skill. Read-only clients disable send and ack.

## State and migration

Home/directories 0700, files 0600. Identity/trust/checkpoints use state.json. Held and outbox files retain ciphertext, sealed retry bytes and metadata. Inbox/YYYY-MM-DD.jsonl stores every authentic inner including unknown fields and every sync.acks version. No Health index, summary, reassembly, command ledger or local feature policy exists. Unit/catalog lookup is available in the [catalog](../../protocol/types.json) and [units](../../protocol/units.json).

Same-home owner-assisted offline migration preserves secrets/config/pairing and trust; a legacy home without exported state returns migration_required. Init refuses initialized homes. Legacy agent.db/diagnostics.db/access.db and WAL/SHM are never opened or deleted by this runtime. Status names them for manual owner handling. Unpair/Delete Relay data/token revocation retain history under its original sender; 30-day receive-time pruning affects thin inbox files only, at loop startup and daily. Each outbox flush retains the latest 100 sent/failed receipts by message id; pending sends remain until delivery or terminal failure. Explicit owner-approved forget after revocation removes the member's thin inbox/held/outbox data, retaining its revoked tombstone and all legacy files.

If the phone says the relay was not told, explicit owner-approved `revoke <member_id>` revokes a known phone on the relay before revoking locally; history stays until `forget`. JSON returns member, state and revoked_on_relay: true for relay success, false for 404; other relay errors leave local state unchanged, and repeated revocation succeeds.

## Requests and results

Use generic send with complete caller-owned JSON; see [skill](../skills/syncky/SKILL.md). Explicit writes need owner intent for exact value/time or an approved standing rule. Sent/relay ACK is not applied. Keep stable command_id/version and correlate every per-version reply, including applied/rejected/deleted_by_user; no local dedup by command id exists.

`access_request` is an optional ask-ahead, not a required step before writes. For a catalog-writable type, a phone ack of `type_not_in_scope`, `type_not_allowed` or `healthkit_denied` means: tell the owner to allow that type on the phone (including Health Settings for iOS denial). With explicit owner approval, send an `access_request` for exactly those write types if the phone has not asked yet. Resend only after the next ordinary sync shows the effective write scope. A refused write creates no access request or automatic system consent prompt; its Home card may offer an owner-tapped Allow action. Unknown or read-only types cannot be enabled; correct the type instead.

On an `invalid` ack, check the command format first (`--validate`): fix timestamps, units or JSON. Schema validation does not cover phone policy; check interval bounds and units, then report an unexplained rejection without looping. Never ask for access on `invalid`. After a phone rejection, keep the same `command_id` and increment `version` before retrying; the phone caches completed rejections.

CLI `send` and MCP `syncky_send` durably queue ciphertext and attempt delivery. A successful call can return `state: "pending"` when another sender holds the delivery lease or a retry is due; the separately running receiver continues delivery. Poll `status --json` or `syncky_status`, matching `sends[].msg_id` to the receipt, until `state: "sent"` (relay acceptance) or `"failed"`. Use a bounded deadline that allows Retry-After; do not resend merely because the receipt is pending. Phone application still requires its matching inbox reply.

Diagnostics and access also require explicit owner approval. Diagnostics require Review and Confirm on the phone. The phone limits pending requests and admission; requests expire after 24 hours. Access has a rolling-day admission and seven-day wait for declined types. Read actual diagnostics/diagnostics_reply/access_reply through inbox, then next ordinary sync's scope. `access_request` lists are sorted and deduplicated before sealing. `--validate` / `syncky_send` validation checks known types and writable writes; use exactly 24 h (`expires_at - created_at == 24h`) for compatibility with phones 0.1.1/0.1.2. An `access_reply` with outcome `invalid` carries an optional value-free `detail` (`unknown_type`, `not_writable`, `ttl`, `empty`, `reason_too_long`, `malformed`, `created_in_future`, `too_large`); read it in the raw inbox, correct the request and use a new `request_ref`. It grants no access.

Allow adds only approved types to Health selection, without selecting their categories. Existing selected categories and individually allowed types are preserved. **Choose Health data** shows partial selection as **Individually allowed: …** under an unchecked category; Allow texts name the exact types. Existing read `all` stays `all` and follows later Health selection changes. Approved reads turn `none` into a chosen list and are unioned into existing read lists. Unchecking a category leaves individually allowed types selected. To stop those too, use **Remove individually allowed types** below the category and save; iOS permissions stay unchanged.

Allowed writes add only the approved write types to the app allowance and request Health sharing only for those exact types, without adding reads; agent scope and iOS write permission still apply. If writing was off or the agent's effective write allowance was empty, its write scope becomes only the approved write types, even from `all` or an absent scope; otherwise existing write scope is unioned as before. Decline revokes nothing. The reply alone never updates cached scope; wait for the next ordinary sync. No phone app version or access-request capability is exposed in sync or status. If no matching `access_reply` arrives after an `access_request`, have the owner open Syncky and sync; if it remains missing, check whether consent is still pending on the phone and whether the request expired, then suggest the owner check for an app update without looping. Missing replies do not prove an old app: the phone may be offline or consent pending. A phone running an app version older than this feature cannot show the request; explain expiry from the timestamps rather than inventing a reply. Syncky cannot observe Health read authorization.

Unlisted received types accept either authenticated data or control kind without a marker, within the existing 262144-byte data / 4096-byte control envelope limits. Unlisted sends use control without a marker. Selftest covers transport, crypto and pairing vectors.

## Rejected write details

Rejected `sync.acks` and direct-server `results` may include an optional `detail` matching `^[a-z_]{1,32}$`. Older phones omit it. Unknown well-formed details are retained; handle them by `reason`. Ignore a malformed detail or one on a non-rejected status without discarding the ack; the thin transport preserves the raw inner JSON unchanged in the inbox. The phone reports the first failing policy check. These are phone outcomes, never medical advice. Correct encoding, unit and time errors, but never change a measured value, invent a timestamp or clamp a value to pass a check; if the real data cannot be represented, stop and tell the owner.

| Reason | Detail | Meaning | What to fix |
| --- | --- | --- | --- |
| `invalid` | `end_in_future` | `end` is later than the phone's now + 1 hour. | Correct time errors; use `end = now` only when that accurately describes the data. For a running daily total, update the same command by incrementing its version. |
| `invalid` | `span_too_long` | `end − start` exceeds the type's `max_span_s`. | Split the period only where the data genuinely covers separate intervals; otherwise do not write it. |
| `invalid` | `bad_interval` | `start` or `end` is missing/malformed, or `start > end`. | Supply valid RFC 3339 timestamps with `start ≤ end`. |
| `invalid` | `bad_value` | Quantity `value` is missing or is not a finite number. | Send a finite JSON number, not a numeric string or null. |
| `invalid` | `bad_unit` | Quantity `unit` is null, not a string or outside the type's unit family; any unit on a category write also fails here. | Use a string in the type's [unit family](../../protocol/units.json) for quantities; omit `unit` entirely for categories. |
| `invalid` | `bad_category_value` | Category `value` is missing, not a string or outside the type's enum. | Use an exact category value from the catalog. |
| `invalid` | `unknown_op` | `op` is neither `write` nor `delete`. | Use one of those two operations. |
| `type_not_in_scope` | `declined_by_user` | The owner explicitly declined this write type for this agent. | Stop sending that type; wait until a later sync's scope includes it again. Do not keep retrying or requesting it. |
| `invalid` | Absent or unknown | Command validation failed without a recognized sub-reason. | Check operation, value, unit and interval against the catalog. |
| `type_not_in_scope` | Absent or unknown | The type is outside the agent's effective write scope. | Stop sending it until the announced scope includes it. |
| `type_not_allowed` | Absent or unknown | The type is unknown, not writable or not allowed by the phone. | Check catalog `write` support and the owner's Health selection and writing settings. |
| `value_out_of_range` | Absent or unknown | The converted quantity is outside catalog bounds or is not finite. | Check the unit and the conversion; if the measured value really is outside the catalog bounds, do not write it, tell the owner. |
| `healthkit_denied` | Absent or unknown | HealthKit refused the operation. | Ask the owner to check iOS Health write permission before retrying. |

After correcting a rejected command, increment its version; resend identical commands with the same id/version only for delivery retries. A detail is explanatory and grants no permission to write.

## Skill trust

Offline skill and literal diff come from package bootstrap or the verified installed bundle. Ed25519 verifies exact payload bytes; pinned HTTPS syncky.app/dev.syncky.app origins, no redirects, bounded fetch, monotonic version and atomic skill/table/schema activation are required. Empty production pin returns skill_key_unset before fetching. A newer package bootstrap supersedes older installed state (`status.skill.state = bootstrap`). Unreadable/corrupt installed state uses that bootstrap with `skill_state_invalid`; corrupt update metadata resets to idle update work and reports the same code. These failures never block status, send, receive or ACK. Each heartbeat carrying a hint resets its bounded retry budget; a different unverified hint can replace a higher version, while verified high-water still rejects downgrades. Hint whats_new and protocol-incompatible notices are advisory, never executable instructions. No binary auto-update controls exist.

## Errors

Exit codes: 0 success, 1 usage, 2 relay, 3 invalid_token, 4 local state/selftest. Error output is metadata-only: no JSON bodies, file contents, Health values, tokens or credentials. Retain the code when reporting to the owner. After invalid_token, stop and tell the owner; never automatically register again. Removed commands fail with usage exit 1. Migration helper codes below describe owner-assisted offline migration, never automatic migration by the runtime.

| Code | Meaning / response |
| --- | --- |
| `invalid_uri` | Pairing URI is malformed; ask the owner for a matching environment, never echo its credentials. |
| `insecure_relay` | Use HTTPS except an explicitly chosen local test relay. |
| `unsupported_version` | Unsupported transport or pairing version; retain data and update the endpoint. |
| `inner_invalid` | Authenticated bytes are not a bounded UTF-8 JSON object with a string type or violate a marker. |
| `member_revoked` | Member trust was revoked; retain history and tell the owner. |
| `aead_failed` | Transport, protected-state or verification failure; inspect metadata and correct the cause before retrying. |
| `already_initialized` | Reuse the identity; init refuses this home. |
| `ambiguous_target` | Select exactly one confirmed phone with --to. |
| `attestation_required` | Transport, protected-state or verification failure; inspect metadata and correct the cause before retrying. |
| `client_outdated` | Transport, protected-state or verification failure; inspect metadata and correct the cause before retrying. |
| `corrupt_state` | Transport, protected-state or verification failure; inspect metadata and correct the cause before retrying. |
| `fingerprint_mismatch` | Do not confirm; compare the owner’s phone digits again. |
| `forbidden` | Transport, protected-state or verification failure; inspect metadata and correct the cause before retrying. |
| `held_overflow` | Transport, protected-state or verification failure; inspect metadata and correct the cause before retrying. |
| `held_unconfirmed` | Transport, protected-state or verification failure; inspect metadata and correct the cause before retrying. |
| `home_locked` | Transport, protected-state or verification failure; inspect metadata and correct the cause before retrying. |
| `hpke_open_failed` | Transport, protected-state or verification failure; inspect metadata and correct the cause before retrying. |
| `hub_full` | Transport, protected-state or verification failure; inspect metadata and correct the cause before retrying. |
| `hub_suspended` | Transport, protected-state or verification failure; inspect metadata and correct the cause before retrying. |
| `hub_unpaid` | Transport, protected-state or verification failure; inspect metadata and correct the cause before retrying. |
| `insecure_permissions` | Transport, protected-state or verification failure; inspect metadata and correct the cause before retrying. |
| `internal_error` | Transport, protected-state or verification failure; inspect metadata and correct the cause before retrying. |
| `invalid_arguments` | Correct command/tool arguments; do not add removed flags. |
| `invalid_assertion` | Transport, protected-state or verification failure; inspect metadata and correct the cause before retrying. |
| `invalid_attestation` | Transport, protected-state or verification failure; inspect metadata and correct the cause before retrying. |
| `invalid_config` | Transport, protected-state or verification failure; inspect metadata and correct the cause before retrying. |
| `invalid_envelope` | Transport, protected-state or verification failure; inspect metadata and correct the cause before retrying. |
| `invalid_input` | Transport, protected-state or verification failure; inspect metadata and correct the cause before retrying. |
| `invalid_invite` | Transport, protected-state or verification failure; inspect metadata and correct the cause before retrying. |
| `invalid_plan_proof` | Transport, protected-state or verification failure; inspect metadata and correct the cause before retrying. |
| `invalid_request` | Transport, protected-state or verification failure; inspect metadata and correct the cause before retrying. |
| `invalid_response` | Transport, protected-state or verification failure; inspect metadata and correct the cause before retrying. |
| `invalid_secrets` | Transport, protected-state or verification failure; inspect metadata and correct the cause before retrying. |
| `invalid_state` | Transport, protected-state or verification failure; inspect metadata and correct the cause before retrying. |
| `invalid_token` | Relay refused the identity; tell the owner and retain local history. |
| `invalid_transition` | Transport, protected-state or verification failure; inspect metadata and correct the cause before retrying. |
| `invalid_url_scheme` | Transport, protected-state or verification failure; inspect metadata and correct the cause before retrying. |
| `key_conflict` | Transport, protected-state or verification failure; inspect metadata and correct the cause before retrying. |
| `key_mismatch` | Transport, protected-state or verification failure; inspect metadata and correct the cause before retrying. |
| `local_error` | Transport, protected-state or verification failure; inspect metadata and correct the cause before retrying. |
| `malformed` | Transport, protected-state or verification failure; inspect metadata and correct the cause before retrying. |
| `method_not_allowed` | Transport, protected-state or verification failure; inspect metadata and correct the cause before retrying. |
| `migration_conflict` | Transport, protected-state or verification failure; inspect metadata and correct the cause before retrying. |
| `migration_failed` | Transport, protected-state or verification failure; inspect metadata and correct the cause before retrying. |
| `migration_required` | Stop the old service; owner-assisted offline export is required. |
| `migration_source_changed` | Transport, protected-state or verification failure; inspect metadata and correct the cause before retrying. |
| `msg_id_conflict` | Transport, protected-state or verification failure; inspect metadata and correct the cause before retrying. |
| `network_error` | Transport, protected-state or verification failure; inspect metadata and correct the cause before retrying. |
| `not_a_recipient` | Transport, protected-state or verification failure; inspect metadata and correct the cause before retrying. |
| `not_found` | Transport, protected-state or verification failure; inspect metadata and correct the cause before retrying. |
| `not_initialized` | Transport, protected-state or verification failure; inspect metadata and correct the cause before retrying. |
| `pair_proof_invalid` | Data remains held; owner fingerprint comparison is required. |
| `pairing_expired` | Transport, protected-state or verification failure; inspect metadata and correct the cause before retrying. |
| `pairing_not_found` | Transport, protected-state or verification failure; inspect metadata and correct the cause before retrying. |
| `payload_too_large` | Transport, protected-state or verification failure; inspect metadata and correct the cause before retrying. |
| `plan_in_use` | Transport, protected-state or verification failure; inspect metadata and correct the cause before retrying. |
| `plan_insufficient` | Transport, protected-state or verification failure; inspect metadata and correct the cause before retrying. |
| `plan_verifier_unavailable` | Transport, protected-state or verification failure; inspect metadata and correct the cause before retrying. |
| `protocol_incompatible` | Transport, protected-state or verification failure; inspect metadata and correct the cause before retrying. |
| `rate_limited` | HTTP 429: for queued outbox sends, the outbox retries automatically after Retry-After when the receiver runs; the caller does not resend. Inspect status.transport.send_lanes and pending sends for deadlines. |
| `relay_error` | Transport, protected-state or verification failure; inspect metadata and correct the cause before retrying. |
| `relay_event` | Transport, protected-state or verification failure; inspect metadata and correct the cause before retrying. |
| `resource_failed` | Verified skill resource unavailable; report the safe code. |
| `result_too_large` | Use a smaller inbox page. |
| `schema_invalid` | Optional local schema rejected the JSON; correct the caller payload. |
| `schema_too_new` | Transport, protected-state or verification failure; inspect metadata and correct the cause before retrying. |
| `send_failed` | Transport, protected-state or verification failure; inspect metadata and correct the cause before retrying. |
| `send_retry` | Transport, protected-state or verification failure; inspect metadata and correct the cause before retrying. |
| `skill_document_invalid` | Transport, protected-state or verification failure; inspect metadata and correct the cause before retrying. |
| `skill_downgrade` | Transport, protected-state or verification failure; inspect metadata and correct the cause before retrying. |
| `skill_fetch_failed` | Transport, protected-state or verification failure; inspect metadata and correct the cause before retrying. |
| `skill_fetch_timeout` | Transport, protected-state or verification failure; inspect metadata and correct the cause before retrying. |
| `skill_key_invalid` | Transport, protected-state or verification failure; inspect metadata and correct the cause before retrying. |
| `skill_key_unset` | No production update pin; bundled skill remains usable offline. |
| `skill_response_invalid` | Transport, protected-state or verification failure; inspect metadata and correct the cause before retrying. |
| `skill_signature_invalid` | Transport, protected-state or verification failure; inspect metadata and correct the cause before retrying. |
| `skill_state_invalid` | Installed skill or update metadata is unreadable/invalid; inspect status.skill. Package bootstrap or the valid installed bundle remains usable; transport continues. |
| `skill_url_invalid` | Transport, protected-state or verification failure; inspect metadata and correct the cause before retrying. |
| `skill_version_conflict` | Transport, protected-state or verification failure; inspect metadata and correct the cause before retrying. |
| `skill_version_mismatch` | Transport, protected-state or verification failure; inspect metadata and correct the cause before retrying. |
| `skill_write_failed` | Transport, protected-state or verification failure; inspect metadata and correct the cause before retrying. |
| `target_not_confirmed` | The selected phone is unconfirmed, revoked or unpaired. |
| `target_revoked` | Transport, protected-state or verification failure; inspect metadata and correct the cause before retrying. |
| `tx_async` | Thin home mutations must be synchronous; retry with a synchronous mutation. |
| `timeout` | Transport, protected-state or verification failure; inspect metadata and correct the cause before retrying. |
| `tool_failed` | Transport, protected-state or verification failure; inspect metadata and correct the cause before retrying. |
| `unknown_member` | Transport, protected-state or verification failure; inspect metadata and correct the cause before retrying. |
| `unknown_recipient` | Transport, protected-state or verification failure; inspect metadata and correct the cause before retrying. |
| `unknown_sender` | Transport, protected-state or verification failure; inspect metadata and correct the cause before retrying. |
| `unsafe_ack` | ACK exceeds the durable checkpoint; receive first. |
| `unsupported_media_type` | Transport, protected-state or verification failure; inspect metadata and correct the cause before retrying. |

| 403 | `invalid_assertion` | E13/E16/E17 (phone only): bad assertion encoding, signature, App ID, counter or timestamp (missing, malformed or outside ±5 minutes of the relay clock), or an assertion sent for a pairing without a stored key | an agent never sees it; the phone immediately offers explicit unpair and pairing with a new agent code, without an assertion retry or key reset; it retains the bearer for E8/E9 self-revocation and E18 subject requests |

| 426 | `client_outdated` | a valid `X-Syncky-App-Version` states a version below the relay minimum | upgrade the app, then try again; do not automatically retry, unpair, revoke credentials or reset attestation; retain queued data and pending acknowledgements |


Phone access request details: use `syncky send --type access_request --json <file|-> --validate` after explicit owner approval. Select the sole confirmed phone automatically; use `--to <member_id>` when several are confirmed. Access reasons are plain text, at most 200 Unicode code points; there is no item-count cap, but both request and reply must fit 4096 bytes. The phone applies one pending slot (`pending_limit`), one admission per rolling 24 hours, a 24-hour deadline and seven-day declined-type wait. Health read permission is unobservable. For `needs_health_settings`, follow the phone's conditional instructions at **Health › Sharing › Apps › Syncky**; stored scope is not read authorization. Repeated sends reuse byte-identical ciphertext; update old endpoints before retrying unsupported requests. Approval to request access is separate from permission to write Health values.

AAD appends `|control` before the optional `|diagnostics=<value>` or `|access=<value>` (mutually exclusive). Marked traffic uses an independent relay lane on every plan for diagnostics; access uses ordinary shared relay limits, including HTTP 429 Retry-After. Never strip authenticated markers to bypass a refusal.

The phone's Check the relay connection prepares no upload. A notification tap opens Review for its matching pending request and prepares a preview locally without sending. Only manual Send or Confirm sends a report; decline sends only a small encrypted reply. Arrival alone prepares nothing. APNs acceptance is not delivery. Reports remain private untrusted JSON in the raw 30-day inbox; no local diagnostics retention scheduler or cooldown exists.

Poll metadata uses `poll_interval_s`, `last_poll_at`, `last_ack_at`, `next_poll_at`, `poll_retry_at` and `ack_retry_at`. Receive caches E14 hub state on startup, at most every five minutes, and after hub events; older in-flight responses cannot overwrite newer events. Read-only status never refreshes it. Sending does not bypass the cadence; after first sync completes, use the advertised interval when waiting for new replies. Hub deletion/revocation never clears local history; use a new home only with owner approval.
