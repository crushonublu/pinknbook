// Run from app/: node scripts/check-radial-layout.mjs
// The focus ring of the phone map (src/graphLayout.ts radialLayout): nothing
// covers anything, everything stays on screen, the same input gives the same
// picture, and people with the same kind of tie sit together.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import ts from 'typescript';

const js = ts.transpileModule(fs.readFileSync('src/graphLayout.ts', 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const { radialLayout, RING_MAX } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));

const KINDS = ['family', 'love', 'conflict', 'social', 'none'];
const W = 390;
const H = 844;
const room = { top: 120, bottom: 170 };
// Deterministic "random" widths.
let seed = 7;
const rnd = (a, b) => {
  seed = (seed * 16807) % 2147483647;
  return a + (seed % 1000) / 1000 * (b - a);
};
// Boxes and round discs.
const overlap = (a, b) => {
  if ('cx' in a && 'cx' in b) return Math.hypot(a.cx - b.cx, a.cy - b.cy) < a.r + b.r;
  if ('cx' in a) return overlap(b, a);
  if (!('cx' in b)) return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  const nx = Math.max(a.x, Math.min(b.cx, a.x + a.w));
  const ny = Math.max(a.y, Math.min(b.cy, a.y + a.h));
  return Math.hypot(nx - b.cx, ny - b.cy) < b.r;
};
const extent = (b) => ('cx' in b ? { x: b.cx - b.r, y: b.cy - b.r, w: 2 * b.r, h: 2 * b.r } : b);
const disc = (n) => ({ cx: n.x, cy: n.y, r: n.r });

for (let n = 1; n <= 14; n++) {
  for (let trial = 0; trial < 6; trial++) {
    const ring = Array.from({ length: n }, (_, i) => ({
      key: `p${i}`,
      kind: KINDS[Math.floor(rnd(0, 5))],
      strength: Math.round(rnd(1, 40)),
      nameW: rnd(40, 130),
      labelW: trial % 3 === 0 ? 0 : rnd(28, 110),
    }));
    const outer = ring.slice(0, 3).map((r, i) => ({ key: `o${i}`, kind: 'family', strength: 3, nameW: rnd(40, 100), labelW: rnd(28, 70), via: r.key }));
    const L = radialLayout(W, H, ring, outer, room);
    const again = radialLayout(W, H, ring, outer, room);
    assert.deepEqual(again, L, 'same input, same picture');
    assert.equal(L.nodes.filter((v) => !v.outer).length, Math.min(n, RING_MAX));
    assert.equal(L.more.length, Math.max(0, n - RING_MAX));

    const boxes = [{ what: 'center', b: disc(L.center) }];
    for (const v of L.nodes) boxes.push({ what: `disc ${v.key}`, b: disc(v) }, { what: `name ${v.key}`, b: v.name });
    for (const l of L.labels) boxes.push({ what: `label ${l.key}`, b: l });
    for (const { what, b: shape } of boxes) {
      const b = extent(shape);
      assert.ok(b.x >= 0 && b.x + b.w <= W, `${what} on screen (n=${n})`);
      if (!what.startsWith('name') && what !== 'center') assert.ok(b.y >= room.top - 1 && b.y + b.h <= H - room.bottom + 1, `${what} clear of header and card (n=${n})`);
    }
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        // A disc and its own name touch by design.
        const a = boxes[i].what.split(' ')[1];
        const b = boxes[j].what.split(' ')[1];
        if (a && a === b) continue;
        assert.ok(!overlap(boxes[i].b, boxes[j].b), `${boxes[i].what} and ${boxes[j].what} overlap (n=${n}, trial ${trial})`);
      }
    }
    // Kinds sit together around the ring.
    const kinds = L.nodes.filter((v) => !v.outer).map((v) => ring.find((r) => r.key === v.key).kind);
    const runs = kinds.filter((k, i) => i === 0 || k !== kinds[i - 1]).length;
    assert.equal(runs, new Set(kinds).size, `same kinds side by side (n=${n})`);
    // Most labels find a place.
    const want = ring.slice(0, RING_MAX).filter((r) => r.labelW > 0).length;
    if (want && n <= 6) assert.ok(L.labels.filter((l) => !l.key.startsWith('o')).length >= Math.ceil(want * 0.75), `labels placed (n=${n}, trial ${trial})`);
  }
}
console.log('radial layout: ok');
