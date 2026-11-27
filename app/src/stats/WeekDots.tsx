import { STR, type Lang } from "../i18n";
import { Icon } from "../icons";
import { addDays, daysBetween, fmt, minutesOf, names, weekStart } from "./format";

/**
 * Monday to Sunday of the week containing `today`: a day that reached the
 * goal is a filled disc with a flame, today shows its progress as a ring with
 * the minutes read, the rest are grey with the weekday letter.
 */
export function WeekDots({ lang, today, goalSec, secOf }: { lang: Lang; today: string; goalSec: number; secOf: (day: string) => number }) {
  const t = STR[lang];
  const dow = names(t.sxDow);
  const start = weekStart(today);
  return (
    <div className="weekdots">
      {dow.map((label, i) => {
        const day = addDays(start, i);
        const when = daysBetween(today, day);
        const sec = secOf(day);
        const met = when <= 0 && sec >= goalSec;
        const state = met ? t.sxDayMet : when > 0 ? t.sxDayLater : t.sxDayNotMet;
        const isToday = when === 0;
        const progress = Math.min(1, sec / Math.max(1, goalSec));
        return (
          <div key={day} className={`weekdots__day${isToday ? " is-today" : ""}`} role="img" aria-label={`${label}: ${isToday && !met ? fmt(t.minutesN, minutesOf(sec)) : state}`}>
            {met ? (
              <span className="weekdots__dot weekdots__dot--met"><Icon name="flame" size={18} /></span>
            ) : isToday ? (
              <span className="weekdots__dot weekdots__dot--ring" style={{ background: `conic-gradient(var(--accent) 0 ${progress * 100}%, var(--border) ${progress * 100}% 100%)` }}>
                <span>{Math.floor(sec / 60)}′</span>
              </span>
            ) : (
              <span className="weekdots__dot">{label}</span>
            )}
            <span className="weekdots__label">{label}</span>
          </div>
        );
      })}
    </div>
  );
}
