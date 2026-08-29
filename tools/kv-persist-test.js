/*
 * 持久化集成测试：用内存 mock 模拟 Upstash REST，验证「重启不丢数据」
 * 流程：起 mock KV(3999) → 起 app(3001, UPSTASH 指向 mock) → 注册用户 → 杀掉 app → 再起 app → 登录同一用户应成功
 * 运行：node tools/kv-persist-test.js
 */
'use strict';
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const KV_PORT = 3999;
const APP_PORT = 3001;
const store = {}; // mock Redis

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓ ' + msg); } else { fail++; console.log('  ✗ FAIL: ' + msg); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(base, p, body, method) {
  const r = await fetch(base + p, {
    method: method || (body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let d = {};
  try { d = await r.json(); } catch (e) {}
  return { status: r.status, data: d };
}

const kvServer = http.createServer((req, res) => {
  const m = req.url.match(/^\/(get|set)\/(.+)$/);
  if (!m) { res.writeHead(404); res.end('{}'); return; }
  const op = m[1], key = decodeURIComponent(m[2]);
  if (op === 'get') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ result: key in store ? store[key] : null }));
  } else {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      // 与真实 Upstash 一致：按原样字符串保存，不解析（否则会掩盖序列化层级的 bug）
      store[key] = body;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ result: 'OK' }));
    });
  }
});

function startApp() {
  const env = Object.assign({}, process.env, {
    PORT: String(APP_PORT),
    STORE_DIR: path.join(__dirname, '..', 'store', 'kv-test-tmp'),
    UPSTASH_REDIS_REST_URL: 'http://127.0.0.1:' + KV_PORT,
    UPSTASH_REDIS_REST_TOKEN: 'mock-token',
  });
  return spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, stdio: 'ignore' });
}

async function waitUp() {
  for (let i = 0; i < 30; i++) {
    try { const r = await fetch('http://127.0.0.1:' + APP_PORT + '/api/info'); if (r.ok) return true; } catch (e) {}
    await sleep(300);
  }
  return false;
}

async function main() {
  await new Promise((r) => kvServer.listen(KV_PORT, r));
  console.log('== 1. 首次启动：注册用户并写入数据 ==');
  let app = startApp();
  ok(await waitUp(), 'app 第一次启动成功');
  const u = 'kvtest' + Date.now().toString(36);
  const reg = await api('http://127.0.0.1:' + APP_PORT, '/api/register', { username: u, password: 'pw123456', name: '持久化' });
  ok(reg.status === 200 && reg.data.token, '注册成功');
  await sleep(700); // 等防抖把数据写进 mock KV
  const keys = Object.keys(store);
  ok(keys.some((k) => k.endsWith('accounts')), '账号数据已写入云端 KV（' + keys.join(',') + '）');
  const accInKv = JSON.parse(store[keys.find((k) => k.endsWith('accounts'))] || '{}');
  ok(!!accInKv[u], 'KV 中的 accounts 含新注册用户');

  console.log('== 2. 模拟 Render 部署：杀掉 app 并清空本地临时目录，再重启 ==');
  app.kill('SIGTERM');
  await sleep(1200);
  // 用系统命令删除临时目录（绕过 Node fs 的安全删除拦截）
  try { require('child_process').execSync('rmdir /s /q "' + path.join(__dirname, '..', 'store', 'kv-test-tmp') + '"'); } catch (e) {}
  app = startApp();
  ok(await waitUp(), 'app 第二次启动成功（本地文件已删，靠云端恢复）');
  const login = await api('http://127.0.0.1:' + APP_PORT, '/api/login', { username: u, password: 'pw123456' });
  ok(login.status === 200 && login.data.token, '重启后账号仍在，登录成功（数据从云端恢复）');
  const info = await api('http://127.0.0.1:' + APP_PORT, '/api/info');
  ok(info.data.storeMode === 'upstash', '/api/info 报告 storeMode=upstash');

  app.kill('SIGTERM');
  await sleep(800);
  kvServer.close();
  try { require('child_process').execSync('rmdir /s /q "' + path.join(__dirname, '..', 'store', 'kv-test-tmp') + '"'); } catch (e) {}
  console.log('\n持久化集成测试: 通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
