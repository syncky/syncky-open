# Your own Syncky server

A self-hosted server template under Apache-2.0: one plain-JavaScript Fetch handler and SQLite repository, with Worker and Docker alternatives. It stores native uploads from your iPhone and exposes OAuth-protected remote MCP. No pairing or Syncky agent is needed. There are no runtime dependencies and no Syncky OAuth, hostname or proxy in the data/auth path.

The template is freely available without a subscription gate. You provide hosting and any AI-provider accounts. Hosting limits and charges, AI-provider plans and the app's entitlements are separate; a free hosting allowance depends on measured usage. The app currently includes Sync during Launch; server writes require the Sync entitlement. This is a recipe outside the Syncky service, not a hosted service.

## Choose a runtime

Use a source tag containing this directory from [syncky-open releases](https://github.com/syncky/syncky-open/releases). Real deployments, Deploy prompts, Docker images and AI-client compatibility remain unverified. Never assume a local standards test proves compatibility with a real client.

Admin password rotation is unsupported after the first successful login: login checks both `ADMIN_PASSWORD` and the password verifier saved in storage. Changing only the deployment secret locks out both old and new passwords. Keep the original password privately and retain it across Worker redeploys and Docker restarts. If you changed it, restore the original value to regain login access. There is no supported admin-password reset flow.

### Worker with SQLite Durable Object

1. In this directory, run `npm ci` with Node >=22.15. This installs only the pinned test/build tools. Review `wrangler.jsonc`: it has no Syncky account, domain or proxy configuration and disables observability.
2. Deploy to your own Cloudflare account using your hosting tool. For a first Wrangler deployment, put only `ADMIN_PASSWORD` in a private, ignored `.dev.vars` file (permissions 600), then use `npm exec -- wrangler deploy --secrets-file .dev.vars`. The required secret must accompany the first deployment. Requests fail closed without the password. Do not put its value in source or command arguments. `.dev.vars.example` declares only its empty name for Deploy discovery; `secrets.required` validates its presence.
3. Use the deployment's HTTPS origin for the admin and MCP connections below. The only required deployment secret is `ADMIN_PASSWORD`; upload, HMAC and OAuth material are generated inside your deployment on the first authenticated login.

The future **Deploy to Cloudflare** link syntax is shown below as text, not an active Deploy button. Publication must first select and verify a real tag, then substitute it for `<published-tag>` and verify the secret prompt and storage provisioning. This is a plain outbound link without callback or tracking:

```text
https://deploy.workers.cloudflare.com/?url=https://github.com/syncky/syncky-open/tree/<published-tag>/examples/own-server
```

`DO_JURISDICTION` defaults to `eu`. An empty string chooses unrestricted placement. Changing it selects different storage: plan an export/storage move or redeployment, rather than expecting existing data to migrate. EU jurisdiction limits Durable Object execution and storage. The edge Worker can process plaintext globally; object metadata/logs and AI providers can be outside the EU, including the United States. This does not guarantee EU-only processing. Local workerd tests use unrestricted placement because they cannot enforce jurisdiction restrictions.

### Docker with Node SQLite

Use this directory as the build context. Set `ADMIN_PASSWORD` privately in your environment and `PUBLIC_URL` to the canonical public HTTPS origin (no path). Run `docker compose -f docker/compose.yaml up --build -d` behind your own HTTPS reverse proxy. This builds from source; no published image is assumed. Compose exposes only `127.0.0.1:3000:3000`. Provide TLS and preserve the canonical host; forwarded host headers cannot change the server's origin.

The pinned base is `node:22.15.0-bookworm-slim`. The non-root Node user stores `own-server.sqlite` in the named volume at `/data`; a bind mount must be writable by UID 1000. `DATABASE_PATH` and `PORT` override `/data/own-server.sqlite` and `3000` when running the Node entry directly. Encrypt the host disk and protect backups. Stop the server or use a consistent SQLite backup method; do not copy only the database while ignoring its WAL/SHM sidecars. `/health` returns only a constant health check, not storage readiness or Health values.

## Connect your iPhone

1. Open `/admin/login` on your deployment's HTTPS origin and enter the admin password. The first successful deployment-local login generates distinct upload, HMAC and OAuth/session material. The private native setup link is shown once. Save it privately or open it on your iPhone; never send it to an online QR service, logs or support.
2. Import/open the link in Syncky Health and confirm the server. It fixes `format=native` and `/server`, defaults to Bearer plus HMAC, and cannot enable writes. Choose Health types in the app. HAE, CSV, Influx and unknown formats receive `415 unsupported_format`.
3. Use **Check connection**, which sends a probe with no Health data. Then use **Sync now** with selected data. A successful probe proves connection/authentication, not stored Health data or permission to read it.

Authentication can instead use Basic or a validated custom header; unauthenticated internet mode is unsupported. Admin settings changes to upload authentication, HMAC or app scheme take effect on explicit rotation. Default scheme is `syncky`; choose `syncky-dev` or `syncky-staging` only for that build, rotate and re-import. Admin, upload and OAuth credentials cannot substitute for each other.

The [server contract](../../protocol/server.md) and [public vectors](../../protocol/test-vectors/) define the exact bytes. These request distinctions matter:

| Request example | Server behavior |
| --- | --- |
| Native data: `X-Syncky-Format: native`, JSON `samples`, `deleted` and optional `summaries` | Commit the whole batch before success; deduplicate samples and replace summaries without adding them to raw coverage. |
| Check connection: native JSON with `delivery.test: true` | Empty `200`, no stored Health data and no commands. |
| Results: `X-Syncky-Kind: results`, no format header | Empty `200`; record the latest command's applied/rejected result and never return commands. |

## Authorize an AI client

1. In `/admin`, review the exact HTTPS callback allowlist. Register your remote MCP client against your origin's `/mcp`, using discovery and dynamic registration or a manual client from **Granted clients** (`/admin/clients`). The server uses S256 PKCE and short access tokens (5 minutes), with rotated refresh tokens. A manual confidential client secret is shown once. Registrations without a first grant expire after 24 hours. Dynamic registration admits clients only below 32 total registrations; eight additional slots are reserved for admin-created manual clients. Dynamic and manual registration each allow 10 attempts per hour. If dynamic registration is full, create a manual client or remove unused registrations on the clients page.
2. Sign in to this server when OAuth opens its consent page. Before any MCP disclosure, the server requires explicit OAuth consent naming the registered client/id/callback host, exact selected Health types and purpose: answer your personal health and fitness questions. Client names are untrusted labels, not proof of brand identity. Approve only the intended types, or Deny.
3. Check the AI provider's privacy, retention and model-training settings before approving, including whether training on your data can be disabled. Your AI account and its terms govern those copies. The server does not call an AI provider itself.
4. Start with the read-only `syncky_status` and bounded `syncky_query`: one consented type, separate samples/summaries, default last 7 days, maximum 31 days and 1–200 rows per page. Missing data means unknown. Summaries and raw samples are separate provenance, not quantities to add together. No chats are stored.

Queries filter dated samples and summaries by their start instant. Activity summaries use their native calendar date, including both UTC calendar dates selected by since/until; undated characteristics use the server's receipt time. Query and export pages load payloads incrementally within their byte budgets. A single row too large for a page returns an explicit error.

Claude.ai and ChatGPT callback defaults are present in the allowlist. Their deployed discovery, registration, S256/resource exchange, consent, reads and revocation remain unverified. Gemini web custom remote MCP support is unconfirmed. Add another exact callback only after checking your client's own documentation; no wildcard or automatic fallback is supported.

## Optional writes and recovery

Writes are disabled by default. To enable `syncky_write`, turn on **Allow newly consented writes** in `/admin` and obtain fresh explicit per-client write consent for the intended types. The tool only queues commands for the next ordinary data reply. In the app, this direct server's **Accept writes to Health** setting must be on. The app applies writes only for supported types in its per-type write allowance, with iOS Health write permission and the Sync entitlement. There is no prompt per write. These controls grant permission only; each command should reflect the owner's intended entry.

A write must name a known destination/device, supported type, stable `command_id` and increasing `version`. It is queued for the next ordinary data reply, capped at 60,000 UTF-8 bytes and signed when HMAC is enabled. There is no push, wake-up, cron or delivery-time guarantee. iOS schedules background work and Health reads need an unlocked iPhone. If there is no new data, there is no ordinary upload and the command waits; a probe or results request cannot collect it.

Queued or delivered is not applied: read the phone's latest applied/rejected result. Eligible commands repeat until that result. Correct a rejection using the same id and a higher version; deletion also uses version + 1 and can reference only that client's prior command. Fresh consent for the same client and type permits new versions of its completed commands. Do not invent successful writes from an empty response. Real-device timing and direct own-write re-upload behavior remain unverified.

Disabling writes pauses all unfinished delivery, including retries; enabling resumes only commands with an active matching grant. Revoke on **Granted clients** stops future MCP access/refresh and permanently cancels that grant's unfinished deliveries, across restarts. Fresh consent cannot revive cancelled commands. An already emitted reply cannot be recalled and late phone results remain accepted. Revocation does not erase stored Health data or AI-provider copies.

For a failed connection, check HTTPS origin, credential rotation/re-import, native format and device time (HMAC allows 300 seconds of skew). For missing data, open/unlock the phone, verify Health selection/permissions and sync; do not treat missing data as zero. For a queued write, check every write control and the latest result, then wait for an ordinary data upload. Respect rate-limit retry delays; do not loop registrations or write attempts.

## You operate it

This runs in your own hosting account under your provider contract and chosen location, with possible United States processing. It is not operated by Syncky. The Durable Object EU boundary does not confine the edge Worker, metadata/logs or AI-provider processing. There is no telemetry, heartbeat or outgoing update check, and no update channel. Updates are manual: review a new source tag, back up and redeploy. Monitor tagged releases and [security reports](../../SECURITY.md) yourself.

Keep setup links and upload/HMAC secrets private. Use **Rotate upload credentials and show link once**, then re-import on every phone; saving settings alone does not rotate them. Use **Granted clients** to review consent and revoke AI access. Neither action deletes copies already shared with a provider; use that provider's deletion controls separately.

Retention has no automatic history expiry: records remain until a phone deletion or operator erasure. Use `/admin/export` for local pages of samples, summaries and results (up to 200 rows); follow each `next_cursor` until null and export each kind separately. Store exported files privately. **Erase and rotate upload credentials** deletes local Health/commands/results/grants/tokens and rotates upload secrets. It does not remove entries already written to the phone's Health store; use the app's remove-written-entries controls for those. Full deletion also requires removing the Worker and its Durable Object storage, or the Docker container and named volume, plus exports and all backups/recovery copies under your provider's retention rules. Deleting Worker code or a container alone is insufficient.

For other people's data, you need your own legal basis and applicable safeguards; personal use is not a blanket exemption for professional or shared hosting. Help is best effort through support@syncky.app, with no SLA. The template is outside the Syncky service; mandatory consumer rights and statutory liability remain unaffected. Never include credentials, bodies, full URLs or Health values in reports.

## Local checks

With Node >=22.15, `npm ci` installs exact dev pins: wrangler 4.124.0, vitest 4.1.11 and @cloudflare/vitest-pool-workers 0.22.0. `npm test` runs shared, real Worker/DO and Node HTTP/SQLite tests. `npm run test:core` runs shared tests only. `npm run build:worker` is a local Wrangler dry-run that fails on warnings; it never deploys. Tests require only this package and the sibling public protocol vectors. Image building, live placement and real-client checks are separate operator checks.
