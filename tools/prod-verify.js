/*
 * 生产环境（Render）账号数据存活验证
 *
 * 用途：在真实线上环境验证「更新版本后用户数据是否还在」。
 *   首次运行（init）  ：注册/登录 → 制造学习数据 → 保存数据快照到本地
 *   验证运行（check）  ：重新登录 → 取回数据 → 与快照逐项对比
 *
 * 用法：
 *   node tools/prod-verify.js init     # 建号并制造数据（只需一次）
 *   node tools/prod-verify.js check    # 部署后验证数据是否还在
 *   node tools/prod-verify.js cleanup  # 清理测试账号
 */
'use strict';
const fs = require('fs');
const path = require('path');
const SITE = process.env.SITE || 'https://vocabpk.onrender.com';
const USER = process.env.USER || 'selftest01';
const PASS = process.env.PASS || 'TestPw2026!';
const SNAP = path.join(__dirname, '.prod_snap.json');

function call(p, token, body, method) {
  return fetch(SITE + p, {
    method: method || (body ? 'POST' : 'GET'),
    headers: Object.assign({ 'Content-Type': 'application/json' },
      token ? { Authorization: 'Bearer ' + token } : {}),
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => {
    let d = {};
    try { d = await r.json(); } catch (e) {}
    return { status: r.status, data: d };
  });
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function login() {
  const r = await call('/api/login', null, { username: USER, password: PASS });
  if (r.status !== 200 || !r.data.token) {
    console.log('❌ 登录失败（' + r.status + '）: ' + (r.data.error || JSON.stringify(r.data)));
    if (r.data.error) console.log('   → 这说明账号【不存在】或【密码不对】，数据很可能已丢失');
    return null;
  }
  return r.data.token;
}

/* 收集账号的全部关键数据，用于部署前后对比 */
async function collect(token) {
  const bk = await call('/api/backup?token=' + token);
  const b = bk.data.backup || {};
  const ov = await call('/api/study/overview?token=' + token);
  const mw = await call('/api/mywords?token=' + token);
  return {
    at: new Date().toISOString(),
    username: b.username || null,
    words: (b.words || []).map((x) => x.word),
    known: (b.known || []).map((x) => x.word),
    customBooks: (b.customBooks || []).map((x) => ({ id: x.id, name: x.name, n: (x.words || []).length })),
    progressKeys: Object.keys((b.study && b.study.progress) || {}).sort(),
    progressDetail: (b.study && b.study.progress) || {},
    logKeys: Object.keys((b.study && b.study.log) || {}).sort(),
    plan: (b.study && b.study.plan) || null,
    mywordsCount: (mw.data.words || []).length,
    overviewLearned: ov.data && ov.data.learned,
    overviewMastered: ov.data && ov.data.mastered,
  };
}

async function init() {
  console.log('=== init：在 ' + SITE + ' 建号并制造数据 ===');
  let r = await call('/api/register', null, { username: USER, password: PASS, name: '自测账号' });
  if (r.status === 409) { console.log('账号已存在，直接登录'); }
  else if (!r.data.token) { console.log('❌ 注册失败:', r.data.error || r.status); return 1; }
  const token = r.data.token || (await login());
  if (!token) return 1;
  console.log('✓ 登录成功:', USER);

  await call('/api/study/plan', token, { bookId: 'cet4', dailyNew: 20, vocabEstimate: 2000 });
  const sess = await call('/api/study/session?token=' + token);
  const qs = (sess.data.questions || []).slice(0, 6);
  let n = 0;
  for (const q of qs) {
    // 前 4 题故意答错（进生词本），后 2 题答对（提升 SRS 等级）
    await call('/api/study/answer', token, { word: q.word, correct: n >= 4, ms: 1500, meaning: q.meaning, lang: q.lang || 'en' });
    n++;
  }
  console.log('✓ 已作答 ' + n + ' 题（4 错 2 对）');
  await call('/api/study/markKnown', token, { word: 'persistentword', meaning: '持久化验证词', book: 'cet4', lang: 'en' });
  await call('/api/custombook', token, { name: '部署验证词书', lang: 'en', text: 'alpha 第一\ntheta 第八\nomega 最后' });
  console.log('✓ 已生成熟词本与自定义词书');
  await sleep(2000); // 等云端防抖写入

  const snap = await collect(token);
  fs.writeFileSync(SNAP, JSON.stringify(snap, null, 2));
  console.log('✓ 快照已保存 → tools/.prod_snap.json');
  console.log('  生词 ' + snap.words.length + ' · 熟词 ' + snap.known.length +
    ' · 词书 ' + snap.customBooks.length + ' · 进度 ' + snap.progressKeys.length + ' 词 · 日志 ' + snap.logKeys.length + ' 天');
  console.log('  生词示例: ' + snap.words.slice(0, 6).join(', '));
  return 0;
}

async function check() {
  console.log('=== check：验证部署后数据是否还在 ===');
  if (!fs.existsSync(SNAP)) { console.log('❌ 没有快照，请先运行 init'); return 1; }
  const before = JSON.parse(fs.readFileSync(SNAP, 'utf8'));
  const token = await login();
  if (!token) return 1;
  console.log('✓ 登录成功（账号与密码哈希完好）');
  const after = await collect(token);

  let pass = 0, fail = 0;
  function cmp(name, a, b) {
    const okk = JSON.stringify(a) === JSON.stringify(b);
    if (okk) { pass++; console.log('  ✓ ' + name); }
    else { fail++; console.log('  ✗ ' + name + '：部署前 ' + JSON.stringify(a) + ' → 现在 ' + JSON.stringify(b)); }
  }
  cmp('生词本', before.words, after.words);
  cmp('熟词本', before.known, after.known);
  cmp('自定义词书', before.customBooks, after.customBooks);
  cmp('学习进度词条', before.progressKeys, after.progressKeys);
  cmp('学习日志(打卡天)', before.logKeys, after.logKeys);
  cmp('学习计划', before.plan, after.plan);
  // 逐词核对 SRS 等级/错误次数/到期时间
  let mism = [];
  for (const k of before.progressKeys) {
    const x = before.progressDetail[k], y = after.progressDetail[k];
    if (!y) { mism.push(k + ':丢失'); continue; }
    if (x.lv !== y.lv) mism.push(k + ':lv');
    if (x.wrong !== y.wrong) mism.push(k + ':wrong');
    if (x.due !== y.due) mism.push(k + ':due');
  }
  if (mism.length) { fail++; console.log('  ✗ SRS 明细不一致: ' + mism.join(',')); }
  else { pass++; console.log('  ✓ 每个词的 SRS 等级/错误次数/到期时间逐项一致'); }

  console.log('----------------------------------------');
  console.log(fail === 0
    ? '✅ 数据全部完好（通过 ' + pass + ' 项）'
    : '❌ 数据丢失或损坏（通过 ' + pass + '，失败 ' + fail + '）');
  return fail ? 1 : 0;
}

async function cleanup() {
  const token = await login();
  if (!token) { console.log('账号已不存在，无需清理'); return 0; }
  await call('/api/mywords?token=' + token, null, 'DELETE');
  await call('/api/known?token=' + token, null, 'DELETE');
  await call('/api/study/reset', token, { scope: 'all' });
  for (const b of ((await call('/api/backup?token=' + token)).data.backup || {}).customBooks || []) {
    await call('/api/custombook?id=' + encodeURIComponent(b.id) + '&token=' + token, null, 'DELETE');
  }
  console.log('✓ 已清空该账号的学习数据（账号本身保留，如需删除请手动）');
  try { fs.unlinkSync(SNAP); } catch (e) {}
  return 0;
}

(async () => {
  const mode = process.argv[2] || 'check';
  let code = 1;
  if (mode === 'init') code = await init();
  else if (mode === 'check') code = await check();
  else if (mode === 'cleanup') code = await cleanup();
  else { console.log('用法: node tools/prod-verify.js init|check|cleanup'); code = 1; }
  process.exit(code);
})().catch((e) => { console.error('异常:', e.message); process.exit(1); });
