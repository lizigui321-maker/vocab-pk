/*
 * 学习题「详解弹出时机」修复测试（用户反馈：新词出题前先弹详解 = 泄题，太蠢）：
 *   A) 渲染新词题目时，禁止在「答题前」自动弹出详解（renderStuQuestion 不应调用 autoDetailOnce / openWordDetail）
 *   B) 选词模式答完「新词」后，自动弹详解（stuPick 触发 autoDetailOnce）
 *   C) 选词模式答完「复习词」后，不自动弹详解（仅新词才弹）
 *   D) 拼写模式答完「新词」后，自动弹详解（stuSpellSubmit 触发 autoDetailOnce）
 * 运行：node tools/study-detail-timing-test.js
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
const stuSpellSubmit = extract('stuSpellSubmit', 'stuPick');

let pass = 0, fail = 0;
function ok(c, m) { if (c) pass++; else { fail++; console.log('  ✗ ' + m); } }

/* ---- 极简 fake DOM（同 study-detail-ui-test 的 harness） ---- */
function makeEl(id, attrs) {
  return {
    id: id || null, attrs: attrs || {}, onclick: null, disabled: false,
    textContent: '', value: '', _h: '',
    set innerHTML(v) { this._h = v; }, get innerHTML() { return this._h; },
    classList: { add() {}, remove() {} },
    getAttribute(k) { return this.attrs[k]; }, focus() {}, addEventListener() {}
  };
}
const elCache = {};
function resetCache() { Object.keys(elCache).forEach(function (k) { delete elCache[k]; }); }
let app = {
  _html: '',
  set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; },
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
    const out = []; const re = /<button class="opt" data-i="(\d+)">/g; let m;
    while ((m = re.exec(this._html))) out.push(makeEl('opt' + m[1], { 'data-i': m[1] }));
    return out;
  }
};
global.app = app;
global.$ = (id) => {
  const qid = (id.charAt && id.charAt(0) === '#') ? id : '#' + id;
  const el = global.app && global.app.querySelector ? global.app.querySelector(qid) : null;
  if (el) return el;
  if (!elCache[qid]) elCache[qid] = makeEl(qid);
  return elCache[qid];
};
global.document = { body: { appendChild() {}, contains() { return true; } }, createElement() { return makeEl(); }, querySelectorAll() { return []; }, getElementById() { return makeEl(); } };

/* ---- 捕获式 setTimeout：只手动 flush 指定延时，避免自动跳题干扰断言 ---- */
const timers = [];
global.setTimeout = (fn, ms) => { timers.push({ fn, ms: ms || 0 }); return timers.length; };
function flush(ms) { const due = timers.filter(t => t.ms === ms); timers.length = 0; due.forEach(t => t.fn()); }
function clearTimers() { timers.length = 0; }

/* ---- 记录外部调用 ---- */
const detailCalls = [];       // openWordDetail
const autoDetailCalls = [];   // autoDetailOnce
global.openWordDetail = (w, l, o) => { detailCalls.push({ w, l, o }); };
global.autoDetailOnce = (w, l, o) => { autoDetailCalls.push({ w, l, o }); };
/* 音效函数：被抽出来跑的 stuPick / renderStuQuestion 会调用 playPick 等，
   无头环境无 AudioContext，直接置空，避免 ReferenceError 让整份测试崩在第一行。 */
global.playPick = () => {};
global.playCorrect = () => {};
global.playWrong = () => {};
global.playCountdown = () => {};
global._sfxTone = () => {};
global.token = 'ui-test-token';
global.speak = () => {};
global.toast = () => {};
global.confirm = () => true;
global.api = () => Promise.resolve({});
global.fetchDetail = (w, l, cb) => { cb({ ipa: '/x/' }); };
/* renderStuQuestion 会通过 fetchIPA 补音标（index.html 里的真实实现依赖
   DETAIL_CACHE / detailKey / fetchDetail）。这里直接给出结果，让被抽出来跑的
   renderStuQuestion 不会因为 ReferenceError 直接崩掉。 */
global.fetchIPA = (w, l, cb) => { cb({ ipa: 'test', audio: '' }); };
global.detailKey = (w, l) => String(w) + '|' + l;
global.DETAIL_CACHE = {};
global.stuQuit = () => {};
global.stuMarkKnown = () => {};
global.stuSpellSubmit = stuSpellSubmit;
global.stuPick = stuPick;
global.renderStuQuestion = renderStuQuestion;
global.shuffleStuOptions = shuffleStuOptions;
global.esc = esc;

function freshStu(n, isNewVal) {
  const queue = [];
  for (let i = 1; i <= n; i++) queue.push({
    word: 'word' + i, meaning: '释义' + i, lang: 'en',
    options: ['错A', '错B', '释义' + i, '错D'], correctIndex: 2, isNew: isNewVal
  });
  return {
    view: 'session', inputMode: 'choice', lastSpeak: null, sess: {
      queue: queue, idx: 0, marks: [], right: 0, wrong: 0,
      lang: 'en', autoSpeak: false, mode: 'unit', label: '测试', startedAt: Date.now(),
      wrongWords: []
    }
  };
}

/* ==== A) 渲染新词题目：答题前不得自动弹详解 ==== */
console.log('== A. 出题前不弹详解（修复核心） ==');
resetCache(); clearTimers();
detailCalls.length = 0; autoDetailCalls.length = 0;
global.stu = freshStu(3, true);
renderStuQuestion();
ok(autoDetailCalls.length === 0, '渲染新词题目时没有调用 autoDetailOnce（出题前不弹）');
ok(detailCalls.length === 0, '渲染新词题目时没有调用 openWordDetail（出题前不弹）');
ok(app.querySelector('#sqDetail') !== null, '题目上仍保留手动「📖 详解」按钮（用户可自愿先看）');

/* ==== B) 选词模式答完新词 → 自动弹详解 ==== */
console.log('== B. 新词答完后自动弹详解 ==');
resetCache(); clearTimers();
detailCalls.length = 0; autoDetailCalls.length = 0;
global.stu = freshStu(3, true);
renderStuQuestion();
stuPick(2); // 选对
ok(autoDetailCalls.length === 0, '刚答题、尚未到 350ms 时不弹（延时由定时器控制）');
flush(350);  // 触发答后自动弹
ok(autoDetailCalls.length === 1, '答完新词后触发一次 autoDetailOnce');
ok(autoDetailCalls[0].w === 'word1' && autoDetailCalls[0].l === 'en', '弹出的是本题新词（word1/en）');

/* ==== C) 选词模式答完复习词 → 不自动弹详解 ==== */
console.log('== C. 复习词答完不自动弹详解 ==');
resetCache(); clearTimers();
detailCalls.length = 0; autoDetailCalls.length = 0;
global.stu = freshStu(3, false); // isNew = false
renderStuQuestion();
stuPick(2);
flush(350);
ok(autoDetailCalls.length === 0, '复习词答完后不自动弹详解');
const fbC = app.querySelector('#sqFb');
ok(fbC !== null && /id="sqFbDetail"/.test(fbC.innerHTML), '复习词反馈区仍提供手动「本题详解」按钮');

/* ==== D) 拼写模式答完新词 → 自动弹详解 ==== */
console.log('== D. 拼写模式新词答完后自动弹详解 ==');
resetCache(); clearTimers();
detailCalls.length = 0; autoDetailCalls.length = 0;
global.stu = freshStu(2, true);
global.stu.inputMode = 'spell';
global.stu.sess.idx = 0;
global.stu.sess.queue[0].meaning = '结果';
renderStuQuestion();
// 提交拼写（拼错）
const inp = makeEl('sqInput', {});
app.querySelector = (sel) => {
  if (sel === '#sqInput') return inp;
  const qid = sel.charAt(0) === '#' ? sel : '#' + sel;
  if (!elCache[qid]) elCache[qid] = makeEl(qid);
  return elCache[qid];
};
inp.value = 'wordX';
stuSpellSubmit();
flush(350);
ok(autoDetailCalls.length === 1, '拼写模式答完新词后触发一次 autoDetailOnce');
ok(autoDetailCalls[0].w === 'word1', '拼写模式弹出的是本题新词（word1）');

console.log('========================================');
console.log('  详解弹出时机修复: 通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
