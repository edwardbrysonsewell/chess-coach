/**
 * Generate the app icons as PNGs, with no image library.
 *
 * iOS needs a real PNG for the Home Screen icon — it will not take an SVG — so
 * the PNG is assembled here by hand: raw RGBA rows, deflated with node's zlib,
 * wrapped in IHDR/IDAT/IEND chunks with CRCs. That is a lot less machinery than
 * adding an image dependency for three files, and it keeps the "everything
 * vendored, nothing fetched" rule intact.
 *
 * The mark is a knight's-move motif: a quiet board with two squares picked out.
 *
 * Usage: node tools/make-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const OUT = 'public/icons';
const SIZES = [
  { name: 'apple-touch-icon.png', size: 180, padded: true },
  { name: 'icon-192.png', size: 192, padded: true },
  { name: 'icon-512.png', size: 512, padded: true },
  { name: 'icon-512-maskable.png', size: 512, padded: false },
];

const DARK = [0x25, 0x30, 0x3c, 0xff];
const LIGHT = [0xe9, 0xed, 0xf2, 0xff];
const ACCENT = [0x2f, 0x6f, 0xeb, 0xff];
const GLOW = [0xf5, 0xc4, 0x51, 0xff];

function render(size, padded) {
  // A maskable icon must survive a circular crop, so its board is inset further.
  const inset = padded ? Math.round(size * 0.14) : Math.round(size * 0.24);
  const boardSize = size - inset * 2;
  const cell = boardSize / 8;
  const pixels = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let colour = DARK;
      const bx = x - inset;
      const by = y - inset;
      if (bx >= 0 && by >= 0 && bx < boardSize && by < boardSize) {
        const file = Math.floor(bx / cell);
        const rank = Math.floor(by / cell);
        const isLight = (file + rank) % 2 === 0;
        colour = isLight ? LIGHT : ACCENT;
        // Two squares a knight's move apart, picked out in gold.
        if ((file === 2 && rank === 5) || (file === 3 && rank === 3)) colour = GLOW;
      }
      const offset = (y * size + x) * 4;
      pixels[offset] = colour[0];
      pixels[offset + 1] = colour[1];
      pixels[offset + 2] = colour[2];
      pixels[offset + 3] = colour[3];
    }
  }
  return pixels;
}

function png(width, height, pixels) {
  // Each scanline is prefixed with a filter byte; 0 means "no filter".
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

mkdirSync(OUT, { recursive: true });
for (const { name, size, padded } of SIZES) {
  const file = `${OUT}/${name}`;
  writeFileSync(file, png(size, size, render(size, padded)));
  process.stdout.write(`wrote ${file} (${size}x${size})\n`);
}
