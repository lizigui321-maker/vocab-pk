/*
 * 单词PK · 词汇对战服务器（局域网 / 公网均可）
 * 零 npm 依赖：Node.js 内置 http + SSE（Server-Sent Events）实现实时对战
 * 启动：node server.js   （默认端口 3000，可用 PORT=xxxx 覆盖）
 * 注：公网（Cloudflare 隧道）下 SSE 可能被链路缓冲，前端会自动降级为 /api/state 轮询
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PUB = path.join(__dirname, 'public');
const BOOKS = JSON.parse(fs.readFileSync(path.join(PUB, 'data', 'books.json'), 'utf8'));

const QUESTION_MS = { word: 12000, listen: 15000 }; // 每题作答时长
const REVEAL_MS = 2000;                             // 答案公布停留时长（最后一人答完快速进入下一题）
const ROOM_EMPTY_TTL = 5 * 60 * 1000;               // 空房间保留时长
const ONLINE_WINDOW = 12 * 1000;                    // 最近 12 秒内有 SSE 或轮询即视为在线

/* 词条预处理：从释义中剥离词性前缀，得到纯中文释义 + 词性分组 */
const POS_RE = /^(n|v|adj|adv|prep|conj|pron|num|int|art|aux|vt|vi|abbr)\.?\s*/i;
function splitMeaning(raw) {
  const segs = String(raw).split(/\s*\/\s*/).map((s) => s.trim()).filter(Boolean);
  const first = segs[0] || '';
  const m = first.match(POS_RE);
  const pos = m ? m[1].toLowerCase() : '';
  const clean = segs.map((s) => s.replace(POS_RE, '').trim()).filter(Boolean).join(' / ');
  return { pos, clean: clean || String(raw) };
}
for (const b of BOOKS) {
  b._words = b.words.map(([word, meaning]) => {
    const { pos, clean } = splitMeaning(meaning);
    return { word, meaning: clean, pos };
  });
  b._byPos = new Map();
  for (const w of b._words) {
    if (!b._byPos.has(w.pos)) b._byPos.set(w.pos, []);
    b._byPos.get(w.pos).push(w);
  }
}

/* ---------------- 持久化存储（生词本 / 词汇量排行） ---------------- */
const STORE = path.join(__dirname, 'store');
if (!fs.existsSync(STORE)) fs.mkdirSync(STORE, { recursive: true });
const RANK_FILE = path.join(STORE, 'vocab-rank.json');
const ACCOUNTS_FILE = path.join(STORE, 'accounts.json');
const SESSIONS_FILE = path.join(STORE, 'sessions.json');
function loadJSON(f, dflt) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return dflt; } }
function saveJSON(f, data) { try { fs.writeFileSync(f, JSON.stringify(data), 'utf8'); } catch (e) {} }
let vocabRank = loadJSON(RANK_FILE, []);     // [{name, best, latest, count, at}] 词汇量排行
let accounts = loadJSON(ACCOUNTS_FILE, {});  // username(小写) -> {username, salt, hash, name, createdAt, words:[{word,meaning,book,at}]}
let sessions = loadJSON(SESSIONS_FILE, {});  // token -> {username, at}
function saveAccounts(){ saveJSON(ACCOUNTS_FILE, accounts); }
function saveSessions(){ saveJSON(SESSIONS_FILE, sessions); }
function hashPassword(pw, salt){ return crypto.scryptSync(String(pw), salt, 32).toString('hex'); }
function newSession(username){
  const token = crypto.randomBytes(24).toString('hex');
  sessions[token] = { username: String(username).toLowerCase(), at: Date.now() };
  saveSessions();
  return token;
}
function authUser(token){
  const s = token && sessions[token];
  if (!s) return null;
  if (Date.now() - s.at > 30 * 24 * 3600 * 1000) { delete sessions[token]; saveSessions(); return null; } // 30 天免登录
  return accounts[String(s.username).toLowerCase()] || null;
}
const RE_USER = /^[a-zA-Z0-9_]{3,16}$/;

/* ---------------- 词汇量自测：难度分层（词取所属最低层） ---------------- */
const TIERS = [
  { id: 'zhongkao', name: '中考' },
  { id: 'gaokao', name: '高考' },
  { id: 'cet4', name: '四级' },
  { id: 'cet6', name: '六级' },
  { id: 'kaoyan', name: '考研' },
  { id: 'ielts', name: '雅思' },
  { id: 'toefl', name: '托福' },
];
const tierWords = TIERS.map(() => []);
const WORD_TIER = new Map(); // 小写单词 -> 难度层（0=中考最高频 … 6=托福），取所属最低（最高频）层
{
  const tierOf = WORD_TIER;
  for (let t = 0; t < TIERS.length; t++) {
    const book = BOOKS.find((b) => b.id === TIERS[t].id);
    if (!book) continue;
    const seen = new Set();
    for (const [word, meaning] of book.words) {
      const k = String(word).toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      if (!tierOf.has(k)) { tierOf.set(k, t); tierWords[t].push({ word, meaning: splitMeaning(meaning).clean }); }
    }
  }
}
const TIER_SIZES = tierWords.map((a) => a.length);
const TIER_SAMPLE = 6; // 每层抽 6 题，共 42 题
const ALL_TIER_WORDS = tierWords.flat(); // 词汇量测试干扰释义候选池

const rooms = new Map();

/* ================= 背单词 · 学习模块（计划 / 词频排序 / 单元 / SRS 复习） ================= */
const UNIT_SIZE = 50;                                  // 每单元词数
const MASTER_LV = 5;                                   // 连续答对 5 级 = 已掌握
const SRS_DAYS = [0, 1, 2, 4, 7, 15, 30, 60];          // 掌握等级 -> 复习间隔（天），索引即等级
const WRONG_REDUE = 10 * 60 * 1000;                    // 答错后 10 分钟进入复习队列

/* 词频表（google-10000 语料，按频率从高到低）；加载失败自动用难度层级兜底 */
const FREQ = (() => {
  try {
    const list = JSON.parse(fs.readFileSync(path.join(PUB, 'data', 'freq.json'), 'utf8'));
    const m = new Map();
    for (let i = 0; i < list.length; i++) m.set(String(list[i]).toLowerCase(), i + 1);
    return m;
  } catch (e) { return new Map(); }
})();

/* 全局单词信息表：小写词 -> {word, meaning, bookName, pos}（首个收录的书优先） */
const WORD_INFO = new Map();

/* 单词的全局频率位次：词频表命中 → 真实词频(1..N)；未命中 → 20000+难度层*100；完全未知 → 30000 */
function freqPos(word) {
  const k = String(word).toLowerCase();
  const r = FREQ.get(k);
  if (r) return r;
  const t = WORD_TIER.get(k);
  if (t === undefined) return 30000;
  return 20000 + t * 100;
}
for (const b of BOOKS) {
  b._studyOrder = b._words.map((w, i) => {
    const k = String(w.word).toLowerCase();
    if (!WORD_INFO.has(k)) WORD_INFO.set(k, { word: w.word, meaning: w.meaning, bookName: b.name, bookId: b.id });
    return { word: w.word, meaning: w.meaning, pos: freqPos(w.word), idx: i, posKey: k };
  });
  b._studyOrder.sort((a, c) => a.pos - c.pos || a.idx - c.idx);
}

/* 学习状态（挂在账号上，账号隔离持久化）：
 * study = { plan:{bookId,dailyNew,vocabEstimate,autoSpeak}, progress:{词:{lv,n,c,wrong,due,firstAt,lastAt}}, log:{"YYYY-MM-DD":{new,review,wrong}} }
 */
function getStudy(acc) {
  if (!acc.study || typeof acc.study !== 'object') acc.study = { plan: null, progress: {}, log: {} };
  if (!acc.study.progress) acc.study.progress = {};
  if (!acc.study.log) acc.study.log = {};
  if (Array.isArray(acc.study.plan)) acc.study.plan = null; // 兼容历史脏数据
  return acc.study;
}
function dayKey(ts) {
  const d = new Date(ts);
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
function wordKey(w) { return String(w || '').trim().toLowerCase(); }

/* 按预估词汇量过滤：频率位次 ≤ 估计值的视为「已会」，跳过学习 */
function filterKnown(book, vocabEstimate) {
  const est = Math.max(0, Number(vocabEstimate) || 0);
  if (!est) return { list: book._studyOrder, skipped: 0 };
  const list = book._studyOrder.filter((w) => w.pos > est);
  return { list, skipped: book._studyOrder.length - list.length };
}
function todayLog(st) {
  const k = dayKey(Date.now());
  if (!st.log[k]) st.log[k] = { new: 0, review: 0, wrong: 0 };
  return st.log[k];
}
function streakOf(st) {
  const days = new Set(Object.keys(st.log).filter((d) => st.log[d].new + st.log[d].review > 0));
  if (!days.size) return 0;
  let streak = 0;
  const cur = new Date();
  if (!days.has(dayKey(cur.getTime()))) {
    cur.setDate(cur.getDate() - 1); // 今天还没学：从昨天往前算（昨天没学则连击清零）
    if (!days.has(dayKey(cur.getTime()))) return 0;
  }
  while (days.has(dayKey(cur.getTime()))) { streak += 1; cur.setDate(cur.getDate() - 1); }
  return streak;
}
/* 学习总览（仪表盘数据） */
function studyOverview(acc) {
  const st = getStudy(acc);
  const out = { plan: null, books: BOOKS.map((b) => ({ id: b.id, name: b.name, count: b.words.length })) };
  if (!st.plan) return out;
  const book = BOOKS.find((b) => b.id === st.plan.bookId) || BOOKS[0];
  const { list, skipped } = filterKnown(book, st.plan.vocabEstimate);
  const now = Date.now();
  const lg = todayLog(st);
  let learned = 0, mastered = 0, due = 0;
  const inBook = new Set(list.map((w) => w.posKey));
  for (const [k, p] of Object.entries(st.progress)) {
    if (!p || !p.n) continue;
    if (inBook.has(k)) learned += 1;
    if (p.lv >= MASTER_LV) mastered += 1;
    else if (p.lv > 0 && p.due && p.due <= now) due += 1;
  }
  const units = [];
  for (let i = 0; i < list.length; i += UNIT_SIZE) {
    const seg = list.slice(i, i + UNIT_SIZE);
    let uLearned = 0;
    for (const w of seg) { const p = st.progress[w.posKey]; if (p && p.n) uLearned += 1; }
    units.push({ index: units.length, total: seg.length, learned: uLearned, first: seg[0].word, last: seg[seg.length - 1].word });
  }
  // 最近 30 天日志（含空白天，供日历条渲染）
  const log30 = [];
  const d = new Date();
  d.setDate(d.getDate() - 29);
  for (let i = 0; i < 30; i++) {
    const k = dayKey(d.getTime());
    const e = st.log[k];
    log30.push({ date: k, new: (e && e.new) || 0, review: (e && e.review) || 0, wrong: (e && e.wrong) || 0 });
    d.setDate(d.getDate() + 1);
  }
  return {
    plan: st.plan, bookId: book.id, bookName: book.name,
    total: list.length, rawTotal: book.words.length, skipped, unitSize: UNIT_SIZE,
    learned, mastered, due, wrongCount: (acc.words || []).length,
    today: { new: lg.new, review: lg.review, wrong: lg.wrong, dailyNew: st.plan.dailyNew, newRemaining: Math.max(0, st.plan.dailyNew - lg.new) },
    streak: streakOf(st), units, log30,
  };
}
/* 生成一道学习选择题（英文题干 + 4 个中文选项，干扰项优先同词性） */
function genStudyQuestion(w, book) {
  let candidates = [];
  const k = wordKey(w.word);
  const orig = book._words.find((x) => wordKey(x.word) === k);
  if (orig && orig.pos && book._byPos.has(orig.pos)) {
    candidates = book._byPos.get(orig.pos).filter((x) => x.word !== w.word && x.meaning !== w.meaning);
  }
  if (candidates.length < 3) candidates = candidates.concat(book._words.filter((x) => x.word !== w.word && x.meaning !== w.meaning));
  const seen = new Set([w.meaning]);
  const distract = [];
  for (const x of shuffle(candidates)) {
    if (seen.has(x.meaning)) continue;
    seen.add(x.meaning); distract.push(x.meaning);
    if (distract.length === 3) break;
  }
  const options = shuffle([w.meaning, ...distract]);
  return { word: w.word, meaning: w.meaning, options, correctIndex: options.indexOf(w.meaning) };
}
function wordInfoOf(word, preferBook) {
  const k = wordKey(word);
  if (preferBook) {
    const hit = preferBook._words.find((x) => wordKey(x.word) === k);
    if (hit) return { meaning: hit.meaning, bookName: preferBook.name };
  }
  const info = WORD_INFO.get(k);
  return info ? { meaning: info.meaning, bookName: info.bookName } : null;
}
/* 学习作答：更新进度 + SRS 排期 + 错题写入与 PK 共享的生词本 */
function studyAnswer(acc, word, correct) {
  const st = getStudy(acc);
  const k = wordKey(word);
  const info = wordInfoOf(word, BOOKS.find((b) => b.id === (st.plan && st.plan.bookId)));
  const now = Date.now();
  const lg = todayLog(st);
  let p = st.progress[k];
  const isNew = !p || !p.n;
  if (!p) p = st.progress[k] = { lv: 0, n: 0, c: 0, wrong: 0, due: 0, firstAt: now, lastAt: now };
  p.n += 1; p.lastAt = now;
  let removed = false;
  if (correct) {
    p.c += 1;
    p.lv = Math.min((p.lv || 0) + 1, SRS_DAYS.length - 1);
    p.due = now + SRS_DAYS[p.lv] * 86400000;
    // 达到掌握等级且已在生词本 → 毕业，自动移出生词本
    if (p.lv >= MASTER_LV && Array.isArray(acc.words)) {
      const before = acc.words.length;
      acc.words = acc.words.filter((x) => wordKey(x.word) !== k);
      removed = before !== acc.words.length;
    }
  } else {
    p.wrong = (p.wrong || 0) + 1;
    p.lv = 0;
    p.due = now + WRONG_REDUE;
    if (info) {
      const list = acc.words = acc.words || [];
      const idx = list.findIndex((x) => wordKey(x.word) === k);
      if (idx >= 0) list.splice(idx, 1);
      list.unshift({ word: String(word), meaning: info.meaning, book: info.bookName, at: now });
      if (list.length > 500) list.length = 500;
    }
    lg.wrong += 1;
  }
  if (isNew) lg.new += 1; else lg.review += 1;
  saveAccounts();
  return { ok: true, lv: p.lv, mastered: p.lv >= MASTER_LV, removed, isNew };
}

/* ---------------- 工具 ---------------- */
function uid() { return crypto.randomBytes(8).toString('hex'); }
function roomCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let c;
  do { c = Array.from({ length: 4 }, () => A[Math.floor(Math.random() * A.length)]).join(''); }
  while (rooms.has(c));
  return c;
}
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function send(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
function lanIPs() {
  const out = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

/* ---------------- 房间与游戏逻辑 ---------------- */
function genQuestions(bookId, count) {
  const book = BOOKS.find((b) => b.id === bookId) || BOOKS[0];
  const pool = shuffle(book._words).slice(0, Math.min(count, book._words.length));
  return pool.map((w) => {
    // 干扰项优先取同词性词条（无法按词性排除，迷惑性更强）；不足 3 个再从全书补
    let candidates = [];
    if (w.pos && book._byPos.has(w.pos)) {
      candidates = book._byPos.get(w.pos).filter((x) => x.word !== w.word && x.meaning !== w.meaning);
    }
    if (candidates.length < 3) {
      candidates = candidates.concat(
        book._words.filter((x) => x.word !== w.word && x.meaning !== w.meaning)
      );
    }
    const seen = new Set([w.meaning]);
    const distract = [];
    for (const x of shuffle(candidates)) {
      if (seen.has(x.meaning)) continue;
      seen.add(x.meaning);
      distract.push(x.meaning);
      if (distract.length === 3) break;
    }
    const options = shuffle([w.meaning, ...distract]);
    return { word: w.word, meaning: w.meaning, options, correctIndex: options.indexOf(w.meaning) };
  });
}

function newRoom({ bookId, mode, count }) {
  const id = roomCode();
  const room = {
    id,
    phase: 'lobby',            // lobby | question | reveal | result
    players: new Map(),
    settings: { bookId, mode, count },
    questions: [],
    qIndex: -1,
    answered: new Map(),       // playerId -> { choice, gained, at }
    timer: null,
    roundStartedAt: 0,
    roundMs: 0,
    lastResult: null,
    emptySince: 0,
  };
  rooms.set(id, room);
  return room;
}

function addPlayer(room, name, isHost, username) {
  const id = uid();
  room.players.set(id, { id, name, username: username || '', score: 0, correctCount: 0, isHost: !!isHost, isNew: true, res: null, ping: null, lastSeen: Date.now(), seenInRound: false });
  return room.players.get(id);
}

/* 在线判定：有 SSE 连接，或最近 ONLINE_WINDOW 内轮询/操作过（公网轮询模式下也算在线） */
function isOnline(p) {
  if (p.res && !p.res.writableEnded && !p.res.destroyed) return true;
  return p.lastSeen && Date.now() - p.lastSeen < ONLINE_WINDOW;
}

function view(room, playerId) {
  const book = BOOKS.find((b) => b.id === room.settings.bookId) || {};
  const v = {
    roomId: room.id,
    phase: room.phase,
    serverNow: Date.now(),
    settings: room.settings,
    bookName: book.name || '',
    qIndex: room.qIndex,
    total: room.questions.length,
    players: [...room.players.values()].map((p) => ({
      id: p.id, name: p.name, score: p.score, correctCount: p.correctCount,
      isHost: p.isHost, isNew: p.isNew, connected: isOnline(p), answered: room.answered.has(p.id),
    })),
    you: playerId,
  };
  if ((room.phase === 'question' || room.phase === 'reveal') && room.questions[room.qIndex]) {
    const q = room.questions[room.qIndex];
    v.question = { index: room.qIndex, word: q.word, options: q.options };
    if (room.phase === 'question') {
      v.question.deadline = room.roundStartedAt + room.roundMs;
      v.question.durationMs = room.roundMs;
      const my = room.answered.get(playerId);
      v.question.myChoice = my ? my.choice : null;
      if (my) {
        // 已答题玩家立即拿到自己的对错与正确答案，前端即时反馈
        v.question.myCorrect = my.choice === q.correctIndex;
        v.question.myGained = my.gained;
        v.question.correctIndex = q.correctIndex;
      }
    } else {
      v.lastResult = room.lastResult;
    }
  }
  return v;
}

function broadcast(room) {
  const payload = (pid) => `data: ${JSON.stringify(view(room, pid))}\n\n`;
  for (const p of room.players.values()) {
    if (p.res && !p.res.writableEnded && !p.res.destroyed) {
      try { p.res.write(payload(p.id)); } catch (e) { p.res = null; }
    }
  }
}

function startGame(room) {
  clearTimeout(room.timer);
  room.questions = genQuestions(room.settings.bookId, room.settings.count);
  room.qIndex = -1;
  room.lastResult = null;
  for (const p of room.players.values()) { p.score = 0; p.correctCount = 0; p.isNew = false; }
  nextQuestion(room);
}

function nextQuestion(room) {
  clearTimeout(room.timer);
  room.qIndex += 1;
  if (room.qIndex >= room.questions.length) {
    room.phase = 'result';
    broadcast(room);
    return;
  }
  room.phase = 'question';
  room.answered = new Map();
  for (const p of room.players.values()) p.seenInRound = false; // 本题是否见过该玩家（轮询/SSE/作答都算）
  room.roundStartedAt = Date.now();
  room.roundMs = QUESTION_MS[room.settings.mode] || QUESTION_MS.word;
  broadcast(room);
  room.timer = setTimeout(() => reveal(room), room.roundMs + 400);
}

/* 答错/超时的单词记入账号个人生词本（按账号隔离、去重，新词在前，最多 500 个） */
function recordWrong(player, q, bookName, at) {
  if (!player || !player.username) return;
  const account = accounts[String(player.username).toLowerCase()];
  if (!account) return;
  const key = String(q.word).toLowerCase();
  const list = account.words = account.words || [];
  const idx = list.findIndex((x) => String(x.word).toLowerCase() === key);
  if (idx >= 0) list.splice(idx, 1);
  list.unshift({ word: q.word, meaning: q.meaning, book: bookName || '', at });
  if (list.length > 500) list.length = 500;
  // PK 答错同步刷新学习进度：已学过的词记忆等级归零，尽快进入复习队列
  if (account.study && account.study.progress && account.study.progress[key]) {
    const pr = account.study.progress[key];
    pr.lv = 0; pr.wrong = (pr.wrong || 0) + 1; pr.due = Date.now() + WRONG_REDUE;
  }
  saveAccounts();
}

function reveal(room) {
  clearTimeout(room.timer);
  if (room.phase !== 'question') return;
  room.phase = 'reveal';
  const q = room.questions[room.qIndex];
  const bookName = (BOOKS.find((b) => b.id === room.settings.bookId) || {}).name || '';
  const now = Date.now();
  const results = {};
  for (const [pid, a] of room.answered) {
    const correct = a.choice === q.correctIndex;
    results[pid] = { choice: a.choice, correct, gained: a.gained };
    if (!correct) recordWrong(room.players.get(pid), q, bookName, now);
  }
  // 超时未答也算生词（在线玩家，或本题期间见过但中途掉线的玩家）
  for (const p of room.players.values()) {
    if ((isOnline(p) || p.seenInRound) && !room.answered.has(p.id)) recordWrong(p, q, bookName, now);
  }
  room.lastResult = { qIndex: room.qIndex, correctIndex: q.correctIndex, word: q.word, meaning: q.meaning, results };
  broadcast(room);
  room.timer = setTimeout(() => nextQuestion(room), REVEAL_MS);
}

function handleAnswer(room, pid, qIndex, choice) {
  if (room.phase !== 'question') return;
  if (qIndex !== room.qIndex || room.answered.has(pid)) return;
  const p = room.players.get(pid);
  if (!p) return;
  p.lastSeen = Date.now();
  p.seenInRound = true;
  const q = room.questions[room.qIndex];
  const now = Date.now();
  const remaining = Math.max(0, room.roundStartedAt + room.roundMs - now);
  let gained = 0;
  if (choice === q.correctIndex) {
    gained = 100 + Math.round(20 * (remaining / room.roundMs)); // 答对 100 + 速度加成最多 20（缩小差距）
    p.score += gained;
    p.correctCount += 1;
  }
  room.answered.set(pid, { choice, gained, at: now });
  const online = [...room.players.values()].filter(isOnline);
  if (online.length > 0 && online.every((x) => room.answered.has(x.id))) {
    reveal(room); // 所有人都答完了，提前公布
  } else {
    broadcast(room);
  }
}

/* 空房间清理 + 房主掉线自动转移（SSE 与轮询玩家都算在线） */
setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    const online = [...room.players.values()].filter(isOnline);
    if (online.length === 0) {
      room.emptySince = room.emptySince || now;
      if (now - room.emptySince > ROOM_EMPTY_TTL) { clearTimeout(room.timer); rooms.delete(id); }
    } else {
      room.emptySince = 0;
      if (!online.some((p) => p.isHost)) {
        for (const p of room.players.values()) p.isHost = false;
        online[0].isHost = true;
        broadcast(room);
      }
    }
  }
}, 30000);

/* ---------------- HTTP 服务 ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

function serveStatic(req, res) {
  let p;
  try { p = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); } catch (e) { p = '/'; }
  if (p === '/') p = '/index.html';
  const fp = path.normalize(path.join(PUB, p));
  if (!fp.startsWith(PUB)) { send(res, 403, { error: 'forbidden' }); return; }
  fs.readFile(fp, (err, data) => {
    if (err) { send(res, 404, { error: 'not found' }); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;
  try {
    if (req.method === 'GET' && p === '/api/books') {
      return send(res, 200, { books: BOOKS.map((b) => ({ id: b.id, name: b.name, count: b.words.length })) });
    }
    if (req.method === 'GET' && p === '/api/info') {
      let publicUrl = '';
      try { publicUrl = fs.readFileSync('store/public-url.txt', 'utf8').trim(); } catch (e) {}
      return send(res, 200, { port: PORT, ips: lanIPs(), publicUrl });
    }
    // ---------------- 账号系统接口 ----------------
    if (req.method === 'POST' && p === '/api/register') {
      const b = await readBody(req);
      const username = String(b.username || '').trim();
      const password = String(b.password || '');
      const name = String(b.name || '').trim().slice(0, 12);
      if (!RE_USER.test(username)) return send(res, 400, { error: '用户名需 3-16 位字母/数字/下划线' });
      if (password.length < 6) return send(res, 400, { error: '密码至少 6 位' });
      if (accounts[username.toLowerCase()]) return send(res, 409, { error: '用户名已被占用' });
      const salt = crypto.randomBytes(16).toString('hex');
      accounts[username.toLowerCase()] = {
        username, salt, hash: hashPassword(password, salt),
        name: name || username, createdAt: Date.now(), words: [],
      };
      saveAccounts();
      const token = newSession(username);
      return send(res, 200, { token, username, name: name || username });
    }
    if (req.method === 'POST' && p === '/api/login') {
      const b = await readBody(req);
      const username = String(b.username || '').trim().toLowerCase();
      const password = String(b.password || '');
      const acc = accounts[username];
      if (!acc || acc.hash !== hashPassword(password, acc.salt)) return send(res, 401, { error: '用户名或密码错误' });
      const token = newSession(username);
      return send(res, 200, { token, username: acc.username, name: acc.name });
    }
    if (req.method === 'GET' && p === '/api/me') {
      const acc = authUser(u.searchParams.get('token') || '');
      if (!acc) return send(res, 401, { error: '未登录' });
      return send(res, 200, { username: acc.username, name: acc.name });
    }
    if (req.method === 'POST' && p === '/api/me') {
      const b = await readBody(req);
      const acc = authUser(b.token);
      if (!acc) return send(res, 401, { error: '未登录' });
      const name = String(b.name || '').trim().slice(0, 12);
      if (name) { acc.name = name; saveAccounts(); }
      return send(res, 200, { ok: true, name: acc.name });
    }
    if (req.method === 'POST' && p === '/api/logout') {
      const b = await readBody(req);
      if (b.token && sessions[b.token]) { delete sessions[b.token]; saveSessions(); }
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/create') {
      const b = await readBody(req);
      const account = authUser(b.token);
      if (!account) return send(res, 401, { error: '请先登录' });
      const bookId = BOOKS.some((x) => x.id === b.bookId) ? b.bookId : BOOKS[0].id;
      const mode = b.mode === 'listen' ? 'listen' : 'word';
      const count = [10, 20, 30].includes(Number(b.count)) ? Number(b.count) : 10;
      const room = newRoom({ bookId, mode, count });
      const player = addPlayer(room, account.name || account.username, true, account.username);
      broadcast(room);
      return send(res, 200, { roomId: room.id, playerId: player.id });
    }
    if (req.method === 'POST' && p === '/api/join') {
      const b = await readBody(req);
      const room = rooms.get(String(b.roomId || '').trim().toUpperCase());
      if (!room) return send(res, 404, { error: '房间不存在，请检查房号' });
      const account = authUser(b.token);
      if (!account) return send(res, 401, { error: '请先登录' });
      if (room.phase !== 'lobby' && room.phase !== 'result') return send(res, 400, { error: '游戏进行中，请等本局结束后再加入' });
      if (room.players.size >= 5) return send(res, 400, { error: '房间已满（最多 5 人）' });
      const player = addPlayer(room, account.name || account.username, false, account.username);
      broadcast(room);
      return send(res, 200, { roomId: room.id, playerId: player.id });
    }
    if (req.method === 'GET' && p === '/api/stream') {
      const roomId = u.searchParams.get('roomId');
      const playerId = u.searchParams.get('playerId');
      const room = rooms.get(roomId);
      const player = room && room.players.get(playerId);
      if (!player) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('gone'); }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write('retry: 2000\n\n');
      player.res = res;
      room.emptySince = 0;
      clearInterval(player.ping);
      player.ping = setInterval(() => { if (!res.writableEnded && !res.destroyed) res.write(': ping\n\n'); }, 15000);
      // 连接建立后再广播一次：所有人（含刚加入者自己）的绿点状态立即正确
      broadcast(room);
      req.on('close', () => {
        clearInterval(player.ping);
        player.res = null;
        broadcast(room);
      });
      return;
    }
    /* 轮询兜底：某些网络（公司/校园网/部分代理）会缓冲 SSE 流，前端降级为定时拉取 */
    if (req.method === 'GET' && p === '/api/state') {
      const roomId = u.searchParams.get('roomId');
      const playerId = u.searchParams.get('playerId');
      const room = rooms.get(roomId);
      const player = room && room.players.get(playerId);
      if (!room || !player) return send(res, 404, { error: '房间不存在' });
      player.lastSeen = Date.now(); // 轮询也算在线（绿点 / 房间保活 / 提前公布答案）
      if (room.phase === 'question') player.seenInRound = true; // 本题期间见过，超时也记生词
      return send(res, 200, view(room, playerId));
    }
    if (req.method === 'POST' && p === '/api/start') {
      const b = await readBody(req);
      const room = rooms.get(b.roomId);
      const pl = room && room.players.get(b.playerId);
      if (!room || !pl) return send(res, 404, { error: '房间不存在' });
      if (!pl.isHost) return send(res, 403, { error: '只有房主可以开始游戏' });
      startGame(room);
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/answer') {
      const b = await readBody(req);
      const room = rooms.get(b.roomId);
      if (!room) return send(res, 404, { error: '房间不存在' });
      handleAnswer(room, b.playerId, Number(b.qIndex), Number(b.choice));
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/replay') {
      const b = await readBody(req);
      const room = rooms.get(b.roomId);
      const pl = room && room.players.get(b.playerId);
      if (!room || !pl) return send(res, 404, { error: '房间不存在' });
      if (!pl.isHost) return send(res, 403, { error: '只有房主可以再来一局' });
      startGame(room);
      return send(res, 200, { ok: true });
    }
    // ---------------- 账号个人生词本 ----------------
    if (req.method === 'GET' && p === '/api/mywords') {
      const acc = authUser(u.searchParams.get('token') || '');
      if (!acc) return send(res, 401, { error: '请先登录' });
      return send(res, 200, { words: acc.words || [], username: acc.username });
    }
    if (req.method === 'DELETE' && p === '/api/mywords') {
      const acc = authUser(u.searchParams.get('token') || '');
      if (!acc) return send(res, 401, { error: '请先登录' });
      if (!acc.words) acc.words = [];
      const word = String(u.searchParams.get('word') || '').trim();
      if (word) {
        const k = word.toLowerCase();
        acc.words = acc.words.filter((x) => String(x.word).toLowerCase() !== k);
      } else {
        acc.words = [];
      }
      saveAccounts();
      return send(res, 200, { ok: true, count: acc.words.length });
    }
    if (req.method === 'GET' && p === '/api/vocabtest/questions') {
      const questions = [];
      const candPool = shuffle(ALL_TIER_WORDS);
      let candIdx = 0;
      // 从候选池顺序取 need 个不同释义（不与正确释义重复）
      const nextDistract = (seen, need) => {
        const out = [];
        let guard = 0;
        while (out.length < need && guard < ALL_TIER_WORDS.length * 3) {
          const x = candPool[candIdx % ALL_TIER_WORDS.length];
          candIdx += 1;
          guard += 1;
          if (seen.has(x.meaning)) continue;
          seen.add(x.meaning);
          out.push(x.meaning);
        }
        return out;
      };
      for (let t = 0; t < TIERS.length; t++) {
        for (const w of shuffle(tierWords[t]).slice(0, Math.min(TIER_SAMPLE, tierWords[t].length))) {
          const seen = new Set([w.meaning]);
          const distract = nextDistract(seen, 3);
          const opts = shuffle([w.meaning, ...distract]);
          questions.push({ word: w.word, tier: t, options: opts, correctIndex: opts.indexOf(w.meaning) });
        }
      }
      return send(res, 200, {
        questions: shuffle(questions),
        tiers: TIERS.map((t, i) => ({ id: t.id, name: t.name, size: TIER_SIZES[i] })),
      });
    }
    if (req.method === 'POST' && p === '/api/vocabtest/submit') {
      const b = await readBody(req);
      const acc = authUser(b.token);
      const name = acc ? acc.username : String(b.name || '').trim().slice(0, 12);
      if (!name) return send(res, 400, { error: '请先登录' });
      const answers = Array.isArray(b.answers) ? b.answers : [];
      const estimates = TIERS.map((t, i) => {
        const c = Math.max(1, Number(b.counts && b.counts[i]) || 0);
        let s = 0;
        for (const a of answers) {
          if (Number(a.tier) !== i) continue;
          const cr = Number(a.credit);
          s += cr === 0.5 ? 0.5 : (cr > 0 ? 1 : 0);
        }
        return Math.round((s / c) * TIER_SIZES[i]);
      });
      const estimate = estimates.reduce((x, y) => x + y, 0);
      const now = Date.now();
      const key = name.toLowerCase();
      const idx = vocabRank.findIndex((x) => x.name.toLowerCase() === key);
      if (idx >= 0) {
        const e = vocabRank[idx];
        e.best = Math.max(e.best || 0, estimate);
        e.latest = estimate;
        e.count = (e.count || 0) + 1;
        e.at = now;
      } else {
        vocabRank.push({ name, best: estimate, latest: estimate, count: 1, at: now });
      }
      vocabRank.sort((a, b2) => b2.best - a.best || a.at - b2.at);
      if (vocabRank.length > 200) vocabRank.length = 200;
      saveJSON(RANK_FILE, vocabRank);
      return send(res, 200, {
        ok: true,
        estimate,
        estimates: estimates.map((v, i) => ({ tier: TIERS[i].name, value: v })),
      });
    }
    if (req.method === 'GET' && p === '/api/vocabrank') {
      const list = vocabRank.map((x, i) => ({ rank: i + 1, name: x.name, best: x.best, latest: x.latest, count: x.count, at: x.at }));
      const acc = authUser(u.searchParams.get('token') || '');
      const myName = acc ? acc.username : String(u.searchParams.get('name') || '').trim();
      let you = null;
      if (myName) {
        const i = vocabRank.findIndex((x) => x.name.toLowerCase() === myName.toLowerCase());
        if (i >= 0) you = { rank: i + 1, name: vocabRank[i].name, best: vocabRank[i].best, latest: vocabRank[i].latest, count: vocabRank[i].count, at: vocabRank[i].at };
      }
      return send(res, 200, { list, you });
    }
    /* ---------------- 背单词：学习计划 / 出题 / 作答 / 统计 ---------------- */
    if (req.method === 'GET' && p === '/api/study/overview') {
      const acc = authUser(u.searchParams.get('token') || '');
      if (!acc) return send(res, 401, { error: '请先登录' });
      return send(res, 200, studyOverview(acc));
    }
    if (req.method === 'POST' && p === '/api/study/plan') {
      const b = await readBody(req);
      const acc = authUser(b.token);
      if (!acc) return send(res, 401, { error: '请先登录' });
      const st = getStudy(acc);
      const bookId = BOOKS.some((x) => x.id === b.bookId) ? b.bookId : (st.plan && st.plan.bookId) || BOOKS[0].id;
      const dailyNew = [10, 20, 30, 50, 100].includes(Number(b.dailyNew)) ? Number(b.dailyNew) : (st.plan && st.plan.dailyNew) || 20;
      let vocabEstimate = Math.max(0, Math.min(30000, Math.round(Number(b.vocabEstimate) || 0)));
      st.plan = {
        bookId, dailyNew, vocabEstimate,
        autoSpeak: b.autoSpeak === undefined ? (st.plan ? st.plan.autoSpeak !== false : true) : b.autoSpeak !== false,
      };
      saveAccounts();
      const book = BOOKS.find((x) => x.id === bookId);
      const { skipped } = filterKnown(book, vocabEstimate);
      return send(res, 200, { ok: true, plan: st.plan, skipped, total: book.words.length - skipped, bookName: book.name });
    }
    if (req.method === 'GET' && p === '/api/study/session') {
      const acc = authUser(u.searchParams.get('token') || '');
      if (!acc) return send(res, 401, { error: '请先登录' });
      const st = getStudy(acc);
      if (!st.plan) return send(res, 400, { error: '请先设置学习计划' });
      const book = BOOKS.find((x) => x.id === st.plan.bookId) || BOOKS[0];
      const mode = u.searchParams.get('mode') === 'unit' ? 'unit' : (u.searchParams.get('mode') === 'review' ? 'review' : 'daily');
      const now = Date.now();
      let queue = [];
      let extra = {};
      if (mode === 'review') {
        const words = (acc.words || []).slice(0, 100); // 生词本复习：最近答错在前
        queue = words.map((x) => ({ word: x.word, meaning: x.meaning }));
        extra = { wrongCount: (acc.words || []).length };
      } else if (mode === 'unit') {
        const unit = Math.max(0, Number(u.searchParams.get('unit')) || 0);
        const { list } = filterKnown(book, st.plan.vocabEstimate);
        const maxUnit = Math.max(0, Math.ceil(list.length / UNIT_SIZE) - 1);
        if (unit > maxUnit) return send(res, 400, { error: '单元不存在' });
        const seg = list.slice(unit * UNIT_SIZE, (unit + 1) * UNIT_SIZE);
        queue = seg.map((w) => ({ word: w.word, meaning: w.meaning }));
        extra = { unit, unitTotal: seg.length };
      } else {
        const { list } = filterKnown(book, st.plan.vocabEstimate);
        const lg = todayLog(st);
        const newRemaining = Math.max(0, st.plan.dailyNew - lg.new);
        const news = list.filter((w) => { const pr = st.progress[w.posKey]; return !pr || !pr.n; }).slice(0, newRemaining);
        const dueList = [];
        for (const [k, pr] of Object.entries(st.progress)) {
          if (!pr || !pr.n || pr.lv <= 0 || pr.lv >= MASTER_LV || !pr.due || pr.due > now) continue;
          const info = WORD_INFO.get(k);
          if (info) dueList.push({ word: info.word, meaning: info.meaning, due: pr.due });
        }
        dueList.sort((a, c) => a.due - c.due);
        const reviews = dueList.slice(0, 100);
        queue = news.map((w) => ({ word: w.word, meaning: w.meaning, isNew: true }))
          .concat(reviews.map((r) => ({ word: r.word, meaning: r.meaning, isNew: false })));
        extra = { newCount: news.length, reviewCount: reviews.length, dailyNew: st.plan.dailyNew };
      }
      const questions = queue.map((q) => Object.assign(genStudyQuestion(q, book), { isNew: q.isNew !== false && !!q.isNew }));
      return send(res, 200, Object.assign({ mode, questions, bookName: book.name, plan: st.plan }, extra));
    }
    if (req.method === 'POST' && p === '/api/study/answer') {
      const b = await readBody(req);
      const acc = authUser(b.token);
      if (!acc) return send(res, 401, { error: '请先登录' });
      if (!b.word) return send(res, 400, { error: '缺少单词' });
      return send(res, 200, studyAnswer(acc, b.word, !!b.correct));
    }
    if (req.method === 'POST' && p === '/api/study/reset') {
      const b = await readBody(req);
      const acc = authUser(b.token);
      if (!acc) return send(res, 401, { error: '请先登录' });
      if (b.scope === 'all') acc.study = { plan: null, progress: {}, log: {} };
      else if (b.scope === 'plan') { const st = getStudy(acc); st.plan = null; }
      else { const st = getStudy(acc); st.progress = {}; st.log = {}; } // scope=progress
      saveAccounts();
      return send(res, 200, { ok: true });
    }
    return serveStatic(req, res);
  } catch (e) {
    send(res, 500, { error: String(e && e.message || e) });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  const onCloud = process.env.RENDER || process.env.RAILWAY || process.env.KOYEB || process.env.VERCEL || process.env.PORT;
  const externalUrl = process.env.RENDER_EXTERNAL_URL || process.env.RAILWAY_PUBLIC_DOMAIN || process.env.KOYEB_APP_PUBLIC_DOMAIN || '';
  const ips = lanIPs();
  console.log('====================================');
  console.log('  单词PK · 词汇对战已启动');
  console.log('====================================');
  if (onCloud) {
    if (externalUrl) console.log('  公网地址:  https://' + externalUrl);
    console.log('  监听端口:  ' + PORT);
    console.log('  环境:      云端部署');
  } else {
    console.log('  本机访问:  http://localhost:' + PORT);
    for (const ip of ips) console.log('  局域网:    http://' + ip + ':' + PORT);
    if (!ips.length) console.log('  (未检测到局域网 IP，其他设备可能无法访问)');
    console.log('------------------------------------');
    console.log('  · 同一 WiFi 的设备可直接打开局域网地址');
    console.log('  · 公网玩家请通过隧道地址访问（start-online.bat）');
  }
  console.log('====================================');
});
