/*
 * 各考试词书「核心词」词本生成脚本
 * 规则：词出现在本书 + 至少还出现在另外 3 本考试词书（中考/高考/四级/六级/考研/雅思/托福）
 *       => 跨考试高频共现 = 该考试的核心高频词
 * 用法：node tools/build-core-books.js
 * 效果：移除通用「核心高频词」词本，为 四级/六级/考研/雅思/托福 各生成一本「xx核心词」
 */
'use strict';
const fs = require('fs');
const path = require('path');

const BOOKS_FILE = path.join(__dirname, '..', 'public', 'data', 'books.json');
const books = JSON.parse(fs.readFileSync(BOOKS_FILE, 'utf8'));

const EXAM = ['zhongkao', 'gaokao', 'cet4', 'cet6', 'kaoyan', 'ielts', 'toefl'];
const sets = {};
for (const b of books) {
  if (EXAM.includes(b.id)) sets[b.id] = new Set(b.words.map(([w]) => String(w).toLowerCase()));
}
const inHowMany = new Map();
for (const id of EXAM) {
  for (const w of sets[id]) inHowMany.set(w, (inHowMany.get(w) || 0) + 1);
}

function coreWords(bookId) {
  const book = books.find((b) => b.id === bookId);
  const seen = new Set();
  const out = [];
  for (const [word, meaning] of book.words) {
    const k = String(word).toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    if ((inHowMany.get(k) || 0) >= 4) out.push([word, meaning]);
  }
  return out;
}

const CORE_DEFS = [
  { id: 'cet4-core', name: '大学英语四级核心词', src: 'cet4' },
  { id: 'cet6-core', name: '大学英语六级核心词', src: 'cet6' },
  { id: 'kaoyan-core', name: '考研核心词', src: 'kaoyan' },
  { id: 'ielts-core', name: '雅思核心词', src: 'ielts' },
  { id: 'toefl-core', name: '托福核心词', src: 'toefl' },
];

// 移除旧的通用 core 词本 + 之前生成过的 xx-core 词本（保证脚本可重复运行）
const kept = books.filter((b) => b.id !== 'core' && !b.id.endsWith('-core'));
const out = [];
for (const b of kept) {
  out.push(b);
  const def = CORE_DEFS.find((d) => d.src === b.id);
  if (def) {
    const words = coreWords(def.src);
    out.push({ id: def.id, name: def.name, words });
    console.log(`${def.name}: ${words.length} 词（源词本 ${b.words.length} 词）`);
  }
}
fs.writeFileSync(BOOKS_FILE, JSON.stringify(out), 'utf8');
console.log('books.json 已更新：', out.length, '本词书');
