import { useEffect, useMemo, useRef, useState } from "react";
import { STR, type Lang } from "../i18n";
import { Icon } from "../icons";
import { RefCover } from "./BookCover";
import { dayKey, daySeconds, fmt, fmtDuration, minutesOf, monthTitle, names, parseDay } from "./format";
import type { PeriodDay, PeriodStats, StatsSummary } from "./types";

/** Day cells of the grid: always whole Monday-first weeks. */
function monthCells(year: number, month: number) {
  const first = new Date(year, month, 1);
  const lead = (first.getDay() + 6) % 7;
  const count = new Date(year, month + 1, 0).getDate();
  const rows = Math.ceil((lead + count) / 7);
  return Array.from({ length: rows * 7 }, (_, i) => {
    const d = new Date(year, month, 1 - lead + i);
    return { key: dayKey(d), n: d.getDate(), inMonth: d.getMonth() === month };
  });
}

const total = daySeconds;
/** A day with minutes, or that Amazon says was read on a Kindle. */
const isRead = (d: PeriodDay) => total(d) > 0 || d.amazon_read;

/** "12/8 – 14/9", with the year when it is not this one. */
function rangeText(start: string, end: string, thisYear: number) {
  const [a, b] = [parseDay(start), parseDay(end)];
  const part = (d: Date) => `${d.getDate()}/${d.getMonth() + 1}${a.getFullYear() === thisYear && b.getFullYear() === thisYear ? "" : `/${d.getFullYear()}`}`;
  return `${part(a)} – ${part(b)}`;
}

/**
 * The streak: the longest one as a headline, whether one is running and the
 * weekly shield, then a calendar month by month. A day of the running streak
 * is filled in the accent colour, any other reading day is tinted, today is
 * outlined, and each day read shows the cover of what was read most.
 *
 * On the desktop page (`desktop`) the tiles are bigger and carry the minutes
 * too, months are stepped with arrows, and a strip of the twelve months (bar
 * = days read) both sums up the year and picks the month.
 */
export function StreakCalendar({ lang, s, period, year, onDay, onHow, onMonthChange, desktop = false }: {
  lang: Lang;
  s: StatsSummary;
  /** The year being shown (or "all", whose year is this one). */
  period: PeriodStats;
  year: number;
  /** A day was chosen; `anchor` is its tile, for a popover. */
  onDay: (day: string, anchor: HTMLElement) => void;
  onHow: (anchor: HTMLElement) => void;
  /** Another month was picked (the tiles a popover pointed at are gone). */
  onMonthChange?: () => void;
  desktop?: boolean;
}) {
  const t = STR[lang];
  const thisYear = Number(s.today.slice(0, 4));
  const thisMonth = Number(s.today.slice(5, 7)) - 1;
  const byDay = useMemo(() => new Map(period.days.map((d) => [d.day, d])), [period]);

  // Months of the year with any reading.
  const readMonths = useMemo(() => {
    const has = new Set<number>();
    for (const d of period.days) if (isRead(d) && d.day.startsWith(`${year}-`)) has.add(Number(d.day.slice(5, 7)) - 1);
    return has;
  }, [period, year]);
  // The last month that can be looked at: this one while the year runs.
  const lastMonth = year === thisYear ? thisMonth : 11;
  // The phone lists the months with reading (and this one); the desktop strip all twelve.
  const months = useMemo(() => {
    if (desktop) return Array.from({ length: 12 }, (_, i) => i);
    const has = new Set(readMonths);
    if (year === thisYear) has.add(thisMonth);
    if (!has.size) has.add(11);
    return [...has].sort((a, b) => a - b);
  }, [desktop, readMonths, year, thisYear, thisMonth]);
  const [picked, setPicked] = useState<{ year: number; month: number } | null>(null);
  const month = picked && picked.year === year && months.includes(picked.month)
    ? picked.month
    : year === thisYear ? thisMonth : readMonths.size ? Math.max(...readMonths) : 11;
  const pick = (m: number) => {
    setPicked({ year, month: m });
    onMonthChange?.();
  };

  const chips = useRef<HTMLDivElement>(null);
  useEffect(() => {
    chips.current?.querySelector<HTMLElement>('[aria-pressed="true"]')?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [month, year]);

  const cells = monthCells(year, month);
  const inStreak = (d: PeriodDay) => d.met && !!s.streak.current_start && d.day >= s.streak.current_start && d.day <= s.today;
  const monthDays = cells.filter((c) => c.inMonth).map((c) => byDay.get(c.key)).filter((d): d is PeriodDay => !!d && isRead(d));
  const monthSec = monthDays.reduce((n, d) => n + total(d), 0);
  const monthKey = `${year}-${String(month + 1).padStart(2, "0")}`;
  const monthNames = names(t.sxMonthNames);
  const dow = names(t.sxDow);
  // An earlier year shows its own best run; this year and all time the all-time one.
  const past = period.kind === "year" && year !== thisYear;
  const longest = past ? period.streak_best_in_period : s.streak.longest;
  const range = past ? null : s.streak.longest_range;
  // "{0}: " then the bold "{1} days read".
  const daysRead = t.sxDaysRead.split("{1}");
  // Days read in a month of the year, for the desktop strip.
  const monthKeyOf = (m: number) => `${year}-${String(m + 1).padStart(2, "0")}`;
  const readIn = (m: number) => period.months.find((x) => x.month === monthKeyOf(m))?.days_read ?? 0;

  const hero = (
    <div className="scx-cal__hero">
      <span className="scx__label">{past ? fmt(t.sxLongestYear, year) : t.sxLongest}</span>
      <span className="scx-cal__big">{longest}</span>
      <span className="scx__sub">{t.msConsecutive}{range ? ` · ${rangeText(range.start, range.end, thisYear)}` : ""}</span>
    </div>
  );
  const status = !past && (
    <div className="scx-cal__chips">
      {s.streak.current > 0 ? (
        <span className="scx-chip scx-chip--fire"><Icon name="flame" size={14} />{fmt(t.sxStreakNow, s.streak.current)}</span>
      ) : (
        <span className="scx-chip">{t.sxNoStreak}</span>
      )}
      {s.streak.current > 0 && (
        <span className={`scx-chip scx-chip--shield${s.streak.freeze_left ? "" : " is-used"}`}>
          <Icon name="snow" size={14} />{s.streak.freeze_left ? t.sxShieldLeft : t.sxShieldUsed}
        </span>
      )}
    </div>
  );
  const how = (
    <button className="scx__icon" onClick={(e) => onHow(e.currentTarget)} aria-label={t.sxStreakHow}><Icon name="info" size={18} /></button>
  );
  const legend = (
    <div className="scx-cal__legend">
      <span><i className="is-streak" />{t.sxLegendStreak}</span>
      <span><i className="is-read" />{t.sxLegendRead}</span>
      {period.days.some((d) => d.amazon_read && total(d) === 0) && <span><i className="is-amazon" />{t.sxLegendAmazon}</span>}
      <span><i className="is-none" />{t.sxLegendNone}</span>
    </div>
  );

  return (
    <section className="scx scx-cal">
      {desktop ? (
        <div className="scx-cal__top">
          {hero}
          {status}
          {how}
          <div className="scx-cal__nav">
            <button className="scx__icon scx__icon--line" onClick={() => pick(month - 1)} disabled={month <= 0} aria-label={t.pcPrevMonth}><Icon name="arrowL" size={16} /></button>
            <span aria-live="polite">{monthTitle(lang, monthKey)}, {year}</span>
            <button className="scx__icon scx__icon--line" onClick={() => pick(month + 1)} disabled={month >= lastMonth} aria-label={t.pcNextMonth}><Icon name="arrowR" size={16} /></button>
          </div>
        </div>
      ) : (
        <>
          <div className="scx__row scx__row--top">
            {hero}
            {how}
          </div>
          {status}
          <div className="scx-cal__months" role="group" aria-label={t.sxPickMonth} ref={chips}>
            {months.map((m) => (
              <button key={m} aria-pressed={m === month} onClick={() => pick(m)}>{monthNames[m]}</button>
            ))}
          </div>
        </>
      )}

      <div className="scx-cal__grid">
        {dow.map((w) => <div key={w} className="scx-cal__dow">{w}</div>)}
        {cells.map((c) => {
          if (!c.inMonth) return <div key={c.key} className="scx-cal__cell is-other" aria-hidden="true"><span>{c.n}</span></div>;
          const d = byDay.get(c.key);
          const future = c.key > s.today;
          const today = c.key === s.today;
          const sec = d ? total(d) : 0;
          const amazonOnly = sec === 0 && !!d?.amazon_read;
          const state = d && inStreak(d) ? "streak" : sec > 0 ? "read" : amazonOnly ? "amazon" : "none";
          const label = `${c.n}/${month + 1}: ${sec > 0 ? fmt(t.minutesN, minutesOf(sec)) : amazonOnly ? t.sxLegendAmazon : t.sxNoReadingShort}`;
          const inner = (
            <>
              <span className="scx-cal__n">{c.n}</span>
              {(desktop ? sec > 0 : today && sec > 0) && <span className="scx-cal__min">{desktop ? minutesOf(sec) : Math.floor(sec / 60)}′</span>}
              {(desktop || !today) && d && d.books.length > 0 && (
                <span className="scx-cal__covers" aria-hidden="true">
                  {d.books.slice(0, 2).map((b) => <span key={b.asin} className="scx-cover scx-cover--cal"><RefCover asin={b.asin} book={period.books[b.asin]} /></span>)}
                </span>
              )}
            </>
          );
          return future ? (
            <div key={c.key} className="scx-cal__cell is-future" aria-hidden="true">{inner}</div>
          ) : (
            <button key={c.key} className={`scx-cal__cell is-${state}${today ? " is-today" : ""}`} aria-label={label} onClick={(e) => onDay(c.key, e.currentTarget)}>{inner}</button>
          );
        })}
      </div>

      {desktop ? (
        <div className="scx-cal__year">
          <div className="scx-cal__yearhead">
            <span>{fmt(t.pcYearOf, year)} · <b>{fmt(t.pcDaysRead, months.reduce((n, m) => n + readIn(m), 0))}</b></span>
            {legend}
          </div>
          <div className="scx-cal__strip" role="group" aria-label={t.sxPickMonth}>
            {months.map((m) => {
              const n = readIn(m);
              const later = m > lastMonth;
              return (
                <button key={m} aria-pressed={m === month} disabled={later} aria-label={fmt(t.sxDaysRead, monthTitle(lang, monthKeyOf(m)), n)} onClick={() => pick(m)}>
                  <i style={{ height: Math.max(2, Math.round((n / 31) * 34)) }} />
                  {monthNames[m]}
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        <>
          {legend}
          <div className="scx-cal__foot">
            <span>{daysRead[0].replace("{0}", monthTitle(lang, monthKey))}<b>{monthDays.length}{daysRead[1]}</b></span>
            <span>{fmtDuration(lang, monthSec)}</span>
          </div>
        </>
      )}
    </section>
  );
}
