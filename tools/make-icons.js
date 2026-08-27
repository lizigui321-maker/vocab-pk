// 生成单词PK 的 App 图标（纯 Node 手写 PNG 编码，无需任何图片库）
// 输出：public/icon-192.png、public/icon-512.png
//      apk 工程各密度 mipmap 的 ic_launcher.png / ic_launcher_round.png
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');

// ---- CRC32（PNG 分块校验） ----
const CRC_TABLE = (function () {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
// 编码 RGBA PNG
function encodePNG(size, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  // 每行前缀 filter 0
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// 闪电多边形（归一化 0..1，y 向下）
const BOLT = [
  [0.52, 0.06], [0.16, 0.60], [0.42, 0.60], [0.30, 0.96],
  [0.86, 0.36], [0.58, 0.36], [0.70, 0.06],
];
function inPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

function makeIcon(size) {
  const buf = Buffer.alloc(size * size * 4);
  const base = [0x4f, 0x6e, 0xf7];   // 品牌蓝 #4f6ef7
  const hi = [0x7c, 0x5c, 0xff];     // 右上提亮 #7c5cff
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = x / size, ny = y / size;
      // 背景：左上偏蓝、右下偏紫的简单渐变，增加层次
      const t = (nx + ny) / 2;
      const r = Math.round(base[0] + (hi[0] - base[0]) * t);
      const g = Math.round(base[1] + (hi[1] - base[1]) * t);
      const b = Math.round(base[2] + (hi[2] - base[2]) * t);
      const white = inPoly(nx, ny, BOLT);
      const o = (y * size + x) * 4;
      buf[o] = white ? 255 : r;
      buf[o + 1] = white ? 255 : g;
      buf[o + 2] = white ? 255 : b;
      buf[o + 3] = 255;
    }
  }
  return encodePNG(size, buf);
}

// 输出 PWA 图标
const pwa192 = makeIcon(192);
const pwa512 = makeIcon(512);
fs.writeFileSync(path.join(ROOT, 'public', 'icon-192.png'), pwa192);
fs.writeFileSync(path.join(ROOT, 'public', 'icon-512.png'), pwa512);
console.log('PWA icons: icon-192.png (%dKB), icon-512.png (%dKB)', (pwa192.length / 1024).toFixed(1), (pwa512.length / 1024).toFixed(1));

// 输出 APK mipmap 图标
const densities = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
for (const [d, s] of Object.entries(densities)) {
  const png = makeIcon(s);
  const dir = path.join(ROOT, 'apk', 'app', 'src', 'main', 'res', 'mipmap-' + d);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'ic_launcher.png'), png);
  fs.writeFileSync(path.join(dir, 'ic_launcher_round.png'), png);
  console.log('  mipmap-%s/ic_launcher.png (%dpx)', d, s);
}
console.log('icons generated.');
