import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** Space kept to the window's edges and between the anchor and the popover, in px. */
const MARGIN = 8;
const OFFSET = 8;

/**
 * A small non-modal dialog on the desktop, anchored under an element (above it
 * when there is no room below, beside it when it fits on neither side) and kept
 * inside the window as the page scrolls
 * or is resized. Escape and a click outside close it, and so does tabbing out
 * of it; focus then goes back to the anchor. It follows the always-dark
 * tokens of `scx-dark`, like the phone's sheets. Rendered in the body so no
 * scrolling or clipping ancestor can cut it off.
 *
 * Clicks on the anchor itself are left to it (its own handler toggles).
 */
export function AnchoredPopover({ anchor, label, onClose, align = "center", className = "", children }: {
  anchor: HTMLElement;
  /** Accessible name of the dialog. */
  label: string;
  onClose: () => void;
  /** Centre on the anchor, or end where the anchor ends. */
  align?: "center" | "end";
  className?: string;
  children: ReactNode;
}) {
  const box = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const place = () => {
      // The anchor was removed (its month or period changed): nothing to point at.
      if (!anchor.isConnected) return close.current();
      const r = anchor.getBoundingClientRect();
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const vw = document.documentElement.clientWidth;
      const vh = document.documentElement.clientHeight;
      const clampX = (x: number) => Math.min(Math.max(MARGIN, x), vw - w - MARGIN);
      const along = clampX(align === "end" ? r.right - w : r.left + r.width / 2 - w / 2);
      let left = along;
      let top: number;
      if (r.bottom + OFFSET + h <= vh - MARGIN) top = r.bottom + OFFSET;
      else if (r.top - OFFSET - h >= MARGIN) top = r.top - OFFSET - h;
      else {
        // Too tall for either side: beside the anchor, so it is not covered.
        top = Math.min(Math.max(MARGIN, r.top), Math.max(MARGIN, vh - h - MARGIN));
        left = r.right + OFFSET + w <= vw - MARGIN ? r.right + OFFSET : r.left - OFFSET - w >= MARGIN ? r.left - OFFSET - w : along;
      }
      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
      el.style.visibility = "visible";
    };
    place();
    // The content can change height (a day's marks load after it opens).
    const ro = new ResizeObserver(place);
    ro.observe(el);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchor, align]);

  useEffect(() => {
    box.current?.focus({ preventScroll: true });
    const back = () => {
      close.current();
      if (anchor.isConnected) anchor.focus();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // The page behind must not also leave Stats.
      e.preventDefault();
      e.stopPropagation();
      back();
    };
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!box.current?.contains(target) && !anchor.contains(target)) close.current();
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onDown, true);
    };
  }, [anchor]);

  return createPortal(
    <section
      ref={box}
      className={`spop scx-dark ${className}`}
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      style={{ visibility: "hidden" }}
      onKeyDown={(e) => {
        if (e.key !== "Tab") return;
        const els = Array.from(box.current?.querySelectorAll<HTMLElement>("button:not(:disabled), [href], input:not(:disabled), select, [tabindex='0']") ?? []);
        const edge = e.shiftKey ? els[0] : els[els.length - 1];
        const active = document.activeElement;
        // Leaving the dialog either way gives focus back to where it came from.
        if (!els.length || active === edge || (e.shiftKey && active === box.current)) {
          e.preventDefault();
          close.current();
          if (anchor.isConnected) anchor.focus();
        }
      }}
    >
      {children}
    </section>,
    document.body,
  );
}
