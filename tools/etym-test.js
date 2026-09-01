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
  'const DICT_VER = 5;',
  extractFn('cleanText'),
  extractFn('normDef'),
  extractFn('isDupDef'),
  extractFn('parseDictApi'),
  extractFn('buildDetail'),
  extractFn('mergeBookOnline'),
  'return { parseDictApi, buildDetail, mergeBookOnline };',
].join('\n');
const { parseDictApi, buildDetail, mergeBookOnline } = new Function(code)();

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
