export interface AccountInfo {
  directed_id: string;
  device_name: string;
}

export interface LibraryRow {
  asin: string;
  cde_type: string; // "EBOK" | "PDOC" | ...
  /** Display values: the user's override, else cleaned-up metadata. */
  title: string;
  author: string;
  /** What is shown without user edits (target of "reset"). */
  auto_title: string;
  auto_author: string;
  /** Raw values from the Amazon library. */
  original_title: string;
  original_author: string;
  /** The user edited title, author or cover. */
  edited: boolean;
  content_type: string;
  purchase_date: string;
  percent: number | null;
  furthest_pos: number | null;
  description: string | null;
  subjects: string[];
  language: string | null;
  publisher: string | null;
  /** Cover file name, served through the `cover` URI scheme. */
  cover: string | null;
  /** Spine colour (#rrggbb) for the shelf view. */
  spine_color: string;
  /** Spine colour without the user's choice (from the cover). */
  auto_spine_color: string;
  /** Cover from the book file / Amazon, ignoring the user's choice. */
  auto_cover: string | null;
  /** The user chose the drawn (typographic) cover. */
  typographic_cover: boolean;
  /** Text length of the book file (drives spine thickness), if known. */
  text_length: number | null;
  /** User spine customisation (null = automatic). */
  spine_style: SpineStyle | null;
  spine_font: SpineFont | null;
  spine_width: number | null;
  /** Hand-arranged position on its shelf. */
  shelf_pos: number | null;
  /** Metadata extraction has run for this book. */
  meta_ready: boolean;
  /** Reading status (manual, else derived from progress). */
  status: ReadStatus;
  status_manual: boolean;
  /** Last read in the app (UTC "YYYY-MM-DD HH:MM:SS"), if ever. */
  last_read: string | null;
  /** Synced from the Kindle library, or added from this computer. */
  source: "amazon" | "local";
  /** A local book whose copy in the app's data folder is gone. */
  file_missing: boolean;
  /** Local books: the Kindle book it is linked to (shown as one card). */
  linked_asin: string | null;
  /** Local books: a Kindle book that looks like the same title (not linked yet). */
  kindle_match: string | null;
}

export type SpineStyle = "plain" | "cloth" | "leather" | "foil";
export type SpineFont = "serif" | "sans" | "caps";
export const SPINE_STYLES: SpineStyle[] = ["plain", "cloth", "leather", "foil"];
export const SPINE_FONTS: SpineFont[] = ["serif", "sans", "caps"];

export type ReadStatus ="unread" | "reading" | "finished" | "abandoned";
export const STATUS_ORDER: ReadStatus[] = ["reading", "unread", "finished", "abandoned"];
export type LibraryView = "shelves" | "grid" | "list";

/** out = first run, nothing chosen yet; guest = using the app without Amazon. */
export type AuthState = "loading" | "out" | "guest" | "in";
export type SortKey = "recent" | "title" | "author" | "progress";
export type TypeFilter = "all" | "EBOK" | "PDOC" | "LOCAL";
