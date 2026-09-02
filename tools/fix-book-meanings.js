'use strict';
/* 精准修正 books.json 中「词头正确但主释义偏僻/错填」的条目。
 * 做法：解析 JSON 取得每条词当前释义，构造精确 token ["word","cur"] 做整体字符串替换
 * （保留文件其余格式，diff 最小），替换后重新解析校验、且新释义必须通过 isValidMeaning，
 * 任一失败则整文件不写回（绝不产生半截改动）。
 * 运行：node tools/fix-book-meanings.js
 */
const fs = require('fs');
const path = require('path');
const BOOKS_FILE = path.join(__dirname, '..', 'public', 'data', 'books.json');

const POS_BASE = 'n|v|adj|adv|prep|conj|pron|num|int|art|aux|vt|vi|abbr';
const POS_RE = new RegExp('^(' + POS_BASE + ')\\.?(\\s*&\\s*(' + POS_BASE + ')\\.?)*[\\s]+', 'i');
const POS_ONLY = new RegExp('^\\s*(' + POS_BASE + ')\\.?(\\s*&\\s*(' + POS_BASE + ')\\.?)*\\s*$', 'i');
function stripPos(t) {
  let s = t;
  while (true) { const mm = s.match(POS_RE); if (!mm) break; const r = s.slice(mm[0].length).trim(); if (!r) break; s = r; }
  return s;
}
function isValidMeaning(m) {
  if (!m || typeof m !== 'string') return false;
  let s = String(m).trim(); if (!s) return false;
  let p; do { p = s; s = stripPos(s); } while (s !== p);
  if (!s) return false; if (POS_ONLY.test(s)) return false; return true;
}

// [bookId, word, newMeaning] —— 仅改主释义顺序/补全，保留全部义项，绝不丢失有效义项
const FIXES = [
  ['zhongkao', 'refuse', 'v 拒绝；n 垃圾，废物'],
  ['kaoyan', 'refuse', 'v 拒绝；n 垃圾，废物'],
  ['kaoyan-core', 'refuse', 'v 拒绝；n 垃圾，废物'],
  ['cet4', 'pitch', 'n 球场；音高；沥青；v 投掷'],
  ['cet4-core', 'pitch', 'n 球场；音高；沥青；v 投掷'],
  ['cet4', 'grave', 'adj 严重的，严肃的；n 坟墓'],
  ['cet4-core', 'grave', 'adj 严重的，严肃的；n 坟墓'],
  ['cet6', 'fringe', 'n 边缘；穗；刘海；adj 附加的'],
  ['cet6-core', 'fringe', 'n 边缘；穗；刘海；adj 附加的'],
  ['cet6', 'monster', 'n 怪物；巨人，巨兽；adj 大的，庞大的'],
  ['cet6-core', 'monster', 'n 怪物；巨人，巨兽；adj 大的，庞大的'],
  ['cet6', 'trifle', 'n 琐事；少量；vi 嘲笑，轻视'],
  ['cet6-core', 'trifle', 'n 琐事；少量；vi 嘲笑，轻视'],
  ['zhongkao', 'quick', 'adj 快的；迅速的'],
  ['zhongkao', 'august', 'n 八月(略作Aug)；adj 威严的（仅小写august）'],
  ['kaoyan', 'august', 'n 八月(略作Aug)；adj 威严的（仅小写august）'],
  ['kaoyan-core', 'august', 'n 八月(略作Aug)；adj 威严的（仅小写august）'],
  // 用户反馈 fit 在雅思中只显示生僻医学义「(病的)发作，痉挛」
  ['ielts', 'fit', 'v 适合；适应；安装；adj 健康的；合适的；(病的)发作，痉挛'],
  ['ielts-core', 'fit', 'v 适合；适应；安装；adj 健康的；合适的；(病的)发作，痉挛'],
];

let raw = fs.readFileSync(BOOKS_FILE, 'utf8');
const books = JSON.parse(raw); // 先确保原文件可解析
const bookMap = new Map(books.map((b) => [b.id, b]));

const log = [];
let changed = 0;
for (const [bookId, word, neu] of FIXES) {
  const b = bookMap.get(bookId);
  if (!b) { log.push('SKIP 未找到词书 ' + bookId); continue; }
  const it = (b.words || []).find((x) => Array.isArray(x) && String(x[0]).toLowerCase() === word.toLowerCase());
  if (!it) { log.push('SKIP ' + bookId + ' 未找到词 ' + word); continue; }
  const cur = String(it[1]);
  if (cur === neu) { log.push('OK ' + bookId + '/' + word + ' 已是目标释义'); continue; }
  if (!isValidMeaning(neu)) { log.push('ABORT ' + bookId + '/' + word + ' 新释义无效：' + neu); process.exit(3); }
  // 用条目里【真实的词形】（可能是 August/august 之类大小写差异）构造 token，避免漏改
  const wkey = String(it[0]);
  const oldTok = '["' + wkey + '","' + cur + '"]';
  const newTok = '["' + wkey + '","' + neu + '"]';
  const cnt = raw.split(oldTok).length - 1;
  if (cnt === 0) { log.push('SKIP ' + bookId + '/' + word + ' 未命中精确 token（cur=' + cur + '）'); continue; }
  raw = raw.split(oldTok).join(newTok);
  changed++;
  log.push('FIX ' + bookId + '/' + word + '： "' + cur + '" -> "' + neu + '"（命中 ' + cnt + ' 处）');
}

// 写回前整体校验
try {
  const re = JSON.parse(raw);
  if (!Array.isArray(re) || re.length !== books.length) throw new Error('词书数量变化 ' + re.length + ' != ' + books.length);
} catch (e) {
  log.push('ABORT 写回后 JSON 校验失败：' + e.message);
  console.log(log.join('\n'));
  process.exit(4);
}

fs.writeFileSync(BOOKS_FILE, raw);
console.log(log.join('\n'));
console.log('\n共修改 ' + changed + ' 处。请随后运行 node tools/build-books.js 重新生成 public/books.bundle.js');
