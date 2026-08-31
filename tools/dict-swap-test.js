/* 回归测试：词书释义正确性 —— 9 处「释义互换」bug 修复断言
 * 对应反馈：「类似于 native 这样的 bug 你要全检一遍」。
 * 经过离线扫描 + 有道在线核验 + 人工语言审查，确认并修复了 9 处「一个词错用了另一个词的释义」：
 *   interact   ← interact 错用「干预/干涉/触犯/妨碍」（应是互相作用）
 *   enthusiasm ← 错用「娱乐/招待/表演」（应是热情/热心/热忱）
 *   unconscious← 错用「无畏的/大胆的」（应是失去知觉/无意识）
 *   offer      ← 错用「违犯/伤害的感情」（应是提供/提出）
 *   lock       ← lock/look 拼写串台：错用「看/显得/似乎/注意」（应是锁/锁上）
 *   as         ← 错用「与…形成对照」（应是作为/当作/如同）
 *   comprise   ← 错用 compress 的「(止血用)敷布」（应是包含/包括/由…组成）
 *   stereotype ← 错用「典型的榜样/样本」（应是陈规/老套/固定模式）
 *   conversely ← 错用「倒地,逆地」(typo)（应是相反地/逆地）
 * 修复：books.json 把这 9 处释义改回正确含义；并顺带把 DICT_VER 4→5，使生产环境已缓存的旧释义在重启后被淘汰重建。
 * 本测试断言：/api/word?w=W&lang=en&wait=0 的义项里【含】正确释义且【不含】错误释义。
 * 纯离线校验，无需联网。
 * 用法：node tools/dict-swap-test.js
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 3962;
const BASE = 'http://localhost:' + PORT;
const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'vpk-swap-'));
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  -> ' + extra : '')); }
}
function req(method, p, body, token) {
  return new Promise((resolve, reject) => {
    let pp = p, b = body;
    if (token) {
      if (b && typeof b === 'object') b = Object.assign({ token }, b);
      else if (method === 'POST') b = { token };
      else pp += (pp.indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(token);
    }
    const data = b ? JSON.stringify(b) : null;
    const r = http.request(BASE + pp, {
      method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
    }, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(body) }); } catch (e) { resolve({ status: res.statusCode, json: {} }); } });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function sensesOf(j) { return ((j && j.senses) || []).map((s) => (s.def || '')); }

// 每个词：正确释义（应出现） / 错误释义（不应出现）
const CASES = [
  { w: 'interact',   must: /互相作用|相互影响/, mustNot: /干预|干涉|触犯|妨碍/ },
  { w: 'enthusiasm', must: /热情|热心|热忱/,     mustNot: /娱乐|招待|表演/ },
  { w: 'unconscious',must: /失去知觉|无意识/,    mustNot: /无畏|大胆/ },
  { w: 'offer',      must: /提供|提出/,          mustNot: /违犯|伤害/ },
  { w: 'lock',       must: /锁/,                 mustNot: /看|显得|似乎|注意/ },
  { w: 'as',         must: /作为|当作|如同/,     mustNot: /形成对照/ },
  { w: 'comprise',   must: /包含|包括|组成/,     mustNot: /敷布/ },
  { w: 'stereotype', must: /陈规|老套|固定模式/, mustNot: /典型的榜样|样本/ },
  { w: 'conversely', must: /相反地|逆地/,        mustNot: /倒地/ },
];

async function main() {
  console.log('启动服务 (PORT=' + PORT + ', STORE=' + STORE + ') ...');
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: Object.assign({}, process.env, { PORT: String(PORT), STORE_DIR: STORE }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stderr.on('data', (d) => { const t = d.toString(); if (/Error|error/.test(t)) process.stderr.write('[srv] ' + t); });

  let ready = false;
  for (let i = 0; i < 50; i++) {
    try { const r = await req('GET', '/api/books'); if (r.status === 200) { ready = true; break; } } catch (e) {}
    await sleep(200);
  }
  if (!ready) { console.error('服务未就绪'); srv.kill(); process.exit(2); }

  const U = 'swp' + Date.now().toString(36).slice(-8);
  const reg = await req('POST', '/api/register', { username: U, password: 'pw123456', name: 'SwapTest' });
  const token = reg.json.token;
  if (!token) { console.error('登录失败'); srv.kill(); process.exit(2); }

  for (const c of CASES) {
    const r = await req('GET', '/api/word?w=' + encodeURIComponent(c.w) + '&lang=en&wait=0', null, token);
    const senses = sensesOf(r.json);
    const all = senses.join(' / ');
    console.log('  ' + c.w + ' 义项: ' + JSON.stringify(senses));
    ok(c.w + ' 详情可查到', r.json && r.json.ok === true);
    ok(c.w + ' 含正确释义（无他词串台）', c.must.test(all), 'got=' + all);
    ok(c.w + ' 不含量错的释义', !c.mustNot.test(all), 'got=' + all);
  }

  srv.kill();
  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
