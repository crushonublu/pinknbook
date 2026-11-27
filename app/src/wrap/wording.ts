// Names of wrap-ups in the words of a language: for the offers on Home, the list
// in Stats and the viewer's title.

import { STR, type Lang } from "../i18n";
import { fmt, monthTitle } from "../stats/format";
import type { WrapKind, WrapSummary } from "../stats/types";
import { isoWeek, weekRange } from "./data";

/** "11/2026" in Vietnamese, "November 2026" in English. */
const monthYear = (lang: Lang, start: string) => (lang === "vi" ? `${Number(start.slice(5, 7))}/${start.slice(0, 4)}` : `${monthTitle(lang, start.slice(0, 7))} ${start.slice(0, 4)}`);

/** The month as a word of a sentence: "11" / "November". */
const monthWord = (lang: Lang, start: string) => (lang === "vi" ? String(Number(start.slice(5, 7))) : monthTitle(lang, start.slice(0, 7)));

/** The viewer's title. */
export function wrapTitle(lang: Lang, kind: WrapKind) {
  const t = STR[lang];
  return kind === "week" ? t.wrTitleWeek : kind === "month" ? t.wrTitleMonth : t.wrTitleYear;
}

/** The offer on Home: "Tổng kết tháng 11 đã sẵn sàng", or its "so far" form while the period runs. */
export function offerTitle(lang: Lang, w: WrapSummary): string {
  const t = STR[lang];
  if (w.kind === "week") return w.preview ? t.wrHomeWeekPreview : fmt(t.wrHomeWeek, isoWeek(w.period_start));
  const word = w.kind === "month" ? monthWord(lang, w.period_start) : w.period_start.slice(0, 4);
  const template = w.kind === "month" ? (w.preview ? t.wrHomeMonthPreview : t.wrHomeMonth) : w.preview ? t.wrHomeYearPreview : t.wrHomeYear;
  return fmt(template, word);
}

/** A row of the list in Stats: "Tuần 47 · 16 – 22/11", "Tháng 11/2026", "Năm 2026". */
export function listLabel(lang: Lang, w: WrapSummary): string {
  const t = STR[lang];
  if (w.kind === "week") return fmt(t.wrLabelWeek, isoWeek(w.period_start), weekRange(lang, w.period_start, w.period_end));
  return w.kind === "month" ? fmt(t.wrLabelMonth, monthYear(lang, w.period_start)) : fmt(t.wrLabelYear, w.period_start.slice(0, 4));
}

/** The kind badge of a row in the list: "Tuần 47", "Tháng", "Năm". */
export function kindBadge(lang: Lang, w: WrapSummary): string {
  const t = STR[lang];
  return w.kind === "week" ? fmt(t.wrBadgeWeek, isoWeek(w.period_start)) : w.kind === "month" ? t.wrKindMonth : t.wrKindYear;
}

/** What a row of the list says besides its badge: the days of the week, "11/2026", "2026". */
export function rowPeriod(lang: Lang, w: WrapSummary): string {
  if (w.kind === "week") return weekRange(lang, w.period_start, w.period_end);
  return w.kind === "month" ? monthYear(lang, w.period_start) : w.period_start.slice(0, 4);
}

/** The icon on a wrap's offer and list row. */
export const WRAP_ICON: Record<WrapKind, string> = { week: "flame", month: "calendar", year: "gift" };

/** The month of a day as a wrap that is still running: what the Stats header button opens when there is nothing saved yet. */
export function currentMonthWrap(today: string): WrapSummary {
  const [y, m] = today.split("-").map(Number);
  const last = new Date(y, m, 0).getDate();
  const ym = today.slice(0, 7);
  return { kind: "month", period_start: `${ym}-01`, period_end: `${ym}-${String(last).padStart(2, "0")}`, preview: true, seen: false, seed: 0, has_layout: false };
}
