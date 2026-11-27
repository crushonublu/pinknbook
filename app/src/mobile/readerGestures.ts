/** Android owns touch navigation, rather than racing foliate's drag/snap path.
 * Capture is essential: foliate's touchmove prevents native text selection.
 * These listeners never prevent a long press or a selection gesture. */
interface CurlDrag {
  beginDrag: (direction: -1 | 1, x: number, y: number, startedAt?: number) => boolean;
  moveDrag: (x: number, y: number) => void;
  endDrag: (cancelled: boolean) => void;
}

/** Main-document margins share page zones, but never own host/iframe events. */
export function acceptReaderSurfaceEvent(event: Event, host: EventTarget, immersive: boolean, bounds: DOMRect | (() => DOMRect)) {
  const path = event.composedPath();
  if (path.some((node) => (node as Element).localName === "iframe")) return false;
  if (path.includes(host)) return true;
  if (!immersive) return false;
  const rect = typeof bounds === "function" ? bounds() : bounds;
  const e = event as MouseEvent & TouchEvent;
  const point = e.touches?.[0] ?? e.changedTouches?.[0] ?? e;
  return point.clientX >= rect.left && point.clientX <= rect.right &&
    point.clientY >= rect.top && point.clientY <= rect.bottom;
}

export function watchReaderGestures(target: EventTarget, options: {
  bounds: () => DOMRect;
  /** Coordinates are local to the event target; Curl and zones use the window. */
  point: (x: number, y: number) => { x: number; y: number };
  selected: () => boolean;
  selectionTarget?: EventTarget;
  accept?: (event: Event) => boolean;
  hitHighlight?: (x: number, y: number) => boolean;
  turn: (direction: -1 | 1) => void;
  toggle: () => void;
  drag?: () => CurlDrag | null;
  busy?: () => boolean;
  onDrag?: () => void;
}) {
  let start: { x: number; y: number; time: number; blocked: boolean; swiping: boolean; curl: CurlDrag | null; consumed: boolean; busyAtStart: boolean } | null = null;
  let suppressClickUntil = 0;
  let offsetX = 0, offsetY = 0;
  const { point, selected } = options;
  const cleanups: (() => void)[] = [];
  const on = <K extends keyof DocumentEventMap>(type: K, listener: (event: DocumentEventMap[K]) => void, config?: AddEventListenerOptions, source = target) => {
    source.addEventListener(type, listener as EventListener, config);
    cleanups.push(() => source.removeEventListener(type, listener as EventListener, config));
  };
  const cancelDrag = () => {
    start?.curl?.endDrag(true);
    if (start) { start.curl = null; start.blocked = true; }
  };
  const interactive = (target: EventTarget | null, x: number, y: number) =>
    !!(target as Element | null)?.closest?.('a, button, input, textarea, select, [role="button"], [contenteditable="true"]') || !!options.hitHighlight?.(x, y);
  on("selectionchange", () => {
    if (start && selected()) cancelDrag();
  }, undefined, options.selectionTarget ?? target);
  on("touchstart", (e) => {
    if (options.accept && !options.accept(e)) return;
    e.stopImmediatePropagation();
    const t = e.touches[0];
    if (e.touches.length !== 1) { cancelDrag(); suppressClickUntil = performance.now() + 700; return; }
    if (start) cancelDrag();
    const origin = point(t.clientX, t.clientY);
    offsetX = origin.x - t.clientX; offsetY = origin.y - t.clientY;
    start = { x: t.clientX, y: t.clientY, time: performance.now(), blocked: selected() || interactive(e.target, t.clientX, t.clientY), swiping: false, curl: null, consumed: false, busyAtStart: !!options.busy?.() };
  }, { capture: true, passive: true });
  on("touchmove", (e) => {
    if (options.accept && !options.accept(e)) return;
    e.stopImmediatePropagation();
    if (!start) return;
    if (selected() || e.touches.length !== 1) { cancelDrag(); suppressClickUntil = performance.now() + 700; return; }
    if (start.blocked) return;
    const t = e.touches[0];
    const dx = Math.abs(t.clientX - start.x), dy = Math.abs(t.clientY - start.y);
    if ((start.swiping || performance.now() - start.time < 450) && dx > 12 && dx > dy * 1.4) {
      if (start.busyAtStart) start.consumed = true;
      if (!start.swiping && !start.consumed) {
        const curl = options.drag?.();
        if (curl) {
          start.consumed = true;
          const originX = start.x + offsetX, originY = start.y + offsetY;
          if (curl.beginDrag(t.clientX < start.x ? 1 : -1, originX, originY, start.time)) {
            start.curl = curl;
            options.onDrag?.();
          }
        }
      }
      start.swiping = true;
      e.preventDefault();
    }
    if (start.curl) {
      e.preventDefault();
      start.curl.moveDrag(t.clientX + offsetX, t.clientY + offsetY);
    }
  }, { capture: true, passive: false });
  on("touchend", (e) => {
    if (options.accept && !options.accept(e)) return;
    e.stopImmediatePropagation();
    if (!start) return;
    const s = start;
    start = null;
    const t = e.changedTouches[0];
    const elapsed = performance.now() - s.time;
    const dx = t.clientX - s.x, dy = t.clientY - s.y;
    const moved = Math.hypot(dx, dy) > 12;
    if (s.blocked || selected() || elapsed >= 450 || moved) suppressClickUntil = performance.now() + 700;
    if (s.busyAtStart && !s.blocked && !selected() && !moved && elapsed < 450) {
      suppressClickUntil = performance.now() + 700;
      e.preventDefault();
      const bounds = options.bounds();
      const x = point(t.clientX, t.clientY).x - bounds.left;
      if (x < bounds.width * .28) options.turn(-1);
      else if (x > bounds.width * .72) options.turn(1);
      return;
    }
    if (s.consumed) {
      suppressClickUntil = performance.now() + 700;
      e.preventDefault();
      s.curl?.endDrag(s.blocked || selected());
      return;
    }
    if (!s.blocked && !selected() && (s.swiping || elapsed < 450) && elapsed < 1500 && Math.abs(dx) >= 48 && Math.abs(dx) > Math.abs(dy) * 1.4) {
      e.preventDefault();
      options.turn(dx < 0 ? 1 : -1);
    }
  }, { capture: true, passive: false });
  on("touchcancel", (e) => {
    if (options.accept && !options.accept(e)) return;
    e.stopImmediatePropagation(); cancelDrag(); start = null; suppressClickUntil = performance.now() + 700;
  }, { capture: true, passive: true });
  on("click", (e) => {
    if (options.accept && !options.accept(e)) return;
    if (e.defaultPrevented || performance.now() < suppressClickUntil || selected() || interactive(e.target, e.clientX, e.clientY)) return;
    const bounds = options.bounds();
    const x = point(e.clientX, e.clientY).x - bounds.left;
    if (x < bounds.width * .28) options.turn(-1);
    else if (x > bounds.width * .72) options.turn(1);
    else if (!options.busy?.()) options.toggle();
  });
  return () => {
    cancelDrag();
    start = null;
    for (const cleanup of cleanups) cleanup();
  };
}
