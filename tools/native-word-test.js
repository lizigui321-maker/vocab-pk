/* 回归测试：词书释义正确性 —— native 不应显示 naive 的释义（「天真的」）
 * 对应反馈：「native 居然显示是天真的」。
 * 根因：books.json 里 雅思词汇 / 雅思核心词 两本词书的 native 词条被错填成
 *       naive 的释义「adj 天真的，幼稚的」（典型释义互换），且 naive 词条被整条删掉。
 *       buildBookIndex 把各词书同一词的义项合并，于是 native 的详情卡片里混进了「天真的」。
 * 修复：① books.json 中把这两处 native 改回「本国的，本土的，当地的」并补回 naivet 词条；
 *       ② 顺带把 DICT_VER 3→4，使生产环境已缓存的旧（错误）native 释义在重启后被淘汰重建。
 * 本测试断言：/api/word?w=native 的义项里【不】出现「天真的」，且含「本国的/本土的/当地的」；
 *            /api/word?w=naive 的义项里【有】「天真的」。
 * 纯离线校验（wait=0 走离线词书索引），无需联网。
 * 用法：node tools/native-word-test.js
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 3961;
const BASE = 'http://localhost:' + PORT;
const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'vpk-native-'));
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
function sensesOf(j) { return ((j && j.senses) || []).map((s) => (s.def || '')); }

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

  const U = 'ntv' + Date.now().toString(36).slice(-8);
  const reg = await req('POST', '/api/register', { username: U, password: 'pw123456', name: 'NativeTest' });
  const token = reg.json.token;
  if (!token) { console.error('登录失败'); srv.kill(); process.exit(2); }

  console.log('\n断言：native 的释义不应是「天真的」，naive 才应该是');
  const natR = await req('GET', '/api/word?w=native&lang=en&wait=0', null, token);
  const natSenses = sensesOf(natR.json);
  console.log('  native 义项: ' + JSON.stringify(natSenses));
  const naivR = await req('GET', '/api/word?w=naive&lang=en&wait=0', null, token);
  const naivSenses = sensesOf(naivR.json);
  console.log('  naive  义项: ' + JSON.stringify(naivSenses));

  ok('native 详情可查到', natR.json && natR.json.ok === true);
  ok('native 不含「天真的」释义', !natSenses.some((d) => /天真/.test(d)), 'got=' + JSON.stringify(natSenses));
  ok('native 含「本国的/本土的/当地的」', natSenses.some((d) => /(本国的|本土的|当地的)/.test(d)), 'got=' + JSON.stringify(natSenses));
  ok('naive 详情可查到', naivR.json && naivR.json.ok === true);
  ok('naive 含「天真的」释义', naivSenses.some((d) => /天真/.test(d)), 'got=' + JSON.stringify(naivSenses));

  srv.kill();
  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
