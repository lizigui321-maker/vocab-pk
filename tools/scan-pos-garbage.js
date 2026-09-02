const fs = require('fs');
const POS_BASE = 'n|v|adj|adv|prep|conj|pron|num|int|art|aux|vt|vi|abbr';
const POS_RE = new RegExp('^(' + POS_BASE + ')\\.?(\\s*&\\s*(' + POS_BASE + ')\\.?)*[\\s]+', 'i');
const POS_ONLY = new RegExp('^\\s*(' + POS_BASE + ')\\.?(\\s*&\\s*(' + POS_BASE + ')\\.?)*\\s*$', 'i');
function stripPos(t) {
  let s = t;
  while (true) {
    const mm = s.match(POS_RE);
    if (!mm) break;
    const rest = s.slice(mm[0].length).trim();
    if (!rest) break;
    s = rest;
  }
  return s;
}
function splitMeaning(raw) {
  const segs = String(raw).split(/\s*\/\s*/).map((s) => s.trim()).filter(Boolean);
  const cleanSegs = [];
  for (const s of segs) {
    const t = stripPos(s);
    if (!t || POS_ONLY.test(t)) continue;
    cleanSegs.push(t);
  }
  let clean = cleanSegs.join(' / ');
  if (!clean) {
    clean = String(raw).replace(new RegExp(POS_RE.source, 'gi'), '')
      .split(' / ').map((x) => x.trim()).filter((x) => x && !POS_ONLY.test(x)).join(' / ');
  }
  return { pos: (segs[0] || '').match(POS_RE) ? segs[0].match(POS_RE)[1].toLowerCase() : '', clean: clean || String(raw) };
}
function isValidMeaning(m) {
  if (!m || typeof m !== 'string') return false;
  let s = String(m).trim();
  if (!s) return false;
  let prev;
  do { prev = s; s = stripPos(s); } while (s !== prev);
  if (!s) return false;
  if (POS_ONLY.test(s)) return false;
  return true;
}
const books = JSON.parse(fs.readFileSync('public/data/books.json', 'utf8'));
let total = 0, garbage = [];
for (const b of books) {
  for (const [w, def] of b.words) {
    total++;
    const { clean } = splitMeaning(def);
    if (!isValidMeaning(clean) || !clean.trim()) garbage.push({ book: b.id, word: w, def, clean });
  }
}
console.log('总词条数:', total);
console.log('脏条目(纯词性/空)数:', garbage.length);
const byBook = {};
for (const g of garbage) byBook[g.book] = (byBook[g.book] || 0) + 1;
console.log('按词书:', JSON.stringify(byBook));
console.log('--- 样例(前60) ---');
garbage.slice(0, 60).forEach((g) => console.log(g.book + ' | ' + JSON.stringify(g.word) + ' | ' + JSON.stringify(g.def)));
