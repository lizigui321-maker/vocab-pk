/* 回归测试：作者反馈功能（文字 + 截图）
 * 场景：用户在软件里填表提交 → 服务端落本地 +（若配置了 SMTP）发邮件给作者。
 * 校验：① 纯文字可提交；② 文字+截图(base64)可提交；③ 无内容被拒(400)；
 *      ④ 后台查看需 admin token(无 token 403 / 有 token 返回列表且含提交)；⑤ 频率限制(>12/小时 429)。
 * 注：本测试不配置 SMTP，故 emailed 应为 false，但反馈必须成功落本地（前端据此仍显示「已收到」）。
 * 用法：node tools/feedback-test.js
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 3952;
const BASE = 'http://localhost:' + PORT;
const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'vpk-fb-'));
const ADMIN = 'testadmin';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  -> ' + extra : '')); }
}
function req(method, p, body, token) {
  return new Promise((resolve, reject) => {
    let pp = p, b = body;
    if (token) { if (b && typeof b === 'object') b = Object.assign({ token }, b); else if (method === 'POST') b = { token }; else pp += (pp.indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(token); }
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
  console.log('启动服务 (PORT=' + PORT + ', STORE=' + STORE + ', FEEDBACK_ADMIN_TOKEN=' + ADMIN + ') ...');
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: Object.assign({}, process.env, { PORT: String(PORT), STORE_DIR: STORE, FEEDBACK_ADMIN_TOKEN: ADMIN }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stderr.on('data', (d) => { const t = d.toString(); if (/Error|error/.test(t)) process.stderr.write('[srv] ' + t); });

  let ready = false;
  for (let i = 0; i < 50; i++) {
    try { const r = await req('GET', '/api/books'); if (r.status === 200) { ready = true; break; } } catch (e) {}
    await sleep(200);
  }
  if (!ready) { console.error('服务未就绪'); srv.kill(); process.exit(2); }

  console.log('\n断言：');
  // ① 纯文字
  let r = await req('POST', '/api/feedback', { text: '背单词时音标没显示' });
  ok('纯文字反馈提交成功', r.status === 200 && r.json.ok === true, 'status=' + r.status + ' json=' + JSON.stringify(r.json));
  ok('未配置 SMTP 时 emailed=false（仍可落本地）', r.json.emailed === false, 'emailed=' + r.json.emailed);

  // ② 文字 + 截图
  r = await req('POST', '/api/feedback', { text: '报错截图如下', image: PNG });
  ok('文字+截图反馈提交成功', r.status === 200 && r.json.ok === true, 'status=' + r.status);

  // ③ 无内容被拒
  r = await req('POST', '/api/feedback', {});
  ok('空内容被拒(400)', r.status === 400, 'status=' + r.status);

  // 非法截图格式
  r = await req('POST', '/api/feedback', { image: 'data:text/plain;base64,abc' });
  ok('非法截图格式被拒(400)', r.status === 400, 'status=' + r.status);

  // ④ 后台查看需 admin token
  r = await req('GET', '/api/feedback');
  ok('无 admin token 查看被拒(403)', r.status === 403, 'status=' + r.status);
  r = await req('GET', '/api/feedback?admin=' + ADMIN);
  ok('有 admin token 可查看列表', r.status === 200 && Array.isArray(r.json.items), 'status=' + r.status);
  const items = (r.json.items || []);
  ok('列表含刚才提交的两份反馈', items.length >= 2, 'items=' + items.length);
  ok('列表项的 text/at/ip 字段完整', items.every((it) => it.at && 'ip' in it && 'text' in it), JSON.stringify(items[0] || {}));

  // ⑤ 频率限制：同一 IP 连续提交 >12 条应触发 429
  let got429 = 0, got200 = 0;
  for (let i = 0; i < 20; i++) {
    const rr = await req('POST', '/api/feedback', { text: '压测 ' + i });
    if (rr.status === 429) got429++;
    else if (rr.status === 200) got200++;
  }
  ok('频率限制生效：超出后返回 429', got429 > 0, '429=' + got429 + ' 200=' + got200);
  ok('频率限制不过度：并非全部被拦', got200 > 0, '200=' + got200);

  srv.kill();
  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
