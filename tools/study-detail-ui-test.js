/*
 * 学习题「详解按钮」UI 冒烟测试（需求 5）：
 * 1) 答题后（无论对错）反馈区出现「📖 本题详解」按钮，点击打开当前词的详解
 * 2) 从第 2 题起出现「⬅ 上一词详解」按钮，点击打开上一题的词（含拼写模式）
 * 3) 拼写模式答题前不显示答案音标（防泄题），答错后反馈区可看详解
 * 运行：node tools/study-detail-ui-test.js
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

const esc = extract('esc', 'toast');
const shuffleStuOptions = extract('shuffleStuOptions', 'renderStuQuestion');
const renderStuQuestion = extract('renderStuQuestion', 'stuSpellSubmit');
const stuPick = extract('stuPick', 'stuQuit');

let pass = 0, fail = 0;
function ok(c, m) { if (c) pass++; else { fail++; console.log('  ✗ ' + m); } }

/* ---- 极简 fake DOM ---- */
function makeEl(id, attrs) {
  return {
    id: id || null,
    attrs: attrs || {},
    onclick: null,
    disabled: false,
    textContent: '',
    value: '',
    _h: '',
    set innerHTML(v) { this._h = v; },
    get innerHTML() { return this._h; },
    classList: { add() {}, remove() {} },
    getAttribute(k) { return this.attrs[k]; },
    focus() {},
    addEventListener() {}
  };
}
const elCache = {}; // 按 id 缓存元素，保证真实代码绑定的事件与测试断言的实例一致
function resetCache() { Object.keys(elCache).forEach(function (k) { delete elCache[k]; }); }
function findInHtml(html, id) { return new RegExp('id="' + id + '"').test(html) ? makeEl(id) : null; }
let app = null;
global.$ = (id) => {
  // 真实代码统一传 '#id'，测试里也可能传 'id'，统一规范化
  const qid = (id.charAt && id.charAt(0) === '#') ? id : '#' + id;
  const el = global.app && global.app.querySelector ? global.app.querySelector(qid) : null;
  if (el) return el;
  if (!elCache[qid]) elCache[qid] = makeEl(qid);
  return elCache[qid];
};app = {
  _html: '',
  set innerHTML(v) { this._html = v; },
  get innerHTML() { return this._html; },
  querySelector(sel) {
    if (!sel.startsWith('#')) return null;
    const id = sel.slice(1);
    const re = new RegExp('id="' + id + '"');
    if (!re.test(this._html)) return null;
    if (!elCache[id]) {
      const attrs = {};
      const di = this._html.match(new RegExp('<button[^>]*id="' + id + '"[^>]*>'));
      if (di && /data-i="(\d+)"/.test(di[0])) attrs['data-i'] = di[0].match(/data-i="(\d+)"/)[1];
      elCache[id] = makeEl(id, attrs);
    }
    return elCache[id];
  },
  querySelectorAll(sel) {
    if (sel !== '#sqOpts .opt') return [];
    const out = [];
    const re = /<button class="opt" data-i="(\d+)">/g;
    let m;
    while ((m = re.exec(this._html))) out.push(makeEl('opt' + m[1], { 'data-i': m[1] }));
    return out;
  }
};
global.app = app;
global.document = { body: { appendChild() {}, contains() { return true; } }, createElement() { return makeEl(); }, querySelectorAll() { return []; }, getElementById() { return makeEl(); } };

/* ---- stub 外部依赖 ---- */
const detailCalls = [];
global.openWordDetail = (w, l, o) => { detailCalls.push({ w: w, l: l, o: o }); };
global.token = 'ui-test-token';
global.speak = () => {};
global.toast = () => {};
global.confirm = () => true;
global.api = () => Promise.resolve({});
global.fetchDetail = (w, l, cb) => { cb({ ipa: '/x/' }); };
/* renderStuQuestion 会通过 fetchIPA 补音标（真实实现依赖 DETAIL_CACHE / detailKey /
   fetchDetail）。直接给结果，避免抽出来跑的 renderStuQuestion 抛 ReferenceError。 */
global.fetchIPA = (w, l, cb) => { cb({ ipa: 'test', audio: '' }); };
global.detailKey = (w, l) => String(w) + '|' + l;
global.DETAIL_CACHE = {};
global.autoDetailOnce = () => {};
/* 音效函数：被抽出来跑的 stuPick / renderStuQuestion 会调用 playPick 等，
   无头环境无 AudioContext，直接置空，避免 ReferenceError 让整份测试崩在第一行。 */
global.playPick = () => {};
global.playCorrect = () => {};
global.playWrong = () => {};
global.playCountdown = () => {};
global._sfxTone = () => {};
global.stuQuit = () => {};
global.stuMarkKnown = () => {};
global.stuSpellSubmit = () => {};
global.stuPick = stuPick;
global.renderStuQuestion = renderStuQuestion;
global.shuffleStuOptions = shuffleStuOptions;
global.esc = esc;
global.$ = global.$;
const realSetTimeout = setTimeout;
global.setTimeout = () => 0; // 不自动跳题，便于断言反馈区
global.setInterval = () => 0;

function freshStu(n) {
  const queue = [];
  for (let i = 1; i <= n; i++) queue.push({
    word: 'word' + i, meaning: '释义' + i, lang: 'en',
    options: ['错A', '错B', '释义' + i, '错D'], correctIndex: 2, isNew: true
  });
  return {
    view: 'session', inputMode: 'choice', lastSpeak: null, sess: {
      queue: queue, idx: 0, marks: [], right: 0, wrong: 0,
      lang: 'en', autoSpeak: false, mode: 'unit', label: '测试', startedAt: Date.now(),
      wrongWords: []
    }
  };
}

/* ==== 场景 1：选择模式，答对 → 反馈区出现本题详解，点击打开当前词 ==== */
console.log('== 1. 选择题答对后「本题详解」 ==');
resetCache();
global.stu = freshStu(3);
renderStuQuestion();
let opts = app.querySelectorAll('#sqOpts .opt');
ok(opts.length === 4, '渲染出 4 个选项（实际 ' + opts.length + '）');
ok(app.querySelector('#sqPrevDetail') === null, '第 1 题不显示「上一词详解」');
stuPick(2); // 选对
let fbEl = app.querySelector('#sqFb');
if (process.env.DBG) { console.log('DEBUG _html 含sqFb:', /id="sqFb"/.test(app._html)); console.log('DEBUG fbEl:', fbEl && JSON.stringify(fbEl.innerHTML).slice(0, 200)); console.log('DEBUG cache:', Object.keys(elCache)); }
ok(fbEl !== null && /id="sqFbDetail"/.test(fbEl.innerHTML), '反馈区包含「本题详解」按钮');
let fbd = global.$('sqFbDetail');
ok(typeof fbd.onclick === 'function', 'sqFbDetail 已绑定点击事件');
fbd.onclick();
ok(detailCalls.length === 1 && detailCalls[0].w === 'word1' && detailCalls[0].l === 'en', '点击打开当前词详解（word1）');

/* ==== 场景 2：答错 → 反馈区同样有本题详解；进入下一题出现上一词按钮 ==== */
console.log('== 2. 选择题答错 + 上一词详解 ==');
detailCalls.length = 0;
resetCache();
global.stu = freshStu(3);
stu.sess.idx = 1; // 直接到第 2 题
renderStuQuestion();
ok(app.querySelector('#sqPrevDetail') !== null, '第 2 题显示「上一词详解」按钮');
app.querySelector('#sqPrevDetail').onclick();
ok(detailCalls.length === 1 && detailCalls[0].w === 'word1', '点击「上一词详解」打开上一题词（word1）');
detailCalls.length = 0;
stuPick(0); // 答错
fbEl = app.querySelector('#sqFb');
ok(fbEl !== null && /id="sqFbDetail"/.test(fbEl.innerHTML), '答错时反馈区也有「本题详解」按钮');
global.$('sqFbDetail').onclick();
ok(detailCalls.length === 1 && detailCalls[0].w === 'word2', '答错后点按钮打开的是本题词（word2）');

/* ==== 场景 3：拼写模式，答题前无答案音标，答错后反馈区可看详解 ==== */
console.log('== 3. 拼写模式防泄题 + 反馈详解 ==');
detailCalls.length = 0;
resetCache();
global.stu = freshStu(2);
stu.inputMode = 'spell';
stu.sess.idx = 0;
stu.sess.queue[0].meaning = '结果';
renderStuQuestion();
ok(!/sqSpeak|sqIpa/.test(app._html.replace(/"sqInput"/, '')), '拼写题不渲染答案音标/朗读按钮');
ok(app.querySelector('#sqHear') !== null, '拼写题提供「听发音」帮助按钮');
ok(app.querySelector('#sqFb') !== null && app.querySelector('#sqFb').innerHTML === '', '拼写题提交前反馈区无「本题详解」');
// 模拟提交（走 stuSpellSubmit 真实代码，需再提取）
const stuSpellSubmit = extract('stuSpellSubmit', 'stuPick');
global.stuSpellSubmit = stuSpellSubmit;
let inp = makeEl('sqInput', {});
app.querySelector = (sel) => { // 允许 sqInput 返回带 value 的假输入框（避免与 $ 互相递归）
  if (sel === '#sqInput') return inp;
  const qid = sel.charAt(0) === '#' ? sel : '#' + sel;
  if (!elCache[qid]) elCache[qid] = makeEl(qid);
  return elCache[qid];
};
inp.value = 'wordX'; // 拼错
stuSpellSubmit();
fbEl = app.querySelector('#sqFb');
ok(fbEl !== null && /id="sqFbDetail"/.test(fbEl.innerHTML), '拼写答错后反馈区出现「本题详解」');
global.$('sqFbDetail').onclick();
ok(detailCalls.length === 1 && detailCalls[0].w === 'word1' && detailCalls[0].l === 'en', '拼写题详解按钮打开正确词（word1/en）');

global.setTimeout = realSetTimeout;
console.log('========================================');
console.log('  学习题详解按钮: 通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
