import { useMemo, useState } from "react";
import type { Lang } from "../i18n";
import type { LibraryRow } from "../types";
import { daysBetween } from "./format";
import { useGenres } from "./useGenres";
import { useStatsPeriod } from "./useStatsPeriod";
import type { PeriodDay, StatsSummary } from "./types";

/** The rolling 7 and 30 day charts look back this far, plus the span before. */
const LOOKBACK_DAYS = 60;

/**
 * What the Stats page needs, on the phone and the desktop: the chosen range
 * (all time, this year or an earlier one) with its numbers, plus the ones that
 * do not follow the range (this year for the goals, the days around today for
 * the 7 and 30 day chart, all time for the years that have reading).
 */
export function useStatsPage(lang: Lang, s: StatsSummary | null, rows: LibraryRow[]) {
  const currentYear = s ? Number(s.today.slice(0, 4)) : new Date().getFullYear();
  const [pick, setPick] = useState<"all" | number | null>(null);
  const sel = pick ?? currentYear;

  const genres = useGenres(lang);
  const ready = !!s;
  const needPrevYear = !!s && daysBetween(`${currentYear}-01-01`, s.today) < LOOKBACK_DAYS;
  const main = useStatsPeriod(sel === "all" ? "all" : "year", sel === "all" ? undefined : `${sel}-01-01`, s, ready);
  const cur = useStatsPeriod("year", `${currentYear}-01-01`, s, ready && sel !== currentYear);
  const prev = useStatsPeriod("year", `${currentYear - 1}-01-01`, s, ready && needPrevYear);
  const allTime = useStatsPeriod("all", undefined, s, ready && sel !== "all");

  const thisYear = sel === currentYear ? main.stats : cur.stats;
  const everything = sel === "all" ? main.stats : allTime.stats;

  // Days around today (this year, and last when the span reaches back into it).
  const recent = useMemo(() => {
    const m = new Map<string, PeriodDay>();
    for (const p of [prev.stats, thisYear]) for (const d of p?.days ?? []) m.set(d.day, d);
    return m;
  }, [prev.stats, thisYear]);
  const rowsByAsin = useMemo(() => new Map(rows.map((r) => [r.asin, r])), [rows]);
  const mainDays = useMemo(() => new Map((main.stats?.days ?? []).map((d) => [d.day, d])), [main.stats]);

  // Years with reading or finished books, newest first, this year always.
  const years = useMemo(() => {
    const ys = new Set<number>([currentYear]);
    for (const m of everything?.months ?? []) if (m.seconds > 0 || m.finished > 0) ys.add(Number(m.month.slice(0, 4)));
    return [...ys].sort((a, b) => b - a);
  }, [everything, currentYear]);

  return { currentYear, sel, setPick, years, genres, main, thisYear, recent, rowsByAsin, mainDays };
}
