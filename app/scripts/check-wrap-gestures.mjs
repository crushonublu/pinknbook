// Run from app/: node scripts/check-wrap-gestures.mjs
// Checks the pure maths of editing a sticker on a wrap-up card: drag, two-finger
// pinch (scale, turn, move), the desktop corner handle, keys, limits and bounds.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import ts from 'typescript';

/** Loads a TypeScript module of src/wrap; a sibling it imports must be loaded before it. */
const loaded = {};
async function load(file) {
  const source = fs.readFileSync(`src/wrap/${file}.ts`, 'utf8');
  let js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
  js = js.replace(/from\s+["']\.\/(\w+)["']/g, (m, name) => (loaded[name] ? `from "${loaded[name]}"` : m));
  const url = 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');
  loaded[file] = url;
  return import(url);
}
await load('shapes');
await load('palettes');
const { CARD_W, CARD_H } = await load('geometry');
await load('iconRules');
const { STICKER_BASE } = await load('layout');
const g = await load('gestures');

let checks = 0;
const check = (label, fn) => {
  fn();
  checks++;
  console.log('PASS ' + label);
};
const near = (a, b, eps = 0.2, what = '') => assert(Math.abs(a - b) <= eps, `${what} ${a} is not ${b}`);
const pose = (over = {}) => ({ x: 540, y: 900, scale: 1, rotate: 0, ...over });
const P = (x, y) => ({ x, y });
const inside = (p, format) => {
  const half = g.reach(p);
  return p.x - half >= 0 && p.y - half >= 0 && p.x + half <= CARD_W && p.y + half <= CARD_H[format];
};

check('wrapDegrees folds any angle into (-180, 180]', () => {
  assert.equal(g.wrapDegrees(190), -170);
  assert.equal(g.wrapDegrees(-190), 170);
  assert.equal(g.wrapDegrees(180), 180);
  assert.equal(g.wrapDegrees(-180), 180);
  assert.equal(g.wrapDegrees(750), 30);
  assert.equal(g.wrapDegrees(0), 0);
});

check('reach is half the box of the turned square', () => {
  near(g.reach({ scale: 1, rotate: 0 }), STICKER_BASE / 2, 1e-9);
  near(g.reach({ scale: 1, rotate: 45 }), (STICKER_BASE / 2) * Math.SQRT2, 1e-9);
  near(g.reach({ scale: 2, rotate: 90 }), STICKER_BASE, 1e-9);
});

check('a drag moves the sticker by what the pointer moved', () => {
  const p = g.dragPose(pose(), P(100, 100), P(160, 70), 'story');
  assert.deepEqual([p.x, p.y, p.scale, p.rotate], [600, 870, 1, 0]);
});

check('a drag stops at the card edges (the whole sticker stays in)', () => {
  const s = pose({ rotate: 30, scale: 1.2 });
  for (const [dx, dy] of [[5000, 0], [-5000, 0], [0, 5000], [0, -5000], [-5000, -5000], [5000, 5000]]) {
    for (const format of ['story', 'post']) {
      const p = g.dragPose(s, P(0, 0), P(dx, dy), format);
      assert(inside(p, format), `${dx},${dy} ${format}: ${JSON.stringify(p)}`);
    }
  }
  near(g.dragPose(pose(), P(0, 0), P(5000, 0), 'story').x, CARD_W - STICKER_BASE / 2, 0.1);
});

check('two fingers moving apart scale the sticker by the ratio of the distances', () => {
  const p = g.pinchPose(pose(), [P(400, 900), P(500, 900)], [P(350, 900), P(550, 900)], 'story');
  near(p.scale, 2, 0.001, 'scale');
  near(p.rotate, 0, 0.1, 'rotate');
});

check('two fingers turning turn the sticker by the angle between them', () => {
  const p = g.pinchPose(pose(), [P(440, 900), P(640, 900)], [P(540, 800), P(540, 1000)], 'story');
  near(p.rotate, 90, 0.1, 'rotate');
  near(p.scale, 1, 0.001, 'scale');
  // The midpoint did not move: nor did the sticker.
  near(p.x, 540, 0.2, 'x');
  near(p.y, 900, 0.2, 'y');
  const back = g.pinchPose(pose({ rotate: 20 }), [P(440, 900), P(640, 900)], [P(640, 900), P(440, 900)], 'story');
  near(back.rotate, -160, 0.1, 'half turn from 20');
});

check('the sticker is carried along by the fingers: it follows the same turn, scale and move', () => {
  const start = pose({ x: 500, y: 700, scale: 0.8, rotate: 10 });
  // Any turn + scale + move of the plane; the fingers go where it takes them.
  const [k, deg] = [1.5, 35];
  const a = (deg * Math.PI) / 180;
  const turned = (p) => P(k * (p.x * Math.cos(a) - p.y * Math.sin(a)), k * (p.x * Math.sin(a) + p.y * Math.cos(a)));
  // The move puts the sticker's centre at (560, 880), well inside the card.
  const c = P(560 - turned(start).x, 880 - turned(start).y);
  const T = (p) => P(turned(p).x + c.x, turned(p).y + c.y);
  const from = [P(300, 600), P(520, 640)];
  const p = g.pinchPose(start, from, from.map(T), 'story');
  near(p.scale, start.scale * k, 0.002, 'scale');
  near(p.rotate, start.rotate + deg, 0.1, 'rotate');
  const centre = T(start);
  near(p.x, centre.x, 0.2, 'x');
  near(p.y, centre.y, 0.2, 'y');
});

check('scale is limited to 0.4-3, however far the fingers go', () => {
  const tiny = g.pinchPose(pose(), [P(300, 900), P(700, 900)], [P(539, 900), P(541, 900)], 'story');
  assert.equal(tiny.scale, g.MIN_SCALE);
  const huge = g.pinchPose(pose(), [P(530, 900), P(550, 900)], [P(0, 900), P(1080, 900)], 'story');
  assert.equal(huge.scale, g.MAX_SCALE);
  assert.equal(g.MIN_SCALE, 0.4);
  assert.equal(g.MAX_SCALE, 3);
  assert(inside(huge, 'story') && inside(tiny, 'story'));
});

check('a pinch never leaves the card, even when the fingers go to a corner', () => {
  for (const format of ['story', 'post']) {
    const p = g.pinchPose(pose(), [P(500, 900), P(580, 900)], [P(1070, CARD_H[format] - 20), P(1075, CARD_H[format] - 10)], format);
    assert(inside(p, format), JSON.stringify(p));
  }
});

check('fingers on the same spot (no distance to compare) leave the sticker be', () => {
  const s = pose({ x: 300, y: 400, rotate: 12, scale: 0.7 });
  assert.deepEqual(g.pinchPose(s, [P(10, 10), P(10, 10)], [P(50, 50), P(90, 90)], 'story'), g.clampPose(s, 'story'));
  assert.deepEqual(g.handlePose(s, P(300, 400), P(900, 900), 'story'), g.clampPose(s, 'story'));
});

check('the corner handle scales by its distance from the centre and turns by its direction', () => {
  const s = pose({ rotate: 10, scale: 1 });
  // Handle at 45 degrees, 100 away; dragged to 135 degrees, 200 away.
  const p = g.handlePose(s, P(540 + 70.71, 900 + 70.71), P(540 - 141.42, 900 + 141.42), 'story');
  near(p.scale, 2, 0.003, 'scale');
  near(p.rotate, 10 + 90, 0.1, 'rotate');
  assert.equal(p.x, 540);
  assert.equal(p.y, 900);
});

check('keys: arrows nudge 1 (10 with Shift), brackets turn, plus and minus scale', () => {
  const s = pose({ x: 300, y: 400, rotate: 0, scale: 1 });
  assert.deepEqual([g.nudgePose(s, 1, 0, false, 'story').x, g.nudgePose(s, 0, -1, false, 'story').y], [301, 399]);
  assert.deepEqual([g.nudgePose(s, -1, 0, true, 'story').x, g.nudgePose(s, 0, 1, true, 'story').y], [290, 410]);
  assert.equal(g.turnPose(s, 1, false, 'story').rotate, 5);
  assert.equal(g.turnPose(s, -1, true, 'story').rotate, -15);
  near(g.resizePose(s, 1, false, 'story').scale, 1.05, 1e-9);
  near(g.resizePose(s, -1, true, 'story').scale, 0.8, 1e-9);
  assert.equal(g.resizePose(pose({ scale: 0.41 }), -1, true, 'story').scale, g.MIN_SCALE);
  assert.equal(g.resizePose(pose({ scale: 2.9 }), 1, true, 'story').scale, g.MAX_SCALE);
  // Against the edge a nudge cannot push out, and a turn that would poke the corners out moves the sticker in.
  const edge = g.dragPose(s, P(0, 0), P(-5000, 0), 'story');
  assert.equal(g.nudgePose(edge, -1, 0, true, 'story').x, edge.x);
  assert(inside(g.turnPose(edge, 1, true, 'story'), 'story'));
});

check('clampPose rounds for saving and keeps stickers legal in both formats', () => {
  const p = g.clampPose({ x: 500.456, y: 789.123, scale: 1.23456, rotate: 12.3456 }, 'post');
  assert.deepEqual(p, { x: 500.5, y: 789.1, scale: 1.235, rotate: 12.3 });
  for (const format of ['story', 'post']) {
    for (const rotate of [0, 33, 45, 90, 135, 180, -170]) {
      for (const scale of [0.1, 0.4, 1, 3, 9]) {
        const q = g.clampPose({ x: -300, y: 9999, scale, rotate }, format);
        assert(inside(q, format), `${format} ${rotate} ${scale}: ${JSON.stringify(q)}`);
        assert(q.scale >= g.MIN_SCALE && q.scale <= g.MAX_SCALE);
      }
    }
  }
});

check('the biggest sticker at any angle fits the post card', () => {
  for (let rotate = -180; rotate <= 180; rotate += 5) {
    const q = g.clampPose({ x: 540, y: 675, scale: g.MAX_SCALE, rotate }, 'post');
    assert(inside(q, 'post'), `${rotate}`);
    near(q.x, 540, 0.1, `x at ${rotate}`);
  }
});

check("toCard divides out the card's scale and offset", () => {
  assert.deepEqual(g.toCard(300, 500, { left: 100, top: 200 }, 0.5), P(400, 600));
  assert.deepEqual(g.toCard(100, 200, { left: 100, top: 200 }, 0.25), P(0, 0));
});

check('raised puts a sticker in front on its own page only', () => {
  const s = (id, z, page) => ({ id, kind: 'icon', ref: 'star', x: 1, y: 1, scale: 1, rotate: 0, z, ...(page ? { page } : {}) });
  const list = [s('a', 1), s('b', 2), s('c', 3), s('d', 4, 1)];
  const up = g.raised(list, 'a');
  assert.equal(up.find((x) => x.id === 'a').z, 4);
  assert.deepEqual(up.filter((x) => x.id !== 'a'), list.filter((x) => x.id !== 'a'));
  assert.equal(g.raised(list, 'c'), list, 'already in front: the same array');
  assert.equal(g.raised(list, 'd'), list, 'the only one of page 1');
  assert.equal(g.raised(list, 'zz').length, 4);
  assert.deepEqual(list.map((x) => x.z), [1, 2, 3, 4], 'the input is not changed');
});

console.log(`${checks} checks passed`);
