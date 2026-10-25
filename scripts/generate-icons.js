/* 生成应用图标（build/icon.png）与托盘 R 图标（stdout 输出 base64，供 tray.ts 内嵌） */
const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePNG(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/** 字母 R 的矢量定义（归一化坐标 0..1）：平直左壁 + 半圆右肩 */
function inBowl(x, y) {
  if (y < 0.1 || y > 0.52) return false;
  if (x >= 0.22 && x <= 0.55) return true;
  return x >= 0.55 && Math.hypot(x - 0.55, y - 0.31) <= 0.21;
}

function inCounter(x, y) {
  if (y >= 0.21 && y <= 0.41 && x >= 0.38 && x <= 0.55) return true;
  return x >= 0.55 && Math.hypot(x - 0.55, y - 0.31) <= 0.1;
}

function inR(x, y) {
  if (x < 0 || x > 1 || y < 0 || y > 1) return false;
  // 竖笔
  if (x >= 0.16 && x <= 0.34 && y >= 0.1 && y <= 0.9) return true;
  // 肩部（含内孔）
  if (inBowl(x, y) && !inCounter(x, y)) return true;
  // 斜腿：从肩部内部起笔，避免接缝
  const vx = 0.32;
  const vy = 0.44;
  const t = ((x - 0.5) * vx + (y - 0.46) * vy) / (vx * vx + vy * vy);
  if (t >= 0 && t <= 1) {
    const cx = 0.5 + t * vx;
    const cy = 0.46 + t * vy;
    if (Math.hypot(x - cx, y - cy) <= 0.085) return true;
  }
  return false;
}

function inRoundRect(x, y, r) {
  if (x < 0 || x > 1 || y < 0 || y > 1) return false;
  const cx = Math.min(Math.max(x, r), 1 - r);
  const cy = Math.min(Math.max(y, r), 1 - r);
  return Math.hypot(x - cx, y - cy) <= r;
}

function coverage(size, samples, test) {
  const data = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hits = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const nx = (x + (sx + 0.5) / samples) / size;
          const ny = (y + (sy + 0.5) / samples) / size;
          if (test(nx, ny)) hits++;
        }
      }
      const a = Math.round((hits / (samples * samples)) * 255);
      const i = (y * size + x) * 4;
      data[i] = 0;
      data[i + 1] = 0;
      data[i + 2] = 0;
      data[i + 3] = a;
    }
  }
  return data;
}

function trayIcon(size, white) {
  const data = coverage(size, size <= 32 ? 16 : 8, inR);
  if (white) {
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
    }
  }
  return encodePNG(size, size, data);
}

function appIcon(size) {
  const data = Buffer.alloc(size * size * 4);
  const radius = 0.22;
  const samples = 4;
  const from = [31, 111, 235];
  const to = [68, 147, 248];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let maskHits = 0;
      let rHits = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const nx = (x + (sx + 0.5) / samples) / size;
          const ny = (y + (sy + 0.5) / samples) / size;
          if (inRoundRect(nx, ny, radius)) maskHits++;
          // R 居中缩放至 52%
          if (inR((nx - 0.24) / 0.52, (ny - 0.24) / 0.52)) rHits++;
        }
      }
      const total = samples * samples;
      const mask = maskHits / total;
      const rCov = rHits / total;
      const t = ((x + y) / 2) / size;
      const r = from[0] + (to[0] - from[0]) * t;
      const g = from[1] + (to[1] - from[1]) * t;
      const b = from[2] + (to[2] - from[2]) * t;
      const i = (y * size + x) * 4;
      data[i] = Math.round(r + (255 - r) * rCov);
      data[i + 1] = Math.round(g + (255 - g) * rCov);
      data[i + 2] = Math.round(b + (255 - b) * rCov);
      data[i + 3] = Math.round(mask * 255);
    }
  }
  return encodePNG(size, size, data);
}

function encodeICO(sizes) {
  const pngs = sizes.map((size) => appIcon(size));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = 6 + 16 * sizes.length;
  const entries = sizes.map((size, i) => {
    const entry = Buffer.alloc(16);
    entry[0] = size === 256 ? 0 : size;
    entry[1] = size === 256 ? 0 : size;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(pngs[i].length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += pngs[i].length;
    return entry;
  });
  return Buffer.concat([header, ...entries, ...pngs]);
}

const root = path.join(__dirname, '..');
fs.mkdirSync(path.join(root, 'build'), { recursive: true });
fs.writeFileSync(path.join(root, 'build/icon.png'), appIcon(1024));
fs.writeFileSync(path.join(root, 'build/icon.ico'), encodeICO([16, 32, 48, 64, 128, 256]));

for (const [name, white] of [
  ['ICON_16_BLACK', false],
  ['ICON_16_WHITE', true],
  ['ICON_32_BLACK', false],
  ['ICON_32_WHITE', true]
]) {
  const size = name.includes('32') ? 32 : 16;
  console.log(`${name}=${trayIcon(size, white).toString('base64')}`);
}

// 控制台预览 16px 效果
const preview = coverage(16, 4, inR);
for (let y = 0; y < 16; y++) {
  let line = '';
  for (let x = 0; x < 16; x++) {
    const a = preview[(y * 16 + x) * 4 + 3];
    line += a > 160 ? '#' : a > 60 ? '+' : ' ';
  }
  console.log(line);
}
