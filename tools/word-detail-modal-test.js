/*
 * 详解弹窗「居中词典卡片」重构冒烟测试（UI 优化后）：
 * 1) 弹窗结构：wd-sheet 卡片、✕ 关闭钮(#wdX)、发音钮(#wdSpeak)、底部操作栏(.wd-foot + .wd-done)
 * 2) 有词书释义时出现 #wdCopy 与 .wd-book，无则不出现
 * 3) fetchDetail 渲染：释义/搭配/例句/词形变化/考试标签 全部正确写入 #wdBody，音标写入 #wdIpa
 * 4) 交互关闭：ESC 键 / 点击遮罩 / ✕ 按钮 / 「我知道了」按钮，均移除弹窗并恢复滚动
 * 5) 滚动锁定：打开时 body overflow=hidden；关闭后恢复原值；连续打开两个弹窗只记录一次原值
 * 运行：node tools/word-detail-modal-test.js
 */
'use strict';
const fs = require('fs');
const html = fs.readFileSync('public/index.html', 'utf8');

function extract(fnName, nextName) {
  const start = html.indexOf('function ' + fnName);
  if (start < 0) { console.error('未找到 function ' + fnName); process.exit(2); }
  const end = html.indexOf('\nfunction ' + nextName, start + 10);
  const block = html.slice(start, end > 0 ? end : undefined);
  return new Function(block + '\nreturn ' + fnName + ';')();
}

/* ---- 极简 fake DOM（支持 id/class 递归查找、事件注册、remove） ---- */
function makeEl(tag, id, cls, attrStr) {
  const el = {
    tag: tag || 'div', id: id || null, cls: cls || '', _h: '', parentNode: null,
    style: {}, _kids: [], _handlers: {}, _cls: {}, _attrStr: attrStr || '',
    set innerHTML(v) { this._h = v; this._kids = []; registerChildren(this, v); },
    get innerHTML() { return this._h; },
    classList: {
      add(c) { el._cls[c] = 1; },
      remove(c) { delete el._cls[c]; },
      contains(c) { return !!el._cls[c]; }
    },
    querySelector(sel) { return findChild(this, sel); },
    querySelectorAll(sel) { return findChildren(this, sel); },
    addEventListener(t, fn) { el._handlers[t] = fn; },
    appendChild(c) { c.parentNode = el; el._kids.push(c); },
    remove() { if (el.parentNode) el.parentNode.removeChild(el); },
    contains(c) { return el === c || el._kids.some(function (k) { return k.contains(c); }); },
    /* 关联词 chip 的 onclick 走 btn.getAttribute('data-w') 取目标词，假元素必须支持，
       否则跳转测试会在点击瞬间抛 "getAttribute is not a function"。 */
    getAttribute(k) {
      const m = (this._attrStr || '').match(new RegExp(k + '="([^"]*)"'));
      return m ? m[1] : null;
    }
  };
  return el;
}
function registerChildren(el, v) {
  const re = /<([a-z]+)([^>]*)>/g;
  let m;
  while ((m = re.exec(v))) {
    const idM = m[2].match(/id="([^"]+)"/);
    const clsM = m[2].match(/class="([^"]+)"/);
    el._kids.push(makeEl(m[1], idM ? idM[1] : null, clsM ? clsM[1] : '', m[2] || ''));
  }
}
function findChild(el, sel) {
  const idM = sel.match(/^#(.+)$/);
  const clsM = sel.match(/^\.(.+)$/);
  for (let i = 0; i < el._kids.length; i++) {
    const k = el._kids[i];
    if (idM && k.id === idM[1]) return k;
    if (clsM && k.cls.split(/\s+/).indexOf(clsM[1]) >= 0) return k;
  }
  for (let i = 0; i < el._kids.length; i++) {
    const k = el._kids[i];
    if (idM && k.id === idM[1]) return k;
    const f = findChild(k, sel);
    if (f) return f;
  }
  return null;
}
function findChildren(el, sel) {
  const out = [];
  const clsM = sel.match(/^\.(.+)$/);
  (function walk(n) {
    for (let i = 0; i < n._kids.length; i++) {
      const k = n._kids[i];
      if (clsM && k.cls.split(/\s+/).indexOf(clsM[1]) >= 0) out.push(k);
      walk(k);
    }
  })(el);
  return out;
}

/* ---- fake document / body ---- */
const doc = {
  _overlays: [],
  body: {
    style: {},
    appendChild(el) { el.parentNode = doc.body; doc._overlays.push(el); },
    removeChild(el) { const i = doc._overlays.indexOf(el); if (i >= 0) doc._overlays.splice(i, 1); },
    contains(el) { return doc._overlays.indexOf(el) >= 0; }
  },
  createElement(t) { return makeEl(t); },
  querySelectorAll(sel) { return sel === '.wd-overlay' ? doc._overlays.slice() : []; },
  querySelector(sel) { return sel === '.wd-overlay' ? (doc._overlays[0] || null) : null; },
  _keys: {},
  addEventListener(t, fn) { doc._keys[t] = fn; },
  removeEventListener(t) { delete doc._keys[t]; }
};
global.document = doc;

/* 详解弹窗模块顶层有 window.addEventListener('popstate', ...)（关联词跳转的浏览器回退支持），
   缺了 window stub 会在模块加载时直接 ReferenceError: window is not defined。
   这里记录监听，便于后面用 fireWin('popstate') 模拟按下手机/浏览器回退键。 */
const winHandlers = {};
global.window = {
  addEventListener(t, fn) { (winHandlers[t] = winHandlers[t] || []).push(fn); },
  removeEventListener(t, fn) {
    const a = winHandlers[t] || []; const i = a.indexOf(fn);
    if (i >= 0) a.splice(i, 1);
  }
};
function fireWin(type, ev) { (winHandlers[type] || []).slice().forEach(function (fn) { fn(ev || {}); }); }
/* 关联词跳转用 history.pushState 压栈、history.go(-n) 关弹窗时清栈 */
const histLog = [];
global.history = {
  pushState(s) { histLog.push(['push', s && s.wdNav]); },
  go(n) { histLog.push(['go', n]); }
};

let pass = 0, fail = 0;
function ok(c, m) { if (c) pass++; else { fail++; console.log('  ✗ ' + m); } }

/* ---- stub 外部依赖 ---- */
const esc = extract('esc', 'toast');
global.wdEscape = esc;
const fetchDetailCalls = [];
const MOCK = {
  ipa: 'ˈæp.əl', ipaUk: 'ˈæp.ʊl',
  senses: [{ pos: 'n.', def: '苹果' }, { pos: 'v.', def: '（使）变成苹果' }],
  phrases: [{ ph: 'apple pie', tr: '苹果派' }],
  examples: [{ en: 'An apple a day keeps the doctor away.', zh: '一天一苹果，医生远离我。' }],
  forms: [{ name: '复数', value: 'apples' }],
  exams: ['中考', '高考']
};
global.fetchDetail = (w, l, cb) => { fetchDetailCalls.push([w, l]); cb(MOCK); };
global.speak = () => {};
global.copyText = () => {};
global.setTimeout = (fn) => { fn(); return 0; };   // close 的延迟移除立即执行，便于断言

/* ---- 提取真实弹窗模块（含 wdActive/wdScrollLock/wdOnKey/openWordDetail） ---- */
const start = html.indexOf('var wdActive');
const end = html.indexOf('\nfunction autoDetailOnce', start);
if (start < 0 || end < 0) { console.error('未找到详解弹窗模块'); process.exit(2); }
const block = html.slice(start, end);
const mod = new Function(block + '\nreturn { openWordDetail: openWordDetail, wdOnKey: wdOnKey, getLock: function(){ return wdScrollLock; }, getActive: function(){ return wdActive; } };')();

console.log('== 详解弹窗结构 ==');
let ov = mod.openWordDetail('apple', 'en', { meaning: '苹果' });
ok(ov && ov.className === 'wd-overlay', '创建 wd-overlay');
let sheet = ov.querySelector('.wd-sheet');
ok(!!sheet, '存在 .wd-sheet 卡片');
ok(!!ov.querySelector('#wdX'), '存在 ✕ 关闭按钮 (#wdX)');
ok(!!ov.querySelector('#wdSpeak'), '存在发音按钮 (#wdSpeak)');
ok(!!ov.querySelector('.wd-foot'), '存在底部操作栏 (.wd-foot)');
let doneBtn = ov.querySelector('#wdClose');
ok(!!doneBtn && doneBtn.cls.indexOf('wd-done') >= 0, '「我知道了」按钮带渐变主样式 .wd-done');
ok(!!ov.querySelector('#wdCopy'), '有词书释义时出现复制按钮 (#wdCopy)');
ok(!!ov.querySelector('.wd-book'), '有词书释义时出现词书释义条 (.wd-book)');
ok(doc.body.style.overflow === 'hidden', '打开弹窗后锁定背景滚动');
ok(fetchDetailCalls.length === 1 && fetchDetailCalls[0][0] === 'apple', '调用 fetchDetail 查询 apple');

console.log('== 详情渲染 ==');
let body = ov.querySelector('#wdBody');
let ipaEl = ov.querySelector('#wdIpa');
ok(ipaEl.textContent === '/ˈæp.əl/　英 /ˈæp.ʊl/', '音标含美音+英音标注: ' + ipaEl.textContent);
ok(body.innerHTML.indexOf('wd-sense') >= 0 && body.innerHTML.indexOf('苹果') >= 0, '释义渲染 wd-sense + 中文释义');
ok(body.innerHTML.indexOf('wd-exam') >= 0 && body.innerHTML.indexOf('中考') >= 0, '考试标签渲染');
ok(body.innerHTML.indexOf('apple pie') >= 0 && body.innerHTML.indexOf('苹果派') >= 0, '常用搭配渲染');
ok(body.innerHTML.indexOf('An apple a day') >= 0 && body.innerHTML.indexOf('一天一苹果') >= 0, '例句渲染（英+中）');
ok(body.innerHTML.indexOf('wd-form') >= 0 && body.innerHTML.indexOf('apples') >= 0, '词形变化渲染');

console.log('== 关闭交互 ==');
// 关闭前先确认 overlay 存在
ok(doc._overlays.length === 1, '当前有 1 个弹窗');
doneBtn.onclick();  // 「我知道了」
ok(doc._overlays.length === 0, '点击「我知道了」关闭弹窗');
ok(doc.body.style.overflow === '', '关闭后恢复背景滚动（原值为空串）');
ok(mod.getLock() === null, '关闭后滚动锁状态复位');

// 遮罩点击关闭
ov = mod.openWordDetail('banana', 'en');
ok(doc.body.style.overflow === 'hidden', '再次打开重新锁定滚动');
/* 复制按钮与词书条是常驻节点，靠 display:none 隐藏（跳词时不一定有词书义），
   所以这里断言「隐藏」而非「不存在」。 */
ok(ov.querySelector('#wdCopy').style.display === 'none' && ov.querySelector('.wd-book').style.display === 'none',
  '无词书释义时隐藏复制按钮/词书条（display:none）');
ov._handlers.click({ target: ov });  // 点击遮罩
ok(doc._overlays.length === 0, '点击遮罩关闭弹窗');
ok(doc.body.style.overflow === '', '遮罩关闭后恢复滚动');

// ✕ 按钮关闭
ov = mod.openWordDetail('cherry', 'en', { meaning: '樱桃' });
ov.querySelector('#wdX').onclick();
ok(doc._overlays.length === 0, '✕ 按钮关闭弹窗');

// ESC 关闭
ov = mod.openWordDetail('date', 'en', { meaning: '日期' });
mod.wdOnKey({ key: 'Escape' });
ok(doc._overlays.length === 0, 'ESC 键关闭弹窗');
ok(doc.body.style.overflow === '', 'ESC 关闭后恢复滚动');

console.log('== 连续打开两个弹窗（滚动锁只记录一次） ==');
const ovA = mod.openWordDetail('elder', 'en', { meaning: '长者' });
const lockVal = mod.getLock();
const ovB = mod.openWordDetail('fig', 'en', { meaning: '无花果' });
ok(mod.getLock() === lockVal, '第二次打开不覆盖滚动锁原值');
ok(doc._overlays.length === 1, '第二次打开先移除旧弹窗（始终只有一个）');
ok(doc._overlays[0] === ovB, '当前弹窗是新的 fig');
ovB.querySelector('#wdClose').onclick();
ok(doc._overlays.length === 0 && doc.body.style.overflow === '', '关闭后恢复滚动（原值正确）');

console.log('== 关闭动画类 ==');
ov = mod.openWordDetail('grape', 'en', { meaning: '葡萄' });
ov.querySelector('#wdClose').onclick();
ok(ov.classList.contains('wd-out') && ov.querySelector('.wd-sheet').classList.contains('wd-out'), '关闭时附加 .wd-out 淡出动画类');

console.log('== 词根词源区块（来自真实词源，无则不渲染） ==');
MOCK.etym = 'tele- “at a distance” + -phone “sound”';
let ovE = mod.openWordDetail('telephone', 'en', { meaning: '电话' });
let bodyE = ovE.querySelector('#wdBody');
ok(bodyE.innerHTML.indexOf('词根词源') >= 0, '有词源时渲染「词根词源」区块');
ok(bodyE.innerHTML.indexOf('at a distance') >= 0, '词源正文正确渲染: ' + (bodyE.innerHTML.match(/wd-etym">([^<]*)</) || [, ''])[1]);
MOCK.etym = '';
let ovN = mod.openWordDetail('nomatch', 'en', { meaning: '无' });
let bodyN = ovN.querySelector('#wdBody');
ok(bodyN.innerHTML.indexOf('词根词源') < 0, '无词源时不渲染「词根词源」区块（绝不杜撰）');

console.log('== 关联词区块（近义 / 同根派生 / 反义）渲染 ==');
MOCK.etym = '';
MOCK.synonyms = [{ pos: 'adj.', tran: '高兴的', words: ['glad', 'pleased'] }];
MOCK.related = [{ pos: 'n.', words: [{ word: 'happiness', tran: '幸福' }] }];
MOCK.antonyms = ['sad'];
let ovR = mod.openWordDetail('happy', 'en', { meaning: '快乐的' });
let bodyR = ovR.querySelector('#wdBody');
ok(bodyR.innerHTML.indexOf('近义词') >= 0, '渲染「近义词」区块');
ok(bodyR.innerHTML.indexOf('同根 · 派生词') >= 0, '渲染「同根·派生词」区块');
ok(bodyR.innerHTML.indexOf('反义词') >= 0, '渲染「反义词」区块');
ok(bodyR.innerHTML.indexOf('glad') >= 0, '近义词渲染出具体词');
ok(bodyR.innerHTML.indexOf('幸福') >= 0, '派生词带中文释义');

console.log('== 关联词 chip 点击跳转 + 返回 ==');
let chips = bodyR.querySelectorAll('.wd-chip');
ok(chips.length >= 4, 'chip 覆盖近义/派生/反义三类（数量 ' + chips.length + '）');
ok(ovR.querySelector('#wdBack').style.display === 'none', '未跳转时隐藏「← 返回」按钮');
let target = null;
for (let i = 0; i < chips.length; i++) { if (chips[i].getAttribute('data-w') === 'happiness') target = chips[i]; }
ok(!!target, '找到 data-w=happiness 的 chip');
if (target) {
  target.onclick();
  ok(ovR.querySelector('#wdWord').textContent === 'happiness',
    '点击派生词 chip 跳到 happiness（实际 ' + ovR.querySelector('#wdWord').textContent + '）');
  ok(ovR.querySelector('#wdBack').style.display === '', '跳转后出现「← 返回」按钮');
  ok(histLog.some(function (h) { return h[0] === 'push'; }), '跳转时 history.pushState 压栈（回退键可用）');
  const before = fetchDetailCalls.length;
  ovR.querySelector('#wdBack').onclick();
  ok(ovR.querySelector('#wdWord').textContent === 'happy',
    '点「← 返回」回到 happy（实际 ' + ovR.querySelector('#wdWord').textContent + '）');
  ok(fetchDetailCalls.length > before, '返回后重新拉取该词释义');
  ok(ovR.querySelector('#wdBack').style.display === 'none', '回到首个词后隐藏「← 返回」');
}

console.log('== 浏览器/手机回退键（popstate）逐层返回 ==');
let ovP = mod.openWordDetail('happy', 'en', { meaning: '快乐的' });
let chipsP = ovP.querySelector('#wdBody').querySelectorAll('.wd-chip');
let t2 = null;
for (let i = 0; i < chipsP.length; i++) { if (chipsP[i].getAttribute('data-w') === 'glad') t2 = chipsP[i]; }
ok(!!t2, '找到 data-w=glad 的 chip');
if (t2) {
  t2.onclick();
  ok(ovP.querySelector('#wdWord').textContent === 'glad', '跳转到 glad');
  fireWin('popstate');                       // 模拟按下回退键
  ok(ovP.querySelector('#wdWord').textContent === 'happy',
    '按回退键返回上一个词 happy（实际 ' + ovP.querySelector('#wdWord').textContent + '）');
  ok(doc._overlays.length === 1, '回退键返回的是「上一个词」，不是关掉整个弹窗');
  fireWin('popstate');                       // 栈已空 → 再按一次应当关闭弹窗
  ok(doc._overlays.length === 0, '导航栈空后再按回退键才关闭弹窗');
}

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
