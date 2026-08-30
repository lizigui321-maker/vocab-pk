/*
 * 回归测试：熟词本（acc.known）里的词在任何学习场景下都不应再出现。
 * 用只有 3 个词的自定义词书，保证目标词一定落在返回窗口内，从而稳定复现历史 bug：
 *   ① markKnown 不写 st.progress.n → daily 新词队列把熟词当「从未学过的生词」再次放出；
 *   ② 进度被整体重置（scope=progress）后，原判断失效，熟词本里的词又冒出来；
 *   ③ 单元 / 复习模式同样不应出现熟词本里的词。
 * 运行：先启动 server.js（如 PORT=3200），再 node tools/known-word-test.js
 *   BASE_URL=http://localhost:3200
 */
'use strict';
const BASE = process.env.BASE_URL || 'http://localhost:3200';
let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓ ' + msg); } else { fail++; console.log('  ✗ FAIL: ' + msg); } }

async function api(p, body, method) {
  const r = await fetch(BASE + p, {
    method: method || (body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let d = {}; try { d = await r.json(); } catch (e) {}
  return { status: r.status, data: d };
}
const U = (p) => 'kn_' + p + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const W = () => 'zz' + Math.random().toString(36).slice(2, 7); // 生造词，避免与全局词库碰撞

async function main() {
  const u = U('A').toLowerCase();
  const reg = await api('/api/register', { username: u, password: 'pw123456', name: '熟词测试' });
  const tok = reg.data.token;
  ok(!!tok, '注册成功并拿到 token');

  // 建一个只有 3 个词的自定义词书，保证目标词一定落在返回窗口内
  const w1 = W(), w2 = W(), w3 = W();
  const cbText = `${w1} 意思一\n${w2} 意思二\n${w3} 意思三`;
  const cb = await api('/api/custombook', { token: tok, name: '熟词回归词书', lang: 'en', text: cbText });
  ok(cb.status === 200 && cb.data.id, '自定义词书创建成功');
  const cbId = cb.data.id;
  const plan = await api('/api/study/plan', { token: tok, bookId: cbId, dailyNew: 3, vocabEstimate: 0 });
  ok(plan.status === 200 && plan.data.ok, '计划已设为自定义词书');

  const wordsOf = async (mode, extra) => {
    const p = '/api/study/session?token=' + tok + '&mode=' + mode + (extra || '');
    const s = await api(p);
    return (s.data.questions || []).map((q) => String(q.word).toLowerCase());
  };

  console.log('== 基线：3 个词都能取到 ==');
  let ws = await wordsOf('daily');
  ok(ws.length === 3 && [w1, w2, w3].every((w) => ws.includes(w)), 'daily 返回全部 3 个词（基线）');

  console.log('== ① markKnown（从未学过，pr.n=0）→ 不应再出现在任何学习场景 ==');
  const target = w1;
  const mk = await api('/api/study/markKnown', { token: tok, word: target });
  ok(mk.status === 200 && mk.data.ok, 'markKnown 成功');
  ws = await wordsOf('daily');
  ok(!ws.includes(target), 'markKnown 后：daily session 不再含目标词');
  const knownGet = await api('/api/known?token=' + tok);
  ok((knownGet.data.words || []).some((x) => String(x.word).toLowerCase() === target), '目标词确实在熟词本里');
  const unitWs = await wordsOf('unit&unit=0');
  ok(!unitWs.includes(target), 'markKnown 后：单元 session 不再含目标词');
  ok(unitWs.length === 2, '单元 session 还剩 2 个词');
  const revWs = await wordsOf('review&limit=50');
  ok(!revWs.includes(target), 'markKnown 后：review session 不再含目标词');

  console.log('== ② 进度整体重置（scope=progress）后，熟词本里的词仍不应冒出来 ==');
  await api('/api/study/reset', { token: tok, scope: 'progress' });
  ws = await wordsOf('daily');
  ok(!ws.includes(target), '重置学习进度后，熟词本里的词依然不出现（修复②）');
  const unitWs2 = await wordsOf('unit&unit=0');
  ok(!unitWs2.includes(target), '重置后单元 session 仍不含目标词');

  console.log('== ③ 学满掌握（5 次答对）→ 进熟词本；重置进度后亦不再出现 ==');
  for (let i = 0; i < 5; i++) await api('/api/study/answer', { token: tok, word: w2, correct: true, ms: 1000 });
  const ov = await api('/api/study/overview?token=' + tok);
  ok(ov.data.mastered >= 1, '学满后 mastered>=1');
  const knownGet2 = await api('/api/known?token=' + tok);
  ok((knownGet2.data.words || []).some((x) => String(x.word).toLowerCase() === w2), '掌握的词进入熟词本');
  await api('/api/study/reset', { token: tok, scope: 'progress' });
  ws = await wordsOf('daily');
  ok(!ws.includes(w2), '重置进度后，已掌握且进熟词本的词不再出现（修复②）');

  // 清理
  await api('/api/study/reset', { token: tok, scope: 'all' });

  console.log(`\n熟词本回归: 通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('❌ 运行异常:', e.message); process.exit(1); });
