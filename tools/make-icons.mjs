// Draws the app icons (a white location pin on a teal tile) and writes them as PNGs.
// Zero dependencies: shapes are sampled 4×4 per pixel and encoded with node:zlib.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('../icons/', import.meta.url));
const TOP = [20, 184, 166];
const BOTTOM = [15, 118, 110];
const WHITE = [255, 255, 255];

const ICONS = [
  { file: 'icon-192.png', size: 192, rounded: true, scale: 0.9 },
  { file: 'icon-512.png', size: 512, rounded: true, scale: 0.9 },
  { file: 'icon-maskable-512.png', size: 512, rounded: false, scale: 0.72 }, // Android crops to a circle or squircle
  { file: 'apple-touch-icon.png', size: 180, rounded: false, scale: 0.85 }, // iOS rounds the corners itself
];

const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

function inRoundedSquare(u, v, r) {
  const dx = Math.max(Math.abs(u - 0.5) - (0.5 - r), 0);
  const dy = Math.max(Math.abs(v - 0.5) - (0.5 - r), 0);
  return dx * dx + dy * dy <= r * r;
}

// Pin: a circle plus the two tangent lines down to the tip (a teardrop).
const HEAD = { x: 0.5, y: 0.4, r: 0.22 };
const TIP_Y = 0.84;
const TIP_TO_HEAD = TIP_Y - HEAD.y;
const TAN = Math.tan(Math.asin(HEAD.r / TIP_TO_HEAD));
const TANGENT_Y = TIP_Y - (TIP_TO_HEAD ** 2 - HEAD.r ** 2) / TIP_TO_HEAD; // where the lines touch the circle

function inPin(x, y) {
  const dx = x - HEAD.x;
  const dy = y - HEAD.y;
  if (dx * dx + dy * dy <= HEAD.r * HEAD.r) return true;
  return y >= TANGENT_Y && y <= TIP_Y && Math.abs(dx) <= (TIP_Y - y) * TAN;
}

const inHole = (x, y) => (x - HEAD.x) ** 2 + (y - HEAD.y) ** 2 <= 0.085 ** 2;

function inRipple(x, y) {
  const e = ((x - 0.5) / 0.25) ** 2 + ((y - 0.865) / 0.07) ** 2;
  return e <= 1 && e >= 0.55;
}

/** RGBA at a point of the icon, in [0, 1] coordinates, or null where transparent. */
function shade(u, v, { rounded, scale }) {
  if (rounded && !inRoundedSquare(u, v, 0.22)) return null;
  const bg = mix(TOP, BOTTOM, v);
  const x = (u - 0.5) / scale + 0.5;
  const y = (v - 0.5) / scale + 0.53;
  if (inPin(x, y)) return inHole(x, y) ? bg : WHITE;
  if (inRipple(x, y)) return mix(bg, WHITE, 0.55);
  return bg;
}

function render({ size, ...style }) {
  const pixels = Buffer.alloc(size * size * 4);
  const n = 4;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < n; sy++) {
        for (let sx = 0; sx < n; sx++) {
          const c = shade((px + (sx + 0.5) / n) / size, (py + (sy + 0.5) / n) / size, style);
          if (!c) continue;
          r += c[0];
          g += c[1];
          b += c[2];
          a += 1;
        }
      }
      const o = (py * size + px) * 4;
      if (a) {
        pixels[o] = Math.round(r / a);
        pixels[o + 1] = Math.round(g / a);
        pixels[o + 2] = Math.round(b / a);
      }
      pixels[o + 3] = Math.round((a / (n * n)) * 255);
    }
  }
  return encodePng(size, pixels);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, k) => {
  let c = k;
  for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

function encodePng(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const stride = size * 4;
  const rows = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(rows, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT, { recursive: true });
for (const icon of ICONS) {
  const png = render(icon);
  writeFileSync(join(OUT, icon.file), png);
  console.log(`icons/${icon.file}  ${icon.size}×${icon.size}  ${(png.length / 1024).toFixed(1)} KB`);
}
