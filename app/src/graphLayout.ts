/**
 * Pure helpers for the relationship map: what kind of tie a label names,
 * where the people go, and where labels fit without covering anything.
 */

export type RelKind = "family" | "love" | "conflict" | "social" | "same" | "none";
/** Legend order; "same" only shows up when the AI flagged a duplicate. */
export const KIND_ORDER: RelKind[] = ["family", "love", "conflict", "social", "none"];

const phrase = (words: string) =>
  new RegExp(`(^|[^\\p{L}])(${words.split("|").map((w) => w.trim()).join("|")})(?=$|[^\\p{L}])`, "iu");

/** The whole label says the two names are one person (labels are merged on this, so it must be strict). */
const SAME =
  /^(?:(?:là |cũng là )?(?:cùng là|cùng|chính là|là) (?:một|1) người(?: duy nhất)?|tên khác|tên gọi khác|biệt danh|(?:the )?same (?:person|character)|one and the same(?: person)?|alias|nickname)$/iu;
const LOVE = phrase(
  "người yêu|tình nhân|nhân tình|yêu|tình cũ|ngoại tình|hôn phu|hôn thê|si mê|thầm yêu|tình địch|lovers|lover|love|in love|affair|sweetheart|fiancé|fiancée|fiance|mistress|romance",
);
const CONFLICT = phrase(
  "thù|kẻ thù|đối thủ|đối địch|đánh|đánh nhau|trộm|kẻ trộm|giết|kẻ giết|hại|bị hại|ghét|căm|căm ghét|mâu thuẫn|xung đột|tố cáo|lừa|lừa đảo|phản bội|bắt nạt|đe dọa|đe doạ|cướp|nạn nhân|" +
    "enemy|enemies|rival|rivals|thief|killer|murderer|victim|hate|hatred|conflict|betray|betrayed|bully|threat|feud",
);
const FAMILY = phrase(
  "vợ|chồng|cha|mẹ|bố|má|con trai|con gái|con ruột|con nuôi|anh|chị|em|chú|bác|dì|cậu|mợ|thím|cháu|ông nội|bà nội|ông ngoại|bà ngoại|" +
    "họ hàng|anh họ|em họ|chị họ|dâu|rể|thông gia|gia đình|bà con|ruột|mẹ kế|cha kế|bố dượng|cha nuôi|mẹ nuôi|anh em|chị em|" +
    "husband|wife|father|mother|son|daughter|brother|brothers|sister|sisters|uncle|aunt|nephew|niece|cousin|cousins|" +
    "grandfather|grandmother|grandson|granddaughter|in-law|family|parent|child|siblings|spouse|stepmother|stepfather",
);

/** The kind of tie a label names (labels are free text from the reader or the AI). */
export function relKind(label: string | null | undefined): RelKind {
  if (!label) return "none";
  const s = label.toLowerCase();
  const bare = s.replace(/\s*\([^)]*\)\s*$/, "").replace(/[.!]+$/, "").trim();
  if (SAME.test(bare)) return "same";
  if (LOVE.test(s)) return "love";
  if (CONFLICT.test(s)) return "conflict";
  if (FAMILY.test(s)) return "family";
  return "social";
}

/** A label short enough for a chip: no trailing "(A – B)", at most `max` characters. */
export function shortLabel(label: string, max = 26): string {
  const s = label.replace(/\s*\([^)]*\)\s*$/, "").trim() || label.trim();
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}

/** One or two letters for a person's disc ("Lý Tam Nhân" → "LN", "Tom" → "T"). */
export function initials(name: string): string {
  const w = name.split(/\s+/).filter(Boolean);
  if (!w.length) return "?";
  const first = w[0][0];
  return (w.length > 1 ? first + w[w.length - 1][0] : first).toUpperCase();
}

// ---- Layout -------------------------------------------------------------------

export interface GNode {
  key: string;
  /** Disc radius. */
  r: number;
  /** Width of the name under the disc. */
  w: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export interface GEdge {
  a: number;
  b: number;
  /** Strength 0–1 (how often the two appear together, relative to the strongest). */
  s: number;
}

/** Room a person takes: the disc, or the name under it if wider. */
const reach = (n: GNode) => Math.max(n.r + 12, n.w / 2 + 10);

/**
 * Place people with a small force simulation: strong ties pull close, everyone
 * pushes everyone away, nobody overlaps a name. Starts from `prev` positions
 * when given (so changing the count does not reshuffle the map). Deterministic.
 */
export function layout(nodes: GNode[], edges: GEdge[], prev?: Map<string, { x: number; y: number }>) {
  const n = nodes.length;
  if (!n) return;
  const deg = new Array(n).fill(0);
  const adj: number[][] = nodes.map(() => []);
  for (const e of edges) {
    deg[e.a] += 1;
    deg[e.b] += 1;
    adj[e.a].push(e.b);
    adj[e.b].push(e.a);
  }

  // Start: kept positions, else the best-connected first in the middle and
  // each next one beside the people it knows, on a golden-angle spiral.
  const order = nodes.map((_, i) => i).sort((a, b) => deg[b] - deg[a] || nodes[b].r - nodes[a].r);
  const placed = new Set<number>();
  let warm = 0;
  for (const i of order) {
    const p = prev?.get(nodes[i].key);
    if (p) {
      nodes[i].x = p.x;
      nodes[i].y = p.y;
      placed.add(i);
      warm++;
    }
  }
  const golden = Math.PI * (3 - Math.sqrt(5));
  order.forEach((i, k) => {
    if (placed.has(i)) return;
    const near = adj[i].filter((j) => placed.has(j));
    const a = k * golden;
    if (near.length) {
      const cx = near.reduce((s, j) => s + nodes[j].x, 0) / near.length;
      const cy = near.reduce((s, j) => s + nodes[j].y, 0) / near.length;
      nodes[i].x = cx + Math.cos(a) * 90;
      nodes[i].y = cy + Math.sin(a) * 90;
    } else {
      const rad = 70 * Math.sqrt(k + 0.5);
      nodes[i].x = Math.cos(a) * rad;
      nodes[i].y = Math.sin(a) * rad;
    }
    nodes[i].vx = 0;
    nodes[i].vy = 0;
    placed.add(i);
  });

  const charge = 2600;
  let alpha = warm > n / 2 ? 0.35 : 1;
  const decay = 1 - Math.pow(0.001, 1 / 320);
  for (let tick = 0; tick < 600 && alpha > 0.002; tick++) {
    // Everyone pushes everyone away (weaker with distance).
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = nodes[j].x - nodes[i].x;
        let dy = nodes[j].y - nodes[i].y;
        let d2 = dx * dx + dy * dy;
        // Far apart: no push, so loners do not drift off.
        if (d2 > 420 * 420) continue;
        if (d2 < 1) {
          dx = ((i * 7 + j * 13) % 11) - 5 || 1;
          dy = ((i * 5 + j * 3) % 7) - 3 || 1;
          d2 = dx * dx + dy * dy;
        }
        const f = (charge * alpha) / d2;
        nodes[i].vx -= dx * f;
        nodes[i].vy -= dy * f;
        nodes[j].vx += dx * f;
        nodes[j].vy += dy * f;
      }
    }
    // Ties pull towards a rest length: stronger ties sit closer.
    for (const e of edges) {
      const A = nodes[e.a];
      const B = nodes[e.b];
      const dx = B.x + B.vx - A.x - A.vx;
      const dy = B.y + B.vy - A.y - A.vy;
      const d = Math.max(1, Math.hypot(dx, dy));
      const rest = reach(A) + reach(B) + 70 - 45 * e.s;
      const k = ((d - rest) / d) * alpha * (0.35 + 0.4 * e.s) / Math.min(deg[e.a], deg[e.b]);
      const bias = deg[e.a] / (deg[e.a] + deg[e.b]);
      B.vx -= dx * k * bias;
      B.vy -= dy * k * bias;
      A.vx += dx * k * (1 - bias);
      A.vy += dy * k * (1 - bias);
    }
    // Gravity to the middle, a little stronger up and down (screens are wide).
    nodes.forEach((p, i) => {
      // People with no tie on the map are held closer, at the edge of the group.
      const g = deg[i] ? 1 : 3;
      p.vx -= p.x * 0.012 * g * alpha;
      p.vy -= p.y * 0.02 * g * alpha;
    });
    // Move, then keep names from overlapping.
    for (const p of nodes) {
      p.vx *= 0.55;
      p.vy *= 0.55;
      p.x += p.vx;
      p.y += p.vy;
    }
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const A = nodes[i];
        const B = nodes[j];
        const dx = B.x - A.x;
        const dy = B.y - A.y;
        const d = Math.hypot(dx, dy) || 1;
        const min = reach(A) + reach(B);
        if (d < min) {
          const push = ((min - d) / d) * 0.5;
          A.x -= dx * push;
          A.y -= dy * push;
          B.x += dx * push;
          B.y += dy * push;
        }
      }
    }
    alpha += (0 - alpha) * decay;
  }
}

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** The space a person takes on screen: disc plus name underneath. */
export function nodeBoxes(n: GNode): Box[] {
  return [
    { x0: n.x - n.r, y0: n.y - n.r, x1: n.x + n.r, y1: n.y + n.r },
    { x0: n.x - n.w / 2 - 2, y0: n.y + n.r + 3, x1: n.x + n.w / 2 + 2, y1: n.y + n.r + 21 },
  ];
}

export function bounds(nodes: GNode[]): Box {
  const b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const n of nodes)
    for (const c of nodeBoxes(n)) {
      b.x0 = Math.min(b.x0, c.x0);
      b.y0 = Math.min(b.y0, c.y0);
      b.x1 = Math.max(b.x1, c.x1);
      b.y1 = Math.max(b.y1, c.y1);
    }
  return b;
}

const hit = (a: Box, b: Box, pad = 3) => a.x0 - pad < b.x1 && b.x0 - pad < a.x1 && a.y0 - pad < b.y1 && b.y0 - pad < a.y1;

export interface LabelItem {
  key: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  w: number;
  h: number;
}

/**
 * Put each label on its line where it covers no person and no other label,
 * in the given order (most important first). Labels with no free spot are
 * left out unless `force`, where they take the least crowded spot.
 */
export function placeLabels(items: LabelItem[], obstacles: Box[], force = false): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  const taken: Box[] = [];
  for (const it of items) {
    let best: { x: number; y: number; box: Box; cost: number } | null = null;
    for (const t of [0.5, 0.4, 0.6, 0.3, 0.7, 0.22, 0.78]) {
      const x = it.x1 + (it.x2 - it.x1) * t;
      const y = it.y1 + (it.y2 - it.y1) * t;
      const box = { x0: x - it.w / 2, y0: y - it.h / 2, x1: x + it.w / 2, y1: y + it.h / 2 };
      const cost = obstacles.filter((o) => hit(box, o)).length * 2 + taken.filter((o) => hit(box, o)).length;
      if (!best || cost < best.cost) best = { x, y, box, cost };
      if (cost === 0) break;
    }
    if (best && (best.cost === 0 || force)) {
      out.set(it.key, { x: best.x, y: best.y });
      taken.push(best.box);
    }
  }
  return out;
}

// ---- Focus ring (phones) ------------------------------------------------------

/** One person around the one in focus. */
export interface RingNode {
  key: string;
  kind: RelKind;
  /** How strong the tie is (chunks together); stronger first within a kind. */
  strength: number;
  /** Width of the name under the disc (capped by the layout). */
  nameW: number;
  /** Width of the tie's label text, 0 for none. */
  labelW: number;
  /** Outer ring: the ring person this one hangs from (a tie of theirs, not of the focus). */
  via?: string;
}

export interface RBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RadialLayout {
  center: { x: number; y: number; r: number };
  nodes: { key: string; x: number; y: number; r: number; outer: boolean; via?: string; name: RBox }[];
  /**
   * Labels on the spokes (`key`: the person the spoke goes to); `short`: cut,
   * the full text shows on tap; `under`: no room on the spoke, so under the name.
   */
  labels: (RBox & { key: string; short: boolean; under?: boolean })[];
  /** Ring people left out (more than fit). */
  more: string[];
}

export const RING_MAX = 10;
const R_CENTER = 34;
const R_RING = 22;
const R_OUTER = 18;
const NAME_H = 16;
const NAME_MAX = 96;
const LABEL_H = 22;
const LABEL_PAD = 20;
const LABEL_SHORT = 56;

type Shape = RBox | { cx: number; cy: number; r: number };
/** Boxes and discs (a disc is round: a label may sit by its corner). */
const overlaps = (a: Shape, b: Shape, m = 2): boolean => {
  if ("cx" in a && "cx" in b) return Math.hypot(a.cx - b.cx, a.cy - b.cy) < a.r + b.r + m;
  if ("cx" in a) return overlaps(b, a, m);
  if (!("cx" in b)) return a.x < b.x + b.w + m && b.x < a.x + a.w + m && a.y < b.y + b.h + m && b.y < a.y + a.h + m;
  const nx = Math.max(a.x, Math.min(b.cx, a.x + a.w));
  const ny = Math.max(a.y, Math.min(b.cy, a.y + a.h));
  return Math.hypot(nx - b.cx, ny - b.cy) < b.r + m;
};
const disc = (x: number, y: number, r: number) => ({ cx: x, cy: y, r });

/**
 * Someone in the middle and their direct ties on an ellipse around them
 * (people with the same kind of tie side by side, the strongest first, from
 * the top, clockwise), and a few ties of those people outside. Labels sit on
 * the spokes about halfway out, moved along the spoke or cut short when they
 * would cover something. The same people always land in the same places.
 * `top` and `bottom` are kept free (header, card).
 */
export function radialLayout(w: number, h: number, ring: RingNode[], outer: RingNode[] = [], room: { top: number; bottom: number } = { top: 0, bottom: 0 }): RadialLayout {
  const order = (n: RingNode) => KIND_ORDER.indexOf(n.kind === "same" ? "none" : n.kind);
  const sorted = [...ring].sort((a, b) => order(a) - order(b) || b.strength - a.strength || (a.key < b.key ? -1 : 1));
  const shown = sorted.slice(0, RING_MAX);
  const more = sorted.slice(RING_MAX).map((n) => n.key);
  const top = room.top;
  const bottom = h - room.bottom;
  const cx = w / 2;
  const cy = (top + bottom) / 2;
  const rx = Math.max(80, w / 2 - NAME_MAX / 2 - 6);
  const ry = Math.max(80, Math.min((bottom - top) / 2 - R_RING - NAME_H - 12, rx * 1.4));

  const taken: Shape[] = [disc(cx, cy, R_CENTER + 2)];
  const nodes: RadialLayout["nodes"] = [];
  const nameBox = (x: number, y: number, r: number, nameW: number): RBox => {
    const nw = Math.min(nameW, NAME_MAX);
    return { x: Math.min(w - 2 - nw, Math.max(2, x - nw / 2)), y: y + r + 3, w: nw, h: NAME_H };
  };
  shown.forEach((n, i) => {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / Math.max(1, shown.length);
    // One person: straight up; two: up and down.
    const x = cx + rx * Math.cos(a);
    const y = cy + ry * Math.sin(a);
    const name = nameBox(x, y, R_RING, n.nameW);
    nodes.push({ key: n.key, x, y, r: R_RING, outer: false, name });
    taken.push(disc(x, y, R_RING), name);
  });

  // Ties of the ring people, outside them along the same spoke, where there is room.
  for (const o of outer) {
    const from = nodes.find((v) => v.key === o.via && !v.outer);
    if (!from || nodes.some((v) => v.key === o.key)) continue;
    const dx = from.x - cx;
    const dy = from.y - cy;
    const len = Math.hypot(dx, dy) || 1;
    const x = from.x + (dx / len) * 78;
    const y = from.y + (dy / len) * 78;
    const name = nameBox(x, y, R_OUTER, o.nameW);
    const me = disc(x, y, R_OUTER);
    if (x - R_OUTER < 2 || x + R_OUTER > w - 2 || y - R_OUTER < top || name.y + name.h > bottom) continue;
    if (taken.some((b) => overlaps(b, me) || overlaps(b, name))) continue;
    nodes.push({ key: o.key, x, y, r: R_OUTER, outer: true, via: o.via, name });
    taken.push(me, name);
  }

  // Labels: about halfway along each spoke, else a bit in or out, else cut short.
  const labels: RadialLayout["labels"] = [];
  const all = [...shown, ...outer];
  for (const v of nodes) {
    const n = all.find((m) => m.key === v.key);
    if (!n || !n.labelW) continue;
    const from = v.outer ? nodes.find((m) => m.key === v.via)! : { x: cx, y: cy };
    const spots = v.outer ? [0.5, 0.4, 0.6] : [0.55, 0.47, 0.63, 0.4, 0.7];
    // Beside the spoke too (above or below a level one), when on it there is no room.
    const len = Math.hypot(v.x - from.x, v.y - from.y) || 1;
    const px = -(v.y - from.y) / len;
    const py = (v.x - from.x) / len;
    const sides = [0, -1, 1];
    let placed: RadialLayout["labels"][number] | null = null;
    for (const short of [false, true]) {
      const lw = (short ? Math.min(n.labelW, LABEL_SHORT) : n.labelW) + LABEL_PAD;
      if (short && n.labelW <= LABEL_SHORT) break;
      for (const [t, side] of sides.flatMap((d) => spots.map((t) => [t, d] as const))) {
        const off = side * (LABEL_H / 2 + 3);
        const x = from.x + (v.x - from.x) * t + px * off;
        const y = from.y + (v.y - from.y) * t + py * off;
        const b = { x: x - lw / 2, y: y - LABEL_H / 2, w: lw, h: LABEL_H };
        if (b.x < 2 || b.x + b.w > w - 2 || b.y < top || b.y + b.h > bottom) continue;
        if (taken.some((o) => overlaps(o, b)) || labels.some((o) => overlaps(o, b))) continue;
        placed = { ...b, key: v.key, short };
        break;
      }
      if (placed) break;
    }
    // No room on the spoke: under the person's name.
    if (!placed) {
      for (const lw of [n.labelW + LABEL_PAD, Math.min(n.labelW, LABEL_SHORT) + LABEL_PAD]) {
        const b = { x: Math.min(w - 2 - lw, Math.max(2, v.x - lw / 2)), y: v.name.y + v.name.h + 1, w: lw, h: LABEL_H - 2 };
        if (b.y + b.h > bottom) break;
        if (taken.some((o) => o !== v.name && overlaps(o, b)) || labels.some((o) => overlaps(o, b))) continue;
        placed = { ...b, key: v.key, short: lw < n.labelW + LABEL_PAD, under: true };
        break;
      }
    }
    if (placed) labels.push(placed);
  }
  return { center: { x: cx, y: cy, r: R_CENTER }, nodes, labels, more };
}
