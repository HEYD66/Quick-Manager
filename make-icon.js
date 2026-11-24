#!/usr/bin/env node
/**
 * make-icon.js — 生成应用图标（纯 Node，无依赖）
 * 输出：electron/icon.png（256x256）、electron/tray.png（32x32）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  let c, table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crcBuf]);
}

function png(size) {
  const W = size, H = size;
  const raw = Buffer.alloc((W * 4 + 1) * H);
  const cx = W / 2, cy = H / 2, r = W * 0.46;
  const inner = W * 0.30;
  for (let y = 0; y < H; y++) {
    raw[y * (W * 4 + 1)] = 0; // filter none
    for (let x = 0; x < W; x++) {
      const off = y * (W * 4 + 1) + 1 + x * 4;
      const dx = x - cx, dy = y - cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      // 圆角方块（近似圆）
      let a = 0, r0 = 124, g0 = 58, b0 = 237; // #7c3aed
      if (d <= r) {
        a = 255;
        // 渐变：右下更亮
        const t = Math.min(1, Math.max(0, (dx + dy) / (2 * r) + 0.5));
        r0 = Math.round(124 + 60 * t);
        g0 = Math.round(58 + 40 * t);
        b0 = Math.round(237 - 40 * t);
      }
      // 白色 "Q" 字（简化为圆环 + 尾巴）
      const ringOuter = d <= inner + W * 0.055 && d >= inner - W * 0.055;
      const tail = (x - cx > W * 0.03 && y - cy > W * 0.03 && Math.abs((x - cx) - (y - cy)) < W * 0.045 && d < inner + W * 0.20);
      if (d <= r && (ringOuter || tail)) { r0 = 255; g0 = 255; b0 = 255; }
      raw[off] = r0; raw[off + 1] = g0; raw[off + 2] = b0; raw[off + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const out = path.join(__dirname, 'electron');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'icon.png'), png(256));
fs.writeFileSync(path.join(out, 'tray.png'), png(32));
console.log('icon.png', fs.statSync(path.join(out, 'icon.png')).size, 'bytes');
console.log('tray.png', fs.statSync(path.join(out, 'tray.png')).size, 'bytes');
