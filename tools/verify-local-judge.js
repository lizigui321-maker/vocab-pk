/* 一次性验证：浏览器本地判题 == 服务器判定（连续 3 题） */
'use strict';
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const zlib = require('zlib');
const fs = require('fs');
const KEY = 'VOCABPK_S3CRET_KEY';

// --- 模拟前端 decodeBooks：解码 books.bundle.js ---
const src = fs.readFileSync('public/books.bundle.js', 'utf8');
const m = src.match(/window\.__VOCAB_BOOKS__ = "([^"]+)"/);
const xbuf = Buffer.from(m[1], 'base64');
const x = Buffer.alloc(xbuf.length);
for (let i = 0; i < xbuf.length; i++) x[i] = xbuf[i] ^ KEY.charCodeAt(i % KEY.length);
const books = JSON.parse(zlib.inflateSync(x).toString('utf8'));
console.log('词书解码 OK：' + books.length + ' 本, 第1本 ' + books[0].name + ' ' + books[0].words.length + ' 词');

// --- 模拟前端 localCorrectIdx ---
function localIdx(word, bookId, options) {
  const book = books.find((b) => b.id === bookId);
  const list = (book && book.words) || [];
  let meaning = null;
  for (const w of list) if (w[0] === word) { meaning = w[1]; break; }
  if (meaning === null) {
    for (const b of books) {
      for (const w of b.words) if (w[0] === word) { meaning = w[1]; break; }
      if (meaning) break;
    }
  }
  return meaning === null ? -1 : options.indexOf(meaning);
}

async function api(p, body) {
  const r = await fetch(BASE + p, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let d = {}; try { d = await r.json(); } catch (e) {}
  return { status: r.status, data: d };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const U = (p) => 'vfy_' + p + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

(async () => {
  const ua = U('A'), ub = U('B');
  const ra = await api('/api/register', { username: ua, password: 'pw123456', name: '验证甲' });
  const rb = await api('/api/register', { username: ub, password: 'pw123456', name: '验证乙' });
  const tokA = ra.data.token, tokB = rb.data.token;
  const c = await api('/api/create', { token: tokA, bookId: 'zhongkao', mode: 'word', count: 5 });
  const roomId = c.data.roomId, pidA = c.data.playerId;
  const j = await api('/api/join', { token: tokB, roomId });
  const pidB = j.data.playerId;
  await api('/api/ready', { roomId, playerId: pidB }); // 只有客人需要准备（房主无需）
  await api('/api/start', { roomId, playerId: pidA });
  await sleep(3400); // 3 秒倒计时
  console.log('房间 ' + roomId + ' 开局，两玩家就位，连续验证 3 题…');

  let allOk = true;
  for (let round = 0; round < 3; round++) {
    let st = (await api('/api/state?roomId=' + roomId + '&playerId=' + pidA)).data;
    let guard = 0;
    while (st.phase !== 'question' && guard++ < 40) { await sleep(300); st = (await api('/api/state?roomId=' + roomId + '&playerId=' + pidA)).data; }
    if (st.phase !== 'question') { console.log('✗ 第 ' + (round + 1) + ' 题未进入答题阶段'); allOk = false; break; }
    const q = st.question;
    const li = localIdx(q.word, st.settings.bookId, q.options);
    console.log('  Q' + (st.qIndex + 1) + ' word="' + q.word + '" 本地判题答案=' + li + ' (选项 ' + q.options.length + ' 个)');
    await api('/api/answer', { roomId, playerId: pidA, qIndex: st.qIndex, choice: li });
    await api('/api/answer', { roomId, playerId: pidB, qIndex: st.qIndex, choice: (li + 2) % q.options.length });
    await sleep(400);
    st = (await api('/api/state?roomId=' + roomId + '&playerId=' + pidA)).data;
    guard = 0;
    while ((!st.lastResult || st.lastResult.qIndex !== st.qIndex) && guard++ < 40) { await sleep(300); st = (await api('/api/state?roomId=' + roomId + '&playerId=' + pidA)).data; }
    const lr = st.lastResult;
    const serverCi = lr.correctIndex;
    const aCorrect = lr.results[pidA] ? lr.results[pidA].correct : null;
    const match = serverCi === li && aCorrect === true;
    console.log('     服务器判定 correctIndex=' + serverCi + ' 我答对=' + aCorrect + ' → ' + (match ? '✓ 完全一致' : '✗ 不一致!'));
    if (!match) allOk = false;
    await sleep(3200); // 等待下一题
  }
  console.log(allOk ? '\n✅ 3 题全部：本地判题与服务器判定完全一致' : '\n❌ 存在不一致！');
  // 清理：退出房间即可（测试账号留给用户数据库无害，也可手动删）
  process.exit(allOk ? 0 : 1);
})();
