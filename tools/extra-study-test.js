/*
 * 临时加学（extra study）回归测试
 * 运行：node tools/extra-study-test.js
 * 前置：server.js 已在 BASE_URL 监听
 *
 * 覆盖（修复前会炸的坑）：
 *   临时加学允许反复点「加学」叠加更多新词。旧逻辑每次都从 unlearnedAll 第 0 位切，
 *   导致「没答完当前这批就再点一次」会把同一批词重复加进队列（重复背词）。
 *   修复：前端把当前队列已有词通过 exclude 回传，后端据此返回【下一批】未学词。
 *   本测试直接打后端接口验证：带 exclude 的连续多次加学，批次之间互不重复。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const STORE = process.env.STORE_DIR
  ? path.resolve(__dirname, '..', process.env.STORE_DIR)
  : path.join(__dirname, '..', 'store');
let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ FAIL: ' + msg); }
}
async function api(p, body, method) {
  const r = await fetch(BASE + p, {
    method: method || (body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let d = {}; try { d = await r.json(); } catch (e) {}
  return { status: r.status, data: d };
}
const U = (p) => 'exs_' + p + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

function wordsOf(sess) { return (sess.questions || []).map((q) => String(q.word).toLowerCase()); }
function disjoint(a, b) {
  const s = new Set(a);
  for (const x of b) if (s.has(x)) return false;
  return true;
}

(async () => {
  console.log('== 1. 注册 + 学习计划（新账号，全部未学）==');
  const user = U('a');
  const reg = await api('/api/register', { username: user, password: 'Pwd@2026', name: '加学测试' });
  const token = reg.data && reg.data.token;
  ok(!!token, '注册成功并拿到 token');
  const plan = await api('/api/study/plan', { token, bookId: 'cet4', dailyNew: 10, vocabEstimate: 0 });
  ok(plan.status === 200, '学习计划设置成功（cet4 / 每日 10 新词）');

  console.log('== 2. 临时加学：连续多次，批次互不重复 ==');
  // 第一次加学：队列空，exclude 为空，取前 20 个未学词
  const b1 = await api('/api/study/session?mode=daily&extraNew=20&token=' + token);
  const w1 = wordsOf(b1.data);
  ok(b1.status === 200 && w1.length === 20, '第一次加学返回 20 个词（实际 ' + w1.length + '）');

  // 第二次加学：exclude 第一次的 20 个词，应返回【下一批】20 个，且不与第一次重复
  const excl1 = w1.join(',');
  const b2 = await api('/api/study/session?mode=daily&extraNew=20&exclude=' + encodeURIComponent(excl1) + '&token=' + token);
  const w2 = wordsOf(b2.data);
  ok(b2.status === 200 && w2.length === 20, '第二次加学返回 20 个词（实际 ' + w2.length + '）');
  ok(disjoint(w1, w2), '第二次加学的词与第一次【完全不重复】（修复前会重复同一批）');

  // 第三次加学：exclude 前两次共 40 个，应返回再下一批 20 个，与前两批都不重复
  const excl2 = w1.concat(w2).join(',');
  const b3 = await api('/api/study/session?mode=daily&extraNew=20&exclude=' + encodeURIComponent(excl2) + '&token=' + token);
  const w3 = wordsOf(b3.data);
  ok(b3.status === 200 && w3.length === 20, '第三次加学返回 20 个词（实际 ' + w3.length + '）');
  ok(disjoint(w1, w3) && disjoint(w2, w3), '第三次加学的词与前两批都不重复');

  // 反向验证：若【不传 exclude】，第二次会再次返回同一批（证明 exclude 是修复关键）
  const b2no = await api('/api/study/session?mode=daily&extraNew=20&token=' + token);
  const w2no = wordsOf(b2no.data);
  ok(!disjoint(w1, w2no), '对照：不带 exclude 时第二次会重复第一次的词（旧逻辑，前端已修正为带 exclude）');

  console.log('== 3. 用完词池后优雅收尾 ==');
  // 把 exclude 设成巨大集合，模拟已加完大部分，剩余不足 20 时应返回剩余且不报错
  const bigPool = Array.from({ length: 200 }, (_, i) => 'padword' + i).join(',');
  const b4 = await api('/api/study/session?mode=daily&extraNew=20&exclude=' + encodeURIComponent(bigPool) + '&token=' + token);
  ok(b4.status === 200, 'exclude 很大时仍正常返回（不崩）');

  console.log('========================================');
  console.log('  临时加学回归: 通过 ' + pass + ' 项，失败 ' + fail + ' 项');

  // 本地清理：删除本测试建的 exs_ 账号，避免污染 store
  try {
    const af = path.join(STORE, 'accounts.json');
    if (fs.existsSync(af)) {
      const acc = JSON.parse(fs.readFileSync(af, 'utf8'));
      let removed = 0;
      for (const k of Object.keys(acc)) if (k.startsWith('exs_')) { delete acc[k]; removed++; }
      if (removed) fs.writeFileSync(af, JSON.stringify(acc));
      console.log('  · 清理 ' + removed + ' 个测试账号');
    }
  } catch (e) { /* 清理失败不影响测试结果 */ }

  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试脚本异常:', e); process.exit(1); });
