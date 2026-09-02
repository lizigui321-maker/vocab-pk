'use strict';
/* 验证 books.json 修正已通过服务端 /api/word（离线词书索引）生效。
 * /api/word 需登录，故先注册临时账号取 token。
 * 用法：BASE_URL=http://127.0.0.1:3199 node tools/verify-meaning-fix.js */
const BASE = process.env.BASE_URL || 'http://127.0.0.1:3199';
async function api(p, body, method) {
  const r = await fetch(BASE + p, {
    method: method || (body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let d = {}; try { d = await r.json(); } catch (e) {}
  return { status: r.status, data: d };
}
async function word(w, tok) {
  const r = await fetch(BASE + '/api/word?w=' + encodeURIComponent(w) + '&wait=0&token=' + tok);
  const d = await r.json().catch(() => ({}));
  return d;
}
// [word, 必须出现的义项关键词, 不应再作为【唯一/首条】出现的旧生僻义]
const CASES = [
  ['quick', '快', '核心'],
  ['august', '八月', '威严的'],
  ['refuse', '拒绝', '垃圾'],
  ['pitch', '球场', '沥青'],
  ['grave', '严重', '坟墓'],
  ['fringe', '边缘', '附加'],
  ['monster', '怪物', '庞大'],
  ['trifle', '琐事', '嘲笑'],
  // 用户截图反馈 fit 在雅思中只显示生僻医学义；/api/word 可能返回已缓存的在线富化数据，
  // 所以用首条词书义项里一定出现的「适应」做 must，重点仍是 firstAvoid=痉挛 不再孤立出现。
  ['fit', '适应', '痉挛'],
];
(async () => {
  const ua = 'vfix_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const reg = await api('/api/register', { username: ua, password: 'pw123456', name: '释义校验' });
  if (reg.status !== 200 || !reg.data.token) { console.log('注册失败', reg); process.exit(2); }
  const tok = reg.data.token;
  let fail = 0;
  for (const [w, must, avoidAlone] of CASES) {
    const d = await word(w, tok);
    const senses = (d && d.senses) || [];
    const all = senses.map((s) => (s.pos || '') + (s.def || '')).join(' | ');
    const first = senses[0] ? ((senses[0].pos || '') + (senses[0].def || '')) : '';
    const hasMust = all.indexOf(must) >= 0;
    const firstAvoid = first.indexOf(avoidAlone) >= 0 && first.indexOf(must) < 0;
    if (hasMust && !firstAvoid) console.log('  ✓ ' + w + '：含「' + must + '」，首条不再是孤立的「' + avoidAlone + '」  [' + first + ']');
    else { fail++; console.log('  ✗ ' + w + ' FAIL  must=' + must + ' firstAvoid=' + avoidAlone + '  senses=' + JSON.stringify(senses)); }
  }
  console.log(fail ? ('\n失败 ' + fail + ' 项') : '\n全部通过：修正已在服务端生效');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(3); });
