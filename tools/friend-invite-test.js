/* 复现「邀请好友进房间后无法开始」+「主界面看不到好友列表」
   完整模拟前端真实调用顺序：加好友 → 好友列表 → 建房 → 邀请 → 收到横幅 → 加入 → 准备 → 开始
   自起服务（端口 3207），无需外部启动。 */
'use strict';
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const PORT = process.env.TEST_PORT || '3207';
const BASE = 'http://localhost:' + PORT;

let pass = 0, fail = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log('  ✅ ' + msg); }
  else { fail++; console.log('  ❌ ' + msg + (extra ? '  →  ' + extra : '')); }
}

function req(method, p, body, token) {
  return new Promise((resolve, reject) => {
    let path2 = p, b = body;
    if (token) {
      if (b && typeof b === 'object') b = Object.assign({ token: token }, b);
      else if (method === 'POST') b = { token: token };
      else path2 += (path2.indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(token);
    }
    const data = b ? JSON.stringify(b) : null;
    const r = http.request(BASE + path2, {
      method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
    }, (res) => {
      let s = '';
      res.on('data', (c) => { s += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(s) }); }
        catch (e) { resolve({ status: res.statusCode, json: {}, raw: s }); }
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 打开 SSE 连接并收集推送（前端 connect() 用的是同一条接口）
function openStream(roomId, playerId, onState) {
  return new Promise((resolve, reject) => {
    const r = http.get(BASE + '/api/stream?roomId=' + roomId + '&playerId=' + playerId, (res) => {
      let b = '';
      res.on('data', (c) => {
        b += c;
        let idx;
        while ((idx = b.indexOf('\n\n')) >= 0) {
          const chunk = b.slice(0, idx); b = b.slice(idx + 2);
          const m = chunk.match(/^data: (.*)$/m);
          if (m) { try { onState(JSON.parse(m[1])); } catch (e) {} }
        }
      });
      resolve(res);
    });
    r.on('error', reject);
  });
}

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await req('GET', '/api/diag');
      if (r.status === 200) return true;
    } catch (e) {}
    await sleep(250);
  }
  return false;
}

async function register(name) {
  const u = 'fi' + Date.now().toString(36).slice(-6) + Math.random().toString(36).slice(2, 4);
  const pw = 'pw123456';
  let r = await req('POST', '/api/register', { username: u, password: pw, name: name });
  if (r.status !== 200) r = await req('POST', '/api/login', { username: u, password: pw });
  if (r.status !== 200) throw new Error('注册失败: ' + JSON.stringify(r.json));
  return { username: u, token: r.json.token };
}

async function main() {
  console.log('[1] 注册两个独立账号（房主 A / 好友 B）');
  const A = await register('Alice');
  const B = await register('Bob');
  console.log('    A=' + A.username + '  B=' + B.username);

  console.log('[2] A 添加 B 为好友');
  const addR = await req('POST', '/api/friend', { username: B.username }, A.token);
  ok(addR.status === 200, 'POST /api/friend 成功', JSON.stringify(addR.json));

  console.log('[3] A 拉好友列表（好友页/主界面的数据来源）');
  const fr = await req('GET', '/api/friends', null, A.token);
  const list = fr.json.friends || [];
  ok(fr.status === 200, 'GET /api/friends 返回 200');
  ok(list.length === 1, '好友列表有 1 人', '实际 ' + list.length);
  ok(list.length === 1 && list[0].username === B.username, '好友列表中确实是 B',
     JSON.stringify(list.map((x) => x.username)));
  if (list.length === 1) {
    ok(typeof list[0].name === 'string' && list[0].name.length > 0, '好友带展示名 name', JSON.stringify(list[0].name));
  }

  console.log('[4] A 创建房间（模拟好友页点「⚡ 邀请PK」时自动建房）');
  const cr = await req('POST', '/api/create', { bookId: '', mode: 'word', count: 20 }, A.token);
  ok(cr.status === 200 && !!cr.json.roomId, '建房成功', JSON.stringify(cr.json));
  const roomId = cr.json.roomId, aPlayerId = cr.json.playerId;

  console.log('[5] A 邀请 B 进房间');
  const inv = await req('POST', '/api/pk/invite',
    { roomId: roomId, playerId: aPlayerId, toUsername: B.username }, A.token);
  ok(inv.status === 200, 'POST /api/pk/invite 成功', JSON.stringify(inv.json));

  console.log('[6] B 轮询邀请横幅 GET /api/invites');
  const iv = await req('GET', '/api/invites', null, B.token);
  const ivs = iv.json.invites || [];
  ok(ivs.length === 1, 'B 收到 1 条邀请', '实际 ' + ivs.length + ' 条 ' + JSON.stringify(iv.json));
  if (ivs.length === 1) {
    ok(ivs[0].roomId === roomId, '邀请里的房间号正确', ivs[0].roomId + ' vs ' + roomId);
    ok(!!ivs[0].bookName, '邀请带词书名（横幅要显示）', JSON.stringify(ivs[0].bookName));
  }

  console.log('[7] B 点「加入房间」');
  const jr = await req('POST', '/api/join', { roomId: roomId }, B.token);
  ok(jr.status === 200 && !!jr.json.playerId, 'B 加入成功', JSON.stringify(jr.json));
  const bPlayerId = jr.json.playerId;

  console.log('[8] 检查房间内身份分配');
  const stA = await req('GET', '/api/state?roomId=' + roomId + '&playerId=' + aPlayerId, null, A.token);
  const stB = await req('GET', '/api/state?roomId=' + roomId + '&playerId=' + bPlayerId, null, B.token);
  ok(stA.status === 200 && stB.status === 200, '双端都能拉到房间状态');
  const playersA = (stA.json && stA.json.players) || [];
  ok(playersA.length === 2, '房间内 2 人', '实际 ' + playersA.length);
  const aSelf = playersA.find((p) => p.id === aPlayerId);
  const bSelf = playersA.find((p) => p.id === bPlayerId);
  ok(aSelf && aSelf.isHost === true, 'A 是房主');
  ok(bSelf && bSelf.isHost === false, 'B 是非房主（需要点准备）');
  console.log('    房间内: ' + JSON.stringify(playersA.map((p) => ({ n: p.name, host: p.isHost, ready: p.ready }))));

  console.log('[9] A 在 B 未准备时点开始 → 应被拒绝');
  const s1 = await req('POST', '/api/start', { roomId: roomId, playerId: aPlayerId }, A.token);
  ok(s1.status === 400, '未准备时开始被拒（400）', '实际 ' + s1.status + ' ' + JSON.stringify(s1.json));
  ok(s1.status === 400 && /未准备/.test(s1.json.error || ''), '错误文案提示未准备', JSON.stringify(s1.json));

  console.log('[10] B 点「我准备好了」');
  const rd = await req('POST', '/api/ready', { roomId: roomId, playerId: bPlayerId }, B.token);
  ok(rd.status === 200, 'B 准备成功', JSON.stringify(rd.json));
  ok(rd.json.ready === true, '返回的 ready 为 true', JSON.stringify(rd.json));

  console.log('[11] 检查房主端 allReady（决定「开始」按钮能否点）');
  const stA2 = await req('GET', '/api/state?roomId=' + roomId + '&playerId=' + aPlayerId, null, A.token);
  ok(stA2.json.allReady === true, 'A 端看到 allReady=true（开始按钮应可点）',
     'allReady=' + stA2.json.allReady + ' players=' + JSON.stringify((stA2.json.players || []).map((p) => ({ n: p.name, host: p.isHost, ready: p.ready }))));
  const stB2 = await req('GET', '/api/state?roomId=' + roomId + '&playerId=' + bPlayerId, null, B.token);
  ok(stB2.json.allReady === true, 'B 端也看到 allReady=true');

  console.log('[12] A 点「开始对战」→ 应成功进入倒计时');
  const s2 = await req('POST', '/api/start', { roomId: roomId, playerId: aPlayerId }, A.token);
  ok(s2.status === 200, '开始成功（200）', '实际 ' + s2.status + ' ' + JSON.stringify(s2.json));
  await sleep(300);
  const stA3 = await req('GET', '/api/state?roomId=' + roomId + '&playerId=' + aPlayerId, null, A.token);
  ok(stA3.json.phase === 'countdown' || stA3.json.phase === 'question',
     '房间已进入倒计时/答题阶段', 'phase=' + stA3.json.phase);

  console.log('[13] SSE 实时推送验证（决定房主端「开始」按钮能否自动点亮）');
  const cr2 = await req('POST', '/api/create', { bookId: '', mode: 'word', count: 10 }, A.token);
  const room2 = cr2.json.roomId, ap2 = cr2.json.playerId;
  const jr2 = await req('POST', '/api/join', { roomId: room2 }, B.token);
  const bp2 = jr2.json.playerId;
  let pushed = null;
  const sseA = await openStream(room2, ap2, (v) => { pushed = v; });
  await sleep(500);
  ok(!!pushed, 'A 端 SSE 建立后收到首帧', pushed ? '' : '未收到任何推送');
  pushed = null; // 清空，只关心「准备」引起的这一次推送
  await req('POST', '/api/ready', { roomId: room2, playerId: bp2 }, B.token);
  await sleep(1000);
  ok(pushed && pushed.allReady === true,
     'B 点准备后，A 端 SSE 立刻收到 allReady=true（房主无需刷新页面）',
     pushed ? 'allReady=' + pushed.allReady : 'A 端未收到任何推送');
  try { sseA.destroy(); } catch (e) {}

  /* ================= 僵尸玩家回归（用户报的「好友进去了却无法开始」）=================
     旧行为：玩家关页面 / 点返回首页只清本地，服务端完全不知情，玩家对象永久留在房间里。
     只要这个僵尸是「非房主且未准备」，allReady 就永远 false —— 房主的开始按钮永远点不动。 */
  console.log('[14] 掉线玩家不再阻塞开局（僵尸回归用例）');
  const C = await register('Cindy');
  const cr3 = await req('POST', '/api/create', { bookId: '', mode: 'word', count: 10 }, A.token);
  const room3 = cr3.json.roomId, ap3 = cr3.json.playerId;
  // B 加入并连上 SSE（模拟 B 已经进到房间里）
  const jrB3 = await req('POST', '/api/join', { roomId: room3 }, B.token);
  const bp3 = jrB3.json.playerId;
  const sseB3 = await openStream(room3, bp3, () => {});
  await sleep(400);
  // B 直接关掉页面（SSE 断开、不再轮询），且【没有】点准备
  sseB3.destroy();
  await sleep(500);
  // C 正常加入并准备
  const jrC3 = await req('POST', '/api/join', { roomId: room3 }, C.token);
  const cp3 = jrC3.json.playerId;
  const sseC3 = await openStream(room3, cp3, () => {});
  await req('POST', '/api/ready', { roomId: room3, playerId: cp3 }, C.token);
  await sleep(300);
  const st3 = await req('GET', '/api/state?roomId=' + room3 + '&playerId=' + ap3, null, A.token);
  const p3 = st3.json.players || [];
  const zombie = p3.find((p) => p.id === bp3);
  ok(p3.length === 3, '房间仍有 3 人（掉线的 B 还在）', '实际 ' + p3.length);
  ok(!!zombie, '能识别出掉线的 B');
  ok(zombie && zombie.ready === false, '掉线的 B 确实【未准备】（旧逻辑下它会永久卡住开局）',
     JSON.stringify(zombie));
  ok(st3.json.allReady === true,
     '★ 掉线玩家未准备时 allReady 仍为 true（旧逻辑这里会是 false → 房主永远开不了局）',
     'allReady=' + st3.json.allReady + ' offlineCount=' + st3.json.offlineCount);
  const start3 = await req('POST', '/api/start', { roomId: room3, playerId: ap3 }, A.token);
  ok(start3.status === 200, '★ 房主能直接开始（不再被掉线的僵尸拦住）',
     '实际 ' + start3.status + ' ' + JSON.stringify(start3.json));
  try { sseC3.destroy(); } catch (e) {}

  console.log('[15] 房主一键「移出掉线玩家」');
  const cr4 = await req('POST', '/api/create', { bookId: '', mode: 'word', count: 10 }, A.token);
  const room4 = cr4.json.roomId, ap4 = cr4.json.playerId;
  const jrB4 = await req('POST', '/api/join', { roomId: room4 }, B.token);
  const bp4 = jrB4.json.playerId;
  const sseB4 = await openStream(room4, bp4, () => {});
  await sleep(300);
  sseB4.destroy();                 // B 关页面
  await sleep(500);                // 等服务端 req close 生效，B 立刻被判掉线
  const st4a = await req('GET', '/api/state?roomId=' + room4 + '&playerId=' + ap4, null, A.token);
  ok((st4a.json.offlineCount || 0) >= 1 || (st4a.json.players || []).length === 1,
     '房主端能看到掉线人数（或已被自动清理）',
     'offlineCount=' + st4a.json.offlineCount + ' players=' + (st4a.json.players || []).length);
  const kick = await req('POST', '/api/room/kick-offline', { roomId: room4, playerId: ap4 }, A.token);
  ok(kick.status === 200, 'POST /api/room/kick-offline 成功', JSON.stringify(kick.json));
  const kickNoHost = await req('POST', '/api/room/kick-offline', { roomId: room4, playerId: bp4 }, B.token);
  ok(kickNoHost.status === 403 || kickNoHost.status === 404, '非房主不能踢人（403/404）',
     '实际 ' + kickNoHost.status);

  console.log('[16] 主动离开 POST /api/leave：玩家立刻从房间消失');
  const cr5 = await req('POST', '/api/create', { bookId: '', mode: 'word', count: 10 }, A.token);
  const room5 = cr5.json.roomId, ap5 = cr5.json.playerId;
  const jrB5 = await req('POST', '/api/join', { roomId: room5 }, B.token);
  const bp5 = jrB5.json.playerId;
  await sleep(200);
  const lv = await req('POST', '/api/leave', { roomId: room5, playerId: bp5 }, B.token);
  ok(lv.status === 200, 'POST /api/leave 返回 200', JSON.stringify(lv.json));
  const st5 = await req('GET', '/api/state?roomId=' + room5 + '&playerId=' + ap5, null, A.token);
  const p5 = st5.json.players || [];
  ok(p5.length === 1 && p5[0].id === ap5, 'B 离开后房间里只剩房主 A', JSON.stringify(p5.map((p) => p.name)));
  ok(st5.json.allReady === true, '只剩房主时 allReady=true（可单人练习）');
  // 幂等：重复离开不应报错
  const lv2 = await req('POST', '/api/leave', { roomId: room5, playerId: bp5 }, B.token);
  ok(lv2.status === 200, '重复调用 /api/leave 仍返回 200（幂等）', '实际 ' + lv2.status);
  // B 离开后，A 立刻能开始
  const start5 = await req('POST', '/api/start', { roomId: room5, playerId: ap5 }, A.token);
  ok(start5.status === 200, '★ B 离开后 A 能立刻开始', '实际 ' + start5.status + ' ' + JSON.stringify(start5.json));

  console.log('[17] 房主离开 → 房主自动转移给剩下的人');
  const cr6 = await req('POST', '/api/create', { bookId: '', mode: 'word', count: 10 }, A.token);
  const room6 = cr6.json.roomId, ap6 = cr6.json.playerId;
  const jrB6 = await req('POST', '/api/join', { roomId: room6 }, B.token);
  const bp6 = jrB6.json.playerId;
  const sseB6 = await openStream(room6, bp6, () => {});
  await sleep(400);
  await req('POST', '/api/leave', { roomId: room6, playerId: ap6 }, A.token); // 房主 A 走了
  await sleep(300);
  const st6 = await req('GET', '/api/state?roomId=' + room6 + '&playerId=' + bp6, null, B.token);
  const b6 = (st6.json.players || []).find((p) => p.id === bp6);
  ok((st6.json.players || []).length === 1, 'A 离开后房间只剩 B', JSON.stringify((st6.json.players || []).map((p) => p.name)));
  ok(b6 && b6.isHost === true, '★ B 自动接任房主（房间不会变成死房间）', JSON.stringify(b6));
  const start6 = await req('POST', '/api/start', { roomId: room6, playerId: bp6 }, B.token);
  ok(start6.status === 200, '★ 接管房主的 B 能开始游戏', '实际 ' + start6.status);
  try { sseB6.destroy(); } catch (e) {}

  console.log('[18] 关页面不留僵尸：掉线超过 STALE_PLAYER_TTL 自动清出房间');
  const cr7 = await req('POST', '/api/create', { bookId: '', mode: 'word', count: 10 }, A.token);
  const room7 = cr7.json.roomId, ap7 = cr7.json.playerId;
  const jrB7 = await req('POST', '/api/join', { roomId: room7 }, B.token);
  const bp7 = jrB7.json.playerId;
  const sseA7 = await openStream(room7, ap7, () => {});
  const sseB7 = await openStream(room7, bp7, () => {});
  await sleep(300);
  sseB7.destroy();   // B 直接关页面，且不调 /api/leave（最恶劣的情况）
  // STALE_PLAYER_TTL(测试环境 25s) 减去回拨的 ONLINE_WINDOW(12s) ≈ 13 秒后应被清掉
  let gone = false;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const s = await req('GET', '/api/state?roomId=' + room7 + '&playerId=' + ap7, null, A.token);
    if (!s.json.players || !s.json.players.some((p) => p.id === bp7)) { gone = true; break; }
  }
  ok(gone, '★ B 关页面后被自动清出房间（不会留下永久僵尸）');
  const st7 = await req('GET', '/api/state?roomId=' + room7 + '&playerId=' + ap7, null, A.token);
  ok(st7.json.allReady === true, '僵尸清掉后 allReady=true', 'allReady=' + st7.json.allReady);
  try { sseA7.destroy(); } catch (e) {}

  console.log('\n==== 好友邀请流程: ' + pass + ' 项通过, ' + fail + ' 项失败 ====');
  if (fail) process.exitCode = 1;
}

(async () => {
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    /* 测试环境把「僵尸清理」的节奏调快，否则光等自动清理就要 45 秒。
       注意 STALE_PLAYER_TTL 必须【大于】ONLINE_WINDOW(12s)：SSE 断开时服务端会把
       lastSeen 回拨 12 秒（为了立刻判离线），TTL 若小于 12s，僵尸会被瞬间清掉，
       就测不到「人还在房间里但不阻塞开局」这个关键场景了。
       生产环境不设这两个变量，仍是 45 秒 / 15 秒。 */
    env: Object.assign({}, process.env, {
      PORT: PORT,
      STALE_PLAYER_TTL: process.env.STALE_PLAYER_TTL || '25000',
      ROOM_SWEEP_MS: process.env.ROOM_SWEEP_MS || '800',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let srvLog = '';
  srv.stdout.on('data', (d) => { srvLog += d; });
  srv.stderr.on('data', (d) => { srvLog += d; });
  try {
    if (!await waitReady()) { console.error('服务启动失败:\n' + srvLog); process.exitCode = 1; return; }
    await main();
  } catch (e) {
    console.error('测试异常:', e.message);
    console.error(srvLog.slice(-2000));
    process.exitCode = 1;
  } finally {
    srv.kill();
  }
})();
