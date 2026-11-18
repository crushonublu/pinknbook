/**
 * Canvas 2D renderer for the page curl.
 *
 * All textures are prepared in sheet coordinates (see geometry.ts), so the
 * renderer only needs one base transform: translate to the spine and mirror
 * with `m = ±1` (m = −1 turns a left-hand page). The rolled part is drawn as
 * thin strips, each an affine squash of the texture along u, which closely
 * approximates the cylinder projection.
 */
import {
  bandMatrix,
  clipBand,
  maxRolled,
  mirror,
  type Curl,
  type Vec,
} from "./geometry";

export interface Scene {
  /** Page size in CSS px (sheet coordinates). */
  W: number;
  H: number;
  /** Spine x in canvas CSS px; m = 1 sheet lies right of the spine, −1 left. */
  spine: number;
  m: 1 | -1;
  /** Two-page spread: the page opposite the sheet stays visible. */
  spread: boolean;
  front: CanvasImageSource;
  back: CanvasImageSource;
  under: CanvasImageSource;
  /** Opposite page, drawn at sheet x ∈ [−W, 0] (spread only). */
  opposite?: CanvasImageSource;
  paper: string;
  dpr: number;
}

const PI = Math.PI;
const SEAM = 0.6;

const darkCache = new Map<string, boolean>();
/** Is this CSS colour a dark paper? (relative luminance below ~0.35) */
function isDark(color: string): boolean {
  let v = darkCache.get(color);
  if (v === undefined) {
    const m = color.match(/[\d.]+/g)?.map(Number) ?? [255, 255, 255];
    const [r, g, b] = m.map((x) => x / 255);
    v = 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.35;
    darkCache.set(color, v);
  }
  return v;
}

function path(ctx: CanvasRenderingContext2D, poly: Vec[]) {
  ctx.moveTo(poly[0].x, poly[0].y);
  for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y);
  ctx.closePath();
}

const apply = (m: DOMMatrix, p: Vec): Vec => ({
  x: m.a * p.x + m.c * p.y + m.e,
  y: m.b * p.x + m.d * p.y + m.f,
});

/** Soft shadow either side of the spine, scaled by `k` (0 … 1). */
function gutter(ctx: CanvasRenderingContext2D, s: Scene, k: number) {
  if (k <= 0.01) return;
  const w = s.W * 0.08;
  for (const side of [-1, 1]) {
    if (!s.spread && side < 0) continue;
    const g = ctx.createLinearGradient(0, 0, side * w, 0);
    for (let i = 0; i <= 8; i++) {
      const t = i / 8;
      g.addColorStop(t, `rgba(0,0,0,${(0.22 * k * Math.exp(-4 * t) * (1 - t)).toFixed(4)})`);
    }
    ctx.fillStyle = g;
    ctx.fillRect(side < 0 ? -w : 0, 0, w, s.H);
  }
}

export function baseMatrix(s: Scene): DOMMatrix {
  return new DOMMatrix([s.dpr * s.m, 0, 0, s.dpr, s.dpr * s.spine, 0]);
}

export function drawCurl(ctx: CanvasRenderingContext2D, s: Scene, c: Curl) {
  const { W, H } = s;
  const base = baseMatrix(s);
  const cv = ctx.canvas;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.save();
  ctx.setTransform(base);
  // A single page has nothing beyond the spine: the sheet slides off there.
  ctx.beginPath();
  if (s.spread) ctx.rect(-W, -H, 2 * W, 3 * H);
  else ctx.rect(0, -H, W * 2, 3 * H);
  ctx.clip();

  if (s.spread && s.opposite) ctx.drawImage(s.opposite, -W, 0, W, H);
  ctx.drawImage(s.under, 0, 0, W, H);

  const { a, R, u, G } = c;
  // 1 while the sheet is mid-turn, fading to 0 as it lands on the far side.
  const show = Math.min(1, Math.hypot(c.F.x - mirror(G).x, c.F.y - G.y) / (0.3 * W));
  const lift = Math.min(1, a / (0.04 * W));
  const at = (n: number): Vec => ({ x: G.x + u.x * n, y: G.y + u.y * n });
  const toward = (p: Vec, len: number) => ctx.createLinearGradient(p.x, p.y, p.x - u.x * len, p.y - u.y * len);

  if (a <= 0.5) {
    ctx.drawImage(s.front, 0, 0, W, H);
    ctx.restore();
    return;
  }

  const dark = isDark(s.paper);
  const rolled = Math.min(maxRolled(c, W, H), PI * R);
  // Outermost reach of the curl over the page beneath.
  const edge = a - R * Math.sin(Math.min(rolled / Math.max(R, 1e-6), PI / 2));

  // 1. Shadow the curl casts on the page underneath.
  {
    const poly = clipBand(W, H, c, -Infinity, edge);
    if (poly.length) {
      const len = (0.035 * W + 0.4 * R) * 3;
      const g = toward(at(edge), len);
      for (let i = 0; i <= 6; i++) {
        const t = i / 6;
        g.addColorStop(t, `rgba(0,0,0,${(0.32 * lift * show * Math.exp(-3 * t)).toFixed(4)})`);
      }
      ctx.beginPath();
      path(ctx, poly);
      ctx.fillStyle = g;
      ctx.fill();
    }
  }

  // 2. The part of the sheet that is still flat.
  {
    const poly = clipBand(W, H, c, a, Infinity);
    if (poly.length) {
      ctx.save();
      ctx.beginPath();
      path(ctx, poly);
      ctx.clip();
      ctx.drawImage(s.front, 0, 0, W, H);
      ctx.restore();
    }
  }
  gutter(ctx, s, Math.sin(PI * Math.min(1, Math.max(0, (G.x - c.F.x) / (2 * G.x)))) * lift);

  // 3. The rolled part: front quarter (facing up) then back quarter.
  const strips = Math.max(4, Math.min(28, Math.ceil((PI * R) / 2 / 2.5)));
  const roll = (d: number) => a - R * Math.sin(d / R);
  for (const half of [0, 1]) {
    const from = half ? PI / 2 : 0;
    if (R < 1e-6 || rolled / R <= from) continue;
    const polys: Vec[][] = [];
    for (let i = 0; i < strips; i++) {
      const d0 = R * (from + (i / strips) * (PI / 2));
      if (d0 >= rolled) break;
      const d1 = Math.min(R * (from + ((i + 1) / strips) * (PI / 2)), rolled);
      const k = d1 - d0 > 1e-6 ? (roll(d0) - roll(d1)) / (d1 - d0) : 1;
      const M = bandMatrix(c, a - d0, roll(d0), k);
      const band = clipBand(W, H, c, a - d1 - SEAM, a - d0 + SEAM);
      if (!band.length) continue;
      const poly = band.map((p) => apply(M, p));
      polys.push(clipBand(W, H, c, a - d1, a - d0).map((p) => apply(M, p)));
      ctx.save();
      ctx.beginPath();
      path(ctx, poly);
      ctx.clip();
      ctx.setTransform(base.multiply(M));
      ctx.drawImage(half ? s.back : s.front, 0, 0, W, H);
      ctx.restore();
    }
    // Cylinder shading: darker where the surface turns away from the viewer.
    const shapes = polys.filter((p) => p.length);
    if (shapes.length) {
      const g = toward(at(a), R);
      for (let i = 0; i <= 12; i++) {
        const t = i / 12;
        const shade = (half ? 0.18 : 0.34) * (1 - Math.sqrt(1 - t * t));
        g.addColorStop(t, `rgba(0,0,0,${shade.toFixed(4)})`);
      }
      ctx.beginPath();
      for (const p of shapes) path(ctx, p);
      ctx.fillStyle = g;
      ctx.fill("nonzero");
      if (dark) {
        // Shadows vanish on dark paper: light the rim of the roll instead.
        const h = toward(at(a), R);
        h.addColorStop(0, `rgba(255,255,255,${half ? 0.07 : 0})`);
        h.addColorStop(0.7, `rgba(255,255,255,${half ? 0.03 : 0})`);
        h.addColorStop(0.92, `rgba(255,255,255,${half ? 0.1 : 0.06})`);
        h.addColorStop(1, `rgba(255,255,255,${half ? 0.16 : 0.1})`);
        ctx.fillStyle = h;
        ctx.fill("nonzero");
      }
    }
  }

  // 4. The part already carried over the roll, lying flat and mirrored.
  if (maxRolled(c, W, H) > PI * R) {
    const M = bandMatrix(c, 0, 2 * a - PI * R, -1);
    const flat = clipBand(W, H, c, -Infinity, a - PI * R);
    if (flat.length) {
      const poly = flat.map((p) => apply(M, p));
      ctx.save();
      // The turned-over part lies flat on the page, so it only casts a thin
      // contact shadow along its edges. A wide, downward-offset blur (as
      // before) filled the sliver between its lower edge and the foot of the
      // page and read as a grey band along the page edge. Keep it inside the
      // page(s) too: there is no paper beyond them to fall on.
      ctx.beginPath();
      if (s.spread) ctx.rect(-W, 0, 2 * W, H);
      else ctx.rect(0, 0, W, H);
      ctx.clip();
      ctx.beginPath();
      path(ctx, poly);
      ctx.shadowColor = `rgba(0,0,0,${(0.2 * show).toFixed(3)})`;
      ctx.shadowBlur = Math.min(8, 0.012 * W) * s.dpr;
      ctx.shadowOffsetY = 0;
      ctx.fillStyle = s.paper;
      ctx.fill();
      ctx.restore();
      ctx.save();
      ctx.beginPath();
      path(ctx, clipBand(W, H, c, -Infinity, a - PI * R + SEAM).map((p) => apply(M, p)));
      ctx.clip();
      ctx.setTransform(base.multiply(M));
      ctx.drawImage(s.back, 0, 0, W, H);
      ctx.restore();
      if (dark) {
        // Shadows vanish on dark paper, so lift the whole turned-over part a
        // touch (close to the 0.07 the roll's back has where they meet)
        // instead of outlining it: a 1 px white outline read as a stray
        // diagonal line across the page.
        ctx.beginPath();
        path(ctx, poly);
        ctx.fillStyle = `rgba(255,255,255,${(0.06 * show).toFixed(3)})`;
        ctx.fill();
      }
    }
  }
  ctx.restore();
}

/** Copy a region of `src` (CSS px, at dpr) into a W×H canvas, optionally mirrored. */
export function pageTexture(
  src: HTMLCanvasElement,
  sx: number,
  W: number,
  H: number,
  dpr: number,
  flip: boolean,
): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = Math.round(W * dpr);
  c.height = Math.round(H * dpr);
  const ctx = c.getContext("2d")!;
  if (flip) ctx.setTransform(-1, 0, 0, 1, c.width, 0);
  ctx.drawImage(src, Math.round(sx * dpr), 0, c.width, c.height, 0, 0, c.width, c.height);
  return c;
}

/**
 * Back face of a sheet: the page printed on the back (spread, so the sheet
 * lands showing the new left page), or — single page, like iBooks — paper with
 * the front's ink bleeding through. The texture is in sheet coordinates and
 * the curl mirrors it, so the bled text reads reversed as on real paper. The
 * bleed is faint and slightly soft so it reads as ink through paper rather
 * than as a second, glitched copy of the page.
 */
export function backTexture(
  front: HTMLCanvasElement,
  back: HTMLCanvasElement | null,
  paper: string,
): HTMLCanvasElement {
  if (back) return back;
  const c = document.createElement("canvas");
  c.width = front.width;
  c.height = front.height;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = paper;
  ctx.fillRect(0, 0, c.width, c.height);
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  ctx.globalAlpha = isDark(paper) ? 0.2 : 0.32;
  ctx.filter = `blur(${(0.6 * dpr).toFixed(2)}px)`;
  ctx.drawImage(front, 0, 0);
  ctx.filter = "none";
  ctx.globalAlpha = 1;
  return c;
}
