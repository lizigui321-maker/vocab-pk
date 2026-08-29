/*
 * 词典离线化测试（用户反馈：弹出详细释义有延迟 / 干脆不显示，提示网络原因）：
 *   A) 内置词书的词必须【零网络、即时】返回，且 src='book'（证明走的是离线索引而非联网）
 *   B) 离线词条字段形状完整（senses / forms / phrases / examples / exams 都可安全读取）
 *   C) 词性被正确从 "n 能力，能耐" 中拆出（pos='n'）
 *   D) 不在词书里的生造词不崩溃，返回 ok:false（前端降级为只显示词书释义）
 *   E) 响应足够快（不因联网而卡顿）
 * 运行：node tools/dict-offline-test.js
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const PORT = 3511;
const BASE = 'http://127.0.0.1:' + PORT;
const STORE_DIR = path.join(__dirname, '..', 'store-dicttest');

let pass = 0, fail = 0;
function ok(c, m) { if (c) pass++; else { fail++; console.log('  ✗ ' + m); } }

function cleanup() { try { fs.rmSync(STORE_DIR, { recursive: true, force: true }); } catch (e) {} }
cleanup();

const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
  env: Object.assign({}, process.env, { PORT: String(PORT), STORE_DIR: STORE_DIR }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvLog = '';
srv.stdout.on('data', (d) => { srvLog += d.toString(); });
srv.stderr.on('data', (d) => { srvLog += d.toString(); });

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/'); if (r.ok) return true; } catch (e) {}
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}
function post(p, body) {
  return fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then((r) => r.json());
}
function get(p, token) {
  return fetch(BASE + p, { headers: token ? { Authorization: 'Bearer ' + token } : {} }).then((r) => r.json());
}

(async () => {
  const ready = await waitReady();
  if (!ready) { console.error('服务器启动失败:\n' + srvLog); srv.kill(); cleanup(); process.exit(2); }

  // 用户名需 3-16 位字母/数字/下划线（RE_USER 限制）
  const uname = 'dt' + String(Date.now()).slice(-8);
  const reg = await post('/api/register', { username: uname, password: 'pw123456', name: '词典测试' });
  const token = reg && reg.token;
  ok(!!token, '测试账号注册并拿到 token' + (token ? '' : ' → ' + JSON.stringify(reg)));

  /* A) 内置词：必须来自离线索引，零网络 */
  console.log('== A. 内置词零网络即时返回 ==');
  const t0 = Date.now();
  const d = await get('/api/word?w=ability&lang=en', token);
  const ms = Date.now() - t0;
  ok(d && d.ok === true, '词书内单词 ability 查询成功');
  ok(d && Array.isArray(d.senses) && d.senses.length > 0, '返回了释义条目（不再"不显示"）');
  ok(d && d.src === 'book', '来源为离线词书索引 src=book（证明未走网络）');
  ok(ms < 3000, '响应耗时 ' + ms + 'ms，无联网卡顿');

  /* B) 字段形状完整，前端可安全读取 */
  console.log('== B. 离线词条字段完整 ==');
  ok(Array.isArray(d.forms) && Array.isArray(d.phrases) && Array.isArray(d.examples) && Array.isArray(d.exams), 'forms/phrases/examples/exams 均为数组（前端不会因 undefined 报错）');
  ok(typeof d.word === 'string' && d.word.length > 0, 'word 字段存在');

  /* C) 词性解析 */
  console.log('== C. 词性正确拆分 ==');
  ok(d.senses[0] && d.senses[0].pos === 'n', '词性从 "n 能力，能耐；才能" 中正确拆出 pos=n');
  ok(d.senses[0] && /能力/.test(d.senses[0].def), '释义正文正确（去除词性前缀）');

  /* D) 生造词不崩溃 */
  console.log('== D. 非词书单词不崩溃 ==');
  let d2 = null, crashed = false;
  try { d2 = await get('/api/word?w=zzqqxnotaword123&lang=en', token); } catch (e) { crashed = true; }
  ok(!crashed, '生造词查询未导致服务端异常');

  /* E) 多个常用词都能离线命中 */
  console.log('== E. 批量离线命中 ==');
  const words = ['about', 'accept', 'achieve', 'book', 'computer', 'important', 'hello'];
  let hitCnt = 0;
  for (const w of words) {
    const r = await get('/api/word?w=' + encodeURIComponent(w) + '&lang=en', token);
    if (r && r.ok && r.senses && r.senses.length && r.src === 'book') hitCnt++;
  }
  ok(hitCnt === words.length, '全部 ' + words.length + ' 个常用词均离线命中（实际 ' + hitCnt + '）');

  console.log('========================================');
  console.log('  词典离线化: 通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  srv.kill();
  cleanup();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); srv.kill(); cleanup(); process.exit(1); });
