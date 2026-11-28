// Run from app/: node scripts/check-xray-groups.mjs
// The groups of the relationship map (src/xrayCast.ts groups()): families by
// family name, people tied to an organisation, clusters named after a place,
// the same groups every time, never a group of one.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import ts from 'typescript';

const load = async (file) => {
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
  return import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));
};
const { castOf, groups, nameParts } = await load('src/xrayCast.ts');
const { links } = await load('src/xrayIndex.ts');

// An entity appearing in the given chunks (one mention per chunk, chunk c at fraction c/100).
const ent = (key, type, chunks, extra = {}) => ({
  key, name: key, type, forms: [key],
  mentions: chunks.map((c, i) => [Math.floor(c / 10), i * 7, key.length, c, c / 100]),
  ...extra,
});
const range = (a, b, step = 1) => Array.from({ length: Math.floor((b - a) / step) + 1 }, (_, i) => a + i * step);

assert.deepEqual(nameParts('Đinh Huy (bố tôi)'), ['Đinh', 'Huy']);

// A Western book: the Vances, two people at Lumen, two at a school in Palo Alto, one alone.
const book = [
  ent('Mira Vance', 'person', range(0, 90)),
  ent('Daniel Vance', 'person', range(0, 40, 4)),
  ent('Ruth Vance', 'person', range(2, 42, 4)),
  ent('Owen Vance', 'person', range(1, 41, 5)),
  ent('Ian Price', 'person', range(30, 60, 2)),
  ent('Erin Cole', 'person', range(31, 61, 2)),
  ent('Lumen', 'org', range(30, 62)),
  ent('Hana Ito', 'person', range(70, 80)),
  ent('Ken Mori', 'person', range(70, 80)),
  ent('Palo Alto', 'place', range(70, 80)),
  ent('Leo', 'person', [95, 96, 97, 98, 99, 99.5]),
];
const ls = links(book, 1);
const cast = castOf(book, ls, 1);
const run = () => groups(book, ls, cast, 1, { center: 'Mira Vance' });
const gs = run();
const find = (key) => gs.find((g) => g.members.includes(key));
const fam = find('Daniel Vance');
assert.equal(fam.kind, 'family');
assert.equal(fam.label, 'Vance');
assert.deepEqual([...fam.members].sort(), ['Daniel Vance', 'Mira Vance', 'Owen Vance', 'Ruth Vance']);
assert.equal(find('Ian Price').kind, 'org');
assert.equal(find('Ian Price').label, 'Lumen');
assert.equal(find('Erin Cole').id, find('Ian Price').id);
assert.equal(find('Hana Ito').kind, 'place');
assert.equal(find('Hana Ito').label, 'Palo Alto');
assert.equal(find('Ken Mori').id, find('Hana Ito').id);
for (const g of gs) if (g.kind !== 'others') assert.ok(g.members.length >= 2, `no group of one: ${g.id}`);
assert.deepEqual(run(), gs, 'the same groups every time');
assert.equal(gs[gs.length - 1].kind === 'others' || !gs.some((g) => g.kind === 'others'), true, '"others" comes last');
// Groups come by how much their people appear with the center.
const tie = (g) => g.members.reduce((n, k) => n + (ls.find((l) => l.key === [k, 'Mira Vance'].sort().join(''))?.chunks.length ?? 0), 0);
const real = gs.filter((g) => g.kind !== 'others').map(tie);
assert.deepEqual(real, [...real].sort((a, b) => b - a));

// A Vietnamese book: the family name comes first ("Đinh Huy", "Đinh Lượng").
const vn = [
  ent('Đinh Huy', 'person', range(0, 40)),
  ent('Đinh Lượng', 'person', range(0, 40, 3)),
  ent('Đinh Mai', 'person', range(1, 40, 3)),
  ent('Lê Văn Huy', 'person', range(50, 70)),
  ent('Trần Văn Lượng', 'person', range(50, 70)),
];
const vls = links(vn, 1);
const vg = groups(vn, vls, castOf(vn, vls, 1), 1, { center: 'Đinh Huy' });
const dinh = vg.find((g) => g.members.includes('Đinh Lượng'));
assert.equal(dinh.kind, 'family');
assert.equal(dinh.label, 'Đinh');
assert.equal(dinh.members.length, 3);
assert.ok(!vg.some((g) => g.kind === 'family' && g.members.includes('Lê Văn Huy')), '"Văn" is a middle name, not a family');

// The narrator and the kin they name; the AI's groups; the reader's moves win.
const story = [
  ent('Tôi (người kể)', 'person', range(0, 60), { narrator: true }),
  ent('Bố tôi', 'person', range(0, 30, 3), { kin: 'bố' }),
  ent('Mẹ tôi', 'person', range(1, 31, 3), { kin: 'mẹ' }),
  ent('Tuấn', 'person', range(20, 50, 2)),
  ent('Lan', 'person', range(21, 51, 2)),
];
const sls = links(story, 1);
const scast = castOf(story, sls, 1);
let sg = groups(story, sls, scast, 1, { center: 'Tôi (người kể)' });
const home = sg.find((g) => g.members.includes('Bố tôi'));
assert.equal(home.kind, 'narrator');
assert.ok(home.members.includes('Mẹ tôi') && home.members.includes('Tôi (người kể)'));
sg = groups(story, sls, scast, 1, { center: 'Tôi (người kể)', ai: new Map([['Tuấn', 'Đội bóng'], ['Lan', 'đội bóng']]) });
const team = sg.find((g) => g.members.includes('Tuấn'));
assert.equal(team.kind, 'ai');
assert.ok(team.members.includes('Lan'), 'AI group names match without case');
sg = groups(story, sls, scast, 1, { center: 'Tôi (người kể)', assign: { Lan: 'user:Lớp 12A' } });
const mine = sg.find((g) => g.members.includes('Lan'));
assert.equal(mine.kind, 'user');
assert.equal(mine.label, 'Lớp 12A');

// At most `max` groups: the rest go to "others".
const many = [];
const FAMS = ['Kim', 'Lee', 'Park', 'Choi', 'Jung', 'Kang', 'Cho', 'Yoon', 'Jang'];
for (let i = 0; i < 9; i++) {
  many.push(ent(`Anna ${FAMS[i]}`, 'person', range(i, i + 80, 10)));
  many.push(ent(`Bob ${FAMS[i]}`, 'person', range(i, i + 80, 10)));
}
const mls = links(many, 1);
const mg = groups(many, mls, castOf(many, mls, 1), 1, { max: 6 });
assert.equal(mg.filter((g) => g.kind !== 'others').length, 6);
assert.equal(mg[mg.length - 1].kind, 'others');
assert.equal(mg[mg.length - 1].members.length, 6);

console.log('xray groups: ok');
