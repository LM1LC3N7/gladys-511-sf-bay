// Generates cover.png (800x534) for gladys-sf-bay-transit: plain Node, no dependency.
// A generic silver suspension bridge over the bay at dusk and a departure board (two departures
// and an alert in amber), on a gradient (no brand logo, no 511 mark).
// Usage: node scripts/cover.mjs cover.png
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const W = 800;
const H = 534;
const px = Buffer.alloc(W * H * 3);
const set = (x, y, [r, g, b], a = 1) => {
  x = Math.round(x);
  y = Math.round(y);
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  px[i] = px[i] * (1 - a) + r * a;
  px[i + 1] = px[i + 1] * (1 - a) + g * a;
  px[i + 2] = px[i + 2] * (1 - a) + b * a;
};
// Sky (dusk) above the water line, the bay below.
const WATER = 360;
for (let y = 0; y < H; y += 1) {
  for (let x = 0; x < W; x += 1) {
    if (y < WATER) {
      const t = y / WATER;
      set(x, y, [40 + 200 * t, 60 + 90 * t, 120 - 20 * t]);
    } else {
      const t = (y - WATER) / (H - WATER);
      set(x, y, [30 - 10 * t, 70 - 30 * t, 110 - 40 * t]);
    }
  }
}
const box = (x0, y0, x1, y1, color, alpha = 1) => {
  for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) set(x, y, color, alpha);
};
const line = (x0, y0, x1, y1, width, color) => {
  const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2);
  for (let s = 0; s <= steps; s += 1) {
    const x = x0 + ((x1 - x0) * s) / steps;
    const y = y0 + ((y1 - y0) * s) / steps;
    for (let dy = -width / 2; dy <= width / 2; dy += 0.5) {
      for (let dx = -width / 2; dx <= width / 2; dx += 0.5) set(x + dx, y + dy, color);
    }
  }
};
const steel = [200, 206, 216];
const deck = 330;
// Deck, two towers, the main cable (a parabola) and the hangers.
box(0, deck, W, deck + 10, steel);
for (const tx of [210, 590]) {
  box(tx - 14, 120, tx - 4, deck + 40, steel);
  box(tx + 4, 120, tx + 14, deck + 40, steel);
  for (const cy of [140, 200, 260]) box(tx - 14, cy, tx + 14, cy + 8, steel);
}
let prev = null;
for (let x = 0; x <= W; x += 4) {
  const half = 190;
  const d = Math.abs(x - 400);
  const y = d <= half ? 125 + (deck - 25 - 125) * (1 - (d / half) ** 2) : 125 + (d - half) * 0.9;
  if (prev) line(prev[0], prev[1], x, Math.min(y, deck), 3, steel);
  if (x % 20 === 0 && y < deck) line(x, y, x, deck, 1, steel);
  prev = [x, Math.min(y, deck)];
}
// Reflection of the deck on the water.
box(0, WATER + 20, W, WATER + 24, steel, 0.35);
// The departure board.
const dark = [24, 30, 48];
const green = [110, 220, 140];
const amber = [250, 190, 60];
const white = [235, 240, 245];
box(470, 390, 770, 510, dark, 0.92);
const row = (y, color, widths) => {
  let x = 488;
  for (const w of widths) {
    box(x, y, x + w, y + 10, color);
    x += w + 12;
  }
};
row(408, white, [40, 120, 50]);
row(436, green, [40, 120, 50]);
row(464, green, [40, 100, 50]);
row(490, amber, [16, 200]);
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;
ihdr[9] = 2;
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y += 1) {
  raw[y * (W * 3 + 1)] = 0;
  px.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
}
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(process.argv[2] ?? 'cover.png', png);
console.log('cover', png.length, 'bytes');
