// Small helpers the stats cards share: days as `YYYY-MM-DD` keys, durations,
// and filling `{0}` placeholders of the i18n strings.

import { STR, type Lang } from "../i18n";

/** Replace `{0}`, `{1}`... in an i18n string. */
export function fmt(template: string, ...values: (string | number)[]): string {
  return values.reduce<string>((s, v, i) => s.replace(`{${i}}`, String(v)), template);
}

/** The unit of a "{0} unit" string ("phút" of "{0} phút"), for a headline number set apart from it. */
export const unitOf = (template: string) => template.replace("{0}", "").trim();

/** A `YYYY-MM-DD` key as a local date at midnight. */
export const parseDay = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
};

export const dayKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** The day `n` days after (or before, when negative) a key. */
export function addDays(key: string, n: number): string {
  const d = parseDay(key);
  d.setDate(d.getDate() + n);
  return dayKey(d);
}

/** Whole days from `a` to `b` (negative when `b` is earlier). */
export const daysBetween = (a: string, b: string) =>
  Math.round((parseDay(b).getTime() - parseDay(a).getTime()) / 86_400_000);

/** Monday of the week containing a day. */
export function weekStart(key: string): string {
  return addDays(key, -((parseDay(key).getDay() + 6) % 7));
}

/** "6 giờ 5 phút" / "12 phút". */
export function fmtDuration(lang: Lang, sec: number) {
  const t = STR[lang];
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h ? fmt(t.durHM, h, m) : fmt(t.durM, m);
}

/** Minutes of a number of seconds, rounded (at least 1 for any reading at all). */
export const minutesOf = (sec: number) => (sec > 0 ? Math.max(1, Math.round(sec / 60)) : 0);

/** Comma-separated i18n list (weekday and month names). */
export const names = (list: string) => list.split(",");

/** "Thứ Tư, 25 tháng 11" for a day key. */
export function longDate(lang: Lang, key: string) {
  const s = parseDay(key).toLocaleDateString(lang === "vi" ? "vi-VN" : "en-US", { weekday: "long", day: "numeric", month: "long" });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** "Tháng 11" / "November" for a `YYYY-MM` key. */
export function monthTitle(lang: Lang, month: string) {
  const s = parseDay(`${month}-01`).toLocaleDateString(lang === "vi" ? "vi-VN" : "en-US", { month: "long" });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The days of the calendar year of a key. */
export const daysInYear = (year: number) => (new Date(year, 11, 31).getTime() - new Date(year, 0, 0).getTime()) / 86_400_000;

/** "Thứ Năm, 26/11" for a day key. */
export const shortDate = (lang: Lang, key: string) =>
  parseDay(key).toLocaleDateString(lang === "vi" ? "vi-VN" : "en-US", { weekday: "long", day: "numeric", month: "numeric" });
