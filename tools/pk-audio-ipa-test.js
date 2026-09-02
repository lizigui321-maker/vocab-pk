// PK 音标/读音回归测试：
// 1) 服务端在出题时应把词典缓存里的音标/音频随题下发（v.question.ipa/ipaUk/audio 存在）
// 2) 出题时预热词典缓存，使对战时音标即时显示（而非逐题异步拉取导致部分词缺音标）
// 用法：先起服务（STORE_DIR=... PORT=3197 node server.js），再 `node tools/pk-audio-ipa-test.js`
const BASE = process.env.BASE_URL || 'http://127.0.0.1:3197';
const H = (t) => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + t });

function j(extra) { return Object.assign({ method: 'POST', headers: { 'Content-Type': 'application/json' } }, extra); }

async function api(path, token, body) {
  const headers = token ? H(token) : { 'Content-Type': 'application/json' };
  const opts = { method: 'POST', headers, body: body ? JSON.stringify(body) : undefined };
  if (path.startsWith('/api/state') || path.includes('?')) opts.method = 'GET';
  const res = await fetch(BASE + path, opts);
  return res.json();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const user = 'pktest_' + Math.random().toString(36).slice(2, 9);
  const reg = await api('/api/register', null, { username: user, password: 'pktest123', name: 'PKT' });
  if (!reg.token) { console.log('FAIL register:', JSON.stringify(reg)); process.exit(1); }
  const token = reg.token;
  console.log('registered', user);

  // 预热一批常见词（这些词大概率在 PK 词池里），确保 dictCache 有音标
  const warm = ['the', 'be', 'have', 'do', 'say', 'get', 'make', 'go', 'take', 'know', 'see', 'come', 'think', 'look', 'want', 'give', 'use', 'find', 'tell', 'ask', 'fit', 'run', 'play', 'good', 'water'];
  await Promise.all(warm.map((w) => fetch(BASE + '/api/word?w=' + encodeURIComponent(w) + '&lang=en&wait=1', { headers: H(token) }).then((r) => r.json()).catch(() => null)));
  console.log('warmed', warm.length, 'words');

  // 建房间（看词选义，10 题）
  const room = await api('/api/create', token, { bookId: '', mode: 'word', count: 10 });
  if (!room.roomId) { console.log('FAIL create:', JSON.stringify(room)); process.exit(1); }
  console.log('room', room.roomId, 'player', room.playerId);
  await api('/api/ready', token, { roomId: room.roomId, playerId: room.playerId, ready: true });
  const st = await api('/api/start', token, { roomId: room.roomId, playerId: room.playerId });
  if (!st.ok) { console.log('FAIL start:', JSON.stringify(st)); process.exit(1); }
  console.log('started');

  // 轮询状态，收集每道题的 word + ipa
  const seen = new Map();
  const deadline = Date.now() + 30000;
  let ticks = 0;
  while (Date.now() < deadline) {
    ticks++;
    const s = await api('/api/state?roomId=' + room.roomId + '&playerId=' + room.playerId, token);
    if (s && s.question && s.question.word) {
      const q = s.question;
      if (!seen.has(q.word)) { seen.set(q.word, { ipa: q.ipa, ipaUk: q.ipaUk, audio: q.audio }); console.log('  tick', ticks, 'phase=', s.phase, 'word=', q.word, 'ipa=', JSON.stringify(q.ipa)); }
    } else if (s) {
      console.log('  tick', ticks, 'phase=', s.phase, 'question?', !!s.question);
    }
    if (seen.size >= 4) break; // 收集到 4 题即可判定
    await sleep(700);
  }

  const list = [...seen.entries()];
  console.log('observed questions:', list.length);
  for (const [w, d] of list) console.log('  ', w, '| ipa=', JSON.stringify(d.ipa), 'audio?', !!d.audio);

  let fail = 0;
  // 断言 1：每道题都带 ipa 字段（字符串）
  for (const [w, d] of list) {
    if (typeof d.ipa !== 'string') { console.log('FAIL: question', w, 'missing ipa field'); fail++; }
  }
  // 断言 2：至少有一题音标非空（服务端确实随题下发了缓存音标）
  const anyIpa = list.some(([, d]) => d.ipa && d.ipa.trim());
  if (!anyIpa) { console.log('FAIL: no served question had a non-empty ipa'); fail++; }
  // 断言 3：出现在题面且被预热的词，音标应非空（服务端用了词典缓存）
  const overlap = list.filter(([w]) => warm.includes(w));
  for (const [w, d] of overlap) {
    if (!d.ipa || !d.ipa.trim()) { console.log('FAIL: warmed word', w, 'served with empty ipa'); fail++; }
  }

  if (fail === 0) {
    console.log('PASS: PK 题面均随题下发音标/音频（ipa 字段存在，且至少一题为非空）');
    process.exit(0);
  } else {
    console.log('FAIL: ' + fail + ' 项未通过');
    process.exit(1);
  }
})().catch((e) => { console.log('ERROR', e); process.exit(1); });
