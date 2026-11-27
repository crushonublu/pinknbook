import { STR, type Lang } from "../i18n";
import { fmt, shortDate } from "./format";
import { GoalRing } from "./GoalRing";
import { secOfDay } from "./streak";
import type { StatsSummary } from "./types";
import { WeekDots } from "./WeekDots";

/**
 * Today on the desktop page: the goal ring, what is left of it (or that it is
 * done) with the streak it keeps, and the week as seven dots.
 */
export function TodayCard({ lang, s }: { lang: Lang; s: StatsSummary }) {
  const t = STR[lang];
  const sec = s.today_app_sec + s.today_kindle_sec;
  const left = Math.max(1, Math.ceil((s.goal_minutes * 60 - sec) / 60));
  const done = s.streak.today_done || sec >= s.goal_minutes * 60;
  return (
    <section className="scx scx-today">
      <div className="scx__row">
        <span className="scx__label">{t.sxToday}</span>
        <span className="scx__sub">{shortDate(lang, s.today)}</span>
      </div>
      <div className="scx-goal__today">
        <GoalRing lang={lang} s={s} />
        <div className="scx-goal__text">
          <div className="scx__big">{done ? t.msGoalDone : fmt(t.pcLeft, left)}</div>
          <div className="scx__sub">
            {done ? t.sxHomeKept : s.streak.current > 0 ? fmt(t.pcKeep, s.streak.current) : t.sxHomeNone}
          </div>
          {s.today_kindle_sec > 0 && <div className="scx__sub">{fmt(t.ofWhichEst, Math.round(s.today_kindle_sec / 60))}</div>}
        </div>
      </div>
      <WeekDots lang={lang} today={s.today} goalSec={s.goal_minutes * 60} secOf={secOfDay(s)} />
    </section>
  );
}
