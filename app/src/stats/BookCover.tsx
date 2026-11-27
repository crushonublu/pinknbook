import { BookCover } from "../BookCover";
import type { BookRef } from "./types";

/**
 * A book of a period (`BookRef`) as its cover image, from the `cover`
 * protocol, or as a block in its spine colour when there is no image. Sized by
 * its parent, which gives the cover's width and height.
 */
export function RefCover({ asin, book, className = "" }: { asin: string; book: BookRef | undefined; className?: string }) {
  return (
    <BookCover
      className={className}
      row={{
        asin,
        // Amazon's picture is only tried for books that look like Kindle ASINs.
        cde_type: /^B[A-Z0-9]{9}$/.test(asin) ? "EBOK" : "",
        cover: book?.cover ?? null,
        title: book?.title ?? "",
        author: book?.author ?? "",
        spine_color: book?.spine_color ?? "#4a3a64",
      }}
    />
  );
}
