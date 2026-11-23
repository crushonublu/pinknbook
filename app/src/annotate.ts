/** Highlights and notes in the reader: shared types and drawing. */

export type HighlightColor = "yellow" | "blue" | "pink" | "orange";
export const HIGHLIGHT_COLORS: HighlightColor[] = ["yellow", "blue", "pink", "orange"];

/** Kindle's four highlight colours. */
export const COLOR_HEX: Record<HighlightColor, string> = {
  yellow: "#f6d84a",
  blue: "#69b0f5",
  pink: "#f38dbb",
  orange: "#f6a443",
};

export interface Annotation {
  id: number;
  cfi: string;
  kstart: number | null;
  kend: number | null;
  fraction: number;
  color: HighlightColor;
  note: string | null;
  excerpt: string | null;
  chapter: string | null;
  created_at: string;
  synced: boolean;
  on_kindle: boolean;
}

/** A Kindle highlight the app does not have yet (from a pull). */
export interface KindleRecord {
  kind: string;
  start: number;
  end: number;
  color: HighlightColor | null;
  text: string | null;
}

const SVG = "http://www.w3.org/2000/svg";

/**
 * foliate overlayer draw function: a tinted box over each line, plus a
 * dotted underline when the highlight carries a note. Light pages multiply
 * the colour into the paper; dark pages lay it on more thinly.
 */
export function drawHighlight(rects: DOMRectList | DOMRect[], opts: { color: string; note: boolean; dark: boolean; underline?: boolean }) {
  const outer = document.createElementNS(SVG, "g");
  const g = document.createElementNS(SVG, "g");
  outer.append(g);
  g.setAttribute("fill", opts.color);
  g.style.opacity = opts.dark ? "0.38" : "0.5";
  g.style.mixBlendMode = opts.dark ? "screen" : "multiply";
  for (const r of Array.from(rects)) {
    const el = document.createElementNS(SVG, "rect");
    el.setAttribute("x", String(r.left));
    el.setAttribute("y", String(opts.underline ? r.bottom - 2 : r.top));
    el.setAttribute("height", String(opts.underline ? 2 : r.height));
    el.setAttribute("width", String(r.width));
    el.setAttribute("rx", "2");
    g.append(el);
  }
  if (opts.note && rects.length) {
    // A dotted underline in a deeper shade marks a highlight with a note.
    const marks = document.createElementNS(SVG, "g");
    marks.style.stroke = `color-mix(in srgb, ${opts.color} 65%, ${opts.dark ? "#fff" : "#000"})`;
    marks.setAttribute("stroke-width", "2");
    marks.setAttribute("stroke-dasharray", "0.1 4");
    marks.setAttribute("stroke-linecap", "round");
    marks.style.opacity = "0.85";
    for (const r of Array.from(rects)) {
      const l = document.createElementNS(SVG, "line");
      const y = String(r.top + r.height + 1);
      l.setAttribute("x1", String(r.left + 1));
      l.setAttribute("x2", String(r.left + r.width));
      l.setAttribute("y1", y);
      l.setAttribute("y2", y);
      marks.append(l);
    }
    outer.append(marks);
  }
  return outer;
}

/**
 * Reading fraction (0–1) of the start of `range` in section `index`:
 * the section's share of the book plus how far into its text the range is.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function fractionOf(view: any, index: number, doc: Document, range: Range): number {
  const fr: number[] = view.getSectionFractions?.() ?? [];
  const f0 = fr[index] ?? 0;
  const f1 = fr[index + 1] ?? 1;
  let before = 0;
  let total = 0;
  const walker = doc.createTreeWalker(doc.body ?? doc.documentElement, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const len = (n as Text).data.length;
    if (n === range.startContainer) before = total + range.startOffset;
    else if (range.comparePoint(n, 0) < 0) before = total + len;
    total += len;
  }
  return Math.min(1, Math.max(0, f0 + (f1 - f0) * (total ? before / total : 0)));
}

/** Screen rectangle of a range shown in a foliate iframe. */
export function screenRect(range: Range): DOMRect | null {
  const doc = range.startContainer.ownerDocument;
  const frame = doc?.defaultView?.frameElement as HTMLElement | null;
  if (!frame) return null;
  const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
  if (!rects.length) return null;
  const f = frame.getBoundingClientRect();
  const left = Math.min(...rects.map((r) => r.left));
  const top = Math.min(...rects.map((r) => r.top));
  const right = Math.max(...rects.map((r) => r.right));
  const bottom = Math.max(...rects.map((r) => r.bottom));
  // Columns of other pages sit off-screen; keep to what is visible.
  return new DOMRect(f.left + left, f.top + top, right - left, bottom - top);
}
