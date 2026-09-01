/*
 * 词根/词源（etym）功能单元测试（无需联网）：
 * 核心保证 —— 词根只来自 dictionaryapi.dev 的 origin 字段（真实词源），
 *   1) 有 origin → etym 被设置并透传（buildDetail / mergeBookOnline）
 *   2) 无 origin → etym 为空串，前端整段不渲染（绝不杜撰）
 *   3) 超长 origin 截断到 400 字符，避免撑爆缓存
 * 运行：node tools/etym-test.js
 */
'use strict';
const fs = require('fs');
const src = fs.readFileSync('server.js', 'utf8');

function extractFn(name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) { console.error('未在 server.js 找到 function ' + name); process.exit(2); }
  const i = src.indexOf('\nfunction ', start + 10);
  const end = i < 0 ? src.length : i;
  return src.slice(start, end);
}

const code = [
  'const DICT_VER = 6;',
  extractFn('cleanText'),
  extractFn('iText'),
  extractFn('shortenDef'),
  extractFn('normDef'),
  extractFn('primarySeg'),   // isDupDef 依赖：多义项时才走到，缺了会在真实多义词上抛 ReferenceError
  extractFn('isDupDef'),
  extractFn('parseYoudao'),
  extractFn('parseDictApi'),
  extractFn('buildDetail'),
  extractFn('mergeBookOnline'),
  'return { parseYoudao, parseDictApi, buildDetail, mergeBookOnline };',
].join('\n');
const { parseYoudao, parseDictApi, buildDetail, mergeBookOnline } = new Function(code)();

let pass = 0, fail = 0;
function ok(c, m) { if (c) pass++; else { fail++; console.log('  ✗ ' + m); } }

/* 模拟 dictionaryapi.dev 返回：含 origin（真实词源） */
const withOrigin = [{
  word: 'telephone',
  origin: "early 18th century: from tele- 'at a distance' + -phone 'sound'",
  phonetic: 'ˈtɛlɪfəʊn',
  meanings: [{ partOfSpeech: 'noun', definitions: [{ definition: 'a device for transmitting speech', example: 'he picked up the telephone' }] }],
}];
/* 模拟 dictionaryapi.dev 返回：无 origin */
const noOrigin = [{
  word: 'run',
  phonetic: 'rʌn',
  meanings: [{ partOfSpeech: 'verb', definitions: [{ definition: 'move at a speed faster than a walk' }] }],
}];
/* 超长 origin，用于验证截断 */
const longOrigin = [{ word: 'x', origin: 'a'.repeat(900), phonetic: 'x', meanings: [{ partOfSpeech: 'n', definitions: [{ definition: 'y' }] }] }];

console.log('== parseDictApi 提取词根/词源 ==');
const a = parseDictApi(withOrigin, 'telephone');
ok(a && a.etym && a.etym.indexOf("at a distance") >= 0, '有 origin 时 etym 包含词源文本: ' + (a && a.etym));
ok(a && a.senses.length > 0, '正常提取释义');

const b = parseDictApi(noOrigin, 'run');
ok(b && b.etym === '', '无 origin 时 etym 为空串（不乱编）');

const c = parseDictApi(longOrigin, 'x');
ok(c && c.etym.length <= 400, '超长 origin 截断到 ≤400 字符，实际=' + (c && c.etym.length));

/* ---- 有道 jsonapi 的 etym 块：本功能真正的词根来源（dictionaryapi.dev 的 origin 实测基本为空） ---- */
function youdaoMock(etymBlock) {
  return {
    ec: { word: [{ trs: [{ tr: [{ l: { i: 'n. 电话' } }] }] }] },
    etym: etymBlock,
  };
}
const ZH = '这个单词来源于希腊语，由tele-（远的）和-phone（声音）组成，表示“电话”。';
const EN = 'From tele- + -phone. From Ancient Greek τῆλε (têle, "afar").';

console.log('== parseYoudao 从有道 etym 块提取词根 ==');
const y1 = parseYoudao(youdaoMock({ etyms: { zh: [{ source: '有道', value: ZH }] } }), 'telephone');
ok(y1 && y1.etym && y1.etym.indexOf('tele-') >= 0, '有道中文词根被提取: ' + (y1 && y1.etym));

const y2 = parseYoudao(youdaoMock({ etyms: { en: [{ source: 'wiktionary', value: EN }] } }), 'telephone');
ok(y2 && y2.etym && y2.etym.indexOf('From tele-') >= 0, '只有英文词源时回退取英文: ' + (y2 && y2.etym));

const y3 = parseYoudao(youdaoMock({ etyms: { zh: [{ value: ZH }], en: [{ value: EN }] } }), 'telephone');
ok(y3 && y3.etym.indexOf('tele-') >= 0 && y3.etym.indexOf('From tele-') < 0, '中英文都有时优先中文');

const y4 = parseYoudao(youdaoMock(undefined), 'telephone');
ok(y4 && y4.etym === '', '有道未返回 etym 时留空（绝不杜撰）');

const y5 = parseYoudao(youdaoMock({ etyms: { zh: [{ value: 'x'.repeat(600) }] } }), 'telephone');
ok(y5 && y5.etym.length <= 300, '超长词源截断到 ≤300 字，实际=' + (y5 && y5.etym.length));

const y6 = parseYoudao(youdaoMock({ etyms: { zh: [{ value: 'a\u200eb\u200fc' }] } }), 'telephone');
ok(y6 && y6.etym === 'abc', '清除不可见的方向控制符: ' + (y6 && y6.etym));

/* 多义项真实形态：会走到 isDupDef → primarySeg（单义项 mock 走不到，曾导致漏测） */
/* 注意：两条义项必须语义真正不同（如 book 的「书 / 预订」）；若用「电话 / 打电话」这类近义，
   会被 isDupDef 正确判重合并成 1 条——那是既有的正确行为，不是词根功能的 bug。 */
const multi = {
  ec: { word: [{ trs: [{ tr: [{ l: { i: 'n. 书；书本' } }] }, { tr: [{ l: { i: 'v. 预订；预约' } }] }] }] },
  etym: { etyms: { zh: [{ value: ZH }] } },
};
const y7 = parseYoudao(multi, 'telephone');
ok(y7 && y7.etym && y7.etym.indexOf('tele-') >= 0, '多义项单词同样能提取词根（走 isDupDef/primarySeg 分支）');
ok(y7 && y7.senses.length >= 2, '多义项解析正常，senses=' + (y7 && y7.senses.length));

console.log('== buildDetail 透传 etym ==');
const det1 = buildDetail('telephone', 'en', { senses: a.senses, etym: a.etym }, 'dictapi');
ok(det1.etym && det1.etym.indexOf("at a distance") >= 0, 'buildDetail 透传真实词源');
const det2 = buildDetail('run', 'en', { senses: b.senses, etym: b.etym }, 'dictapi');
ok(det2.etym === '', 'buildDetail 对无词源返回空串（非 undefined）');

console.log('== mergeBookOnline 合并时保留在线词源 ==');
const online = { word: 'telephone', senses: [{ pos: 'n.', def: '电话' }], etym: a.etym, src: 'dictapi' };
const book = { word: 'telephone', senses: [{ pos: 'n.', def: '电话' }] };
const merged = mergeBookOnline(book, online);
ok(merged.etym && merged.etym.indexOf("at a distance") >= 0, 'mergeBookOnline 把在线词源并入最终结果');

const onlineNo = { word: 'run', senses: [{ pos: 'v.', def: '跑' }], etym: '', src: 'dictapi' };
const mergedNo = mergeBookOnline({ word: 'run', senses: [] }, onlineNo);
ok(mergedNo.etym === '', 'mergeBookOnline 无词源时保持空串');

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
