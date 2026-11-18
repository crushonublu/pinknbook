import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type CSSProperties } from "react";
import { STR, type Lang } from "./i18n";
import { STATUS_ORDER, type LibraryRow, type ReadStatus } from "./types";
import { Book3D } from "./Book3D";
import { heightFactor, lookOf } from "./spine";
import { statusLabel } from "./bookInfo";
import type { BookActions } from "./Library";
import { Icon } from "./icons";

/** Book height on the shelves (px, before per-book variation). */
const BOOK_H = 188;
/** Gap between standing spines and around face-out books. */
const SPINE_GAP = 2;
const FACE_GAP = 14;
const PULL_MS = 430;
/** A spring for FLIP moves (overshoots a touch, settles). */
const SPRING =
  "linear(0, 0.009, 0.035 2.1%, 0.141, 0.281 6.7%, 0.723 12.9%, 0.938 16.7%, 1.017, 1.077 20.4%, 1.121, 1.149 24.3%, 1.159, 1.163, 1.161, 1.154 29.9%, 1.129 32.8%, 1.051 39.6%, 1.017 43.1%, 0.991, 0.977 51%, 0.974 53.8%, 0.975 57.1%, 0.997 69.8%, 1.003 76.9%, 1)";

const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Books on the "reading" shelf face out, like a display shelf. */
const faceOut = (s: ReadStatus) => s === "reading";

/** Width a book takes on a shelf (mirrors the geometry in Book3D). */
function slotWidth(row: LibraryRow, status: ReadStatus): number {
  const h = Math.round(BOOK_H * heightFactor(row.asin));
  if (faceOut(status)) return Math.round((h * 2) / 3) + FACE_GAP;
  return Math.max(8, Math.round((lookOf(row).width * h) / 190)) + SPINE_GAP;
}

/** Hover turn of a standing book (degrees), matching App.css. */
const TURN = (55 * Math.PI) / 180;

/**
 * How far a standing book's right-hand neighbours slide away while it is
 * turned to show its cover: the cover's width on screen, less the spine's.
 */
function pushWidth(row: LibraryRow): number {
  const h = Math.round(BOOK_H * heightFactor(row.asin));
  const t = Math.max(8, Math.round((lookOf(row).width * h) / 190));
  const d = Math.round((h * 2) / 3);
  return Math.round(d * Math.sin(TURN) + t * Math.cos(TURN) - t + 10);
}

type Item = { kind: "book"; row: LibraryRow } | { kind: "gap"; row: LibraryRow };

/** Greedy line packing: each line becomes one plank of the bookcase. */
function pack(items: Item[], status: ReadStatus, width: number): Item[][] {
  const lines: Item[][] = [];
  let line: Item[] = [];
  let used = 0;
  for (const it of items) {
    const w = slotWidth(it.row, status);
    if (line.length && used + w > width) {
      lines.push(line);
      line = [];
      used = 0;
    }
    line.push(it);
    used += w;
  }
  if (line.length) lines.push(line);
  return lines;
}

/** Order a shelf: hand-arranged position first, else the incoming (sorted) order. */
function arrange(rows: LibraryRow[]): LibraryRow[] {
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (a.r.shelf_pos ?? Infinity) - (b.r.shelf_pos ?? Infinity) || a.i - b.i)
    .map((x) => x.r);
}

type Drag = {
  row: LibraryRow;
  from: ReadStatus;
  /** Pointer offset inside the grabbed book. */
  dx: number;
  dy: number;
  /** Where the drag started (initial ghost position). */
  x0: number;
  y0: number;
  target: { status: ReadStatus; index: number } | null;
};

export function Bookcase({
  rows,
  lang,
  actions,
  onSeeAll,
  onArrange,
}: {
  rows: LibraryRow[];
  lang: Lang;
  actions: BookActions;
  onSeeAll: (s: ReadStatus) => void;
  /** Book `asin` now sits on shelf `status`, whose full order is `order`. */
  onArrange: (asin: string, status: ReadStatus, order: string[]) => void;
}) {
  const t = STR[lang];
  const rootRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  // Unknown until measured: nothing is laid out (or animated) before that.
  const [width, setWidth] = useState<number | null>(null);
  const [pulled, setPulled] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [focusAsin, setFocusAsin] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  const wantFocus = useRef(false);
  const justDragged = useRef(false);

  // Shelf contents, in display order.
  const shelves = useMemo(() => {
    const m = new Map<ReadStatus, LibraryRow[]>();
    for (const s of STATUS_ORDER) m.set(s, arrange(rows.filter((r) => r.status === s)));
    return m;
  }, [rows]);
  const flat = useMemo(() => STATUS_ORDER.flatMap((s) => shelves.get(s)!), [shelves]);
  const activeFocus = focusAsin && flat.some((r) => r.asin === focusAsin) ? focusAsin : flat[0]?.asin ?? null;

  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    // Re-measure on the next frame: setting state inside the observer
    // callback re-lays out the shelves in the same frame and trips the
    // "ResizeObserver loop" error.
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setWidth((w) => (w === el.clientWidth ? w : el.clientWidth)));
    });
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  // ── FLIP: books glide (with a spring) to wherever a re-layout puts them.
  const rects = useRef(new Map<string, DOMRect>());
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const base = root.getBoundingClientRect();
    const next = new Map<string, DOMRect>();
    const motion = !reduced();
    root.querySelectorAll<HTMLElement>("[data-flip]").forEach((el) => {
      const key = el.dataset.flip!;
      const r = el.getBoundingClientRect();
      const rel = new DOMRect(r.left - base.left, r.top - base.top, r.width, r.height);
      next.set(key, rel);
      const prev = rects.current.get(key);
      if (!motion || !prev) return;
      const dx = prev.left - rel.left;
      const dy = prev.top - rel.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], {
        duration: 520,
        easing: SPRING,
      });
    });
    rects.current = next;
  });

  // Keyboard focus follows `focusAsin` after re-renders (e.g. a book moved).
  useEffect(() => {
    if (!wantFocus.current || !activeFocus) return;
    wantFocus.current = false;
    rootRef.current?.querySelector<HTMLElement>(`[data-slot="${CSS.escape(activeFocus)}"]`)?.focus();
  });

  // ── Opening: pull the book out, turn its cover to you, then morph into
  // the detail page from that cover.
  const pullTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (pullTimer.current) clearTimeout(pullTimer.current);
  }, []);
  const open = useCallback(
    (row: LibraryRow, slot: HTMLElement | null) => {
      if (pullTimer.current) return;
      const cover = () => slot?.querySelector("[data-cover-asin]") ?? null;
      if (reduced()) {
        actions.details(row, cover());
        return;
      }
      setPulled(row.asin);
      pullTimer.current = window.setTimeout(() => {
        pullTimer.current = null;
        actions.details(row, cover());
        setPulled(null);
      }, PULL_MS);
    },
    [actions],
  );

  // ── Drag & drop (pointer events: Tauri's file-drop handling disables
  // HTML5 drag-and-drop in the Windows webview).
  const dragRef = useRef<Drag | null>(null);
  dragRef.current = drag;

  function targetAt(x: number, y: number, asin: string): Drag["target"] {
    const root = rootRef.current;
    if (!root) return null;
    const shelfEl = document
      .elementsFromPoint(x, y)
      .map((e) => e.closest<HTMLElement>("[data-shelf]"))
      .find((e): e is HTMLElement => !!e && root.contains(e));
    if (!shelfEl) return null;
    const status = shelfEl.dataset.shelf as ReadStatus;
    const rowsEls = [...shelfEl.querySelectorAll<HTMLElement>(".case__row")];
    // The plank whose band is nearest the pointer.
    let best = rowsEls[0];
    let bestDist = Infinity;
    for (const el of rowsEls) {
      const r = el.getBoundingClientRect();
      const dist = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
      if (dist < bestDist) {
        best = el;
        bestDist = dist;
      }
    }
    let index = 0;
    for (const el of rowsEls) {
      const slots = [...el.querySelectorAll<HTMLElement>("[data-slot]")].filter((s) => s.dataset.slot !== asin);
      if (el !== best) {
        index += slots.length;
        continue;
      }
      for (const s of slots) {
        const r = s.getBoundingClientRect();
        if (x > r.left + r.width / 2) index++;
      }
      break;
    }
    return { status, index };
  }

  function onPointerDown(e: PointerEvent<HTMLElement>, row: LibraryRow, from: ReadStatus) {
    if (e.button !== 0 || pulled) return;
    const slot = e.currentTarget;
    const start = { x: e.clientX, y: e.clientY };
    const rect = slot.getBoundingClientRect();
    let started = false;

    const move = (ev: globalThis.PointerEvent) => {
      if (!started) {
        if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 6) return;
        started = true;
        document.body.classList.add("is-dragging-book");
        setDrag({
          row,
          from,
          dx: start.x - rect.left,
          dy: start.y - rect.top,
          x0: rect.left,
          y0: rect.top,
          target: null,
        });
      }
      const d = dragRef.current;
      if (ghostRef.current && d) {
        ghostRef.current.style.transform = `translate(${ev.clientX - d.dx}px, ${ev.clientY - d.dy}px) rotate(-4deg)`;
      }
      const target = targetAt(ev.clientX, ev.clientY, row.asin);
      setDrag((cur) =>
        cur && (cur.target?.status !== target?.status || cur.target?.index !== target?.index)
          ? { ...cur, target }
          : cur,
      );
      autoScroll(ev.clientY);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      document.body.classList.remove("is-dragging-book");
      if (!started) return;
      justDragged.current = true;
      setTimeout(() => (justDragged.current = false), 0);
      const d = dragRef.current;
      setDrag(null);
      if (d?.target) commitMove(d.row, d.target.status, d.target.index);
    };
    const cancel = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      document.body.classList.remove("is-dragging-book");
      setDrag(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
  }

  /** Scroll the library while dragging near its top / bottom edge. */
  function autoScroll(y: number) {
    const sc = rootRef.current?.closest(".app__body");
    if (!sc) return;
    const r = sc.getBoundingClientRect();
    if (y < r.top + 60) sc.scrollBy({ top: -14 });
    else if (y > r.bottom - 60) sc.scrollBy({ top: 14 });
  }

  function commitMove(row: LibraryRow, status: ReadStatus, index: number) {
    const list = shelves.get(status)!.filter((r) => r.asin !== row.asin).map((r) => r.asin);
    const i = Math.max(0, Math.min(index, list.length));
    list.splice(i, 0, row.asin);
    const before = shelves.get(row.status)!.map((r) => r.asin);
    if (row.status === status && before.join() === list.join()) return;
    onArrange(row.asin, status, list);
    if (row.status !== status) setAnnounce(`${row.title}: ${t.moved} ${statusLabel(t, status)}`);
  }

  // ── Keyboard: ←/→ pick a book, Home/End, Enter opens, i = details,
  // Alt+←/→ moves it along the shelf, Alt+↑/↓ to the shelf above / below.
  function onKey(e: KeyboardEvent<HTMLElement>, row: LibraryRow, status: ReadStatus) {
    const shelf = shelves.get(status)!;
    const at = shelf.findIndex((r) => r.asin === row.asin);
    const go = (asin: string | undefined) => {
      if (!asin) return;
      e.preventDefault();
      wantFocus.current = true;
      setFocusAsin(asin);
    };
    if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      e.preventDefault();
      const to = at + (e.key === "ArrowLeft" ? -1 : 1);
      if (to < 0 || to >= shelf.length) return;
      wantFocus.current = true;
      commitMove(row, status, to);
      return;
    }
    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      const si = STATUS_ORDER.indexOf(status) + (e.key === "ArrowUp" ? -1 : 1);
      const to = STATUS_ORDER[si];
      if (!to) return;
      wantFocus.current = true;
      commitMove(row, to, shelves.get(to)!.length);
      return;
    }
    const fi = flat.findIndex((r) => r.asin === row.asin);
    switch (e.key) {
      case "ArrowRight":
        return go(flat[fi + 1]?.asin);
      case "ArrowLeft":
        return go(flat[fi - 1]?.asin);
      case "Home":
        return go(flat[0]?.asin);
      case "End":
        return go(flat[flat.length - 1]?.asin);
      case "Enter":
      case " ":
        e.preventDefault();
        return open(row, e.currentTarget);
      default:
        if (e.key.toLowerCase() === "i") {
          e.preventDefault();
          actions.details(row, e.currentTarget.querySelector("[data-cover-asin]"));
        }
    }
  }

  // Shelf contents while dragging: the book leaves its shelf and a gap of
  // its size opens where it would land.
  function itemsFor(status: ReadStatus): Item[] {
    const books = shelves.get(status)!;
    if (!drag) return books.map((row) => ({ kind: "book", row }));
    const items: Item[] = books.filter((r) => r.asin !== drag.row.asin).map((row) => ({ kind: "book", row }));
    if (drag.target?.status === status) {
      items.splice(Math.min(drag.target.index, items.length), 0, { kind: "gap", row: drag.row });
    }
    return items;
  }

  const inner = Math.max(200, (width ?? 0) - 48);

  return (
    <div className={`case${drag ? " case--dragging" : ""}`} ref={rootRef}>
      {width != null && STATUS_ORDER.map((status) => {
        const count = shelves.get(status)!.length;
        // Empty shelves only show up as drop targets while dragging.
        if (!count && !drag) return null;
        const items = itemsFor(status);
        const lines = pack(items, status, inner);
        if (!lines.length) lines.push([]);
        return (
          <section
            key={status}
            className={`case__shelf${drag?.target?.status === status ? " is-target" : ""}`}
            data-shelf={status}
            aria-label={statusLabel(t, status)}
          >
            <header className="shelf__head">
              <h2>
                {statusLabel(t, status)} <span className="shelf__count">{count}</span>
              </h2>
              {count > 0 && (
                <button className="linkbtn" onClick={() => onSeeAll(status)}>
                  {t.seeAll}
                  <Icon name="arrowR" size={14} />
                </button>
              )}
            </header>
            {lines.map((line, li) => (
              <div className="case__bay" key={li}>
                <div className={`case__row${faceOut(status) ? " case__row--face" : ""}`}>
                  {line.length === 0 && <div className="case__empty muted">{t.shelfEmpty}</div>}
                  {line.map((it) =>
                    it.kind === "gap" ? (
                      <div
                        key="__gap"
                        className="case__gap"
                        data-flip="__gap"
                        style={{ width: slotWidth(it.row, status), height: Math.round(BOOK_H * heightFactor(it.row.asin)) }}
                      />
                    ) : (
                      <div
                        key={it.row.asin}
                        className={`case__slot${pulled === it.row.asin ? " is-pulled" : ""}`}
                        data-flip={it.row.asin}
                        data-slot={it.row.asin}
                        role="button"
                        tabIndex={activeFocus === it.row.asin ? 0 : -1}
                        aria-label={`${it.row.title}${it.row.author ? ` — ${it.row.author}` : ""}`}
                        title={it.row.author ? `${it.row.title}\n${it.row.author}` : it.row.title}
                        style={
                          {
                            width: slotWidth(it.row, status),
                            ...(faceOut(status) ? null : { "--push": `${pushWidth(it.row)}px` }),
                          } as CSSProperties
                        }
                        onPointerDown={(e) => onPointerDown(e, it.row, status)}
                        onClick={(e) => {
                          if (justDragged.current) return;
                          setFocusAsin(it.row.asin);
                          open(it.row, e.currentTarget);
                        }}
                        onKeyDown={(e) => onKey(e, it.row, status)}
                        onFocus={() => setFocusAsin(it.row.asin)}
                      >
                        <Book3D row={it.row} look={lookOf(it.row)} mode={faceOut(status) ? "face" : "spine"} height={BOOK_H} />
                        {faceOut(status) && it.row.percent != null && it.row.percent > 0 && (
                          <div className="case__progress" aria-hidden="true">
                            <div style={{ width: `${Math.min(100, it.row.percent)}%` }} />
                          </div>
                        )}
                      </div>
                    ),
                  )}
                </div>
                <div className="case__plank" aria-hidden="true" />
              </div>
            ))}
          </section>
        );
      })}
      <p className="case__hint muted small">{t.shelfHint}</p>
      <div className="sr-only" aria-live="polite">
        {announce}
      </div>

      {drag && (
        <div
          className="case__ghost"
          ref={ghostRef}
          aria-hidden="true"
          style={{ transform: `translate(${drag.x0}px, ${drag.y0}px) rotate(-4deg)` }}
        >
          <Book3D
            row={drag.row}
            look={lookOf(drag.row)}
            mode={faceOut(drag.target?.status ?? drag.from) ? "face" : "spine"}
            height={BOOK_H}
            coverTag={false}
          />
        </div>
      )}
    </div>
  );
}
