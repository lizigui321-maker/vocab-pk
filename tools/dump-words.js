'use strict';
const fs = require('fs');
const path = require('path');
const BOOKS_FILE = path.join(__dirname, '..', 'public', 'data', 'books.json');
const books = JSON.parse(fs.readFileSync(BOOKS_FILE, 'utf8'));
const want = process.argv.slice(2).map((s) => s.toLowerCase());
for (const w of want) {
  console.log('\n===== ' + w + ' =====');
  for (const b of books) {
    const lang = (b && b.lang === 'es') ? 'es' : 'en';
    if (lang !== 'en') continue;
    const it = (b.words || []).find((x) => Array.isArray(x) && String(x[0]).toLowerCase() === w);
    if (it) console.log('  [' + b.id + ' | ' + b.name + ']  ' + JSON.stringify(it[1]));
  }
}
