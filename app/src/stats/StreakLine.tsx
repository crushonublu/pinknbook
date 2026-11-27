import { STR, type Lang } from "../i18n";
import { fmt } from "./format";
import type { StatsSummary } from "./types";

/**
 * What is left of today's streak, in one line: kept, how many minutes still
 * to read (the number in bold), or what it takes to start one.
 */
export function StreakLine({ lang, s }: { lang: Lang; s: StatsSummary }) {
  const t = STR[lang];
  if (s.streak.today_done) return <>{t.sxHomeKept}</>;
  if (s.streak.current === 0) return <>{fmt(t.sxHomeStart, s.goal_minutes)}</>;
  const left = Math.max(1, Math.ceil((s.goal_minutes * 60 - (s.today_app_sec + s.today_kindle_sec)) / 60));
  const [before, after] = t.sxHomeLeft.split("{0}");
  return <>{before}<b>{fmt(t.minutesN, left)}</b>{after}</>;
}
