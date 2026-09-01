#!/usr/bin/env node
/* build-books.js — 把词书打包进前端（简单混淆，防 F12 直读）
 * 流程：books.json → XOR(key) → deflate 压缩 → Base64 → public/books.bundle.js
 * 前端解码（index.html 内 decodeBooks）与其对称：
 *   atob → DecompressionStream('deflate') → XOR(key) → JSON.parse
 * 运行：node tools/build-books.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'public', 'data', 'books.json');
const OUT = path.join(ROOT, 'public', 'books.bundle.js');

// 密钥：仅打包时使用；前端解码函数里用 charCode 数组还原，不写明文
const KEY = 'VOCABPK_S3CRET_KEY';

// 与 server.js 的 splitMeaning 保持逐字一致：出题用「剥离词性前缀后的纯中文释义」，
// 且支持 vi&n / n&adj 这类组合词性（旧实现只认单个词性，会把 "n&v 估计" 错切成 "&v 估计"）。
const POS_BASE = 'n|v|adj|adv|prep|conj|pron|num|int|art|aux|vt|vi|abbr';
const POS_RE = new RegExp('^(' + POS_BASE + ')\\.?(\\s*&\\s*(' + POS_BASE + ')\\.?)*[\\s]+', 'i');
const POS_ONLY = new RegExp('^\\s*(' + POS_BASE + ')\\.?(\\s*&\\s*(' + POS_BASE + ')\\.?)*\\s*$', 'i');
function stripPos(t) {
  let s = t;
  while (true) {
    const mm = s.match(POS_RE);
    if (!mm) break;
    const rest = s.slice(mm[0].length).trim();
    if (!rest) break;
    s = rest;
  }
  return s;
}
function splitMeaning(raw) {
  const segs = String(raw).split(/\s*\/\s*/).map((s) => s.trim()).filter(Boolean);
  const first = segs[0] || '';
  const m = first.match(POS_RE);
  const pos = m ? m[1].toLowerCase() : '';
  const cleanSegs = [];
  for (const s of segs) {
    const t = stripPos(s);
    if (!t || POS_ONLY.test(t)) continue;
    cleanSegs.push(t);
  }
  let clean = cleanSegs.join(' / ');
  if (!clean) {
    clean = String(raw).replace(new RegExp(POS_RE.source, 'gi'), '')
      .split(' / ').map((x) => x.trim()).filter((x) => x && !POS_ONLY.test(x)).join(' / ');
  }
  return { pos, clean: clean || String(raw) };
}
function isValidMeaning(m) {
  if (!m || typeof m !== 'string') return false;
  let s = String(m).trim();
  if (!s) return false;
  let prev;
  do { prev = s; s = stripPos(s); } while (s !== prev);
  if (!s) return false;
  if (POS_ONLY.test(s)) return false;
  return true;
}

const books = JSON.parse(fs.readFileSync(SRC, 'utf8')).map((b) => ({
  id: b.id,
  name: b.name,
  lang: b.lang || 'en',
  words: b.words
    .map(([word, meaning]) => [word, splitMeaning(meaning).clean])
    .filter(([, m]) => isValidMeaning(m)),
}));
const json = JSON.stringify(books);

// 1) deflate 压缩（对 UTF-8 原始字节，压缩率最高）
const jsonBytes = Buffer.from(json, 'utf8');
const deflated = zlib.deflateSync(jsonBytes);
// 2) XOR 混淆（仅作用于压缩流，防 F12 直读；不影响压缩率）
const xbuf = Buffer.alloc(deflated.length);
for (let i = 0; i < deflated.length; i++) {
  xbuf[i] = deflated[i] ^ KEY.charCodeAt(i % KEY.length);
}
// 3) Base64
const b64 = xbuf.toString('base64');

const out =
  '/* 词书数据（混淆压缩编码，防直接查看）— 由 tools/build-books.js 生成，请勿手改 */\n' +
  'window.__VOCAB_BOOKS__ = ' + JSON.stringify(b64) + ';\n';

fs.writeFileSync(OUT, out);

const rawKB = (json.length / 1024).toFixed(0);
const outKB = (b64.length / 1024).toFixed(1);
console.log('OK: 词书 ' + books.length + ' 本, 原始 ' + rawKB + ' KB, 打包后 ' + outKB + ' KB -> ' + path.relative(ROOT, OUT));
