/*
 * 核心高频词词本生成脚本
 * 原理：四级/六级/考研三本中，至少出现在 2 本的词 = 跨书共现 = 大学阶段核心高频词
 * 释义优先级：四级 > 六级 > 考研
 * 用法：node tools/build-core-book.js <源目录> <输出路径>
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = process.argv[2] || 'C:/Users/Rick_Lei/AppData/Local/Temp';
const OUT = process.argv[3] || path.join(__dirname, '..', 'public', 'data', 'core.json');

function readBookMap(file) {
  const raw = fs.readFileSync(file, 'utf8');
  let arr;
  try {
    arr = JSON.parse(raw);
  } catch (e) {
    arr = raw.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  }
  const map = new Map();
  for (const item of arr) {
    const w = item.headWord || (item.content && item.content.word && item.content.word.wordHead);
    if (!w || !/^[A-Za-z][A-Za-z\-']*$/.test(w)) continue;
    const t = item.content && item.content.word && item.content.word.content && item.content.word.content.trans;
    let meaning = '';
    if (Array.isArray(t) && t.length) {
      const first = t[0];
      const cn = first.tranCn || first.tran || '';
      meaning = String(((first.pos ? first.pos + ' ' : '') + cn).trim());
    }
    if (!meaning) continue;
    if (meaning.length > 30) meaning = meaning.slice(0, 30) + '…';
    const lw = w.toLowerCase();
    if (!map.has(lw)) map.set(lw, { word: w, meaning });
  }
  return map;
}

const D = (n) => path.join(SRC, n);
const sources = [
  { id: 'cet4', map: readBookMap(D('cet4/CET4_2.json')) },
  { id: 'cet6', map: readBookMap(D('cet6/CET6_3.json')) },
  { id: 'kaoyan', map: readBookMap(D('ky/KaoYan_2.json')) },
];

// 统计每个词出现在几本书
const freq = new Map();
for (const s of sources) for (const k of s.map.keys()) freq.set(k, (freq.get(k) || 0) + 1);

const words = [];
for (const [k, n] of freq) {
  if (n < 2) continue; // 至少在两本词书中出现才算核心高频
  const entry = sources[0].map.get(k) || sources[1].map.get(k) || sources[2].map.get(k);
  words.push([entry.word, entry.meaning]);
}
words.sort((a, b) => a[0].localeCompare(b[0]));

const book = { id: 'core', name: '核心高频词', words };
fs.writeFileSync(OUT, JSON.stringify(book), 'utf8');
for (const s of sources) console.log(`${s.id}: ${s.map.size} 词`);
console.log(`核心高频词（≥2本共现）: ${words.length} 词 -> ${OUT}`);
