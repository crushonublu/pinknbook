import { daysBetween } from "./format";
import type { StatsSummary } from "./types";

/**
 * Which day of the running streak `day` is (1 = the day it began), or null
 * when it is not a goal day of that streak. Counted back from today with the
 * summary's days (the last year), so a day older than that is not numbered.
 */
export function streakDayNumber(s: StatsSummary, day: string): number | null {
  const start = s.streak.current_start;
  if (!start || day < start || day > s.today || daysBetween(day, s.today) > 360) return null;
  const goalSec = s.goal_minutes * 60;
  const met = (d: { app_sec: number; kindle_sec: number }) => d.app_sec + d.kindle_sec >= goalSec;
  const self = s.days.find((d) => d.day === day);
  if (!self || !met(self)) return null;
  // Goal days after this one are what is left of the streak.
  const after = s.days.filter((d) => d.day > day && d.day <= s.today && met(d)).length;
  return s.streak.current - after;
}

/** Nothing on record at all: no reading, in the app, on Kindle or on paper, and no finished book. */
export const isNewReader = (s: StatsSummary) => s.total_seconds === 0 && s.books_finished === 0;

/** Seconds read on a day, from the summary (today's live total, else the last year's days). */
export const secOfDay = (s: StatsSummary) => (day: string) => {
  if (day === s.today) return s.today_app_sec + s.today_kindle_sec;
  const d = s.days.find((x) => x.day === day);
  return d ? d.app_sec + d.kindle_sec : 0;
};
