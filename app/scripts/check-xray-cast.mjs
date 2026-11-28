// Run from app/: node scripts/check-xray-cast.mjs
// The cast of a book (src/xrayCast.ts): who is main, minor or passing, and who is the author.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import ts from 'typescript';

const load = async (file) => {
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
  return import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
};
const { castOf, castOrder, isCredited, creditedPeople, nameWords, MAX_MAIN } = await load('src/xrayCast.ts');

// A person with `n` mentions spread over `secs` sections, between fractions `from` and `to`.
const person = (key, n, secs, from = 0.1, to = 0.4, extra = {}) => ({
  key, name: key, type: 'person', forms: [key],
  mentions: Array.from({ length: n }, (_, i) => {
    const f = from + ((to - from) * i) / Math.max(1, n - 1);
    return [i % secs, i * 10, key.length, i, f];
  }),
  ...extra,
});
const link = (a, b, k = 3) => ({ a, b, key: a < b ? `${a}\u0001${b}` : `${b}\u0001${a}`, chunks: Array.from({ length: k }, (_, i) => i) });

// Names: marks and case do not matter; one shared word with a different name is not a match.
assert.deepEqual(nameWords('Đinh Huy'), ['dinh', 'huy']);
const credited = creditedPeople(['John Carreyrou', 'Fyodor Dostoevsky; dịch: Phạm Mạnh Hùng']);
assert.ok(isCredited('John Carreyrou', credited));
assert.ok(!isCredited('Carreyrou', credited), 'a family name alone counts only when the book names the author in full');
assert.ok(isCredited('Carreyrou', credited, new Set([0])));
assert.ok(!isCredited('Hoài', creditedPeople(['Tô Hoài'])), 'a character sharing a given name with the author stays');
assert.ok(isCredited('carreyrou john', credited));
assert.ok(isCredited('Phạm Mạnh Hùng', credited), 'the translator is credited too');
assert.ok(!isCredited('John Smith', credited));
assert.ok(!isCredited('John', credited), 'a short first name alone is not the author');
assert.ok(!isCredited('Elizabeth Holmes', credited));

const ents = [
  person('Elizabeth', 300, 12),
  person('Sunny', 140, 9),
  person('Tyler', 60, 6),
  person('Chris', 24, 5),
  person('Noel', 9, 3),
  person('Pfizer', 12, 1), // one section, no ties: passing
  person('Waiter', 3, 2), // too few
  person('Editor', 8, 2, 0.001, 0.015), // only in the front matter
  person('John Carreyrou', 20, 4),
  person('Carreyrou', 15, 3),
];
const links = [link('Elizabeth', 'Sunny', 40), link('Elizabeth', 'Tyler', 12), link('Elizabeth', 'Chris', 9), link('Chris', 'Noel'), link('Elizabeth', 'Noel'), link('Tyler', 'Sunny')];
let cast = castOf(ents, links, 1, { credits: ['John Carreyrou'] });
const tier = (k) => cast.get(k)?.tier;
assert.equal(tier('Elizabeth'), 'main');
assert.equal(tier('Sunny'), 'main');
assert.equal(tier('Pfizer'), 'passing');
assert.equal(tier('Waiter'), 'passing');
assert.equal(tier('Editor'), 'passing');
assert.equal(cast.get('John Carreyrou').author, true);
assert.equal(cast.get('Carreyrou').author, true, 'the full name is in the book: the family name alone is the author too');
assert.ok(!castOrder(cast).includes('John Carreyrou'), 'the author is never listed');
assert.deepEqual(castOrder(cast).slice(0, 2), ['Elizabeth', 'Sunny']);
assert.ok(['main', 'minor'].includes(tier('Noel')));

// Cut at the reader's place: someone not yet met is not in the cast.
cast = castOf([...ents, person('Later', 30, 5, 0.6, 0.9)], links, 0.42);
assert.equal(cast.get('Later'), undefined);

// The narrator of a first-person book is always main, even when rarely named.
cast = castOf([person('Tôi (người kể)', 6, 3, 0.1, 0.4, { narrator: true }), ...ents], links, 1);
assert.equal(cast.get('Tôi (người kể)').tier, 'main');

// Never more than MAX_MAIN main characters.
const crowd = Array.from({ length: 20 }, (_, i) => person(`P${i}`, 100, 10));
const crowdLinks = crowd.slice(1).map((p) => link('P0', p.key));
cast = castOf(crowd, crowdLinks, 1);
assert.equal([...cast.values()].filter((c) => c.tier === 'main').length, MAX_MAIN);

// The AI's say over the rules, the reader's over both; a reader's pin shows even a credited name.
cast = castOf(ents, links, 1, {
  credits: ['John Carreyrou'],
  roles: new Map([['Tyler', 'minor'], ['Pfizer', 'main'], ['John Carreyrou', 'main']]),
  overrides: { Chris: 'main', Sunny: 'passing' },
});
assert.equal(tier('Tyler'), 'passing');
assert.equal(cast.get('Tyler').from, 'ai');
assert.equal(tier('Pfizer'), 'main');
assert.equal(cast.get('John Carreyrou').author, true, 'the AI cannot bring the author back');
assert.equal(tier('Chris'), 'main');
assert.equal(tier('Sunny'), 'passing');
assert.equal(cast.get('Sunny').from, 'user');
cast = castOf(ents, links, 1, { credits: ['John Carreyrou'], overrides: { 'John Carreyrou': 'minor' } });
assert.equal(cast.get('John Carreyrou').author, undefined);
assert.ok(castOrder(cast).includes('John Carreyrou'));

console.log('xray cast: ok');
