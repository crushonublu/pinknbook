import { invoke } from "@tauri-apps/api/core";
import { isAndroid } from "./platform";

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
export async function grTranslate(text: string, target: "vi" | "en"): Promise<GrTranslation> {
  try {
    return await invoke<GrTranslation>("goodreads_translate", { text, target });
  } catch (e) {
    // Google rate-limits the app's own HTTP client on Android (there is no
    // second TLS stack to retry with, as on Windows); the WebView is let through.
    if (!isAndroid || String(e) !== "rate_limited") throw e;
    const out = await webTranslate(text, target);
    void invoke("goodreads_save_translation", { text, target, translated: out.text, lang: out.source_lang }).catch(() => undefined);
    return out;
  }
}

async function webTranslate(text: string, target: "vi" | "en"): Promise<GrTranslation> {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${target}&dt=t`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: new URLSearchParams({ q: text.trim() }).toString(),
  });
  if (r.status === 429) throw "rate_limited";
  if (!r.ok) throw `Google Translate: HTTP ${r.status}`;
  const v = await r.json() as [Array<[string]> | null, unknown, string | null];
  const translated = (v?.[0] ?? []).map((seg) => seg?.[0] ?? "").join("").trim();
  if (!translated) throw "Google Translate: unexpected answer";
  return { text: translated, source_lang: typeof v?.[2] === "string" ? v[2] : null };
}
