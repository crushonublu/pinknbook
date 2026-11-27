import { useEffect, useMemo, useRef, useState } from "react";
import { Book3D } from "../Book3D";
import { heightFactor, lookOf, type SpineLook } from "../spine";
import type { LibraryRow } from "../types";
import type { BookRef } from "./types";

/** Book height on the shelf, before the per-book variation and the fit. */
const BASE_H = 96;
/** Book height of the compact (Home) shelf, and the title size that lets a title be read on its slim spines. */
const COMPACT_H = 88;
const COMPACT_TITLE_PX = 5;
/** Title size on the Stats shelf's spines: small enough for a title to fit their height. */
const SHELF_TITLE_PX = 7;
/** Gap between spines (as on the bookcase). */
const GAP = 2;
/** A paper book, or one no longer in the library, is a mid-width plain spine. */
const MID_WIDTH = 26;
/** Never draw the shelf smaller than this; wrap onto more shelves instead. */
const MIN_SCALE = 0.75;
const MAX_SHELVES = 3;

interface Slot {
  key: string;
  /** Set for a book finished, absent for a place still to fill. */
  book?: { row: Pick<LibraryRow, "asin" | "cde_type" | "cover" | "title" | "author" | "spine_color">; look: SpineLook };
  asin: string;
  /** Spine width at the base height. */
  width: number;
}

const slotWidth = (look: { width: number }, h: number) => Math.max(8, Math.round((look.width * h) / 190));

/** The shelf as lines of slots, and the scale that makes the widest fit `width`. */
function layout(slots: Slot[], width: number, base: number) {
  const w = (s: Slot, scale: number) => slotWidth(s, Math.round(base * scale * heightFactor(s.asin))) + GAP;
  const natural = slots.map((s) => w(s, 1));
  const total = natural.reduce((a, b) => a + b, 0);
  const pack = (limit: number) => {
    const lines: Slot[][] = [[]];
    let used = 0;
    slots.forEach((s, i) => {
      if (used + natural[i] > limit && lines[lines.length - 1].length) {
        lines.push([]);
        used = 0;
      }
      lines[lines.length - 1].push(s);
      used += natural[i];
    });
    return lines;
  };
  // One shelf if it fits without shrinking much; else as many as it takes at
  // full size (at most three), else three shelves and a fit to the width.
  let lines = total * MIN_SCALE <= width ? [slots] : pack(width);
  if (lines.length > MAX_SHELVES) lines = pack(Math.ceil(total / MAX_SHELVES) * 1.08);
  const widest = Math.max(...lines.map((l) => l.reduce((n, s) => n + w(s, 1), 0)));
  return { lines, scale: Math.min(1, width / widest) };
}

/**
 * The yearly goal as books on a shelf: the spines of the books finished (the
 * same Book3D spines as the bookcase) in finish order, then an outline for
 * each book still to read. A big goal wraps onto up to three shelves, each
 * with its own plank, rather than shrinking the spines to slivers.
 */
export function YearShelf({ asins, goal, rows, books, ariaLabel, compact = false }: {
  /** Books finished, in finish order. */
  asins: string[];
  /** One short line of small spines, no plank and no wrapping (the Home miniature). */
  compact?: boolean;
  goal: number;
  /** The library's books by asin (their own spine style, font and thickness). */
  rows: Map<string, LibraryRow>;
  /** Period books, for the colour of a book that is not in the library (paper). */
  books: Record<string, BookRef>;
  ariaLabel: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(320);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth || 320));
    ro.observe(el);
    setWidth(el.clientWidth || 320);
    return () => ro.disconnect();
  }, []);

  const slots = useMemo(() => {
    const real: Slot[] = asins.map((asin, i) => {
      const row = rows.get(asin);
      if (row) return { key: `${asin}-${i}`, asin, book: { row, look: lookOf(row) }, width: lookOf(row).width };
      const ref = books[asin];
      const look: SpineLook = { color: ref?.spine_color ?? "#4a3a64", style: "plain", font: "serif", width: MID_WIDTH };
      const row2 = { asin, cde_type: "", cover: ref?.cover ?? null, title: ref?.title ?? asin, author: ref?.author ?? "", spine_color: look.color };
      return { key: `${asin}-${i}`, asin, book: { row: row2, look }, width: MID_WIDTH };
    });
    const mean = real.length ? Math.round(real.reduce((n, s) => n + s.width, 0) / real.length) : MID_WIDTH;
    const empty: Slot[] = Array.from({ length: Math.max(0, goal - real.length) }, (_, i) => ({ key: `empty-${i}`, asin: `empty-${i}`, width: mean }));
    return [...real, ...empty];
  }, [asins, goal, rows, books]);

  const base = compact ? COMPACT_H : BASE_H;
  const { lines, scale } = useMemo(() => (compact ? { lines: [slots], scale: 1 } : layout(slots, width, base)), [slots, width, compact, base]);

  return (
    <div className={`scx-shelf${compact ? " scx-shelf--compact" : ""}`} ref={box} role="img" aria-label={ariaLabel}>
      {lines.map((line, i) => (
        <div key={i} className="scx-shelf__line">
          <div className="scx-shelf__books" style={{ height: Math.round(base * scale) }}>
            {line.map((s) => {
              const h = Math.round(base * scale);
              return s.book ? (
                <div key={s.key} className="scx-shelf__slot" title={s.book.row.title}>
                  <Book3D row={s.book.row} look={s.book.look} mode="spine" height={h} coverTag={false} titlePx={compact ? COMPACT_TITLE_PX : SHELF_TITLE_PX} />
                </div>
              ) : (
                <i key={s.key} className="scx-shelf__empty" style={{ width: slotWidth(s, Math.round(h * heightFactor(s.asin))), height: Math.round(h * heightFactor(s.asin)) }} />
              );
            })}
          </div>
          {!compact && <div className="scx-shelf__plank" />}
        </div>
      ))}
    </div>
  );
}
