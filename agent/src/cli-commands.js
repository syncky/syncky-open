export const PAIRING_LIMITS_NOTICE = 'Hosted default pairing-link lifetime: 10 minutes; expires_at from the relay is authoritative.\nHosted default never-joined hub lifetime: 24 hours from registration; creating another link does not restart it.\n';

export const globalFlags = { home: 'string', relay: 'string', 'url-scheme': 'string', 'log-level': 'string', help: 'boolean' };
export const commands = {
  init: { usage: 'init --name <name>', details: 'Relay: HTTP(S) origin without credentials, path, query or fragment. HTTPS is recommended; non-loopback HTTP warns once per process and host, while loopback HTTP stays quiet. Saved config.json relay_url binds the home; --relay/SYNCKY_RELAY_URL overrides must match its canonical origin. Redirects are refused.', flags: { name: 'string', invite: 'string' } },
  pair: { usage: 'pair [--read <comma-separated-types>] [--write <comma-separated-types>] [--v1] [--wait] [--timeout <seconds>] [--no-qr]', details: PAIRING_LIMITS_NOTICE.trimEnd(), flags: { read: 'string', write: 'string', v1: 'boolean', wait: 'boolean', timeout: 'string', 'no-qr': 'boolean' } },
  wait: { usage: 'wait [--timeout <seconds>]', flags: { timeout: 'string' } },
  confirm: { usage: 'confirm <member_id> <fingerprint>', max: 8 },
  reject: { usage: 'reject <member_id>', max: 1, details: 'Reject a joined phone locally, then revoke it on the relay. Discard held ciphertext; pending sends to that phone fail. Received history remains subject to normal 30-day retention or earlier owner-approved syncky forget <member_id> --yes. If the relay call fails, local rejection remains: run syncky revoke <member_id> after the relay is reachable or the token is fixed. After invalid_token, stop and tell the owner.' },
  revoke: { usage: 'revoke <member_id>', max: 1, details: 'Revoke a known phone on the relay, then stop trusting it locally. Discard held ciphertext; pending sends to that phone fail. Received history remains subject to normal 30-day retention or earlier owner-approved syncky forget <member_id> --yes.' },
  forget: { usage: 'forget <member_id> [--yes]', max: 1, flags: { yes: 'boolean' } },
  status: { usage: 'status' },
  send: { usage: 'send --type <type> --json <file|-> [--to <member_id>] [--validate]', details: 'Returns a metadata receipt: pending is queued for receiver retry, sent is relay acceptance only, failed is terminal. Inspect code, relay_code, relay_status and optional fixed hint; pending and failed receipts still exit 0. Do not resend a pending message. Phone application is reported separately in inbox replies.', flags: { type: 'string', to: 'string', validate: 'boolean' } },
  inbox: { usage: 'inbox [--type <type>] [--member <member_id>] [--after-seq <seq>] [--since <date>] [--until <date>] [--limit <n>]', details: 'Pages scan at most 64 MiB / 10,000 records, including filtered records. Budget exhaustion after progress returns a partial page with has_more and next_after_seq at the last scanned cursor. Continue from that cursor, even for an empty page. On inbox_scan_limit no cursor progress fit; use a narrower date range and retain history.', flags: { type: 'string', member: 'string', 'after-seq': 'string', since: 'string', until: 'string', limit: 'string' } },
  receive: { usage: 'receive [--once] [--poll-interval <seconds>] [--emit-records]', flags: { once: 'boolean', 'poll-interval': 'string', 'emit-records': 'boolean' } },
  ack: { usage: 'ack --up-to-seq <seq>', flags: { 'up-to-seq': 'string' } },
  skill: { usage: 'skill [--diff]', flags: { diff: 'boolean' } },
  mcp: { usage: 'mcp' },
  selftest: { usage: 'selftest' },
  help: { usage: 'help [command]', max: 1 },
};
export const commandNames = () => Object.keys(commands);
