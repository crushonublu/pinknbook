/**
 * Shared-element motion with the View Transitions API (Chromium/WebView2).
 *
 * One element at a time carries `view-transition-name: book`: the cover that
 * was clicked, the cover on the detail page, or the reader. Starting a
 * transition while the old element is tagged and letting the new state render
 * its own tagged element makes the browser morph one into the other — a cover
 * grows into the detail page or "opens" into the reader. Without support, or
 * with reduced motion, state just changes instantly.
 */
import { flushSync } from "react-dom";

export const SHARED = "book";

type VT = { finished: Promise<void> };
type DocVT = Document & { startViewTransition?: (cb: () => void) => VT };

function supported() {
  return (
    typeof (document as DocVT).startViewTransition === "function" &&
    !matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function setName(el: Element | null | undefined, name: string) {
  if (el instanceof HTMLElement) el.style.viewTransitionName = name;
}

/** The cover element of a book card currently on screen. */
export function coverOf(asin: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-cover-asin="${CSS.escape(asin)}"]`);
}

/**
 * Morph from `from` (an element on screen now) into whatever the new state
 * tags with the shared name. `to` optionally names an element that exists
 * only after the update (e.g. a library cover when closing the detail page).
 */
export function morph(update: () => void, from?: Element | null, to?: () => Element | null) {
  if (!supported()) {
    update();
    return;
  }
  setName(from, SHARED);
  let tagged: Element | null = null;
  const vt = (document as DocVT).startViewTransition!(() => {
    setName(from, "");
    flushSync(update);
    tagged = to?.() ?? null;
    setName(tagged, SHARED);
  });
  vt.finished.finally(() => setName(tagged, "")).catch(() => undefined);
}
