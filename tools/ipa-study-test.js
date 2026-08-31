/* 回归测试：学单词（背单词答题界面）应显示音标（IPA）
 * 对应反馈：「学单词的时候都没有音标」。
 * 根因：前端答题界面此前用 fetchDetail(word, lang, cb)（不带 wait），
 *       后端对词书词优先返回「仅词书义」的书本条目（无音标），导致 #sqIpa 永远为空。
 * 修复：答题界面改用 fetchIPA（内部 fetchDetail(..., wait=1)），等待在线富化取回音标。
 *       本测试验证前端所依赖的后端契约：/api/word?w=W&lang=en&wait=1 必须返回音标。
 * 需要网络（有道）补全；启动服务后自动等待富化。
 * 用法：node tools/ipa-study-test.js
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 3951;
const BASE = 'http://localhost:' + PORT;
const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'vpk-ipa-'));
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  -> ' + extra : '')); }
}
function req(method, p, body, token) {
  return new Promise((resolve, reject) => {
    let pp = p, b = body;
    if (token) {
      if (b && typeof b === 'object') b = Object.assign({ token }, b);
      else if (method === 'POST') b = { token };
      else pp += (pp.indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(token);
    }
    const data = b ? JSON.stringify(b) : null;
    const r = http.request(BASE + pp, {
      method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
    }, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(body) }); } catch (e) { resolve({ status: res.statusCode, json: {} }); } });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log('启动服务 (PORT=' + PORT + ', STORE=' + STORE + ') ...');
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: Object.assign({}, process.env, { PORT: String(PORT), STORE_DIR: STORE }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stderr.on('data', (d) => { const t = d.toString(); if (/Error|error/.test(t)) process.stderr.write('[srv] ' + t); });

  let ready = false;
  for (let i = 0; i < 50; i++) {
    try { const r = await req('GET', '/api/books'); if (r.status === 200) { ready = true; break; } } catch (e) {}
    await sleep(200);
  }
  if (!ready) { console.error('服务未就绪'); srv.kill(); process.exit(2); }

  const U = 'ipa' + Date.now().toString(36).slice(-8);
  const reg = await req('POST', '/api/register', { username: U, password: 'pw123456', name: 'IpaTest' });
  const token = reg.json.token;
  if (!token) { console.error('登录失败'); srv.kill(); process.exit(2); }

  // 建一本极小自定义词书并设为学习计划，拿到真实出题词（贴合「学单词」场景）
  const cb = await req('POST', '/api/custombook', { name: 'IPA', lang: 'en', text: 'default 默认\napple 苹果\nbook 书\nwater 水\nhappy 快乐\nstudent 学生' }, token);
  await req('POST', '/api/study/plan', { bookId: cb.json.id, dailyNew: 10, vocabEstimate: 0 }, token);
  const sess = await req('GET', '/api/study/session?mode=daily', null, token);
  const qWords = (sess.json.questions || []).map((q) => q.word).filter(Boolean);
  console.log('  学习计划首屏出题词: ' + JSON.stringify(qWords));

  // 前端答题界面现在对每个词调用 fetchIPA -> /api/word?...&wait=1
  console.log('\n断言：wait=1 必须返回音标（前端依赖的契约）');

  // 1) 真实出题词逐个验证 wait=1 返回音标
  for (const w of qWords) {
    let r = await req('GET', '/api/word?w=' + encodeURIComponent(w) + '&lang=en&wait=1', null, token);
    const d = r.json;
    const ipa = d && (d.ipa || d.ipaUs);
    ok('出题词 ' + w + ' 经 wait=1 取得音标', !!(d && d.ok && ipa), 'ipa=' + (ipa || '无') + ' src=' + (d && d.src));
  }

  // 2) 固定常用词（验证通用词也 OK）
  const fixed = ['sound', 'run', 'beautiful'];
  for (const w of fixed) {
    let r = await req('GET', '/api/word?w=' + encodeURIComponent(w) + '&lang=en&wait=1', null, token);
    const d = r.json;
    const ipa = d && (d.ipa || d.ipaUs);
    ok('常用词 ' + w + ' 经 wait=1 取得音标', !!(d && d.ok && ipa), 'ipa=' + (ipa || '无') + ' src=' + (d && d.src));
  }

  // 3) 对照：不带 wait 时后端优先返回「仅词书义」条目（无音标）——说明为何必须 wait=1
  if (qWords.length) {
    const w = qWords[0];
    const ctrl = await req('GET', '/api/word?w=' + encodeURIComponent(w) + '&lang=en', null, token);
    const noWaitIpa = ctrl.json && (ctrl.json.ipa || ctrl.json.ipaUs);
    console.log('  对照（不带 wait）首屏 ' + w + ' 音标=' + (noWaitIpa || '无') + ' src=' + (ctrl.json && ctrl.json.src));
    ok('不带 wait 的首屏可能无音标（正是此前的 bug 根因）', true, 'noWaitIpa=' + (noWaitIpa || '无'));
  }

  srv.kill();
  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
