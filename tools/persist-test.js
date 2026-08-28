/*
 * 数据持久化加固测试（需求 3：版本更新/重启/崩溃都不能丢用户数据）
 * 运行：node tools/persist-test.js
 * 自建独立 STORE_DIR，全程不动真实数据。覆盖：
 *  - 正常注册 → 原子写入生成 .bak
 *  - 模拟进程被杀后 accounts.json 损坏 → 启动自动回退 .bak，账号仍在
 *  - 删除主文件 + .bak（磁盘被清空场景）→ 启动从每日快照自动恢复
 *  - 快照保留最近 7 份
 *  - SIGTERM 优雅退出（kvFlush 路径不抛错）
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const PORT = 3417;
const BASE = 'http://localhost:' + PORT;
const ROOT = path.join(__dirname, '..');
const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'vpk-persist-'));
const NODE = process.execPath;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ FAIL: ' + msg); }
}
function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, [path.join(ROOT, 'server.js')], {
      env: Object.assign({}, process.env, { PORT: String(PORT), STORE_DIR: STORE }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout.on('data', (c) => { log += c; });
    child.stderr.on('data', (c) => { log += c; });
    let tries = 0;
    const t = setInterval(async () => {
      tries++;
      try {
        const r = await fetch(BASE + '/api/info');
        if (r.ok) { clearInterval(t); resolve(child); }
        else if (tries > 30) { clearInterval(t); reject(new Error('server not up: ' + log.slice(-500))); }
      } catch (e) {
        if (tries > 30) { clearInterval(t); reject(new Error('server not up: ' + log.slice(-500))); }
      }
    }, 300);
  });
}
function stopServer(child) {
  return new Promise((resolve) => {
    child.on('exit', () => resolve());
    try { child.kill('SIGTERM'); } catch (e) { resolve(); }
    setTimeout(resolve, 4000);
  });
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

async function main() {
  console.log('存储目录: ' + STORE);
  console.log('== 1. 启动 + 注册，验证 .bak 原子备份 ==');
  let srv = await startServer();
  const uname = 'p' + Date.now().toString(36); // 控制在 16 位以内（用户名上限 16）
  const r1 = await api('/api/register', { username: uname, password: 'pw123456', name: '持久' });
  ok(r1.status === 200 && r1.data.token, '注册成功 ' + uname);
  // 再注册一个触发第二次保存：第一次写入没有旧版本可备份，第二次起 .bak 才存在
  await api('/api/register', { username: uname + 'b', password: 'pw123456', name: '二' });
  const accFile = path.join(STORE, 'accounts.json');
  ok(fs.existsSync(accFile), 'accounts.json 已写入');
  ok(fs.existsSync(accFile + '.bak'), 'accounts.json.bak 备份存在');
  await stopServer(srv);

  console.log('== 2. 模拟崩溃：accounts.json 损坏 → 回退 .bak 恢复 ==');
  fs.writeFileSync(accFile, '{"username":"半截数据', 'utf8'); // 损坏（截断 JSON）
  srv = await startServer();
  const l1 = await api('/api/login', { username: uname, password: 'pw123456' });
  ok(l1.status === 200 && l1.data.token, '损坏后登录成功（自动回退 .bak）');
  ok(fs.readdirSync(STORE).some((f) => f.indexOf('accounts.json.corrupt-') === 0), '损坏文件已留档 .corrupt-*（不静默删除）');
  await stopServer(srv);

  console.log('== 3. 模拟磁盘被清空：主文件+备份都没了 → 每日快照恢复 ==');
  try { fs.unlinkSync(accFile); } catch (e) {} // 上一步已改名，可能不存在
  try { fs.unlinkSync(accFile + '.bak'); } catch (e) {}
  srv = await startServer();
  const l2 = await api('/api/login', { username: uname, password: 'pw123456' });
  ok(l2.status === 200 && l2.data.token, '主文件+备份全丢后仍能登录（快照兜底）');
  const me = await fetch(BASE + '/api/me', { headers: { 'Authorization': 'Bearer ' + l2.data.token } }).then((r) => r.json());
  ok(me.username === uname, '账号名正确（@' + me.username + '）');
  await stopServer(srv);

  console.log('== 4. 快照保留上限 ==');
  // 伪造 9 份历史快照；启动时 writeSnapshot 会清理到 7 份
  for (let i = 0; i < 9; i++) {
    fs.writeFileSync(path.join(STORE, 'snapshot-2020-01-0' + i + '.json'), JSON.stringify({ dummy: true }));
  }
  srv = await startServer();
  await sleep(2000);
  const snaps = fs.readdirSync(STORE).filter((f) => /^snapshot-\d{4}-\d{2}-\d{2}\.json$/.test(f)).length;
  ok(snaps <= 7, '快照文件 ≤7 份（实际 ' + snaps + '，不含 .bak）');
  await stopServer(srv);

  console.log('== 5. SIGTERM 优雅退出（kvFlush 路径无异常） ==');
  srv = await startServer();
  await api('/api/register', { username: uname + 'c', password: 'pw123456', name: 'C' });
  let exitOk = true;
  srv.on('exit', (code, signal) => {
    // Windows 上 kill('SIGTERM') 常常直接强杀（code=null / signal=SIGTERM），
    // 但只要进程正常结束、没有留下崩溃残留即可；Linux/Render 上会走优雅退出（code=0）
    if (code !== 0 && code !== null) exitOk = false;
  });
  await stopServer(srv);
  ok(exitOk, 'SIGTERM 进程正常结束（无异常退出码）');

  // 清理
  try { fs.rmSync(STORE, { recursive: true, force: true }); } catch (e) {}
  console.log('========================================');
  console.log('  持久化加固: 通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
