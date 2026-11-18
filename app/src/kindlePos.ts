/**
 * Kindle positions ↔ places in the rendered book.
 *
 * On KF8 books a Kindle position (highlights, notes) is
 *   section start (skeleton offset in the raw text) + byte offset into the
 *   section's assembled HTML (fragments inserted into the skeleton),
 * the same space as `kindle:pos:fid:off` links. Ranges are inclusive: `end`
 * is the last byte of the last character. (Checked against Kindle for PC's
 * own records and highlights from other devices.)
 *
 * Positions only mean this for the exact build of the book we hold; the
 * backend asks Amazon for (and sends) positions tagged with our build's id.
 *
 * `book.getKindleMap` (patched into public/foliate/mobi.js) gives a section's
 * assembled bytes. This module walks them, pairs every character of text with
 * its byte, aligns that with the live document's text nodes, and converts
 * both ways.
 *
 * Older MOBI 6 books have no such map; callers fall back to app-only data.
 */

interface SourceMap {
  rawStart: number;
  rawEnd: number;
  /** Assembled-HTML byte offset of each UTF-16 unit of the source text. */
  srcByte: Int32Array;
  /** The source text itself (outside tags, entities decoded). */
  text: string;
}

interface DomMap {
  nodes: Text[];
  /** Offset of each node in the DOM text stream. */
  starts: number[];
  /** DOM text index → source text index. */
  dToS: Int32Array;
  /** Source text index → DOM text index (nearest at or after). */
  sToD: Int32Array;
  total: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Book = any;

const srcCache = new WeakMap<Book, Map<number, Promise<SourceMap | null>>>();
const domCache = new WeakMap<Document, DomMap>();

/** Whether the book can address text by Kindle position at all. */
export function supportsKindlePos(book: Book): boolean {
  return typeof book?.getKindleMap === "function";
}

/** The section whose raw text range holds `pos`, or -1. */
export function sectionOfPos(book: Book, pos: number): number {
  const ranges: [number, number][] | undefined = book?.kindleRanges;
  if (!ranges) return -1;
  return ranges.findIndex(([a, b]) => pos >= a && pos < b);
}

function sourceMap(book: Book, index: number): Promise<SourceMap | null> {
  let per = srcCache.get(book);
  if (!per) srcCache.set(book, (per = new Map()));
  let p = per.get(index);
  if (!p) {
    p = (async () => {
      const m = await book.getKindleMap(index);
      if (!m) return null;
      const { text, srcByte } = extractText(m.bytes, m.utf8);
      return { rawStart: m.rawStart, rawEnd: m.rawEnd, text, srcByte };
    })().catch(() => null);
    per.set(index, p);
  }
  return p;
}

// ---- Source side -----------------------------------------------------------

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  mdash: "—", ndash: "–", hellip: "…", lsquo: "‘", rsquo: "’",
  ldquo: "“", rdquo: "”", laquo: "«", raquo: "»", copy: "©",
  reg: "®", trade: "™", middot: "·", bull: "•", deg: "°",
  shy: "­", thinsp: " ", ensp: " ", emsp: " ", zwj: "‍", zwnj: "‌",
};

const CP1252 = new TextDecoder("windows-1252");

/** Text outside tags (entities decoded), with each unit's byte offset. */
function extractText(b: Uint8Array, utf8: boolean): { text: string; srcByte: Int32Array } {
  const units: string[] = [];
  const offs: number[] = [];
  const push = (s: string, at: number) => {
    for (let k = 0; k < s.length; k++) {
      units.push(s[k]);
      offs.push(at);
    }
  };
  const startsWith = (i: number, s: string) => {
    for (let k = 0; k < s.length; k++) if (b[i + k] !== s.charCodeAt(k)) return false;
    return true;
  };
  const startsWithCI = (i: number, s: string) => {
    for (let k = 0; k < s.length; k++) {
      const c = b[i + k];
      if (c === undefined || (c | 0x20) !== (s.charCodeAt(k) | 0x20)) return false;
    }
    return true;
  };
  const indexOf = (i: number, s: string, ci = false) => {
    for (let j = i; j <= b.length - s.length; j++) if (ci ? startsWithCI(j, s) : startsWith(j, s)) return j;
    return b.length;
  };

  let i = 0;
  while (i < b.length) {
    const c = b[i];
    if (c === 0x3c /* < */) {
      if (startsWith(i, "<!--")) {
        i = indexOf(i + 4, "-->") + 3;
        continue;
      }
      if (startsWith(i, "<![CDATA[")) {
        const end = indexOf(i + 9, "]]>");
        decodeRun(i + 9, end);
        i = end + 3;
        continue;
      }
      // Tag: find its end, honouring quoted attribute values.
      let j = i + 1;
      let q = 0;
      while (j < b.length) {
        const d = b[j];
        if (q) {
          if (d === q) q = 0;
        } else if (d === 0x22 || d === 0x27) q = d;
        else if (d === 0x3e) break;
        j++;
      }
      const isStyle = startsWithCI(i, "<style") && !isNameChar(b[i + 6]);
      const isScript = startsWithCI(i, "<script") && !isNameChar(b[i + 7]);
      const selfClosing = b[j - 1] === 0x2f;
      i = j + 1;
      if ((isStyle || isScript) && !selfClosing) {
        i = indexOf(i, isStyle ? "</style" : "</script", true);
      }
      continue;
    }
    // A run of text up to the next tag.
    let end = i;
    while (end < b.length && b[end] !== 0x3c) end++;
    decodeRun(i, end);
    i = end;
  }

  function decodeRun(from: number, to: number) {
    let k = from;
    while (k < to) {
      const c = b[k];
      if (c === 0x26 /* & */) {
        let e = k + 1;
        while (e < to && e - k < 12 && b[e] !== 0x3b) e++;
        if (b[e] === 0x3b) {
          const name = String.fromCharCode(...b.slice(k + 1, e));
          let ch: string | null = null;
          if (name[0] === "#") {
            const n = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
            if (Number.isFinite(n) && n > 0) ch = String.fromCodePoint(n);
          } else ch = NAMED[name] ?? null;
          if (ch != null) {
            push(ch, k);
            k = e + 1;
            continue;
          }
        }
        push("&", k);
        k++;
        continue;
      }
      if (!utf8 || c < 0x80) {
        push(utf8 ? String.fromCharCode(c) : CP1252.decode(b.subarray(k, k + 1)), k);
        k++;
        continue;
      }
      const n = c >= 0xf0 ? 4 : c >= 0xe0 ? 3 : c >= 0xc0 ? 2 : 1;
      let cp = n === 4 ? c & 0x07 : n === 3 ? c & 0x0f : n === 2 ? c & 0x1f : 0xfffd;
      for (let m = 1; m < n; m++) cp = (cp << 6) | ((b[k + m] ?? 0x80) & 0x3f);
      push(String.fromCodePoint(n === 1 ? 0xfffd : cp), k);
      k += n;
    }
  }

  return { text: units.join(""), srcByte: Int32Array.from(offs) };
}

function isNameChar(c: number | undefined) {
  return c !== undefined && ((c >= 0x30 && c <= 0x39) || ((c | 0x20) >= 0x61 && (c | 0x20) <= 0x7a) || c === 0x2d);
}

// ---- DOM side --------------------------------------------------------------

const isWS = (ch: string) => ch === " " || ch === "\n" || ch === "\t" || ch === "\r" || ch === "\f";

function domMap(doc: Document, src: SourceMap): DomMap {
  const cached = domCache.get(doc);
  if (cached) return cached;
  const nodes: Text[] = [];
  const starts: number[] = [];
  const parts: string[] = [];
  let total = 0;
  const walker = doc.createTreeWalker(doc.documentElement, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      (n.parentElement?.closest("style, script") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text;
    nodes.push(t);
    starts.push(total);
    parts.push(t.data);
    total += t.data.length;
  }
  const d = parts.join("");
  const s = src.text;
  // Greedy alignment that tolerates whitespace the parser dropped or kept
  // and the odd character decoded differently.
  const dToS = new Int32Array(d.length + 1);
  const sToD = new Int32Array(s.length + 1).fill(-1);
  let i = 0;
  let j = 0;
  while (i < d.length && j < s.length) {
    if (d[i] === s[j] || (d[i] === " " && s[j] === " ")) {
      dToS[i] = j;
      sToD[j] = i;
      i++;
      j++;
    } else if (isWS(s[j])) j++;
    else if (isWS(d[i])) dToS[i++] = j;
    else {
      dToS[i] = j;
      sToD[j] = i;
      i++;
      j++;
    }
  }
  for (; i <= d.length; i++) dToS[i] = Math.min(j, s.length);
  // Fill gaps in sToD with the next mapped DOM index.
  let next = d.length;
  for (let k = s.length; k >= 0; k--) {
    if (sToD[k] >= 0) next = sToD[k];
    else sToD[k] = next;
  }
  const map = { nodes, starts, dToS, sToD, total };
  domCache.set(doc, map);
  return map;
}

function domIndexOf(dm: DomMap, node: Node, offset: number): number | null {
  if (node.nodeType !== Node.TEXT_NODE) {
    // An element boundary: use the first text node at or after it.
    const el = node as Element;
    const child = el.childNodes[offset] ?? null;
    const doc = node.ownerDocument!;
    const walker = doc.createTreeWalker(doc.documentElement, NodeFilter.SHOW_TEXT);
    walker.currentNode = child ?? el;
    const t = child && child.nodeType === Node.TEXT_NODE ? child : walker.nextNode();
    if (!t) return dm.total;
    const k = dm.nodes.indexOf(t as Text);
    return k < 0 ? null : dm.starts[k];
  }
  const k = dm.nodes.indexOf(node as Text);
  return k < 0 ? null : dm.starts[k] + offset;
}

/** UTF-8 length of the character starting at unit `k` of `text`. */
function charBytes(text: string, k: number): number {
  const cp = text.codePointAt(k) ?? 0;
  return cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
}

// ---- Public conversions ----------------------------------------------------

/**
 * Kindle positions of a DOM range in section `index`: `start` is the first
 * character's byte, `end` the LAST character's byte (Kindle's ranges are
 * inclusive).
 */
export async function rangeToKindle(
  book: Book,
  index: number,
  doc: Document,
  range: Range,
): Promise<{ start: number; end: number } | null> {
  if (!supportsKindlePos(book)) return null;
  const src = await sourceMap(book, index);
  if (!src || !src.text.length) return null;
  const dm = domMap(doc, src);
  const a = domIndexOf(dm, range.startContainer, range.startOffset);
  const b = domIndexOf(dm, range.endContainer, range.endOffset);
  if (a == null || b == null || b <= a) return null;
  const sa = dm.dToS[Math.min(a, dm.total)];
  const sb = dm.dToS[Math.max(a, b - 1)];
  const k0 = Math.min(Math.max(sa, 0), src.srcByte.length - 1);
  const k1 = Math.min(Math.max(sb, 0), src.srcByte.length - 1);
  return {
    start: src.rawStart + src.srcByte[k0],
    end: src.rawStart + src.srcByte[k1] + charBytes(src.text, k1) - 1,
  };
}

/** A DOM range in `doc` (section `index`) for an inclusive Kindle range. */
export async function kindleToRange(
  book: Book,
  index: number,
  doc: Document,
  start: number,
  end: number,
): Promise<Range | null> {
  if (!supportsKindlePos(book)) return null;
  const src = await sourceMap(book, index);
  if (!src || !src.text.length) return null;
  const dm = domMap(doc, src);
  const toSrc = (pos: number, last: boolean) => {
    const a = pos - src.rawStart;
    if (a < 0) return null;
    // First text unit whose byte is at/after `a` (or the last one at/before it).
    let lo = 0;
    let hi = src.srcByte.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (src.srcByte[mid] < a) lo = mid + 1;
      else hi = mid;
    }
    if (last && (lo >= src.srcByte.length || src.srcByte[lo] > a)) lo--;
    return Math.max(0, Math.min(lo, src.srcByte.length - 1));
  };
  const s0 = toSrc(start, false);
  const s1 = toSrc(end, true);
  if (s0 == null || s1 == null || s1 < s0) return null;
  const d0 = dm.sToD[s0];
  let d1 = dm.sToD[s1];
  if (d1 < d0) d1 = d0;
  const point = (d: number): [Text, number] | null => {
    if (!dm.nodes.length) return null;
    let k = 0;
    while (k + 1 < dm.nodes.length && dm.starts[k + 1] <= d) k++;
    return [dm.nodes[k], Math.min(d - dm.starts[k], dm.nodes[k].data.length)];
  };
  const p0 = point(d0);
  const p1 = point(d1 + 1);
  if (!p0 || !p1) return null;
  const r = doc.createRange();
  r.setStart(p0[0], p0[1]);
  r.setEnd(p1[0], p1[1]);
  snapToWords(r);
  return r.collapsed ? null : r;
}

const WORD = /[\p{L}\p{N}\p{M}'’]/u;

/**
 * Grow a range to whole words and drop surrounding spaces. Positions from
 * other Kindle devices can land a few bytes off (their copy of the book is
 * not byte-identical), which would otherwise cut words in half.
 */
function snapToWords(r: Range) {
  // Inside a word, go to whichever edge is nearer: a start past the middle
  // of a word belongs to the next word, an end past the middle takes the
  // whole word.
  const sc = r.startContainer;
  if (sc.nodeType === Node.TEXT_NODE) {
    const t = (sc as Text).data;
    let o = r.startOffset;
    while (o < t.length && /\s/.test(t[o])) o++;
    if (o > 0 && o < t.length && WORD.test(t[o - 1]) && WORD.test(t[o])) {
      let a = o;
      while (a > 0 && WORD.test(t[a - 1])) a--;
      let b = o;
      while (b < t.length && WORD.test(t[b])) b++;
      if (o - a > b - o) {
        o = b;
        while (o < t.length && !WORD.test(t[o])) o++;
      } else o = a;
    }
    r.setStart(sc, o);
  }
  const ec = r.endContainer;
  if (ec.nodeType === Node.TEXT_NODE) {
    const t = (ec as Text).data;
    let o = r.endOffset;
    while (o > 0 && /\s/.test(t[o - 1])) o--;
    if (o > 0 && o < t.length && WORD.test(t[o - 1]) && WORD.test(t[o])) {
      let a = o;
      while (a > 0 && WORD.test(t[a - 1])) a--;
      let b = o;
      while (b < t.length && WORD.test(t[b])) b++;
      if (o - a >= b - o) o = b;
      else {
        o = a;
        while (o > 0 && /\s/.test(t[o - 1])) o--;
      }
    }
    if (ec !== sc || o > r.startOffset) r.setEnd(ec, o);
  }
}
