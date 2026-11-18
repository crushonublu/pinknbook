/**
 * Find text in a book. Matching ignores case; a query typed without
 * Vietnamese marks also ignores the marks in the book ("doc ly" finds
 * "Đốc lý"), while a query with marks must match them. Runs of white space
 * count as one space, and a match may cross inline tags ("Đốc <i>lý</i>").
 */

export interface SearchHit {
  /** Section index in the book. */
  index: number;
  cfi: string;
  /** Reading fraction of the match (0–1), for the progress bar. */
  fraction: number;
  pre: string;
  match: string;
  post: string;
}

const MARKS = /[̀-ͯ]/g;
const foldCache = new Map<string, string>();

/** One character without case or marks ("Ế" → "e", "đ" → "d"). */
function foldChar(c: string): string {
  if (c < "\u0080") return c.toLowerCase();
  let f = foldCache.get(c);
  if (f === undefined) {
    f = c.toLowerCase().normalize("NFD").replace(MARKS, "").replace(/đ/g, "d");
    foldCache.set(c, f);
  }
  return f;
}

const SPACE = /[\s  -​　]/;

/** The query in the form the book text is compared in, and which form that is. */
export function prepareQuery(q: string): { text: string; loose: boolean } | null {
  const lower = q.toLowerCase().replace(/\s+/g, " ").trim();
  if (!lower) return null;
  const folded = Array.from(lower, foldChar).join("");
  // No marks typed: compare without marks. Otherwise keep them.
  return folded === lower ? { text: folded, loose: true } : { text: lower, loose: false };
}

const SKIP = new Set(["script", "style", "head", "title", "svg", "math"]);

/** Every match of `query` in a section's document, as ranges with context. */
export function* findInDoc(doc: Document, query: { text: string; loose: boolean }) {
  const root = doc.body ?? doc.documentElement;
  const nodes: Text[] = [];
  const starts: number[] = [];
  let full = "";
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      SKIP.has((n.parentElement?.localName ?? "").toLowerCase()) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    nodes.push(n);
    starts.push(full.length);
    full += n.data;
  }
  if (!full) return;

  // The compared text, with where each of its characters came from.
  let cmp = "";
  const from: number[] = [];
  let lastSpace = true;
  for (let i = 0; i < full.length; i++) {
    const c = full[i];
    if (SPACE.test(c)) {
      if (!lastSpace) {
        cmp += " ";
        from.push(i);
      }
      lastSpace = true;
      continue;
    }
    lastSpace = false;
    const f = query.loose ? foldChar(c) : c.toLowerCase();
    for (let k = 0; k < f.length; k++) {
      cmp += f[k];
      from.push(i);
    }
  }

  const point = (offset: number): [Text, number] => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return [nodes[lo], Math.min(offset - starts[lo], nodes[lo].data.length)];
  };
  const q = query.text;
  for (let at = cmp.indexOf(q); at >= 0; at = cmp.indexOf(q, at + q.length)) {
    const s = from[at];
    const e = from[at + q.length - 1] + 1;
    const range = doc.createRange();
    const [sn, so] = point(s);
    const [en, eo] = point(e);
    try {
      range.setStart(sn, so);
      range.setEnd(en, eo);
    } catch {
      continue;
    }
    yield {
      range,
      offset: s,
      length: full.length,
      pre: excerpt(full.slice(Math.max(0, s - 60), s), true),
      match: full.slice(s, e).replace(/\s+/g, " "),
      post: excerpt(full.slice(e, e + 80), false),
    };
  }
}

/** Context around a match, cut at a word edge and with spaces tidied. */
function excerpt(s: string, before: boolean): string {
  let t = s.replace(/\s+/g, " ");
  if (before) {
    const cut = t.indexOf(" ");
    if (s.length >= 60 && cut > 0 && cut < 20) t = "…" + t.slice(cut + 1);
  } else {
    const cut = t.lastIndexOf(" ");
    if (s.length >= 80 && cut > 50) t = t.slice(0, cut) + "…";
  }
  return t;
}

export const MAX_HITS = 1000;

/**
 * Search the whole book section by section, reporting hits as they come.
 * Stops early when `signal` says so or after MAX_HITS.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function searchBook(
  view: any,
  raw: string,
  onHits: (hits: SearchHit[], progress: number) => void,
  signal: { cancelled: boolean },
): Promise<number> {
  const query = prepareQuery(raw);
  const sections = view?.book?.sections ?? [];
  if (!query || !sections.length) return 0;
  const fr: number[] = view.getSectionFractions?.() ?? [];
  let count = 0;
  for (let i = 0; i < sections.length; i++) {
    if (signal.cancelled) return count;
    if (!sections[i].createDocument) continue;
    let doc: Document;
    try {
      doc = await sections[i].createDocument();
    } catch {
      continue;
    }
    const f0 = fr[i] ?? i / sections.length;
    const f1 = fr[i + 1] ?? (i + 1) / sections.length;
    const hits: SearchHit[] = [];
    for (const m of findInDoc(doc, query)) {
      let cfi: string;
      try {
        cfi = view.getCFI(i, m.range);
      } catch {
        continue;
      }
      hits.push({
        index: i,
        cfi,
        fraction: f0 + (f1 - f0) * (m.length ? m.offset / m.length : 0),
        pre: m.pre,
        match: m.match,
        post: m.post,
      });
      if (count + hits.length >= MAX_HITS) break;
    }
    count += hits.length;
    if (signal.cancelled) return count;
    onHits(hits, (i + 1) / sections.length);
    if (count >= MAX_HITS) return count;
    // Let the page breathe between sections.
    await new Promise((r) => setTimeout(r, 0));
  }
  return count;
}

/** A light box behind every match; the chosen one is stronger and outlined. */
export function drawSearchHit(rects: DOMRectList | DOMRect[], opts: { current: boolean; dark: boolean }) {
  const SVG = "http://www.w3.org/2000/svg";
  const g = document.createElementNS(SVG, "g");
  const color = opts.dark ? "#f5c451" : "#f0a91e";
  g.setAttribute("fill", color);
  g.style.opacity = opts.current ? (opts.dark ? "0.5" : "0.55") : opts.dark ? "0.2" : "0.25";
  g.style.mixBlendMode = opts.dark ? "screen" : "multiply";
  for (const r of Array.from(rects)) {
    const el = document.createElementNS(SVG, "rect");
    el.setAttribute("x", String(r.left - 1));
    el.setAttribute("y", String(r.top));
    el.setAttribute("height", String(r.height));
    el.setAttribute("width", String(r.width + 2));
    el.setAttribute("rx", "3");
    if (opts.current) {
      el.setAttribute("stroke", color);
      el.setAttribute("stroke-width", "1.5");
    }
    g.append(el);
  }
  return g;
}
