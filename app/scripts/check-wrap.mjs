// Run from app/: node scripts/check-wrap.mjs
// Checks the wrap-up cards' pure parts: the seeded background generator, the
// card palettes (contrast of every text colour, agreement with stats.css), the
// icon manifest and files, the sticker rules and the auto layout.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import ts from 'typescript';

/** Loads a TypeScript module of src/wrap; `deps` maps the name of a sibling module it imports to that module's exports (already loaded). */
const loaded = {};
async function load(file) {
  const source = fs.readFileSync(`src/wrap/${file}.ts`, 'utf8');
  let js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
  // A sibling import becomes an import of that sibling's data URL (siblings are loaded first).
  js = js.replace(/from\s+["']\.\/(\w+)["']/g, (m, name) => (loaded[name] ? `from "${loaded[name].url}"` : m));
  const url = 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');
  const mod = await import(url);
  loaded[file] = { url, mod };
  return mod;
}
let checks = 0;
const check = (label, fn) => {
  fn();
  checks++;
  console.log('PASS ' + label);
};

const shapes = await load('shapes');
const { THEMES, THEME_IDS } = await load('palettes');
const geometry = await load('geometry');
const rules = await load('iconRules');
const layout = await load('layout');
const { pickFact } = await load('factPick');
const { mulberry32, seedFor, hash32, composeBackground, generateBackground, buildShape, shapeTouches, SHAPE_KINDS, UNDER_TEXT_OPACITY, MIN_SHAPES, MAX_SHAPES } = shapes;

// ---- RNG and seeds ----
check('mulberry32 is deterministic and in [0,1)', () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  for (let i = 0; i < 1000; i++) {
    const v = a();
    assert.equal(v, b());
    assert(v >= 0 && v < 1);
  }
  assert.notEqual(mulberry32(1)(), mulberry32(2)());
});
check('seedFor is a stable 32-bit hash that reacts to every part', () => {
  assert.equal(seedFor('month', '2026-11-01', 0), seedFor('month', '2026-11-01', 0));
  assert.equal(seedFor('month', '2026-11-01', 0), hash32('month|2026-11-01|0'));
  const seeds = new Set([seedFor('month', '2026-11-01', 0), seedFor('week', '2026-11-01', 0), seedFor('month', '2026-12-01', 0), seedFor('month', '2026-11-01', 1)]);
  assert.equal(seeds.size, 4);
  for (const s of seeds) assert(Number.isInteger(s) && s >= 0 && s < 2 ** 32);
});

// ---- Shapes ----
check('every shape kind builds a closed, finite path inside the unit box', () => {
  for (const kind of SHAPE_KINDS) {
    for (let seed = 0; seed < 60; seed++) {
      const d = buildShape(kind, mulberry32(seed));
      assert(/^M/.test(d) && /Z$/.test(d), `${kind} ${seed}`);
      const nums = d.match(/-?\d*\.?\d+/g).map(Number);
      assert(nums.every((v) => Number.isFinite(v)), `${kind} ${seed} finite`);
      // Bezier handles may lean a little outside the box.
      assert(nums.every((v) => v > -0.5 && v < 1.5), `${kind} ${seed} box`);
    }
  }
});
check('different seeds give different shapes', () => {
  for (const kind of ['blob', 'burst', 'flower', 'seal']) assert.notEqual(buildShape(kind, mulberry32(1)), buildShape(kind, mulberry32(2)), kind);
});

// ---- Composition and SVG ----
const AVOID = [{ x: 80, y: 110, w: 620, h: 230 }, { x: 80, y: 1660, w: 700, h: 120 }];
check('3-6 shapes; one or two big blurred glows; a shape that reaches text is faint', () => {
  for (let seed = 0; seed < 400; seed++) {
    for (const id of THEME_IDS) {
      const list = composeBackground(mulberry32(seed), THEMES[id], 1080, 1920, AVOID);
      assert(list.length >= MIN_SHAPES && list.length <= MAX_SHAPES, `count ${list.length}`);
      const glows = list.filter((s) => s.blur > 0 && s.size >= 0.8 * 1080);
      assert(glows.length >= 1 && glows.length <= 2, `glows ${glows.length}`);
      for (const g of glows) assert(g.opacity <= UNDER_TEXT_OPACITY + 1e-9, 'a glow is faint');
      for (const s of list) {
        if (AVOID.some((a) => shapeTouches(s, a))) assert(s.opacity <= UNDER_TEXT_OPACITY + 1e-9, `faint under text (seed ${seed})`);
        assert(s.opacity > 0 && s.opacity <= 1);
      }
    }
  }
});
check('the same seed gives the same SVG, another seed another one', () => {
  for (const id of THEME_IDS) {
    const a = generateBackground(seedFor('month', '2026-11-01', 0), THEMES[id], 1080, 1920, AVOID);
    assert.equal(a, generateBackground(seedFor('month', '2026-11-01', 0), THEMES[id], 1080, 1920, AVOID));
    assert.notEqual(a, generateBackground(seedFor('month', '2026-11-01', 1), THEMES[id], 1080, 1920, AVOID));
  }
});
check('the SVG has the grain layer, balanced tags and no NaN', () => {
  const svg = generateBackground(seedFor('year', '2026-01-01', 3), THEMES.wine, 1080, 1350, AVOID);
  assert(svg.startsWith('<svg') && svg.endsWith('</svg>'));
  assert(svg.includes('feTurbulence type="fractalNoise"') && svg.includes('baseFrequency="0.8"') && svg.includes('numOctaves="3"') && svg.includes('stitchTiles="stitch"'));
  assert(svg.includes('<feColorMatrix'));
  assert(!/NaN|undefined|Infinity/.test(svg));
  for (const tag of ['g', 'defs']) assert.equal((svg.match(new RegExp(`<${tag}[ >]`, 'g')) || []).length, (svg.match(new RegExp(`</${tag}>`, 'g')) || []).length, tag);
  // Every url(#id) points at a defined id.
  for (const [, id] of svg.matchAll(/url\(#([^)]+)\)/g)) assert(svg.includes(`id="${id}"`), id);
});

// ---- Palettes ----
const lum = (hex) => {
  const v = parseInt(hex.slice(1), 16);
  const lin = (c) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(v >> 16) + 0.7152 * lin((v >> 8) & 255) + 0.0722 * lin(v & 255);
};
const contrast = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const blend = (fg, bg, alpha) => {
  const f = parseInt(fg.slice(1), 16);
  const g = parseInt(bg.slice(1), 16);
  const ch = (shift) => Math.round(((f >> shift) & 255) * alpha + ((g >> shift) & 255) * (1 - alpha));
  return '#' + [16, 8, 0].map((s) => ch(s).toString(16).padStart(2, '0')).join('');
};
check('all six themes exist with valid colours', () => {
  assert.deepEqual([...THEME_IDS], ['wine', 'forest', 'night', 'paper', 'sunset', 'ocean']);
  for (const id of THEME_IDS) {
    const t = THEMES[id];
    for (const k of ['bg', 'border', 'tile', 'btn', 'ink', 'sub', 'kicker', 'hi', 'dim', 'grain']) assert(/^#[0-9a-f]{6}$/.test(t[k]), `${id}.${k}`);
    assert(t.shapes.length >= 3 && t.shapes.length <= 4 && t.shapes.every((c) => /^#[0-9a-f]{6}$/.test(c)), `${id}.shapes`);
  }
});
check('text colours reach 4.5:1 on the card, tiles and buttons', () => {
  for (const id of THEME_IDS) {
    const t = THEMES[id];
    for (const ground of ['bg', 'tile', 'btn']) {
      for (const text of ['ink', 'sub', 'kicker', 'hi']) {
        const c = contrast(t[text], t[ground]);
        assert(c >= 4.5, `${id}: ${text} on ${ground} is ${c.toFixed(2)}`);
      }
    }
  }
});
check('text stays readable on a shape drawn under it', () => {
  for (const id of THEME_IDS) {
    const t = THEMES[id];
    for (const color of t.shapes) {
      const ground = blend(color, t.bg, UNDER_TEXT_OPACITY);
      for (const text of ['ink', 'sub', 'kicker']) {
        const c = contrast(t[text], ground);
        assert(c >= 4.5, `${id}: ${text} on ${color} at ${UNDER_TEXT_OPACITY} is ${c.toFixed(2)}`);
      }
    }
  }
});
check('stats.css colours the same six themes with the same colours', () => {
  const css = fs.readFileSync('src/stats/stats.css', 'utf8');
  const vars = { bg: '--sc-bg', border: '--sc-border', tile: '--sc-tile', btn: '--sc-btn', ink: '--sc-ink', sub: '--sc-sub', kicker: '--sc-kicker', hi: '--sc-hi', dim: '--sc-dim' };
  for (const id of THEME_IDS) {
    const rule = css.match(new RegExp(`\\.scard-theme--${id}\\s*\\{([^}]*)\\}`));
    assert(rule, `no .scard-theme--${id} in stats.css`);
    for (const [key, name] of Object.entries(vars)) {
      const m = rule[1].match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`));
      assert(m, `${id}: ${name} missing`);
      assert.equal(m[1].toLowerCase(), THEMES[id][key], `${id}: ${name}`);
    }
  }
});

// ---- Geometry ----
const { CARD_W, CARD_H, geometryOf, avoidOf, pagesOf, FORMATS } = geometry;
const KINDS = ['week', 'month', 'year'];
const everyCard = (fn) => {
  for (const kind of KINDS) for (const format of FORMATS) for (let page = 0; page < pagesOf(kind); page++) fn(geometryOf(kind, format, page), `${kind}/${format}/${page}`, kind, format, page);
};
const hit = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
check('a year has six pages, a week and a month one', () => {
  assert.deepEqual(KINDS.map(pagesOf), [1, 1, 6]);
});
check('the bands of a card sit inside it and do not overlap', () => {
  everyCard((g, label, kind, format) => {
    const bands = Object.entries(g.blocks).sort((a, b) => a[1].y - b[1].y);
    bands.forEach(([name, b], i) => {
      assert(b.y >= 0 && b.h > 0 && b.y + b.h <= CARD_H[format], `${label}: ${name} outside the card`);
      if (i) assert(b.y >= bands[i - 1][1].y + bands[i - 1][1].h, `${label}: ${name} overlaps ${bands[i - 1][0]}`);
    });
  });
});
check('sticker zones sit inside the card and clear of every text area', () => {
  everyCard((g, label, kind, format) => {
    assert(g.zones.length >= 2, `${label}: ${g.zones.length} zones`);
    for (const z of g.zones) {
      assert(z.x >= 0 && z.y >= 0 && z.x + z.w <= CARD_W && z.y + z.h <= CARD_H[format], `${label}: zone outside`);
      for (const a of g.avoid) assert(!hit(z, a), `${label}: zone ${JSON.stringify(z)} meets text ${JSON.stringify(a)}`);
    }
  });
});
// Bands that hold text straight on the card (the others sit on a tile, a cover or a chart of their own),
// and the stretch of each one's left side that the text area must span.
const TEXT_BANDS = { head: [80, 520], head2: [80, 520], line: [80, 520], hero: [80, 520], days: [80, 520], covers: [80, 520], book: [374, 774] };
check('every band of text on the card lies inside a text area the background keeps clear', () => {
  everyCard((g, label) => {
    for (const [name, [from, to]] of Object.entries(TEXT_BANDS)) {
      const band = g.blocks[name];
      if (!band) continue;
      const area = g.avoid.find((a) => a.y <= band.y && a.y + a.h >= band.y + band.h && a.x <= from && a.x + a.w >= to);
      assert(area, `${label}: the ${name} band ${JSON.stringify(band)} is not inside a text area`);
    }
    // The footer's two ends.
    const foot = g.blocks.foot;
    for (const [from, to] of [[80, 280], [CARD_W - 280, CARD_W - 80]]) {
      assert(g.avoid.some((a) => a.y <= foot.y && a.y + a.h >= foot.y + foot.h && a.x <= from && a.x + a.w >= to), `${label}: foot ${from}`);
    }
  });
});
check('the month cover row and its captions are a text area, in both formats', () => {
  for (const format of FORMATS) {
    const covers = geometryOf('month', format).blocks.covers;
    assert(avoidOf('month', format).some((a) => a.x <= 80 && a.x + a.w >= CARD_W - 80 && a.y <= covers.y && a.y + a.h >= covers.y + covers.h), `${format}: covers`);
    // Whatever reaches a caption (the foot of the cover row) is faint.
    const caption = { x: 300, y: covers.y + covers.h - 60, w: 10, h: 10 };
    for (let seed = 0; seed < 100; seed++) {
      for (const s of composeBackground(mulberry32(seed), THEMES.sunset, CARD_W, CARD_H[format], avoidOf('month', format))) {
        if (shapeTouches(s, caption)) assert(s.opacity <= UNDER_TEXT_OPACITY + 1e-9, `${format} seed ${seed}: a vivid shape under a caption`);
      }
    }
  }
});
check('no shape under text, on any card, theme or seed, is more than faint', () => {
  for (const kind of KINDS) {
    for (const format of FORMATS) {
      const avoid = avoidOf(kind, format);
      for (const id of THEME_IDS) {
        for (let seed = 0; seed < 60; seed++) {
          for (const s of composeBackground(mulberry32(seed), THEMES[id], CARD_W, CARD_H[format], avoid)) {
            if (avoid.some((a) => shapeTouches(s, a))) assert(s.opacity <= UNDER_TEXT_OPACITY + 1e-9, `${kind}/${format}/${id}/${seed}`);
          }
        }
      }
    }
  }
});
check('on every card most of the crisp shapes still keep their strength', () => {
  for (const kind of KINDS) {
    for (const format of FORMATS) {
      let crisp = 0;
      let strong = 0;
      for (let seed = 0; seed < 150; seed++) {
        for (const s of composeBackground(mulberry32(seed), THEMES.wine, CARD_W, CARD_H[format], avoidOf(kind, format))) {
          if (s.blur > 0 && s.size >= 0.8 * CARD_W) continue;
          crisp++;
          if (s.opacity > UNDER_TEXT_OPACITY) strong++;
        }
      }
      assert(strong / crisp > 0.7, `${kind}/${format}: only ${Math.round((100 * strong) / crisp)}% of the crisp shapes are not faded`);
    }
  }
});

// ---- The highlight line ----
const stats = ({ persona, ...over } = {}) => ({
  persona: { night_share: 0, early_share: 0, trend_pct: null, ...persona },
  best_day: null,
  words: 0,
  highlights: 0,
  finished: [],
  days_read: 0,
  ...over,
});
check('the highlight line is the first fact the numbers support, in order', () => {
  const day = { day: '2026-10-14', seconds: 3000 };
  assert.equal(pickFact(stats({ persona: { trend_pct: 40 }, best_day: day })), 'trend');
  assert.equal(pickFact(stats({ persona: { trend_pct: 14 }, best_day: day })), 'best');
  assert.equal(pickFact(stats({ persona: { night_share: 0.6 } })), 'night');
  assert.equal(pickFact(stats({ persona: { early_share: 0.3 } })), 'early');
  assert.equal(pickFact(stats({ words: 3 })), 'words');
  assert.equal(pickFact(stats({ highlights: 5 })), 'highlights');
  assert.equal(pickFact(stats({ finished: [{}] })), 'finished');
  assert.equal(pickFact(stats({ days_read: 4 })), 'days');
  assert.equal(pickFact(stats()), 'none');
  assert.equal(pickFact(stats({ persona: { trend_pct: 40, night_share: 0.9 }, best_day: day, words: 2, highlights: 3 })), 'trend');
});
check('the highlight line never repeats a fact the card already shows', () => {
  const day = { day: '2026-10-14', seconds: 3000 };
  const rich = stats({ persona: { trend_pct: 158 }, best_day: day, words: 2, highlights: 30, finished: [{}], days_read: 6 });
  const noBest = { ...rich, best_day: null };
  const noWords = { ...noBest, words: 0 };
  // The week card shows the trend and the days: the line is another fact (it was the trend again).
  assert.equal(pickFact(rich, ['trend', 'days']), 'best');
  assert.equal(pickFact(noBest, ['trend', 'days']), 'words');
  assert.equal(pickFact(noWords, ['trend', 'days']), 'highlights');
  // The month shows the days, the highlights and (as covers) the finished books.
  assert.equal(pickFact(noWords, ['days', 'highlights', 'finished']), 'trend');
  assert.equal(pickFact({ ...noWords, persona: { ...rich.persona, trend_pct: 3 } }, ['days', 'highlights', 'finished']), 'none');
  // The year overview shows the trend, the days, the highlights and the books.
  assert.equal(pickFact(noWords, ['trend', 'days', 'highlights', 'finished']), 'none');
  for (const shown of [['trend'], ['days'], ['highlights'], ['finished'], ['trend', 'days', 'highlights', 'finished']]) {
    for (const p of [rich, noBest, noWords]) assert(!shown.includes(pickFact(p, shown)), `${pickFact(p, shown)} is shown already`);
  }
});

// ---- Sticker rules ----
function baseFacts(over = {}) {
  return { kind: 'month', streakBest: 0, nightShare: 0, earlyShare: 0, goalMet: false, finished: 0, highlights: 0, notes: 0, words: 0, trendPct: null, topGenre: null, badges: [], ...over };
}
const refs = (f, seed = 1) => rules.pickStickers(f, mulberry32(seed)).map((s) => `${s.kind}:${s.ref}`);

// ---- Icons ----
const manifest = JSON.parse(fs.readFileSync('src/wrap/icons.json', 'utf8'));
const ids = new Set(manifest.map((i) => i.id));
check('the icon manifest is well formed and its files exist as WebP', () => {
  assert(manifest.length >= 30 && manifest.length <= 50, `${manifest.length} icons`);
  assert.equal(ids.size, manifest.length, 'unique ids');
  for (const icon of manifest) {
    assert(/^[a-z-]+$/.test(icon.id) && icon.file === `${icon.id}.webp` && icon.tags.length > 0, icon.id);
    assert.equal(new URL(icon.source_url).hostname, 'cdn.3dicons.reicon.dev', icon.id);
    for (const size of [256, 512]) {
      const bytes = fs.readFileSync(`public/wrap-icons/${size}/${icon.file}`);
      assert(bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP', `${icon.id} ${size}`);
    }
  }
  assert.equal(fs.readdirSync('public/wrap-icons/256').length, manifest.length, 'no file outside the manifest');
});
check('the sticker tray offers first what the rules would use, unique, all in the manifest', () => {
  const f = baseFacts({ kind: 'year', topGenre: 'romance', streakBest: 9, nightShare: 0.6, goalMet: true, badges: [{ id: 'streak', tier: 2 }] });
  const list = rules.relevantStickers(f);
  const keys = list.map((s) => `${s.kind}:${s.ref}`);
  assert.equal(new Set(keys).size, keys.length);
  for (const must of ['icon:heart', 'icon:flame', 'icon:moon', 'icon:trophy', 'icon:medal', 'badge:streak']) assert(keys.includes(must), must);
  for (const s of list) if (s.kind === 'icon') assert(ids.has(s.ref), s.ref);
  assert(rules.relevantStickers(baseFacts()).length >= 3);
});
check('every icon the rules can name is in the manifest', () => {
  const named = new Set(Object.values(rules.GENRE_ICON));
  const facts = [baseFacts(), baseFacts({ kind: 'year', topGenre: 'romance', streakBest: 9, nightShare: 0.6, goalMet: true, finished: 4, highlights: 30, notes: 6, words: 3, trendPct: 40, badges: [{ id: 'streak', tier: 2 }] }), baseFacts({ earlyShare: 0.4 })];
  for (const f of facts) {
    for (let page = 0; page < 6; page++) for (const s of rules.yearPageStickers(f, page, mulberry32(1))) if (s.kind === 'icon') named.add(s.ref);
    for (let seed = 0; seed < 50; seed++) for (const s of rules.pickStickers(f, mulberry32(seed))) if (s.kind === 'icon') named.add(s.ref);
  }
  for (const id of named) assert(ids.has(id), `icon "${id}" is not in icons.json`);
});
check('stickers follow the rules, most telling first', () => {
  assert.equal(refs(baseFacts({ streakBest: 7 }))[0], 'icon:flame');
  assert.equal(refs(baseFacts({ streakBest: 6 })).includes('icon:flame'), false);
  assert.equal(refs(baseFacts({ nightShare: 0.5 }))[0], 'icon:moon');
  assert.equal(refs(baseFacts({ earlyShare: 0.3 }))[0], 'icon:sun');
  assert.equal(refs(baseFacts({ goalMet: true }))[0], 'icon:trophy');
  assert.deepEqual(refs(baseFacts({ badges: [{ id: 'books', tier: 3 }, { id: 'streak', tier: 1 }] })).slice(0, 2), ['icon:medal', 'badge:books']);
  assert.equal(refs(baseFacts({ topGenre: 'romance' }))[0], 'icon:heart');
  assert.equal(refs(baseFacts({ topGenre: 'fantasy' }))[0], 'icon:wand');
  assert.equal(refs(baseFacts({ topGenre: 'scifi' }))[0], 'icon:rocket');
  assert.equal(refs(baseFacts({ topGenre: 'mystery' }))[0], 'icon:magnifier');
  assert.equal(refs(baseFacts({ topGenre: 'horror' }))[0], 'icon:ghost');
  assert.equal(refs(baseFacts({ trendPct: 16 }))[0], 'icon:rocket');
  assert.equal(refs(baseFacts({ trendPct: 15 })).includes('icon:rocket'), false);
  assert.equal(refs(baseFacts({ trendPct: 14 })).includes('icon:rocket'), false);
  assert.deepEqual(refs(baseFacts({ topGenre: 'scifi', trendPct: 30 })).slice(0, 2), ['icon:rocket', 'icon:lightning']);
  assert.equal(refs(baseFacts({ finished: 3 }))[0], 'icon:crown');
  assert.equal(refs(baseFacts({ highlights: 20 }))[0], 'icon:bookmark');
  assert.equal(refs(baseFacts({ words: 1 }))[0], 'icon:lightbulb');
  assert.equal(refs(baseFacts({ kind: 'year' }))[0], 'icon:gift');
  assert(refs(baseFacts({ kind: 'year' })).includes('icon:popper'));
});
check('3 to 6 stickers, no repeats, whatever the facts', () => {
  const everything = baseFacts({ kind: 'year', streakBest: 30, nightShare: 0.7, earlyShare: 0.4, goalMet: true, finished: 9, highlights: 90, notes: 9, words: 9, trendPct: 50, topGenre: 'romance', badges: [{ id: 'streak', tier: 3 }] });
  for (const f of [baseFacts(), everything, baseFacts({ streakBest: 7 })]) {
    for (let seed = 0; seed < 30; seed++) {
      const list = refs(f, seed);
      assert(list.length >= 3 && list.length <= 6, `${list.length} stickers`);
      assert.equal(new Set(list).size, list.length);
    }
  }
  assert.deepEqual(refs(baseFacts(), 4), refs(baseFacts(), 4));
});

// ---- Layout ----
const periodStats = (over = {}) => ({
  kind: 'month', days: Array.from({ length: 30 }, () => ({})), days_met: 20, streak_best_in_period: 8, finished: [{}, {}, {}], highlights: 41, notes: 2, words: 0,
  persona: { night_share: 0.6, early_share: 0, top_genre: 'literary', trend_pct: 20, avg_min_per_reading_day: 20, fast_finishes: 0 }, ...over,
});
const box = (s) => {
  const size = layout.STICKER_BASE * s.scale;
  return { x: s.x - size / 2, y: s.y - size / 2, w: size, h: size };
};
check('iconFacts reads a period', () => {
  const f = rules.iconFacts(periodStats(), [{ id: 'streak', tier: 0 }, { id: 'books', tier: 2 }, { id: 'hours', tier: 3 }]);
  assert.deepEqual(f.badges.map((b) => b.id), ['hours', 'books']);
  assert.equal(f.goalMet, true);
  assert.equal(rules.iconFacts(periodStats({ days_met: 14 })).goalMet, false);
  assert.equal(f.streakBest, 8);
  assert.equal(f.topGenre, 'literary');
  assert.equal(f.finished, 3);
});
check('the auto layout puts stickers in free zones, inside the card, clear of the text', () => {
  for (const kind of KINDS) {
    for (const format of FORMATS) {
      const facts = rules.iconFacts(periodStats({ kind }), [{ id: 'streak', tier: 2 }]);
      for (let seed = 0; seed < 40; seed++) {
        const stickers = layout.autoStickers(kind, format, facts, mulberry32(seed));
        assert(stickers.length >= 3, `${kind}/${format}: ${stickers.length} stickers`);
        const taken = new Set();
        for (const s of stickers) {
          const page = s.page ?? 0;
          const b = box(s);
          assert(b.x >= 0 && b.y >= 0 && b.x + b.w <= CARD_W && b.y + b.h <= CARD_H[format], `${kind}/${format}/${page}: ${s.id} outside`);
          for (const a of geometryOf(kind, format, page).avoid) assert(!hit(b, a), `${kind}/${format}/${page}: ${s.id} covers text ${JSON.stringify(a)}`);
          assert(Math.abs(s.rotate) <= 16 && s.scale > 0.2 && s.scale < 1.2, `${s.id} turn/scale`);
          assert(!taken.has(s.id), 'unique ids');
          taken.add(s.id);
        }
        for (const a of stickers) for (const b of stickers) if (a !== b && (a.page ?? 0) === (b.page ?? 0)) assert(!hit(box(a), box(b)), `${kind}/${format}: ${a.id} overlaps ${b.id}`);
      }
    }
  }
});
check('a year spreads stickers over its six pages', () => {
  const stickers = layout.autoStickers('year', 'story', rules.iconFacts(periodStats({ kind: 'year' })), mulberry32(3));
  assert.deepEqual([...new Set(stickers.map((s) => s.page ?? 0))].sort(), [0, 1, 2, 3, 4, 5]);
  assert.equal(new Set(stickers.map((s) => s.z)).size, stickers.length, 'unique z');
});
check('newLayout is stable, and rerolling changes the background but not the stickers', () => {
  const facts = rules.iconFacts(periodStats());
  const a = layout.newLayout('month', '2026-10-01', facts);
  assert.deepEqual(a, layout.newLayout('month', '2026-10-01', facts));
  assert.equal(a.theme, 'wine');
  assert.equal(a.seed, seedFor('month', '2026-10-01', 0));
  const b = layout.newLayout('month', '2026-10-01', facts, { reroll: 2 });
  assert.equal(b.seed, seedFor('month', '2026-10-01', 2));
  assert.deepEqual(b.stickers, a.stickers);
  assert.notDeepEqual(layout.newLayout('month', '2026-10-01', facts, { format: 'post' }).stickers, a.stickers);
  assert.deepEqual(['week', 'month', 'year'].map((k) => layout.newLayout(k, '2026-01-05', facts).theme), ['forest', 'wine', 'night']);
});
check('a saved layout comes back, and anything unusable is refused', () => {
  const facts = rules.iconFacts(periodStats({ kind: 'year' }));
  const a = layout.newLayout('year', '2026-01-01', facts, { reroll: 3, format: 'post' });
  assert.deepEqual(layout.parseLayout(layout.layoutJson(a), 'year'), a);
  assert.equal(layout.parseLayout(null, 'year'), null);
  assert.equal(layout.parseLayout('not json', 'year'), null);
  assert.equal(layout.parseLayout('{}', 'year'), null);
  const bad = (change) => layout.parseLayout(JSON.stringify({ ...a, ...change }), 'year');
  assert.equal(bad({ theme: 'neon' }), null);
  assert.equal(bad({ format: 'banner' }), null);
  assert.equal(bad({ stickers: [{ id: 'x', kind: 'icon', ref: 'star', x: 1, y: 2, scale: 1, rotate: 0 }] }), null);
  assert.equal(bad({ stickers: [{ ...a.stickers[0], page: 9 }] }), null);
  // A page is only valid for a year.
  assert.equal(layout.parseLayout(layout.layoutJson(a), 'month'), null);
});

console.log(`${checks} checks passed`);
