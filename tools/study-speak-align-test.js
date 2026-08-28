/*
 * 学习题「发音与详解卡片对齐」回归测试（用户反馈 bug：
 *   答完新词后自动弹上一词详解卡片，但此时下一题的「自动发音」却响起，
 *   导致看着上一词的卡片却听到当前词的发音，声音与卡片错配）。
 * 修复点：renderStuQuestion 的自动发音定时器在弹窗开着时改为挂起（stuPendingSpeak），
 *         openWordDetail 的 close() 在弹窗关闭后补播挂起的当前题发音。
 * 运行：node tools/study-speak-align-test.js
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
const openWordDetail = extract('openWordDetail', 'autoDetailOnce');
const autoDetailOnce = extract('autoDetailOnce', 'shuffleStuOptions');
const shuffleStuOptions = extract('shuffleStuOptions', 'renderStuQuestion');
const renderStuQuestion = extract('renderStuQuestion', 'stuSpellSubmit');
const stuPick = extract('stuPick', 'stuQuit');

let pass = 0, fail = 0;
function ok(c, m) { if (c) pass++; else { fail++; console.log('  ✗ ' + m); } }

/* ---- 捕获式定时器 ---- */
const timers = [];
global.setTimeout = (fn, ms) => { timers.push({ fn, ms: ms || 0 }); return timers.length; };
function flush(ms) { const due = timers.filter(t => t.ms === ms); timers.length = 0; due.forEach(t => t.fn()); }
function clearTimers() { timers.length = 0; }

/* ---- 捕获 speak / openWordDetail ---- */
const speakCalls = [];
global.speak = (w, l) => { speakCalls.push({ w: w, l: l }); };
const detailCalls = [];
global.openWordDetail = openWordDetail; // 用真实实现，便于触发 wdActive / close
global.autoDetailOnce = (w, l, o) => { detailCalls.push({ w, l, o }); autoDetailOnce(w, l, o); };
global.wdEscape = (s) => s == null ? '' : String(s);
global.copyText = () => {};
global.fetchDetail = (w, l, cb) => { cb({ ipa: '/x/', ipaUs: '/x/' }); };
global.toast = () => {};
global.confirm = () => true;
global.api = () => Promise.resolve({});
global.token = 'ui-test-token';
global.wdActive = null;
global.wdScrollLock = null;
global.stuPendingSpeak = null;
global.wdOnKey = () => {};
global.wdAutoShown = {};
global.detailKey = (w, l) => String(w) + '|' + l; // autoDetailOnce 去重用
global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

/* ---- 假 DOM ---- */
function makeEl(id) {
  const el = {
    id: id || null, onclick: null, disabled: false, textContent: '', value: '', _h: '',
    _attrs: {}, classList: { add() {}, remove() {} },
    getAttribute(k) { return this._attrs[k]; }, setAttribute(k, v) { this._attrs[k] = v; },
    focus() {}, addEventListener() {}, removeEventListener() {}, appendChild() {},
    querySelector(sel) { return makeEl(String(sel).replace('#', '')); },
    querySelectorAll() { return []; }
  };
  Object.defineProperty(el, 'innerHTML', { get() { return this._h; }, set(v) { this._h = v; } });
  return el;
}
const body = { children: [], style: {}, appendChild(c) { c.parentNode = body; body.children.push(c); }, contains() { return true; } };
body.removeChild = (c) => { const i = body.children.indexOf(c); if (i >= 0) body.children.splice(i, 1); };
global.document = {
  body,
  createElement() { return makeEl(); },
  getElementById() { return makeEl(); },
  addEventListener() {}, removeEventListener() {},
  querySelector(sel) {
    if (sel === '.wd-overlay') return body.children.length ? body.children[body.children.length - 1] : null;
    return makeEl();
  },
  querySelectorAll(sel) { if (sel === '.wd-overlay') return body.children; return []; }
};

/* ---- app / $ harness（解析 innerHTML 中的 id） ---- */
const appCache = {};
function makeApp() {
  return {
    _html: '',
    set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; },
    querySelector(sel) {
      if (!sel.startsWith('#')) return null;
      const id = sel.slice(1);
      const re = new RegExp('id="' + id + '"');
      if (!re.test(this._html)) return null;
      if (!appCache[id]) {
        const attrs = {};
        const di = this._html.match(new RegExp('<button[^>]*id="' + id + '"[^>]*>'));
        if (di && /data-i="(\d+)"/.test(di[0])) attrs['data-i'] = di[0].match(/data-i="(\d+)"/)[1];
        appCache[id] = makeEl(id, attrs);
      }
      return appCache[id];
    },
    querySelectorAll(sel) {
      if (sel !== '#sqOpts .opt') return [];
      const out = []; const re = /<button class="opt" data-i="(\d+)">/g; let m;
      while ((m = re.exec(this._html))) out.push(makeEl('opt' + m[1], { 'data-i': m[1] }));
      return out;
    }
  };
}
let app = makeApp();
global.app = app;
global.$ = (id) => {
  const qid = (id.charAt && id.charAt(0) === '#') ? id : '#' + id;
  const el = global.app.querySelector(qid);
  if (el) return el;
  if (!appCache[qid]) appCache[qid] = makeEl(qid);
  return appCache[qid];
};
global.stuQuit = () => {};
global.stuMarkKnown = () => {};
global.stuSpellSubmit = extract('stuSpellSubmit', 'stuPick');
global.stuPick = stuPick;
global.renderStuQuestion = renderStuQuestion;
global.shuffleStuOptions = shuffleStuOptions;
global.esc = esc;
global.openWordDetail = openWordDetail;

function freshStu(n) {
  const queue = [];
  for (let i = 1; i <= n; i++) queue.push({
    word: 'word' + i, meaning: 'm' + i, lang: 'en',
    options: ['错A', '错B', 'm' + i, '错D'], correctIndex: 2, isNew: true
  });
  return {
    view: 'session', inputMode: 'choice', lastSpeak: null,
    sess: { queue, idx: 0, marks: [], right: 0, wrong: 0, lang: 'en', autoSpeak: true, mode: 'unit', label: '测试', startedAt: Date.now(), wrongWords: [] }
  };
}

/* ==== 场景：答完新词弹上一词卡片，下一题自动发音应被挂起，关弹窗后补播当前题 ==== */
console.log('== 发音与详解卡片对齐 ==');
clearTimers();
Object.keys(appCache).forEach(k => delete appCache[k]);
detailCalls.length = 0; speakCalls.length = 0;
global.wdActive = null; global.stuPendingSpeak = null; global.stu = freshStu(4);
renderStuQuestion();              // 渲染 word1，调度 speak(word1) @350
flush(350);                       // 念出 word1
ok(speakCalls.length === 1 && speakCalls[0].w === 'word1', '第一题渲染后自动发音念 word1');

// 模拟「答完新词 → 自动弹上一词（word1）详解卡片」
global.autoDetailOnce('word1', 'en', 'm1'); // 真实 openWordDetail，wdActive 置位
ok(global.wdActive !== null, '答完新词后详解弹窗已打开（wdActive 置位）');

// 推进到下一题 word2（真实 renderStuQuestion），其自动发音定时器 @350 触发
global.stu.sess.idx = 1;
global.stu.lastSpeak = 'word1';   // 模拟 word1 已念过，避免重复调度
renderStuQuestion();
flush(350);                       // 下一题自动发音定时器触发
ok(global.wdActive !== null, '讲解弹窗仍开着（用户尚未关闭）');
// 关键断言：弹窗开着时，不应误念 word2，而应挂起
const spokeWord2 = speakCalls.some(c => c.w === 'word2');
ok(!spokeWord2, '弹窗开着时绝不误播下一题 word2（修复核心）');
ok(global.stuPendingSpeak && global.stuPendingSpeak.word === 'word2', '下一题发音已挂起（stuPendingSpeak=word2），待关弹窗补播');

// 用户关闭详解弹窗
global.wdActive.close();          // close() 调度 180ms 后移除并补播
flush(180);
ok(global.wdActive === null, '弹窗已关闭');
const last = speakCalls[speakCalls.length - 1];
ok(last && last.w === 'word2', '关弹窗后补播当前题 word2（发音与卡片对齐）');

/* ==== 无弹窗时：下一题自动发音照常立即念（不回归） ==== */
console.log('== 无弹窗时自动发音照常 ==');
clearTimers();
Object.keys(appCache).forEach(k => delete appCache[k]);
speakCalls.length = 0; detailCalls.length = 0;
global.wdActive = null; global.stuPendingSpeak = null; global.stu = freshStu(3);
renderStuQuestion();
flush(350);
ok(speakCalls.length === 1 && speakCalls[0].w === 'word1', '无弹窗时第一题照常自动发音 word1');

console.log('========================================');
console.log('  发音对齐修复: 通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
