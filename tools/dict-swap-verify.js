/* 词典释义互换 · 在线核验（全量 withinCandidates -> 真 corrupt）
 * 用法：node tools/dict-swap-verify.js
 *
 * 先跑 dict-swap-scan.js 生成 dict-swap-candidates.json（含 withinCandidates 异常释义）。
 * 本脚本对【每一个】异常释义对应的词，用有道 jsonapi 取该词真实释义，
 * 若该异常释义的关键中文字在真实释义中完全找不到，则判定为「该释义并非 W 的真实含义」——
 * 即 genuine swap / 错填。
 *
 * 跳过规则：关键短语为空（如「边(缘)」「拖, 曳」这类单字）视为无法判定，不确认。
 * 结论：合法/无法判定 不处理；确认 corrupt 的进入 dict-swap-confirmed.json 供人工复核。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'dict-swap-candidates.json'), 'utf8'));
const cands = data.withinCandidates || [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function keyPhrases(raw) {
  const s = String(raw || '').replace(/^[a-zA-Z]+(\s*&\s*[a-zA-Z]+)*\.?\s+/, '');
  const runs = (s.match(/[一-鿿]{2,}/g) || []).filter((x) => !/^(的|了|等|与|和|或|及|之|者|们|缘)$/.test(x));
  return runs;
}

async function youdaoExplanation(w) {
  const url = 'https://dict.youdao.com/jsonapi?q=' + encodeURIComponent(w.toLowerCase()) + '&le=en&doctype=json';
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    return await r.text();
  } catch (e) { return null; }
}

(async () => {
  const byWord = new Map();
  for (const c of cands) {
    if (!byWord.has(c.word)) byWord.set(c.word, []);
    byWord.get(c.word).push(c);
  }
  const words = [...byWord.keys()];
  console.log('待核验词数:', words.length);

  const confirmed = [];
  const reviewed = [];
  const failed = [];
  let done = 0;
  const CONC = 6;

  async function worker() {
    while (true) {
      const w = words.pop();
      if (w === undefined) return;
      done++;
      const txt = await youdaoExplanation(w);
      if (txt == null) { failed.push(w); continue; }
      for (const d of byWord.get(w)) {
        const kp = keyPhrases(d.def);
        if (!kp.length) { reviewed.push({ word: w, def: d.def, note: '无>=2字关键短语，跳过' }); continue; }
        const hasAny = kp.some((p) => txt.includes(p));
        if (hasAny) reviewed.push({ word: w, def: d.def, owner: d.owner, note: '有道含该释义，合法' });
        else confirmed.push({ word: w, book: d.book, def: d.def, owner: d.owner, keys: kp });
      }
      if (done % 50 === 0) console.log(`  进度 ${done}/${words.length}  已确认 ${confirmed.length} 条`);
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));

  fs.writeFileSync(path.join(__dirname, 'dict-swap-confirmed.json'), JSON.stringify({ confirmed, reviewedCount: reviewed.length, failed }, null, 2));
  console.log('\n=== 全量在线核验结果 ===');
  console.log('合法/跳过:', reviewed.length, '| 网络失败:', failed.length, '| 确认 corrupt:', confirmed.length);
  if (failed.length) console.log('网络失败词:', failed.join(', '));
  console.log('\n--- 确认 corrupt（W 在线释义中不含该释义，疑似真互换/错填）---');
  for (const c of confirmed) {
    console.log(`[${c.word}] @${c.book}: "${c.def}"  -> 疑似应属 ${c.owner}  | 关键短语 ${JSON.stringify(c.keys)}`);
  }
})();
