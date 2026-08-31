'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// Extract the functions we need (same trick as def-dedup-test.js)
const names = ['cleanText', 'shortenDef', 'normDef', 'primarySeg', 'isDupDef', 'parseYoudaoSuggestEn'];
let code = '';
for (const n of names) {
  const re = new RegExp('function\\s+' + n + '\\s*\\([^)]*\\)\\s*\\{');
  const m = src.match(re);
  if (!m) throw new Error('not found: ' + n);
  let start = m.index;
  let depth = 0, i = start;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  code += src.slice(start, i) + '\n';
}

const ctx = { console };
vm.createContext(ctx);
vm.runInContext(code, ctx);

const sample = {
  result: { msg: 'success', code: 200 },
  data: {
    entries: [
      {
        explain: 'n. 声音，声响；听力范围，听距；乐音；（音乐演出、电影等的）音响录制和播出，音响制作；无线电广播；海峡，海湾；意义，印象；喧闹',
        entry: 'sound'
      }
    ],
    query: 'sound',
    language: 'en',
    type: 'dict'
  }
};

const out = ctx.parseYoudaoSuggestEn(sample, 'sound');
console.log('parsed senses:', JSON.stringify(out.senses, null, 2));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? ' -> ' + extra : '')); }
}

ok('至少解析出 2 条义项', out.senses.length >= 2, '实际 ' + out.senses.length);
ok('包含名词「声音/声响」', out.senses.some((s) => /n\.?/.test(s.pos) && /声音|声响/.test(s.def)));
ok('继承词性：无词性前缀的后续义项段也带 n.', out.senses.some((s) => /听距|乐音|听力范围/.test(s.def) && /n\.?/.test(s.pos)));
ok('不保留纯英文/无中文段', !out.senses.some((s) => !/[\u4e00-\u9fff]/.test(s.def)));

process.exit(fail ? 1 : 0);
