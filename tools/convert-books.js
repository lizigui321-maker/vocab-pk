/*
 * 词书转换脚本：把百词斩词库 JSON 转成单词PK格式
 * 用法：node tools/convert-books.js <源目录> <输出路径>
 * 源目录需包含: cz(中考) gz4 gz5 gz6 gz6b gz7 gz10 gz11(人教高中各册) cet6 ky ielts toefl
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = process.argv[2] || 'C:/Users/Rick_Lei/AppData/Local/Temp';
const OUT = process.argv[3] || '';

function readBook(file) {
  const raw = fs.readFileSync(file, 'utf8');
  let arr;
  try {
    arr = JSON.parse(raw);
  } catch (e) {
    // 兼容 JSON Lines：每行一个对象
    arr = raw.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  }
  const seen = new Set();
  const words = [];
  for (const item of arr) {
    const w = item.headWord || (item.content && item.content.word && item.content.word.wordHead);
    if (!w || !/^[A-Za-z][A-Za-z\-']*$/.test(w)) continue;
    const lw = w.toLowerCase();
    if (seen.has(lw)) continue;
    const t = item.content && item.content.word && item.content.word.content && item.content.word.content.trans;
    let meaning = '';
    if (Array.isArray(t) && t.length) {
      const first = t[0];
      // 中文释义字段是 tranCn（tran 是同义词的字段，会导致释义丢失只剩词性）
      const cn = first.tranCn || first.tran || '';
      meaning = String(((first.pos ? first.pos + ' ' : '') + cn).trim());
    }
    if (!meaning) continue;
    if (meaning.length > 30) meaning = meaning.slice(0, 30) + '…';
    seen.add(lw);
    words.push([w, meaning]);
  }
  return words;
}

function mergeBooks(files) {
  const seen = new Set();
  const words = [];
  for (const f of files) {
    const ws = readBook(f);
    for (const [w, m] of ws) {
      const lw = w.toLowerCase();
      if (seen.has(lw)) continue;
      seen.add(lw);
      words.push([w, m]);
    }
  }
  return words;
}

const D = (n) => path.join(SRC, n);
const books = [];
// 核心高频词（由 build-core-book.js 生成：四级/六级/考研 ≥2 本共现）
const coreFile = path.join(__dirname, '..', 'public', 'data', 'core.json');
if (fs.existsSync(coreFile)) {
  const core = JSON.parse(fs.readFileSync(coreFile, 'utf8'));
  books.push({ id: core.id, name: core.name, words: core.words.map(([w, m]) => [w, m]) });
}
books.push(
  { id: 'zhongkao', name: '中考核心词汇', words: readBook(D('cz/ChuZhong_2.json')) },
  { id: 'gaokao', name: '高考核心词汇（人教版高中）', words: mergeBooks([
    'gz4/PEPGaoZhong_4.json', 'gz5/PEPGaoZhong_5.json', 'gz6b/PEPGaoZhong_6.json',
    'gz7/PEPGaoZhong_7.json', 'gz10/PEPGaoZhong_10.json', 'gz11/PEPGaoZhong_11.json',
  ].map((f) => D(f))) },
  { id: 'cet4', name: '大学英语四级', words: readBook(D('cet4/CET4_2.json')) },
  { id: 'cet6', name: '大学英语六级', words: readBook(D('cet6/CET6_3.json')) },
  { id: 'kaoyan', name: '考研词汇', words: readBook(D('ky/KaoYan_2.json')) },
  { id: 'ielts', name: '雅思词汇', words: readBook(D('ielts/IELTS_2.json')) },
  { id: 'toefl', name: '托福词汇', words: readBook(D('toefl/TOEFL_2.json')) },
);

const dest = OUT || path.join(__dirname, '..', 'public', 'data', 'books.json');
fs.writeFileSync(dest, JSON.stringify(books), 'utf8');
for (const b of books) console.log(`${b.name}: ${b.words.length} 词`);
console.log('总计:', books.reduce((s, b) => s + b.words.length, 0), '词 ->', dest);
