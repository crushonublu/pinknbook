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
