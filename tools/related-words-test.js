/*
 * 单词详解「关联词」回归测试
 * 覆盖：近义词 synonyms / 反义词 antonyms / 同根派生词 related / 词根词源 etym
 *      + 关联词可点进去（目标词本身能查到详解，保证跳过去不是空白）
 * 运行：node tools/related-words-test.js
 * 前置：server.js 已在某端口运行；BASE_URL 可改端口
 *
 * 背景（别踩回去的坑）：
 *  - 有道的同义词在 d.syno.synos[].syno.ws[{w}]，不是 synos[].ws —— 后者恒为空，
 *    曾据此误判「有道没有同义词」。
 *  - 有道 rel_word.rels[].rel = {pos, words:[{word,tran}]} 是「同根/派生词」的现成来源
 *    （happy→adv:happily / n:happiness；create→adj:creative / n:creation,creativity…）。
 *  - 有道完全没有反义词字段，只能从 dictionaryapi.dev 取，且是后台异步补的，
 *    所以「反义词可能为空」属正常，不能断言其必然存在。
 */
'use strict';
const BASE = process.env.BASE_URL || 'http://127.0.0.1:3256';
let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ FAIL: ' + msg); }
}
async function get(path, token) {
  const r = await fetch(BASE + path, { headers: token ? { Authorization: 'Bearer ' + token } : {} });
  let j = null;
  try { j = await r.json(); } catch (e) {}
  return { status: r.status, json: j };
}
async function detail(word, token) {
  const r = await get('/api/word?w=' + encodeURIComponent(word) + '&lang=en&wait=1', token);
  return r.json || {};
}
(async () => {
  const u = 'rwt' + Math.random().toString(36).slice(2, 8);
  const reg = await fetch(BASE + '/api/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: u, password: 'test1234' }),
  });
  const regJ = await reg.json();
  const TOKEN = regJ.token;
  ok(!!TOKEN, '注册拿 token 成功');

  console.log('== 1. happy：近义词 / 派生词 / 词根 ==');
  const happy = await detail('happy', TOKEN);
  ok(Array.isArray(happy.synonyms), 'synonyms 是数组');
  const happySyn = [];
  (happy.synonyms || []).forEach((g) => (g.words || []).forEach((w) => happySyn.push(String(w).toLowerCase())));
  ok(happySyn.length > 0, '有近义词（' + happySyn.slice(0, 5).join(', ') + '）');
  ok(happySyn.indexOf('glad') >= 0 || happySyn.indexOf('pleased') >= 0,
    '近义词含 glad/pleased（实际：' + happySyn.slice(0, 6).join(', ') + '）');
  ok((happy.synonyms || []).every((g) => !g.pos || typeof g.pos === 'string'), '近义词分组 pos 是字符串');

  ok(Array.isArray(happy.related), 'related 是数组');
  const happyRel = [];
  (happy.related || []).forEach((g) => (g.words || []).forEach((w) => happyRel.push(String(w.word).toLowerCase())));
  ok(happyRel.length > 0, '有同根/派生词（' + happyRel.slice(0, 5).join(', ') + '）');
  ok(happyRel.indexOf('happiness') >= 0, '派生词含 happiness（名词形式）');
  ok(happyRel.indexOf('happily') >= 0, '派生词含 happily（副词形式）');
  const rel0 = (happy.related || [])[0] || {};
  ok(!!rel0.pos, '派生词带词性标记（' + rel0.pos + '）');
  ok((rel0.words || []).every((w) => w.word && typeof w.tran === 'string'), '派生词每项含 word 与中文 tran');

  ok(typeof happy.etym === 'string' && happy.etym.length > 0, '有词根词源（' + String(happy.etym || '').slice(0, 40) + '…）');

  console.log('== 2. create：派生词覆盖多种词性 ==');
  const create = await detail('create', TOKEN);
  const creRel = [];
  (create.related || []).forEach((g) => (g.words || []).forEach((w) => creRel.push(String(w.word).toLowerCase())));
  ok(creRel.indexOf('creative') >= 0, '派生词含 creative（形容词）');
  ok(creRel.indexOf('creatively') >= 0, '派生词含 creatively（副词）');
  ok(creRel.indexOf('creation') >= 0 || creRel.indexOf('creativity') >= 0, '派生词含 creation/creativity（名词）');
  const crePos = (create.related || []).map((g) => g.pos).join(' ');
  ok(/adj|adv|n/.test(crePos), '派生词按词性分组（' + crePos + '）');

  console.log('== 3. 关联词点进去必须能查到详解（跳转不是空白） ==');
  const targets = ['happiness', 'creative'];
  for (const t of targets) {
    const d = await detail(t, TOKEN);
    ok(d && d.ok !== false && Array.isArray(d.senses) && d.senses.length > 0,
      '点 ' + t + ' 能拿到详解（' + ((d.senses || []).length) + ' 条释义）');
  }

  console.log('== 4. 字段健壮性：缺失时为空数组而非 undefined（前端直接 .length 不炸） ==');
  const zzz = await detail('zzzqqxnotexist123', TOKEN);
  ok(zzz && (zzz.ok === false || !zzz.senses || !zzz.senses.length), '不存在的词返回空结果，不 500');
  for (const w of ['happy', 'create']) {
    const d = await detail(w, TOKEN);
    ok(Array.isArray(d.synonyms), w + ' synonyms 是数组（非 undefined）');
    ok(Array.isArray(d.related), w + ' related 是数组（非 undefined）');
    ok(Array.isArray(d.antonyms), w + ' antonyms 是数组（非 undefined；可为空，有道无此数据）');
  }

  console.log('\n' + (fail ? '✗ ' : '✓ ') + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
