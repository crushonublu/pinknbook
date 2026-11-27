/** Marker matching is deliberately bounded: 2 must not match 20 or 2*. */
export function startsWithNoteMarker(text: string, marker: string): boolean {
  const clean = (s: string) => s.trim().replace(/^[\s↩↵←↑•]+/u, "").replace(/^[[(]\s*/, "").replace(/[\])]$/, "");
  const m = clean(marker);
  const t = clean(text);
  if (!m || !t.startsWith(m)) return false;
  return !/[\p{L}\p{N}*†‡]/u.test(t.slice(m.length, m.length + 1));
}

/** Search leaf text blocks after the reference, excluding its entire paragraph. */
export function findNoteByMarker(doc: Document, ref: Element, sameSection: boolean): Element | null {
  const marker = (ref.textContent ?? "").trim();
  const paragraph = ref.closest("p, li, dd, dt, blockquote, td") ?? ref;
  const blocks = "p, li, dd, dt, blockquote, div, td, aside";
  for (const block of doc.querySelectorAll(blocks)) {
    if (sameSection && (block.contains(ref) || paragraph.contains(block) || !(ref.compareDocumentPosition(block) & 4))) continue;
    // Container divs can include many notes; use their inner text block instead.
    if (block.querySelector(blocks)) continue;
    if (startsWithNoteMarker(block.textContent ?? "", marker)) return block;
  }
  return null;
}

const NOTE_BLOCK =
  'aside, [epub\\:type~="footnote"], [epub\\:type~="endnote"], [epub\\:type~="rearnote"], [role="doc-footnote"], [role="doc-endnote"]';

/** Amazon conversions often put the note in an <aside epub:type="footnote"> right
 *  after the paragraph that cites it, with a broken href and even a different
 *  number (ref "2*", note "4*"). Take the footnote block that directly follows
 *  the reference's paragraph (only whitespace or other notes in between). */
export function findAdjacentNote(ref: Element): Element | null {
  const paragraph = ref.closest("p, li, dd, dt, blockquote, td, div") ?? ref;
  for (let el = paragraph.nextElementSibling; el; el = el.nextElementSibling) {
    if (el.matches(NOTE_BLOCK)) return (el.textContent ?? "").trim() ? el : null;
    if ((el.textContent ?? "").trim()) return null;
  }
  return null;
}
