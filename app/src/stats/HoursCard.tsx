import { STR, type Lang } from "../i18n";
import { fmt } from "./format";
import type { PeriodStats } from "./types";

/** Width of the window the card names, in hours. */
const WINDOW = 3;
/** Height of the tallest bar in px. */
const BAR_H = 96;

const hh = (h: number) => `${String(h % 24).padStart(2, "0")}:00`;

/** First hour of the busiest run of `WINDOW` hours (the day wraps at midnight). */
export function bestWindow(hours: number[]) {
  let best = 0;
  let sum = -1;
  for (let h = 0; h < 24; h++) {
    const s = Array.from({ length: WINDOW }, (_, i) => hours[(h + i) % 24]).reduce((a, b) => a + b, 0);
    if (s > sum) [best, sum] = [h, s];
  }
  return { start: best, seconds: sum };
}

/**
 * Reading time by hour of the day on a night-blue card: 24 bars with the
 * busiest three hours lit, and that window as the headline.
 */
export function HoursCard({ lang, p }: { lang: Lang; p: PeriodStats }) {
  const t = STR[lang];
  const total = p.hours.reduce((a, b) => a + b, 0);
  const head = <span className="scx__label">{t.sxHoursLead}</span>;
  if (total === 0) {
    return (
      <section className="scx scx-hours scard-theme--night">
        {head}
        <p className="scx__sub">{t.sxHoursNone}</p>
      </section>
    );
  }
  const win = bestWindow(p.hours);
  const lit = (h: number) => (h - win.start + 24) % 24 < WINDOW;
  const most = Math.max(...p.hours);
  const habit = p.persona.night_share >= 0.5 ? t.bd_night_owl : p.persona.early_share >= 0.5 ? t.bd_early_bird : null;
  // The hourly chart is partial when hours only began to be logged inside the period.
  const since = p.hours_since && p.hours_since > p.start ? p.hours_since.split("-").reverse().slice(0, 2).join("/") : null;

  return (
    <section className="scx scx-hours scard-theme--night">
      <div className="scx__stack">
        {head}
        <span className="scx__hero">{hh(win.start)} – {hh(win.start + WINDOW)}</span>
        <span className="scx__sub">{[habit, fmt(t.sxHoursShare, Math.round((win.seconds / total) * 100))].filter(Boolean).join(" · ")}</span>
      </div>
      <div className="scx-hours__chart" role="img" aria-label={t.sxHoursAria}>
        <div className="scx-hours__bars">
          {p.hours.map((v, h) => (
            <i key={h} className={lit(h) ? "is-lit" : undefined} style={{ height: Math.max(2, Math.round((v / most) * BAR_H)) }} />
          ))}
        </div>
        <div className="scx-hours__axis" aria-hidden="true"><span>0h</span><span>6h</span><span>12h</span><span>18h</span><span>23h</span></div>
      </div>
      {since && <p className="scx__sub">{fmt(t.sxHoursSince, since)}</p>}
    </section>
  );
}
