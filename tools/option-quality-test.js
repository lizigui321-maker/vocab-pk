/*
 * 选项质量验证：确保所有选择题的 4 个选项均非脏数据（空串 / 纯词性标注 "n." "v" 等），
 * 且 correctIndex 正确指向 q.meaning。覆盖 daily/review/unit session、PK、词汇量自测。
 * 运行：node tools/option-quality-test.js   （需 server 已在 BASE_URL 监听）
 */
'use strict';
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const POS_ONLY = /^\s*(n|v|adj|adv|prep|conj|pron|num|int|art|aux|vt|vi|abbr)\.?\s*$/i;
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

function checkOptions(opts, ctx) {
  ok(opts.length === 4, ctx + ' 选项数=4（实际 ' + opts.length + '）');
  const seen = new Set();
  for (const o of opts) {
    const s = String(o).trim();
    ok(!!s, ctx + ' 选项非空（有空选项: "' + o + '"）');
    ok(!POS_ONLY.test(s), ctx + ' 选项非纯词性标注（出现脏选项: "' + o + '"）');
    ok(!seen.has(s), ctx + ' 选项无重复（"' + o + '"）');
    seen.add(s);
  }
}
/* kind: 'study' 题带 meaning，correctIndex 必须指向 q.meaning；
   'vocab' 题带 correctIndex 但不下发 meaning，仅校验其在范围内且所指释义有效；
   'pk' 题不下发 correctIndex/meaning（防泄题），只校验选项。 */
function checkQuestion(q, ctx, kind) {
  checked++;
  const opts = q.options || [];
  checkOptions(opts, ctx);
  if (kind === 'study') {
    ok(typeof q.correctIndex === 'number' && q.correctIndex >= 0 && q.correctIndex <= 3, ctx + ' correctIndex 在 0-3');
    ok(opts[q.correctIndex] === q.meaning, ctx + ' correctIndex 指向 q.meaning');
  } else if (kind === 'vocab') {
    ok(typeof q.correctIndex === 'number' && q.correctIndex >= 0 && q.correctIndex <= 3, ctx + ' correctIndex 在 0-3');
    ok(!POS_ONLY.test(String(opts[q.correctIndex] || '').trim()), ctx + ' correctIndex 所指释义有效');
  }
  // kind==='pk' 不校验 correctIndex（服务端不下发）
}

async function main() {
  const ua = U('A').toLowerCase();
  const reg = await api('/api/register', { username: ua, password: 'pw123456', name: '质检' });
  ok(reg.status === 200 && reg.data.token, '注册成功');
  const tok = reg.data.token;

  const books = ['zhongkao','gaokao','cet4','cet6','kaoyan','ielts','toefl','awl','es'];
  for (const bk of books) {
    await api('/api/study/plan', { token: tok, bookId: bk, dailyNew: 30, vocabEstimate: 0 });
    const ss = await api('/api/study/session?token=' + tok);
    ok(ss.status === 200, bk + ' daily session 成功');
    (ss.data.questions || []).forEach((q) => checkQuestion(q, bk + '/daily', 'study'));
    const rs = await api('/api/study/session?token=' + tok + '&mode=review');
    (rs.data.questions || []).forEach((q) => checkQuestion(q, bk + '/review', 'study'));
  }
  // 单元 session
  await api('/api/study/plan', { token: tok, bookId: 'cet4', dailyNew: 10, vocabEstimate: 0 });
  const us = await api('/api/study/session?token=' + tok + '&mode=unit&unit=2');
  (us.data.questions || []).forEach((q) => checkQuestion(q, 'cet4/unit2', 'study'));

  // PK 出题
  const created = await api('/api/create', { token: tok, bookId: 'cet4', mode: 'word', count: 20 });
  const rid = created.data.roomId, pid = created.data.playerId;
  await api('/api/ready', { roomId: rid, playerId: pid }); // 全员准备后才能开始
  await api('/api/start', { roomId: rid, playerId: pid });
  await new Promise((r) => setTimeout(r, 3400));           // 3 秒倒计时
  const st = (await api('/api/state?roomId=' + rid + '&playerId=' + pid)).data;
  if (st.question) checkQuestion(st.question, 'PK/cet4', 'pk');
  else console.log('  ✗ PK 未能进入答题阶段，题目质量未被校验');

  // 词汇量自测
  const vt = await api('/api/vocabtest/questions');
  ok(vt.status === 200 && Array.isArray(vt.data.questions), '词汇量自测题获取成功');
  (vt.data.questions || []).forEach((q) => checkQuestion(q, 'vocabtest', 'vocab'));

  console.log('\n== 选项质量验证 ==');
  console.log('检查题目数: ' + checked + ' · 通过 ' + pass + ' · 失败 ' + fail);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
