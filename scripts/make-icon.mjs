/**
 * Generates build/icon.png, from which electron-builder derives the .icns and
 * .ico at package time.
 *
 * Hand-rolled rather than pulled from a design tool so the icon is reproducible
 * and reviewable: it is a script in the repo, not an opaque binary someone has
 * to trust. Run with `node scripts/make-icon.mjs`.
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = 1024;
const MARGIN = 72;
const CORNER = 200;

/** The accent blue from the app's stylesheet, so icon and UI agree. */
const TOP = [0x3d, 0x7a, 0xff];
const BOTTOM = [0x22, 0x4f, 0xc4];
const CARD = [0xff, 0xff, 0xff];

const pixels = Buffer.alloc(SIZE * SIZE * 4, 0);

function setPixel(x, y, [r, g, b], alpha) {
  if (alpha <= 0) return;
  const offset = (y * SIZE + x) * 4;
  const existing = pixels[offset + 3] / 255;
  const incoming = Math.min(1, alpha);
  const out = incoming + existing * (1 - incoming);
  if (out === 0) return;
  // Straight-alpha "over" compositing, so the rounded corners stay smooth.
  for (let channel = 0; channel < 3; channel++) {
    const under = pixels[offset + channel];
    pixels[offset + channel] = Math.round((/* over */ [r, g, b][channel] * incoming + under * existing * (1 - incoming)) / out);
  }
  pixels[offset + 3] = Math.round(out * 255);
}

/** Signed distance to a rounded rectangle; negative inside. */
function roundedRectDistance(x, y, left, top, right, bottom, radius) {
  const cx = Math.max(left + radius, Math.min(x, right - radius));
  const cy = Math.max(top + radius, Math.min(y, bottom - radius));
  const dx = x - cx;
  const dy = y - cy;
  return Math.hypot(dx, dy) - radius;
}

/** One-pixel antialiased coverage from a signed distance. */
function coverage(distance) {
  return Math.max(0, Math.min(1, 0.5 - distance));
}

// Background plate, with a vertical gradient so it does not read as flat.
for (let y = 0; y < SIZE; y++) {
  const t = y / (SIZE - 1);
  const colour = TOP.map((channel, index) => Math.round(channel + (BOTTOM[index] - channel) * t));
  for (let x = 0; x < SIZE; x++) {
    const distance = roundedRectDistance(x + 0.5, y + 0.5, MARGIN, MARGIN, SIZE - MARGIN, SIZE - MARGIN, CORNER);
    setPixel(x, y, colour, coverage(distance));
  }
}

/**
 * A stack of index-card rows: a bullet and a line, three times, narrowing down
 * the stack. Reads as "a list of things" at 16px as well as at 1024.
 */
const ROWS = [
  { y: 372, width: 452 },
  { y: 512, width: 380 },
  { y: 652, width: 300 },
];
const BULLET_X = 300;
const BULLET_RADIUS = 30;
const BAR_LEFT = 384;
const BAR_HEIGHT = 56;

for (const row of ROWS) {
  for (let y = row.y - BULLET_RADIUS - 2; y <= row.y + BULLET_RADIUS + 2; y++) {
    if (y < 0 || y >= SIZE) continue;
    for (let x = BULLET_X - BULLET_RADIUS - 2; x <= BAR_LEFT + row.width + 2; x++) {
      if (x < 0 || x >= SIZE) continue;
      const px = x + 0.5;
      const py = y + 0.5;

      const bullet = Math.hypot(px - BULLET_X, py - row.y) - BULLET_RADIUS;
      const bar = roundedRectDistance(
        px,
        py,
        BAR_LEFT,
        row.y - BAR_HEIGHT / 2,
        BAR_LEFT + row.width,
        row.y + BAR_HEIGHT / 2,
        BAR_HEIGHT / 2,
      );

      setPixel(x, y, CARD, coverage(Math.min(bullet, bar)));
    }
  }
}

// --- PNG encoding ----------------------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // colour type: RGBA
ihdr[10] = 0; // deflate
ihdr[11] = 0; // adaptive filtering
ihdr[12] = 0; // no interlace

// Filter type 0 (none) in front of every scanline.
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  pixels.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const target = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'build', 'icon.png');
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, png);
console.log(`Wrote ${target} (${SIZE}×${SIZE}, ${(png.length / 1024).toFixed(1)} kB)`);
