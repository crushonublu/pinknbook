// Generated backgrounds for the wrap-up cards: a few soft, grainy shapes (blobs,
// bursts, flowers, seals, rings, pills, arches) on the card colour. Everything is
// derived from a seed, so a card always opens with the same background and
// "Đổi nền" only has to bump a counter. The result is plain SVG text: it is
// shown in an <img> and can be drawn into the exported picture as it is.
//
// The generator is self-contained (no imports besides types) so that
// scripts/check-wrap.mjs can load it on its own.

/** A random number generator: [0, 1). */
export type Rng = () => number;

/** mulberry32: a small, fast seeded generator (same seed, same sequence). */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a: a stable 32-bit hash of a string. */
export function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** The seed of a card's background: its kind, first day and reroll counter. */
export const seedFor = (kind: string, periodStart: string, reroll: number): number => hash32(`${kind}|${periodStart}|${reroll}`);

const between = (rng: Rng, lo: number, hi: number) => lo + (hi - lo) * rng();
const intBetween = (rng: Rng, lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));
const pick = <T>(rng: Rng, list: readonly T[]): T => list[Math.floor(rng() * list.length)];
/** Numbers in paths: three decimals are plenty for a unit box and keep the text short. */
const n = (v: number) => String(Math.round(v * 1000) / 1000);

interface Pt {
  x: number;
  y: number;
}

// ---- Shape builders ---------------------------------------------------------------------------
// Each returns SVG path data in the unit box (0..1, centre .5 .5, never wider than 1).

/** A closed smooth curve through the points (Catmull-Rom turned into cubic Béziers). */
function smoothClosed(pts: Pt[]): string {
  const m = pts.length;
  let d = `M${n(pts[0].x)} ${n(pts[0].y)}`;
  for (let i = 0; i < m; i++) {
    const p0 = pts[(i - 1 + m) % m];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % m];
    const p3 = pts[(i + 2) % m];
    d += `C${n(p1.x + (p2.x - p0.x) / 6)} ${n(p1.y + (p2.y - p0.y) / 6)} ${n(p2.x - (p3.x - p1.x) / 6)} ${n(p2.y - (p3.y - p1.y) / 6)} ${n(p2.x)} ${n(p2.y)}`;
  }
  return `${d}Z`;
}

/** A closed polygon whose corners are rounded: `round` (0..0.5) is how far along each edge the rounding starts. */
function roundedPolygon(pts: Pt[], round: number): string {
  const m = pts.length;
  const at = (a: Pt, b: Pt) => ({ x: a.x + (b.x - a.x) * round, y: a.y + (b.y - a.y) * round });
  let d = "";
  for (let i = 0; i < m; i++) {
    const prev = pts[(i - 1 + m) % m];
    const v = pts[i];
    const next = pts[(i + 1) % m];
    const a = at(v, prev);
    const b = at(v, next);
    d += `${i ? "L" : "M"}${n(a.x)} ${n(a.y)}Q${n(v.x)} ${n(v.y)} ${n(b.x)} ${n(b.y)}`;
  }
  return `${d}Z`;
}

/** Points on a circle of radius .5 around the centre, `radius(i)` of it, starting at `phase`. */
const onCircle = (count: number, radius: (i: number) => number, phase: number): Pt[] =>
  Array.from({ length: count }, (_, i) => {
    const a = phase + (i * 2 * Math.PI) / count;
    const r = 0.5 * radius(i);
    return { x: 0.5 + r * Math.cos(a), y: 0.5 + r * Math.sin(a) };
  });

/** An organic blob: 5-8 points round a circle with jittered radii, joined smoothly. */
export function blob(rng: Rng, points = intBetween(rng, 5, 8), jitter = between(rng, 0.2, 0.4)): string {
  return smoothClosed(onCircle(points, () => 1 - jitter * rng(), rng() * Math.PI * 2));
}

/** A star-burst: 6-14 spikes, the valleys at `inner` (0.3..0.85) of the radius, corners rounded when `rounded`. */
export function burst(rng: Rng, spikes = intBetween(rng, 6, 14), inner = between(rng, 0.55, 0.8), rounded = rng() < 0.7): string {
  const pts = onCircle(spikes * 2, (i) => (i % 2 ? inner : 1), -Math.PI / 2);
  return roundedPolygon(pts, rounded ? between(rng, 0.25, 0.4) : 0);
}

/** A polar curve r = base + amp*cos(k*angle), sampled smoothly. */
function wave(lobes: number, base: number, amp: number): string {
  const samples = Math.max(96, lobes * 12);
  return smoothClosed(
    Array.from({ length: samples }, (_, i) => {
      const a = (i * 2 * Math.PI) / samples - Math.PI / 2;
      const r = base + amp * Math.cos(lobes * (a + Math.PI / 2));
      return { x: 0.5 + r * Math.cos(a), y: 0.5 + r * Math.sin(a) };
    }),
  );
}

/** A flower: 4-9 round petals. */
export function flower(rng: Rng, petals = intBetween(rng, 4, 9)): string {
  const amp = between(rng, 0.1, 0.16);
  return wave(petals, 0.5 - amp, amp);
}

/** A wavy seal (a scalloped coin): 10-20 shallow waves. */
export function seal(rng: Rng, waves = intBetween(rng, 10, 20)): string {
  return wave(waves, 0.46, 0.04);
}

/** A ring: a disc with a round hole (the hole winds the other way, so it is empty with the default fill rule). */
export function ring(rng: Rng): string {
  const hole = between(rng, 0.22, 0.34);
  const circle = (r: number, sweep: 0 | 1) => `M${n(0.5 - r)} .5A${n(r)} ${n(r)} 0 1 ${sweep} ${n(0.5 + r)} .5A${n(r)} ${n(r)} 0 1 ${sweep} ${n(0.5 - r)} .5Z`;
  return `${circle(0.5, 1)}${circle(hole, 0)}`;
}

/** A pill: a capsule, wide and about half as tall. */
export function pill(rng: Rng): string {
  const h = between(rng, 0.38, 0.52);
  const r = h / 2;
  const top = 0.5 - r;
  const bottom = 0.5 + r;
  return `M${n(r)} ${n(top)}H${n(1 - r)}A${n(r)} ${n(r)} 0 0 1 ${n(1 - r)} ${n(bottom)}H${n(r)}A${n(r)} ${n(r)} 0 0 1 ${n(r)} ${n(top)}Z`;
}

/** An arch: a door shape, flat at the bottom and a half circle on top. */
export function arch(rng: Rng): string {
  const w = between(rng, 0.7, 1);
  const x0 = 0.5 - w / 2;
  const r = w / 2;
  return `M${n(x0)} 1V${n(r)}A${n(r)} ${n(r)} 0 0 1 ${n(x0 + w)} ${n(r)}V1Z`;
}

export const SHAPE_KINDS = ["blob", "burst", "flower", "seal", "ring", "pill", "arch"] as const;
export type ShapeKind = (typeof SHAPE_KINDS)[number];

const BUILDERS: Record<ShapeKind, (rng: Rng) => string> = {
  blob: (r) => blob(r),
  burst: (r) => burst(r),
  flower: (r) => flower(r),
  seal: (r) => seal(r),
  ring,
  pill,
  arch,
};

/** One shape of the given kind. */
export const buildShape = (kind: ShapeKind, rng: Rng): string => BUILDERS[kind](rng);

// ---- Composition --------------------------------------------------------------------------------

/** A rectangle in card coordinates. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** What a background needs of a card theme. */
export interface ShapePalette {
  /** Card colour. */
  bg: string;
  /** 3-4 colours the shapes are drawn in. */
  shapes: readonly string[];
  /** Colour of the grain (light on dark cards, dark on light ones). */
  grain: string;
}

export type Fill =
  | { type: "solid"; color: string }
  | { type: "linear"; from: string; to: string; angle: number }
  | { type: "radial"; from: string; to: string };

/** A shape placed on the card. */
export interface PlacedShape {
  kind: ShapeKind;
  d: string;
  /** Centre, in card coordinates. */
  cx: number;
  cy: number;
  /** Width of the unit box, in card coordinates. */
  size: number;
  /** Degrees. */
  rotate: number;
  fill: Fill;
  opacity: number;
  /** Gaussian blur radius in card coordinates (0 = sharp). */
  blur: number;
}

/** A shape that touches text is drawn at most this opaque, so the text stays readable. */
export const UNDER_TEXT_OPACITY = 0.22;
/** Shapes per card. */
export const MIN_SHAPES = 3;
export const MAX_SHAPES = 6;
/** Positions tried for each shape: many, because most of a card is text and few spots reach none of it. */
const TRIES = 200;

/** How far a shape reaches from its centre, as a share of its size: every kind fits the unit circle, an arch's corners lie further out. */
const reachOf = (kind: ShapeKind) => (kind === "arch" ? 0.71 : 0.5);

/** Whether the circle a shape fits in touches a rectangle. */
export function shapeTouches(shape: Pick<PlacedShape, "kind" | "cx" | "cy" | "size">, a: Rect): boolean {
  const dx = Math.max(a.x - shape.cx, 0, shape.cx - (a.x + a.w));
  const dy = Math.max(a.y - shape.cy, 0, shape.cy - (a.y + a.h));
  const r = shape.size * reachOf(shape.kind);
  return dx * dx + dy * dy < r * r;
}

function fillFor(rng: Rng, colors: readonly string[], i: number): Fill {
  const from = colors[i % colors.length];
  const to = colors[(i + 1 + Math.floor(rng() * (colors.length - 1))) % colors.length];
  const roll = rng();
  if (roll < 0.4) return { type: "solid", color: from };
  if (roll < 0.75) return { type: "linear", from, to, angle: Math.floor(rng() * 360) };
  return { type: "radial", from, to };
}

/**
 * 3-6 shapes for a w*h card. One or two are glows: big, blurred and faint (at
 * most UNDER_TEXT_OPACITY, so text on top of them stays readable wherever they
 * are). The others are crisp and vivid, along the edges; each is put where it
 * reaches the fewest `avoid` zones (the title, the highlight line...), and a
 * shape that still reaches one is drawn faint instead.
 */
export function composeBackground(rng: Rng, palette: ShapePalette, w: number, h: number, avoid: readonly Rect[] = []): PlacedShape[] {
  const count = intBetween(rng, MIN_SHAPES, MAX_SHAPES);
  const glowCount = rng() < 0.5 ? 1 : 2;
  // Colours in a shuffled order so neighbours differ.
  const colors = [...palette.shapes].sort(() => rng() - 0.5);
  const out: PlacedShape[] = [];
  for (let i = 0; i < count; i++) {
    const glow = i < glowCount;
    const kind = glow ? pick(rng, ["blob", "blob", "flower", "seal", "burst"] as const) : pick(rng, SHAPE_KINDS);
    const size = (glow ? between(rng, 0.9, 1.3) : between(rng, 0.3, 0.6)) * w;
    // Along an edge, the centre a little inside or outside the card. Of a few tries the one that
    // reaches the fewest text areas is kept.
    const spot = () => {
      const side = Math.floor(rng() * 4);
      const along = rng();
      const depth = glow ? between(rng, -0.1, 0.3) : between(rng, 0.0, 0.2);
      return { cx: side < 2 ? (side === 0 ? depth * w : (1 - depth) * w) : along * w, cy: side < 2 ? along * h : side === 2 ? depth * w : h - depth * w };
    };
    const reached = (at: { cx: number; cy: number }) => avoid.filter((a) => shapeTouches({ kind, size, ...at }, a)).length;
    let { cx, cy } = spot();
    let fewest = glow ? 0 : reached({ cx, cy });
    for (let t = 1; t < TRIES && fewest > 0; t++) {
      const at = spot();
      const n = reached(at);
      if (n < fewest) {
        ({ cx, cy } = at);
        fewest = n;
      }
    }
    out.push({
      kind,
      d: buildShape(kind, rng),
      cx,
      cy,
      size,
      rotate: Math.floor(rng() * 360),
      fill: fillFor(rng, colors, i),
      opacity: glow ? UNDER_TEXT_OPACITY : fewest > 0 ? UNDER_TEXT_OPACITY : between(rng, 0.9, 1),
      blur: glow ? Math.round(between(rng, 0.05, 0.1) * w) : rng() < 0.15 ? Math.round(0.012 * w) : 0,
    });
  }
  return out;
}
// ---- SVG --------------------------------------------------------------------------------------

/** "#rrggbb" as 0..1 channels, for the grain's colour matrix. */
function channels(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

/**
 * The background as an SVG document: the card colour, the placed shapes (the
 * gradients and blurs defined once in <defs>) and a grain layer on top
 * (fractal noise turned into alpha and drawn faintly). Ids are prefixed with the
 * seed, so several backgrounds can share one page.
 */
export function backgroundSvg(shapes: readonly PlacedShape[], palette: ShapePalette, w: number, h: number, seed: number): string {
  const id = `wb${seed.toString(36)}`;
  const defs: string[] = [];
  const body: string[] = [];
  shapes.forEach((s, i) => {
    let fill: string;
    if (s.fill.type === "solid") fill = s.fill.color;
    else {
      fill = `url(#${id}g${i})`;
      const stops = `<stop offset="0" stop-color="${s.fill.from}"/><stop offset="1" stop-color="${s.fill.to}"/>`;
      if (s.fill.type === "linear") {
        const a = (s.fill.angle * Math.PI) / 180;
        const dx = Math.cos(a) / 2;
        const dy = Math.sin(a) / 2;
        defs.push(`<linearGradient id="${id}g${i}" x1="${n(0.5 - dx)}" y1="${n(0.5 - dy)}" x2="${n(0.5 + dx)}" y2="${n(0.5 + dy)}">${stops}</linearGradient>`);
      } else {
        defs.push(`<radialGradient id="${id}g${i}" cx=".35" cy=".3" r=".8">${stops}</radialGradient>`);
      }
    }
    if (s.blur) defs.push(`<filter id="${id}b${i}" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="${s.blur}"/></filter>`);
    const filter = s.blur ? ` filter="url(#${id}b${i})"` : "";
    body.push(
      `<g transform="translate(${n(s.cx)} ${n(s.cy)}) rotate(${s.rotate}) scale(${n(s.size)}) translate(-.5 -.5)" opacity="${n(s.opacity)}"${filter}><path d="${s.d}" fill="${fill}"/></g>`,
    );
  });
  const [r, g, b] = channels(palette.grain);
  defs.push(
    `<filter id="${id}n" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="3" stitchTiles="stitch"/>` +
      `<feColorMatrix type="matrix" values="0 0 0 0 ${n(r)} 0 0 0 0 ${n(g)} 0 0 0 0 ${n(b)} 1.3 0 0 0 -0.4"/></filter>`,
  );
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">` +
    `<defs>${defs.join("")}</defs>` +
    `<rect width="${w}" height="${h}" fill="${palette.bg}"/>` +
    body.join("") +
    `<rect width="${w}" height="${h}" filter="url(#${id}n)" opacity=".11"/>` +
    `</svg>`
  );
}

/** A whole background, from a seed: the one call the cards make. */
export function generateBackground(seed: number, palette: ShapePalette, w: number, h: number, avoid: readonly Rect[] = []): string {
  return backgroundSvg(composeBackground(mulberry32(seed), palette, w, h, avoid), palette, w, h, seed);
}
