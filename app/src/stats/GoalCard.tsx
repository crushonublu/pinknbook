import { useState } from "react";
import { STR, type Lang } from "../i18n";
import { fmt, fmtDuration, addDays, weekStart } from "./format";
import { yearPace } from "./goal";
import { GoalRing } from "./GoalRing";
import type { LibraryRow } from "../types";
import type { BookRef, PeriodDay, StatsSummary } from "./types";
import { WeekDots } from "./WeekDots";
import { YearShelf } from "./YearShelf";

type Scope = "today" | "week" | "year";

/**
 * The goals: today's minutes (a ring), this week (seven dots) and the yearly
 * book goal (a shelf with one spine per book of the goal, filled for each
 * book finished).
 */
export function GoalCard({ lang, s, days, rows, books, onChangeGoal, yearOnly = false }: {
  lang: Lang;
  s: StatsSummary;
  /** Reading days around today, for the week. */
  days: Map<string, PeriodDay>;
  /** The library's books by asin, for their real spines. */
  rows: Map<string, LibraryRow>;
  /** Period books, for books that are not in the library. */
  books: Record<string, BookRef>;
  onChangeGoal: () => void;
  /** Only the yearly goal, under a plain heading (the desktop page shows today and the week in their own card). */
  yearOnly?: boolean;
}) {
  const t = STR[lang];
  const [scope, setScope] = useState<Scope>("year");
  const goal = s.goal_minutes;
  const todaySec = s.today_app_sec + s.today_kindle_sec;
  const todayMin = Math.floor(todaySec / 60);
  const secOf = (day: string) => {
    if (day === s.today) return todaySec;
    const d = days.get(day);
    return d ? d.app_sec + d.kindle_sec + d.manual_sec : 0;
  };
  const start = weekStart(s.today);
  const week = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const weekMet = week.filter((d) => d <= s.today && secOf(d) >= goal * 60).length;
  const weekSec = week.reduce((n, d) => n + secOf(d), 0);

  const booksGoal = s.goal_books_year;
  const done = s.books_finished_year;
  const pace = yearPace(booksGoal, done, s.today);

  return (
    <section className="scx scx-goal">
      {yearOnly ? (
        <div className="scx__row">
          <span className="scx__label">{t.pcYearGoal}</span>
          <button className="scx__btn scx__btn--small" onClick={onChangeGoal} aria-label={t.msChangeGoal}>{t.pcEdit}</button>
        </div>
      ) : (
        <div className="scx-seg" role="group" aria-label={t.sxGoalBy}>
          {(["today", "week", "year"] as const).map((k) => (
            <button key={k} aria-pressed={scope === k} onClick={() => setScope(k)}>
              {k === "today" ? t.sxToday : k === "week" ? t.sxWeek : t.sxYear}
            </button>
          ))}
        </div>
      )}

      {scope === "today" && (
        <div className="scx-goal__today">
          <GoalRing lang={lang} s={s} />
          <div className="scx-goal__text">
            <div className="scx__big">{fmt(t.todayOf, todayMin, goal)}</div>
            <div className="scx__sub">{todayMin >= goal ? t.msGoalDone : fmt(t.sxTodayLeft, goal - todayMin)}</div>
            {s.today_kindle_sec > 0 && <div className="scx__sub">{fmt(t.ofWhichEst, Math.round(s.today_kindle_sec / 60))}</div>}
          </div>
        </div>
      )}

      {scope === "week" && (
        <>
          <WeekDots lang={lang} today={s.today} goalSec={goal * 60} secOf={secOf} />
          <div className="scx__big">{fmt(t.sxWeekMet, weekMet)}</div>
          <div className="scx__sub">{fmt(t.sxWeekTotal, fmtDuration(lang, weekSec))}</div>
        </>
      )}

      {scope === "year" && (
        <>
          <YearShelf asins={s.finished_year_asins} goal={booksGoal} rows={rows} books={books} ariaLabel={fmt(t.sxShelfAria, done, booksGoal)} />
        </>
      )}

      <div className="scx-goal__foot">
        <div>
          {scope === "year" && (
            <>
              <div className="scx__hero"><span className="scx__acc">{done}</span> / {fmt(t.sxBooksN, booksGoal)}</div>
              <div className="scx__sub">
                {pace.behind > 0 ? fmt(t.sxBehind, pace.behind) : t.sxOnTrack}
                {" · "}
                {pace.done ? t.sxYearDone : fmt(t.sxYearLeft, booksGoal - done, pace.daysLeft)}
              </div>
            </>
          )}
        </div>
        {!yearOnly && <button className="scx__btn" onClick={onChangeGoal}>{t.msChangeGoal}</button>}
      </div>
    </section>
  );
}
