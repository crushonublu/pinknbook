import { findAdjacentNote, findNoteByMarker } from "./footnoteFallback";
import { isAndroid } from "./platform";
import { STR, type Lang } from "./i18n";
import { MobileReaderSheet } from "./mobile/MobileReaderSheet";
import { useEffect, useLayoutEffect, useRef } from "react";
import { usePlace } from "./AnnotationPopup";

/** A footnote shown over the text, kept as safe nodes of the app's document. */
export interface FootnotePeek {
  rect: DOMRect;
  content: DocumentFragment;
  /** A heading with a colour dot (for the reader's own notes). */
  label?: { text: string; color: string };
}

/** The reader's own note as popup content, one paragraph per line. */
export function noteContent(text: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  for (const line of text.split(/\n+/)) {
    if (!line.trim()) continue;
    const p = document.createElement("p");
    p.textContent = line;
    frag.appendChild(p);
  }
  return frag;
}

const NOTEREF = /(^|\s)(noteref|footnote|endnote|rearnote|biblioref)(\s|$)/i;
const SHORT_MARK = /^[[(]?\s*([0-9]{1,4}[*†‡]?|[*†‡§¶]{1,3}|[ivxlc]{1,5}|[a-z])\s*[\])]?\.?$/i;

/**
 * Whether a link looks like a footnote reference: marked as one, set in
 * superscript, or just a short mark such as "[3]", "12", "*".
 */
export function isNoteRef(a: Element): boolean {
  const type = a.getAttributeNS("http://www.idpf.org/2007/ops", "type") ?? a.getAttribute("epub:type") ?? "";
  const role = a.getAttribute("role") ?? "";
  if (NOTEREF.test(type) || NOTEREF.test(role.replace("doc-", ""))) return true;
  const text = (a.textContent ?? "").trim();
  if (!text || text.length > 8) return false;
  return SHORT_MARK.test(text) || !!a.closest("sup") || !!a.querySelector("sup");
}

const BLOCKS = "p, li, dd, dt, blockquote, div, td, h1, h2, h3, h4, h5, h6";
const WHOLE_NOTE =
  'aside, [epub\\:type~="footnote"], [epub\\:type~="endnote"], [epub\\:type~="rearnote"], [role="doc-footnote"], [role="doc-endnote"]';

/** The first element at or after `el` (in reading order) that holds text. */
function firstWithText(el: Element): Element | null {
  if ((el.textContent ?? "").trim()) return el;
  const doc = el.ownerDocument;
  const walker = doc.createTreeWalker(doc.body ?? doc.documentElement, NodeFilter.SHOW_TEXT);
  walker.currentNode = el;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if ((n.textContent ?? "").trim()) return n.parentElement;
  }
  return null;
}

/** The element a footnote link points to, widened to the whole note. */
function noteElement(target: Element): Element | null {
  const start = firstWithText(target);
  if (!start) return null;
  const whole = start.closest(WHOLE_NOTE);
  if (whole && (whole.textContent ?? "").length < 4000) return whole;
  const block = start.closest(BLOCKS);
  if (!block || block === block.ownerDocument.body) return start;
  // A note in a list or a definition entry often keeps its text one level up.
  return block;
}

/** Up to three blocks after `el` that carry on its note (stops at the next mark). */
function blocksAfter(el: Element): Element[] {
  const out: Element[] = [];
  for (let n = el.nextElementSibling; n && out.length < 3; n = n.nextElementSibling) {
    const text = (n.textContent ?? "").trim();
    if (!text) continue;
    if (/^([[(]\s*\d{1,4}\s*[\])]|\d{1,4}\*|[*†‡]+\s)/.test(text)) break;
    out.push(n);
  }
  return out;
}

const KEEP: Record<string, string> = {
  p: "p", div: "p", blockquote: "blockquote", li: "p", dd: "p", dt: "p", td: "span",
  b: "b", strong: "b", i: "i", em: "i", cite: "i", u: "u", sup: "sup", sub: "sub",
  small: "small", br: "br", span: "span", a: "span", code: "code",
  h1: "b", h2: "b", h3: "b", h4: "b", h5: "b", h6: "b",
};
const DROP = new Set(["script", "style", "img", "image", "svg", "video", "audio", "object", "iframe", "math", "head"]);

/**
 * Copy book content into the app's document keeping only text and simple
 * formatting: no attributes, links, scripts or media can come across.
 */
function copySafe(src: Node, into: Node) {
  for (const n of Array.from(src.childNodes)) {
    if (n.nodeType === Node.TEXT_NODE) {
      into.appendChild(document.createTextNode(n.textContent ?? ""));
    } else if (n.nodeType === Node.ELEMENT_NODE) {
      const tag = (n as Element).localName.toLowerCase();
      if (DROP.has(tag)) continue;
      const as = KEEP[tag];
      if (as) {
        const el = document.createElement(as);
        if (as !== "br") copySafe(n, el);
        into.appendChild(el);
      } else copySafe(n, into);
    }
  }
}

/**
 * Load the text a footnote link points to. `index` is the section the link
 * sits in. Returns null for links that lead nowhere useful.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function loadFootnote(view: any, index: number, a: Element): Promise<DocumentFragment | null> {
  const book = view?.book;
  const raw = a.getAttribute("href");
  if (!book || !raw) return null;
  const href = book.sections?.[index]?.resolveHref?.(raw) ?? raw;
  if (book.isExternal?.(href)) return null;
  // Kindle conversions can leave placeholders or positions without an anchor.
  // A failed resolver must not prevent the marker search.
  let resolved;
  try { resolved = await book.resolveHref?.(href); } catch { /* malformed conversion */ }
  let note: Element | null = null;
  let noteIndex = resolved?.index ?? index;
  if (resolved?.index >= 0 && typeof resolved.anchor === "function") {
    try {
      const doc = await book.sections[resolved.index]?.createDocument?.();
      const target = doc && resolved.anchor(doc);
      if (target?.nodeType === 1 && target !== doc.body) note = noteElement(target);
    } catch { /* fall through to marker search */ }
  }
  if (note && (!(note.textContent ?? "").trim() || (note.textContent ?? "").length > 4000)) note = null;
  if (!note && isNoteRef(a)) {
    const adjacent = findAdjacentNote(a);
    if (adjacent) note = noteElement(adjacent);
  }
  if (!note && isNoteRef(a)) {
    for (let i = index; i < (book.sections?.length ?? 0); i++) {
      let doc: Document | undefined;
      try { doc = i === index ? a.ownerDocument : await book.sections[i]?.createDocument?.(); } catch { continue; }
      if (!doc) continue;
      const target = findNoteByMarker(doc, a, i === index);
      if (target) { note = noteElement(target); noteIndex = i; break; }
    }
  }
  if (!note) return null;
  const frag = document.createDocumentFragment();
  copySafe(note, frag);
  // Some books put the mark in a paragraph of its own and the text in the
  // next one, which can even start the next section.
  if (SHORT_MARK.test((note.textContent ?? "").trim())) {
    let more = blocksAfter(note);
    if (!more.length) {
      const next = (await book.sections[noteIndex + 1]?.createDocument?.()) as Document | undefined;
      const first = next?.body?.firstElementChild;
      const lead = first ? firstWithText(first)?.closest(BLOCKS) : null;
      // Carry on only into running text, not a heading or a contents page.
      const prose = lead && !/^h[1-6]$/.test(lead.localName) && (lead.textContent ?? "").trim().length >= 25;
      if (lead && prose) more = [lead, ...blocksAfter(lead)].slice(0, 3);
    }
    for (const b of more) {
      const p = document.createElement("p");
      copySafe(b, p);
      frag.appendChild(p);
    }
  }
  const text = (frag.textContent ?? "").trim();
  // Nothing to show, or the link really leads to a chapter, not a note.
  if (!text || text.length > 4000) return null;
  return frag;
}

/** The floating box with a footnote's text; stays open while hovered. */
export function FootnotePopup({
  peek,
  lang,
  font,
  onEnter,
  onLeave,
  onClose,
}: {
  peek: FootnotePeek;
  lang: Lang;
  font: string;
  onEnter: () => void;
  onLeave: () => void;
  onClose: () => void;
}) {
  const body = useRef<HTMLDivElement>(null);
  // Fill the box before it is measured and placed (declared first, runs first).
  useLayoutEffect(() => {
    const el = body.current;
    if (!el) return;
    el.replaceChildren(peek.content.cloneNode(true));
    el.scrollTop = 0;
  }, [peek.content]);
  const { ref, pos } = usePlace(peek.rect, 8, peek.content);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [onClose]);
  if (isAndroid) return <MobileReaderSheet title={peek.label?.text ?? STR[lang].mcFootnote} closeLabel={STR[lang].closeReader} onClose={onClose}>
    <div className="mc-footnote" style={{ fontFamily: font }}><div ref={body} className="fnote__body" /></div>
  </MobileReaderSheet>;
  return (
    <div
      ref={ref}
      className={`fnote${peek.label ? " fnote--own" : ""}`}
      style={{ fontFamily: font, ...(pos ? { left: pos.left, top: pos.top } : { visibility: "hidden" }) }}
      role="note"
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
    >
      <div className="fnote__scroll">
        {peek.label && (
          <div className="fnote__label">
            <i style={{ background: peek.label.color }} />
            {peek.label.text}
          </div>
        )}
        <div ref={body} className="fnote__body" />
      </div>
    </div>
  );
}
