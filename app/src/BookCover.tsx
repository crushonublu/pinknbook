import { useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { LibraryRow } from "./types";

/** URL of a book's cover: the local cover file, else Amazon's CDN for EBOKs. */
export function coverUrl(row: Pick<LibraryRow, "asin" | "cde_type" | "cover">): string | null {
  if (row.cover) return convertFileSrc(row.cover, "cover");
  if (row.cde_type === "EBOK" && /^B[A-Z0-9]{9}$/.test(row.asin)) {
    return `https://images-na.ssl-images-amazon.com/images/P/${row.asin}.01._SCLZZZZZZZ_.jpg`;
  }
  return null;
}

/**
 * A book cover. Without an image it draws a typographic cover in the book's
 * spine colour (title + author set in the book face) instead of initials.
 */
export function BookCover({
  row,
  className = "",
  src,
}: {
  row: Pick<LibraryRow, "asin" | "cde_type" | "cover" | "title" | "author" | "spine_color">;
  className?: string;
  /** Show this image instead (e.g. a picked file being previewed). */
  src?: string;
}) {
  const url = src ?? coverUrl(row);
  const [failed, setFailed] = useState<string | null>(null);
  if (url && failed !== url) {
    return (
      <img
        className={`cover ${className}`}
        src={url}
        alt={row.title}
        loading="lazy"
        draggable={false}
        onError={() => setFailed(url)}
      />
    );
  }
  return (
    <div
      className={`cover cover--type ${className}`}
      style={{ ["--spine" as string]: row.spine_color }}
      role="img"
      aria-label={row.title}
    >
      <div className="cover--type__rule" />
      <div className="cover--type__title">{row.title || row.asin}</div>
      {row.author && <div className="cover--type__author">{row.author}</div>}
    </div>
  );
}
