/* 释义去重单元测试
 * 直接从 server.js 抽出 normDef / primarySeg / isDupDef 的真实源码来跑，
 * 保证测的就是生产代码本身，而不是复制走样的副本。
 * 既验证「近义重复要拦掉」，也验证「不同义项不能被误删」（防止过度合并）。 */
'use strict';
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
function grab(name) {
  // 从 "function name(" 开始，按大括号配平截取整个函数
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('未找到函数 ' + name);
  let i = src.indexOf('{', start), depth = 0, end = -1;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
  }
  if (end < 0) throw new Error('函数 ' + name + ' 括号未配平');
  return src.slice(start, end);
}
const sandbox = {};
new Function(grab('normDef') + '\n' + grab('primarySeg') + '\n' + grab('isDupDef') +
  '\nthis.normDef=normDef;this.primarySeg=primarySeg;this.isDupDef=isDupDef;').call(sandbox);
const isDupDef = sandbox.isDupDef;

let pass = 0, fail = 0;
function shouldDedup(name, newDef, existing) {
  if (isDupDef(newDef, existing)) { pass++; console.log('  ✅ [应去重] ' + name); }
  else { fail++; console.log('  ❌ [应去重却没拦住] ' + name + '  new=' + JSON.stringify(newDef) + ' existing=' + JSON.stringify(existing)); }
}
function shouldKeep(name, newDef, existing) {
  if (!isDupDef(newDef, existing)) { pass++; console.log('  ✅ [应保留] ' + name); }
  else { fail++; console.log('  ❌ [被误删] ' + name + '  new=' + JSON.stringify(newDef) + ' existing=' + JSON.stringify(existing)); }
}

console.log('=== A. 应当判定为重复（用户抱怨的「一堆近义项」）===');
shouldDedup('字面几乎相同：条，条款；一条 vs 条， 条款', '条， 条款', ['条，条款；一条']);
shouldDedup('高度重叠：条款，项目，一条(新闻) vs 条款，项目；一则；一件商品（或物品）', '条款，项目，一条(新闻)', ['条款，项目；一则；一件商品（或物品）']);
shouldDedup('主义项相同但措辞不同：去,离开,进行 vs 去；走；变为', '去,离开,进行', ['去；走；变为']);
shouldDedup('极短义项被完整义项包含：做 vs 使；做，制造', '做', ['使；做，制造']);
shouldDedup('完全重复：项目 vs 项目', '项目', ['项目']);
shouldDedup('标点/空格差异：条，条款 vs 条, 条款', '条， 条款', ['条，条款']);
shouldDedup('主义项出现在对方中：轻的，少量的 vs 明亮的；轻的；不重要的', '轻的，少量的', ['明亮的；轻的；不重要的']);
shouldDedup('连续子串：项目，条款 vs 条款，项目；一则', '项目，条款', ['条款，项目；一则；一件商品']);

console.log('\n=== B. 应当保留（不能过度合并，丢了真义项）===');
shouldKeep('名词 vs 形容词：光；光线；灯 vs 明亮的；轻的', '光；光线；灯；打火机；领悟；浅色；天窗', ['明亮的；轻的；不重要的']);
shouldKeep('动词 vs 名词：制造，做 vs 品牌，型号', '（机器、设备等的）品牌，型号；结构，构造', ['制造；制定，拟定；使变得，使处于']);
shouldKeep('完全不同义项：获得，得到 vs 变得，成为', '获得,得到', ['变得，成为；到达']);
shouldKeep('跑 vs 经营', '经营', ['跑，奔跑']);
shouldKeep('看 vs 说', '说，讲', ['看，观看']);
shouldKeep('去 vs 去除（主义项单字不应误伤）', '去除，除掉', ['去；走；变为']);
shouldKeep('去年 vs 去', '去年', ['去；走；变为']);
shouldKeep('点钟 vs 点，指向', '点钟，时刻', ['点，指向；要点']);
shouldKeep('空列表（第一条永远保留）', '项目，条款', []);
shouldKeep('不同词性的同形：预订 vs 保留', '预订，预约', ['保留，保持']);

console.log('\n结果: ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
