/* PK 结算「单词总览」面板回归测试
 *
 * 回归场景：玩家答完题后退出房间（/api/leave → removePlayer 把他从 room.players 删掉），
 * 其他人打开结算面板仍能看到他每题答对/答错 —— 因为面板按 room.history 里记录的
 * playerId 渲染，而不是按当前的 room.players。
 *
 * 关键不变量（本次修复的数据契约）：
 *   reveal() 必须把玩家名字一并写进 history[].results[pid].name，
 *   否则前端即使改成「按 results 的 key 渲染」也拿不到名字（只会显示兜底「玩家」）。
 *
 * 旧代码：results[pid] = {choice, correct, gained}（无 name），且前端用 v.players 渲染
 *   → 玩家一离场就从面板消失。本测试断言 name 已随结果记录，锁定修复。
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
  return { token: r.json.token, name: u };
}

async function main() {
  const host = await register();
  const guest = await register();
  // 服务端注册时把 name 截断到 12 字符（见 /api/register 的 slice(0,12)），
  // 所以结算面板里记录的 name 也是截断后的；期望值要对齐这一规则。
  const expectedGuestName = guest.name.slice(0, 12);

  const cr = await api('POST', '/api/create', { bookId: 'cet4', mode: 'word', count: 10 }, host.token);
  check('建房成功', cr.status === 200, JSON.stringify(cr.json));
  const roomId = cr.json.roomId, hostId = cr.json.playerId;

  const jr = await api('POST', '/api/join', { roomId: roomId }, guest.token);
  check('客人加入成功', jr.status === 200, JSON.stringify(jr.json));
  const guestId = jr.json.playerId;

  await api('POST', '/api/ready', { roomId: roomId, playerId: guestId }, guest.token);
  const sr = await api('POST', '/api/start', { roomId: roomId, playerId: hostId }, host.token);
  check('房主开始游戏', sr.status === 200, sr.status + ' ' + (sr.json.error || ''));

  // 把整局打完：每个 question 阶段，host 答 0、guest 答 1（均为合法下标），
  // 两人都答完才会 reveal 进入下一题。
  const deadline = Date.now() + 60000;
  let reachedResult = false;
  while (Date.now() < deadline) {
    const st = await api('GET', '/api/state?roomId=' + roomId + '&playerId=' + hostId, host.token);
    const v = st.json;
    if (v && v.phase === 'result') { reachedResult = true; break; }
    if (v && v.phase === 'question' && v.question) {
      const qi = v.question.index;
      const n = (v.question.options || []).length;
      if (n >= 1) {
        await api('POST', '/api/answer', { roomId: roomId, playerId: hostId, qIndex: qi, choice: 0 }, host.token).catch(() => {});
        await api('POST', '/api/answer', { roomId: roomId, playerId: guestId, qIndex: qi, choice: Math.min(1, n - 1) }, guest.token).catch(() => {});
      }
    }
    await sleep(250);
  }
  check('整局对战能打到结算阶段', reachedResult, '未在 60s 内进入 result');

  // 结算面板数据
  const st = await api('GET', '/api/state?roomId=' + roomId + '&playerId=' + hostId, host.token);
  const hist = (st.json && st.json.history) || [];
  check('结算面板 history 已生成', hist.length > 0, 'history=' + JSON.stringify(hist).slice(0, 80));

  // 关键不变量：每个 history 条目都包含两位玩家的对错，且【名字已随结果记录】
  let nameCaptured = true, leaverInEveryEntry = true, nameMatch = true;
  for (const h of hist) {
    const res = h.results || {};
    if (!res[guestId] || typeof res[guestId].correct !== 'boolean') leaverInEveryEntry = false;
    if (res[guestId] && typeof res[guestId].name !== 'string') nameCaptured = false;
    // 修复前 name 为 undefined；修复后应为客人注册名（非空）
    if (res[guestId] && !res[guestId].name) nameCaptured = false;
    if (res[guestId] && res[guestId].name !== expectedGuestName) nameMatch = false;
  }
  check('离场前：history 每个条目都记录了客人的逐题对错', leaverInEveryEntry);
  check('离场前：results[客人].name 已随结果记录（非空字符串）', nameCaptured);
  check('离场前：记录的 name 与客人注册名一致', nameMatch, 'guest.name=' + guest.name);

  // 客人退出房间
  const lv = await api('POST', '/api/leave', { roomId: roomId, playerId: guestId }, guest.token);
  check('客人退出房间成功', lv.status === 200, lv.status + ' ' + (lv.json.error || ''));

  const st2 = await api('GET', '/api/state?roomId=' + roomId + '&playerId=' + hostId, host.token);
  const players2 = (st2.json && st2.json.players) || [];
  check('客人离场后已不在 room.players（复现 bug 场景：从当前成员中消失）',
    !players2.some((p) => p.id === guestId));

  // 修复核心：即便客人已离场，房主看到的结算面板 history 仍保留他的逐题对错与名字
  const hist2 = (st2.json && st2.json.history) || [];
  let stillThere = true, stillNamed = true;
  for (const h of hist2) {
    const res = h.results || {};
    if (!res[guestId] || typeof res[guestId].correct !== 'boolean') stillThere = false;
    if (!res[guestId] || !res[guestId].name || res[guestId].name !== expectedGuestName) stillNamed = false;
  }
  check('客人离场后：房主面板 history 仍保留客人的逐题对错', stillThere);
  check('客人离场后：房主面板仍能看到客人的名字（而非「玩家」兜底）', stillNamed);

  console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('❌ 异常:', e.message); process.exit(1); });
