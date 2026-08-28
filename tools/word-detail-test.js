/*
 * 单词详解接口 /api/word 测试（需求 1 & 2：音标 / 真人发音 / 详略得当的释义）
 * 运行：node tools/word-detail-test.js
 * 前置：server.js 已在某端口运行；设置 BASE_URL=http://localhost:PORT 可改端口
 * 覆盖：
 *   1. 未登录访问 → 401
 *   2. 英文词（hello）→ 音标 / 词性释义 / 变形 / 搭配 / 例句 / 考试标签 / 真人音频
 *   3. 西语词（perro）→ multle 完整词典（n.(阴) 狗，犬 等）
 *   4. 西语形近词过滤（hola）→ 只有「你好；喂」，不混入 Holanda 等
 *   5. 不存在的词 → 200 {ok:false}（负缓存，不 500）
 *   6. 释义「详略得当」：单个词性释义条数有限，不塞 8 个义项
 */
'use strict';
const BASE = process.env.BASE_URL || 'http://localhost:3000';
let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ FAIL: ' + msg); }
}
async function api(p, body, method) {
  const r = await fetch(BASE + p, {
    method: method || (body ? 'POST' : 'GET'),
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let j = {};
  try { j = await r.json(); } catch (e) {}
  return { status: r.status, json: j };
}
(async () => {
  const u = 'wdt' + Math.random().toString(36).slice(2, 8);
  const pw = 'test1234';
  console.log('== 0. 未登录访问 /api/word 应 401 ==');
  let r = await api('/api/word?w=hello');
  ok(r.status === 401, '未登录 → 401（实际 ' + r.status + '）');

  console.log('== 1. 注册登录 ==');
  r = await api('/api/register', { username: u, password: pw });
  ok(r.status === 200 && r.json.token, '注册成功');
  const TOKEN = r.json.token;
  const H = { Authorization: 'Bearer ' + TOKEN };

  console.log('== 2. 英文词 hello：完整详解结构 ==');
  r = await fetch(BASE + '/api/word?w=hello&lang=en', { headers: H });
  const h = await r.json();
  ok(r.status === 200 && h.ok === true, '接口返回 ok=true');
  ok(!!h.ipa && /[a-zA-Zəʊɜːˈˌ]/.test(h.ipa), '有音标 /' + h.ipa + '/');
  ok(Array.isArray(h.senses) && h.senses.length >= 2, '词性释义 >= 2 条（' + (h.senses || []).length + '）');
  ok(h.senses.every(s => s.pos && s.def), '每条释义都有词性与释义文本');
  ok(Array.isArray(h.forms) && h.forms.length > 0, '有词形变化（' + (h.forms || []).length + '）');
  ok(Array.isArray(h.phrases) && h.phrases.length > 0, '有常用搭配（' + (h.phrases || []).length + '）');
  ok(Array.isArray(h.examples) && h.examples.length > 0, '有例句（' + (h.examples || []).length + '）');
  ok(/dict\.youdao\.com\/dictvoice/.test(h.audio || ''), '有真人发音音频 URL');
  ok((h.exams || []).length > 0, '有考试标签（' + (h.exams || []).join('/') + '）');

  console.log('== 3. 释义「详略得当」：单条释义不超长、总条数受限 ==');
  ok(h.senses.every(s => (s.def || '').length <= 170), '每条释义 <= 170 字');
  ok(h.senses.length <= 4, '总义项 <= 4 条');

  console.log('== 4. 西语 perro：multle 完整词典 ==');
  r = await fetch(BASE + '/api/word?w=perro&lang=es', { headers: H });
  const perro = await r.json();
  ok(r.status === 200 && perro.ok === true, '接口返回 ok=true');
  ok(perro.senses.some(s => s.def.indexOf('狗') >= 0), '含「狗」义项');
  ok(perro.senses.some(s => s.pos), '带词性标记');
  ok(/dict\.youdao\.com\/dictvoice\?le=es/.test(perro.audio || ''), '有西语真人发音 URL');

  console.log('== 5. 西语 hola：形近词过滤（不混入 Holanda） ==');
  r = await fetch(BASE + '/api/word?w=hola&lang=es', { headers: H });
  const hola = await r.json();
  ok(r.status === 200 && hola.ok === true, '接口返回 ok=true');
  const holaDef = (hola.senses || []).map(s => s.def).join(' ');
  ok(holaDef.indexOf('你好') >= 0, '含「你好」');
  ok(holaDef.indexOf('Holanda') < 0 && holaDef.indexOf('荷兰') < 0, '不混入形近词 Holanda');

  console.log('== 6. 不存在的词：负缓存，返回 ok:false 而非 500 ==');
  r = await fetch(BASE + '/api/word?w=zzzqqxnotexist123&lang=en', { headers: H });
  const nf = await r.json();
  ok(r.status === 200 && nf.ok === false, '200 {ok:false}（实际 status=' + r.status + ' ok=' + nf.ok + '）');

  console.log('== 7. 参数校验 ==');
  r = await fetch(BASE + '/api/word?lang=en', { headers: H });
  ok(r.status === 400, '缺 w 参数 → 400');
  r = await fetch(BASE + '/api/word?w=' + encodeURIComponent('a'.repeat(200)), { headers: H });
  ok(r.status === 200 || r.status === 400, '超长单词不崩溃（实际 ' + r.status + '）');

  console.log('== 8. 清理测试账号 ==');
  try {
    const path = require('path');
    const fs = require('fs');
    const af = path.join(__dirname, '..', 'store', 'accounts.json');
    if (fs.existsSync(af)) {
      const accs = JSON.parse(fs.readFileSync(af, 'utf8'));
      let removed = 0;
      for (const k of Object.keys(accs)) {
        if (/^wdt/.test(k)) { delete accs[k]; removed++; }
      }
      fs.writeFileSync(af, JSON.stringify(accs));
      ok(removed > 0, '已清理 ' + removed + ' 个测试账号');
    } else {
      console.log('  · 无本地 accounts.json（远程环境），跳过清理');
    }
  } catch (e) { ok(false, '清理失败: ' + e.message); }

  console.log('\n单词详解接口: ' + (fail ? ('失败 ' + fail + ' 项') : '通过 ' + pass + ' 项，失败 0 项'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
