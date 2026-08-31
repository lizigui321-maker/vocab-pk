/* 模拟双人对战全流程测试：创建→加入→开始→答题→公布→结果 */
'use strict';
const http = require('http');

const BASE = process.env.TEST_BASE || 'http://localhost:3199';
let TOKEN = '';       // 房主账号 token
/* 第二名玩家必须用【独立账号】：服务端按 username 判定「同一账号在房间里只占一个玩家位」，
   用同一个账号既建房又加入，只会复用同一个玩家（房主本人），根本构不成对战，
   后续「非房主不能开始」「客人需准备」等断言也就无从验证。 */
let GUEST_TOKEN = '';

function req(method, path, body, token) {
  return new Promise((resolve, reject) => {
    let p = path, b = body;
    const tk = token || TOKEN;
    // 自动携带登录 token（POST 放 body，GET 放 query）
    if (tk) {
      if (b && typeof b === 'object') b = Object.assign({ token: tk }, b);
      else if (method === 'POST') b = { token: tk };
      else p += (p.indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(tk);
    }
    const data = b ? JSON.stringify(b) : null;
    const r = http.request(BASE + p, {
      method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(body) }); }
        catch (e) { resolve({ status: res.statusCode, json: {} }); }
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

// 打开一个 SSE 连接并监听状态
function openStream(roomId, playerId, onState) {
  return new Promise((resolve, reject) => {
    const r = http.get(BASE + `/api/stream?roomId=${roomId}&playerId=${playerId}`, (res) => {
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log('[0] 注册并登录测试账号...');
  const U = 'bt' + Date.now().toString(36).slice(-8);
  const PW = 'pw123456';
  const reg = await req('POST', '/api/register', { username: U, password: PW, name: 'Battle' });
  if (reg.status === 200) TOKEN = reg.json.token;
  else {
    const lg = await req('POST', '/api/login', { username: U, password: PW });
    if (lg.status !== 200) throw new Error('测试账号注册/登录失败: ' + JSON.stringify(lg.json));
    TOKEN = lg.json.token;
  }
  if (!TOKEN) throw new Error('未获取到 token');
  console.log('    已登录(房主):', U);

  // 第二名玩家：注册一个独立账号（对战必须由两个不同账号构成）
  const U2 = 'bt' + Date.now().toString(36).slice(-8) + 'b';
  const reg2 = await req('POST', '/api/register', { username: U2, password: PW, name: '小红' });
  if (reg2.status === 200) GUEST_TOKEN = reg2.json.token;
  else {
    const lg2 = await req('POST', '/api/login', { username: U2, password: PW });
    if (lg2.status !== 200) throw new Error('玩家2注册/登录失败: ' + JSON.stringify(lg2.json));
    GUEST_TOKEN = lg2.json.token;
  }
  if (!GUEST_TOKEN) throw new Error('未获取到玩家2 token');
  console.log('    已登录(玩家2):', U2);

  console.log('[1] 获取词库...');
  const books = await req('GET', '/api/books');
  console.log('    词汇本:', books.json.books.map((b) => `${b.name}(${b.count})`).join(', '));
  if (books.json.books.length < 6) throw new Error('词库数量不对（应至少 6 本，实际 ' + books.json.books.length + '）');

  console.log('[1b] 校验默认对战词书为托福(toefl)，且题库已剔除简单词...');
  if (books.json.defaultPkBook !== 'toefl') throw new Error('默认对战词书应为 toefl，实际: ' + books.json.defaultPkBook);
  // 本地读取 books.json，构造「基础简单词集合」（与服务器 FOUNDATION_BOOK_IDS 保持一致）
  const fs = require('fs');
  const path = require('path');
  const allBooks = JSON.parse(fs.readFileSync(path.join(__dirname, 'public', 'data', 'books.json'), 'utf8'));
  const FOUNDATION = ['zhongkao', 'gaokao', 'cet4', 'cet4-core'];
  const simpleSet = new Set();
  for (const fid of FOUNDATION) {
    const b = allBooks.find((x) => x.id === fid);
    if (b) for (const it of b.words) if (Array.isArray(it) && typeof it[0] === 'string') simpleSet.add(it[0].trim().toLowerCase());
  }
  // 默认词书（bookId 留空）出题，应回落到 toefl，且不应出现任何「基础简单词」
  const defQ = await req('GET', '/api/diag/questions?bookId=&count=30');
  if (defQ.status !== 200) throw new Error('/api/diag/questions 失败: ' + JSON.stringify(defQ.json));
  if (defQ.json.bookId !== 'toefl') throw new Error('默认出题词书应为 toefl，实际: ' + defQ.json.bookId);
  const leaked = defQ.json.questions.filter((q) => simpleSet.has(String(q.word || '').trim().toLowerCase()));
  if (leaked.length) throw new Error('默认题库混入了 ' + leaked.length + ' 个简单词，例如: ' + leaked.slice(0, 5).map((q) => q.word).join(', '));
  console.log('    默认(空 bookId) =>', defQ.json.bookName, '| 抽样', defQ.json.count, '题，无简单词 ✅');
  // 基础词书(cet4)本身不被过滤：应仍包含大量基础词，且能正常出题
  const cet4Q = await req('GET', '/api/diag/questions?bookId=cet4&count=30');
  if (cet4Q.status !== 200) throw new Error('cet4 出题失败');
  if (cet4Q.json.questions.length === 0) throw new Error('cet4 出题为空，过滤逻辑有误');
  console.log('    基础词书 cet4 出题', cet4Q.json.questions.length, '题（不过滤）✅');

  console.log('[2] 房主创建房间（四级·听力模式·5题特殊?默认10）...');
  const created = await req('POST', '/api/create', { name: '小明', bookId: 'cet4', mode: 'listen', count: 10 });
  if (created.status !== 200) throw new Error('创建失败: ' + JSON.stringify(created.json));
  const { roomId, playerId: hostId } = created.json;
  console.log('    房间号:', roomId);

  console.log('[3] 玩家2加入...');
  const joined = await req('POST', '/api/join', { roomId, name: '小红' }, GUEST_TOKEN);
  if (joined.status !== 200) throw new Error('加入失败: ' + JSON.stringify(joined.json));
  const guestId = joined.json.playerId;

  const states = { host: [], guest: [] };
  const seen = {};
  await openStream(roomId, hostId, (s) => { states.host.push(s); });
  await openStream(roomId, guestId, (s) => { states.guest.push(s); });
  await sleep(300);

  console.log('[4] 非房主尝试开始（应被拒绝）...');
  const badStart = await req('POST', '/api/start', { roomId, playerId: guestId }, GUEST_TOKEN);
  console.log('    =>', badStart.status, badStart.json.error || '(未拒绝!)');
  if (badStart.status === 200) throw new Error('非房主不应能开始游戏');

  console.log('[5] 客人准备后房主开始游戏（含 3 秒倒计时；房主无需准备）...');
  // 客人未准备时，房主不应能开始
  const earlyStart = await req('POST', '/api/start', { roomId, playerId: hostId });
  if (earlyStart.status === 200) throw new Error('客人未准备却仍能开始，准备机制失效');
  console.log('    客人未准备时开始被拒 =>', earlyStart.status, earlyStart.json.error || '');
  // 只有客人需要准备
  await req('POST', '/api/ready', { roomId, playerId: guestId }, GUEST_TOKEN);
  const st5 = await req('GET', '/api/state?roomId=' + roomId + '&playerId=' + hostId);
  if (st5.json.allReady !== true) throw new Error('客人已准备但 allReady 不为 true');
  const hostReady = (st5.json.players || []).find((p) => p.isHost);
  if (hostReady && hostReady.ready !== false) throw new Error('房主不应需要准备');
  console.log('    客人已准备，房主未准备（符合预期），房主开始');
  const notReadyStart = await req('POST', '/api/start', { roomId, playerId: hostId });
  if (notReadyStart.status !== 200) throw new Error('客人已准备却无法开始：' + (notReadyStart.json.error || ''));
  await sleep(3400); // 等 3 秒倒计时走完
  const cdState = await req('GET', '/api/state?roomId=' + roomId + '&playerId=' + hostId);
  if (cdState.json.phase !== 'question') throw new Error('倒计时结束后未进入答题阶段：' + cdState.json.phase);
  console.log('    => 倒计时结束，已进入答题阶段');

  let correct = 0, wrong = 0, timeouts = 0;
  const totals = { host: 0, guest: 0 };

  // 循环处理每一题，直到 result
  for (let round = 0; round < 12; round++) {
    const hs = states.host[states.host.length - 1];
    if (!hs || hs.phase !== 'question') {
      if (hs && hs.phase === 'result') break;
      await sleep(600); continue;
    }
    const q = hs.question;
    if (seen[q.index]) { await sleep(400); continue; }
    seen[q.index] = true;

    // 小明：抢答快且答案来自 guest 状态里的正确项？我们不知道正确答案（服务端不泄露）
    // 策略：小明随机选，小红延迟 1.2s 后选另一个选项
    const hostChoice = Math.floor(Math.random() * 4);
    await req('POST', '/api/answer', { roomId, playerId: hostId, qIndex: q.index, choice: hostChoice });
    await sleep(1200);
    const gs = states.guest[states.guest.length - 1];
    if (gs && gs.phase === 'question' && gs.question && gs.question.myChoice === null) {
      await req('POST', '/api/answer', { roomId, playerId: guestId, qIndex: q.index, choice: (hostChoice + 1) % 4 }, GUEST_TOKEN);
    }
    // 等待 reveal
    await sleep(800);
    const hr = states.host[states.host.length - 1];
    if (hr && hr.phase === 'reveal') {
      const lr = hr.lastResult;
      for (const pid of [hostId, guestId]) {
        const r = lr.results[pid];
        if (r && r.correct) correct++; else if (r) wrong++; else timeouts++;
      }
    }
    await sleep(4200); // 等 reveal 结束进入下一题
  }

  const fin = states.host[states.host.length - 1];
  console.log('[6] 最终阶段:', fin.phase, '| 题目数:', fin.total);
  if (fin.phase !== 'result') throw new Error('未正常到达 result 阶段');
  if (fin.total !== 10) throw new Error('题目数应为 10');
  console.log('    排名:', fin.players.map((p) => `${p.name} ${p.score}分/对${p.correctCount}`).join('  |  '));
  console.log(`    答题统计: 正确判定 ${correct} 次, 错误判定 ${wrong} 次, 超时 ${timeouts} 次`);
  if (correct + wrong + timeouts !== 20) throw new Error('答题记录数不对（应为 20 = 2人×10题）');

  console.log('[7] 再来一局（同样只需客人准备，房主无需；含 3 秒倒计时）...');
  await req('POST', '/api/ready', { roomId, playerId: guestId }, GUEST_TOKEN);
  const rep = await req('POST', '/api/replay', { roomId, playerId: hostId });
  if (rep.status !== 200) throw new Error('再来一局失败：' + (rep.json.error || ''));
  await sleep(3600); // 等 3 秒倒计时
  const again = states.host[states.host.length - 1];
  console.log('    新阶段:', again.phase, '第', again.qIndex + 1, '题');
  if (again.phase !== 'question') throw new Error('再来一局失败');

  console.log('[8] 非法房间号加入（应报错）...');
  const badJoin = await req('POST', '/api/join', { roomId: 'ZZZZ', name: '路人' });
  console.log('    =>', badJoin.status, badJoin.json.error);

  console.log('\n✅ 全部测试通过');
  process.exit(0);
}

main().catch((e) => { console.error('❌ 测试失败:', e.message); process.exit(1); });
