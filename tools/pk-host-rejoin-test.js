/* 房主重连 / 同账号再加入 场景回归测试
 * 真实场景：房主断线重连、刷新页面、或开了第二个标签页再加入房间。
 * 期望：房主身份必须保留，房间不能变成「无人可开始」的死房间。
 */
'use strict';
const http = require('http');
const BASE = process.env.BASE_URL || 'http://localhost:3300';

function api(method, path, body, token) {
  return new Promise((resolve, reject) => {
    let p = path, b = body;
    if (token) {
      if (b && typeof b === 'object') b = Object.assign({ token: token }, b);
      else if (method === 'POST') b = { token: token };
      else p += (p.indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(token);
    }
    const data = b ? JSON.stringify(b) : null;
    const r = http.request(BASE + p, {
      method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
    }, (res) => {
      let s = '';
      res.on('data', (c) => { s += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(s) }); }
        catch (e) { resolve({ status: res.statusCode, json: {} }); }
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uname = () => 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? ' -> ' + extra : '')); }
}
async function register() {
  const u = uname();
  const r = await api('POST', '/api/register', { username: u, password: 'pw123456', name: u });
  if (r.status !== 200) throw new Error('注册失败: ' + JSON.stringify(r.json));
  return r.json.token;
}

async function main() {
  console.log('=== 场景A：房主同一账号再次加入（断线重连 / 刷新页面）===');
  {
    const t = await register();
    const cr = await api('POST', '/api/create', { bookId: 'cet4', mode: 'word', count: 10 }, t);
    check('建房成功', cr.status === 200, JSON.stringify(cr.json));
    const roomId = cr.json.roomId, hostId = cr.json.playerId;

    // 同一账号再次加入（模拟重连）
    const jr = await api('POST', '/api/join', { roomId: roomId }, t);
    check('房主重连加入成功', jr.status === 200, JSON.stringify(jr.json));

    // 房主身份必须保留
    const st = await api('GET', '/api/state?roomId=' + roomId + '&playerId=' + (jr.json.playerId || hostId), t);
    const players = st.json.players || [];
    const hostCount = players.filter((p) => p.isHost).length;
    check('重连后房间仍有且仅有 1 位房主', hostCount === 1, 'players=' + JSON.stringify(players.map((p) => ({ n: p.name, h: p.isHost }))));
    check('重连后房间不应出现重复玩家（同一账号只占 1 个位置）', players.length === 1, '实际 ' + players.length + ' 人');

    // 关键：房主仍能开始游戏（房间没变成死房间）
    const sr = await api('POST', '/api/start', { roomId: roomId, playerId: hostId }, t);
    check('原 playerId 仍可开始游戏（房间未被踢出/未失效）', sr.status === 200, sr.status + ' ' + (sr.json.error || ''));
  }

  console.log('\n=== 场景B：两个不同账号正常建房 + 加入 ===');
  {
    const t1 = await register();
    const t2 = await register();
    const cr = await api('POST', '/api/create', { bookId: 'cet4', mode: 'word', count: 10 }, t1);
    const roomId = cr.json.roomId, hostId = cr.json.playerId;
    const jr = await api('POST', '/api/join', { roomId: roomId }, t2);
    check('第二名玩家加入成功', jr.status === 200, JSON.stringify(jr.json));
    const guestId = jr.json.playerId;

    const st = await api('GET', '/api/state?roomId=' + roomId + '&playerId=' + hostId, t1);
    const hostP = (st.json.players || []).find((p) => p.id === hostId);
    check('房主仍是房主（未被客人顶替）', !!hostP && hostP.isHost === true, JSON.stringify(hostP));

    await api('POST', '/api/ready', { roomId: roomId, playerId: guestId }, t2);
    const sr = await api('POST', '/api/start', { roomId: roomId, playerId: hostId }, t1);
    check('客人准备后房主可开始', sr.status === 200, sr.status + ' ' + (sr.json.error || ''));
  }

  console.log('\n=== 场景C：房号大小写不敏感（用户手输小写房号）===');
  {
    const t1 = await register(), t2 = await register();
    const cr = await api('POST', '/api/create', { bookId: 'cet4', mode: 'word', count: 10 }, t1);
    const roomId = cr.json.roomId;
    const lower = String(roomId).toLowerCase();
    const jr = await api('POST', '/api/join', { roomId: lower }, t2);
    check('小写房号可以加入', jr.status === 200, jr.status + ' ' + (jr.json.error || ''));
    if (jr.status === 200) {
      // 加入后，用小写房号调用 start，应同样可用（不能 join 能进、start 报 404）
      const t3 = await register();
      const cr2 = await api('POST', '/api/create', { bookId: 'cet4', mode: 'word', count: 10 }, t1);
      const roomId2 = cr2.json.roomId;
      const jr2 = await api('POST', '/api/join', { roomId: roomId2 }, t3);
      await api('POST', '/api/ready', { roomId: roomId2, playerId: jr2.json.playerId }, t3);
      const srLower = await api('POST', '/api/start', { roomId: String(roomId2).toLowerCase(), playerId: cr2.json.playerId }, t1);
      check('小写房号调用 /api/start 也可开始（大小写一致处理）', srLower.status === 200, srLower.status + ' ' + (srLower.json.error || ''));
    }
  }

  console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('❌ 异常:', e.message); process.exit(1); });
