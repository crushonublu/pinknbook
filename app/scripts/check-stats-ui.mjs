// Run from app/: node scripts/check-stats-ui.mjs
// Checks the words of the stats, genre and wrap-up UI: every string exists in
// Vietnamese and English, every string the stats and wrap code asks for is
// defined, and the raw export errors of wrap_export.rs / MainActivity.kt are
// turned into sentences of the reader's language.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import ts from 'typescript';

const transpile = (file) => ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');

const i18nUrl = dataUrl(transpile('src/i18n.ts'));
const { STR } = await import(i18nUrl);
const exportJs = transpile('src/wrap/exportError.ts').replace(/from\s+["']\.\.\/i18n["']/, `from "${i18nUrl}"`);
const { exportError } = await import(dataUrl(exportJs));

let checks = 0;
const check = (label, fn) => {
  fn();
  checks++;
  console.log('PASS ' + label);
};

check('Vietnamese and English have the same strings, none empty', () => {
  const vi = Object.keys(STR.vi);
  const en = Object.keys(STR.en);
  assert.deepEqual(vi.filter((k) => !(k in STR.en)), [], 'missing in English');
  assert.deepEqual(en.filter((k) => !(k in STR.vi)), [], 'missing in Vietnamese');
  for (const lang of ['vi', 'en']) assert.deepEqual(vi.filter((k) => !String(STR[lang][k]).trim()), []);
});

check('placeholders agree between the two languages', () => {
  const slots = (s) => [...String(s).matchAll(/\{(\d)\}/g)].map((m) => m[1]).sort().join();
  const odd = Object.keys(STR.vi).filter((k) => slots(STR.vi[k]) !== slots(STR.en[k]));
  assert.deepEqual(odd, []);
});

check('every string the stats and wrap code reads is defined', () => {
  const files = ['src/stats', 'src/wrap']
    .flatMap((dir) => fs.readdirSync(dir).map((f) => path.join(dir, f)))
    .filter((f) => /\.tsx?$/.test(f));
  const missing = [];
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    for (const m of text.matchAll(/\bt\.([A-Za-z]\w*)/g)) if (!(m[1] in STR.vi)) missing.push(`${f}: ${m[1]}`);
  }
  assert.deepEqual(missing, []);
});

check('known export failures read as sentences in both languages, without the raw text', () => {
  const cases = [
    ['Saving to Photos needs Android 10 or newer', 'wrErrOldAndroid'],
    ['The gallery did not accept the picture', 'wrErrGalleryRefused'],
    ['The gallery gave no place to write', 'wrErrGalleryWrite'],
    ['Sharing is only available on the phone', 'wrErrNoShare'],
    ['Saving pictures is not available on this platform', 'wrErrUnsupported'],
    ['Android could not take the picture', 'wrErrAndroid'],
    ['Could not write C:\\Pictures\\x.png: access is denied. (os error 5)', 'wrErrWriteFile'],
    ['The picture could not be made.', 'wrErrPicture'],
    ['Permission denied', 'wrErrPermission'],
  ];
  for (const lang of ['vi', 'en']) {
    for (const [raw, key] of cases) {
      assert.deepEqual(exportError(lang, new Error(raw)), { text: STR[lang][key] }, raw);
      assert.deepEqual(exportError(lang, raw), { text: STR[lang][key] }, raw);
    }
  }
  const denied = new Error('Write permission denied');
  denied.name = 'NotAllowedError';
  assert.equal(exportError('en', denied).text, STR.en.wrErrPermission);
});

check('an unknown export failure gets the general sentence and keeps the raw text for small print', () => {
  for (const lang of ['vi', 'en']) {
    assert.deepEqual(exportError(lang, new Error('SecurityError-free surprise 42')), { text: STR[lang].wrExportFailed, detail: 'SecurityError-free surprise 42' });
    assert.deepEqual(exportError(lang, 'odd'), { text: STR[lang].wrExportFailed, detail: 'odd' });
  }
  assert(!/\{0\}/.test(STR.vi.wrExportFailed + STR.en.wrExportFailed));
});

console.log(`${checks} checks passed`);
