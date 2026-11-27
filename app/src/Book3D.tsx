import { forwardRef, type CSSProperties, type HTMLAttributes } from "react";
import type { LibraryRow } from "./types";
import { BookCover } from "./BookCover";
import { heightFactor, inkFor, type SpineLook } from "./spine";

/**
 * A book as a CSS 3D box: spine, front and back boards, page block on top
 * and along the fore-edge.
 *
 * Geometry (all from CSS variables, see App.css `.b3d`): --h height,
 * --t thickness (spine width), --d depth (cover width, 2:3 of height).
 * The box's own plane is the spine; the boards stand at ±90°.
 *
 * Modes:
 * - "spine": standing on a shelf, spine to the viewer (slot is --t wide)
 * - "face":  turned to show its front cover (slot is --d wide)
 * - "free":  the caller rotates it (`turn`, degrees around Y)
 */
export type Book3DMode = "spine" | "face" | "free";

type Props = {
  row: Pick<LibraryRow, "asin" | "cde_type" | "cover" | "title" | "author" | "spine_color">;
  look: SpineLook;
  mode: Book3DMode;
  /** Book height in px before the per-book variation. */
  height: number;
  /** Use the full height (no per-book variation), e.g. in the editor. */
  exactHeight?: boolean;
  /** "free" mode: rotation around Y in degrees (0 = spine, -90 = cover). */
  turn?: number;
  /** Put `data-cover-asin` on the front board (shared-element morphs). */
  coverTag?: boolean;
  /** Front-board image override (preview of a picked file). */
  coverSrc?: string;
  /** Title size on the spine in px, for spines too small for the usual one (the Home shelf). */
  titlePx?: number;
} & Omit<HTMLAttributes<HTMLDivElement>, "children">;

export const Book3D = forwardRef<HTMLDivElement, Props>(function Book3D(
  { row, look, mode, height, exactHeight, turn, coverTag = true, coverSrc, titlePx, className = "", style, ...rest },
  ref,
) {
  const h = Math.round(height * (exactHeight ? 1 : heightFactor(row.asin)));
  // Thickness is tuned for a ~190 px book; scale it with the drawn height.
  const t = Math.max(8, Math.round((look.width * h) / 190));
  const d = Math.round((h * 2) / 3);
  const vars = {
    "--h": `${h}px`,
    "--t": `${t}px`,
    "--d": `${d}px`,
    "--spine": look.color,
    "--ink": inkFor(look),
    ...(mode === "free" ? { "--turn": `${turn ?? -30}deg` } : null),
    ...style,
  } as CSSProperties;
  const titleSize = titlePx ?? Math.max(8, Math.min(13, t * 0.42));
  return (
    <div
      ref={ref}
      className={`b3d b3d--${mode} ${className}`}
      data-style={look.style}
      data-font={look.font}
      style={vars}
      {...rest}
    >
      <div className="b3d__box">
        <div className="b3d__face b3d__spine" aria-hidden="true">
          <span className="b3d__title" style={{ fontSize: titleSize }}>
            {row.title}
          </span>
          {row.author && t >= 18 && (
            <span className="b3d__author" style={{ fontSize: Math.max(7, titleSize * 0.72) }}>
              {shortAuthor(row.author)}
            </span>
          )}
        </div>
        <div className="b3d__face b3d__front" {...(coverTag ? { "data-cover-asin": row.asin } : null)}>
          <BookCover row={row} src={coverSrc} />
        </div>
        <div className="b3d__face b3d__back" />
        <div className="b3d__face b3d__top" />
        <div className="b3d__face b3d__fore" />
      </div>
    </div>
  );
});

/** "Fyodor Dostoevsky" → "Dostoevsky"; keeps short names and "A & B" whole. */
function shortAuthor(a: string): string {
  const first = a.split(/\s*[,;&]\s*/)[0].trim();
  if (first.length <= 16) return first;
  const parts = first.split(/\s+/);
  return parts[parts.length - 1];
}
