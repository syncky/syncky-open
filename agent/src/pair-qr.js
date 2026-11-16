import nodeFs from 'node:fs';
import { join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import QRCode from 'qrcode-terminal/vendor/QRCode/index.js';
import QRErrorCorrectLevel from 'qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel.js';
import { LocalStateError } from './config.js';
import { privateDirectory, privateStat, syncDirectory, writeAll } from './protected-files.js';
import { isPairingId } from './ids.js';

export const QR_QUIET_ZONE = 4;
// Chat panes are narrow; two modules on a solid screen still scan, and the image files keep the full margin.
export const QR_TERMINAL_QUIET_ZONE = 2;

export function pairingQr(uri) {
  const qr = new QRCode(-1, QRErrorCorrectLevel.L);
  qr.addData(uri); qr.make();
  return qr.modules;
}

const dark = (matrix, x, y, zone) => matrix[y - zone]?.[x - zone] === true;

export function renderTerminalQr(uri) {
  const matrix = pairingQr(uri), size = matrix.length + QR_TERMINAL_QUIET_ZONE * 2;
  let text = '';
  for (let y = 0; y < size; y += 2) {
    for (let x = 0; x < size; x++) text += dark(matrix, x, y, QR_TERMINAL_QUIET_ZONE) ? (dark(matrix, x, y + 1, QR_TERMINAL_QUIET_ZONE) ? ' ' : '▄') : (dark(matrix, x, y + 1, QR_TERMINAL_QUIET_ZONE) ? '▀' : '█');
    text += '\n';
  }
  return text;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, bytes) {
  const body = Buffer.concat([Buffer.from(type), bytes]), length = Buffer.alloc(4), crc = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

export function qrPng(matrix) {
  const scale = 8, size = (matrix.length + QR_QUIET_ZONE * 2) * scale, header = Buffer.alloc(13), pixels = Buffer.alloc((size + 1) * size);
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) pixels[y * (size + 1) + x + 1] = dark(matrix, Math.floor(x / scale), Math.floor(y / scale), QR_QUIET_ZONE) ? 0 : 255;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

export function qrSvg(matrix) {
  const size = matrix.length + QR_QUIET_ZONE * 2, paths = [];
  for (let y = 0; y < matrix.length; y++) for (let x = 0; x < matrix.length; x++) if (matrix[y][x]) paths.push(`M${x + QR_QUIET_ZONE} ${y + QR_QUIET_ZONE}h1v1h-1z`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size * 8}" height="${size * 8}" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><path fill="#fff" d="M0 0h${size}v${size}H0z"/><path fill="#000" d="${paths.join('')}"/></svg>\n`;
}

export function cleanupPairingQr(home, liveId, { fs = nodeFs } = {}) {
  try {
    privateStat(home, { fs, directory: true });
    const directory = join(home, 'pairing-qr');
    if (!privateStat(directory, { fs, directory: true, optional: true })) return;
    for (const name of fs.readdirSync(directory)) {
      if (isPairingId(liveId) && ['png', 'svg'].some(format => name === `${liveId}.${format}`)) continue;
      try {
        const path = join(directory, name);
        if (fs.lstatSync(path).isFile()) fs.unlinkSync(path);
      } catch {}
    }
    syncDirectory(directory, { fs });
  } catch {}
}

export function createPairingQrFiles(home, doc, { qrPng: png, qrSvg: svg } = {}, { fs = nodeFs } = {}) {
  if (![png, svg].every(flag => flag === undefined || typeof flag === 'boolean') || !isPairingId(doc.pairing_id)) throw new LocalStateError('invalid_input', 'QR images require boolean flags and a valid pairing');
  if (!png && !svg) return {};
  const directory = privateDirectory(resolve(home, 'pairing-qr'), { fs }), files = {};
  try {
    const matrix = pairingQr(doc.uri);
    for (const [format, enabled] of [['png', png], ['svg', svg]]) {
      if (!enabled) continue;
      const absolute = join(directory, `${doc.pairing_id}.${format}`);
      const fd = fs.openSync(absolute, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      try {
        files['qr_' + format] = absolute;
        fs.fchmodSync(fd, 0o600);
        writeAll(fd, format === 'png' ? qrPng(matrix) : qrSvg(matrix), { fs }); fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
    }
    syncDirectory(directory, { fs });
    return files;
  } catch {
    for (const path of Object.values(files)) { try { fs.unlinkSync(path); } catch {} }
    throw new LocalStateError('invalid_input', 'QR image requires a new file in the private pairing-qr directory');
  }
}
