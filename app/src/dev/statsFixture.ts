// Deterministic reading data for the stats preview page (stats-preview.html).
// It stands in for the Rust side: `statsPreview.tsx` answers `stats_summary`,
// `stats_period` and the rest from here, so the stats UI can be looked at in a
// plain browser. Nothing in the app imports this file.
//
// The story: "today" is Thursday 26 Nov 2026. Fourteen months of reading with
// gaps, a running 12-day streak (14-25 Nov; today is 14 of 20 minutes so far),
// a longest streak of 34 days (12 Aug - 14 Sep), 19 books finished in 2026
// against a goal of 24, two books still being read and two paper books.
// Streaks are recomputed from the days for any daily goal (without the weekly
// shield, which is always shown as available).
//
// `?empty=1` is a new reader instead: the same library with nothing read, no
// finished book and no recap. Paper reading added by hand, genres picked on a
// book's page and recaps deleted are kept for the life of the page.

import { addDays, dayKey, daysBetween, parseDay, weekStart } from "../stats/format";
import type {
  BadgeId, BookRef, DayMarks, DayRange, GenreInfo, GenreShare, PeriodDay, PeriodKind, PeriodStats, StatsSummary, WrapDoc, WrapKind, WrapSummary,
} from "../stats/types";
import type { LibraryRow, SpineFont, SpineStyle } from "../types";

export const TODAY = "2026-11-26";
/** A reader who has not read anything yet. */
export const EMPTY = new URLSearchParams(location.search).get("empty") === "1";
/** Reading starts here; the first book is finished on 24 Oct 2025. */
const FIRST_DAY = "2025-10-01";
/** Hour-of-day data exists from here on, as when it was added to the app. */
const HOURS_SINCE = "2026-03-01";

/** What the Settings of the page change. */
export const settings = { goalMinutes: 20, goalBooksYear: 24, kindleEstimates: true };

// ---- Random numbers ------------------------------------------------------------------------

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable 0..1 from a string. */
function unit(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10007) / 10007;
}

// ---- Genres ---------------------------------------------------------------------------------

export const GENRES: GenreInfo[] = [
  { id: "literary", vi: "Văn học", en: "Literature", fiction: true },
  { id: "fantasy", vi: "Kỳ ảo", en: "Fantasy", fiction: true },
  { id: "scifi", vi: "Khoa học viễn tưởng", en: "Science Fiction", fiction: true },
  { id: "romance", vi: "Lãng mạn", en: "Romance", fiction: true },
  { id: "mystery", vi: "Trinh thám & Giật gân", en: "Mystery & Thriller", fiction: true },
  { id: "horror", vi: "Kinh dị", en: "Horror", fiction: true },
  { id: "historical_fiction", vi: "Tiểu thuyết lịch sử", en: "Historical Fiction", fiction: true },
  { id: "kids_ya", vi: "Thiếu nhi & YA", en: "Children's & YA", fiction: true },
  { id: "comics", vi: "Truyện tranh & Manga", en: "Comics & Manga", fiction: true },
  { id: "poetry_drama", vi: "Thơ & Kịch", en: "Poetry & Drama", fiction: true },
  { id: "memoir", vi: "Tiểu sử & Hồi ký", en: "Biography & Memoir", fiction: false },
  { id: "history", vi: "Lịch sử", en: "History", fiction: false },
  { id: "science", vi: "Khoa học & Công nghệ", en: "Science & Technology", fiction: false },
  { id: "self_help", vi: "Tâm lý & Phát triển bản thân", en: "Psychology & Self-Help", fiction: false },
  { id: "business", vi: "Kinh doanh & Kinh tế", en: "Business & Economics", fiction: false },
  { id: "philosophy", vi: "Triết học & Tôn giáo", en: "Philosophy & Religion", fiction: false },
  { id: "nonfiction", vi: "Phi hư cấu khác", en: "Other Nonfiction", fiction: false },
];

// ---- Books ----------------------------------------------------------------------------------

interface Book {
  asin: string;
  title: string;
  author: string;
  color: string;
  genre: string | null;
  /** The day it was finished; null while it is being read. */
  finish: string | null;
  /** A paper book: not in the library, its time is typed in by hand. */
  paper?: boolean;
  /** Read next to the books of the day, on about this share of days, from this day on (it has no window of its own). */
  alongside?: { from: string; share: number };
}

/** In the order they were finished; the last two are still being read. */
const BOOKS: Book[] = [
  { asin: "PV0001", title: "Hoàng tử bé", author: "Antoine de Saint-Exupéry", color: "#d9b44a", genre: "kids_ya", finish: "2025-10-24" },
  { asin: "PV0002", title: "Sapiens", author: "Yuval Noah Harari", color: "#c76b2b", genre: "history", finish: "2025-11-12" },
  { asin: "PV0003", title: "Nhà giả kim", author: "Paulo Coelho", color: "#3b6e8f", genre: "literary", finish: "2025-12-03" },
  { asin: "PV0004", title: "Atomic Habits", author: "James Clear", color: "#2f6b4f", genre: "self_help", finish: "2025-12-27" },
  { asin: "PV0005", title: "Kiêu hãnh và định kiến", author: "Jane Austen", color: "#a8475a", genre: "romance", finish: "2026-01-09" },
  { asin: "PV0006", title: "Sherlock Holmes toàn tập", author: "Arthur Conan Doyle", color: "#4a3a64", genre: "mystery", finish: "2026-01-24" },
  { asin: "PV0007", title: "Rừng Na Uy", author: "Haruki Murakami", color: "#2f6b4f", genre: "literary", finish: "2026-02-17" },
  { asin: "PV0008", title: "Neuromancer", author: "William Gibson", color: "#16324f", genre: "scifi", finish: "2026-03-05" },
  { asin: "PV0009", title: "Đắc nhân tâm", author: "Dale Carnegie", color: "#e8c547", genre: "self_help", finish: "2026-03-16" },
  { asin: "PV0010", title: "Hobbit", author: "J. R. R. Tolkien", color: "#7a4b2a", genre: "fantasy", finish: "2026-03-28" },
  { asin: "PV0011", title: "Trăm năm cô đơn", author: "Gabriel García Márquez", color: "#b5651d", genre: "literary", finish: "2026-04-08" },
  { asin: "PV0012", title: "Kafka bên bờ biển", author: "Haruki Murakami", color: "#6b3f8f", genre: "literary", finish: "2026-04-22" },
  { asin: "PV0013", title: "Foundation", author: "Isaac Asimov", color: "#1f4e79", genre: "scifi", finish: "2026-05-14" },
  { asin: "PV0014", title: "Bố già", author: "Mario Puzo", color: "#222222", genre: "mystery", finish: "2026-06-06" },
  { asin: "PV0015", title: "Cuốn theo chiều gió", author: "Margaret Mitchell", color: "#8c2f39", genre: "historical_fiction", finish: "2026-06-25" },
  { asin: "PV0016", title: "Ba người lính ngự lâm", author: "Alexandre Dumas", color: "#3d5a80", genre: "historical_fiction", finish: "2026-07-03" },
  { asin: "PV0017", title: "Cuộc đời của Pi", author: "Yann Martel", color: "#1d7874", genre: "literary", finish: "2026-07-15" },
  { asin: "PV0018", title: "Cha giàu cha nghèo", author: "Robert Kiyosaki", color: "#5e8c31", genre: "business", finish: "2026-07-29" },
  { asin: "PV0019", title: "Frankenstein", author: "Mary Shelley", color: "#3a3f47", genre: "horror", finish: "2026-08-18" },
  { asin: "PV0020", title: "Suy tưởng", author: "Marcus Aurelius", color: "#8f6b3f", genre: "philosophy", finish: "2026-09-07" },
  { asin: "PV0021", title: "Tuổi trẻ đáng giá bao nhiêu", author: "Rosie Nguyễn", color: "#e07a9b", genre: "self_help", finish: "2026-09-21", paper: true },
  { asin: "PV0022", title: "Mật mã Da Vinci", author: "Dan Brown", color: "#5a2a2a", genre: "mystery", finish: "2026-10-12" },
  { asin: "PV0023", title: "Hành trình về phương Đông", author: "Baird T. Spalding", color: "#c2813a", genre: "philosophy", finish: "2026-11-09" },
  { asin: "PV0024", title: "Dune", author: "Frank Herbert", color: "#c76b2b", genre: "scifi", finish: null, alongside: { from: "2026-09-15", share: 0.5 } },
  { asin: "PV0025", title: "Ghi chép lặt vặt", author: "Nhiều tác giả", color: "#4a6b8f", genre: null, finish: null, alongside: { from: "2026-11-12", share: 0.4 } },
  { asin: "PV0026", title: "Truyện ngắn chọn lọc", author: "Nam Cao", color: "#9c4f6b", genre: "literary", finish: "2025-12-20", paper: true, alongside: { from: "2025-12-10", share: 0.6 } },
];

const byAsin = new Map(BOOKS.map((b) => [b.asin, b]));

/** Genres the reader picked on a book's page (null = back to the automatic one). */
const GENRE_CHOICE = new Map<string, string>();
/** The genre of a book: the reader's choice, else the story's. */
const genreOf = (asin: string) => GENRE_CHOICE.get(asin) ?? byAsin.get(asin)?.genre ?? null;

export function bookGenre(asin: string) {
  return { genre: genreOf(asin), user: GENRE_CHOICE.has(asin) };
}

export function setBookGenre(asin: string, genre: string | null) {
  if (genre) GENRE_CHOICE.set(asin, genre);
  else GENRE_CHOICE.delete(asin);
}
/** The books finished, in finish order. */
const FINISHED = EMPTY ? [] : BOOKS.filter((b) => b.finish).sort((a, b) => a.finish!.localeCompare(b.finish!));
/** Books finished before pntome kept dates. */
const UNDATED = EMPTY ? 0 : 3;

const ref = (asin: string): BookRef => {
  const b = byAsin.get(asin)!;
  return { title: b.title, author: b.author, cover: null, spine_color: b.color };
};

/** The books in the library (paper books are not), as the bookcase would hold them. */
export function libraryRows(): LibraryRow[] {
  const styles: SpineStyle[] = ["plain", "cloth", "leather", "foil"];
  const fonts: SpineFont[] = ["serif", "sans", "caps"];
  return BOOKS.filter((b) => !b.paper).map((b, i) => ({
    asin: b.asin,
    cde_type: "PDOC",
    title: b.title,
    author: b.author,
    auto_title: b.title,
    auto_author: b.author,
    original_title: b.title,
    original_author: b.author,
    edited: false,
    content_type: "application/pdf",
    purchase_date: "2025-09-01",
    percent: EMPTY ? 0 : b.finish ? 100 : 40,
    furthest_pos: null,
    description: null,
    subjects: [],
    language: "vi",
    publisher: null,
    cover: null,
    spine_color: b.color,
    auto_spine_color: b.color,
    auto_cover: null,
    typographic_cover: true,
    text_length: Math.round(180_000 + unit(b.asin) * 2_400_000),
    spine_style: styles[i % styles.length],
    spine_font: fonts[i % fonts.length],
    spine_width: null,
    shelf_pos: null,
    meta_ready: true,
    status: EMPTY ? "unread" : b.finish ? "finished" : "reading",
    status_manual: false,
    last_read: null,
    source: "local",
    file_missing: false,
    linked_asin: null,
    kindle_match: null,
  }));
}

// ---- Days -------------------------------------------------------------------------------------

/** Reading hours' weights: a night owl (00:00-03:59 is about half of it). */
const HOUR_WEIGHT = [70, 52, 30, 16, 2, 0, 0, 1, 2, 2, 2, 3, 3, 3, 2, 2, 3, 4, 6, 9, 14, 22, 34, 40];

interface RawDay {
  /** Minutes read, all books. */
  min: number;
  books: { asin: string; share: number }[];
  /** The Kindle estimate is a share of the day's non-paper reading. */
  kindle: boolean;
  /** Seconds measured per hour of the day (in the app only). */
  hours: number[];
}

const LONGEST = { from: "2026-08-12", to: "2026-09-14" };
const RUNNING = { from: "2026-11-14", to: "2026-11-25" };
const GAPS: [string, string][] = [
  ["2025-12-28", "2026-01-03"],
  ["2026-02-03", "2026-02-11"],
  ["2026-05-20", "2026-06-02"],
  ["2026-08-11", "2026-08-11"],
  ["2026-09-15", "2026-09-15"],
  ["2026-11-13", "2026-11-13"],
];
const within = (d: string, r: { from: string; to: string }) => d >= r.from && d <= r.to;

const RAW = new Map<string, RawDay>();
(function build() {
  if (EMPTY) return;
  const rnd = mulberry32(2026);
  // One book after another, each from the day after the last was finished; Dune is the one in hand since the last finish.
  const sequential = FINISHED.filter((b) => !b.alongside);
  const current = byAsin.get("PV0024")!;
  for (let day = FIRST_DAY; day <= TODAY; day = addDays(day, 1)) {
    const forced = within(day, LONGEST) || within(day, RUNNING);
    const gap = GAPS.some(([a, b]) => day >= a && day <= b);
    if (day === TODAY) continue;
    if (gap || (!forced && rnd() > 0.62)) continue;
    const min = forced ? 20 + Math.round(rnd() * 38) + (rnd() < 0.08 ? 40 : 0) : 5 + Math.round(rnd() * 48);
    const main = sequential.find((b) => b.finish! >= day) ?? current;
    const books = [{ asin: main.asin, share: 1 }];
    for (const b of BOOKS) {
      if (!b.alongside || b === main || day < b.alongside.from || (b.finish && day > b.finish) || rnd() > b.alongside.share) continue;
      books[0].share = 0.6;
      books.push({ asin: b.asin, share: 0.4 });
      break;
    }
    // Hours: chunks of up to half an hour from a start hour drawn from the weights.
    const hours = new Array<number>(24).fill(0);
    if (day >= HOURS_SINCE) {
      const total = HOUR_WEIGHT.reduce((a, b) => a + b, 0);
      let pick = rnd() * total;
      let h = 0;
      while (h < 23 && pick > HOUR_WEIGHT[h]) pick -= HOUR_WEIGHT[h++];
      let left = min * 60;
      while (left > 0) {
        const chunk = Math.min(left, 1800);
        hours[h % 24] += chunk;
        left -= chunk;
        h++;
      }
    }
    RAW.set(day, { min, books, kindle: rnd() < 0.22, hours });
  }
  // Today so far: 14 minutes in the app.
  RAW.set(TODAY, { min: 14, books: [{ asin: "PV0024", share: 1 }], kindle: false, hours: new Array<number>(24).fill(0).map((_, h) => (h === 21 ? 14 * 60 : 0)) });
})();

/** Paper reading added by hand on the page, by day (what `log_manual_reading` stores). */
const MANUAL = new Map<string, { asin: string; seconds: number }[]>();

/** One day as the backend reports it: the reading of the story plus what was added by hand. */
function periodDay(day: string): PeriodDay {
  const base = storyDay(day);
  const extra = MANUAL.get(day);
  if (!extra) return base;
  const books = new Map(base.books.map((b) => [b.asin, b.seconds]));
  for (const e of extra) books.set(e.asin, (books.get(e.asin) ?? 0) + e.seconds);
  const manual = base.manual_sec + extra.reduce((n, e) => n + e.seconds, 0);
  return {
    ...base,
    manual_sec: manual,
    met: base.app_sec + base.kindle_sec + manual >= settings.goalMinutes * 60,
    books: [...books].map(([asin, seconds]) => ({ asin, seconds })).sort((a, b) => b.seconds - a.seconds),
  };
}

/** One day of the story, honouring the Kindle-estimate setting. */
function storyDay(day: string): PeriodDay {
  const raw = RAW.get(day);
  if (!raw) return { day, app_sec: 0, kindle_sec: 0, manual_sec: 0, met: false, books: [] };
  const sec = raw.min * 60;
  const books = raw.books.map((b) => ({ asin: b.asin, seconds: Math.round(sec * b.share) }));
  const manual = books.filter((b) => byAsin.get(b.asin)!.paper).reduce((n, b) => n + b.seconds, 0);
  const digital = sec - manual;
  const kindle = raw.kindle && settings.kindleEstimates ? Math.round(digital * 0.3) : 0;
  // With estimates off, only the in-app share of a Kindle day counts.
  const app = raw.kindle && !settings.kindleEstimates ? Math.round(digital * 0.7) : digital - kindle;
  const total = app + kindle + manual;
  return {
    day,
    app_sec: app,
    kindle_sec: kindle,
    manual_sec: manual,
    met: total >= settings.goalMinutes * 60,
    books: books.sort((a, b) => b.seconds - a.seconds),
  };
}

const total = (d: PeriodDay) => d.app_sec + d.kindle_sec + d.manual_sec;

/** Highlights, notes and saved words of a day (also what `stats_day` answers). */
export function dayMarks(day: string): DayMarks {
  const raw = RAW.get(day);
  if (!raw) return { highlights: 0, notes: 0, words: 0 };
  return {
    highlights: Math.round(unit(`${day}h`) * (raw.min / 6)),
    notes: unit(`${day}n`) < 0.25 ? 1 + Math.round(unit(`${day}m`) * 2) : 0,
    words: unit(`${day}w`) < 0.5 ? Math.round(unit(`${day}x`) * 5) : 0,
  };
}

// ---- Paper reading added by hand --------------------------------------------------------------

const MANUAL_MAX_MINUTES = 600;

/** The slug the backend makes of a title for a paper book's asin. */
const paperAsin = (title: string) => `paper:${title.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "")}`;

/** `log_manual_reading`, with the checks and messages of stats.rs `log_manual`. */
export function logManual(day: string, asin: string | null, title: string | null, minutes: number) {
  if (!(minutes >= 1 && minutes <= MANUAL_MAX_MINUTES)) throw new Error(`minutes must be 1..=${MANUAL_MAX_MINUTES}`);
  if (day > TODAY || day < addDays(TODAY, -7)) throw new Error("reading can only be added for today and the 7 days before");
  let key = asin?.trim() || "";
  if (!key) {
    const t = title?.trim() ?? "";
    if (!t) throw new Error("a book or a title is needed");
    key = paperAsin(t);
    if (key === "paper:") throw new Error("the title needs letters or digits");
    if (!byAsin.has(key)) byAsin.set(key, { asin: key, title: t, author: "", color: "#8f6b3f", genre: null, finish: null, paper: true });
  } else if (!byAsin.has(key)) throw new Error(`unknown book: ${key}`);
  const list = MANUAL.get(day) ?? [];
  if (list.reduce((n, e) => n + e.seconds, 0) + minutes * 60 > MANUAL_MAX_MINUTES * 60) {
    throw new Error(`at most ${MANUAL_MAX_MINUTES} minutes can be added by hand for one day`);
  }
  const have = list.find((e) => e.asin === key);
  if (have) have.seconds += minutes * 60;
  else list.push({ asin: key, seconds: minutes * 60 });
  MANUAL.set(day, list);
}

export function deleteManual(day: string, asin: string) {
  const list = (MANUAL.get(day) ?? []).filter((e) => e.asin !== asin);
  if (list.length) MANUAL.set(day, list);
  else MANUAL.delete(day);
}

/** `manual_readings`: what was added by hand on a day (the story's own paper books are not "added" here). */
export function manualOn(day: string) {
  return (MANUAL.get(day) ?? []).map((e) => ({ asin: e.asin, title: byAsin.get(e.asin)!.title, seconds: e.seconds }));
}

// ---- Streaks ----------------------------------------------------------------------------------

/** The running and the longest run of goal days (consecutive, no shield), for the current goal. */
function streaks() {
  let longest = 0;
  let longestRange: DayRange | null = null;
  let run = 0;
  let runStart = FIRST_DAY;
  for (let day = FIRST_DAY; day <= TODAY; day = addDays(day, 1)) {
    if (periodDay(day).met) {
      if (run === 0) runStart = day;
      run++;
      if (run > longest) {
        longest = run;
        longestRange = { start: runStart, end: day };
      }
    } else if (day !== TODAY) {
      run = 0;
    }
  }
  // The streak running into today: today counts once its goal is met.
  const todayDone = periodDay(TODAY).met;
  let current = 0;
  let start: string | null = null;
  for (let day = todayDone ? TODAY : addDays(TODAY, -1); day >= FIRST_DAY && periodDay(day).met; day = addDays(day, -1)) {
    current++;
    start = day;
  }
  return { current, longest, today_done: todayDone, freeze_left: true, current_start: start, longest_range: longestRange };
}

// ---- Periods ----------------------------------------------------------------------------------

function range(kind: PeriodKind, anchor: string | null): { start: string; end: string; prev: { start: string; end: string } | null } {
  const a = anchor || TODAY;
  if (kind === "all") return { start: EMPTY ? TODAY : FIRST_DAY, end: TODAY, prev: null };
  if (kind === "week") {
    const start = weekStart(a);
    return { start, end: addDays(start, 6), prev: { start: addDays(start, -7), end: addDays(start, -1) } };
  }
  const d = parseDay(a);
  if (kind === "month") {
    const start = dayKey(new Date(d.getFullYear(), d.getMonth(), 1));
    const end = dayKey(new Date(d.getFullYear(), d.getMonth() + 1, 0));
    return { start, end, prev: { start: dayKey(new Date(d.getFullYear(), d.getMonth() - 1, 1)), end: addDays(start, -1) } };
  }
  const y = d.getFullYear();
  return { start: `${y}-01-01`, end: `${y}-12-31`, prev: { start: `${y - 1}-01-01`, end: `${y - 1}-12-31` } };
}

const eachDay = (start: string, end: string) => Array.from({ length: daysBetween(start, end) + 1 }, (_, i) => addDays(start, i));

function bestRun(days: PeriodDay[]) {
  let best = 0;
  let run = 0;
  for (const d of days) {
    run = d.met ? run + 1 : 0;
    best = Math.max(best, run);
  }
  return best;
}

export function periodStats(kind: PeriodKind, anchor: string | null): PeriodStats {
  const { start, end, prev } = range(kind, anchor);
  const days = eachDay(start, end).map(periodDay);
  const totalSec = days.reduce((n, d) => n + total(d), 0);
  const prevTotal = prev ? eachDay(prev.start, prev.end).reduce((n, d) => n + total(periodDay(d)), 0) : 0;
  const daysRead = days.filter((d) => total(d) > 0).length;

  const perBook = new Map<string, number>();
  for (const d of days) for (const b of d.books) perBook.set(b.asin, (perBook.get(b.asin) ?? 0) + b.seconds);
  const read = [...perBook.entries()].filter(([, s]) => s >= 60).sort((a, b) => b[1] - a[1]);

  const finished = FINISHED.filter((b) => b.finish! >= start && b.finish! <= end).map((b) => ({ asin: b.asin, title: b.title, day: b.finish! }));
  const topBooks = read.slice(0, 5).map(([asin, seconds]) => ({ asin, title: byAsin.get(asin)!.title, author: byAsin.get(asin)!.author, seconds }));

  const genreBooks = new Map<string, { books: number; seconds: number }>();
  let unknown = 0;
  for (const [asin, seconds] of read) {
    const g = genreOf(asin);
    if (!g) unknown++;
    else genreBooks.set(g, { books: (genreBooks.get(g)?.books ?? 0) + 1, seconds: (genreBooks.get(g)?.seconds ?? 0) + seconds });
  }
  const genres: GenreShare[] = [...genreBooks.entries()].map(([id, v]) => ({ id, ...v })).sort((a, b) => b.books - a.books || b.seconds - a.seconds);

  const hours = new Array<number>(24).fill(0);
  for (const d of days) RAW.get(d.day)?.hours.forEach((s, h) => (hours[h] += s));
  const timed = hours.reduce((a, b) => a + b, 0);
  const share = (from: number, to: number) => (timed ? hours.slice(from, to).reduce((a, b) => a + b, 0) / timed : 0);

  const marks = days.map((d) => dayMarks(d.day));
  const highlights = marks.reduce((n, m) => n + m.highlights + m.notes, 0);
  const best = days.reduce<PeriodDay | null>((b, d) => (total(d) > (b ? total(b) : 0) ? d : b), null);

  const months =
    kind === "year" || kind === "all"
      ? [...new Set(days.map((d) => d.day.slice(0, 7)))].map((month) => {
          const inMonth = days.filter((d) => d.day.startsWith(month));
          return {
            month,
            days_read: inMonth.filter((d) => total(d) > 0).length,
            seconds: inMonth.reduce((n, d) => n + total(d), 0),
            finished: finished.filter((f) => f.day.startsWith(month)).length,
          };
        })
      : [];

  const asins = new Set<string>([...days.flatMap((d) => d.books.map((b) => b.asin)), ...finished.map((f) => f.asin), ...topBooks.map((b) => b.asin)]);
  const books: Record<string, BookRef> = {};
  for (const a of asins) books[a] = ref(a);

  const runs = streaks();
  return {
    kind,
    start,
    end,
    is_complete: end < TODAY,
    prev_start: prev?.start ?? null,
    prev_end: prev?.end ?? null,
    days,
    total_sec: totalSec,
    prev_total_sec: prevTotal,
    days_read: daysRead,
    days_met: days.filter((d) => d.met).length,
    streak_best_in_period: bestRun(days),
    current_streak: runs.current,
    finished,
    finished_undated: kind === "all" ? UNDATED : 0,
    top_books: topBooks,
    genres,
    genre_unknown_books: unknown,
    hours,
    hours_since: EMPTY ? null : HOURS_SINCE,
    highlights,
    notes: marks.reduce((n, m) => n + m.notes, 0),
    words: marks.reduce((n, m) => n + m.words, 0),
    best_day: best ? { day: best.day, seconds: total(best) } : null,
    months,
    persona: {
      night_share: share(0, 4),
      early_share: share(4, 6),
      top_genre: genres[0]?.id ?? null,
      trend_pct: prevTotal > 0 ? ((totalSec - prevTotal) * 100) / prevTotal : null,
      avg_min_per_reading_day: daysRead ? totalSec / 60 / daysRead : 0,
      fast_finishes: EMPTY ? 0 : kind === "all" ? 4 : 2,
    },
    books,
  };
}

// ---- Summary ----------------------------------------------------------------------------------

/** Badge id, tier thresholds and the value reached (so tiers run from locked to gold). */
const BADGES: [BadgeId, number[], number][] = [
  ["streak", [7, 30, 100, 365], 34],
  ["hours", [1, 10, 100, 500], 86],
  ["big_day", [60, 120, 180, 240], 58],
  ["books", [1, 5, 25, 50], 23],
  ["fast_finish", [1, 3, 10, 20], 2],
  ["comeback", [1, 3, 5, 10], 0],
  ["highlights", [10, 100, 500, 1000], 640],
  ["notes", [5, 25, 50, 200], 4],
  ["rainbow", [1, 3, 10, 25], 0],
  ["night_owl", [1, 7, 30, 100], 9],
  ["early_bird", [1, 7, 30, 100], 0],
  ["weekend", [1, 4, 12, 52], 6],
  ["variety", [3, 7, 14, 30], 5],
];

export function summary(): StatsSummary {
  const today = periodDay(TODAY);
  const past = eachDay(addDays(TODAY, -364), TODAY).map(periodDay).filter((d) => total(d) > 0);
  const year = periodStats("year", TODAY);
  const all = periodStats("all", null);
  const s = streaks();
  return {
    today: TODAY,
    goal_minutes: settings.goalMinutes,
    kindle_estimates: settings.kindleEstimates,
    today_app_sec: today.app_sec + today.manual_sec,
    today_kindle_sec: today.kindle_sec,
    streak: s,
    days: past.map((d) => ({ day: d.day, app_sec: d.app_sec + d.manual_sec, kindle_sec: d.kindle_sec, merged: false })),
    total_seconds: all.total_sec,
    books_finished: FINISHED.length + UNDATED,
    goal_books_year: settings.goalBooksYear,
    books_finished_year: year.finished.length,
    finished_year_asins: year.finished.map((f) => f.asin),
    speed: 1.2,
    top_books: all.top_books.map((b) => ({ asin: b.asin, title: b.title, seconds: b.seconds })),
    badges: BADGES.map(([id, thresholds, value]) => ({ id, tier: thresholds.filter((t) => (EMPTY ? 0 : value) >= t).length, value: EMPTY ? 0 : value, thresholds })),
    unlocked: [],
    backfilled: 0,
  };
}

// ---- Wrap-ups ---------------------------------------------------------------------------------

/** Wraps the reader deleted on the page. */
const DELETED_WRAPS = new Set<string>();
export const deleteWrap = (kind: string, start: string) => void DELETED_WRAPS.add(`${kind}:${start}`);

export function wrapSummaries(): WrapSummary[] {
  const make = (kind: WrapKind, period_start: string, period_end: string, preview: boolean, seen: boolean): WrapSummary => ({
    kind, period_start, period_end, preview, seen, seed: 1, has_layout: false,
  });
  if (EMPTY) return [];
  return [
    make("month", "2026-11-01", "2026-11-30", true, false),
    make("month", "2026-10-01", "2026-10-31", false, true),
    make("week", "2026-11-16", "2026-11-22", false, true),
    make("week", "2026-11-09", "2026-11-15", false, true),
    make("month", "2026-09-01", "2026-09-30", false, true),
    make("year", "2025-01-01", "2025-12-31", false, true),
    make("month", "2025-12-01", "2025-12-31", false, true),
    make("week", "2025-12-22", "2025-12-28", false, true),
    make("month", "2025-11-01", "2025-11-30", false, true),
  ].filter((w) => !DELETED_WRAPS.has(`${w.kind}:${w.period_start}`));
}

export function wrapDoc(kind: WrapKind, periodStart: string): WrapDoc {
  const stats = periodStats(kind, periodStart);
  return { kind, period_start: stats.start, period_end: stats.end, preview: !stats.is_complete, seen: false, seed: 1, layout_json: null, stats };
}
