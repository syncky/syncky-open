# Security

Please report a vulnerability privately: open this repository's **Security** tab and choose **Report a vulnerability** (GitHub private vulnerability reporting). Do not open a public issue for it.

In scope: the protocol (schemas, vectors, the rules in `protocol/README.md`), the reference agent, the minimal agent, the minimal server and the own-server template (Worker and Docker) in this repository, and the Syncky relay and app behaviour they describe.

Please include what you found, how to reproduce it and what an attacker gains. Never send real health data, tokens, webhook secrets or private keys in a report.

## You operate it

You operate the template in your own hosting account, under your provider contract and chosen location, including possible United States processing. The EU Durable Object setting limits its execution/storage, not the edge Worker, object metadata/logs or AI providers. It does not guarantee EU-only processing. The template has no telemetry and no update channel: review a new source tag, back up and redeploy manually.

Keep upload/HMAC credentials private; rotate them in the admin page and re-import the one-time setup link on the phone. The server requires explicit OAuth consent identifying the client, exact Health types and health/fitness purpose before AI disclosure. Review training/privacy settings and revoke access on Granted clients. Revocation cannot recall an emitted reply or erase AI-provider copies. Use local export pages, erase server data and remove the Worker plus Durable Object storage, or Docker volume, and all exports/backups/recovery copies under your provider's retention rules. Deleting code or a container alone does not delete storage.

The template is outside the Syncky service, freely available without a subscription gate, with best-effort help through support@syncky.app and no SLA. Hosting and AI-provider accounts/costs are yours. Other people's data requires your own legal basis. Mandatory consumer rights and statutory liability remain unaffected.

Security fixes for the agent and own-server template follow tagged releases. Watch this repository and review release notes; the template has no automatic security update delivery. Use the private reporting channel above for either runtime.
