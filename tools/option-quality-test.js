/*
 * 选项质量回归测试：确保生成的题目选项里绝不会出现「n n.」「v n.」这类纯词性垃圾，
 * 且正确答案（q.meaning）本身也必须是有效释义。覆盖 daily/review/unit session、PK、词汇量自测，
 * 并直接校验此前被污染为纯词性的词条（do/rocket/semiconductor/spite/tension/textile/estimate）已恢复。
 * 运行：先起服务（node server.js），再 node tools/option-quality-test.js
 *       BASE_URL=http://localhost:3199 可改端口
 */
'use strict';
const fs = require('fs');
const path = require('path');
const BASE = process.env.BASE_URL || 'http://localhost:3199';
let pass = 0, fail = 0, checked = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.log('  ✗ FAIL: ' + msg); } }
async function api(p, body, method) {
  const r = await fetch(BASE + p, {
    method: method || (body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let d = {}; try { d = await r.json(); } catch (e) {}
  return { status: r.status, data: d };
}
const U = (p) => 'opt_' + p + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

// 与 server.js / build-books.js 保持一致的强判定（旧版 POS_ONLY 匹配不到 "n n."，故此处循环剥离词性前缀）
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
function isGarbage(m) {
  if (!m || typeof m !== 'string') return true;
  let s = String(m).trim();
  if (!s) return true;
  let prev;
  do { prev = s; s = stripPos(s); } while (s !== prev);
  if (!s) return true;
  if (POS_ONLY.test(s)) return true;
  return false;
}
function cleanOf(raw) {
  const segs = String(raw).split(/\s*\/\s*/).map((s) => s.trim()).filter(Boolean);
  const cleanSegs = [];
  for (const s of segs) { const t = stripPos(s); if (!t || POS_ONLY.test(t)) continue; cleanSegs.push(t); }
  return cleanSegs.join(' / ') || String(raw);
}

function checkOptions(opts, ctx) {
  ok(opts.length === 4, ctx + ' 选项数=4（实际 ' + opts.length + '）');
  const seen = new Set();
  for (const o of opts) {
    const s = String(o).trim();
    ok(!!s, ctx + ' 选项非空（有空选项: "' + o + '"）');
    ok(!isGarbage(s), ctx + ' 选项非纯词性垃圾（出现脏选项: "' + o + '"）');
    ok(!seen.has(s), ctx + ' 选项无重复（"' + o + '"）');
    seen.add(s);
  }
}
function checkQuestion(q, ctx, kind) {
  checked++;
  const opts = q.options || [];
  checkOptions(opts, ctx);
  if (kind === 'study') {
    ok(typeof q.correctIndex === 'number' && q.correctIndex >= 0 && q.correctIndex <= 3, ctx + ' correctIndex 在 0-3');
    ok(!isGarbage(String(q.meaning || '')), ctx + ' 正确答案 q.meaning 非垃圾（"' + q.meaning + '"）');
    ok(opts[q.correctIndex] === q.meaning, ctx + ' correctIndex 指向 q.meaning');
  } else if (kind === 'vocab') {
    ok(typeof q.correctIndex === 'number' && q.correctIndex >= 0 && q.correctIndex <= 3, ctx + ' correctIndex 在 0-3');
    ok(!isGarbage(String(opts[q.correctIndex] || '').trim()), ctx + ' correctIndex 所指释义有效');
  }
  // kind==='pk' 不校验 correctIndex（服务端不下发）
}

async function main() {
  const ua = U('A').toLowerCase();
  const reg = await api('/api/register', { username: ua, password: 'pw123456', name: '质检' });
  ok(reg.status === 200 && reg.data.token, '注册成功');
  const tok = reg.data.token;

  const books = ['zhongkao', 'gaokao', 'cet4', 'cet6', 'kaoyan', 'ielts', 'toefl', 'awl', 'es'];
  for (const bk of books) {
    await api('/api/study/plan', { token: tok, bookId: bk, dailyNew: 30, vocabEstimate: 0 });
    const ss = await api('/api/study/session?token=' + tok);
    ok(ss.status === 200, bk + ' daily session 成功');
    (ss.data.questions || []).forEach((q) => checkQuestion(q, bk + '/daily', 'study'));
    const rs = await api('/api/study/session?token=' + tok + '&mode=review');
    (rs.data.questions || []).forEach((q) => checkQuestion(q, bk + '/review', 'study'));
  }
  await api('/api/study/plan', { token: tok, bookId: 'cet4', dailyNew: 10, vocabEstimate: 0 });
  const us = await api('/api/study/session?token=' + tok + '&mode=unit&unit=2');
  (us.data.questions || []).forEach((q) => checkQuestion(q, 'cet4/unit2', 'study'));

  const created = await api('/api/create', { token: tok, bookId: 'cet4', mode: 'word', count: 20 });
  const rid = created.data.roomId, pid = created.data.playerId;
  await api('/api/start', { roomId: rid, playerId: pid });
  await new Promise((r) => setTimeout(r, 3400));
  const st = (await api('/api/state?roomId=' + rid + '&playerId=' + pid)).data;
  if (st.question) checkQuestion(st.question, 'PK/cet4', 'pk');
  else console.log('  ✗ PK 未能进入答题阶段，题目质量未被校验');

  const vt = await api('/api/vocabtest/questions');
  ok(vt.status === 200 && Array.isArray(vt.data.questions), '词汇量自测题获取成功');
  (vt.data.questions || []).forEach((q) => checkQuestion(q, 'vocabtest', 'vocab'));

  console.log('\n== B. 被污染词条已恢复正确释义（词书数据层）==');
  const booksJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'data', 'books.json'), 'utf8'));
  const expect = {
    do: ['做', '干', '从事'], rocket: ['火箭'], semiconductor: ['半导体'],
    spite: ['恶意', '怨恨'], tension: ['紧张', '张力'], textile: ['纺织品', '纺织'],
    estimate: ['估计', '估价'],
    // 本轮审计修正：主释义偏僻/错填的词，确认已恢复为常用义（且非纯词性垃圾）
    quick: ['快'], august: ['八月'], refuse: ['拒绝'], pitch: ['球场', '音高'],
    grave: ['严重'], fringe: ['边缘'], monster: ['怪物'], trifle: ['琐事', '少量'],
    fit: ['适合', '健康', '安装'],
  };
  for (const [w, kws] of Object.entries(expect)) {
    let foundClean = null, foundGarbage = false;
    for (const b of booksJson) {
      const hit = b.words.find((x) => x[0] === w);
      if (!hit) continue;
      const clean = cleanOf(hit[1]);
      if (isGarbage(clean)) foundGarbage = true;
      if (kws.some((k) => clean.indexOf(k) >= 0)) foundClean = clean;
    }
    ok(!foundGarbage, w + ' 已无纯词性垃圾释义');
    ok(!!foundClean, w + ' 已恢复正确释义（含「' + kws.join('/') + '」）：' + (foundClean || '缺失'));
  }

  console.log('\n== 选项质量验证 ==');
  console.log('检查题目数: ' + checked + ' · 通过 ' + pass + ' · 失败 ' + fail);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
