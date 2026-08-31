/* 回归测试：词书词应补全「日常义」（对应反馈：default 的「默认/缺省」此前缺失）
 * 场景：default 在词书里只有「违约/拖欠」（考试词书只教这层意思），
 *       但「默认/缺省」是最高频的日常义，必须经由在线词典补全并合并进详情。
 * 校验：① 详情 senses 含「默认/缺省」；
 *      ② cet6 与 ielts 对同一词的「违约/拖欠」近义只保留一条（不重复）；
 *      ③ 合并后义项数量合理（≤4）。
 * 需要网络（有道）才能补全；启动服务时自动等待富化并轮询。
 * 用法：node tools/default-everyday-meaning-test.js
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 3944;
const BASE = 'http://localhost:' + PORT;
const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'vpk-def-'));
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

  const U = 'dm' + Date.now().toString(36).slice(-8);
  const reg = await req('POST', '/api/register', { username: U, password: 'pw123456', name: 'DefMean' });
  const token = reg.json.token;
  if (!token) { console.error('登录失败'); srv.kill(); process.exit(2); }

  // 首次查询触发后台富化；轮询等待「默认/缺省」补全（最多 ~20s）
  let r = await req('GET', '/api/word?w=default&lang=en', null, token);
  for (let i = 0; i < 40; i++) {
    const ds = (r.json && r.json.senses) || [];
    if (ds.some((s) => /默认|缺省/.test(s.def))) break;
    await sleep(500);
    r = await req('GET', '/api/word?w=default&lang=en', null, token);
  }
  const senses = (r.json && r.json.senses) || [];
  const defs = senses.map((s) => s.def);
  console.log('  default 详情 senses: ' + JSON.stringify(defs));

  console.log('\n断言：');
  ok('default 详情含「默认/缺省」日常义（此前缺失）', senses.some((s) => /默认|缺省/.test(s.def)), 'senses=' + JSON.stringify(defs));
  ok('default 保留「违约/拖欠」词书义', senses.some((s) => /违约|拖欠/.test(s.def)));
  ok('「违约/拖欠」近义只保留一条（cet6/ielts 不重复）', senses.filter((s) => /违约|拖欠/.test(s.def)).length <= 1, JSON.stringify(senses.filter((s) => /违约|拖欠/.test(s.def)).map((s) => s.def)));
  ok('合并后义项数量合理（≤4）', senses.length <= 4, '实际 ' + senses.length + ' 条');

  srv.kill();
  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
