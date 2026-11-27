const MAX_CONTROL_ENVELOPE_BYTES = 4096;
const MAX_ACCESS_ENVELOPE_BYTES = 131072;
const MAX_PAIRING_SCOPE_BLOB_BYTES = 12000;
const MAX_PAIRING_SCOPE_BLOB_CHARS = 16000;
const MAX_PAIRING_REQUEST_BODY_BYTES = 16384;

export const PAIRING_BYTE_LIMITS = Object.freeze({
  max_pairing_scope_blob_bytes: MAX_PAIRING_SCOPE_BLOB_BYTES,
  max_pairing_scope_blob_base64url_chars: MAX_PAIRING_SCOPE_BLOB_CHARS,
  max_pairing_request_body_bytes: MAX_PAIRING_REQUEST_BODY_BYTES,
  max_control_envelope_bytes: MAX_CONTROL_ENVELOPE_BYTES,
  max_access_envelope_bytes: MAX_ACCESS_ENVELOPE_BYTES,
});
const envelopeLimits = `Complete UTF-8 envelope limits: ${MAX_CONTROL_ENVELOPE_BYTES} bytes for ordinary controls, ${MAX_ACCESS_ENVELOPE_BYTES} bytes for access requests and replies.`;
export const PAIRING_LIMITS_NOTICE = 'Hosted default pairing-link lifetime: 10 minutes; expires_at from the relay is authoritative.\nHosted default never-joined hub lifetime: 24 hours from registration; creating another link does not restart it.\n'
  + `Encrypted pairing scope: ${MAX_PAIRING_SCOPE_BLOB_BYTES} bytes, ${MAX_PAIRING_SCOPE_BLOB_CHARS} base64url characters. Hosted pairing body: ${MAX_PAIRING_REQUEST_BODY_BYTES} bytes.\n${envelopeLimits}\n`;

export const globalFlags = { home: 'string', relay: 'string', 'url-scheme': 'string', 'log-level': 'string', help: 'boolean' };
export const commands = {
  init: { usage: 'init --name <name>', details: 'Relay: HTTP(S) origin without credentials, path, query or fragment. HTTPS is recommended; non-loopback HTTP warns once per process and host, while loopback HTTP stays quiet. Saved config.json relay_url binds the home; --relay/SYNCKY_RELAY_URL overrides must match its canonical origin. Redirects are refused.', flags: { name: 'string', invite: 'string' } },
  pair: { usage: 'pair [--read <comma-separated-types>] [--write <comma-separated-types>] [--v1] [--show-qr] [--qr-png] [--qr-svg] [--wait] [--timeout <seconds>] [--no-qr]', details: 'Print the pairing link, QR and code. With --v1, requested types are sent as an access request after fingerprint confirmation. --show-qr reprints the current live pairing without creating a link; cannot combine with --v1, --read or --write. QR images are created exclusively at <home>/pairing-qr/<pairing_id>.png or .svg (directory 0700, file 0600). Existing files and symlinks are refused. Stale images are swept on pairing commands, completion, replacement and expiry; cleanup errors do not interrupt pairing. --json includes qr_text (null with --no-qr) and absolute qr_png/qr_svg paths when present.\n' + PAIRING_LIMITS_NOTICE.trimEnd(), flags: { read: 'string', write: 'string', v1: 'boolean', 'show-qr': 'boolean', 'qr-png': 'boolean', 'qr-svg': 'boolean', wait: 'boolean', timeout: 'string', 'no-qr': 'boolean' } },
  wait: { usage: 'wait [--timeout <seconds>]', flags: { timeout: 'string' } },
  confirm: { usage: 'confirm <member_id> <fingerprint>', max: 8 },
  reject: { usage: 'reject <member_id>', max: 1, details: 'Reject a joined phone locally, then revoke it on the relay. Discard held ciphertext; pending sends to that phone fail. Received history remains subject to normal 30-day retention or earlier owner-approved syncky forget <member_id> --yes. If the relay call fails, local rejection remains: run syncky revoke <member_id> after the relay is reachable or the token is fixed. After invalid_token, stop and tell the owner.' },
  revoke: { usage: 'revoke <member_id>', max: 1, details: 'Revoke a known phone on the relay, then stop trusting it locally. Discard held ciphertext; pending sends to that phone fail. Received history remains subject to normal 30-day retention or earlier owner-approved syncky forget <member_id> --yes.' },
  forget: { usage: 'forget <member_id> [--yes]', max: 1, flags: { yes: 'boolean' } },
  status: { usage: 'status' },
  send: { usage: 'send --type <type> --json <file|-> [--to <member_id>] [--validate]', details: '--validate checks available local schemas and returns {"valid":true}. It sends nothing. Plain sends of access_request and scope_release validate before sending. Plain send returns a metadata receipt: pending is queued for receiver retry, sent is relay acceptance only, failed is terminal. Inspect code, relay_code, relay_status and optional fixed hint; pending and failed receipts still exit 0. Do not resend a pending message. Phone application is reported separately in inbox replies. ' + envelopeLimits + ` Syncky 0.1.5 drops access requests above ${MAX_CONTROL_ENVELOPE_BYTES} bytes.`, flags: { type: 'string', to: 'string', validate: 'boolean' } },
  inbox: { usage: 'inbox [--type <type>] [--member <member_id>] [--after-seq <seq>] [--since <date>] [--until <date>] [--limit <n>]', details: 'Pages scan at most 64 MiB / 10,000 records, including filtered records. Budget exhaustion after progress returns a partial page with has_more and next_after_seq at the last scanned cursor. Continue from that cursor, even for an empty page. On inbox_scan_limit no cursor progress fit; use a narrower date range and retain history.', flags: { type: 'string', member: 'string', 'after-seq': 'string', since: 'string', until: 'string', limit: 'string' } },
  receive: { usage: 'receive [--once] [--poll-interval <seconds>] [--emit-records]', details: '--poll-interval sets the configured cadence in whole seconds (300–86,400, inclusive, default 1800). --once skips that cadence. The ordinary client minimum between polls is 300 seconds. The first sync, pending command acknowledgments and pagination can allow earlier checks. Relay Retry-After can delay the next poll.', flags: { once: 'boolean', 'poll-interval': 'string', 'emit-records': 'boolean' } },
  ack: { usage: 'ack --up-to-seq <seq>', flags: { 'up-to-seq': 'string' } },
  skill: { usage: 'skill [--diff]', flags: { diff: 'boolean' } },
  mcp: { usage: 'mcp' },
  selftest: { usage: 'selftest' },
  help: { usage: 'help [command]', max: 1 },
};
export const commandNames = () => Object.keys(commands);
