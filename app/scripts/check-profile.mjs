// Run from app/: node scripts/check-profile.mjs
import fs from 'node:fs';
import assert from 'node:assert/strict';
import ts from 'typescript';

const source = fs.readFileSync('src/stats/profile.ts', 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const { profileSentence, profileText, profileFacts } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));

const genreName = (id) => ({ literary: 'Văn học', scifi: 'Khoa học viễn tưởng' })[id];
const en = (id) => ({ literary: 'Literary fiction', scifi: 'Science fiction' })[id];
const persona = (over = {}) => ({
  night_share: 0, early_share: 0, top_genre: null, trend_pct: null, avg_min_per_reading_day: 0, fast_finishes: 0, ...over,
});
const say = (p, lang = 'vi', kind = 'year', names = genreName) => profileText(profileSentence(p, lang, { kind, genreName: names }));
const em = (p, lang = 'vi', kind = 'year') => profileSentence(p, lang, { kind, genreName }).filter((x) => x.em).map((x) => x.text);

// Nothing read: no sentence at all.
assert.deepEqual(profileSentence(persona(), 'vi', { kind: 'year', genreName }), []);

// Night owl with a favourite genre, and a trend as the second sentence.
let p = persona({ night_share: 0.62, top_genre: 'literary', trend_pct: 18.4, avg_min_per_reading_day: 25 });
assert.equal(say(p), 'Bạn là cú đêm mê văn học: 62% thời gian đọc rơi vào khoảng 0–4 giờ sáng. So với năm trước, bạn đọc nhiều hơn 18%.');
assert.deepEqual(em(p), ['cú đêm', '18%']);
assert.equal(say(p, 'en', 'year', en), 'You are a night owl who loves literary fiction: 62% of your reading falls between midnight and 4 AM. Compared with last year, you read 18% more.');

// Night beats early; exactly half counts; below half is neither.
assert.match(say(persona({ night_share: 0.5, early_share: 0.5 })), /^Bạn là cú đêm: 50%/);
assert.match(say(persona({ early_share: 0.5 })), /^Bạn là chim sớm: 50% thời gian đọc rơi vào khoảng 4–6 giờ sáng\./);
assert.doesNotMatch(say(persona({ night_share: 0.49, avg_min_per_reading_day: 20 })), /cú đêm/);

// Without night or early reading the favourite genre leads, then the average.
p = persona({ top_genre: 'scifi', avg_min_per_reading_day: 24.6 });
assert.equal(say(p), 'Bạn đọc nhiều nhất thể loại khoa học viễn tưởng. Mỗi ngày đọc, bạn dành trung bình 25 phút.');
assert.equal(say(p, 'en', 'year', en), 'You read science fiction more than anything else. On the days you read, you spend 25 minutes on average.');

// Only the average: said once, as the first sentence.
assert.equal(say(persona({ avg_min_per_reading_day: 0.2 })), 'Mỗi ngày đọc, bạn dành trung bình 1 phút.');

// A genre id the names do not know (names not loaded yet) is left out, not printed raw.
assert.equal(say(persona({ top_genre: 'mystery', avg_min_per_reading_day: 10 })), 'Mỗi ngày đọc, bạn dành trung bình 10 phút.');
assert.equal(profileText(profileSentence(persona({ top_genre: 'literary', avg_min_per_reading_day: 10 }), 'vi', { kind: 'year' })), 'Mỗi ngày đọc, bạn dành trung bình 10 phút.');

// Trend: small changes are skipped, a fall reads "ít hơn", the kind picks the word, "all" has none.
p = persona({ top_genre: 'literary', trend_pct: 4.9, fast_finishes: 2 });
assert.equal(say(p), 'Bạn đọc nhiều nhất thể loại văn học. 2 cuốn bạn đọc xong chỉ trong vòng một tuần kể từ lúc bắt đầu.');
p = persona({ top_genre: 'literary', trend_pct: -30 });
assert.match(say(p, 'vi', 'month'), /So với tháng trước, bạn đọc ít hơn 30%\.$/);
assert.match(say(p, 'vi', 'week'), /So với tuần trước/);
assert.match(say(p, 'en', 'week', en), /Compared with last week, you read 30% less\.$/);
assert.doesNotMatch(say(p, 'vi', 'all'), /So với/);

// Fast finishes in English read in the singular and plural.
assert.match(say(persona({ top_genre: 'scifi', fast_finishes: 1 }), 'en', 'year', en), /1 book finished within a week of starting\.$/);
assert.match(say(persona({ top_genre: 'scifi', fast_finishes: 3 }), 'en', 'year', en), /3 books finished/);

// Never more than two sentences: lead plus one follow-up, even with every fact present.
p = persona({ night_share: 0.7, top_genre: 'literary', trend_pct: 40, avg_min_per_reading_day: 30, fast_finishes: 5 });
assert.equal(say(p).split(/(?<=[.])\s/).length, 2);

// The facts sent to the AI are numbers and one genre name, nothing else.
assert.deepEqual(profileFacts(persona({ night_share: 0.6234, top_genre: 'literary', trend_pct: 17.6, avg_min_per_reading_day: 24.6, fast_finishes: 1 }), 'month', genreName), {
  period: 'month', night_share: 0.62, early_share: 0, top_genre: 'Văn học', trend_pct: 18, avg_min_per_reading_day: 25, fast_finishes: 1,
});
assert.equal(profileFacts(persona(), 'all').top_genre, null);
assert.equal(profileFacts(persona(), 'all').trend_pct, null);

console.log('profile ok');
