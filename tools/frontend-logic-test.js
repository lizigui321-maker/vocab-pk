/*
 * 前端逻辑单测：验证 shuffleStuOptions（学习题选项位置随机化）真实代码。
 * 同一词多次出题时正确项位置不应固定，且每次洗牌后正确项仍指向 q.meaning。
 * 运行：node tools/frontend-logic-test.js
 */
'use strict';
const fs = require('fs');
const html = fs.readFileSync('public/index.html', 'utf8');
const start = html.indexOf('function shuffleStuOptions');
if (start < 0) { console.error('未找到 shuffleStuOptions'); process.exit(2); }
const end = html.indexOf('\nfunction ', start + 10);
const block = html.slice(start, end);
const shuffleStuOptions = new Function(block + '\nreturn shuffleStuOptions;')(); // 提取真实前端函数

let pass = 0, fail = 0;
function ok(c, m) { if (c) pass++; else { fail++; console.log('  ✗ ' + m); } }

const base = { word: 'outcome', meaning: '结果，后果，成果', options: ['地中海', 'n. 旧', '结果，后果，成果', '饼，糕，蛋糕'], correctIndex: 2 };
const seen = new Set();
let allCorrect = true;
for (let i = 0; i < 300; i++) {
  const q = JSON.parse(JSON.stringify(base)); // 深拷贝，模拟每次重新渲染
  shuffleStuOptions(q);
  if (q.options[q.correctIndex] !== q.meaning) allCorrect = false;
  if (typeof q.correctIndex !== 'number' || q.correctIndex < 0 || q.correctIndex > 3) allCorrect = false;
  if (new Set(q.options).size !== 4) allCorrect = false; // 无重复、无丢失
  seen.add(q.correctIndex);
}
ok(allCorrect, '每次洗牌后正确项仍指向 q.meaning 且 4 选项完整不重复');
ok(seen.size >= 3, '同一词 300 次出题，正确项位置至少出现 3 种不同位置（实际 ' + seen.size + ' 种）=> 不再固定');

console.log('\n== 前端选项随机化 ==');
console.log('通过 ' + pass + ' · 失败 ' + fail);
process.exit(fail ? 1 : 0);
