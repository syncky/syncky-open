import { renderTerminalQr } from './pairing.js';
import { PAIRING_LIMITS_NOTICE } from './cli-commands.js';
export { PAIRING_LIMITS_NOTICE };

const limits = Object.freeze({ hosted_defaults: Object.freeze({ pairing_link_ttl_s: 600, unjoined_hub_ttl_s: 86400 }),
  pairing_link_deadline: 'expires_at', unjoined_hub_clock: 'registration' });

export function pairOutput(started, { json = false, noQr = false } = {}) {
  if (json) return JSON.stringify({ ...started, qr_text: noQr ? null : renderTerminalQr(started.uri), limits }) + '\n';
  return `Pairing link (${started.uri.startsWith('https://') ? 'open on the iPhone with Syncky Health' : 'scan inside Syncky Health or paste there'}, single use, expires ${started.expires_at}):\n` + started.uri + '\n' + (noQr ? '' : renderTerminalQr(started.uri))
    + (started.code ? 'Pairing code: ' + started.code + '\n' : '')
    + (started.qr_png ? 'Private QR PNG: ' + started.qr_png + '\n' : '')
    + (started.qr_svg ? 'Private QR SVG: ' + started.qr_svg + '\n' : '')
    + PAIRING_LIMITS_NOTICE + 'Link expires_at: ' + started.expires_at + '\n';
}
