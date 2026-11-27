import { useState } from "react";
import { STR, type Lang } from "../i18n";
import { addDays, fmt, fmtDuration, names, parseDay } from "./format";
import type { PeriodDay } from "./types";

type Span = 7 | 30;

/** Height of the bars' area in px. */
const CHART_H = 128;

/**
 * Minutes read each day over the last 7 or 30 days, stacked: pntome on the
 * bottom, paper books and the Kindle app on this phone (measured) in the
 * middle and the Kindle estimate on top, with the daily goal as a dashed line
 * and the total against the span before it.
 */
export function ReadingTimeCard({ lang, today, goalMinutes, days, initialSpan = 7 }: {
  lang: Lang;
  today: string;
  goalMinutes: number;
  days: Map<string, PeriodDay>;
  /** The span shown first (the desktop page opens on 30 days). */
  initialSpan?: Span;
}) {
  const t = STR[lang];
  const [span, setSpan] = useState<Span>(initialSpan);
  const dow = names(t.msWeekdays);

  const window = (end: string, n: number) =>
    Array.from({ length: n }, (_, i) => {
      const key = addDays(end, i - n + 1);
      const d = days.get(key);
      return {
        key,
        app: (d?.app_sec ?? 0) / 60,
        kindleApp: (d?.kindle_app_sec ?? 0) / 60,
        kindle: (d?.kindle_sec ?? 0) / 60,
        manual: (d?.manual_sec ?? 0) / 60,
      };
    });
  const bars = window(today, span);
  const sum = (list: { app: number; kindleApp: number; kindle: number; manual: number }[]) =>
    list.reduce((n, d) => n + (d.app + d.kindleApp + d.kindle + d.manual) * 60, 0);
  const totalSec = sum(bars);
  const prevSec = sum(window(addDays(today, -span), span));
  const change = prevSec > 0 ? Math.round(((totalSec - prevSec) * 100) / prevSec) : 0;

  const top = Math.max(goalMinutes * 1.5, ...bars.map((d) => d.app + d.kindleApp + d.kindle + d.manual));
  // The phone's Kindle app only shows where it is measured at all.
  const hasKindleApp = bars.some((d) => d.kindleApp > 0);
  const px = (m: number) => `${Math.round((m / top) * CHART_H)}px`;
  const labelOf = (key: string, i: number) => {
    if (key === today) return t.msToday;
    if (span === 7) return dow[parseDay(key).getDay()];
    // A date under every fifth bar keeps 30 narrow bars readable.
    return (bars.length - 1 - i) % 5 === 0 ? String(parseDay(key).getDate()) : "";
  };

  return (
    <section className="scx scx-time">
      <div className="scx__row scx__row--top">
        <div className="scx__stack">
          <span className="scx__label">{span === 7 ? t.sxReadTime7 : t.sxReadTime30}</span>
          <span className="scx__hero">{fmtDuration(lang, totalSec)}</span>
          {change !== 0 && (
            <span className={`scx__trend ${change > 0 ? "is-up" : "is-down"}`} aria-label={`${change > 0 ? t.sxUp : t.sxDown} ${Math.abs(change)}% ${span === 7 ? t.sxVsWeek : t.sxVsMonth}`}>
              <span aria-hidden="true">{change > 0 ? "▲" : "▼"} {Math.abs(change)}% {span === 7 ? t.sxVsWeek : t.sxVsMonth}</span>
            </span>
          )}
        </div>
        <div className="scx-seg scx-seg--small" role="group" aria-label={t.sxSpan}>
          <button aria-pressed={span === 7} onClick={() => setSpan(7)}>{t.sxWeek}</button>
          <button aria-pressed={span === 30} onClick={() => setSpan(30)}>{t.sxMonth}</button>
        </div>
      </div>

      <div className={`scx-bars scx-bars--${span}`} role="img" aria-label={fmt(t.sxBarsAria, span)}>
        <div className="scx-bars__goal" style={{ bottom: `${22 + Math.round((goalMinutes / top) * CHART_H)}px` }} />
        <span className="scx-bars__goaltag" style={{ bottom: `${25 + Math.round((goalMinutes / top) * CHART_H)}px` }}>{goalMinutes}′</span>
        {bars.map((d, i) => (
          <div key={d.key} className={`scx-bars__col${d.key === today ? " is-today" : ""}`}>
            {d.kindle > 0 && <i className="is-kindle" style={{ height: px(d.kindle) }} />}
            {d.kindleApp > 0 && <i className="is-kindleapp" style={{ height: px(d.kindleApp) }} />}
            {d.manual > 0 && <i className="is-manual" style={{ height: px(d.manual) }} />}
            {d.app > 0 && <i className="is-app" style={{ height: px(d.app) }} />}
            <span>{labelOf(d.key, i)}</span>
          </div>
        ))}
      </div>

      <div className="scx-legend">
        <span><i className="is-app" />{t.sxInApp}</span>
        {hasKindleApp && <span><i className="is-kindleapp" />{t.sxKindleApp}</span>}
        <span><i className="is-kindle" />{t.sxKindleEst}</span>
        <span><i className="is-manual" />{t.sxManual}</span>
        <span><i className="is-goal" />{t.sxDayGoal}</span>
      </div>
    </section>
  );
}
