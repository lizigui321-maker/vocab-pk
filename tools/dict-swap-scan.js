/* 词典释义互换 / 错填 全量扫描器
 * 用法：node tools/dict-swap-scan.js
 *
 * 目的：找出 books.json 里「某词的释义其实是另一个词的释义」这类数据污染
 *      （典型如 native 被错填成 naive 的「天真的，幼稚的」，且 naive 词条丢失）。
 *
 * 两路检测：
 *   A. 同词跨词书一致性：一个词在 >=3 本词书出现时，对每条释义计算它与
 *      「最核心释义」的字符级 Jaccard 相似度；极低者视为少数派异常释义（疑似错填）。
 *   B. 跨词头释义重复：同一段（归一化后）中文释义挂到了 >=2 个不同英文词上，
 *      且这些词彼此并非同义 —— 高概率为「释义搬错词头」的互换。
 *
 * 输出：
 *   - 控制台：按可疑度排序的候选清单（含每个词的完整释义，便于人工判定）。
 *   - 同目录 dict-swap-candidates.json：完整结果（含全部词，供二次分析）。
 *
 * 说明：本脚本只「发现」候选，不做自动修改；是否真为 bug 由人工结合英语词义判定。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const BOOKS_FILE = path.join(__dirname, '..', 'public', 'data', 'books.json');
const books = JSON.parse(fs.readFileSync(BOOKS_FILE, 'utf8'));

/* ---------- 归一化 ---------- */
// 剥掉词性前缀（adj / vi&n / n. / vt&vi&n 等），只留释义本体
const POS_RE = /^[a-zA-Z]+(\s*&\s*[a-zA-Z]+)*\.?\s+/;
function normDef(raw) {
  let s = String(raw || '').trim();
  s = s.replace(POS_RE, '');
  // 去掉标点/空白，保留中文、字母、数字
  s = s.replace(/[\s，。；;、()（）\[\]【】:：!！?？"'‘’“”.,/\\|-]/g, '');
  return s.toLowerCase();
}
function charSet(s) { return new Set([...s]); }
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const c of a) if (b.has(c)) inter++;
  const uni = a.size + b.size - inter;
  return uni ? inter / uni : 0;
}
function contain(a, b) { // a 被 b 包含的比例
  if (!a.size) return 0;
  let inter = 0;
  for (const c of a) if (b.has(c)) inter++;
  return inter / a.size;
}

/* ---------- 收集：word -> [{book, raw, norm, set}] ---------- */
const byWord = new Map();
for (const b of books) {
  const lang = (b && b.lang === 'es') ? 'es' : 'en';
  if (lang !== 'en') continue; // 本任务只查英文词书
  const ws = (b && b.words) || [];
  for (const it of ws) {
    if (!Array.isArray(it) || typeof it[0] !== 'string') continue;
    const w = it[0].trim();
    if (!w) continue;
    const raw = it[1] || '';
    const n = normDef(raw);
    if (!/[一-鿿]/.test(n)) continue; // 必须含中文
    if (n.length < 2) continue;
    if (!byWord.has(w)) byWord.set(w, []);
    byWord.get(w).push({ book: b.name, raw, norm: n, set: charSet(n) });
  }
}

/* ---------- 检测 A：同词跨词书一致性 ---------- */
const withinCandidates = [];
for (const [word, entries] of byWord) {
  if (entries.length < 3) continue;
  // 找最核心条目：与其他所有条目的 Jaccard 总和最大
  let repIdx = 0, bestSum = -1;
  for (let i = 0; i < entries.length; i++) {
    let sum = 0;
    for (let j = 0; j < entries.length; j++) if (i !== j) sum += jaccard(entries[i].set, entries[j].set);
    if (sum > bestSum) { bestSum = sum; repIdx = i; }
  }
  const rep = entries[repIdx];
  for (let i = 0; i < entries.length; i++) {
    if (i === repIdx) continue;
    const e = entries[i];
    const sim = jaccard(e.set, rep.set);
    if (sim < 0.35) {
      withinCandidates.push({ word, book: e.book, def: e.raw, norm: e.norm, simToMajority: +sim.toFixed(3), majority: rep.raw });
    }
  }
}

/* ---------- 检测 B：跨词头释义重复 ---------- */
// norm -> [words]
const normToWords = new Map();
for (const [word, entries] of byWord) {
  const seen = new Set();
  for (const e of entries) {
    if (seen.has(e.norm)) continue;
    seen.add(e.norm);
    if (!normToWords.has(e.norm)) normToWords.set(e.norm, new Set());
    normToWords.get(e.norm).add(word);
  }
}
const crossDupes = [];
for (const [norm, ws] of normToWords) {
  if (ws.size >= 2) crossDupes.push({ norm, words: [...ws], count: ws.size });
}
crossDupes.sort((a, b) => b.count - a.count || b.norm.length - a.norm.length);

/* ---------- 检测 C：精准「释义互换」判定 ----------
 * 真正的互换（native 被错填成 naive 的「天真的」）有两个特征：
 *   1) 错填的释义 D 是「某个特定其他词 W' 的【首要/一致性】释义」——
 *      即 W' 自己的共识释义 ≈ D（W' 才是 D 的合法主人）；
 *   2) 而当前词 W 自己的共识释义与 D 截然不同（W 把别人的释义借来了）。
 * 合法的「一词多义 / 近义」不会被误判：
 *   - force 的 v 强迫 虽也是 compel 的释义，但没有任何词的【共识】专门是「强迫」，
 *     故找不到 owner；
 *   - 近义词组（huge/enormous/gigantic 都=巨大的）每个词的共识都是该释义，
 *     不属于「借来」的异常释义，不会进入检测 A 的异常集。
 */
// 预计算每个词的共识释义（最中心条目）
const consensus = new Map();
for (const [word, entries] of byWord) {
  let repIdx = 0, bestSum = -1;
  for (let i = 0; i < entries.length; i++) {
    let sum = 0;
    for (let j = 0; j < entries.length; j++) if (i !== j) sum += jaccard(entries[i].set, entries[j].set);
    if (sum > bestSum) { bestSum = sum; repIdx = i; }
  }
  consensus.set(word, entries[repIdx]);
}

const swaps = [];
for (const c of withinCandidates) {
  const Dset = charSet(c.norm);
  // 找 owner：某个其他词 W' 的共识释义与 D 高度相似（≈ 0.6+）
  let owner = null;
  for (const [w2, rep] of consensus) {
    if (w2 === c.word) continue;
    const j = jaccard(rep.set, Dset);
    if (j >= 0.6) { if (!owner || j > owner.j) owner = { word: w2, j: +j.toFixed(2) }; }
  }
  if (owner) swaps.push({ word: c.word, book: c.book, def: c.def, owner: owner.word, ownerJ: owner.j, borrowerConsensus: c.majority });
}
// 去重：同一 (word, owner) 只保留一条
const seen = new Set();
const swapsDedup = [];
for (const s of swaps) {
  const k = s.word + '|' + s.owner;
  if (seen.has(k)) continue;
  seen.add(k); swapsDedup.push(s);
}
swapsDedup.sort((a, b) => b.ownerJ - a.ownerJ || a.word.localeCompare(b.word));

/* ---------- 输出 ---------- */
const out = { withinCandidates, crossDupes, swaps: swapsDedup, stats: { words: byWord.size, within: withinCandidates.length, cross: crossDupes.length, swapCandidates: swapsDedup.length } };
fs.writeFileSync(path.join(__dirname, 'dict-swap-candidates.json'), JSON.stringify(out, null, 2));

console.log('=== 词典释义互换扫描 ===');
console.log('英文词头总数:', byWord.size, '| 检测A异常释义:', withinCandidates.length, '| 检测B跨词头重复:', crossDupes.length, '| 检测C疑似互换:', swapsDedup.length);

console.log('\n--- C. 疑似释义互换（D 是另一词 W\' 的首要释义，且当前词 W 共识与之不符），按 owner 重合度降序 ---');
for (const s of swapsDedup) {
  console.log(`[${s.word}] @${s.book}: "${s.def}"  -> 疑似应属 ${s.owner} (重合${s.ownerJ})  | ${s.word} 自身共识: "${s.borrowerConsensus}"`);
}
