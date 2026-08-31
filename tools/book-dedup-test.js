/* 词书释义去重 / 组合词性前缀验证（端到端）
 * 启动一个干净 STORE_DIR 的服务，登录后查若干含组合词性(vi&n / vt&vi&n / n & adj)的词，
 * 断言：① 释义 def 不再残留 "vi&n"/"vt&vi" 之类的词性前缀；
 *      ② 同一词在不同词书里的近义义项被去重（如 default 的「不履行义务，拖欠」与「拖欠，违约；不出庭」只留其一）；
 *      ③ 任两个保留义项的字符 Jaccard 不高于 0.4（不是近义重复）。
 * 用法：node tools/book-dedup-test.js  （会自行拉起服务，结束后关闭）
 */
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 3931;
const BASE = 'http://localhost:' + PORT;
const STORE = fs.mkdtempSync(path.join(os.tmpdir(), 'vpk-dedup-'));
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

function hasPosPrefix(def) {
  return /(^|\s)(vi&n|vt&vi|vt&vi&n|n & adj|prep&adv|n&adj|vt&aux)\b/.test(def) || /^[a-z]{1,3}&/.test(def);
}
function jaccard(a, b) {
  const sa = new Set(a), sb = new Set(b);
  let inter = 0; for (const c of sa) if (sb.has(c)) inter++;
  const u = sa.size + sb.size - inter;
  return u ? inter / u : 0;
}
function norm(s) { return String(s).replace(/[\s，。、；：""''（）【】()\-—\/·《》]/g, ''); }

async function main() {
  console.log('启动服务 (PORT=' + PORT + ', STORE=' + STORE + ') ...');
  const srv = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: Object.assign({}, process.env, { PORT: String(PORT), STORE_DIR: STORE }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stderr.on('data', (d) => { const t = d.toString(); if (/Error|error/.test(t)) process.stderr.write('[srv] ' + t); });

  // 等待就绪
  let ready = false;
  for (let i = 0; i < 50; i++) {
    try { const r = await req('GET', '/api/books'); if (r.status === 200) { ready = true; break; } } catch (e) {}
    await sleep(200);
  }
  if (!ready) { console.error('服务未就绪'); srv.kill(); process.exit(2); }

  // 注册登录
  const U = 'dt' + Date.now().toString(36).slice(-8);
  const reg = await req('POST', '/api/register', { username: U, password: 'pw123456', name: 'Dedup' });
  const token = reg.json.token;
  if (!token) { console.error('登录失败'); srv.kill(); process.exit(2); }

  const words = ['default', 'appeal', 'attack', 'beat', 'bet', 'blend', 'cease', 'dare', 'debate', 'throughout', 'Muslim', 'maximum'];
  let badPrefix = 0, dupPairs = 0, nearDupKeep = 0;
  for (const w of words) {
    const r = await req('GET', '/api/word?w=' + encodeURIComponent(w) + '&lang=en', null, token);
    const d = r.json;
    const senses = (d && d.senses) || [];
    for (const s of senses) {
      if (hasPosPrefix(s.def)) { badPrefix++; console.log('    残留前缀: ' + w + ' -> ' + s.pos + ' | ' + s.def); }
    }
    // 两两检查 Jaccard
    for (let i = 0; i < senses.length; i++) {
      for (let j = i + 1; j < senses.length; j++) {
        const jc = jaccard(norm(senses[i].def), norm(senses[j].def));
        if (jc > 0.4) { dupPairs++; nearDupKeep++; console.log('    近义重复: ' + w + ' -> ' + senses[i].def + '  ||  ' + senses[j].def + '  (J=' + jc.toFixed(2) + ')'); }
      }
    }
  }

  console.log('\n断言：');
  ok('组合词性前缀已从 def 中剥离（无 "vi&n"/"vt&vi" 残留）', badPrefix === 0, '残留 ' + badPrefix + ' 条');
  ok('保留义项之间无近义重复 (Jaccard>0.4)', dupPairs === 0, '发现 ' + dupPairs + ' 对');
  const defR = await req('GET', '/api/word?w=default&lang=en', null, token);
  const defSenses = (defR.json && defR.json.senses) || [];
  const defCount = defSenses.length;
  ok('default 不再出现两条近义（cet6 与 ielts 合并为一条）', defCount <= 1, '实际 ' + defCount + ' 条: ' + JSON.stringify(defSenses.map((s) => s.def)));

  srv.kill();
  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
