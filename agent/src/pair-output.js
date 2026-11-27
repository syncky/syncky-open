import { renderTerminalQr } from './pairing.js';
import { PAIRING_BYTE_LIMITS, PAIRING_LIMITS_NOTICE } from './cli-commands.js';
import { POLL_INTERVAL_MIN_S } from './config.js';
export { PAIRING_LIMITS_NOTICE };

const limits = Object.freeze({ hosted_defaults: Object.freeze({ pairing_link_ttl_s: 600, unjoined_hub_ttl_s: 86400, poll_floor_s: POLL_INTERVAL_MIN_S }),
  pairing_link_deadline: 'expires_at', unjoined_hub_clock: 'registration', ...PAIRING_BYTE_LIMITS });

export function pairOutput(started, { json = false, noQr = false } = {}) {
  if (json) return JSON.stringify({ ...started, qr_text: noQr ? null : renderTerminalQr(started.uri), limits }) + '\n';
  const details = started.code ? 'QR block, HTTPS link, pairing code and expiry' : 'QR block, HTTPS link and expiry';
  return PAIRING_LIMITS_NOTICE + (started.qr_png ? 'QR PNG: ' + started.qr_png + '\n' : '')
    + (started.qr_svg ? 'QR SVG: ' + started.qr_svg + '\n' : '')
    + '\nPairing link (open on the iPhone with Syncky Health, single use):\n' + started.uri + '\n'
    + (noQr ? '' : '\n```text\n' + renderTerminalQr(started.uri) + '```\n\n')
    + (started.code ? 'Pairing code: ' + started.code + '\n' : '')
    + 'Link expires_at: ' + started.expires_at + '\n'
    + (noQr ? 'Run `pair --show-qr` for this home to display the QR block. ' : '')
    + `Show the owner the ${details} in this chat. Leave out image paths.\n`;
}
