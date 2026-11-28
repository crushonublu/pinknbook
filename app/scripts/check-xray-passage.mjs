// Run from app/: node scripts/check-xray-passage.mjs
// The sentences around a mention (src/xrayIndex.ts sentenceSpan), for the excerpt opened in place.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import ts from 'typescript';

const src = fs.readFileSync('src/xrayIndex.ts', 'utf8');
const js = ts.transpileModule(src, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const { sentenceSpan } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));

const text = 'Một. Hai ba. Chris kể chuyện cũ! Bốn năm? Sáu bảy… Tám.';
const at = text.indexOf('Chris');
const cut = (around) => { const [s, e] = sentenceSpan(text, at, at + 5, around); return text.slice(s, e); };
assert.equal(cut(0), 'Chris kể chuyện cũ!');
assert.equal(cut(1), 'Hai ba. Chris kể chuyện cũ! Bốn năm?');
assert.equal(cut(2), 'Một. Hai ba. Chris kể chuyện cũ! Bốn năm? Sáu bảy…');
assert.equal(cut(9), text, 'never past the section');
// Closing quotes stay with their sentence; paragraphs end sentences too.
const q = '“Đi đi,” Chris nói. “Ngay!”\nĐoạn mới.';
const i = q.indexOf('Chris');
const [s, e] = sentenceSpan(q, i, i + 5, 1);
assert.equal(q.slice(s, e), '“Đi đi,” Chris nói. “Ngay!”');
// A very long sentence is cut, not taken whole.
const long = 'x'.repeat(2000) + ' Chris ' + 'y'.repeat(2000);
const j = long.indexOf('Chris');
const [ls, le] = sentenceSpan(long, j, j + 5);
assert.ok(j - ls <= 400 && le - j <= 410);
console.log('xray passage: ok');
