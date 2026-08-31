/*
 * 胖虎单词PK · 背单词与单词对战服务器（局域网 / 公网均可）
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
const net = require('net');
const tls = require('tls');

const PORT = process.env.PORT || 3000;
const PUB = path.join(__dirname, 'public');
const BOOKS = JSON.parse(fs.readFileSync(path.join(PUB, 'data', 'books.json'), 'utf8'));

const QUESTION_MS = { word: 12000, listen: 15000 }; // 每题作答时长
const REVEAL_MS = 2000;                             // 答案公布停留时长（最后一人答完快速进入下一题）
const ROOM_EMPTY_TTL = 5 * 60 * 1000;               // 空房间保留时长
const ONLINE_WINDOW = 12 * 1000;                    // 最近 12 秒内有 SSE 或轮询即视为在线
const APP_VERSION = '1.4.11';                       // 部署版本号：经 /api/diag 与前端页脚展示，便于确认「更新是否生效」

/* 词条预处理：从释义中剥离词性前缀，得到纯中文释义 + 词性分组。
 * 词性可能是组合形式：vi&n / vt&vi&n / n & adj / prep&adv 等（books.json 里共 1265 条）。
 * 旧正则只认单个词性（v. / n.），导致「vi&n 拖欠，违约」被拆成 pos=空、def="vi&n 拖欠，违约"，
 * 既污染详情弹窗展示，又让跨词书的近义去重失效——default 因此刷出两条近义（已报 bug）。
 * 这里把 & 组合整体识别为词性前缀。 */
const POS_BASE = 'n|v|adj|adv|prep|conj|pron|num|int|art|aux|vt|vi|abbr';
const POS_RE = new RegExp('^(' + POS_BASE + ')\\.?(\\s*&\\s*(' + POS_BASE + ')\\.?)*[\\s]+', 'i');
const POS_ONLY = new RegExp('^\\s*(' + POS_BASE + ')\\.?(\\s*&\\s*(' + POS_BASE + ')\\.?)*\\s*$', 'i');
/* 反复剥离开头的词性前缀（处理 "n n." / "aux v" 这类脏数据，避免残留 "n." 混入选项） */
function stripPos(t) {
  let s = t;
  while (true) {
    const mm = s.match(POS_RE);
    if (!mm) break;
    const rest = s.slice(mm[0].length).trim();
    if (!rest) break;
    s = rest;
  }
  return s;
}
function splitMeaning(raw) {
  const segs = String(raw).split(/\s*\/\s*/).map((s) => s.trim()).filter(Boolean);
  const first = segs[0] || '';
  const m = first.match(POS_RE);
  const pos = m ? m[1].toLowerCase() : '';
  const cleanSegs = [];
  for (const s of segs) {
    const t = stripPos(s);
    if (!t || POS_ONLY.test(t)) continue; // 去掉纯词性标注的段
    cleanSegs.push(t);
  }
  let clean = cleanSegs.join(' / ');
  if (!clean) {
    // 兜底：整串去词性前缀，再滤掉纯词性残段
    clean = String(raw).replace(new RegExp(POS_RE.source, 'gi'), '')
      .split(' / ').map((x) => x.trim()).filter((x) => x && !POS_ONLY.test(x)).join(' / ');
  }
  return { pos, clean: clean || String(raw) };
}
/* 释义是否有效：非空且非纯词性标注（"n." / "v" / "aux" 等） */
function isValidMeaning(m) {
  if (!m || typeof m !== 'string') return false;
  const s = String(m).trim();
  if (!s) return false;
  if (POS_ONLY.test(s)) return false;
  return true;
}
for (const b of BOOKS) {
  b._words = b.words
    .map(([word, meaning]) => {
      const { pos, clean } = splitMeaning(meaning);
      return { word, meaning: clean, pos };
    })
    .filter((w) => isValidMeaning(w.meaning)); // 过滤脏数据词条（如 "n n."），避免它们作为题目或干扰项
  b._byPos = new Map();
  for (const w of b._words) {
    if (!b._byPos.has(w.pos)) b._byPos.set(w.pos, []);
    b._byPos.get(w.pos).push(w);
  }
}

/* 单词对战默认词书 & 「简单词」剔除集合
 * - DEFAULT_PK_BOOK：对战默认词书改为托福（toefl，9212 词），而非 toefl-core（2562）。
 * - FOUNDATION_BOOK_IDS：一个 4000+ 词汇量玩家早已掌握的入门词书（中考/高考/四级/四级核心）。
 *   生成【非基础词书】的 PK 题库时，剔除这些「简单词」，让题目聚焦在更难、更值得练的词上；
 *   基础词书本身（用户明确选了入门词书）则保留全部词，照常出题。 */
const DEFAULT_PK_BOOK = 'toefl';
const FOUNDATION_BOOK_IDS = ['zhongkao', 'gaokao', 'cet4', 'cet4-core'];
const KNOWN_SIMPLE_WORDS = new Set();
for (const fid of FOUNDATION_BOOK_IDS) {
  const fb = BOOKS.find((x) => x.id === fid);
  if (fb) for (const w of fb._words) KNOWN_SIMPLE_WORDS.add(String(w.word || '').toLowerCase());
}

/* ---------------- 持久化存储（生词本 / 词汇量排行） ---------------- */
/* STORE_DIR 环境变量可指定数据目录（用于 Render 挂载持久磁盘）；默认用代码目录下的 store/ */
const STORE = process.env.STORE_DIR ? path.resolve(process.env.STORE_DIR) : path.join(__dirname, 'store');
if (!fs.existsSync(STORE)) fs.mkdirSync(STORE, { recursive: true });
const RANK_FILE = path.join(STORE, 'vocab-rank.json');
const ACCOUNTS_FILE = path.join(STORE, 'accounts.json');
const SESSIONS_FILE = path.join(STORE, 'sessions.json');
const GROUPS_FILE = path.join(STORE, 'groups.json');
/* loadJSON：主文件坏了绝不静默清零——先把坏文件改名留档，再回退 .bak，最后才用默认值（D2） */
function loadJSON(f, dflt) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) {
    if (e && e.code === 'ENOENT') return dflt;
    try {
      const bad = f + '.corrupt-' + Date.now();
      fs.renameSync(f, bad);
      console.error('[存储] 数据文件损坏，已留档为 ' + path.basename(bad) + '，尝试回退备份');
    } catch (e2) {}
    try { return JSON.parse(fs.readFileSync(f + '.bak', 'utf8')); } catch (e3) { return dflt; }
  }
}
/* saveJSON：原子写（临时文件 + rename），写前把上一份好数据留为 .bak。
   直接 writeFileSync 在进程被 kill / 磁盘写满时会产生半截 JSON，下次启动 loadJSON 解析失败
   就等于「所有账号数据凭空消失」；原子写 + 备份让最坏情况只丢失最后一次保存（D2）。 */
function saveJSON(f, data, replacer) {
  let str;
  try { str = JSON.stringify(data, replacer || null); } catch (e) { console.error('[存储] 序列化失败', f, (e && e.message) || e); return; }
  const tmp = f + '.tmp-' + process.pid;
  try {
    fs.writeFileSync(tmp, str, 'utf8');
    try { if (fs.existsSync(f)) fs.copyFileSync(f, f + '.bak'); } catch (e) {}
    fs.renameSync(tmp, f);
  } catch (e) {
    console.error('[存储] 保存失败', f, (e && e.message) || e);
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e2) {}
  }
}

/* ---- 可选云端持久化（Upstash Redis REST）：解决 Render 免费版每次部署/重启清空本地磁盘、
   导致账号与生词本全部丢失的问题。配置 UPSTASH_REDIS_REST_URL 与 UPSTASH_REDIS_REST_TOKEN
   两个环境变量即自动启用；未配置时退回纯本地文件模式（行为与之前完全一致）。 ---- */
const UPSTASH_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const KV_ON = !!(UPSTASH_URL && UPSTASH_TOKEN && typeof fetch === 'function');
const KV_PREFIX = 'vocabpk:v1:';
/* ---- 实例租约：防止「旧实例用陈旧内存数据回写云端」覆盖新实例的数据（部署丢数据主因之一）。
   每个实例启动后把自己的 id 写进 __lease__；退出（SIGTERM）时先读租约，若已被新实例接管，
   则【绝不】回写——因为旧实例内存里是它启动那一刻的陈旧快照，写回去会抹掉新数据。
   只在能【明确读到】别实例的租约时才让位；读不到（网络抖动）时保持「我仍是主」，
   避免因一次抖动就彻底不写云端。 ---- */
const INSTANCE_ID = Math.random().toString(36).slice(2, 10) + '-' + Date.now().toString(36);
let leaseOwner = true;
/* kvUsable：云端是否可写。KV_ON 仅表示「已配置凭据」。 */
let kvUsable = KV_ON;
let kvLastError = null;    // 最近一次云端错误（供 /api/storage-status 诊断）
let kvLastWriteAt = 0;
/* ===== 作者反馈（文字 + 截图）=====
 * 用户在软件里填表提交后，自动发邮件到作者邮箱（默认 lizigui321@gmail.com）。
 * 邮件发送走 Node 内置 tls 模块实现的极简 SMTP 客户端，零依赖；凭据通过环境变量注入，绝不写进代码。
 * 未配置 SMTP 时，反馈仍会写入本地 feedback.jsonl（兜底，绝不丢），只是不发邮件。
 * 渲染端 Render 上需设置：SMTP_USER / SMTP_PASS（Gmail 用「应用专用密码」）/ 可选 SMTP_HOST SMTP_PORT SMTP_SECURE / FEEDBACK_TO / FEEDBACK_ADMIN_TOKEN（用于后台查看反馈列表）。 */
const FEEDBACK_TO = process.env.FEEDBACK_TO || 'lizigui321@gmail.com';
const FEEDBACK_DIR = path.join(STORE, 'feedback');
const FEEDBACK_ADMIN_TOKEN = process.env.FEEDBACK_ADMIN_TOKEN || '';
const SMTP = {
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT || '465', 10) || 465,
  user: process.env.SMTP_USER || '',
  pass: process.env.SMTP_PASS || '',
  from: process.env.FEEDBACK_FROM || process.env.SMTP_USER || '',
};
const SMTP_SECURE = process.env.SMTP_SECURE ? (process.env.SMTP_SECURE === 'true') : (SMTP.port === 465);
const SMTP_READY = !!(SMTP.user && SMTP.pass);
let kvRateLimitedAt = 0;   // 最近一次被 Upstash 限流(429)的时刻
let kvRateWarned = false;  // 限流告警只打一次，避免刷屏
const kvWriteQueue = [];   // 写入失败的重试队列（网络抖动不再静默丢数据）
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
/* 统一带超时的 fetch：Upstash 偶发慢响应/挂起时不能把启动流程卡死（原实现无超时 = 可能永久挂起） */
function kvFetch(url, opts, ms) {
  const ctrl = (typeof AbortController === 'function') ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, ms || 6000) : null;
  return Promise.race([
    fetch(url, Object.assign({}, opts, ctrl ? { signal: ctrl.signal } : {})),
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), (ms || 6000) + 800)),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}
async function kvGetOnce(key, ms) {
  try {
    const r = await kvFetch(UPSTASH_URL + '/get/' + encodeURIComponent(KV_PREFIX + key),
      { headers: { Authorization: 'Bearer ' + UPSTASH_TOKEN } }, ms || 6000);
    if (!r.ok) return { ok: false, error: 'http_' + r.status };
    const d = await r.json().catch(() => ({}));
    if (d.result == null) return { ok: true, found: false, value: null };
    /* 反序列化后再兜一层：
       历史数据曾用「双重序列化」写入（JSON.stringify(JSON.stringify(data))），
       取回来 parse 一次后仍是【字符串】，导致上层 typeof value === 'object' 判 false 而整批跳过
       —— 这正是「每次更新后所有账号都不见了」的根因。这里多 parse 一层，
       既能正确读出新格式，也能把云端已存在的旧格式数据救回来。 */
    try {
      let v = JSON.parse(d.result);
      if (typeof v === 'string') {
        try { v = JSON.parse(v); } catch (e2) { /* 本身就是普通字符串值，保持原样 */ }
      }
      return { ok: true, found: true, value: v };
    } catch (e) { return { ok: true, found: true, value: null }; }
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}
/* 读取带指数退避重试（默认 3 次）：一次网络抖动不再导致「整进程永久降级为本地文件模式 →
   Render 清盘 → 数据全丢」。这是「明明做了处理却每次更新都丢」的根因。 */
async function kvGet(key, tries, ms) {
  const n = tries || 3;
  let last = { ok: false, error: 'unknown' };
  for (let i = 0; i < n; i++) {
    last = await kvGetOnce(key, ms);
    if (last.ok) { kvLastError = null; return last; }
    kvLastError = last.error;
    if (i < n - 1) await sleep(400 * Math.pow(2, i));
  }
  return last;
}
async function kvSetOnce(key, data) {
  try {
    const r = await kvFetch(UPSTASH_URL + '/set/' + encodeURIComponent(KV_PREFIX + key), {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + UPSTASH_TOKEN, 'Content-Type': 'application/json' },
      // 只序列化一次：Upstash 按原样保存字符串，读取时 parse 一次即可还原对象。
      // （此前写成 JSON.stringify(JSON.stringify(data))，多套了一层，读回来是字符串而非对象）
      body: JSON.stringify(data),
    }, 8000);
    if (!r.ok) {
      kvLastError = 'http_' + r.status;
      // 429 = Upstash 免费额度限流。此时绝不能立刻重试，否则会雪上加霜，
      // 把真正重要的账号/进度写入也一起拖垮（表现为更新后账号失效）。
      if (r.status === 429) {
        kvRateLimitedAt = Date.now();
        if (!kvRateWarned) {
          kvRateWarned = true;
          console.error('[KV] ⚠️ 触发 Upstash 限流(429)：已暂停重试以节省额度，账号写入转入队列稍后补写');
        }
      }
      return false;
    }
    if (kvRateLimitedAt && Date.now() - kvRateLimitedAt > 60000) { kvRateLimitedAt = 0; kvRateWarned = false; }
    kvLastError = null; kvLastWriteAt = Date.now();
    return true;
  } catch (e) { kvLastError = String((e && e.message) || e); return false; }
}
/* 写入带重试 + 失败入队（后台定时重放）：抖动/限流不再静默丢数据 */
async function kvSet(key, data) {
  if (!kvUsable) return;
  // 正在被限流时不再原地重试（重试只会加剧限流），直接入队，交给后台慢慢补写
  const limited = kvRateLimitedAt && (Date.now() - kvRateLimitedAt < 60000);
  const tries = limited ? 1 : 3;
  for (let i = 0; i < tries; i++) {
    if (await kvSetOnce(key, data)) { kvLastWriteAt = Date.now(); return; }
    if (i < tries - 1) await sleep(400 * Math.pow(2, i));
  }
  console.error('[KV] 写入失败，已入队待重试:', key, kvLastError);
  for (let j = kvWriteQueue.length - 1; j >= 0; j--) if (kvWriteQueue[j].key === key) kvWriteQueue.splice(j, 1);
  kvWriteQueue.push({ key: key, data: data, at: Date.now() });
  if (kvWriteQueue.length > 40) kvWriteQueue.splice(0, kvWriteQueue.length - 40);
}
/* 后台重放失败写入；30 分钟仍失败则丢弃，避免无限堆积 */
setInterval(async () => {
  if (!kvUsable || !kvWriteQueue.length) return;
  const item = kvWriteQueue[0];
  if (await kvSetOnce(item.key, item.data)) { kvWriteQueue.shift(); console.log('[KV] 重试写入成功:', item.key); }
  else if (Date.now() - item.at > 30 * 60 * 1000) { kvWriteQueue.shift(); console.error('[KV] 放弃重试:', item.key); }
}, 20000);
const kvTimers = {};
/* 防抖合并：一次答题/操作只触发一次网络写。注意把 data 一并保存在定时器里，
   这样退出前 flush 的是「保存时刻」的快照，而不是进程退出时的全局变量（旧实例的全局
   可能还是它启动那一刻的陈旧数据，见 S1）。 */
function kvSave(key, data) {
  if (!kvUsable || !leaseOwner) return;
  if (kvTimers[key]) clearTimeout(kvTimers[key].t);
  kvTimers[key] = { t: setTimeout(() => { delete kvTimers[key]; kvSet(key, data); }, 400), data };
}
let vocabRank = loadJSON(RANK_FILE, []);     // [{name, best, latest, count, at}] 词汇量排行
let accounts = loadJSON(ACCOUNTS_FILE, {});  // username(小写) -> {username, salt, hash, name, createdAt, words:[{word,meaning,book,at}]}
let sessions = loadJSON(SESSIONS_FILE, {});  // token -> {username, at}
let groups = loadJSON(GROUPS_FILE, {});      // groupId -> {id, name, owner, members:[username], code, createdAt}
function saveAccounts(){ saveJSON(ACCOUNTS_FILE, accounts, accountsReplacer); kvSave('accounts', accounts); }
function saveSessions(){ saveJSON(SESSIONS_FILE, sessions); kvSave('sessions', sessions); }
function saveGroups(){ saveJSON(GROUPS_FILE, groups); kvSave('groups', groups); }
function saveRank(){ saveJSON(RANK_FILE, vocabRank); kvSave('vocab-rank', vocabRank); }
/* 序列化账号时剔除运行时字段（__rt 里的 Map / 自定义词书的 _words 缓存等），
   避免把几 MB 的运行时缓存写进 accounts.json / 云端 KV，也避免反序列化出脏数据（D1） */
function accountsReplacer(k, v) {
  if (k === '__rt') return undefined;
  if (k && typeof k === 'string' && (k === '_words' || k === '_byPos' || k === '_studyOrder')) return undefined;
  return v;
}
/* 启动时：启用云端持久化则以云端数据为准（本地文件在 Render 上部署即被清空）；
   云端为空（首次启用）时把本地现有数据上传，完成无缝迁移。 */
async function loadStoreFromKVOnce() {
  if (!KV_ON) return false;
  try {
    const [kAcc, kSes, kGrp, kRk] = await Promise.all([
      kvGet('accounts'), kvGet('sessions'), kvGet('groups'), kvGet('vocab-rank'),
    ]);
    /* S2：任意一项拉取失败（网络超时/5xx/DNS），一律视为「云端不可用」，
       严禁用本地（可能是几天前的）数据覆盖云端 → 降级为本地文件模式。 */
    if (!kAcc.ok || !kSes.ok || !kGrp.ok || !kRk.ok) {
      kvUsable = false;
      const err = (kAcc.error || kSes.error || kGrp.error || kRk.error || 'unknown');
      console.log('  存储模式:  本地文件（云端拉取失败，已禁止本地数据回灌覆盖云端：' + err + '）');
      return false;
    }
    let migrated = false;
    if (kAcc.found && kAcc.value && typeof kAcc.value === 'object') accounts = kAcc.value;
    else if (!kAcc.found && Object.keys(accounts).length) { kvSet('accounts', accounts); migrated = true; }
    if (kSes.found && kSes.value && typeof kSes.value === 'object') sessions = kSes.value;
    else if (!kSes.found && Object.keys(sessions).length) { kvSet('sessions', sessions); migrated = true; }
    if (kGrp.found && kGrp.value && typeof kGrp.value === 'object') groups = kGrp.value;
    else if (!kGrp.found && Object.keys(groups).length) { kvSet('groups', groups); migrated = true; }
    if (kRk.found && Array.isArray(kRk.value)) vocabRank = kRk.value;
    else if (!kRk.found && vocabRank.length) { kvSet('vocab-rank', vocabRank); migrated = true; }

    /* S4 自愈：四项里任何一项在云端为空，先尝试用云端「全量快照」补回。
       场景：某次写入只成功了一半、或有人在 Upstash 控制台误删了某个 key。
       只有在快照里确实有数据时才回填，绝不拿空数据覆盖已有内容。 */
    let healed = false;
    const emptyAcc = !Object.keys(accounts).length;
    const emptyGrp = !Object.keys(groups).length;
    if (emptyAcc || emptyGrp) {
      const full = await kvGet('__full__');
      if (full.ok && full.found && full.value && typeof full.value === 'object') {
        const f = full.value;
        if (emptyAcc && f.accounts && Object.keys(f.accounts).length) { accounts = f.accounts; kvSet('accounts', accounts); healed = true; }
        if (!Object.keys(groups).length && f.groups && Object.keys(f.groups).length) { groups = f.groups; kvSet('groups', groups); healed = true; }
        if (!vocabRank.length && Array.isArray(f.vocabRank) && f.vocabRank.length) { vocabRank = f.vocabRank; kvSet('vocab-rank', vocabRank); healed = true; }
        if (!Object.keys(sessions).length && f.sessions && Object.keys(f.sessions).length) { sessions = f.sessions; kvSet('sessions', sessions); healed = true; }
      }
    }
    /* 本地文件也为空（Render 每次部署清盘）而云端没有账号 → 用本地快照兜底再上传一次 */
    if (!Object.keys(accounts).length) restoreFromSnapshot();

    saveJSON(ACCOUNTS_FILE, accounts, accountsReplacer); saveJSON(SESSIONS_FILE, sessions); saveJSON(GROUPS_FILE, groups); saveJSON(RANK_FILE, vocabRank);
    /* 写完再存一份全量快照，作为下次出问题的恢复源 */
    kvSet('__full__', { accounts: accounts, groups: groups, sessions: sessions, vocabRank: vocabRank, at: Date.now() });
    console.log('  存储模式:  Upstash Redis 云端持久化（账号/生词本跨部署不丢失）' + (migrated ? ' · 已完成本地→云端首次迁移' : '') + (healed ? ' · 已用云端全量快照自愈' : ''));
    return true;
  } catch (e) {
    kvUsable = false;
    console.log('  存储模式:  本地文件（云端拉取异常，已禁止本地数据回灌覆盖云端：' + ((e && e.message) || e) + '）');
    return false;
  }
}
/* 启动加载（带重试）：以前只读 1 次，失败就永久降级本地文件模式；Render 每次部署清空磁盘，
   只要这一次读取抖动，整轮部署的数据就全没了 —— 这正是「明明做了处理却每次更新都丢」的根因。
   现在最多重试 3 轮（约 12s），覆盖 Upstash 冷启动 / 瞬时 5xx / 网络抖动。 */
async function loadStoreFromKV() {
  if (!KV_ON) return false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const okLoaded = await loadStoreFromKVOnce();
    if (okLoaded) return true;
    if (attempt < 3) {
      console.log('[存储] 云端读取失败（' + kvLastError + '），' + (attempt * 3) + 's 后重试 ' + attempt + '/3 …');
      await sleep(attempt * 3000);
    }
  }
  return false;
}
/* 租约：启动成功接管云端后登记本实例；退出前据此判断能否回写 */
async function kvTakeLease() {
  if (!kvUsable) return;
  await kvSetOnce('__lease__', { id: INSTANCE_ID, at: Date.now() });
  leaseOwner = true;
}
/* 云端恢复看门狗：启动时若因网络抖动降级为本地模式，持续在后台探测；
   一旦连通，把降级期间本地产生的数据【安全合并】回云端——
   只补充云端没有的账号，云端已有的【一律保留云端版本】，绝不覆盖。
   这样即便 KV 短暂抽风，用户数据也不会因为「降级期间注册的账号随清盘消失」而丢失。 */
function startKvRecoveryWatchdog() {
  if (!KV_ON || kvUsable) return;
  let tries = 0;
  const timer = setInterval(async () => {
    if (kvUsable) { clearInterval(timer); return; }
    tries += 1;
    const probe = await kvGet('accounts', 1, 8000);
    if (!probe.ok) {
      if (tries % 10 === 0) console.log('[存储] 云端仍不可用（已重试 ' + tries + ' 次）：' + probe.error);
      return;
    }
    clearInterval(timer);
    const cloud = (probe.found && probe.value && typeof probe.value === 'object') ? probe.value : {};
    let added = 0, kept = 0;
    for (const [k, v] of Object.entries(accounts)) {
      if (cloud[k]) { kept += 1; continue; } // 云端已有 → 保留云端版本，绝不覆盖
      cloud[k] = v; added += 1;
    }
    // 云端有、本地没有（降级期间别人注册的）→ 以云端为准拉回来
    let pulled = 0;
    for (const [k, v] of Object.entries(cloud)) { if (!accounts[k]) { accounts[k] = v; pulled += 1; } }
    kvUsable = true;
    saveAccounts();
    await kvTakeLease();
    console.log('[存储] ✅ 云端已恢复（第 ' + tries + ' 次重试成功）：补充本地 ' + added +
      ' 个账号 · 保留云端 ' + kept + ' 个 · 拉回云端新增 ' + pulled + ' 个');
  }, 30000);
}
/* 退出前确认租约：只有「租约仍属于自己」才允许回写；已被新实例接管则绝不回写 */
async function kvStillOwner() {
  if (!kvUsable) return false;
  const cur = await kvGet('__lease__', 2);
  if (cur.ok && cur.found && cur.value && cur.value.id && cur.value.id !== INSTANCE_ID) return false;
  return true; // 读不到/读失败时按「仍是主」处理，避免抖动导致完全不写
}
/* 进程退出前（Render 部署时会发 SIGTERM）：只把「仍在防抖队列里、代表最新一次保存动作」
   的写入落盘，绝不把进程当前的全局变量整库覆盖写回云端。
   原因（S1）：部署时新旧实例并存，旧实例内存里是它启动那一刻的陈旧快照；若把这份全局变量
   整库回写，会抹掉部署窗口内新实例产生的所有注册/学习/生词本变动。这里只 flush 真正的
   挂起写入（数据在保存那一刻就已捕获在定时器里），旧实例若无新请求则队列为空、什么都不写。 */
/* 摘下挂起写入并停掉防抖定时器（必须先做，否则租约判定期间定时器会抢先写入陈旧数据） */
function kvTakePending() {
  const pending = [];
  for (const k of Object.keys(kvTimers)) {
    clearTimeout(kvTimers[k].t);
    pending.push({ key: k, data: kvTimers[k].data });
    delete kvTimers[k];
  }
  return pending;
}
async function kvFlush(pending) {
  const writes = (pending || []).map((p) => kvSet(p.key, p.data));
  if (!writes.length) return;
  try {
    await Promise.race([
      Promise.all(writes),
      new Promise((_, rej) => setTimeout(() => rej(new Error('kvFlush 超时')), 8000)),
    ]);
  } catch (e) { console.error('[KV] 退出前刷新失败', (e && e.message) || e); }
}
/* 退出前留一点时间让 stdout 刷完：管道输出在 process.exit() 时可能被截断，
   导致部署日志里看不到存储模式等关键信息（排查「数据去哪了」时最需要这些日志）。 */
function exitAfterFlush(code) { setTimeout(() => process.exit(code), 60); }
async function gracefulShutdown(sig) {
  // 退出前先刷新今日快照（此时内存里有最新数据），再处理云端写入（D3）
  try { writeSnapshot(); } catch (e) {}
  // 1) 先摘下挂起写入，防止判定租约的几百毫秒里防抖定时器抢先把陈旧数据写出去
  const pending = kvTakePending();
  if (!pending.length) { exitAfterFlush(0); return; }
  // 2) 关键：确认自己仍是云端租约持有者。若新实例已接管（部署场景），本实例内存里是
  //    启动那一刻的陈旧快照，此时回写会把部署窗口内新实例产生的数据全部抹掉 —— 宁可不写。
  const owner = await kvStillOwner();
  if (!owner) {
    console.log('[存储] 检测到新实例已接管云端，放弃本次退出回写（保护新数据不被陈旧快照覆盖）');
    exitAfterFlush(0);
    return;
  }
  await kvFlush(pending);
  exitAfterFlush(0);
}
process.on('SIGTERM', () => { gracefulShutdown('SIGTERM').catch(() => process.exit(0)); });
process.on('SIGINT', () => { gracefulShutdown('SIGINT').catch(() => process.exit(0)); });
/* beforeExit 兜底：进程正常退出（无 SIGTERM，如脚本结束）时也要把挂起的云端写入落盘 */
process.on('beforeExit', () => { if (kvUsable && Object.keys(kvTimers).length) kvFlush(kvTakePending()); });

/* ================= 单词词典（音标 / 释义 / 例句 / 搭配） =================
 * 数据来源（服务端拉取，避免浏览器直连被 CORS / 网络策略拦掉）：
 *   1) 有道词典公开 JSON 接口 —— 国内可直连，含英美音标、分词性释义、变形、短语、双语例句
 *   2) dictionaryapi.dev —— 海外环境更稳，含标准 IPA 与真人音频，作为补充/兜底
 * 结果落盘到 store/dict.json 长期缓存（词表有限，命中后几乎零延迟）。
 */
const DICT_FILE = path.join(STORE, 'dict.json');
const DICT_MAX = 3000;                 // 缓存上限，超出后按时间淘汰最早的一半
/* 释义缓存结构版本号。改动释义的解析/去重规则时必须 +1：
   否则磁盘里旧版缓存会被原样读回，新的去重规则根本不会生效，
   用户看到的是「明明修了却还是一堆近义项」（这个坑踩过一次）。
   启动时会自动丢弃版本不符的旧条目，让它们按新规则重新生成。 */
const DICT_VER = 5; // 5: books.json 再修正 9 处释义互换（interact/enthusiasm/unconscious/offer/lock/as/comprise/stereotype/conversely 错用他词释义），淘汰旧缓存以重建
let dictCache = loadJSON(DICT_FILE, {});
if (!dictCache || typeof dictCache !== 'object' || Array.isArray(dictCache)) dictCache = {};
/* 淘汰旧版本缓存条目：只针对磁盘里读出来的富化结果（带 v 字段的才是本版本写的）。
   离线词书索引不在这里，它每次启动都从 books.json 现建，天然是新的。 */
(function dropStaleDictCache() {
  let dropped = 0;
  for (const k of Object.keys(dictCache)) {
    const e = dictCache[k];
    if (e && typeof e === 'object' && e.v === DICT_VER) continue;
    delete dictCache[k]; dropped += 1;
  }
  if (dropped) console.log('[词典] 已淘汰 ' + dropped + ' 条旧版释义缓存（结构 v' + DICT_VER + '），将按新规则重新生成');
})();
let dictDirty = false;
function dictKey(word, lang) { return (lang === 'es' ? 'es' : 'en') + ':' + String(word || '').trim().toLowerCase(); }
function saveDict() {
  if (!dictDirty) return;
  dictDirty = false;
  const keys = Object.keys(dictCache);
  if (keys.length > DICT_MAX) {
    keys.sort((a, b) => (dictCache[a].at || 0) - (dictCache[b].at || 0));
    for (const k of keys.slice(0, Math.ceil(keys.length / 2))) delete dictCache[k];
  }
  saveJSON(DICT_FILE, dictCache);
}

/* ---------- 离线词书索引：所有内置词书自带的「词性 + 中文释义」----------
 * 背景：词典详情原先只能靠联网查有道 / dictionaryapi.dev，而 Render 每次部署会清空磁盘，
 *       导致 store/dict.json 缓存全丢 → 每个词都要重新联网 → 慢、且网络不通时直接不显示。
 * 方案：public/data/books.json 是随代码发布的静态文件，内含 1.4 万词的「词性+释义」。
 *       启动时在内存里建索引，查询时【零网络、即时】返回；外部 API 只用于补充音标/例句。 */
const BOOKS_FILE = path.join(PUB, 'data', 'books.json');
const bookIndex = new Map(); // 'en:word' -> { word, lang, senses:[{pos,def}], src:'book' }
function parseBookMeaning(s) {
  const t = String(s == null ? '' : s).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  if (!t) return { pos: '', def: '' };
  const m = t.match(POS_RE);
  if (m) {
    const pos = m[0].replace(/[\s.]+$/g, '').toLowerCase(); // 去掉结尾的空格/点
    const def = t.slice(m[0].length).trim();
    if (def) return { pos: pos, def: def };
  }
  return { pos: '', def: t };
}
function buildBookIndex() {
  let n = 0;
  try {
    const raw = JSON.parse(fs.readFileSync(BOOKS_FILE, 'utf8'));
    if (!Array.isArray(raw)) return 0;
    for (const b of raw) {
      const lang = (b && b.lang === 'es') ? 'es' : 'en';
      const ws = (b && b.words) || [];
      for (const it of ws) {
        if (!Array.isArray(it) || typeof it[0] !== 'string') continue;
        const w = it[0].trim();
        if (!w) continue;
        const p = parseBookMeaning(it[1]);
        if (!p.def) continue;
        /* 只要含中文的释义。词书里混着一些被拆坏的短语条目：
           如 "go without"（没有…也行）被拆成 word=go / meaning=without，
           于是查 go 会冒出一条纯英文的「without」，对中文用户毫无意义。
           学习用的 BOOKS 有 isValidMeaning 过滤，词典索引此前漏了这道，这里补上。 */
        if (!/[\u4e00-\u9fff]/.test(p.def)) continue;
        const key = lang + ':' + w.toLowerCase();
        const prev = bookIndex.get(key);
        if (!prev) {
          // 字段形状与联网富化结果保持一致，前端无需区分来源
          bookIndex.set(key, { word: w, lang: lang, ipa: '', audio: '', senses: [{ pos: p.pos, def: p.def }], forms: [], phrases: [], examples: [], exams: [], src: 'book' });
        } else if (prev.senses.length < 4 && !isDupDef(p.def, prev.senses.map((s) => s.def))) {
          // 同一词在不同词书里的补充义项；近义重复（「条，条款；一条」vs「条，条款」）在此拦掉
          prev.senses.push({ pos: p.pos, def: p.def });
        }
        n++;
      }
    }
  } catch (e) { console.error('[词典] 词书索引构建失败', (e && e.message) || e); }
  return n;
}
const BOOK_INDEX_SIZE = buildBookIndex();

/* ---------- 词典富化结果的云端分片缓存 ----------
 * 外部 API 补来的音标/例句等富化数据存进 Upstash（按 语言+首字母 分片，避免单 key 过大）。
 * 这样部署后缓存不丢，越用越全，最终几乎不再依赖实时联网。 */
function dictShardKey(word, lang) {
  const c = String(word || '').trim().toLowerCase().charAt(0);
  const letter = /[a-z0-9]/.test(c) ? c : '_';
  return 'dict:' + (lang === 'es' ? 'es' : 'en') + ':' + letter;
}
const dictShardsLoaded = new Set();
const dictShardTimers = {};
/* 词典缓存【已改为只存本地磁盘，不再读写云端】——这是修复「每次更新后账号/密码失效」的关键一环。
   原因：① Upstash 免费额度约 1 万 commands/天，词典分片读写会大量挤占额度；
          一旦触发 429 限流，连 accounts（账号+进度）都写不进去，
          表现就是「更新版本后账号没了 / 用户名密码不对」。
        ② 内置词书已有离线索引（4 万条，零网络即时显示），
          外部富化（音标/例句）属于丢了可重建的缓存，不值得占用用户数据的额度。
   结论：宝贵的云端额度全部留给 accounts / sessions / groups / vocab-rank。 */
async function loadDictShard(word, lang, ms) {
  return; // 云端词典缓存已停用；本地 store/dict.json 在启动时已载入内存
}
function saveDictShard(word, lang) {
  saveDict(); // 仅落本地磁盘（会被平台清盘，但只是缓存，可重建）
}
/* 后台限速富化：对已有词书释义、但缺音标/例句的词，慢慢联网补齐并存库。
   严格限速，既保护外部 API，也避免打爆 Upstash 免费额度。 */
const enrichQueue = [];
const enrichSeen = new Set();
let enrichRunning = false;
let enrichCount = 0;
let enrichHourStart = Date.now();
const ENRICH_MAX_PER_HOUR = 240;
function scheduleEnrich(word, lang) {
  const key = dictKey(word, lang);
  const cur = dictCache[key];
  if (cur && cur.ipa) return;              // 已有音标，认为已富化
  if (enrichSeen.has(key)) return;
  enrichSeen.add(key);
  enrichQueue.push({ word: word, lang: lang });
  if (enrichQueue.length > 400) enrichQueue.shift();
  startEnrich();
}
async function startEnrich() {
  if (enrichRunning) return;
  enrichRunning = true;
  try {
    while (enrichQueue.length) {
      if (Date.now() - enrichHourStart > 3600000) { enrichHourStart = Date.now(); enrichCount = 0; }
      if (enrichCount >= ENRICH_MAX_PER_HOUR) break;
      const item = enrichQueue.shift();
      if (!item) break;
      try {
        const d = await _fetchWordDetail(item.word, dictKey(item.word, item.lang), item.lang);
        if (d) { enrichCount++; saveDictShard(item.word, item.lang); }
      } catch (e) { /* 富化失败不影响用户，下次再说 */ }
      await sleep(700);
    }
  } finally { enrichRunning = false; }
}
function fetchJSON(url, ms) {
  const ctrl = (typeof AbortController === 'function') ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), ms || 5000) : null;
  return Promise.race([
    fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36' },
      signal: ctrl ? ctrl.signal : undefined,
    }).then((r) => (r.ok ? r.json() : Promise.reject(new Error('http_' + r.status)))),
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), (ms || 5000) + 500)),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}
/* 去掉有道释义里的 HTML 标签与多余空白 */
function cleanText(s) {
  return String(s == null ? '' : s)
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
/* 有道接口里 {l:{i:...}} 的 i 有时是字符串、有时是数组，统一取文本 */
function iText(l) {
  if (!l) return '';
  if (Array.isArray(l.i)) return cleanText(l.i[0] || '');
  return cleanText(l.i || '');
}
/* 释义「详略得当」：按中文分号切成要点，最多保留 max 条，避免一个词性下塞 8 个义项 */
function shortenDef(def, max) {
  const s = cleanText(def);
  const parts = s.split(/[；;]/).map((x) => x.trim()).filter(Boolean);
  if (parts.length <= (max || 3)) return s;
  const kept = parts.slice(0, max || 3);
  return kept.join('；') + ' 等';
}
/* 有道 jsonapi → 统一结构（英文主力源） */
function parseYoudao(d, word) {
  const out = { senses: [], forms: [], phrases: [], examples: [], exams: [] };
  const pushSense = (pos, def) => {
    if (!def) return;
    if (out.senses.length >= 4) return;
    const d2 = shortenDef(def, out.senses.length === 0 ? 3 : 2).slice(0, 160);
    if (!d2) return;
    // 有道常把「条 / 条款 / 一条」这类近义义项拆成多条返回，逐条跳过
    if (isDupDef(d2, out.senses.map((s) => s.def))) return;
    out.senses.push({ pos: pos || '', def: d2 });
  };
  const ecs = ((d.ec || {}).word) || ((d.simple || {}).word) || [];
  const w0 = ecs[0];
  if (w0) {
    if (w0.ukphone) out.ipaUk = cleanText(w0.ukphone);
    if (w0.usphone) out.ipaUs = cleanText(w0.usphone);
    if (w0.ukspeech) out.audioUk = 'https://dict.youdao.com/dictvoice?le=en&type=1&audio=' + encodeURIComponent(String(w0.ukspeech).split('&')[0]);
    if (w0.usspeech) out.audioUs = 'https://dict.youdao.com/dictvoice?le=en&type=2&audio=' + encodeURIComponent(String(w0.usspeech).split('&')[0]);
    for (const t of (w0.trs || [])) {
      const tr0 = (t && Array.isArray(t.tr) && t.tr[0]) || t || {};
      const line = iText(tr0.l);
      if (!line) continue;
      const m = line.match(/^([a-zA-Z]+\.)\s*(.*)$/);
      if (m) pushSense(m[1], m[2]); else pushSense('', line);
    }
    for (const f of (w0.wfs || [])) {
      const wf = f && f.wf;
      if (wf && wf.name && wf.value && out.forms.length < 6) out.forms.push({ name: cleanText(wf.name), value: cleanText(wf.value) });
    }
  }
  for (const p of ((d.phrs || {}).phrs || [])) {
    if (out.phrases.length >= 3) break;
    const ph = p && p.phr;
    if (!ph) continue;
    const head = iText(ph.headword && ph.headword.l);
    const tr0 = (Array.isArray(ph.trs) && ph.trs[0]) || {};
    const tr = iText(tr0.tr && tr0.tr.l) || iText(tr0.l);
    if (head) out.phrases.push({ ph: head, tr: tr });
  }
  for (const pair of ((d.blng_sents_part || {})['sentence-pair'] || [])) {
    if (out.examples.length >= 2) break;
    const en = cleanText(pair && (pair.sentence || pair['sentence-eng']));
    const zh = cleanText(pair && pair['sentence-translation']);
    if (en) out.examples.push({ en: en, zh: zh });
  }
  for (const e of ((d.ec || {}).exam_type || [])) {
    if (out.exams.length >= 4) break;
    const n = cleanText(e);
    if (n) out.exams.push(n);
  }
  return out;
}
/* 有道 suggest → 统一结构（西语等小语种兜底：只有释义，没有音标/例句）
   注意：suggest 会返回一堆「形近词」（查 hola 会带出 holanda / holandeses），
   必须只取 entry 与目标词完全相同的那条，否则释义会张冠李戴（B6）。 */
function parseYoudaoSuggest(d, word) {
  const out = { senses: [], forms: [], phrases: [], examples: [], exams: [] };
  const target = String(word || '').trim().toLowerCase();
  const ents = ((d || {}).data || {}).entries || [];
  for (const e of ents) {
    if (String(e.entry || '').trim().toLowerCase() !== target) continue;
    const ex = cleanText(e.explain).replace(/~/g, String(word || ''));
    if (!ex) continue;
    for (const seg of ex.split(/;|；/)) {
      const line = cleanText(seg);
      // 只保留含中文的段：西语词条的解释串里混着 "|→" "m.," 之类的格式噪音
      if (!line || !/[\u4e00-\u9fff]/.test(line) || out.senses.length >= 2) continue;
      const m = line.match(/^([a-zA-Z]+\.?)\s*(.*)$/);
      const rest = m && m[2] ? m[2].replace(/^\d+[.、]\s*/, '').trim() : line; // 剥掉 "1." "2、" 义项编号
      if (!rest) continue;
      const d2 = rest.slice(0, 160);
      if (isDupDef(d2, out.senses.map((s) => s.def))) continue;
      if (m && /[\u4e00-\u9fff]/.test(rest)) out.senses.push({ pos: m[1], def: d2 });
      else out.senses.push({ pos: '', def: d2 });
    }
    break;
  }
  return out;
}
/* 有道 suggest（英文）→ 统一结构；作为 jsonapi/dictapi 都失败时的兜底，只补中文释义（无音标）。
   响应示例：{"data":{"entries":[{"entry":"sound","explain":"n. 声音，声响；听力范围，听距；乐音；..."}]}}
   注意：explain 里只有第一个义项段带词性，后续同词性段省略词性，需要继承 lastPos。 */
function parseYoudaoSuggestEn(d, word) {
  const out = { senses: [], forms: [], phrases: [], examples: [], exams: [] };
  const target = String(word || '').trim().toLowerCase();
  const ents = ((d || {}).data || {}).entries || [];
  for (const e of ents) {
    if (String(e.entry || '').trim().toLowerCase() !== target) continue;
    const ex = cleanText(e.explain).replace(/~/g, String(word || ''));
    if (!ex) continue;
    let lastPos = '';
    for (const seg of ex.split(/;|；/)) {
      if (out.senses.length >= 4) break;
      const line = cleanText(seg);
      if (!line || !/[\u4e00-\u9fff]/.test(line)) continue;
      const m = line.match(/^([a-zA-Z]+\.?)\s*(.*)$/);
      let pos = lastPos, rest = line;
      if (m && m[1] && m[2] && /[\u4e00-\u9fff]/.test(m[2])) {
        pos = m[1];
        rest = m[2].replace(/^\d+[.、]\s*/, '').trim();
        lastPos = pos;
      }
      if (!rest) continue;
      const d2 = shortenDef(rest, out.senses.length === 0 ? 3 : 2).slice(0, 160);
      if (!d2 || isDupDef(d2, out.senses.map((s) => s.def))) continue;
      out.senses.push({ pos: pos, def: d2 });
    }
    break;
  }
  return out;
}
/* 有道 jsonapi(le=es) 的 multle 字典 → 统一结构（西语主力源：完整词性+义项）
   结构：d.multle.word[0].trs[] = [{tr:[{l:{i:["adj.\\n"]}}]}, {tr:[{l:{i:["1.极坏的…"]}}]}, …]
   词性行（adj. / m., / f.）与义项行（1.狗，犬）交替出现，~ 是单词代称。 */
function parseYoudaoMultle(d, word) {
  const out = { senses: [], forms: [], phrases: [], examples: [], exams: [] };
  const w0 = (((d || {}).multle || {}).word || [])[0];
  if (!w0 || !Array.isArray(w0.trs)) return out;
  const w = String(word || '');
  let pos = '';
  for (const t of w0.trs) {
    const tr0 = (t && Array.isArray(t.tr) && t.tr[0]) || t || {};
    let line = iText(tr0.l).replace(/~/g, w).replace(/[\n\r]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!line) continue;
    if (/^\|/.test(line) || /^→/.test(line)) continue; // "|→ 另见" 等格式噪音
    const posm = line.match(/^([a-zA-Z]+)[.,]?$/); // 纯词性行：adj. / m., / f.
    if (posm) { pos = posm[1]; continue; }
    const nm = line.match(/^(\d+)[.、]\s*(.*)$/);
    const def = nm ? nm[2].trim() : line;
    if (!def || !/[\u4e00-\u9fff]/.test(def)) continue; // 只要含中文的义项
    if (out.senses.length >= 4) break;
    const d2 = shortenDef(def, out.senses.length === 0 ? 3 : 2).slice(0, 160);
    if (!d2) continue;
    if (isDupDef(d2, out.senses.map((s) => s.def))) continue;
    const posShow = pos === 'm' ? 'n.(阳)' : pos === 'f' ? 'n.(阴)' : pos;
    out.senses.push({ pos: posShow, def: d2 });
  }
  return out;
}
/* dictionaryapi.dev → 统一结构（海外兜底，提供标准 IPA 与真人音频） */
/* 释义去重：新义项与已有义项高度相似则跳过。
 * 背景（务必记住，否则会重蹈覆辙）：这个函数【曾经只被 parseDictApi 调用】，
 * 而真正产出释义的两条主路径（离线词书索引 buildBookIndex、有道 parseYoudao）都没去重，
 * 于是加了去重却"看起来没效果"——详情弹窗里照样刷出一堆「条 / 条款 / 一条」。
 * 现在三条路径统一走这里。
 * 判定（任一命中即重复）：
 *   1) 归一化后完全相同
 *   2) 一方是另一方的连续子串（双方都 ≥4 字时才启用，避免误伤短词）
 *   3) 极短义项（1-2 字）被某条已有义项整段包含 → 冗余（如「做」⊂「使；做，制造」）
 *   4) Jaccard 字符重叠率 > 0.4 → 近义重复（用字集合，抗词序与虚词差异）
 *   5) 子集覆盖率 > 0.65 → 新义项大部分字已被某条已有义项覆盖
 */
function normDef(s) {
  return String(s == null ? '' : s)
    .replace(/[\s，。、；：""''（）【】()\-—\/·《》]/g, '')
    .toLowerCase();
}
/* 主义项：中文词典习惯把核心释义放在最前面（「去；走；变为」的核心就是「去」）。
   两条释义若主义项相同，基本就是同一意思的不同措辞（如「去；走；变为」vs「去,离开,进行」），
   这类用字不同、但语义重复的，纯字符相似度抓不到，必须靠主义项来识别。 */
function primarySeg(s) {
  return String(s == null ? '' : s).split(/[；;，,、\/]/)[0].trim();
}
function isDupDef(newDef, existing) {
  const list = Array.isArray(existing) ? existing : [];
  const a = normDef(newDef);
  if (!a) return false;
  // 3) 极短义项：完全相同，或被某条更完整的义项整段包含，都算冗余
  if (a.length < 3) {
    for (let i = 0; i < list.length; i++) {
      const bx = normDef(list[i]);
      if (bx === a) return true;                                  // 完全相同（两条都很短也算重复）
      if (bx.length >= 3 && bx.indexOf(a) >= 0) return true;      // 被更完整的义项包含
    }
    return false;
  }
  for (let i = 0; i < list.length; i++) {
    const b = normDef(list[i]);
    if (!b) continue;
    if (b.length < 3) {
      // 已有的是极短义项，且被新义项整段包含 —— 同样判重复
      if (a.indexOf(b) >= 0) return true;
      continue;
    }
    if (a === b) return true;                                                    // 1)
    if (a.length >= 4 && b.length >= 4 && (a.indexOf(b) >= 0 || b.indexOf(a) >= 0)) return true; // 2)
    // 2b) 主义项相同或互相包含（≥2 字才启用，避免「去」这类单字误伤「去除/去年」等）
    const na = normDef(primarySeg(newDef)), nb = normDef(primarySeg(list[i]));
    if (na && nb) {
      if (na === nb) return true;
      if (na.length >= 2 && nb.indexOf(na) >= 0) return true;
      if (nb.length >= 2 && na.indexOf(nb) >= 0) return true;
      // 主义项落在对方【整条】释义里也算重复：
      // 如已有「明亮的；轻的；不重要的」时，新来的「轻的，少量的」的主义项「轻的」已被覆盖
      if (na.length >= 2 && b.indexOf(na) >= 0) return true;
      if (nb.length >= 2 && a.indexOf(nb) >= 0) return true;
    }
    const sa = new Set(a), sb = new Set(b);
    let inter = 0;
    for (const c of sa) { if (sb.has(c)) inter++; }
    const union = sa.size + sb.size - inter;
    if (union > 0 && inter / union > 0.4) return true;                           // 4)
    if (inter / sa.size > 0.65) return true;                                     // 5)
  }
  return false;
}
function parseDictApi(d, word) {
  const out = { senses: [], forms: [], phrases: [], examples: [], exams: [] };
  if (!Array.isArray(d) || !d[0]) return null;
  const e = d[0];
  if (e.phonetic) out.ipa = cleanText(e.phonetic);
  for (const ph of (e.phonetics || [])) {
    if (!out.ipa && ph.text) out.ipa = cleanText(ph.text);
    if (!out.audio && ph.audio) out.audio = String(ph.audio);
  }
  for (const m of (e.meanings || [])) {
    if (out.senses.length >= 4) break;
    const pos = cleanText(m.partOfSpeech);
    for (const def of (m.definitions || [])) {
      if (out.senses.length >= 4) break;
      if (!def || !def.definition) continue;
      const dtext = cleanText(def.definition).slice(0, 120);
      if (isDupDef(dtext, out.senses.map(function(s){ return s.def; }))) continue;
      out.senses.push({ pos: pos, def: dtext, en: cleanText(def.example || '').slice(0, 160) });
    }
  }
  if (!out.senses.length) return null;
  return out;
}
function buildDetail(word, lang, parsed, src) {
  const isEs = lang === 'es';
  const audio = parsed.audio || parsed.audioUs ||
    (isEs
      ? 'https://dict.youdao.com/dictvoice?le=es&audio=' + encodeURIComponent(word)
      : 'https://dict.youdao.com/dictvoice?le=en&type=2&audio=' + encodeURIComponent(word));
  const ipa = parsed.ipa || parsed.ipaUs || '';
  const out = {
    word: word, lang: isEs ? 'es' : 'en',
    ipa: ipa,
    ipaUk: parsed.ipaUk || '', ipaUs: parsed.ipaUs || '',
    audio: audio,
    audioUk: parsed.audioUk || '', audioUs: parsed.audioUs || '',
    senses: parsed.senses || [],
    forms: parsed.forms || [],
    phrases: parsed.phrases || [],
    examples: parsed.examples || [],
    exams: parsed.exams || [],
    src: src, at: Date.now(),
    v: DICT_VER,   // 结构版本：供启动时淘汰旧规则生成的缓存（详见 DICT_VER 注释）
  };
  return out;
}
/* 词书释义与在线词典释义合并。规则：
 *  - 词书义优先入列，自身近义先去重（buildBookIndex 已折叠 cet6/ielts 对同一词的近义，这里再保险一次）；
 *  - 在线义按「；」拆段，只保留词书里没有的新义项段，冗余段（如 default 的「违约/拖欠」）丢弃；
 *    否则整条在线义因含「违约/拖欠」被 isDupDef 判为与词书近义、连带把「默认/缺省」一起丢掉；
 *  - 音标/音频/例句/搭配/词形优先用在线（更全），词书缺则补。 */
function mergeBookOnline(book, online) {
  const senses = [];
  const isDup = (def) => senses.some((s) => isDupDef(def, [s.def]));
  for (const s of (book.senses || [])) {
    if (s && s.def && !isDup(s.def)) senses.push({ pos: s.pos || '', def: s.def });
  }
  const bookDefs = (book.senses || []).map((s) => s.def);
  // dictionaryapi.dev 给出的是英文释义；词书已有中文释义时，不把这些英文义项混入弹窗，
  // 只取它的音标/音频/例句等。自定义词书里的词没有 book.senses 时，才保留英文释义兜底。
  const hasChineseBook = (book.senses || []).some((s) => /[\u4e00-\u9fff]/.test(s.def || ''));
  const onlineSenses = (online.src === 'dictapi' && hasChineseBook) ? [] : (online.senses || []);
  for (const s of onlineSenses) {
    if (!s || !s.def) continue;
    const segs = String(s.def).split(/[；;]/).map((x) => x.trim()).filter(Boolean);
    const novel = segs.filter((seg) => !isDupDef(seg, bookDefs) && !isDup(seg));
    if (!novel.length) continue;
    if (senses.length >= 8) break;
    senses.push({ pos: s.pos || '', def: novel.join('；') });
  }
  const pick = (a, b) => (a || b);
  return {
    word: book.word || online.word,
    lang: book.lang || online.lang || 'en',
    ipa: pick(online.ipa, book.ipa),
    ipaUk: pick(online.ipaUk, book.ipaUk),
    ipaUs: pick(online.ipaUs, book.ipaUs),
    audio: pick(online.audio, book.audio),
    audioUk: pick(online.audioUk, book.audioUk),
    audioUs: pick(online.audioUs, book.audioUs),
    senses: senses,
    forms: (online.forms && online.forms.length) ? online.forms : (book.forms || []),
    phrases: (online.phrases && online.phrases.length) ? online.phrases : (book.phrases || []),
    examples: (online.examples && online.examples.length) ? online.examples : (book.examples || []),
    exams: (online.exams && online.exams.length) ? online.exams : (book.exams || []),
    src: (online.src ? (online.src + '+book') : (book.src || 'book')),
    at: Date.now(),
    v: DICT_VER,
  };
}
/* 把在线富化结果写入 dictCache；若该词属于某本词书，则先与词书释义合并（见 mergeBookOnline）。 */
function cacheWordDetail(key, out) {
  const bk = bookIndex.get(key);
  const finalOut = (bk && (bk.senses || []).length) ? mergeBookOnline(bk, out) : out;
  dictCache[key] = finalOut;
  dictDirty = true;
  saveDict();
  return finalOut;
}

/* 查询单词详情：本地缓存 → 有道 → dictionaryapi.dev（英文）→ 有道 suggest（西语）
   并发防护：同一词去重（正在查的直接复用），全局最多同时 4 个外部请求，防刷限流。 */
const dictInFlight = new Map(); // key -> [promise]
let dictConcurrent = 0;
const DICT_MAX_CONCURRENT = 4;
/* 启动一次外部词典请求，并在 inFlight map 中复用，避免同一个词并发重复查询。 */
function startFetchWordDetail(word, lang) {
  const key = dictKey(word, lang);
  if (dictInFlight.has(key)) return dictInFlight.get(key);
  const p = _fetchWordDetail(word, key, lang);
  dictInFlight.set(key, p);
  p.then(() => { dictInFlight.delete(key); saveDictShard(word, lang); }, () => dictInFlight.delete(key));
  return p;
}
/* 同步等在线富化（带超时）。详情弹窗首屏用：避免用户先看到不完整的词书义、再靠轮询补。 */
async function enrichWithTimeout(word, lang, ms) {
  try {
    return await Promise.race([
      startFetchWordDetail(word, lang),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms || 5000)),
    ]);
  } catch (e) {
    return null;
  }
}
/* 查询顺序（关键：前 3 步都不依赖实时联网，保证「不延迟、不失败」）：
   1) 内存富化缓存      2) Upstash 云端分片富化缓存（短超时，超时就跳过）
   3) 离线词书索引（1.4 万词，零网络即时返回「词性+释义」，音标后台慢慢补）
   4) 都不命中（自定义词书里的词）才走外部网络，失败也只是没有音标，不会报错
   注：wait=true 时，对词书词会同步等最多约 5s 在线富化，用于详情弹窗首屏。 */
async function getWordDetail(word, lang, wait) {
  const key = dictKey(word, lang);
  const w = String(word || '').trim();
  if (!w) return null;
  const NEG_TTL = 30 * 60 * 1000; // 查不到的词 30 分钟内不再重复打网络

  // 1) 内存富化缓存
  let hit = dictCache[key];
  if (hit && typeof hit === 'object' && (hit.senses || []).length) return hit;

  // 2) 云端分片富化缓存（首次访问某分片才消耗一次 KV 读，且最多等 1.2s）
  await loadDictShard(w, lang, 1200);
  hit = dictCache[key];
  if (hit && typeof hit === 'object' && (hit.senses || []).length) return hit;

  // 3) 离线词书索引：即时返回，音标/例句交给后台富化
  const bk = bookIndex.get(key);
  if (bk && (bk.senses || []).length) {
    // 详情弹窗首屏：等一会儿在线富化，避免先显示不完整词书义
    if (wait) {
      const enriched = await enrichWithTimeout(w, lang, 5000);
      if (enriched) return enriched;
    }
    scheduleEnrich(w, lang);
    return bk;
  }

  // 4) 外部网络（自定义词书里的词）
  if (hit && typeof hit === 'object' && hit.neg && Date.now() - (hit.at || 0) < NEG_TTL) return null;
  return startFetchWordDetail(w, lang);
}
async function _fetchWordDetail(w, key, lang) {
  const isEs = lang === 'es';
  const q = encodeURIComponent(w.toLowerCase());
  try {
    while (dictConcurrent >= DICT_MAX_CONCURRENT) await new Promise((r) => setTimeout(r, 120));
    dictConcurrent += 1;
  } catch (e) { /* 等待被中断也正常返回 */ }
  try {
    if (isEs) {
      // 优先 jsonapi(le=es) 的 multle 完整词典；suggest 仅作兜底（只有模糊释义）
      const d = await fetchJSON('https://dict.youdao.com/jsonapi?q=' + q + '&le=es&doctype=json', 6000);
      const p = parseYoudaoMultle(d, w);
      // multle 质量判定：至少 2 条义项，或带词性标记（hola 之类的词 multle 只有 1 条
      // 音译「加洛莱」，必须回退 suggest 才拿得到「你好」）
      const multleOk = p.senses.length >= 2 || p.senses.some((s) => s.pos);
      if (multleOk) {
        const out = buildDetail(w, 'es', p, 'youdao');
        return cacheWordDetail(key, out);
      }
      const ds = await fetchJSON('https://dict.youdao.com/suggest?num=5&ver=3.0&doctype=json&le=es&q=' + q, 5000);
      const ps = parseYoudaoSuggest(ds, w);
      if (ps.senses.length) {
        const out = buildDetail(w, 'es', ps, 'youdao-suggest');
        return cacheWordDetail(key, out);
      }
    } else {
      // 1) 有道主力源（英文）。若 youdao 完全失败（网络被拦截/超时），仍然继续走 fallback，
      //    而不是整条 catch 跳过 dictapi。生产环境偶发 youdao 不可达时，音标至少能从 dictapi 回来。
      let p = null;
      try {
        const d = await fetchJSON('https://dict.youdao.com/jsonapi?q=' + q + '&doctype=json', 6000);
        p = parseYoudao(d, w);
      } catch (e) { console.log('[dict] youdao failed for', w, '-', e.message); }
      if (p && p.senses.length) {
        // 有道没给音标/音频时，用 dictionaryapi.dev 补齐
        if (!p.ipaUs && !p.ipa) {
          try {
            const d2 = await fetchJSON('https://api.dictionaryapi.dev/api/v2/entries/en/' + q, 5000);
            const p2 = parseDictApi(d2, w);
            if (p2) { if (p2.ipa) p.ipa = p2.ipa; if (p2.audio) p.audio = p2.audio; }
          } catch (e) { console.log('[dict] dictapi(ipa) failed for', w, '-', e.message); }
        }
        const out = buildDetail(w, 'en', p, 'youdao');
        return cacheWordDetail(key, out);
      }
      // 2) 有道失败/无结果：回退 dictionaryapi.dev（至少能补音标；非词书词也能给出英文释义）
      try {
        const d3 = await fetchJSON('https://api.dictionaryapi.dev/api/v2/entries/en/' + q, 5000);
        const p3 = parseDictApi(d3, w);
        if (p3) {
          console.log('[dict] dictapi fallback used for', w);
          const out = buildDetail(w, 'en', p3, 'dictapi');
          return cacheWordDetail(key, out);
        }
      } catch (e) { console.log('[dict] dictapi fallback failed for', w, '-', e.message); }
      // 3) 最后兜底：有道 suggest（英文）。这个接口在部分网络环境下比 jsonapi 更稳，
      //    能给出带词性的中文释义，但没有音标/例句；和词书义合并后至少保证「声音」这类日常义不丢。
      try {
        const d4 = await fetchJSON('https://dict.youdao.com/suggest?num=5&ver=3.0&doctype=json&le=en&q=' + q, 5000);
        const p4 = parseYoudaoSuggestEn(d4, w);
        if (p4.senses.length) {
          console.log('[dict] youdao-suggest fallback used for', w);
          const out = buildDetail(w, 'en', p4, 'youdao-suggest');
          return cacheWordDetail(key, out);
        }
      } catch (e) { console.log('[dict] youdao-suggest fallback failed for', w, '-', e.message); }
    }
  } catch (e) { /* 网络异常：返回 null，前端降级为只显示词书释义 */ } finally {
    dictConcurrent -= 1; // 无论成败都要释放并发名额
  }
  // 查不到时记一个空结果，避免同一个生僻词被反复联网查询（30 分钟后才允许重试）
  dictCache[key] = { word: w, lang: isEs ? 'es' : 'en', ipa: '', audio: '', senses: [], forms: [], phrases: [], examples: [], exams: [], src: 'none', neg: true, at: Date.now(), v: DICT_VER };
  dictDirty = true; saveDict();
  return null;
}

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
/* 取令牌：优先 Authorization: Bearer <token> 头（避免令牌进入 URL → 浏览器历史/代理日志/
   Render 访问日志），其次回退到 query(?token=) 与 body.token（SSE 的 EventSource 无法自定义
   请求头，仍需走 query；旧客户端也靠 query/body 兼容）。 */
function tokenOf(req, u, b) {
  const auth = req.headers['authorization'] || req.headers['Authorization'];
  if (auth) { const m = /^Bearer\s+(.+)$/i.exec(String(auth)); if (m) return m[1].trim(); }
  const q = u.searchParams.get('token');
  if (q) return q;
  if (b && b.token) return b.token;
  return '';
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
      const tw = splitMeaning(meaning).clean;
      if (!tierOf.has(k) && isValidMeaning(tw)) { tierOf.set(k, t); tierWords[t].push({ word, meaning: tw }); }
    }
  }
}
const TIER_SIZES = tierWords.map((a) => a.length);
const TIER_SAMPLE = 6; // 每层抽 6 题，共 42 题
const ALL_TIER_WORDS = tierWords.flat(); // 词汇量测试干扰释义候选池

const rooms = new Map();
const invites = new Map(); // targetUsername(lower) -> [{id, fromUsername, fromName, roomId, bookName, mode, count, at, expiresAt}]

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
  if (!b.lang) b.lang = 'en'; // 词书语言：en 英语 / es 西班牙语（影响朗读发音）
  b._studyOrder = b._words.map((w, i) => {
    const k = String(w.word).toLowerCase();
    if (!WORD_INFO.has(k)) WORD_INFO.set(k, { word: w.word, meaning: w.meaning, bookName: b.name, bookId: b.id, lang: b.lang });
    return { word: w.word, meaning: w.meaning, pos: freqPos(w.word), idx: i, posKey: k };
  });
  // keepOrder 词书（AWL 按 sublist 学术频率、西语按教学频率）保持原始顺序；其余按通用词频排序
  if (!b.keepOrder) b._studyOrder.sort((a, c) => a.pos - c.pos || a.idx - c.idx);
}

/* 用户自定义词书：把存储用定义（{id,name,lang,words:[[w,m]]}）补全为带运行时字段的「书」，
 * 复用与全局词书相同的出题/排序逻辑。带缓存避免每次请求重建。 */
function buildRuntimeBook(def) {
  if (def._words) return def;
  const words = (def.words || []).map(([word, meaning]) => {
    const { pos, clean } = splitMeaning(meaning);
    return { word, meaning: clean, pos, raw: meaning };
  });
  const byPos = new Map();
  for (const w of words) {
    if (!byPos.has(w.pos)) byPos.set(w.pos, []);
    byPos.get(w.pos).push(w);
  }
  const studyOrder = words.map((w, i) => {
    const k = String(w.word).toLowerCase();
    return { word: w.word, meaning: w.meaning, pos: freqPos(w.word), idx: i, posKey: k };
  });
  if (!def.keepOrder) studyOrder.sort((a, c) => a.pos - c.pos || a.idx - c.idx);
  def._words = words;
  def._byPos = byPos;
  def._studyOrder = studyOrder;
  if (!def.lang) def.lang = 'en';
  return def;
}
/* 解析词书：先查全局，再查账号自定义词书（id 形如 cb-<时间戳>） */
function resolveBook(acc, id) {
  const g = BOOKS.find((b) => b.id === id);
  if (g) return g;
  if (id && id.indexOf('cb-') === 0 && acc) {
    if (!acc.__rt) acc.__rt = new Map();
    if (acc.__rt.has(id)) return acc.__rt.get(id);
    const cb = (acc.customBooks || []).find((x) => x.id === id);
    if (!cb) return null;
    const rt = buildRuntimeBook(JSON.parse(JSON.stringify(cb)));
    acc.__rt.set(id, rt);
    return rt;
  }
  return null;
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

/* 熟词本（已会/已掌握）单词集合：这些词在任何学习、复习、单元场景下都不应再出现。
   之前只靠 st.progress.lv>=MASTER_LV 来判断，但存在两类失效：
   ① markKnown 不会写入 st.progress.n（保持 0），于是 daily 新词队列把它当「从未学过的生词」再次放出；
   ② 进度被整体重置（scope=progress）后该判断直接失效，熟词本里的词又冒出来。
   所以以 acc.known 这一权威集合为唯一准绳做排除。 */
function knownSetOf(acc) {
  const s = new Set();
  for (const x of (acc.known || [])) { const k = wordKey(x && x.word); if (k) s.add(k); }
  return s;
}
/* 在“按预估词汇量过滤”的列表基础上，再剔除已移入熟词本的词 */
function knownFilteredList(book, vocabEstimate, knownSet) {
  const { list, skipped } = filterKnown(book, vocabEstimate);
  if (!knownSet || knownSet.size === 0) return { list, skipped, knownSkipped: 0 };
  const out = [];
  let knownSkipped = 0;
  for (const w of list) { if (knownSet.has(w.posKey)) knownSkipped += 1; else out.push(w); }
  return { list: out, skipped, knownSkipped };
}
/* 取词的展示卡片（word+meaning），优先从指定词书取，再回退全局词表。
   修复：自定义词书（不在全局 WORD_INFO 中）的到期/复习词此前只查 WORD_INFO，会被整体丢弃、永远不复习。 */
function wordCard(k, preferBook) {
  const info = wordInfoOf(k, preferBook);
  const w = (preferBook && preferBook._words.find((x) => wordKey(x.word) === k)) || WORD_INFO.get(k);
  if (!w && !info) return null;
  return { word: (w && w.word) || k, meaning: (info && info.meaning) || (w && w.meaning) || k };
}
/* 把单词从「熟词本」移回「生词本」时，必须同时撤销它的「已掌握」进度。
   否则该词进度仍停留在 lv=MASTER_LV，会被三处同时排除：
     ① 每日新词（要求 pr.n 为空 = 从未学过）
     ② 每日到期复习（要求 lv < MASTER_LV）
     ③ 智能复习队列（要求 lv < MASTER_LV）
   结果就是：它明明显示在生词本里，用户却永远刷不到它 —— 等同于把它关进了小黑屋。
   用户把它收回生词本 = 明确表达「这个我还不会」，理应立即降级为待巩固。 */
function demoteKnownWord(acc, w) {
  const k = wordKey(w);
  const st = acc && acc.study;
  if (!st || !st.progress || !st.progress[k]) return;
  const pr = st.progress[k];
  pr.lv = 0;
  pr.due = Date.now();      // 立即可复习，不用再等一个周期
  pr.lastAt = Date.now();
}

/* 按预估词汇量过滤：频率位次 ≤ 估计值的视为「已会」，跳过学习 */
function filterKnown(book, vocabEstimate) {
  const est = Math.max(0, Number(vocabEstimate) || 0);
  // 预估词汇量针对「英语」；非英语词书（如西班牙语）无词频概念，不跳过任何词
  if (!est || (book.lang && book.lang !== 'en')) return { list: book._studyOrder, skipped: 0 };
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
  const custom = (acc.customBooks || []).map((b) => ({ id: b.id, name: b.name, count: (b.words || []).length, lang: b.lang || 'en', custom: true }));
  const out = { plan: null, books: BOOKS.map((b) => ({ id: b.id, name: b.name, count: b.words.length, lang: b.lang })).concat(custom) };
  if (!st.plan) return out;
  const book = resolveBook(acc, st.plan.bookId) || BOOKS[0];
  const { list, skipped, knownSkipped } = knownFilteredList(book, st.plan.vocabEstimate, knownSetOf(acc));
  const now = Date.now();
  const lg = todayLog(st);
  let learned = 0, mastered = 0, due = 0;
  const inBook = new Set(list.map((w) => w.posKey));
  for (const [k, p] of Object.entries(st.progress)) {
    if (!p || !p.n) continue;
    if (inBook.has(k)) learned += 1;
    if (p.lv >= MASTER_LV) mastered += 1;
    // lv=0（答错待巩固）的词同样算「待复习」，与每日队列 / 智能复习队列口径保持一致
    else if (p.due && p.due <= now) due += 1;
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
    total: list.length, rawTotal: book.words.length, skipped, knownSkipped, unitSize: UNIT_SIZE,
    learned, mastered, due, wrongCount: (acc.words || []).length, knownCount: (acc.known || []).length,
    review: reviewStats(acc),   // 智能复习统计：待复习/易错/已掌握
    today: { new: lg.new, review: lg.review, wrong: lg.wrong, dailyNew: st.plan.dailyNew, newRemaining: Math.max(0, st.plan.dailyNew - lg.new), newPoolRemaining: Math.max(0, list.length - learned) },
    streak: streakOf(st), units, log30,
    books: BOOKS.map((b) => ({ id: b.id, name: b.name, count: b.words.length, lang: b.lang })).concat(custom),
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
    if (!isValidMeaning(x.meaning)) continue; // 防御：跳过无效释义（"n." 等脏数据）
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
    if (hit) return { meaning: hit.meaning, bookName: preferBook.name, lang: preferBook.lang };
  }
  const info = WORD_INFO.get(k);
  return info ? { meaning: info.meaning, bookName: info.bookName, lang: info.lang } : null;
}
/* 学习作答：更新进度 + SRS 排期 + 错题写入与 PK 共享的生词本
   extra 允许前端补传 {meaning, book, lang}：自定义词书里的词不在全局 WORD_INFO 中，
   不补传的话答错了也进不了生词本（B2）。字段按字符串截断，不会污染存储。 */
function studyAnswer(acc, word, correct, ms, extra) {
  const st = getStudy(acc);
  const k = wordKey(word);
  let info = wordInfoOf(word, resolveBook(acc, st.plan && st.plan.bookId));
  if (!info && extra && typeof extra === 'object') {
    const m = typeof extra.meaning === 'string' ? extra.meaning.slice(0, 200) : '';
    if (m) info = { meaning: m, bookName: (typeof extra.book === 'string' ? extra.book.slice(0, 60) : ''), lang: (extra.lang === 'es' ? 'es' : 'en') };
  }
  const now = Date.now();
  const lg = todayLog(st);
  let p = st.progress[k];
  const isNew = !p || !p.n;
  if (!p) p = st.progress[k] = { lv: 0, n: 0, c: 0, wrong: 0, due: 0, firstAt: now, lastAt: now };
  p.n += 1; p.lastAt = now;
  if (info && !p.meaning) p.meaning = info.meaning; // 记住首次收录的释义，供熟词本兜底
  let removed = false;
  let ease = 1;
  if (correct) {
    p.c += 1;
    p.lv = Math.min((p.lv || 0) + 1, SRS_DAYS.length - 1);
    // 答题速度感知：记得牢（答得快）→ 间隔拉长，减少无谓复习；
    // 犹豫（答得慢）→ 间隔缩短，及时巩固。等级规则不变（仍 lv+1）。
    // 未提供用时（如自动化/旧客户端）时 ease=1，保持原间隔（向后兼容）。
    if (typeof ms === 'number' && ms > 0) {
      if (ms <= 2500) ease = 1.5;
      else if (ms >= 8000 && ms <= 20000) ease = 0.6;
      else ease = 1;
    }
    p.due = now + Math.round(SRS_DAYS[p.lv] * 86400000 * ease);
    // 达到掌握等级：从生词本毕业，并记入「熟词本」
    if (p.lv >= MASTER_LV) {
      if (Array.isArray(acc.words)) {
        const before = acc.words.length;
        acc.words = acc.words.filter((x) => wordKey(x.word) !== k);
        removed = before !== acc.words.length;
      }
      const known = acc.known = acc.known || [];
      const kidx = known.findIndex((x) => wordKey(x.word) === k);
      const km = { word: String(word), meaning: (info && info.meaning) || (p.meaning || ''), book: (info && info.bookName) || '', lang: (info && info.lang) || 'en', at: now };
      if (kidx >= 0) known.splice(kidx, 1);
      known.unshift(km);
      if (known.length > 5000) known.length = 5000;
    }
  } else {
    p.wrong = (p.wrong || 0) + 1;
    p.lv = 0;
    p.due = now + WRONG_REDUE;
    if (info) {
      const list = acc.words = acc.words || [];
      const idx = list.findIndex((x) => wordKey(x.word) === k);
      if (idx >= 0) list.splice(idx, 1);
      list.unshift({ word: String(word), meaning: info.meaning, book: info.bookName, lang: info.lang, at: now });
      if (list.length > 500) list.length = 500;
    }
    lg.wrong += 1;
  }
  if (isNew) lg.new += 1; else lg.review += 1;
  saveAccounts();
  return { ok: true, lv: p.lv, due: p.due, ease: ease, mastered: p.lv >= MASTER_LV, removed, isNew };
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
/* 房号规范化：去空格 + 转大写。
   此前只有 /api/join 做了规范化，而 /api/start、/api/answer、/api/ready、/api/state、
   /api/stream 等直接拿原始值查 rooms，导致用户手输小写房号时
   「能进房间，但开始 / 答题 / 准备全部报 404 房间不存在」。统一走这里，杜绝此类不一致。 */
function roomIdOf(v) { return String(v || '').trim().toUpperCase(); }
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
const MAX_BODY = 20 * 1024 * 1024; // 20MB：备份恢复等大请求也能容纳，超过才拒绝（L7）
function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    let tooBig = false;
    req.on('data', (c) => { b += c; if (b.length > MAX_BODY) { tooBig = true; req.destroy(); } });
    req.on('end', () => {
      if (tooBig) return resolve({ __tooLarge: true });
      try { resolve(b ? JSON.parse(b) : {}); } catch (e) { resolve({ __invalid: true }); }
    });
    req.on('error', () => resolve({}));
  });
}
/* 频率限制（L2，防暴力破解）：
   - 登录：只统计「失败」次数（用户名/密码错）。同一 IP 10 分钟内失败超 30 次才封禁，
     正常多账号注册/登录不会被误伤；暴力破解几乎全是失败尝试，会被有效拖慢。
   - 注册：同一 IP 10 分钟内最多 50 次，防批量注册垃圾账号。 */
const loginFails = new Map();   // ip -> { count, first }
const regFails = new Map();     // ip -> { count, first }
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}
function _throttleBucket(map, ip) {
  const now = Date.now();
  let e = map.get(ip);
  if (!e || now - e.first > 10 * 60 * 1000) { e = { count: 0, first: now }; map.set(ip, e); }
  return e;
}
function noteLoginFailure(ip) { _throttleBucket(loginFails, ip).count += 1; }
function loginThrottled(ip) { return _throttleBucket(loginFails, ip).count > 30; }
function registerThrottled(ip) { return _throttleBucket(regFails, ip).count > 50; }
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
  const book = BOOKS.find((b) => b.id === bookId)
    || BOOKS.find((b) => b.id === DEFAULT_PK_BOOK)
    || BOOKS[0];
  // 默认玩家按 4000+ 词汇量处理：非基础词书里剔除「中考/高考/四级/四级核心」这些已掌握的简单词，
  // 让 PK 题库聚焦在更难、更值得练的词上；基础词书本身则保留全部词（用户明确选了入门词书就照给）。
  const isFoundation = FOUNDATION_BOOK_IDS.includes(book.id);
  const words = isFoundation
    ? book._words
    : book._words.filter((w) => !KNOWN_SIMPLE_WORDS.has(String(w.word || '').toLowerCase()));
  const byPos = new Map();
  for (const w of words) {
    if (!byPos.has(w.pos)) byPos.set(w.pos, []);
    byPos.get(w.pos).push(w);
  }
  const pool = shuffle(words).slice(0, Math.min(count, words.length));
  return pool.map((w) => {
    // 干扰项从「过滤后的词表」里取，避免把已剔除的简单词当干扰项又放出来；
    // 优先取同词性词条（无法按词性排除，迷惑性更强）；不足 3 个再从全书补
    let candidates = [];
    if (w.pos && byPos.has(w.pos)) {
      candidates = byPos.get(w.pos).filter((x) => x.word !== w.word && x.meaning !== w.meaning);
    }
    if (candidates.length < 3) {
      candidates = candidates.concat(
        words.filter((x) => x.word !== w.word && x.meaning !== w.meaning)
      );
    }
    const seen = new Set([w.meaning]);
    const distract = [];
    for (const x of shuffle(candidates)) {
      if (seen.has(x.meaning)) continue;
      if (!isValidMeaning(x.meaning)) continue; // 防御：跳过无效释义（"n." 等脏数据）
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
    phase: 'lobby',            // lobby | countdown | question | reveal | result
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
    countdownEndsAt: 0,        // 开局 3 秒倒计时的结束时刻（phase === 'countdown' 时有效）
    history: [],               // 本局每题结果，供结算「单词总览面板」使用
  };
  rooms.set(id, room);
  return room;
}

function addPlayer(room, name, isHost, username) {
  const id = uid();
  room.players.set(id, { id, name, username: username || '', score: 0, correctCount: 0, isHost: !!isHost, isNew: true, res: null, ping: null, lastSeen: Date.now(), seenInRound: false, ready: false });
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
      id: p.id, name: p.name,
      // 账号名（小写）：房间内点名字即可一键加好友，无需搜索。
      // 匿名/未登录加入的玩家没有账号名，前端会隐藏加好友入口。
      username: p.username ? String(p.username).toLowerCase() : '',
      score: p.score, correctCount: p.correctCount,
      isHost: p.isHost, isNew: p.isNew, connected: isOnline(p), answered: room.answered.has(p.id),
      ready: !!p.ready,
    })),
    you: playerId,
    /* 准备状态只看【非房主】玩家：房主点「开始」本身就代表他准备好了，
       再要求房主点一次准备纯属多余（单人房更是荒谬）。
       房间里只有房主一人时，非房主集合为空 → allReady=true，可直接开始。 */
    allReady: [...room.players.values()].filter((p) => !p.isHost).every((p) => p.ready),
  };
  // 开局倒计时：所有人都能看到同一个「3、2、1」，避免各端计时不一致造成的抢跑
  if (room.phase === 'countdown') v.countdownEndsAt = room.countdownEndsAt;
  // 结算阶段：带上本局单词总览（供「一键加生词本」面板使用）
  if (room.phase === 'result') v.history = room.history || [];
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

const COUNTDOWN_MS = 3000;
/* 开局 3 秒倒计时：先进入 countdown 阶段广播给所有人，到点再真正发题。
   用服务端统一的时间戳，保证各端看到的「3、2、1」一致，不会有人抢跑。 */
function startCountdown(room) {
  clearTimeout(room.timer);
  room.phase = 'countdown';
  room.countdownEndsAt = Date.now() + COUNTDOWN_MS;
  broadcast(room);
  room.timer = setTimeout(() => { if (room.phase === 'countdown') startGame(room); }, COUNTDOWN_MS);
}
function startGame(room) {
  clearTimeout(room.timer);
  room.questions = genQuestions(room.settings.bookId, room.settings.count);
  room.qIndex = -1;
  room.lastResult = null;
  room.history = [];           // 本局每题结果（结算面板用）
  room.countdownEndsAt = 0;
  for (const p of room.players.values()) { p.score = 0; p.correctCount = 0; p.isNew = false; p.ready = false; }
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
function recordWrong(player, q, bookName, lang, at) {
  if (!player || !player.username) return;
  const account = accounts[String(player.username).toLowerCase()];
  if (!account) return;
  const key = String(q.word).toLowerCase();
  // 已移入熟词本（已掌握/已会）的词，即便 PK 答错也不应被拉回生词本，也不重置已掌握的进度。
  // 否则熟词本会“偷偷失效”——用户在单词学习里点过的熟词，打一局 PK 答错就又冒出来。
  if (account.known && account.known.some((x) => String(x.word).toLowerCase() === key)) return;
  const list = account.words = account.words || [];
  const idx = list.findIndex((x) => String(x.word).toLowerCase() === key);
  if (idx >= 0) list.splice(idx, 1);
  list.unshift({ word: q.word, meaning: q.meaning, book: bookName || '', lang: lang || 'en', at });
  if (list.length > 500) list.length = 500;
  // PK 答错同步刷新学习进度：已学过的词记忆等级归零，尽快进入复习队列
  if (account.study && account.study.progress && account.study.progress[key]) {
    const pr = account.study.progress[key];
    pr.lv = 0; pr.wrong = (pr.wrong || 0) + 1; pr.due = Date.now() + WRONG_REDUE;
  }
  saveAccounts();
}

/* 智能复习队列：按「遗忘曲线 + 错误率」综合打分，挑出此刻最该复习的词。
   分数越高越紧急：超期时长（小时）+ 错误次数×3 + (3-掌握等级)×2 —— 越久没看、越常错、越不熟，越靠前。
   来源：① 生词本中未掌握的词 ② 学习进度里已到期需巩固的词。
   若到期的都复习完了，则退而取「最薄弱」的词继续巩固，并在 stats.caughtUp 标记，前端可提示。 */
function buildReviewQueue(acc, st, limit) {
  const now = Date.now();
  const pr = st.progress || {};
  const knownSet = knownSetOf(acc);
  const planBook = resolveBook(acc, st.plan && st.plan.bookId);
  const cands = [];
  const seen = new Set();
  const scoreOf = (p) => {
    if (!p) return 1000;                                   // 完全没学过：最优先
    const overdueH = p.due ? Math.max(0, now - p.due) / 3600000 : 999;
    return overdueH + (p.wrong || 0) * 3 + (3 - Math.min(p.lv || 0, 3)) * 2;
  };
  // ① 生词本（用户明确标记要背的），跳过已掌握 / 已移入熟词本
  for (const x of (acc.words || [])) {
    const k = wordKey(x.word);
    if (seen.has(k)) continue;
    if (knownSet.has(k)) continue;                          // 已在熟词本，不应再复习
    const p = pr[k];
    if (p && (p.lv || 0) >= MASTER_LV) continue;            // 已掌握，不再进复习
    seen.add(k);
    cands.push({ word: x.word, meaning: x.meaning, lang: x.lang || 'en', score: scoreOf(p), due: (p && p.due) || 0, lv: (p && p.lv) || 0, wrong: (p && p.wrong) || 0, src: 'wrong' });
  }
  // ② 学习进度中已到期、未掌握的词
  for (const [k, p] of Object.entries(pr)) {
    if (!p || !p.n || (p.lv || 0) >= MASTER_LV) continue;
    if (seen.has(k)) continue;
    if (knownSet.has(k)) continue;                          // 已在熟词本，不再复习
    if (p.due && p.due > now) continue;                     // 还没到复习时间
    const card = wordCard(k, planBook);
    if (!card) continue;
    seen.add(k);
    cands.push({ word: card.word, meaning: card.meaning, lang: (p.lang) || card.lang || 'en', score: scoreOf(p), due: p.due || 0, lv: p.lv || 0, wrong: p.wrong || 0, src: 'srs' });
  }
  cands.sort((a, b2) => b2.score - a.score);
  // 统计：到期数 = 已过复习时间的；薄弱词 = 错过 1 次以上的
  let dueCount = 0, weakCount = 0;
  for (const c of cands) {
    if (!c.due || c.due <= now) dueCount += 1;
    if (c.wrong >= 1) weakCount += 1;
  }
  const picked = cands.slice(0, Math.max(1, Math.min(200, limit || 50)));
  return {
    queue: picked.map((c) => ({ word: c.word, meaning: c.meaning, lang: c.lang })),
    stats: {
      total: cands.length,          // 待复习总数
      picked: picked.length,        // 本组数量
      dueCount: dueCount,           // 已到期
      weakCount: weakCount,         // 易错词
      wrongCount: (acc.words || []).length,
      caughtUp: dueCount === 0 && cands.length > 0, // 到期的都复习完了，本组是额外巩固
    },
  };
}
/* 复习概览统计（供首页/复习入口展示「还有多少词要复习」） */
function reviewStats(acc) {
  const st = getStudy(acc);
  const now = Date.now();
  let due = 0, weak = 0, mastered = 0;
  for (const p of Object.values(st.progress || {})) {
    if (!p || !p.n) continue;
    if ((p.lv || 0) >= MASTER_LV) { mastered += 1; continue; }
    if (!p.due || p.due <= now) due += 1;
    if ((p.wrong || 0) >= 1) weak += 1;
  }
  // 生词本里还没进学习进度（完全没学过）的词，也该算「待复习」
  for (const x of (acc.words || [])) {
    const p = (st.progress || {})[wordKey(x.word)];
    if (!p || !p.n) due += 1;
  }
  return { due: due, weak: weak, mastered: mastered, wordbookCount: (acc.words || []).length };
}

function reveal(room) {
  clearTimeout(room.timer);
  if (room.phase !== 'question') return;
  room.phase = 'reveal';
  const q = room.questions[room.qIndex];
  const bookName = (BOOKS.find((b) => b.id === room.settings.bookId) || {}).name || '';
  const bookLang = (BOOKS.find((b) => b.id === room.settings.bookId) || {}).lang || 'en';
  const now = Date.now();
  const results = {};
  for (const [pid, a] of room.answered) {
    const correct = a.choice === q.correctIndex;
    results[pid] = { choice: a.choice, correct, gained: a.gained };
    if (!correct) recordWrong(room.players.get(pid), q, bookName, bookLang, now);
  }
  // 超时未答也算生词（在线玩家，或本题期间见过但中途掉线的玩家）
  for (const p of room.players.values()) {
    if ((isOnline(p) || p.seenInRound) && !room.answered.has(p.id)) recordWrong(p, q, bookName, bookLang, now);
  }
  room.lastResult = { qIndex: room.qIndex, correctIndex: q.correctIndex, word: q.word, meaning: q.meaning, results };
  /* 记录本局每一题：结算时给出一个「单词总览面板」，可勾选任意词加入生词本
     （包括答对的词——想再巩固也可以，这是对「只能记错词」的补充）。 */
  if (!Array.isArray(room.history)) room.history = [];
  room.history.push({
    qIndex: room.qIndex,
    word: q.word,
    meaning: q.meaning,
    lang: bookLang,
    bookName: bookName,
    options: q.options,
    correctIndex: q.correctIndex,
    results: results,   // playerId -> {choice, correct, gained}（前端可用 v.you 取自己的）
  });
  broadcast(room);
  room.timer = setTimeout(() => nextQuestion(room), REVEAL_MS);
}

function handleAnswer(room, pid, qIndex, choice) {
  if (room.phase !== 'question') return;
  if (qIndex !== room.qIndex || room.answered.has(pid)) return;
  const p = room.players.get(pid);
  if (!p) return;
  const q = room.questions[room.qIndex];
  // 选项下标必须落在本题选项范围内；伪造的越界值直接拒绝，避免记出「答错」的生词（B3）
  if (!q || !Number.isInteger(choice) || choice < 0 || choice >= q.options.length) return;
  p.lastSeen = Date.now();
  p.seenInRound = true;
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

/* ================= 数据安全：过期会话清理 + 本地每日快照 =================
 * 目的（需求 3）：版本更新 / 重启 / 部署都不该清空用户数据。
 *  · 过期会话：sessions 只增不减会让 accounts.json 之外的 sessions.json 无限膨胀，
 *    定期清理掉 30 天免登录窗口已过期的令牌。
 *  · 每日快照：把 accounts / groups / sessions / vocabRank 存成 store/snapshot-日期.json，
 *    保留最近 7 份。未配置云端 KV 时，若主数据文件因故丢失（误删/迁移/磁盘被清），
 *    启动阶段会自动用最近一份快照恢复，而不是让所有用户「凭空变成新账号」。 */
function pruneSessions() {
  const now = Date.now();
  const LIMIT = 30 * 24 * 3600 * 1000;
  let n = 0;
  for (const [tk, s] of Object.entries(sessions)) {
    if (!s || !s.at || now - s.at > LIMIT) { delete sessions[tk]; n += 1; }
  }
  if (n) { saveSessions(); console.log('[存储] 已清理过期会话 ' + n + ' 条'); }
}
const SNAP_KEEP = 7;
function snapshotFile(dateStr) { return path.join(STORE, 'snapshot-' + dateStr + '.json'); }
function writeSnapshot() {
  try {
    const dateStr = dayKey(Date.now());
    const f = snapshotFile(dateStr);
    // 同一天直接覆盖：让「今天的快照」最多只有 6 小时延迟，恢复时丢的数据更少
    const snap = { at: Date.now(), date: dateStr, accounts: accounts, groups: groups, sessions: sessions, vocabRank: vocabRank };
    saveJSON(f, snap, accountsReplacer);
    const files = fs.readdirSync(STORE).filter((x) => /^snapshot-\d{4}-\d{2}-\d{2}\.json$/.test(x)).sort();
    while (files.length > SNAP_KEEP) {
      const old = files.shift();
      try { fs.unlinkSync(path.join(STORE, old)); } catch (e) {}
    }
    console.log('[存储] 已写入每日快照 ' + dateStr);
  } catch (e) { console.error('[存储] 快照失败', (e && e.message) || e); }
}
/* 启动时：主数据为空但有本地快照 → 自动恢复（仅本地模式有意义；云端模式以 KV 为准） */
function restoreFromSnapshot() {
  try {
    const files = fs.readdirSync(STORE).filter((x) => /^snapshot-\d{4}-\d{2}-\d{2}\.json$/.test(x)).sort();
    if (!files.length) return false;
    const snap = loadJSON(path.join(STORE, files[files.length - 1]), null);
    if (!snap || typeof snap !== 'object') return false;
    let restored = false;
    const snapAcc = (snap.accounts && typeof snap.accounts === 'object') ? Object.keys(snap.accounts).length : 0;
    const snapGrp = (snap.groups && typeof snap.groups === 'object') ? Object.keys(snap.groups).length : 0;
    if (!Object.keys(accounts).length && snapAcc) { accounts = snap.accounts; restored = true; }
    if (!Object.keys(groups).length && snapGrp) { groups = snap.groups; restored = true; }
    // 注意：秩榜是数组，必须判断「快照里有内容」再回填，否则空数组也会误报「已恢复」
    if (!vocabRank.length && Array.isArray(snap.vocabRank) && snap.vocabRank.length) { vocabRank = snap.vocabRank; restored = true; }
    if (restored) {
      saveJSON(ACCOUNTS_FILE, accounts, accountsReplacer);
      saveJSON(GROUPS_FILE, groups);
      saveJSON(RANK_FILE, vocabRank);
      console.log('[存储] ⚠️ 数据文件为空，已从快照 ' + files[files.length - 1] + ' 自动恢复（账号 ' + Object.keys(accounts).length + ' 个）');
    }
    return restored;
  } catch (e) { return false; }
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

/* 每 6 小时：清理过期会话 + 写一次每日快照（本地文件模式下的数据保命底牌） */
setInterval(() => {
  try { pruneSessions(); writeSnapshot(); } catch (e) {}
  // 云端模式下同步刷新「全量快照」，让自愈源不至于过旧
  if (kvUsable) kvSet('__full__', { accounts: accounts, groups: groups, sessions: sessions, vocabRank: vocabRank, at: Date.now() });
}, 6 * 3600 * 1000);
setTimeout(() => { try { pruneSessions(); writeSnapshot(); } catch (e) {} }, 30000);

/* ---------------- HTTP 服务 ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

/* ===================== 作者反馈：存储 + 频率限制 + 极简 SMTP ===================== */
const feedbackHits = new Map();   // ip -> { count, first }：每 IP 每小时最多 12 条，防刷
function feedbackThrottled(ip) {
  const now = Date.now();
  let e = feedbackHits.get(ip);
  if (!e || now - e.first > 3600 * 1000) { feedbackHits.set(ip, { count: 1, first: now }); return false; }
  e.count++;
  return e.count > 12;
}
let feedbackMem = [];             // 内存兜底（最近 100 条），文件才是主存储
function ensureFeedbackDir() { try { if (!fs.existsSync(FEEDBACK_DIR)) fs.mkdirSync(FEEDBACK_DIR, { recursive: true }); } catch (e) {} }
const FEEDBACK_FILE = path.join(FEEDBACK_DIR, 'feedback.jsonl');
function saveFeedback(rec) {
  feedbackMem.push(rec);
  if (feedbackMem.length > 100) feedbackMem = feedbackMem.slice(-100);
  try {
    ensureFeedbackDir();
    fs.appendFileSync(FEEDBACK_FILE, JSON.stringify(rec) + '\n', 'utf8');
  } catch (e) { console.error('[反馈] 写入本地失败', (e && e.message) || e); }
}
function recentFeedback() {
  try {
    if (fs.existsSync(FEEDBACK_FILE)) {
      const lines = fs.readFileSync(FEEDBACK_FILE, 'utf8').trim().split(/\r?\n/).filter(Boolean);
      const arr = lines.map(function (l) { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
      return arr.slice(-50).reverse();
    }
  } catch (e) {}
  return feedbackMem.slice().reverse();
}

function b64(s) { return Buffer.from(s, 'utf8').toString('base64'); }

// 读取一条 SMTP 响应（兼容多行 250-.../250 结尾），遇到「<3位码> 」（空格）即视为结束
function smtpRead(sock) {
  return new Promise(function (resolve, reject) {
    let acc = '';
    function onData(c) {
      acc += c.toString('binary');
      const lines = acc.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (/^\d{3} /.test(lines[i])) {
          const code = parseInt(lines[i].slice(0, 3), 10);
          sock.removeListener('data', onData);
          resolve({ code: code, text: acc });
          return;
        }
      }
    }
    sock.on('data', onData);
    sock.once('error', function (e) { sock.removeListener('data', onData); reject(e); });
  });
}
function smtpWrite(sock, line) {
  return new Promise(function (resolve, reject) {
    sock.write(line + '\r\n', function (err) { if (err) reject(err); else resolve(); });
  });
}
function buildFeedbackMime(opts) {
  const boundary = 'vocabpkfb' + Date.now();
  const now = new Date().toUTCString();
  const meta = (opts.meta && opts.meta.at || '') + '\n来源账号：' + ((opts.meta && opts.meta.user) || '未登录') +
    '\nIP：' + ((opts.meta && opts.meta.ip) || '') + '\nUA：' + ((opts.meta && opts.meta.ua) || '');
  const body = '【用户反馈】\n' + meta + '\n\n' + (opts.text || '') + '\n';
  const parts = [];
  parts.push('Date: ' + now);
  parts.push('From: ' + SMTP.from);
  parts.push('To: ' + FEEDBACK_TO);
  parts.push('Subject: =?UTF-8?B?' + b64(opts.subject || 'vocab-pk 反馈') + '?=');
  parts.push('Message-ID: <' + Date.now() + '.' + Math.random().toString(36).slice(2) + '@vocab-pk>');
  parts.push('MIME-Version: 1.0');
  parts.push('Content-Type: multipart/mixed; boundary="' + boundary + '"');
  parts.push('');
  parts.push('--' + boundary);
  parts.push('Content-Type: text/plain; charset=UTF-8');
  parts.push('Content-Transfer-Encoding: 8bit');
  parts.push('');
  parts.push(body);
  if (opts.imageBase64) {
    const ext = (opts.imageType === 'jpeg') ? 'jpg' : (opts.imageType || 'png');
    const mimeType = (opts.imageType === 'jpeg') ? 'image/jpeg' : ('image/' + (opts.imageType || 'png'));
    parts.push('--' + boundary);
    parts.push('Content-Type: ' + mimeType + '; name="screenshot.' + ext + '"');
    parts.push('Content-Transfer-Encoding: base64');
    parts.push('Content-Disposition: attachment; filename="screenshot.' + ext + '"');
    parts.push('');
    const b64str = opts.imageBase64;
    let wrapped = '';
    for (let i = 0; i < b64str.length; i += 76) wrapped += b64str.slice(i, i + 76) + '\r\n';
    parts.push(wrapped.replace(/\r\n$/, ''));
  }
  parts.push('--' + boundary + '--');
  return parts.join('\r\n');
}
/* 极简 SMTP 客户端（零依赖，仅用内置 tls/net）。返回 true=已发送，false=未发送/失败。
   调用方不必判返回值——反馈已落本地；邮件只是锦上添花。 */
async function sendFeedbackEmail(opts) {
  if (!SMTP_READY) { console.log('[反馈] SMTP 未配置，跳过邮件（反馈已写入本地 feedback.jsonl）'); return false; }
  let sock = null;
  try {
    if (SMTP_SECURE) {
      sock = tls.connect({ host: SMTP.host, port: SMTP.port, rejectUnauthorized: true, timeout: 15000 });
    } else {
      sock = net.connect({ host: SMTP.host, port: SMTP.port, timeout: 15000 });
    }
    await new Promise(function (res, rej) {
      sock.once('secureConnect', res); sock.once('connect', res);
      sock.once('error', rej);
      sock.once('timeout', function () { rej(new Error('SMTP 连接超时')); });
    });
    let r = await smtpRead(sock);
    if (r.code !== 220) throw new Error('握手失败 ' + r.code);
    await smtpWrite(sock, 'EHLO vocabpk');
    r = await smtpRead(sock);
    if (r.code !== 250) throw new Error('EHLO 失败 ' + r.code);
    if (!SMTP_SECURE) {                 // STARTTLS 升级
      await smtpWrite(sock, 'STARTTLS');
      r = await smtpRead(sock);
      if (r.code !== 220) throw new Error('STARTTLS 失败 ' + r.code);
      sock = tls.connect({ socket: sock, rejectUnauthorized: true });
      await new Promise(function (res, rej) { sock.once('secureConnect', res); sock.once('error', rej); });
      await smtpWrite(sock, 'EHLO vocabpk');
      r = await smtpRead(sock);
      if (r.code !== 250) throw new Error('TLS 后 EHLO 失败 ' + r.code);
    }
    await smtpWrite(sock, 'AUTH LOGIN');
    r = await smtpRead(sock);
    if (r.code !== 334) throw new Error('AUTH 失败 ' + r.code);
    await smtpWrite(sock, b64(SMTP.user));
    r = await smtpRead(sock);
    if (r.code !== 334) throw new Error('用户名被拒 ' + r.code);
    await smtpWrite(sock, b64(SMTP.pass));
    r = await smtpRead(sock);
    if (r.code !== 235) throw new Error('密码被拒（Gmail 请用「应用专用密码」而非登录密码）');
    await smtpWrite(sock, 'MAIL FROM:<' + SMTP.from + '>');
    r = await smtpRead(sock);
    if (r.code !== 250) throw new Error('MAIL FROM 失败 ' + r.code);
    await smtpWrite(sock, 'RCPT TO:<' + FEEDBACK_TO + '>');
    r = await smtpRead(sock);
    if (r.code !== 250) throw new Error('RCPT TO 失败 ' + r.code);
    await smtpWrite(sock, 'DATA');
    r = await smtpRead(sock);
    if (r.code !== 354) throw new Error('DATA 失败 ' + r.code);
    const raw = buildFeedbackMime(opts);
    const stuffed = raw.split('\r\n').map(function (l) { return l.charAt(0) === '.' ? '.' + l : l; }).join('\r\n');
    await new Promise(function (res, rej) { sock.write(stuffed + '\r\n.\r\n', function (err) { if (err) rej(err); else res(); }); });
    r = await smtpRead(sock);
    if (r.code !== 250) throw new Error('发送失败 ' + r.code);
    await smtpWrite(sock, 'QUIT').catch(function () {});
    try { sock.end(); } catch (e) {}
    return true;
  } catch (e) {
    console.error('[反馈] 邮件发送异常:', (e && e.message) || e);
    try { if (sock && sock.destroy) sock.destroy(); } catch (e2) {}
    return false;
  }
}

function serveStatic(req, res) {
  let p;
  try { p = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); } catch (e) { p = '/'; }
  if (p === '/') p = '/index.html';
  const fp = path.normalize(path.join(PUB, p));
  // 必须带路径分隔符，否则 "publicXXX" 这类同级目录会被 startsWith 误判放行（L5）
  if (fp !== PUB && !fp.startsWith(PUB + path.sep)) { send(res, 403, { error: 'forbidden' }); return; }
  fs.readFile(fp, (err, data) => {
    if (err) { send(res, 404, { error: 'not found' }); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;
  try {
    if (req.method === 'GET' && p === '/api/books') {
      return send(res, 200, { books: BOOKS.map((b) => ({ id: b.id, name: b.name, count: b.words.length, lang: b.lang })), defaultPkBook: DEFAULT_PK_BOOK });
    }
    if (req.method === 'GET' && p === '/api/info') {
      let publicUrl = '';
      try { publicUrl = fs.readFileSync('store/public-url.txt', 'utf8').trim(); } catch (e) {}
      return send(res, 200, { port: PORT, ips: lanIPs(), publicUrl, storeMode: kvUsable ? 'upstash' : 'local' });
    }
    /* 公开诊断端点（只暴露数量与字节数，不泄露任何用户名/密码/内容）：
       用于排查「部署后账号消失」——可看出云端到底有没有数据、数据多大、写入是否报错。 */
    if (req.method === 'GET' && p === '/api/diag') {
      let cloud = { ok: false, error: 'not-attempted' };
      try { cloud = await kvGet('accounts', 1, 8000); } catch (e) { cloud = { ok: false, error: String(e && e.message) }; }
      const memStr = JSON.stringify(accounts);
      const cloudVal = (cloud && cloud.found && cloud.value) ? cloud.value : null;
      return send(res, 200, {
        ok: true,
        version: APP_VERSION,
        storeMode: kvUsable ? 'upstash' : 'local',
        kvConfigured: KV_ON,
        kvUsable: kvUsable,
        kvLastError: kvLastError || null,
        memAccountCount: Object.keys(accounts).length,
        memAccountsKB: +(Buffer.byteLength(memStr) / 1024).toFixed(1),
        cloudOk: !!(cloud && cloud.ok),
        cloudFound: !!(cloud && cloud.found),
        cloudError: (cloud && cloud.error) || null,
        cloudAccountCount: cloudVal ? Object.keys(cloudVal).length : 0,
        cloudAccountsKB: cloudVal ? +(Buffer.byteLength(JSON.stringify(cloudVal)) / 1024).toFixed(1) : 0,
        leaseOwner: leaseOwner,
        serverTime: new Date().toISOString(),
      });
    }
    /* 只读诊断端点：返回某词书生成的 PK 题目样例（复用 genQuestions 真实逻辑）。
       仅暴露公开词书里的「词 + 释义 + 选项」（books.json 本就是公开静态文件），不泄露任何账号数据。
       用途：验证「默认词书 / 简单词剔除」等出题规则是否生效，无需开整局对战。 */
    if (req.method === 'GET' && p === '/api/diag/questions') {
      const q = u.searchParams;
      const bookId = q.get('bookId') || '';
      const count = [10, 20, 30].includes(Number(q.get('count'))) ? Number(q.get('count')) : 30;
      const qs = genQuestions(bookId, count);
      const book = BOOKS.find((b) => b.id === bookId) || BOOKS.find((b) => b.id === DEFAULT_PK_BOOK) || BOOKS[0];
      return send(res, 200, { bookId: book.id, bookName: book.name, requested: bookId, count: qs.length, questions: qs });
    }
    // ---------------- 账号系统接口 ----------------
    if (req.method === 'POST' && p === '/api/register') {
      const b = await readBody(req);
      if (b.__tooLarge) return send(res, 413, { error: '请求体过大' });
      if (registerThrottled(clientIp(req))) return send(res, 429, { error: '注册过于频繁，请稍后再试' });
      const username = String(b.username || '').trim();
      const password = String(b.password || '');
      const name = String(b.name || '').trim().slice(0, 12);
      if (!RE_USER.test(username)) return send(res, 400, { error: '用户名需 3-16 位字母/数字/下划线' });
      if (password.length < 6) return send(res, 400, { error: '密码至少 6 位' });
      if (accounts[username.toLowerCase()]) return send(res, 409, { error: '用户名已被占用' });
      const salt = crypto.randomBytes(16).toString('hex');
      accounts[username.toLowerCase()] = {
        username, salt, hash: hashPassword(password, salt),
        name: name || username, createdAt: Date.now(), words: [], known: [], customBooks: [],
      };
      saveAccounts();
      const token = newSession(username);
      return send(res, 200, { token, username, name: name || username });
    }
    if (req.method === 'POST' && p === '/api/login') {
      const b = await readBody(req);
      if (b.__tooLarge) return send(res, 413, { error: '请求体过大' });
      const ip = clientIp(req);
      if (loginThrottled(ip)) return send(res, 429, { error: '登录尝试过于频繁，请稍后再试' });
      const username = String(b.username || '').trim().toLowerCase();
      const password = String(b.password || '');
      const acc = accounts[username];
      if (!acc) {
        /* 明确区分「账号不存在」与「密码错误」。以前两者混为一句话，
           导致「数据被清空」和「单纯记错密码」无法分辨，排查更新丢号问题时极其困难。 */
        console.log('[登录失败] 账号不存在 user=' + username +
          ' · 当前账号总数=' + Object.keys(accounts).length +
          ' · 存储模式=' + (kvUsable ? 'cloud' : 'local') +
          ' · 云端错误=' + (kvLastError || '无'));
        noteLoginFailure(ip);
        return send(res, 401, { error: '账号不存在（若刚更新过版本，可能是数据尚未同步，请稍候重试）' });
      }
      if (!acc.hash || !acc.salt) {
        console.log('[登录失败] 账号数据损坏（缺 hash/salt） user=' + username + ' · 存储模式=' + (kvUsable ? 'cloud' : 'local'));
        noteLoginFailure(ip);
        return send(res, 401, { error: '账号数据异常，请联系管理员修复' });
      }
      if (acc.hash !== hashPassword(password, acc.salt)) {
        noteLoginFailure(ip);
        return send(res, 401, { error: '密码不正确' });
      }
      const token = newSession(username);
      return send(res, 200, { token, username: acc.username, name: acc.name });
    }
    if (req.method === 'GET' && p === '/api/me') {
      const acc = authUser(tokenOf(req, u));
      if (!acc) return send(res, 401, { error: '未登录' });
      return send(res, 200, { username: acc.username, name: acc.name });
    }
    if (req.method === 'POST' && p === '/api/me') {
      const b = await readBody(req);
      const acc = authUser(tokenOf(req, u, b));
      if (!acc) return send(res, 401, { error: '未登录' });
      const name = String(b.name || '').trim().slice(0, 12);
      if (name) { acc.name = name; saveAccounts(); }
      return send(res, 200, { ok: true, name: acc.name });
    }
    if (req.method === 'POST' && p === '/api/me/password') {
      const b = await readBody(req);
      const acc = authUser(tokenOf(req, u, b));
      if (!acc) return send(res, 401, { error: '未登录' });
      const oldPassword = String(b.oldPassword || '');
      const newPassword = String(b.newPassword || '');
      if (!oldPassword || acc.hash !== hashPassword(oldPassword, acc.salt)) return send(res, 403, { error: '当前密码错误' });
      if (newPassword.length < 6) return send(res, 400, { error: '新密码至少 6 位' });
      acc.salt = crypto.randomBytes(16).toString('hex');
      acc.hash = hashPassword(newPassword, acc.salt);
      // 改密码后让该用户所有会话（含其他设备）失效，防止旧会话被劫持后长期可用（L6）
      const lower = acc.username.toLowerCase();
      for (const [tk, s] of Object.entries(sessions)) {
        if (String(s.username).toLowerCase() === lower) delete sessions[tk];
      }
      saveSessions();
      saveAccounts();
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/logout') {
      const b = await readBody(req);
      if (b.token && sessions[b.token]) { delete sessions[b.token]; saveSessions(); }
      return send(res, 200, { ok: true });
    }

    /* ================= 好友 / 单词小组 / PK 邀请 ================= */
    // 给任意用户名算一份「对外可见」的学习概览（今日打卡、连续天数、最近活跃、是否在线）
    function publicStudy(username) {
      const acc = accounts[String(username).toLowerCase()];
      if (!acc) return null;
      const st = getStudy(acc);
      const lg = st.log[dayKey(Date.now())] || { new: 0, review: 0, wrong: 0 };
      let lastActive = null;
      for (const d of Object.keys(st.log)) {
        if ((st.log[d].new + st.log[d].review) > 0 && (!lastActive || d > lastActive)) lastActive = d;
      }
      return {
        today: { new: lg.new, review: lg.review, wrong: lg.wrong },
        streak: streakOf(st),
        lastActive,
        online: isUserOnlineInRooms(username),
      };
    }
    function isUserOnlineInRooms(username) {
      const u = String(username).toLowerCase();
      for (const room of rooms.values()) {
        for (const p of room.players.values()) {
          if ((p.username || '').toLowerCase() === u && isOnline(p)) return true;
        }
      }
      return false;
    }
    function friendList(acc) {
      const friends = (acc.friends || []).slice();
      return friends.map(function (un) {
        const a = accounts[un]; const s = publicStudy(un);
        return {
          username: un, name: a ? a.name : un,
          today: s ? s.today : { new: 0, review: 0, wrong: 0 },
          streak: s ? s.streak : 0, lastActive: s ? s.lastActive : null, online: s ? s.online : false,
        };
      });
    }
    function groupView(gid, me) {
      const g = groups[gid]; if (!g) return null;
      const members = g.members.map(function (un) {
        const a = accounts[un]; const s = publicStudy(un);
        return {
          username: un, name: a ? a.name : un, isOwner: un === g.owner,
          today: s ? s.today : { new: 0, review: 0, wrong: 0 },
          streak: s ? s.streak : 0, lastActive: s ? s.lastActive : null, online: s ? s.online : false,
        };
      });
      return { id: g.id, name: g.name, owner: g.owner, code: g.code, isOwner: g.owner === String(me).toLowerCase(), members };
    }
    function genGroupCode() {
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      let code;
      do {
        code = '';
        for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
      } while (Object.values(groups).some((g) => g.code === code));
      return code;
    }

    if (req.method === 'POST' && p === '/api/friend') {
      const b = await readBody(req);
      const acc = authUser(tokenOf(req, u, b));
      if (!acc) return send(res, 401, { error: '请先登录' });
      const target = String(b.username || '').trim().toLowerCase();
      if (!RE_USER.test(target)) return send(res, 400, { error: '用户名需 3-16 位字母/数字/下划线' });
      if (target === acc.username.toLowerCase()) return send(res, 400, { error: '不能添加自己为好友' });
      if (!accounts[target]) return send(res, 404, { error: '用户不存在' });
      acc.friends = acc.friends || [];
      if (!acc.friends.includes(target)) { acc.friends.push(target); saveAccounts(); }
      return send(res, 200, { ok: true, friends: friendList(acc) });
    }
    if (req.method === 'DELETE' && p === '/api/friend') {
      const acc = authUser(tokenOf(req, u));
      if (!acc) return send(res, 401, { error: '请先登录' });
      const target = String(u.searchParams.get('username') || '').trim().toLowerCase();
      acc.friends = (acc.friends || []).filter((x) => x !== target);
      saveAccounts();
      return send(res, 200, { ok: true, friends: friendList(acc) });
    }
    if (req.method === 'GET' && p === '/api/friends') {
      const acc = authUser(tokenOf(req, u));
      if (!acc) return send(res, 401, { error: '请先登录' });
      return send(res, 200, { friends: friendList(acc) });
    }
    if (req.method === 'POST' && p === '/api/group') {
      const b = await readBody(req);
      const acc = authUser(tokenOf(req, u, b));
      if (!acc) return send(res, 401, { error: '请先登录' });
      const name = String(b.name || '').trim().slice(0, 20);
      if (!name) return send(res, 400, { error: '小组名不能为空' });
      const id = 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      groups[id] = { id, name, owner: acc.username.toLowerCase(), members: [acc.username.toLowerCase()], code: genGroupCode(), createdAt: Date.now() };
      saveGroups();
      return send(res, 200, { ok: true, group: groupView(id, acc.username) });
    }
    if (req.method === 'POST' && p === '/api/group/join') {
      const b = await readBody(req);
      const acc = authUser(tokenOf(req, u, b));
      if (!acc) return send(res, 401, { error: '请先登录' });
      const code = String(b.code || '').trim().toUpperCase();
      let gid = null;
      for (const g of Object.values(groups)) if (g.code === code) { gid = g.id; break; }
      if (!gid) return send(res, 404, { error: '邀请码无效' });
      const g = groups[gid];
      if (g.members.length >= 50) return send(res, 400, { error: '小组人数已满（最多 50 人）' });
      if (!g.members.includes(acc.username.toLowerCase())) g.members.push(acc.username.toLowerCase());
      saveGroups();
      return send(res, 200, { ok: true, group: groupView(gid, acc.username) });
    }
    if (req.method === 'DELETE' && p === '/api/group') {
      const b = await readBody(req);
      const acc = authUser(tokenOf(req, u, b));
      if (!acc) return send(res, 401, { error: '请先登录' });
      const g = groups[String(b.groupId || '')];
      if (!g) return send(res, 404, { error: '小组不存在' });
      const me = acc.username.toLowerCase();
      if (g.owner === me) {
        const others = g.members.filter((m) => m !== me);
        if (others.length) { g.owner = others[0]; g.members = others; saveGroups(); return send(res, 200, { ok: true, transferred: true }); }
        delete groups[g.id]; saveGroups(); return send(res, 200, { ok: true, deleted: true });
      }
      g.members = g.members.filter((m) => m !== me); saveGroups();
      return send(res, 200, { ok: true, left: true });
    }
    if (req.method === 'POST' && p === '/api/group/member') {
      const b = await readBody(req);
      const acc = authUser(tokenOf(req, u, b));
      if (!acc) return send(res, 401, { error: '请先登录' });
      const g = groups[String(b.groupId || '')];
      if (!g) return send(res, 404, { error: '小组不存在' });
      if (g.owner !== acc.username.toLowerCase()) return send(res, 403, { error: '只有组长能添加成员' });
      const target = String(b.username || '').trim().toLowerCase();
      if (!accounts[target]) return send(res, 404, { error: '用户不存在' });
      if (g.members.includes(target)) return send(res, 200, { ok: true, group: groupView(g.id, acc.username) });
      if (g.members.length >= 50) return send(res, 400, { error: '小组人数已满' });
      g.members.push(target); saveGroups();
      return send(res, 200, { ok: true, group: groupView(g.id, acc.username) });
    }
    if (req.method === 'GET' && p === '/api/groups') {
      const acc = authUser(tokenOf(req, u));
      if (!acc) return send(res, 401, { error: '请先登录' });
      const me = acc.username.toLowerCase();
      const list = Object.values(groups).filter((g) => g.members.includes(me)).map((g) => groupView(g.id, me));
      return send(res, 200, { groups: list });
    }
    if (req.method === 'POST' && p === '/api/pk/invite') {
      const b = await readBody(req);
      const acc = authUser(tokenOf(req, u, b));
      if (!acc) return send(res, 401, { error: '请先登录' });
      const room = rooms.get(roomIdOf(b.roomId));
      if (!room) return send(res, 404, { error: '房间不存在' });
      const player = room.players.get(String(b.playerId || ''));
      if (!player || (player.username || '').toLowerCase() !== acc.username.toLowerCase()) return send(res, 403, { error: '你不在该房间' });
      const to = String(b.toUsername || '').trim().toLowerCase();
      if (!accounts[to]) return send(res, 404, { error: '好友不存在' });
      if (to === acc.username.toLowerCase()) return send(res, 400, { error: '不能邀请自己' });
      const bookName = (BOOKS.find((x) => x.id === room.settings.bookId) || {}).name || '';
      const inv = {
        id: crypto.randomBytes(8).toString('hex'), fromUsername: acc.username.toLowerCase(), fromName: acc.name || acc.username,
        roomId: room.id, bookName, mode: room.settings.mode, count: room.settings.count, at: Date.now(), expiresAt: Date.now() + 5 * 60 * 1000,
      };
      invites.set(to, (invites.get(to) || []).filter((x) => x.expiresAt > Date.now()).concat(inv));
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && p === '/api/invites') {
      const acc = authUser(tokenOf(req, u));
      if (!acc) return send(res, 401, { error: '请先登录' });
      const me = acc.username.toLowerCase();
      const list = (invites.get(me) || []).filter((x) => x.expiresAt > Date.now());
      invites.set(me, list);
      return send(res, 200, { invites: list });
    }
    if (req.method === 'DELETE' && p === '/api/invite') {
      const acc = authUser(tokenOf(req, u));
      if (!acc) return send(res, 401, { error: '请先登录' });
      const id = u.searchParams.get('id') || '';
      const me = acc.username.toLowerCase();
      invites.set(me, (invites.get(me) || []).filter((x) => x.id !== id));
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p === '/api/create') {
      const b = await readBody(req);
      const account = authUser(tokenOf(req, u, b));
      if (!account) return send(res, 401, { error: '请先登录' });
      const bookId = BOOKS.some((x) => x.id === b.bookId)
        ? b.bookId
        : (BOOKS.some((x) => x.id === DEFAULT_PK_BOOK) ? DEFAULT_PK_BOOK : BOOKS[0].id);
      const mode = b.mode === 'listen' ? 'listen' : 'word';
      const count = [10, 20, 30].includes(Number(b.count)) ? Number(b.count) : 10;
      const room = newRoom({ bookId, mode, count });
      const player = addPlayer(room, account.name || account.username, true, account.username);
      broadcast(room);
      return send(res, 200, { roomId: room.id, playerId: player.id });
    }
    if (req.method === 'POST' && p === '/api/join') {
      const b = await readBody(req);
      const room = rooms.get(roomIdOf(b.roomId));
      if (!room) return send(res, 404, { error: '房间不存在，请检查房号' });
      const account = authUser(tokenOf(req, u, b));
      if (!account) return send(res, 401, { error: '请先登录' });
      if (room.phase !== 'lobby' && room.phase !== 'result') return send(res, 400, { error: '游戏进行中，请等本局结束后再加入' });
      if (room.players.size >= 5) return send(res, 400, { error: '房间已满（最多 5 人）' });
      /* 重连处理：同一账号已在房间里时【直接复用原玩家】，而不是删掉重建。
         此前是「删除旧玩家 + 按非房主新建」，带来两个严重后果：
           ① 房主刷新页面 / 断线重连后，房主身份丢失 → 房间变成谁都开不了局的死房间；
           ② 旧 playerId 立即失效，客户端此前拿到的 id 再去调 start/answer 全部 404。
         复用则天然保住 playerId、房主身份、以及中途重连时的已有得分；
         同时 players 集合不会因反复重连而膨胀。 */
      let player = null;
      for (const p of room.players.values()) {
        if (p.username && account.username && p.username.toLowerCase() === account.username.toLowerCase()) { player = p; break; }
      }
      if (player) {
        player.lastSeen = Date.now();
        player.name = account.name || account.username;
        // 房间里已无房主（原房主掉线被清理）时由重连者接管，避免房间彻底报废
        if (![...room.players.values()].some((x) => x.isHost)) player.isHost = true;
      } else {
        const roomHasHost = [...room.players.values()].some((p) => p.isHost);
        player = addPlayer(room, account.name || account.username, !roomHasHost, account.username);
      }
      broadcast(room);
      return send(res, 200, { roomId: room.id, playerId: player.id });
    }
    if (req.method === 'GET' && p === '/api/stream') {
      const roomId = u.searchParams.get('roomId');
      const playerId = u.searchParams.get('playerId');
      const room = rooms.get(roomIdOf(roomId));
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
      const room = rooms.get(roomIdOf(roomId));
      const player = room && room.players.get(playerId);
      if (!room || !player) return send(res, 404, { error: '房间不存在' });
      player.lastSeen = Date.now(); // 轮询也算在线（绿点 / 房间保活 / 提前公布答案）
      if (room.phase === 'question') player.seenInRound = true; // 本题期间见过，超时也记生词
      return send(res, 200, view(room, playerId));
    }
    if (req.method === 'POST' && p === '/api/start') {
      const b = await readBody(req);
      const room = rooms.get(roomIdOf(b.roomId));
      const pl = room && room.players.get(b.playerId);
      if (!room || !pl) return send(res, 404, { error: '房间不存在' });
      if (!pl.isHost) return send(res, 403, { error: '只有房主可以开始游戏' });
      if (room.phase !== 'lobby' && room.phase !== 'result') return send(res, 400, { error: '当前阶段无法开始' });
      // 只有「非房主」玩家需要先准备（房主点开始即代表自己已就绪）
      const notReady = [...room.players.values()].filter((x) => !x.isHost && !x.ready);
      if (notReady.length) {
        return send(res, 400, { error: '还有 ' + notReady.length + ' 人未准备：' + notReady.map((x) => x.name).join('、') });
      }
      startCountdown(room);
      return send(res, 200, { ok: true });
    }
    /* 玩家准备 / 取消准备（全员准备后房主才能开始） */
    if (req.method === 'POST' && p === '/api/ready') {
      const b = await readBody(req);
      const room = rooms.get(roomIdOf(b.roomId));
      const pl = room && room.players.get(b.playerId);
      if (!room || !pl) return send(res, 404, { error: '房间不存在' });
      if (room.phase !== 'lobby' && room.phase !== 'result') return send(res, 400, { error: '游戏进行中，无需准备' });
      pl.ready = (b.ready === undefined) ? !pl.ready : !!b.ready;
      broadcast(room);
      return send(res, 200, { ok: true, ready: pl.ready });
    }
    /* 房主在房间内直接改词书 / 模式 / 题数；改动后所有人回到未准备，需重新确认 */
    if (req.method === 'POST' && p === '/api/room/settings') {
      const b = await readBody(req);
      const room = rooms.get(roomIdOf(b.roomId));
      const pl = room && room.players.get(b.playerId);
      if (!room || !pl) return send(res, 404, { error: '房间不存在' });
      if (!pl.isHost) return send(res, 403, { error: '只有房主可以修改房间设置' });
      if (room.phase !== 'lobby' && room.phase !== 'result') return send(res, 400, { error: '游戏进行中，不能修改设置' });
      if (b.bookId && BOOKS.some((x) => x.id === b.bookId)) room.settings.bookId = b.bookId;
      if (b.mode === 'listen' || b.mode === 'word') room.settings.mode = b.mode;
      if ([10, 20, 30].includes(Number(b.count))) room.settings.count = Number(b.count);
      for (const p of room.players.values()) p.ready = false; // 设置变了，大家重新确认
      broadcast(room);
      return send(res, 200, { ok: true, settings: room.settings });
    }
    if (req.method === 'POST' && p === '/api/answer') {
      const b = await readBody(req);
      const room = rooms.get(roomIdOf(b.roomId));
      if (!room) return send(res, 404, { error: '房间不存在' });
      // 校验房号与玩家号匹配，避免任何人拿到 roomId 就能替别人答题（B4）
      const pl0 = room.players.get(String(b.playerId || ''));
      if (!pl0) return send(res, 403, { error: '你不在该房间' });
      const qi = Number(b.qIndex), ci = Number(b.choice);
      if (!Number.isInteger(qi) || !Number.isInteger(ci)) return send(res, 400, { error: '参数不合法' });
      handleAnswer(room, pl0.id, qi, ci);
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/replay') {
      const b = await readBody(req);
      const room = rooms.get(roomIdOf(b.roomId));
      const pl = room && room.players.get(b.playerId);
      if (!room || !pl) return send(res, 404, { error: '房间不存在' });
      if (!pl.isHost) return send(res, 403, { error: '只有房主可以再来一局' });
      // 与开局一致：只看非房主玩家是否就绪，并走 3 秒倒计时
      const notReady = [...room.players.values()].filter((x) => !x.isHost && !x.ready);
      if (notReady.length) {
        return send(res, 400, { error: '还有 ' + notReady.length + ' 人未准备：' + notReady.map((x) => x.name).join('、') });
      }
      startCountdown(room);
      return send(res, 200, { ok: true });
    }
    // ---------------- 账号个人生词本 ----------------
    if (req.method === 'GET' && p === '/api/mywords') {
      const acc = authUser(tokenOf(req, u));
      if (!acc) return send(res, 401, { error: '请先登录' });
      return send(res, 200, { words: acc.words || [], username: acc.username });
    }
    /* 手动收录生词（支持批量）：用于 PK 结算的「单词总览面板」——
       用户可以勾选任意词加入生词本，包括那些答对的词（想再巩固也行）。
       注意：这是「主动收藏」，不像答错那样把学习进度等级清零。 */
    if (req.method === 'POST' && p === '/api/mywords/add') {
      const b = await readBody(req);
      if (b.__tooLarge) return send(res, 413, { error: '请求体过大' });
      const acc = authUser(tokenOf(req, u, b));
      if (!acc) return send(res, 401, { error: '请先登录' });
      let list = Array.isArray(b.words) ? b.words : [b];
      if (list.length > 200) list = list.slice(0, 200);
      const now = Date.now();
      let added = 0, skipped = 0;
      const cur = acc.words = acc.words || [];
      for (const it of list) {
        if (!it || typeof it.word !== 'string') continue;
        const w = String(it.word).trim().slice(0, 64);
        if (!w) continue;
        const key = w.toLowerCase();
        if (cur.some((x) => String(x.word).toLowerCase() === key)) { skipped += 1; continue; }
        cur.unshift({
          word: w,
          meaning: typeof it.meaning === 'string' ? String(it.meaning).slice(0, 200) : '',
          book: typeof it.book === 'string' ? String(it.book).slice(0, 40) : '',
          lang: it.lang === 'es' ? 'es' : 'en',
          at: now,
        });
        added += 1;
        // 同一个词不能同时躺在「生词本」和「熟词本」里：熟词本在学习/复习过滤中优先级更高，
        // 若不移出，这个词会处于自相矛盾的状态 —— 显示在生词本里，却永远不会被学到。
        // 用户主动收回生词本 = 明确表示「这个我还不会」，理应退出熟词本。
        if (acc.known && acc.known.length) {
          const before = acc.known.length;
          acc.known = acc.known.filter((x) => wordKey(x && x.word) !== wordKey(w));
          // 确实是从熟词本移回来的 → 撤销「已掌握」进度，否则它仍会被三处过滤挡住、永远刷不到
          if (acc.known.length !== before) demoteKnownWord(acc, w);
        }
      }
      if (cur.length > 500) cur.length = 500;
      if (added) saveAccounts();
      return send(res, 200, { ok: true, added: added, skipped: skipped, total: cur.length });
    }
    if (req.method === 'DELETE' && p === '/api/mywords') {
      const acc = authUser(tokenOf(req, u));
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
    /* 存储诊断：确认当前是「云端持久化」还是「本地文件（Render 部署即清空=会丢）」模式。
       需登录后查看，且只返回状态计数，不含任何凭据。 */
    if (req.method === 'GET' && p === '/api/storage-status') {
      const acc = authUser(tokenOf(req, u));
      if (!acc) return send(res, 401, { error: '请先登录' });
      // 实时查一次租约：能直接看出「本实例是否仍是云端持有者」（部署排障用）
      const isOwner = kvUsable ? await kvStillOwner() : false;
      const lease = kvUsable ? await kvGet('__lease__', 1, 3000) : { ok: false };
      return send(res, 200, {
        ok: true,
        mode: kvUsable ? 'cloud' : 'local',
        kvConfigured: KV_ON,
        kvUsable: kvUsable,
        leaseOwner: leaseOwner,
        isCurrentOwner: isOwner,
        leaseHolder: (lease.ok && lease.found && lease.value && lease.value.id) ? String(lease.value.id).slice(0, 8) : null,
        self: String(INSTANCE_ID).slice(0, 8),
        accounts: Object.keys(accounts).length,
        sessions: Object.keys(sessions).length,
        groups: Object.keys(groups).length,
        pendingWrites: Object.keys(kvTimers).length,
        queuedRetries: kvWriteQueue.length,
        lastError: kvLastError,
        lastWriteAt: kvLastWriteAt,
        instance: String(INSTANCE_ID).slice(0, 8),
        uptimeSec: Math.round(process.uptime()),
      });
    }
    /* 单词详情：音标 / 分词性释义 / 例句 / 搭配（服务端拉取并长期缓存，前端不再直连第三方） */
    if (req.method === 'GET' && p === '/api/word') {
      const acc = authUser(tokenOf(req, u));
      if (!acc) return send(res, 401, { error: '请先登录' });
      const w = String(u.searchParams.get('w') || '').trim().slice(0, 64);
      if (!w) return send(res, 400, { error: '缺少单词' });
      const lang = u.searchParams.get('lang') === 'es' ? 'es' : 'en';
      const wait = u.searchParams.get('wait') === '1'; // 详情弹窗首屏：等在线富化
      const d = await getWordDetail(w, lang, wait);
      if (!d) return send(res, 200, { ok: false, word: w, lang: lang });
      return send(res, 200, Object.assign({ ok: true }, d));
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
          if (!isValidMeaning(x.meaning)) continue; // 防御：跳过无效释义（"n." 等脏数据）
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
      const acc = authUser(tokenOf(req, u, b));
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
      saveRank();
      return send(res, 200, {
        ok: true,
        estimate,
        estimates: estimates.map((v, i) => ({ tier: TIERS[i].name, value: v })),
      });
    }
    if (req.method === 'GET' && p === '/api/vocabrank') {
      const list = vocabRank.map((x, i) => ({ rank: i + 1, name: x.name, best: x.best, latest: x.latest, count: x.count, at: x.at }));
      const acc = authUser(tokenOf(req, u));
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
      const acc = authUser(tokenOf(req, u));
      if (!acc) return send(res, 401, { error: '请先登录' });
      return send(res, 200, studyOverview(acc));
    }
    if (req.method === 'POST' && p === '/api/study/plan') {
      const b = await readBody(req);
      const acc = authUser(tokenOf(req, u, b));
      if (!acc) return send(res, 401, { error: '请先登录' });
      const st = getStudy(acc);
      const bookId = resolveBook(acc, b.bookId) ? b.bookId : (st.plan && st.plan.bookId) || BOOKS[0].id;
      const dailyNew = [10, 20, 30, 50, 100].includes(Number(b.dailyNew)) ? Number(b.dailyNew) : (st.plan && st.plan.dailyNew) || 20;
      let vocabEstimate = Math.max(0, Math.min(30000, Math.round(Number(b.vocabEstimate) || 0)));
      st.plan = {
        bookId, dailyNew, vocabEstimate,
        autoSpeak: b.autoSpeak === undefined ? (st.plan ? st.plan.autoSpeak !== false : true) : b.autoSpeak !== false,
      };
      saveAccounts();
      const book = resolveBook(acc, bookId) || BOOKS[0];
      const { skipped } = filterKnown(book, vocabEstimate);
      return send(res, 200, { ok: true, plan: st.plan, skipped, total: book.words.length - skipped, bookName: book.name });
    }
    if (req.method === 'GET' && p === '/api/study/session') {
      const acc = authUser(tokenOf(req, u));
      if (!acc) return send(res, 401, { error: '请先登录' });
      const st = getStudy(acc);
      if (!st.plan) return send(res, 400, { error: '请先设置学习计划' });
      const book = resolveBook(acc, st.plan.bookId) || BOOKS[0];
      const mode = u.searchParams.get('mode') === 'unit' ? 'unit' : (u.searchParams.get('mode') === 'review' ? 'review' : 'daily');
      const now = Date.now();
      let queue = [];
      let extra = {};
      if (mode === 'review') {
        /* 智能复习：不再是「生词本前 100 个」，而是按遗忘曲线综合打分挑最该复习的词。
           打分 = 超期时长（越久没复习越急）+ 历史错误次数（老出错的优先）+ 掌握等级越低越优先。
           覆盖两个来源：① 生词本里未掌握的词 ② 学习进度中已到期该巩固的词。 */
        const rev = buildReviewQueue(acc, st, Number(u.searchParams.get('limit')) || 50);
        queue = rev.queue;
        extra = rev.stats;
      } else if (mode === 'unit') {
        const unit = Math.max(0, Number(u.searchParams.get('unit')) || 0);
        const { list } = knownFilteredList(book, st.plan.vocabEstimate, knownSetOf(acc));
        const maxUnit = Math.max(0, Math.ceil(list.length / UNIT_SIZE) - 1);
        if (unit > maxUnit) return send(res, 400, { error: '单元不存在' });
        const seg = list.slice(unit * UNIT_SIZE, (unit + 1) * UNIT_SIZE);
        queue = seg.map((w) => ({ word: w.word, meaning: w.meaning }));
        extra = { unit, unitTotal: seg.length };
      } else {
        const knownSet = knownSetOf(acc);
        const { list } = knownFilteredList(book, st.plan.vocabEstimate, knownSet);
        const lg = todayLog(st);
        const newRemaining = Math.max(0, st.plan.dailyNew - lg.new);
        // 临时加学：在今日计划新词之外，额外追加 extraNew 个未学新词（前端可反复点击叠加）
        const extraNew = Math.max(0, Math.min(200, Math.floor(Number(u.searchParams.get('extraNew')) || 0)));
        const unlearnedAll = list.filter((w) => { const pr = st.progress[w.posKey]; return !pr || !pr.n; });
        const news = unlearnedAll.slice(0, newRemaining + extraNew);
        /* 每日学习只围绕【当前词书】：到期的复习词同样限定在当前词书内。
           跨词书的到期词、生词本里的词统一交给「智能复习」(mode=review) 处理，
           否则用户换了词书之后，旧词书的词还会一直混在每日任务里。 */
        const inBook = new Set(list.map((w) => w.posKey));
        const dueList = [];
        for (const [k, pr] of Object.entries(st.progress)) {
          // 不能排除 lv===0：答错的词会被置为 lv=0、10 分钟后到期（WRONG_REDUE），
          // 若在这里跳过，错题就永远不会出现在「每日学习」里 —— 答错的词凭空消失，
          // 用户只能去「智能复习」才见得到（复习队列本身就允许 lv=0，两边逻辑此前不一致）。
          // 错题恰恰是最该马上巩固的，必须让它回到每日队列。
          if (!pr || !pr.n || pr.lv >= MASTER_LV || !pr.due || pr.due > now) continue;
          if (knownSet.has(k)) continue; // 熟词本里的词，即便进度异常也绝不再复习
          if (!inBook.has(k)) continue;  // 不属于当前词书 → 交给智能复习，不占每日任务
          const card = wordCard(k, book);
          if (card) dueList.push({ word: card.word, meaning: card.meaning, due: pr.due });
        }
        dueList.sort((a, c) => a.due - c.due);
        const reviews = dueList.slice(0, 100);
        const newsItems = news.map((w) => ({ word: w.word, meaning: w.meaning, isNew: true }));
        const revItems = reviews.map((r) => ({ word: r.word, meaning: r.meaning, isNew: false }));
        // 交错出题：复习词与新词轮流出现，且复习词靠前（快忘的先救、再学新词），
        // 比「先全部新词再全部复习」更符合间隔重复的记忆规律。
        queue = [];
        let ni = 0, ri = 0;
        while (ri < revItems.length || ni < newsItems.length) {
          if (ri < revItems.length) queue.push(revItems[ri++]);
          if (ni < newsItems.length) queue.push(newsItems[ni++]);
        }
        extra = { newCount: news.length, reviewCount: reviews.length, dailyNew: st.plan.dailyNew, extraNew: extraNew, newPoolRemaining: Math.max(0, unlearnedAll.length - news.length) };
      }
      // 干扰项取自与该词同语言的词书（复习模式可能混入西语生词，避免出现跨语言选项）
      const questions = queue.map((q) => {
        const srcBook = (q.lang && q.lang !== book.lang && BOOKS.find((b) => b.lang === q.lang)) || book;
        // isNew：按学习进度判断（从未答过的词 = 新词），供前端「首次出现弹详解」使用。
        // 生词本复习模式强制 false —— 那些词本来就是答错过的，不该再当新词弹窗。
        const pr = st.progress[wordKey(q.word)];
        const isNew = mode === 'review' ? false : (!pr || !pr.n);
        return Object.assign(genStudyQuestion(q, srcBook), { isNew: isNew, lang: srcBook.lang });
      });
      return send(res, 200, Object.assign({ mode, questions, bookName: book.name, lang: book.lang, plan: st.plan }, extra));
    }
    if (req.method === 'POST' && p === '/api/study/answer') {
      const b = await readBody(req);
      const acc = authUser(tokenOf(req, u, b));
      if (!acc) return send(res, 401, { error: '请先登录' });
      if (!b.word) return send(res, 400, { error: '缺少单词' });
      const ms = Number(b.ms);
      return send(res, 200, studyAnswer(acc, String(b.word).slice(0, 64), !!b.correct, (isFinite(ms) && ms >= 0) ? ms : 0, b));
    }
    if (req.method === 'POST' && p === '/api/study/reset') {
      const b = await readBody(req);
      const acc = authUser(tokenOf(req, u, b));
      if (!acc) return send(res, 401, { error: '请先登录' });
      if (b.scope === 'all') acc.study = { plan: null, progress: {}, log: {} };
      else if (b.scope === 'plan') { const st = getStudy(acc); st.plan = null; }
      else { const st = getStudy(acc); st.progress = {}; st.log = {}; } // scope=progress
      saveAccounts();
      return send(res, 200, { ok: true });
    }
    /* 标记为「已会」（熟词）：移出生词本 + 写入熟词本 + 进度置为掌握 */
    if (req.method === 'POST' && p === '/api/study/markKnown') {
      const b = await readBody(req);
      const acc = authUser(tokenOf(req, u, b));
      if (!acc) return send(res, 401, { error: '请先登录' });
      const word = String(b.word || '').trim();
      if (!word) return send(res, 400, { error: '缺少单词' });
      // 允许前端传入 meaning/book/lang（如从生词本点「熟词」时保留原条目信息），否则回退到词书查询
      const meaning = b.meaning ? String(b.meaning) : '';
      const bookName = b.book ? String(b.book) : '';
      const lang = b.lang === 'es' ? 'es' : (b.lang ? String(b.lang) : '');
      const st = getStudy(acc);
      const k = wordKey(word);
      const now2 = Date.now();
      const info = wordInfoOf(word, resolveBook(acc, st.plan && st.plan.bookId));
      const pr = st.progress[k] = st.progress[k] || { lv: 0, n: 0, c: 0, wrong: 0, due: 0, firstAt: now2, lastAt: now2 };
      pr.lv = MASTER_LV; pr.n = Math.max(pr.n || 0, 1); pr.c = Math.max(pr.c || 0, 1); pr.due = now2 + 365 * 86400000; // 已掌握：进度置满，且 1 年内不再作为新词/复习出现
      if (Array.isArray(acc.words)) acc.words = acc.words.filter((x) => wordKey(x.word) !== k);
      const known = acc.known = acc.known || [];
      const km = { word, meaning: meaning || (info && info.meaning) || '', book: bookName || (info && info.bookName) || '', lang: lang || (info && info.lang) || 'en', at: now2 };
      const kidx = known.findIndex((x) => wordKey(x.word) === k);
      if (kidx >= 0) known.splice(kidx, 1);
      known.unshift(km);
      if (known.length > 5000) known.length = 5000;
      saveAccounts();
      return send(res, 200, { ok: true, knownCount: known.length });
    }
    /* 熟词本：查询 / 移除（toWrong=1 时移回生词本） */
    if (req.method === 'GET' && p === '/api/known') {
      const acc = authUser(tokenOf(req, u));
      if (!acc) return send(res, 401, { error: '请先登录' });
      return send(res, 200, { words: acc.known || [], username: acc.username });
    }
    if (req.method === 'DELETE' && p === '/api/known') {
      const acc = authUser(tokenOf(req, u));
      if (!acc) return send(res, 401, { error: '请先登录' });
      const known = acc.known = acc.known || [];
      const word = String(u.searchParams.get('word') || '').trim();
      if (word) {
        const k = word.toLowerCase();
        const idx = known.findIndex((x) => String(x.word).toLowerCase() === k);
        const item = idx >= 0 ? known[idx] : null;
        if (idx >= 0) known.splice(idx, 1);
        if (item && u.searchParams.get('toWrong')) {
          const wl = acc.words = acc.words || [];
          if (!wl.some((x) => String(x.word).toLowerCase() === k)) wl.unshift({ word: item.word, meaning: item.meaning, book: item.book || '', lang: item.lang || 'en', at: Date.now() });
          if (wl.length > 500) wl.length = 500;
          // 移回生词本 = 用户认为这个还不会：撤销「已掌握」进度，否则它进了生词本也永远刷不到
          demoteKnownWord(acc, word);
        }
      } else {
        acc.known = [];
      }
      saveAccounts();
      return send(res, 200, { ok: true, count: (acc.known || []).length });
    }
    /* 自定义词书：新建 / 列表 / 删除 */
    if (req.method === 'POST' && p === '/api/custombook') {
      const b = await readBody(req);
      const acc = authUser(tokenOf(req, u, b));
      if (!acc) return send(res, 401, { error: '请先登录' });
      const name = String(b.name || '').trim().slice(0, 30) || ('我的词书 ' + (((acc.customBooks || []).length) + 1));
      const lang = b.lang === 'es' ? 'es' : 'en';
      const text = String(b.text || '');
      const words = [];
      const seen = new Set();
      text.split(/\r?\n/).forEach((line) => {
        const s = line.trim(); if (!s) return;
        const m = s.match(/^(\S+)[ \t=：:]+([\s\S]+)$/);
        if (!m) return;
        const w = m[1].trim(), mean = m[2].trim();
        if (!w || !mean) return;
        const k = w.toLowerCase(); if (seen.has(k)) return; seen.add(k);
        words.push([w, mean]);
      });
      if (!words.length) return send(res, 400, { error: '没有解析到有效的「单词 释义」行，每行格式如：apple 苹果' });
      if (words.length > 3000) words.length = 3000;
      acc.customBooks = acc.customBooks || [];
      if (acc.customBooks.length >= 30) return send(res, 400, { error: '自定义词书最多 30 本' });
      const id = 'cb-' + Date.now();
      acc.customBooks.push({ id, name, lang, words, createdAt: Date.now() });
      saveAccounts();
      return send(res, 200, { ok: true, id, name, count: words.length, lang });
    }
    if (req.method === 'GET' && p === '/api/custombooks') {
      const acc = authUser(tokenOf(req, u));
      if (!acc) return send(res, 401, { error: '请先登录' });
      return send(res, 200, { books: (acc.customBooks || []).map((x) => ({ id: x.id, name: x.name, count: (x.words || []).length, lang: x.lang || 'en' })) });
    }
    if (req.method === 'DELETE' && p === '/api/custombook') {
      const acc = authUser(tokenOf(req, u));
      if (!acc) return send(res, 401, { error: '请先登录' });
      const id = u.searchParams.get('id') || '';
      acc.customBooks = (acc.customBooks || []).filter((x) => x.id !== id);
      if (acc.__rt) acc.__rt.delete(id); // 清掉运行时缓存，否则删除后仍能出题（B5）
      const st = getStudy(acc);
      if (st.plan && st.plan.bookId === id) st.plan = null;
      saveAccounts();
      return send(res, 200, { ok: true });
    }
    /* 整账户备份 / 恢复（生词本 + 熟词本 + 自定义词书 + 学习进度） */
    if (req.method === 'GET' && p === '/api/backup') {
      const acc = authUser(tokenOf(req, u));
      if (!acc) return send(res, 401, { error: '请先登录' });
      return send(res, 200, { backup: {
        username: acc.username, words: acc.words || [], known: acc.known || [],
        customBooks: acc.customBooks || [], study: acc.study || null, exportedAt: Date.now(),
      } });
    }
    if (req.method === 'POST' && p === '/api/restore') {
      const b = await readBody(req);
      if (b.__tooLarge) return send(res, 413, { error: '备份数据过大（超过 20MB）' });
      const acc = authUser(tokenOf(req, u, b));
      if (!acc) return send(res, 401, { error: '请先登录' });
      const data = b.backup;
      if (!data || typeof data !== 'object') return send(res, 400, { error: '备份数据格式不正确' });
      // 逐条校验字段类型，脏备份无法注入异常数据（L8）
      function pickWordList(arr) {
        if (!Array.isArray(arr)) return null;
        const out = [];
        for (const it of arr) {
          if (!it || typeof it !== 'object' || typeof it.word !== 'string') continue;
          out.push({
            word: String(it.word),
            meaning: typeof it.meaning === 'string' ? it.meaning : '',
            book: typeof it.book === 'string' ? it.book : '',
            lang: it.lang === 'es' ? 'es' : (typeof it.lang === 'string' ? it.lang : 'en'),
            at: Number(it.at) || Date.now(),
          });
        }
        return out;
      }
      const words = pickWordList(data.words);
      const known = pickWordList(data.known);
      const customBooks = (Array.isArray(data.customBooks) ? data.customBooks : []).map(function (it) {
        if (!it || typeof it.id !== 'string' || !Array.isArray(it.words)) return null;
        return {
          id: String(it.id),
          name: typeof it.name === 'string' ? it.name : '我的词书',
          lang: it.lang === 'es' ? 'es' : 'en',
          words: (it.words || []).filter(function (w) { return Array.isArray(w) && typeof w[0] === 'string'; }).map(function (w) { return [String(w[0]), typeof w[1] === 'string' ? w[1] : '']; }),
          createdAt: Number(it.createdAt) || Date.now(),
        };
      }).filter(Boolean);
      acc.words = words || (acc.words || []);
      acc.known = known || (acc.known || []);
      acc.customBooks = customBooks || (acc.customBooks || []);
      acc.study = (data.study && typeof data.study === 'object') ? {
        plan: (data.study.plan === null || typeof data.study.plan === 'object') ? data.study.plan : null,
        progress: (data.study.progress && typeof data.study.progress === 'object') ? data.study.progress : {},
        log: (data.study.log && typeof data.study.log === 'object') ? data.study.log : {},
      } : (acc.study || null);
      saveAccounts();
      return send(res, 200, { ok: true });
    }
    // ---------------- 作者反馈（文字 + 截图）：任何人可提交，自动发邮件给作者 ----------------
    if (req.method === 'GET' && p === '/api/feedback') {
      const admin = u.searchParams.get('admin');
      if (!FEEDBACK_ADMIN_TOKEN || admin !== FEEDBACK_ADMIN_TOKEN) return send(res, 403, { error: '无权限' });
      return send(res, 200, { items: recentFeedback() });
    }
    if (req.method === 'POST' && p === '/api/feedback') {
      const b = await readBody(req);
      if (b.__tooLarge) return send(res, 413, { error: '请求体过大' });
      const ip = clientIp(req);
      if (feedbackThrottled(ip)) return send(res, 429, { error: '反馈过于频繁，请稍后再试（每小时上限 12 条）' });
      const text = String(b.text || '').trim().slice(0, 2000);
      const image = (typeof b.image === 'string') ? b.image : '';
      if (!text && !image) return send(res, 400, { error: '请填写内容或上传截图' });
      let imgB64 = '', imgType = 'png';
      if (image) {
        const m = /^data:image\/(png|jpe?g|gif|webp);base64,(.+)$/i.exec(image);
        if (!m) return send(res, 400, { error: '截图格式不支持（仅 png/jpg/gif/webp）' });
        if (m[2].length > 8 * 1024 * 1024) return send(res, 400, { error: '截图过大（请 < 8MB）' });
        imgType = m[1].toLowerCase() === 'jpg' ? 'jpeg' : m[1].toLowerCase();
        imgB64 = m[2];
      }
      const acc = authUser(tokenOf(req, u));
      const rec = {
        at: new Date().toISOString(),
        ip: ip,
        ua: String(req.headers['user-agent'] || '').slice(0, 300),
        user: (acc && acc.username) || null,
        text: text,
        hasImage: !!imgB64,
        emailed: false,
      };
      saveFeedback(rec);
      try {
        const sent = await sendFeedbackEmail({
          subject: '[vocab-pk 反馈] ' + (text.slice(0, 40) || (imgB64 ? '(含截图)' : '(空)')),
          text: text || '(无文字，仅截图)',
          imageBase64: imgB64,
          imageType: imgType,
          meta: rec,
        });
        rec.emailed = !!sent;
      } catch (e) { console.error('[反馈] 邮件异常', (e && e.message) || e); }
      return send(res, 200, { ok: true, emailed: rec.emailed });
    }
    return serveStatic(req, res);
  } catch (e) {
    send(res, 500, { error: String(e && e.message || e) });
  }
});

/* 启动：若配置了云端持久化，先从云端拉取数据再对外服务，避免用空数据响应 */
loadStoreFromKV().then(async () => {
  if (!kvUsable) {
    // 纯本地文件模式：主数据丢了就用最近的每日快照恢复，避免「更新一次版本，账号全没了」
    restoreFromSnapshot();
    writeSnapshot();
    /* 失声保护：部署平台上「只存本地磁盘」等同于「下次更新数据全丢」，必须大喊出来，
       否则日志一闪而过就没人发现，直到用户集体丢号才暴露。 */
    const onCloudHost = process.env.RENDER || process.env.RAILWAY || process.env.KOYEB || process.env.VERCEL;
    if (onCloudHost) {
      console.log('\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
      console.log('!! 严重警告：云端持久化【未生效】，数据目前只写在本地磁盘。');
      console.log('!! 本平台每次更新版本都会清空磁盘 → 再更新一次用户数据就会全部丢失！');
      console.log('!! 请立即检查环境变量：UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN');
      console.log('!! 云端是否已配置：' + (KV_ON ? '已配置' : '未配置') + ' · 最近错误：' + (kvLastError || '无'));
      console.log('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n');
      // 启动兜底：后台持续重试云端，连通后把本地期间产生的数据安全合并回去
      startKvRecoveryWatchdog();
    }
  } else {
    // 云端模式：登记本实例为租约持有者，让即将退出的旧实例放弃回写（防覆盖新数据）
    await kvTakeLease();
  }
  server.listen(PORT, '0.0.0.0', () => {
  const onCloud = process.env.RENDER || process.env.RAILWAY || process.env.KOYEB || process.env.VERCEL || process.env.PORT;
  const externalUrl = process.env.RENDER_EXTERNAL_URL || process.env.RAILWAY_PUBLIC_DOMAIN || process.env.KOYEB_APP_PUBLIC_DOMAIN || '';
  const ips = lanIPs();
  console.log('====================================');
  console.log('  胖虎单词PK · 背单词+单词对战 已启动');
  console.log('  离线词典:  ' + BOOK_INDEX_SIZE + ' 条词书词条已建索引（内置词零网络即时显示）');
  console.log('====================================');
  if (!KV_ON) {
    // 打印【变量名】而不打印值，方便发现拼写/多了空格之类的配置错误（不泄露凭据）
    const found = Object.keys(process.env).filter((k) => /UPSTASH|REDIS|KV_/i.test(k));
    console.log('  存储模式:  ⚠️ 本地文件（部署平台会清空磁盘 → 每次更新账号都会丢！）');
    console.log('  排查提示:  需配置 UPSTASH_REDIS_REST_URL 与 UPSTASH_REDIS_REST_TOKEN');
    console.log('  已检测到:  ' + (found.length ? found.join(', ') : '（没有任何 UPSTASH/REDIS 相关环境变量，请到平台 Environment 里添加）'));
  } else if (!kvUsable) {
    console.log('  存储模式:  ⚠️ 云端已配置但连接失败，本次运行降级为本地文件（更新后账号可能丢失！）');
    console.log('  云端错误:  ' + (kvLastError || '未知') + '（启动重试 ' + '3' + ' 次均未成功，后台仍在持续重试）');
  } else {
    console.log('  存储模式:  ✅ Upstash 云端持久化已生效（账号/进度跨更新保留）');
  }
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
  // 端口被占用 / 无权限监听时给出人话提示，而不是抛一堆栈后默默退出
  server.on('error', function (e) {
    if (e && e.code === 'EADDRINUSE') {
      console.error('\n[启动失败] 端口 ' + PORT + ' 已被占用。');
      console.error('  · 可能已经有一个服务在跑了，直接用它就行；');
      console.error('  · 或者用 set PORT=3400 && node server.js 换个端口；');
      console.error('  · Windows 上可用 netstat -ano | findstr :' + PORT + ' 找到占用进程。\n');
    } else {
      console.error('[启动失败]', (e && e.message) || e);
    }
    process.exit(1);
  });
});
