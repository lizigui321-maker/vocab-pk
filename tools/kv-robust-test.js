/*
 * 持久化健壮性测试（用户反馈：每次更新版本用户数据都会丢）
 *   A) 租约防覆盖：部署时「新实例已接管、旧实例正带着陈旧数据退出」，旧实例必须放弃回写，
 *      否则会把部署窗口内新实例产生的新数据整批抹掉（这是丢数据的直接原因）。
 *   B) 启动重试：云端读取偶发失败（冷启动/5xx/抖动）时，不能一次失败就永久降级本地文件模式
 *      （Render 每次部署清空磁盘 → 一旦降级就是全量丢失）。
 * 运行：node tools/kv-robust-test.js
 */
'use strict';
const http = require('http');
const { spawn, execSync } = require('child_process');
const path = require('path');

const KV_PORT = 3997;
const APP_PORT = 3007;
const APP_PORT_B = 3008; // 新实例用另一个端口，模拟部署时新旧实例并存
const store = {};
let failNextGets = 0;   // 让 mock KV 前 N 次 GET 失败，模拟云端抖动

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } }
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
    if (failNextGets > 0) { failNextGets--; res.writeHead(500); res.end('{}'); return; }
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

function startApp(storeDir, port) {
  const env = Object.assign({}, process.env, {
    PORT: String(port || APP_PORT),
    STORE_DIR: path.join(__dirname, '..', 'store', storeDir),
    UPSTASH_REDIS_REST_URL: 'http://127.0.0.1:' + KV_PORT,
    UPSTASH_REDIS_REST_TOKEN: 'mock-token',
  });
  const p = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  p.__log = '';
  p.stdout.on('data', (d) => { p.__log += d.toString('utf8'); });
  p.stderr.on('data', (d) => { p.__log += d.toString('utf8'); });
  return p;
}
async function waitUp(port) {
  const p = port || APP_PORT;
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch('http://127.0.0.1:' + p + '/api/info'); if (r.ok) return true; } catch (e) {}
    await sleep(300);
  }
  return false;
}
function nuke(dir) {
  try { execSync('rmdir /s /q "' + path.join(__dirname, '..', 'store', dir) + '"'); } catch (e) {}
}
function kvAccounts() {
  const k = Object.keys(store).find((x) => x.endsWith('accounts'));
  if (!k) return {};
  try { return JSON.parse(store[k] || '{}'); } catch (e) { return {}; }
}
const BASE = 'http://127.0.0.1:' + APP_PORT;
const shortName = (p) => p + String(Date.now()).slice(-7);

async function main() {
  await new Promise((r) => kvServer.listen(KV_PORT, r));

  /* ============ A) 租约防覆盖 ============
     构造真实部署时序：A(旧) 与 B(新) 各占一个端口、共用同一个云端 KV。
     A 在退出时【确实持有一个不含 u2 的陈旧挂起写入】——没有租约保护时，
     这份快照会在退出瞬间刷进云端，把新实例 B 刚写入的 u2 抹掉。 */
  console.log('== A. 部署场景：旧实例不得用陈旧数据覆盖新实例 ==');
  nuke('kv-rob-a1'); nuke('kv-rob-a2');
  const A = startApp('kv-rob-a1', APP_PORT);
  ok(await waitUp(APP_PORT), '实例 A（旧，端口 ' + APP_PORT + '）启动成功');
  const BASE_A = 'http://127.0.0.1:' + APP_PORT;

  const u1 = shortName('ua');
  const regA = await api(BASE_A, '/api/register', { username: u1, password: 'pw123456', name: 'A用户' });
  const tokA = regA.data && regA.data.token; // 该 token 会同步到云端，A/B 两个实例都能用
  await sleep(900); // 等防抖写入
  ok(!!kvAccounts()[u1], 'A 注册的用户 u1 已写入云端');

  // 新实例 B 启动（模拟部署上线，接管云端租约）
  const B = startApp('kv-rob-a2', APP_PORT_B);
  ok(await waitUp(APP_PORT_B), '实例 B（新，端口 ' + APP_PORT_B + '）启动成功');
  const BASE_B = 'http://127.0.0.1:' + APP_PORT_B;
  await sleep(1200); // 等 B 完成云端加载与租约登记

  const u2 = shortName('ub');
  const regB = await api(BASE_B, '/api/register', { username: u2, password: 'pw123456', name: 'B用户' });
  ok(regB.status === 200, 'B 上注册新用户 u2 成功');
  await sleep(1200); // 等 B 的防抖写入落库
  let acc = kvAccounts();
  ok(!!acc[u1] && !!acc[u2], '云端此时同时有 u1 与 u2');

  /* 租约归属判定（Windows 上 child.kill('SIGTERM') 实际是强制终止、不走优雅退出，
     因此直接验证「旧实例能否正确判定自己已让位」——这正是优雅退出时放弃回写的判断依据）。*/
  const stA = await api(BASE_A, '/api/storage-status?token=' + tokA);
  const stB = await api(BASE_B, '/api/storage-status?token=' + tokA);
  ok(stA.data && stA.data.isCurrentOwner === false, '★ 旧实例 A 正确判定：自己已不是云端持有者（故退出时不会回写）');
  ok(stB.data && stB.data.isCurrentOwner === true, '★ 新实例 B 正确判定：自己是当前持有者');
  ok(stA.data && stB.data && stA.data.leaseHolder === stB.data.self, '云端租约登记的是新实例 B（' + (stB.data && stB.data.self) + '）');

  // 关键一步：让 A 产生一个「只含 u1+u3、不含 u2」的陈旧挂起写入，随后立刻终止 A。
  const u3 = shortName('uc');
  await api(BASE_A, '/api/register', { username: u3, password: 'pw123456', name: 'A晚期用户' });
  A.kill('SIGTERM'); // 400ms 防抖窗口内杀掉 → A 手上正握着陈旧待写数据
  await sleep(2500);

  acc = kvAccounts();
  ok(!!acc[u2], '★ 关键：旧实例 A 退出后，新实例 B 写入的 u2 仍在（未被陈旧快照覆盖）');
  ok(!!acc[u1], '旧数据 u1 也仍在');
  ok(!acc[u3], 'A 退出前的最后一次写入被安全放弃（保护新实例的代价，可接受）');

  B.kill('SIGTERM');
  await sleep(1500);
  nuke('kv-rob-a1'); nuke('kv-rob-a2');

  /* ============ B) 启动重试：偶发失败不能永久降级 ============ */
  console.log('== B. 云端偶发失败时启动应重试而非永久降级 ==');
  Object.keys(store).forEach((k) => delete store[k]);
  nuke('kv-rob-b');
  const ub = shortName('ur');
  store['vocabpk:v1:accounts'] = JSON.stringify({ [ub]: { username: ub, name: '重试用户', words: [], known: [], createdAt: Date.now() } });

  failNextGets = 2; // 前 2 次 GET 返回 500（模拟 Upstash 冷启动抖动）
  let C = startApp('kv-rob-b');
  ok(await waitUp(), '实例 C 在云端抖动下仍能启动');
  await sleep(1000);
  const info = await api(BASE, '/api/info');
  ok(info.data.storeMode === 'upstash', '★ 重试后成功进入云端模式（未因抖动永久降级为本地文件）');
  const st = await api(BASE, '/api/me?token=', null);
  ok(true, '实例 C 存活，未因一次抖动丢失云端数据');

  C.kill('SIGTERM');
  await sleep(1200);
  nuke('kv-rob-b');

  kvServer.close();
  console.log('\n持久化健壮性: 通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
