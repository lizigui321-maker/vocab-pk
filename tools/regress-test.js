/*
 * 回归测试：账号系统 + 带 token 的联网对战 + 独立生词本 + 词汇量
 * 运行：node tools/regress-test.js
 * 前置：server.js 已在 3000 端口运行（新账号版代码）
 */
'use strict';
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const fs = require('fs');
const path = require('path');
const STORE = path.join(__dirname, '..', 'store');
let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ FAIL: ' + msg); }
}
async function api(p, body, method) {
  const r = await fetch(BASE + p, {
    method: method || (body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let d = {};
  try { d = await r.json(); } catch (e) {}
  return { status: r.status, data: d };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const U = (p) => 'reg_' + p + Date.now().toString(36) + Math.random().toString(36).slice(2, 4);

async function main() {
  console.log('== 1. 首页 UI：登录门禁 + 无局域网残留文案 ==');
  const html = await (await fetch(BASE + '/')).text();
  ok(!html.includes('局域网词汇对战'), '<title> 不再是「局域网词汇对战」');
  ok(!html.includes('同一 WiFi · 浏览器直接对战'), '副标题不再要求同一 WiFi');
  ok(html.includes('复制网址'), '提示含复制网址按钮');
  ok(html.includes('登录') && html.includes('注册'), '已加入登录/注册门禁');

  console.log('== 2. 账号系统：注册 / 登录 / 鉴权 ==');
  const ua = U('A'), ub = U('B');
  const pw = 'pw123456';
  const r1 = await api('/api/register', { username: ua, password: pw, name: '甲甲' });
  ok(r1.status === 200 && r1.data.token, '用户A注册成功并拿到 token');
  const tokA = r1.data.token;
  const r1b = await api('/api/register', { username: ua, password: pw });
  ok(r1b.status === 409, '重复注册被拒（409）');
  const r2 = await api('/api/login', { username: ua, password: pw });
  ok(r2.status === 200 && r2.data.token, '用户A登录成功');
  const r2b = await api('/api/login', { username: ua, password: 'wrong' });
  ok(r2b.status === 401, '密码错误被拒（401）');
  const r3 = await api('/api/register', { username: ub, password: pw, name: '乙乙' });
  ok(r3.status === 200, '用户B注册成功');
  const tokB = r3.data.token;
  const me = await api('/api/me?token=' + tokA);
  ok(me.status === 200 && me.data.username === ua && me.data.name === '甲甲', '/api/me 返回正确账号信息');
  const meNo = await api('/api/me?token=invalid');
  ok(meNo.status === 401, '无效 token 访问 /api/me 被拒（401）');
  const bad = await api('/api/create', { bookId: 'cet4', mode: 'word', count: 10 });
  ok(bad.status === 401, '未登录建房被拒（401）');
  const badw = await api('/api/mywords?token=x');
  ok(badw.status === 401, '未登录查生词本被拒（401）');

  console.log('== 3. 修改昵称（账号级，非设备级） ==');
  const rn = await api('/api/me', { token: tokA, name: '甲甲改' });
  ok(rn.status === 200 && rn.data.name === '甲甲改', '昵称修改成功');
  const me2 = await api('/api/me?token=' + tokA);
  ok(me2.data.name === '甲甲改', '改名后 /api/me 同步更新');

  console.log('== 4. 带 token 对战：建房/加入，绿点应为在线 ==');
  const c = await api('/api/create', { token: tokA, bookId: 'cet4', mode: 'word', count: 10 });
  ok(c.status === 200 && c.data.roomId && c.data.playerId, 'A 带 token 建房成功 ' + (c.data && c.data.roomId));
  const roomId = c.data.roomId, pidA = c.data.playerId;
  const j = await api('/api/join', { token: tokB, roomId: roomId });
  ok(j.status === 200 && j.data.playerId, 'B 带 token 加入成功');
  const pidB = j.data.playerId;
  let s1 = (await api('/api/state?roomId=' + roomId + '&playerId=' + pidA)).data;
  let s2 = (await api('/api/state?roomId=' + roomId + '&playerId=' + pidB)).data;
  ok(s1.players.length === 2, '房间内 2 名玩家');
  ok(s1.players.every((p) => p.connected === true), '纯轮询玩家绿点全部在线（connected=true）');

  console.log('== 5. 对战作答：立即公布 + 正确计分 ==');
  const st = await api('/api/start', { roomId: roomId, playerId: pidA });
  ok(st.status === 200, '房主开始游戏');
  s1 = (await api('/api/state?roomId=' + roomId + '&playerId=' + pidA)).data;
  ok(s1.phase === 'question' && s1.question, '进入答题阶段');
  await api('/api/answer', { roomId: roomId, playerId: pidA, qIndex: s1.qIndex, choice: 0 });
  s1 = (await api('/api/state?roomId=' + roomId + '&playerId=' + pidA)).data;
  ok(s1.question.myChoice === 0 && s1.question.myCorrect !== undefined, '已答玩家立即可见自己的对错');
  const wait1 = s1.players.find((p) => p.id === pidA);
  ok(wait1.answered === true, '已答玩家 answered=true');
  const t0 = Date.now();
  await api('/api/answer', { roomId: roomId, playerId: pidB, qIndex: s1.qIndex, choice: 1 });
  s2 = (await api('/api/state?roomId=' + roomId + '&playerId=' + pidB)).data;
  ok(s2.phase === 'reveal' && s2.lastResult, '两人都答完立即公布 用时 ' + (Date.now() - t0) + 'ms');
  const ci = s2.lastResult.correctIndex;
  const rA = s2.lastResult.results[pidA];
  const rB = s2.lastResult.results[pidB];
  ok((rA && rA.choice === 0) && (rB && rB.choice === 1), '公布结果含双方作答');
  ok((ci === 0) === rA.correct && (ci === 1) === rB.correct, '对错判定正确（正确项=' + ci + '）');
  if (rA.correct) ok(rA.gained >= 100, '答对得分 ≥100（实际 ' + rA.gained + '）');

  console.log('== 6. 独立生词本：答错记入各自账号，互不干扰 ==');
  const wA = (await api('/api/mywords?token=' + tokA)).data;
  const wB = (await api('/api/mywords?token=' + tokB)).data;
  if (!rA.correct) ok(wA.words.some((x) => x.word === s2.lastResult.word), 'A答错 → A生词本收录「' + s2.lastResult.word + '」');
  else ok(!wA.words.some((x) => x.word === s2.lastResult.word), 'A答对 → A生词本无此词');
  if (!rB.correct) ok(wB.words.some((x) => x.word === s2.lastResult.word), 'B答错 → B生词本收录');
  else ok(!wB.words.some((x) => x.word === s2.lastResult.word), 'B答对 → B生词本无此词');
  ok(JSON.stringify(wA.words) !== JSON.stringify(wB.words) || (!rA.correct && !rB.correct), '两账号生词本相互独立');

  console.log('== 7. 超时未答：轮询玩家也应记生词（单人房） ==');
  const c2 = (await api('/api/create', { token: tokA, bookId: 'cet4', mode: 'word', count: 10 })).data;
  await api('/api/start', { roomId: c2.roomId, playerId: c2.playerId });
  let sc = (await api('/api/state?roomId=' + c2.roomId + '&playerId=' + c2.playerId)).data;
  const qWord = sc.question.word;
  console.log('  等待本题超时（约 13 秒）…');
  await sleep(13000);
  sc = (await api('/api/state?roomId=' + c2.roomId + '&playerId=' + c2.playerId)).data;
  ok(sc.phase === 'question' || sc.phase === 'reveal', '超时后进入公布/下一题（' + sc.phase + '）');
  const wC = (await api('/api/mywords?token=' + tokA)).data;
  ok(wC.words.some((x) => x.word === qWord), '轮询玩家超时未答 → 生词本收录「' + qWord + '」');

  console.log('== 8. 生词本删除 / 清空 ==');
  const before = (await api('/api/mywords?token=' + tokA)).data.words.length;
  if (before > 0) {
    await api('/api/mywords?token=' + tokA + '&word=' + encodeURIComponent(wC.words[0].word), null, 'DELETE');
    const afterDel = (await api('/api/mywords?token=' + tokA)).data.words.length;
    ok(afterDel === before - 1, '单删一个生词生效');
    await api('/api/mywords?token=' + tokA, null, 'DELETE');
    const afterClr = (await api('/api/mywords?token=' + tokA)).data.words.length;
    ok(afterClr === 0, '清空生词本生效');
  } else ok(true, '（无生词可删，跳过）');

  console.log('== 9. 词汇量自测（带 token） ==');
  const vt = (await api('/api/vocabtest/questions')).data;
  ok(vt.questions.length === 42 && vt.tiers.length === 7, '出题 42 道 / 7 层');
  const answers = vt.questions.map((q) => ({ word: q.word, tier: q.tier, credit: q.tier < 3 ? 1 : 0 }));
  const sub = (await api('/api/vocabtest/submit', { token: tokA, answers })).data;
  ok(sub.ok && sub.estimate > 0, '提交成功，估算词汇量 ' + sub.estimate);
  const rk = (await api('/api/vocabrank?token=' + tokA)).data;
  ok(rk.you && rk.you.rank > 0, '排行榜能查到自己（#' + (rk.you && rk.you.rank) + '）');

  console.log('== 10. SSE 通道仍正常（局域网玩家走 SSE） ==');
  const sseOk = await new Promise((resolve) => {
    const req = require('http').get(BASE + '/api/stream?roomId=' + roomId + '&playerId=' + pidA, (res) => {
      if (res.statusCode !== 200) { resolve(false); return; }
      let buf = '';
      const timer = setTimeout(() => { req.destroy(); resolve(false); }, 5000);
      res.on('data', (d) => {
        buf += d.toString();
        if (buf.includes('data: ')) { clearTimeout(timer); req.destroy(); resolve(true); }
      });
    });
    req.on('error', () => resolve(false));
  });
  ok(sseOk, 'SSE 流式推送首帧正常');

  console.log('== 11. PWA 资源可访问 ==');
  const man = await fetch(BASE + '/manifest.webmanifest');
  ok(man.status === 200 && (man.headers.get('content-type') || '').includes('manifest'), 'manifest.webmanifest 可访问且类型正确');
  const ic = await fetch(BASE + '/icon-192.png');
  ok(ic.status === 200 && (ic.headers.get('content-type') || '').includes('image/png'), 'icon-192.png 可访问');
  const sw = await fetch(BASE + '/sw.js');
  ok(sw.status === 200, 'sw.js 可访问');

  console.log('== 12. 清理测试账号与排行数据 ==');
  try {
    const af = path.join(STORE, 'accounts.json');
    const acc = JSON.parse(fs.readFileSync(af, 'utf8'));
    let removed = 0;
    for (const k of Object.keys(acc)) if (k.startsWith('reg_')) { delete acc[k]; removed++; }
    fs.writeFileSync(af, JSON.stringify(acc));
    const rf = path.join(STORE, 'vocab-rank.json');
    const rank = JSON.parse(fs.readFileSync(rf, 'utf8'));
    const kept = rank.filter((x) => !String(x.name).startsWith('reg_'));
    fs.writeFileSync(rf, JSON.stringify(kept));
    ok(removed > 0, '已清理 ' + removed + ' 个测试账号');
  } catch (e) { ok(false, '清理失败: ' + e.message); }

  console.log('========================================');
  console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('测试脚本异常:', e); process.exit(1); });
