// What the wrap-up templates say, worked out from a period's numbers: which
// books go on the cover wall, the one highlight fact, week numbers and dates.

import { STR, type Lang } from "../i18n";
import { addDays, daySeconds, fmt, minutesOf, parseDay } from "../stats/format";
import type { PeriodStats } from "../stats/types";
import { pickFact, type ShownFact } from "./factPick";

/** A book on a card: how it got there. */
export interface WallBook {
  asin: string;
  /** Finished on this day; absent for a book that was read but not finished. */
  finished?: string;
  seconds: number;
}

export { daySeconds };

/** Seconds read of each book in the period (from the days). */
function secondsByBook(p: PeriodStats): Map<string, number> {
  const m = new Map<string, number>();
  for (const d of p.days) for (const b of d.books) m.set(b.asin, (m.get(b.asin) ?? 0) + b.seconds);
  return m;
}

/** The books of a period for the covers: the finished ones (in order), then the others by time read, at most `max`. */
export function wallBooks(p: PeriodStats, max: number): { shown: WallBook[]; more: number } {
  const seconds = secondsByBook(p);
  const all: WallBook[] = p.finished.map((f) => ({ asin: f.asin, finished: f.day, seconds: seconds.get(f.asin) ?? 0 }));
  const done = new Set(all.map((b) => b.asin));
  for (const b of p.top_books) if (!done.has(b.asin)) all.push({ asin: b.asin, seconds: b.seconds });
  return { shown: all.slice(0, max), more: Math.max(0, all.length - max) };
}

/** "8/11" for a day key. */
export const dayMonth = (key: string) => {
  const d = parseDay(key);
  return `${d.getDate()}/${d.getMonth() + 1}`;
};

/** "9g 40p" / "9h 40m"; "35p" under an hour. */
export function shortDuration(lang: Lang, sec: number): string {
  const t = STR[lang];
  const min = minutesOf(sec);
  return min >= 60 ? fmt(t.wrDurHM, Math.floor(min / 60), min % 60) : fmt(t.wrDurM, min);
}

/** ISO week number of a day. */
export function isoWeek(key: string): number {
  const d = parseDay(key);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const first = new Date(d.getFullYear(), 0, 4);
  return 1 + Math.round(((d.getTime() - first.getTime()) / 86_400_000 - 3 + ((first.getDay() + 6) % 7)) / 7);
}

/** "16 – 22/11" for a week, with both months when it crosses one. */
export function weekRange(lang: Lang, start: string, end: string): string {
  const [a, b] = [parseDay(start), parseDay(end)];
  const left = a.getMonth() === b.getMonth() ? String(a.getDate()) : dayMonth(start);
  return fmt(STR[lang].wrRange, left, dayMonth(end));
}

/** Seven days from the Monday of a week. */
export const weekDays = (start: string) => Array.from({ length: 7 }, (_, i) => addDays(start, i));

/** A line of a card with bold values: `{0}`, `{1}`... of the template are the bold parts. */
export function boldParts(template: string, values: string[]): { text: string; bold: boolean }[] {
  const out: { text: string; bold: boolean }[] = [];
  let rest = template;
  for (let i = 0; i < values.length; i++) {
    const [before, after] = rest.split(`{${i}}`);
    if (before) out.push({ text: before, bold: false });
    out.push({ text: values[i], bold: true });
    rest = after ?? "";
  }
  if (rest) out.push({ text: rest, bold: false });
  return out;
}

/** The one extra fact a card states (see `pickFact`), worded; `shown` are the facts its numbers already give. */
export function highlightFact(lang: Lang, p: PeriodStats, shown: readonly ShownFact[] = []): { text: string; bold: boolean }[] {
  const t = STR[lang];
  switch (pickFact(p, shown)) {
    case "trend": return boldParts(t.wrFactTrend, [String(Math.round(p.persona.trend_pct ?? 0))]);
    case "best": return boldParts(t.wrFactBest, [shortDuration(lang, p.best_day!.seconds), dayMonth(p.best_day!.day)]);
    case "night": return boldParts(t.wrFactNight, [String(Math.round(p.persona.night_share * 100))]);
    case "early": return boldParts(t.wrFactEarly, [String(Math.round(p.persona.early_share * 100))]);
    case "words": return boldParts(t.wrFactWords, [String(p.words)]);
    case "highlights": return boldParts(t.wrFactHighlights, [String(p.highlights)]);
    case "finished": return boldParts(t.wrFactFinished, [String(p.finished.length)]);
    case "days": return boldParts(t.wrFactDays, [String(p.days_read)]);
    default: return [{ text: t.wrFactNone, bold: false }];
  }
}

/** Total of a period as hours, rounded, for the year card. */
export const hoursOf = (sec: number) => Math.round(sec / 3600);
