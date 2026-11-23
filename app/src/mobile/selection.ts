/** Native selection changes continue after pointerup (including handle drags).
 * Register before gesture capture listeners; never prevent native selection. */
export function watchTouchSelection(doc: Document, check: () => void) {
  let touching = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { if (!touching && doc.defaultView) check(); }, 250);
  };
  const down = () => { touching = true; clearTimeout(timer); };
  const up = () => { touching = false; schedule(); };
  doc.addEventListener("touchstart", down, { capture: true, passive: true });
  doc.addEventListener("touchend", up, { capture: true, passive: true });
  doc.addEventListener("touchcancel", up, { capture: true, passive: true });
  doc.addEventListener("selectionchange", schedule);
  const context = (e: Event) => e.preventDefault();
  doc.addEventListener("contextmenu", context);
  doc.documentElement.classList.add("is-android");
  const style = doc.createElement("style");
  style.textContent = ".is-android, .is-android * { -webkit-touch-callout: none !important; } .is-android body { -webkit-user-select: text; user-select: text; }";
  (doc.head ?? doc.documentElement).append(style);
  return () => {
    clearTimeout(timer);
    doc.removeEventListener("touchstart", down, true);
    doc.removeEventListener("touchend", up, true);
    doc.removeEventListener("touchcancel", up, true);
    doc.removeEventListener("selectionchange", schedule);
    doc.removeEventListener("contextmenu", context);
    style.remove();
  };
}
