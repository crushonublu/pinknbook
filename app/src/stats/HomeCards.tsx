import { BookCover } from "../BookCover";
import { STR, type Lang } from "../i18n";
import { Icon } from "../icons";
import type { LibraryRow } from "../types";
import { fmt } from "./format";
import { yearPace } from "./goal";
import { StreakLine } from "./StreakLine";
import { isNewReader, secOfDay } from "./streak";
import type { StatsSummary } from "./types";
import { YearShelf } from "./YearShelf";
import { WeekDots } from "./WeekDots";

/** Spines drawn in the Home yearly-goal row, however big the goal. */
const MAX_SPINES = 20;

/**
 * The streak on Home: days in a row, what is left of today's goal, the week
 * as seven dots and the books being read as a stack of covers. Opens Stats.
 */
export function HomeStreakCard({ lang, summary, reading, onOpen }: {
  lang: Lang;
  summary: StatsSummary | null;
  /** The books being read, the latest first (the first two are drawn). */
  reading: LibraryRow[];
  onOpen: () => void;
}) {
  const t = STR[lang];
  if (!summary) return null;
  const s = summary;
  const goalSec = s.goal_minutes * 60;
  const [lead, tail] = t.sxHomeStreak.split("{0}");
  const title = s.streak.current > 0 ? fmt(t.sxHomeStreak, s.streak.current) : t.sxHomeNone;
  return (
    <button className="mobile-streak" onClick={onOpen} aria-label={fmt(t.sxHomeAria, title)}>
      <span className="mobile-streak__head">
        <span className="mobile-streak__text">
          <span className="mobile-streak__title">
            {s.streak.current > 0 ? <>{lead}<span>{s.streak.current}</span>{tail}</> : t.sxHomeNone}
          </span>
          <span className="mobile-streak__sub">
            <StreakLine lang={lang} s={s} />
          </span>
        </span>
        {reading.length > 0 && (
          <span className="mobile-streak__covers" aria-hidden="true">
            {reading.slice(0, 2).map((r) => <span key={r.asin}><BookCover row={r} /></span>)}
          </span>
        )}
      </span>
      <WeekDots lang={lang} today={s.today} goalSec={goalSec} secOf={secOfDay(s)} />
    </button>
  );
}

/** "19 / 24 books this year" with a few spines, the pace and a way into Stats. */
export function HomeYearRow({ lang, summary, rows, onOpen }: { lang: Lang; summary: StatsSummary | null; rows: LibraryRow[]; onOpen: () => void }) {
  const t = STR[lang];
  if (!summary) return null;
  const goal = summary.goal_books_year;
  const done = summary.books_finished_year;
  const pace = yearPace(goal, done, summary.today);
  // A miniature of the goal: as many spines as fit, filled in proportion with the latest finished.
  const spines = Math.min(goal, MAX_SPINES);
  const filled = Math.min(spines, done > 0 ? Math.max(1, Math.round((done / goal) * spines)) : 0);
  const byAsin = new Map(rows.map((r) => [r.asin, r]));
  const [before, after] = t.sxYearRow.split("{0}");
  const [mid, end] = after.split("{1}");
  return (
    <button className="mobile-year" onClick={onOpen}>
      <span className="mobile-year__head">
        <span className="mobile-year__title">{before}<span>{done}</span>{mid}{goal}{end}</span>
        <Icon name="arrowR" size={18} />
      </span>
      {/* The whole width of the card, so the spines can be tall enough to read. */}
      <span className="mobile-year__spines" aria-hidden="true">
        <YearShelf compact asins={filled ? summary.finished_year_asins.slice(-filled) : []} goal={spines} rows={byAsin} books={{}} ariaLabel="" />
      </span>
      <span className="mobile-year__sub">{isNewReader(summary) ? t.sxYearFresh : pace.behind > 0 ? fmt(t.sxBehind, pace.behind) : t.sxOnTrack} · {t.sxSeeStats}</span>
    </button>
  );
}
