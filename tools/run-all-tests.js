/*
 * 全量测试跑批器：一次性跑完 test.js + tools/ 下所有 *-test.js，
 * 汇总每个文件的「通过/失败」计数与退出码，并给出总览。
 *
 * 用法：
 *   node tools/run-all-tests.js                 # 默认打 http://localhost:3000
 *   BASE_URL=http://localhost:3456 node tools/run-all-tests.js
 *   SKIP_NET=1 node tools/run-all-tests.js      # 跳过需要联网的文件
 *
 * 判定规则（不依赖各测试文件的输出格式，尽量宽容）：
 *   1) 退出码 0 → 通过
 *   2) 退出码非 0 → 失败
 *   3) 输出里出现 "❌" / "not ok" / "FAIL" / "失败" → 即使退出码 0 也记为失败
 *   4) 解析 "N/M" 或 "通过 N / 失败 M" 之类数字作为计数展示
 */
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NODE = process.execPath;
const BASE = process.env.BASE_URL || 'http://localhost:3456';
const SKIP_NET = process.env.SKIP_NET === '1';
const ONLY = process.argv[2] || '';

/* 需要真实外网（有道 / dictionaryapi.dev）的用例：沙箱/离线环境可跳过 */
const NET_FILES = new Set([
  'word-detail-test.js',
  'ipa-study-test.js',
  'youdao-suggest-en-test.js',
]);

const files = [];
files.push({ rel: 'test.js', abs: path.join(ROOT, 'test.js'), env: { TEST_BASE: BASE } });
for (const f of fs.readdirSync(__dirname).sort()) {
  if (!/-test\.js$/.test(f)) continue;
  files.push({ rel: 'tools/' + f, abs: path.join(__dirname, f), env: { BASE_URL: BASE, TEST_BASE: BASE } });
}

function counts(out) {
  let pass = null, fail = null;
  // 优先认「通过 N ... 失败 M」这类中文汇总（最常见的输出形态）
  let m = out.match(/通过\s*[::]?\s*(\d+)[^\d]{0,8}失败\s*[::]?\s*(\d+)/);
  if (!m) m = out.match(/(\d+)\s*通过[^\d]{0,6}(\d+)\s*失败/);
  if (m) { pass = Number(m[1]); fail = Number(m[2]); return { pass, fail }; }
  const ok = (out.match(/✅|✓|√/g) || []).length;
  const no = (out.match(/❌|✗|×/g) || []).length;
  if (ok || no) { pass = ok; fail = no; return { pass, fail }; }
  const mm = out.match(/(\d+)\s*\/\s*(\d+)/g);
  if (mm && mm.length) {
    const last = mm[mm.length - 1].match(/(\d+)\s*\/\s*(\d+)/);
    pass = Number(last[1]); fail = Number(last[2]);
  }
  return { pass, fail };
}
/* 是否算「跑挂了」。注意别把「失败 0 项」这种正常汇总误判为失败 */
function looksBroken(out, status) {
  if (status !== 0) return true;
  if (/❌|✗|not ok|\bFAIL\b/.test(out)) return true;
  if (/失败\s*[::]?\s*[1-9]/.test(out)) return true;   // 「失败 0 项」不算
  if (/\b0\s*\/\s*[1-9]/.test(out)) return true;
  return false;
}

const results = [];
for (const f of files) {
  if (ONLY && f.rel.indexOf(ONLY) < 0) continue;
  if (SKIP_NET && NET_FILES.has(path.basename(f.abs))) { results.push({ rel: f.rel, skipped: true }); continue; }
  const r = spawnSync(NODE, [f.abs], {
    cwd: ROOT,
    env: Object.assign({}, process.env, f.env),
    encoding: 'utf8',
    timeout: 180000,
  });
  const out = String(r.stdout || '') + String(r.stderr || '');
  const c = counts(out);
  const okRun = !looksBroken(out, r.status);
  results.push({ rel: f.rel, ok: okRun, status: r.status, pass: c.pass, fail: c.fail, out });
}

let passTotal = 0, failTotal = 0, okN = 0, badN = 0, skipN = 0;
console.log('\n================ 全量测试总览 (BASE=' + BASE + ') ================');
for (const r of results) {
  if (r.skipped) { skipN++; console.log('  ⏭  ' + r.rel + '  (SKIP_NET，已跳过)'); continue; }
  const p = r.pass === null ? '?' : r.pass;
  const q = r.fail === null ? '?' : r.fail;
  if (r.ok) { okN++; passTotal += (r.pass || 0); console.log('  ✅ ' + r.rel.padEnd(38) + ' 通过 ' + p + ' / 失败 ' + q); }
  else { badN++; failTotal += (r.fail || 1); console.log('  ❌ ' + r.rel.padEnd(38) + ' 通过 ' + p + ' / 失败 ' + q + '  (exit=' + r.status + ')'); }
}
console.log('------------------------------------------------------------------');
console.log('  文件：' + okN + ' 通过 / ' + badN + ' 失败 / ' + skipN + ' 跳过   断言：通过 ' + passTotal + ' · 失败 ' + failTotal);
console.log('==================================================================\n');

if (process.env.SHOW_FAIL === '1') {
  for (const r of results) {
    if (r.skipped || r.ok) continue;
    console.log('\n########## ' + r.rel + ' ##########');
    console.log(String(r.out || '').split('\n').slice(-40).join('\n'));
  }
}
process.exit(badN ? 1 : 0);
