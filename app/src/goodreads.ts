import { invoke } from "@tauri-apps/api/core";

/** A Goodreads book, as its search suggestions describe it (src-tauri/src/goodreads.rs). */
export interface GrBook {
  book_id: string;
  title: string;
  author: string;
  rating: number | null;
  ratings_count: number;
  pages: number | null;
  description: string | null;
  series: string | null;
  series_pos: string | null;
  url: string;
  image_url: string | null;
}

export interface GrReview {
  name: string;
  avatar: string | null;
  profile_url: string | null;
  rating: number | null;
  text: string;
  likes: number;
  created: number | null;
}

/** What only the Goodreads book page has (often unavailable: bot challenge). */
export interface GrDetails {
  description: string | null;
  genres: string[];
  published: number | null;
  rating: number | null;
  ratings_count: number | null;
  /** 1★ … 5★ counts. */
  rating_dist: number[];
  reviews_count: number | null;
  reviews: GrReview[];
}

export interface GrState {
  status: "found" | "none";
  book: GrBook | null;
  manual: boolean;
  details: GrDetails | null;
  details_status: "ok" | "blocked" | "pending" | "none";
}

export const grInfo = (asin: string, refresh = false) => invoke<GrState>("goodreads_info", { asin, refresh });
export const grDetails = (asin: string, retry = false) => invoke<GrState>("goodreads_details", { asin, retry });
export const grCandidates = (asin: string, query?: string) =>
  invoke<GrBook[]>("goodreads_candidates", { asin, query: query ?? null });
export const grChoose = (asin: string, book: GrBook | null) => invoke<GrState>("goodreads_choose", { asin, book });
export const grReset = (asin: string) => invoke<void>("goodreads_reset", { asin });

export interface GrTranslation {
  text: string;
  /** Detected language of the original, e.g. "en". */
  source_lang: string | null;
}

/** Google-translate a review into the UI language (cached on the Rust side). */
export const grTranslate = (text: string, target: "vi" | "en") =>
  invoke<GrTranslation>("goodreads_translate", { text, target });
