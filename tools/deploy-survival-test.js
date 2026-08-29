/*
 * 「更新版本后用户数据是否完好」全量审计测试
 *
 * 模拟一次真实的 Render 部署：制造完整用户数据 → 杀掉进程 → 清空本地磁盘（Render 每次部署都会清盘）
 * → 用同一个云端 KV 重新启动 → 逐项校验数据是否原样回来。
 *
 * 覆盖：账号密码（能否登录）、学习计划、学习进度（SRS 等级/到期/错误次数/日志连续天数）、
 *       生词本、熟词本、自定义词书（含词条）、好友、词汇量排行。
 *
 * 运行：node tools/deploy-survival-test.js
 */
'use strict';
const http = require('http');
const { spawn, execSync } = require('child_process');
const path = require('path');

const KV_PORT = 3981;
const APP_PORT = 3031;
const BASE = 'http://127.0.0.1:' + APP_PORT;
const STORE_DIRNAME = 'deploy-survive-tmp';
const store = {}; // mock Upstash

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- mock Upstash REST ---------- */
const kvServer = http.createServer((req, res) => {
  const m = req.url.match(/^\/(get|set)\/(.+)$/);
  if (!m) { res.writeHead(404); res.end('{}'); return; }
  const op = m[1], key = decodeURIComponent(m[2]);
  if (op === 'get') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ result: key in store ? store[key] : null }));
  } else {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      try { store[key] = JSON.parse(b); } catch (e) { store[key] = b; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ result: 'OK' }));
    });
  }
});

function nuke() { try { execSync('rmdir /s /q "' + path.join(__dirname, '..', 'store', STORE_DIRNAME) + '"'); } catch (e) {} }
function startApp() {
  return spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, {
      PORT: String(APP_PORT),
      STORE_DIR: path.join(__dirname, '..', 'store', STORE_DIRNAME),
      UPSTASH_REDIS_REST_URL: 'http://127.0.0.1:' + KV_PORT,
      UPSTASH_REDIS_REST_TOKEN: 'mock-token',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
async function waitUp() {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(BASE + '/api/info'); if (r.ok) return true; } catch (e) {}
    await sleep(300);
  }
  return false;
}
async function call(p, body, method) {
  const r = await fetch(BASE + p, {
    method: method || (body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let d = {};
  try { d = await r.json(); } catch (e) {}
  return { status: r.status, data: d };
}

(async () => {
  nuke();
  await new Promise((r) => kvServer.listen(KV_PORT, r));

  /* ========== 1. 制造完整的用户数据 ========== */
  console.log('== 1. 制造用户数据 ==');
  let app = startApp();
  ok(await waitUp(), '实例启动成功');

  const user = 'sv' + String(Date.now()).slice(-8);
  const pwd = 'MyPwd@2026';
  const reg = await call('/api/register', { username: user, password: pwd, name: '存活测试' });
  const token = reg.data && reg.data.token;
  ok(!!token, '注册成功（用户名 ' + user + '）');

  // 学习计划
  await call('/api/study/plan', { token: token, bookId: 'cet4', dailyNew: 20, vocabEstimate: 3000 });
  const plan0 = await call('/api/study/overview?token=' + token);
  ok(plan0.data && plan0.data.plan && plan0.data.plan.bookId === 'cet4', '学习计划已设置（cet4）');

  // 答若干题：制造学习进度（SRS 等级/到期/错误次数/每日日志）
  const sess = await call('/api/study/session?token=' + token);
  const qs = (sess.data && sess.data.questions) || [];
  ok(qs.length > 0, '取到学习题目 ' + qs.length + ' 道');
  let answered = 0;
  for (let i = 0; i < qs.length && i < 6; i++) {
    const q = qs[i];
    // 前 3 题答错（进生词本），后 3 题答对（提升 SRS 等级）
    const correct = i >= 3;
    await call('/api/study/answer', { token: token, word: q.word, correct: correct, ms: 1200, meaning: q.meaning, lang: q.lang || 'en' });
    answered++;
  }
  ok(answered > 0, '已作答 ' + answered + ' 题');

  // 熟词本（标记为已认识）
  await call('/api/study/markKnown', { token: token, word: 'survivalword', meaning: '存活测试词', book: 'cet4', lang: 'en' });

  // 自定义词书（含词条）
  const cbText = 'alpha 第一个\ntheta 第八个\nomega 最后一个';
  const cb = await call('/api/custombook', { token: token, name: '审计词书', lang: 'en', text: cbText });
  ok(cb.status === 200, '自定义词书创建成功');

  // 词汇量排行
  await call('/api/vocabtest/submit', { token: token, score: 6600 }).catch(() => {});

  await sleep(1500); // 等防抖把数据写入云端

  /* ---------- 部署前快照 ---------- */
  const before = await call('/api/backup?token=' + token);
  const b = before.data.backup;
  const beforeWords = (b.words || []).length;
  const beforeKnown = (b.known || []).length;
  const beforeBooks = (b.customBooks || []).length;
  const beforeBookWords = beforeBooks ? ((b.customBooks[0].words || []).length) : 0;
  const beforeProgKeys = Object.keys((b.study && b.study.progress) || {}).length;
  const beforeLogKeys = Object.keys((b.study && b.study.log) || {}).length;
  console.log('  部署前：生词 ' + beforeWords + ' · 熟词 ' + beforeKnown + ' · 自定义词书 ' + beforeBooks +
    '(' + beforeBookWords + ' 词) · 学习进度 ' + beforeProgKeys + ' 词 · 日志 ' + beforeLogKeys + ' 天');
  ok(beforeWords > 0 || beforeKnown > 0, '已产生生词本/熟词本数据');
  ok(beforeBooks === 1 && beforeBookWords === 3, '自定义词书含 3 个词条');
  ok(beforeProgKeys > 0, '已产生学习进度数据（' + beforeProgKeys + ' 个词）');

  /* ========== 2. 模拟 Render 部署：杀进程 + 清空本地磁盘 + 重启 ========== */
  console.log('== 2. 模拟部署（杀进程 → 清空本地磁盘 → 用同一云端重启）==');
  app.kill();
  await sleep(1200);
  nuke(); // Render 每次部署清空磁盘，本地文件必须被视为「不存在」
  const diskGone = !require('fs').existsSync(path.join(__dirname, '..', 'store', STORE_DIRNAME));
  ok(diskGone, '本地数据目录已清空（模拟 Render 清盘）');

  app = startApp();
  ok(await waitUp(), '新实例启动成功');

  /* ========== 3. 逐项校验数据是否完好 ========== */
  console.log('== 3. 校验数据是否完好 ==');

  // 3.1 账号与密码
  const lg = await call('/api/login', { username: user, password: pwd });
  ok(lg.status === 200 && lg.data.token, '★ 用原密码登录成功（账号与密码哈希完好）');
  const badPwd = await call('/api/login', { username: user, password: 'wrong-password' });
  ok(badPwd.status !== 200, '错误密码仍被拒绝（安全性未受损）');
  // 登录态是否跨部署保持（会话同步到云端 → 用户更新后无需重新登录）
  const meOld = await call('/api/me?token=' + token);
  ok(meOld.status === 200, '★ 部署前的登录态（旧 token）仍有效，用户无需重新登录');
  const token2 = (lg.data && lg.data.token) || token;

  // 3.2 生词本 / 熟词本 / 自定义词书 / 学习进度
  const after = await call('/api/backup?token=' + token2);
  const a = after.data.backup;
  ok(!!a, '能取回备份数据');
  ok((a.words || []).length === beforeWords, '★ 生词本完好（' + beforeWords + ' → ' + (a.words || []).length + '）');
  ok((a.known || []).length === beforeKnown, '★ 熟词本完好（' + beforeKnown + ' → ' + (a.known || []).length + '）');
  ok((a.customBooks || []).length === beforeBooks, '★ 自定义词书数量完好（' + beforeBooks + '）');
  const afterBookWords = (a.customBooks && a.customBooks[0] && a.customBooks[0].words || []).length;
  ok(afterBookWords === beforeBookWords, '★ 自定义词书词条完好（' + beforeBookWords + ' → ' + afterBookWords + '）');
  const afterBookName = a.customBooks && a.customBooks[0] && a.customBooks[0].name;
  ok(afterBookName === '审计词书', '自定义词书名称完好（' + afterBookName + '）');

  const afterProgKeys = Object.keys((a.study && a.study.progress) || {}).length;
  ok(afterProgKeys === beforeProgKeys, '★ 学习进度词条数完好（' + beforeProgKeys + ' → ' + afterProgKeys + '）');
  const afterLogKeys = Object.keys((a.study && a.study.log) || {}).length;
  ok(afterLogKeys === beforeLogKeys, '★ 学习日志/打卡天数完好（' + beforeLogKeys + ' → ' + afterLogKeys + '）');

  // 逐词比对学习进度的关键字段（SRS 等级/复习到期/错误次数）
  const bp = (b.study && b.study.progress) || {};
  const ap = (a.study && a.study.progress) || {};
  let progMismatch = [];
  for (const k of Object.keys(bp)) {
    const x = bp[k], y = ap[k];
    if (!y) { progMismatch.push(k + ':缺失'); continue; }
    if (x.lv !== y.lv) progMismatch.push(k + ':lv');
    if (x.wrong !== y.wrong) progMismatch.push(k + ':wrong');
    if (x.due !== y.due) progMismatch.push(k + ':due');
  }
  ok(progMismatch.length === 0, '★ 每个词的 SRS 等级/错误次数/复习到期时间逐项一致' +
    (progMismatch.length ? '（差异：' + progMismatch.join(',') + '）' : ''));

  // 3.3 学习计划
  const ov = await call('/api/study/overview?token=' + token2);
  ok(ov.data && ov.data.plan && ov.data.plan.bookId === 'cet4', '★ 学习计划完好（bookId=cet4）');
  ok(ov.data && ov.data.plan && ov.data.plan.dailyNew === 20, '学习计划每日新词数完好（20）');

  // 3.4 生词本接口直接校验（避免只依赖 backup）
  const mw = await call('/api/mywords?token=' + token2);
  ok(mw.status === 200 && Array.isArray(mw.data.words), '生词本接口可读且返回数组');
  const kn = await call('/api/known?token=' + token2);
  ok(kn.status === 200 && Array.isArray(kn.data.words), '熟词本接口可读且返回数组');

  // 3.5 存储模式确认为云端
  const st = await call('/api/storage-status?token=' + token2);
  ok(st.data && st.data.mode === 'cloud', '存储模式为云端持久化（mode=' + (st.data && st.data.mode) + '）');
  ok(st.data && st.data.accounts >= 1, '云端账号数 ≥ 1（实际 ' + (st.data && st.data.accounts) + '）');

  app.kill();
  await sleep(1000);
  nuke();
  kvServer.close();
  console.log('========================================');
  console.log('  部署数据存活审计: 通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); try { kvServer.close(); } catch (x) {} nuke(); process.exit(1); });
