/* 学习逻辑回归测试：错题是否回到每日队列 / 生词本与熟词本互斥 / 临时加学 / 熟词本排除 */
'use strict';
const http = require('http');
const BASE = process.env.BASE_URL || 'http://localhost:3302';

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
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? ' -> ' + extra : '')); }
}
const uname = () => 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/* 用一本极小的自定义词书，保证出题切片一定包含我们关注的词（避免随机/词频过滤掩盖问题） */
async function setup(token) {
  const cb = await api('POST', '/api/custombook', {
    name: 'T', lang: 'en',
    text: 'alpha 阿尔法\nbeta 贝塔\ngamma 伽马\ndelta 德尔塔\nomega 欧米伽',
  }, token);
  if (cb.status !== 200) throw new Error('创建自定义词书失败: ' + JSON.stringify(cb.json));
  const pl = await api('POST', '/api/study/plan', { bookId: cb.json.id, dailyNew: 10, vocabEstimate: 0 }, token);
  if (pl.status !== 200) throw new Error('设置计划失败: ' + JSON.stringify(pl.json));
  return cb.json.id;
}

async function main() {
  const u = uname();
  const reg = await api('POST', '/api/register', { username: u, password: 'pw123456', name: u });
  if (reg.status !== 200) throw new Error('注册失败: ' + JSON.stringify(reg.json));
  const T = reg.json.token;
  const bookId = await setup(T);
  console.log('自定义词书:', bookId);

  console.log('\n=== 场景1：答错的词必须回到「每日学习」队列（lv=0 到期词不被吞掉）===');
  {
    // 直接注入一条「已学过但答错、且已到期」的进度：lv=0 / n=1 / due 在过去
    // （答错后服务端会把词置为 lv=0、10 分钟后到期，这里等价模拟到期之后的状态）
    const ov = await api('GET', '/api/study/overview', null, T);
    const plan = ov.json.plan;
    const rs = await api('POST', '/api/restore', {
      backup: {
        study: {
          plan: plan,
          progress: { alpha: { lv: 0, n: 1, c: 0, wrong: 1, due: Date.now() - 60000, firstAt: Date.now(), lastAt: Date.now() } },
          log: {},
        },
      },
    }, T);
    check('注入错题进度成功', rs.status === 200, JSON.stringify(rs.json));

    const sess = await api('GET', '/api/study/session?mode=daily', null, T);
    const words = (sess.json.questions || []).map((q) => q.word);
    check('答错且已到期的 alpha 出现在每日学习队列', words.includes('alpha'), '队列=' + JSON.stringify(words));
    check('每日队列给出了复习词计数', (sess.json.reviewCount || 0) >= 1, 'reviewCount=' + sess.json.reviewCount);
  }

  console.log('\n=== 场景2：总览「待复习」计数也要含错题（口径一致）===');
  {
    const ov = await api('GET', '/api/study/overview', null, T);
    check('待复习数 >= 1', (ov.json.due || 0) >= 1, 'due=' + ov.json.due);
  }

  console.log('\n=== 场景3：加入生词本必须同时移出熟词本（不能同词两属）===');
  {
    // 先把 beta 标记为熟词
    const mk = await api('POST', '/api/study/markKnown', { word: 'beta', meaning: '贝塔' }, T);
    check('标记 beta 为熟词成功', mk.status === 200, JSON.stringify(mk.json));
    let kn = await api('GET', '/api/known', null, T);
    check('beta 已进入熟词本', (kn.json.words || []).some((x) => x.word === 'beta'), JSON.stringify(kn.json.words));

    // 再手动把 beta 收回生词本
    const add = await api('POST', '/api/mywords/add', { word: 'beta', meaning: '贝塔' }, T);
    check('手动加入生词本成功', add.status === 200, JSON.stringify(add.json));
    kn = await api('GET', '/api/known', null, T);
    check('beta 已自动移出熟词本（不会同词两属）', !(kn.json.words || []).some((x) => x.word === 'beta'), JSON.stringify(kn.json.words));
    const mw = await api('GET', '/api/mywords', null, T);
    check('beta 确实在生词本里', (mw.json.words || []).some((x) => x.word === 'beta'), JSON.stringify(mw.json.words));

    // 关键：此时 beta 必须能被学到（若仍在熟词本会被永久过滤）
    const sess = await api('GET', '/api/study/session?mode=daily', null, T);
    const words = (sess.json.questions || []).map((q) => q.word);
    check('移回生词本后 beta 重新可被学到', words.includes('beta'), '队列=' + JSON.stringify(words));
  }

  console.log('\n=== 场景4：临时加学 extraNew 可突破当日计划量 ===');
  {
    const u2 = uname();
    const r2 = await api('POST', '/api/register', { username: u2, password: 'pw123456', name: u2 });
    const T2 = r2.json.token;
    await setup(T2);
    await api('POST', '/api/study/plan', { dailyNew: 10, vocabEstimate: 0 }, T2);
    // 词书只有 5 个词，计划 10 个新词，所以不加学就已经是全部 5 个；改为验证 extraNew 至少不报错且可叠加
    const s1 = await api('GET', '/api/study/session?mode=daily&extraNew=0', null, T2);
    const s2 = await api('GET', '/api/study/session?mode=daily&extraNew=3', null, T2);
    check('extraNew=0 正常返回题目', (s1.json.questions || []).length > 0, 'n=' + (s1.json.questions || []).length);
    check('extraNew=3 正常返回题目', (s2.json.questions || []).length > 0, 'n=' + (s2.json.questions || []).length);
    check('extraNew 被正确回显', s2.json.extraNew === 3, 'extraNew=' + s2.json.extraNew);
  }

  console.log('\n=== 场景5：熟词本单词不出现在每日 / 单元 / 复习（上一轮修复的回归）===');
  {
    const u3 = uname();
    const r3 = await api('POST', '/api/register', { username: u3, password: 'pw123456', name: u3 });
    const T3 = r3.json.token;
    await setup(T3);
    await api('POST', '/api/study/markKnown', { word: 'gamma', meaning: '伽马' }, T3);

    const d = await api('GET', '/api/study/session?mode=daily', null, T3);
    check('熟词 gamma 不在每日队列', !(d.json.questions || []).map((q) => q.word).includes('gamma'));
    const un = await api('GET', '/api/study/session?mode=unit&unit=0', null, T3);
    check('熟词 gamma 不在单元队列', !(un.json.questions || []).map((q) => q.word).includes('gamma'));
    const rv = await api('GET', '/api/study/session?mode=review', null, T3);
    check('熟词 gamma 不在复习队列', !(rv.json.questions || []).map((q) => q.word).includes('gamma'));
  }

  console.log('\n=== 场景6：熟词本「移回生词本」(toWrong=1) 后必须能重新学到 ===');
  {
    const u4 = uname();
    const r4 = await api('POST', '/api/register', { username: u4, password: 'pw123456', name: u4 });
    const T4 = r4.json.token;
    await setup(T4);
    await api('POST', '/api/study/markKnown', { word: 'delta', meaning: '德尔塔' }, T4);
    const del = await api('DELETE', '/api/known?word=delta&toWrong=1', null, T4);
    check('熟词 delta 移回生词本成功', del.status === 200, JSON.stringify(del.json));
    const kn = await api('GET', '/api/known', null, T4);
    check('delta 已不在熟词本', !(kn.json.words || []).some((x) => x.word === 'delta'));
    const mw = await api('GET', '/api/mywords', null, T4);
    check('delta 已进入生词本', (mw.json.words || []).some((x) => x.word === 'delta'));
    const sess = await api('GET', '/api/study/session?mode=daily', null, T4);
    const words = (sess.json.questions || []).map((q) => q.word);
    check('移回后 delta 重新可被每日学到', words.includes('delta'), '队列=' + JSON.stringify(words));
    const rv = await api('GET', '/api/study/session?mode=review', null, T4);
    check('移回后 delta 也进入智能复习', (rv.json.questions || []).map((q) => q.word).includes('delta'), '队列=' + JSON.stringify((rv.json.questions || []).map((q) => q.word)));
  }

  console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('❌ 异常:', e.message); process.exit(1); });
