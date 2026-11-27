// Types of the stats, genre and wrap-up commands. Each interface mirrors a Rust
// struct (serde, snake_case); the file named in its comment holds the original.

/** The periods `stats_period` knows. "all" is everything on record. */
export type PeriodKind = "week" | "month" | "year" | "all";
/** The periods that have a wrap-up card. */
export type WrapKind = "week" | "month" | "year";

/** src-tauri/src/period.rs `DayBook`. */
export interface DayBook {
  asin: string;
  seconds: number;
}

/** period.rs `PeriodDay`. */
export interface PeriodDay {
  /** Reading day, YYYY-MM-DD (it starts at 04:00). */
  day: string;
  /** Measured in the in-app reader. */
  app_sec: number;
  /** Estimated from Kindle progress (0 when estimates are off); what is left once `kindle_app_sec` is taken off. */
  kindle_sec: number;
  /** Measured: the Kindle app on this phone was on screen (Android). */
  kindle_app_sec: number;
  /** Typed in by hand (paper books). */
  manual_sec: number;
  /** The daily goal was reached. */
  met: boolean;
  /** Amazon says the account read on some Kindle that day, whatever the minutes are. */
  amazon_read: boolean;
  /** Books read that day, most first (books no longer in the library are left out). */
  books: DayBook[];
}

/** period.rs `FinishedBook`. */
export interface FinishedBook {
  asin: string;
  title: string;
  day: string;
}

/** period.rs `TopBook`. */
export interface TopBook {
  asin: string;
  title: string;
  author: string;
  seconds: number;
}

/** period.rs `GenreShare`. */
export interface GenreShare {
  /** A `GenreInfo.id`. */
  id: string;
  /** Books read (at least a minute) in the period with this genre. */
  books: number;
  seconds: number;
}

/** period.rs `BestDay`. */
export interface BestDay {
  day: string;
  seconds: number;
}

/** period.rs `MonthStat`. */
export interface MonthStat {
  /** YYYY-MM. */
  month: string;
  days_read: number;
  seconds: number;
  finished: number;
}

/** period.rs `Persona`: the facts the rule-based reader profile is written from. */
export interface Persona {
  /** Share (0..1) of the timed reading that fell at night (00:00-03:59). */
  night_share: number;
  /** Same for the early morning (04:00-05:59). */
  early_share: number;
  top_genre: string | null;
  /** Percent change of the total against the previous period; null when there is nothing to compare. */
  trend_pct: number | null;
  avg_min_per_reading_day: number;
  /** Books finished in the period within a week of first being read. */
  fast_finishes: number;
}

/** period.rs `BookRef`: what is needed to draw a book (`cover` is a file served by the `cover` protocol). */
export interface BookRef {
  title: string;
  author: string;
  cover: string | null;
  /** #rrggbb, for when there is no cover image. */
  spine_color: string;
}

/** period.rs `PeriodStats`, returned by `stats_period`. */
export interface PeriodStats {
  kind: PeriodKind;
  /** First and last reading day, inclusive. */
  start: string;
  end: string;
  /** The period is over (its last day is before today). */
  is_complete: boolean;
  /** The period before; null for "all". */
  prev_start: string | null;
  prev_end: string | null;
  /** Every day from start to end, including days still to come. */
  days: PeriodDay[];
  total_sec: number;
  prev_total_sec: number;
  /** Days with any reading, or that Amazon says were read on a Kindle. */
  days_read: number;
  days_met: number;
  /** Longest run of goal days inside the period (same freeze rule as the streak). */
  streak_best_in_period: number;
  current_streak: number;
  finished: FinishedBook[];
  /** "all" only: books already finished before pntome kept dates (in no week, month or year). */
  finished_undated: number;
  top_books: TopBook[];
  /** Most books first. */
  genres: GenreShare[];
  genre_unknown_books: number;
  /** Seconds per local hour of day (24 values); only reading logged with an hour. */
  hours: number[];
  /** First day any reading has an hour; the chart is partial before it. */
  hours_since: string | null;
  /** Highlights (notes included), notes and saved words created in the period. */
  highlights: number;
  notes: number;
  words: number;
  best_day: BestDay | null;
  /** Per month, for "year" and "all"; empty otherwise. */
  months: MonthStat[];
  persona: Persona;
  /** Every book mentioned above, by asin. */
  books: Record<string, BookRef>;
}

/** genre.rs `GenreInfo`, returned by `genre_list`. */
export interface GenreInfo {
  id: string;
  vi: string;
  en: string;
  fiction: boolean;
}

/** wrap.rs `WrapSummary`, returned by `wraps_pending` and `wraps_list`. */
export interface WrapSummary {
  kind: WrapKind;
  /** First reading day of the period. */
  period_start: string;
  period_end: string;
  /** Live numbers of a period that is not over (nothing is saved). */
  preview: boolean;
  seen: boolean;
  /** Background variation; the reroll counter. */
  seed: number;
  has_layout: boolean;
}

/** The wrap-ups the Stats pages list, and what opens one (given by the app, which shows the viewer). */
export interface WrapsAccess {
  list: WrapSummary[];
  onOpen: (w: WrapSummary) => void;
  /** Delete a saved wrap; the list is then given again without it. */
  onDelete: (w: WrapSummary) => void;
}

/** stats.rs `ManualEntry`, returned by `manual_readings`: paper reading added by hand for a book on a day. */
export interface ManualEntry {
  asin: string;
  title: string;
  seconds: number;
}

/** genre.rs `BookGenre`, returned by `book_genre`. */
export interface BookGenre {
  /** A `GenreInfo.id`; null when no genre could be told. */
  genre: string | null;
  /** Chosen by the reader, not worked out. */
  user: boolean;
}

/** wrap.rs `WrapDoc`, returned by `wrap_get`. */
export interface WrapDoc {
  kind: WrapKind;
  period_start: string;
  period_end: string;
  preview: boolean;
  seen: boolean;
  seed: number;
  /** The reader's saved arrangement of the card (JSON text). */
  layout_json: string | null;
  stats: PeriodStats;
}

export type BadgeId =
  | "streak" | "hours" | "big_day" | "books" | "fast_finish" | "comeback" | "highlights"
  | "notes" | "rainbow" | "night_owl" | "early_bird" | "weekend" | "variety";

/** stats.rs `DayRange`: a run of days, both ends included. */
export interface DayRange {
  start: string;
  end: string;
}

/** amazon_days.rs `AmazonDays`: the days Amazon says were read on a Kindle, and how fresh that is. */
export interface AmazonDays {
  /** "none" (never asked), "ok", "needs_signin" or "error". */
  status: "none" | "ok" | "needs_signin" | "error";
  /** When they were last fetched (unix seconds). */
  fetched_at: number | null;
  count: number;
}

/** kindle_app.rs `UsageStatus`, returned by `kindle_usage_status`. */
export interface KindleUsage {
  /** Android only. */
  supported: boolean;
  /** "Usage access" was granted in the system settings. */
  granted: boolean;
  /** The setting (on unless switched off). */
  enabled: boolean;
}

/** stats.rs `KindleTick`, returned by `kindle_activity_tick`. */
export interface KindleTick {
  minutes: number;
  /** Some book's position moved since the last look. */
  moved: boolean;
}

/** stats.rs `Summary`, returned by `stats_summary` (title bar, Home and the cards that need no period). */
export interface StatsSummary {
  today: string;
  goal_minutes: number;
  kindle_estimates: boolean;
  /** Measured today: in the app, paper books and the Kindle app on this phone. */
  today_app_sec: number;
  today_kindle_sec: number;
  amazon_days: AmazonDays;
  streak: {
    current: number;
    longest: number;
    today_done: boolean;
    freeze_left: boolean;
    /** First goal day of the running streak. */
    current_start: string | null;
    longest_range: DayRange | null;
  };
  /** Days with any reading in the last year; `app_sec` includes paper reading typed in by hand and time in the phone's Kindle app. */
  days: { day: string; app_sec: number; kindle_sec: number; merged: boolean }[];
  total_seconds: number;
  books_finished: number;
  goal_books_year: number;
  books_finished_year: number;
  /** Those books, in the order they were finished. */
  finished_year_asins: string[];
  speed: number;
  top_books: { asin: string; title: string; seconds: number }[];
  badges: { id: BadgeId; tier: number; value: number; thresholds: number[] }[];
  unlocked: { id: BadgeId; tier: number }[];
  backfilled: number;
}

/** period.rs `DayMarks`, returned by `stats_day`. */
export interface DayMarks {
  highlights: number;
  notes: number;
  words: number;
}
