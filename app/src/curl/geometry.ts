/**
 * Page-curl geometry: the turning sheet wraps around a cylinder.
 *
 * Everything is in "sheet coordinates": origin at the top of the spine, x
 * growing away from the spine across the sheet, so the sheet is the rectangle
 * [0, W] × [0, H]. The reader grabs sheet point G and holds it at F (F.x < 0
 * means it has been carried across the spine).
 *
 * The fold axis is perpendicular to u = (F − G)/|F − G|. For a sheet point P,
 * n = (P − G)·u. Points with n ≥ a stay flat; a point d = a − n past the axis
 * rolls onto a cylinder of radius R:
 *   d < πR : n' = a − R·sin(d/R)   (z = R(1 − cos(d/R)))
 *   d ≥ πR : n' = a + (d − πR)     (lying flat on top, mirrored)
 * and moves to P + u·(n' − n). `a` is solved so that G lands exactly on F.
 */

export interface Vec {
  x: number;
  y: number;
}

export interface Curl {
  G: Vec;
  u: Vec;
  /** Distance from G to the fold axis along u. */
  a: number;
  /** Cylinder radius. */
  R: number;
  /** The (possibly clamped) finger position. */
  F: Vec;
}

const PI = Math.PI;

export const mirror = (p: Vec): Vec => ({ x: -p.x, y: p.y });
const dist = (p: Vec, q: Vec) => Math.hypot(p.x - q.x, p.y - q.y);

/** Axis distance so the grabbed point travels `s` along u for radius R. */
export function axisFor(s: number, R: number): number {
  if (s <= 0) return 0;
  if (R <= 1e-6) return s / 2;
  if (s >= PI * R) return (s + PI * R) / 2;
  let lo = 0;
  let hi = PI * R;
  for (let i = 0; i < 40; i++) {
    const m = (lo + hi) / 2;
    if (m - R * Math.sin(m / R) < s) lo = m;
    else hi = m;
  }
  return (lo + hi) / 2;
}

/**
 * Paper is bound at the spine and cannot stretch: the grabbed point can never
 * be farther from either spine corner than it is on the flat sheet.
 */
function clampFinger(G: Vec, F: Vec, H: number): Vec {
  const corners = [
    { x: 0, y: 0 },
    { x: 0, y: H },
  ];
  const r = corners.map((c) => dist(G, c));
  const ok = (p: Vec, k: number) => dist(p, corners[k]) <= r[k] + 1e-6;
  if (ok(F, 0) && ok(F, 1)) return F;
  const cands: Vec[] = [G, mirror(G)];
  for (const k of [0, 1]) {
    const c = corners[k];
    const d = dist(F, c);
    if (d < 1e-9 || ok(F, k)) continue;
    const p = { x: c.x + ((F.x - c.x) * r[k]) / d, y: c.y + ((F.y - c.y) * r[k]) / d };
    if (ok(p, 1 - k)) cands.push(p);
  }
  let best = cands[0];
  for (const c of cands) if (dist(F, c) < dist(F, best)) best = c;
  return best;
}

/** Radius: tighter for short pulls and as the sheet nears its landing spot. */
function radiusFor(s: number, G: Vec, F: Vec, W: number): number {
  const pull = 0.4 + 0.6 * Math.min(1, s / (0.5 * W));
  const land = Math.min(1, dist(F, mirror(G)) / (0.6 * W));
  return 0.11 * W * pull * land;
}

export function solveCurl(G: Vec, Fin: Vec, W: number, H: number): Curl {
  const F = clampFinger(G, Fin, H);
  const dx = F.x - G.x;
  const dy = F.y - G.y;
  const s = Math.hypot(dx, dy);
  if (s < 0.01) return { G, u: { x: -1, y: 0 }, a: 0, R: radiusFor(0, G, F, W), F };
  const u = { x: dx / s, y: dy / s };
  // The axis must not pass the spine corners (they stay on the flat side).
  const lim = Math.min(-G.x * u.x - G.y * u.y, -G.x * u.x + (H - G.y) * u.y);
  let R = radiusFor(s, G, F, W);
  if (axisFor(s, R) > lim) {
    let lo = 0;
    let hi = R;
    for (let i = 0; i < 30; i++) {
      const m = (lo + hi) / 2;
      if (axisFor(s, m) <= lim) lo = m;
      else hi = m;
    }
    R = lo;
  }
  const a = Math.max(0, Math.min(lim, axisFor(s, R)));
  return { G, u, a, R, F };
}

/** n-coordinate of a sheet point. */
export const nOf = (c: Curl, p: Vec) => (p.x - c.G.x) * c.u.x + (p.y - c.G.y) * c.u.y;

/**
 * Clip the sheet rectangle to the band lo ≤ n ≤ hi (Sutherland–Hodgman).
 * Use ±Infinity for an open side.
 */
export function clipBand(W: number, H: number, c: Curl, lo: number, hi: number): Vec[] {
  let poly: Vec[] = [
    { x: 0, y: 0 },
    { x: W, y: 0 },
    { x: W, y: H },
    { x: 0, y: H },
  ];
  for (const [sign, bound] of [
    [1, lo],
    [-1, hi],
  ] as const) {
    if (!Number.isFinite(bound)) continue;
    const out: Vec[] = [];
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i];
      const q = poly[(i + 1) % poly.length];
      const dp = sign * (nOf(c, p) - bound);
      const dq = sign * (nOf(c, q) - bound);
      if (dp >= 0) out.push(p);
      if (dp >= 0 !== dq >= 0) {
        const t = dp / (dp - dq);
        out.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
      }
    }
    poly = out;
    if (poly.length < 3) return [];
  }
  return poly;
}

/**
 * Affine map (as a DOMMatrix 2D tuple a,b,c,d,e,f) that sends a sheet point
 * with coordinate n to n' = c0 + k·(n − n0), moving only along u.
 */
export function bandMatrix(c: Curl, n0: number, c0: number, k: number): DOMMatrix {
  const { u, G } = c;
  const m = k - 1;
  const t = c0 - k * n0 - m * (G.x * u.x + G.y * u.y);
  return new DOMMatrix([1 + m * u.x * u.x, m * u.x * u.y, m * u.x * u.y, 1 + m * u.y * u.y, u.x * t, u.y * t]);
}

/** Largest distance past the axis of any sheet point (how much is rolled). */
export function maxRolled(c: Curl, W: number, H: number): number {
  const ns = [
    { x: 0, y: 0 },
    { x: W, y: 0 },
    { x: W, y: H },
    { x: 0, y: H },
  ].map((p) => nOf(c, p));
  return c.a - Math.min(...ns);
}

// Android GPU path: identical solver with reusable output storage.
function clampFingerInto(G: Vec, F: Vec, H: number, out: Vec): Vec {
  const r0 = Math.hypot(G.x, G.y), r1 = Math.hypot(G.x, G.y-H);
  out.x = F.x; out.y = F.y;
  if (Math.hypot(F.x,F.y) <= r0+1e-6 && Math.hypot(F.x,F.y-H) <= r1+1e-6) return out;
  out.x = G.x; out.y = G.y;
  let best = Math.hypot(F.x-G.x,F.y-G.y);
  const mirrored = Math.hypot(F.x+G.x,F.y-G.y);
  if (mirrored < best) { out.x = -G.x; best = mirrored; }
  for (let k = 0; k < 2; k++) {
    const cy = k ? H : 0, radius = k ? r1 : r0;
    const d = Math.hypot(F.x,F.y-cy);
    if (d < 1e-9 || d <= radius+1e-6) continue;
    const x = F.x*radius/d, y = cy+(F.y-cy)*radius/d;
    if (Math.hypot(x,y-(k ? 0 : H)) > (k ? r0 : r1)+1e-6) continue;
    const distance = Math.hypot(F.x-x,F.y-y);
    if (distance < best) { out.x=x; out.y=y; best=distance; }
  }
  return out;
}
function radiusForInto(s: number, G: Vec, F: Vec, W: number): number {
  const pull = 0.4 + 0.6 * Math.min(1, s / (0.5 * W));
  const land = Math.min(1, Math.hypot(F.x + G.x, F.y - G.y) / (0.6 * W));
  return 0.11 * W * pull * land;
}
/** Supply an output object for allocation-free GPU frames. */
export function solveCurlInto(G: Vec, Fin: Vec, W: number, H: number, out: Curl): Curl {
  const result = out;
  const F = clampFingerInto(G, Fin, H, result.F);
  result.G = G;
  const dx = F.x - G.x;
  const dy = F.y - G.y;
  const s = Math.hypot(dx, dy);
  if (s < 0.01) {
    result.u.x=-1; result.u.y=0; result.a=0; result.R=radiusForInto(0,G,F,W);
    return result;
  }
  const u = result.u;
  u.x=dx/s; u.y=dy/s;
  // The axis must not pass the spine corners (they stay on the flat side).
  const lim = Math.min(-G.x * u.x - G.y * u.y, -G.x * u.x + (H - G.y) * u.y);
  let R = radiusForInto(s, G, F, W);
  if (axisFor(s, R) > lim) {
    let lo = 0;
    let hi = R;
    for (let i = 0; i < 30; i++) {
      const m = (lo + hi) / 2;
      if (axisFor(s, m) <= lim) lo = m;
      else hi = m;
    }
    R = lo;
  }
  const a = Math.max(0, Math.min(lim, axisFor(s, R)));
  result.a=a; result.R=R;
  return result;
}
