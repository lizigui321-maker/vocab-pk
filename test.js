/* 模拟双人对战全流程测试：创建→加入→开始→答题→公布→结果 */
'use strict';
const http = require('http');

const BASE = 'http://localhost:3199';

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(BASE + path, {
      method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
    }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(b) }); }
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
  console.log('[1] 获取词库...');
  const books = await req('GET', '/api/books');
  console.log('    词汇本:', books.json.books.map((b) => `${b.name}(${b.count})`).join(', '));
  if (books.json.books.length !== 6) throw new Error('词库数量不对');

  console.log('[2] 房主创建房间（四级·听力模式·5题特殊?默认10）...');
  const created = await req('POST', '/api/create', { name: '小明', bookId: 'cet4', mode: 'listen', count: 10 });
  if (created.status !== 200) throw new Error('创建失败: ' + JSON.stringify(created.json));
  const { roomId, playerId: hostId } = created.json;
  console.log('    房间号:', roomId);

  console.log('[3] 玩家2加入...');
  const joined = await req('POST', '/api/join', { roomId, name: '小红' });
  if (joined.status !== 200) throw new Error('加入失败: ' + JSON.stringify(joined.json));
  const guestId = joined.json.playerId;

  const states = { host: [], guest: [] };
  const seen = {};
  await openStream(roomId, hostId, (s) => { states.host.push(s); });
  await openStream(roomId, guestId, (s) => { states.guest.push(s); });
  await sleep(300);

  console.log('[4] 非房主尝试开始（应被拒绝）...');
  const badStart = await req('POST', '/api/start', { roomId, playerId: guestId });
  console.log('    =>', badStart.status, badStart.json.error || '(未拒绝!)');
  if (badStart.status === 200) throw new Error('非房主不应能开始游戏');

  console.log('[5] 房主开始游戏...');
  await req('POST', '/api/start', { roomId, playerId: hostId });
  await sleep(300);

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
      await req('POST', '/api/answer', { roomId, playerId: guestId, qIndex: q.index, choice: (hostChoice + 1) % 4 });
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

  console.log('[7] 再来一局...');
  await req('POST', '/api/replay', { roomId, playerId: hostId });
  await sleep(400);
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
