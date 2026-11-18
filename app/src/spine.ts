/**
 * How a book looks standing on the shelf: spine thickness from the book's
 * length, a little height variation so a row doesn't look machine-cut, and a
 * legible ink colour for the lettering on its spine colour.
 */
import type { LibraryRow, SpineFont, SpineStyle } from "./types";

/** Everything the 3D book needs to draw its spine. */
export interface SpineLook {
  color: string;
  style: SpineStyle;
  font: SpineFont;
  /** Spine thickness in px at the shelf's base book height. */
  width: number;
}

/** Stable 0..1 value from a string (book ASIN). */
export function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10007) / 10007;
}

/**
 * Thickness from the PalmDOC text length (bytes of markup + text): ~190 KB is
 * a slim novella, ~4 MB a doorstop. Log scale onto 15–42 px. Unknown length:
 * a mid-sized book with a bit of per-book variation.
 */
export function autoWidth(row: Pick<LibraryRow, "asin" | "text_length">): number {
  const len = row.text_length;
  if (!len || len <= 0) return Math.round(22 + hash01(row.asin) * 10);
  const t = Math.min(1, Math.max(0, (Math.log10(len) - 5.2) / (6.65 - 5.2)));
  return Math.round(15 + t * 27);
}

/** Books are not all the same height: 90–100 % of the shelf's book height. */
export function heightFactor(asin: string): number {
  return 0.9 + hash01(asin + "h") * 0.1;
}

export function lookOf(row: LibraryRow): SpineLook {
  return {
    color: row.spine_color,
    style: row.spine_style ?? "plain",
    font: row.spine_font ?? "serif",
    width: row.spine_width ?? autoWidth(row),
  };
}

/** Relative luminance (sRGB) of #rrggbb. */
function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return 0.2;
  const n = parseInt(m[1], 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

/** Lettering colour on a spine: warm paper on dark spines, ink on light ones. */
export function inkFor(look: SpineLook): string {
  if (look.style === "foil") return "#e9c46a";
  return luminance(look.color) > 0.36 ? "#1d1a16" : "#f6efe2";
}

/** A few spine colours to pick from (bookbinding cloths). */
export const SPINE_SWATCHES = [
  "#7a1f2b", "#b5452f", "#c98a2c", "#2f5d50", "#1f3a5f",
  "#3b2f5c", "#2a2a2e", "#e8dcc4", "#5b4636", "#8a9a7b",
];
