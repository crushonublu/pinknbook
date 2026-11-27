import { useEffect, useRef, useState } from "react";
import { STR, type Lang } from "../i18n";
import { Icon } from "../icons";
import { AnchoredPopover } from "./AnchoredPopover";
import { BadgesCard } from "./BadgesCard";
import { DayContent } from "./DaySheet";
import { FinishedByMonth } from "./FinishedByMonth";
import { fmt, longDate } from "./format";
import { GenreDonut } from "./GenreDonut";
import { GoalCard } from "./GoalCard";
import { HoursCard } from "./HoursCard";
import { ProfileCard } from "./ProfileCard";
import { ReadingTimeCard } from "./ReadingTimeCard";
import { DAILY_GOALS, saveStatsSettings, yearlyGoals } from "./settings";
import { ManualPanel } from "./ManualReading";
import { EmptyStats, StatsError, StatsSkeleton } from "./StatsStates";
import { StreakCalendar } from "./StreakCalendar";
import { TodayCard } from "./TodayCard";
import { TopBooks } from "./TopBooks";
import { isNewReader } from "./streak";
import { useStatsPage } from "./useStatsPage";
import { WrapList } from "../wrap/WrapOffers";
import { currentMonthWrap } from "../wrap/wording";
import type { LibraryRow } from "../types";
import type { StatsSummary, WrapsAccess } from "./types";
import "./stats.css";

/** What the one open popover is about. */
type Pop = { kind: "day"; day: string; anchor: HTMLElement } | { kind: "how"; anchor: HTMLElement } | { kind: "manual"; anchor: HTMLElement };

/**
 * The desktop Stats page: the cards of the phone page (src/stats) laid out in
 * wrapping rows, with the settings in the header instead of a sheet and a
 * popover instead of a sheet for a day. As on the phone, the cards about "now"
 * (today, the yearly goal, the 7 and 30 day chart) do not follow the range.
 */
export function DesktopStatsPage({ lang, s, loadFailed = false, rows, onBack, onChanged, wraps }: {
  lang: Lang;
  s: StatsSummary | null;
  /** The summary could not be loaded (it is then still null). */
  loadFailed?: boolean;
  /** The library's books, for the spines on the yearly shelf. */
  rows: LibraryRow[];
  onBack: () => void;
  onChanged: () => void;
  /** The wrap-ups: listed at the bottom, and the newest opened by the header button; omitted, neither. */
  wraps?: WrapsAccess;
}) {
  const t = STR[lang];
  const { currentYear, sel, setPick, years, genres, main, thisYear, recent, rowsByAsin, mainDays } = useStatsPage(lang, s, rows);
  const [pop, setPop] = useState<Pop | null>(null);
  const yearGoal = useRef<HTMLSelectElement>(null);
  // A day's popover is about the range it was opened in.
  useEffect(() => setPop(null), [sel]);

  const head = (
    <header className="stx-head">
      <button className="stx-head__back" onClick={onBack}>
        <Icon name="arrowL" size={16} />
        <span>{t.backToLibrary}</span>
      </button>
      <h1>{t.stats}</h1>
      {s && (
        <div className="stx-seg" role="group" aria-label={t.sxRange}>
          {(["all", ...years] as const).map((k) => (
            <button key={k} aria-pressed={sel === k} onClick={() => setPick(k)}>{k === "all" ? t.sxAll : k}</button>
          ))}
        </div>
      )}
      <span className="stx-head__spacer" />
      {s && wraps && (
        <button className="stx-wrapbtn" onClick={() => wraps.onOpen(wraps.list[0] ?? currentMonthWrap(s.today))}>
          <Icon name="sparkle" size={16} />
          {t.wrOpenBtn}
        </button>
      )}
      {s && (
        <button className="stx-wrapbtn" aria-haspopup="dialog" aria-expanded={pop?.kind === "manual"} disabled={!main.stats} onClick={(e) => { const anchor = e.currentTarget; setPop((cur) => (cur?.kind === "manual" ? null : { kind: "manual", anchor })); }}>
          <Icon name="plus" size={16} />
          {t.sxManual}
        </button>
      )}
      {s && (
        <>
          <label className="stx-field">
            <span>{t.sxDayGoal}</span>
            <select className="stx-select" value={s.goal_minutes} onChange={(e) => saveStatsSettings({ goalMinutes: Number(e.target.value) }, onChanged)}>
              {DAILY_GOALS.map((g) => <option key={g} value={g}>{fmt(t.minutesN, g)}</option>)}
            </select>
          </label>
          <label className="stx-field">
            <span>{t.pcYearGoal}</span>
            <select className="stx-select" ref={yearGoal} value={s.goal_books_year} onChange={(e) => saveStatsSettings({ goalBooksYear: Number(e.target.value) }, onChanged)}>
              {yearlyGoals(s.goal_books_year).map((g) => <option key={g} value={g}>{fmt(t.sxBooksN, g)}</option>)}
            </select>
          </label>
          <label className="stx-field stx-field--check" title={t.kindleEstHint}>
            <input type="checkbox" checked={s.kindle_estimates} onChange={(e) => saveStatsSettings({ kindleEstimates: e.target.checked }, onChanged)} />
            <span>{t.kindleEst}</span>
          </label>
        </>
      )}
    </header>
  );

  const p = main.stats;
  if (!s || !p || !thisYear) {
    return (
      <div className="stx">
        <div className="stx__inner">
          {head}
          {(s ? main.failed : loadFailed) ? <StatsError lang={lang} onRetry={onChanged} /> : <StatsSkeleton lang={lang} />}
        </div>
      </div>
    );
  }

  return (
    <div className="stx">
      <div className="stx__inner">
        {head}

        {isNewReader(s) ? (
          <>
            <EmptyStats lang={lang} onAddPaper={(button) => setPop({ kind: "manual", anchor: button })} />
            {wraps && <WrapList lang={lang} wraps={wraps.list} onOpen={wraps.onOpen} onDelete={wraps.onDelete} />}
          </>
        ) : (
          <>
            <div className="stx-row">
              <div className="stx-cell stx-cell--wide"><ProfileCard lang={lang} p={p} s={s} genreName={genres.name} wide /></div>
              <div className="stx-cell"><TodayCard lang={lang} s={s} /></div>
              <div className="stx-cell">
                <GoalCard lang={lang} s={s} days={recent} rows={rowsByAsin} books={thisYear.books} yearOnly onChangeGoal={() => yearGoal.current?.focus()} />
              </div>
            </div>

            <div className="stx-row stx-row--top">
              <div className="stx-cell stx-cell--main">
                <StreakCalendar
                  desktop
                  lang={lang}
                  s={s}
                  period={p}
                  year={sel === "all" ? currentYear : sel}
                  onDay={(day, anchor) => setPop((cur) => (cur?.kind === "day" && cur.day === day ? null : { kind: "day", day, anchor }))}
                  onHow={(anchor) => setPop((cur) => (cur?.kind === "how" ? null : { kind: "how", anchor }))}
                  onMonthChange={() => setPop(null)}
                />
              </div>
              <div className="stx-col">
                <ReadingTimeCard lang={lang} today={s.today} goalMinutes={s.goal_minutes} days={recent} initialSpan={30} />
                <HoursCard lang={lang} p={p} />
                <GenreDonut lang={lang} p={p} genreName={genres.name} />
              </div>
            </div>

            <div className="stx-row">
              <div className="stx-cell stx-cell--main"><FinishedByMonth lang={lang} p={p} today={s.today} desktop /></div>
              <div className="stx-cell stx-cell--side"><TopBooks lang={lang} p={p} /></div>
            </div>

            <BadgesCard lang={lang} s={s} grid />
            {wraps && <WrapList lang={lang} wraps={wraps.list} onOpen={wraps.onOpen} onDelete={wraps.onDelete} />}
          </>
        )}
      </div>

      {pop?.kind === "day" && (
        <AnchoredPopover anchor={pop.anchor} label={longDate(lang, pop.day)} onClose={() => setPop(null)} className="spop--day">
          <h2 className="spop__title">{longDate(lang, pop.day)}</h2>
          <DayContent lang={lang} s={s} day={pop.day} data={mainDays.get(pop.day)} books={p.books} rows={rows} onChanged={onChanged} />
        </AnchoredPopover>
      )}
      {pop?.kind === "manual" && (
        <AnchoredPopover anchor={pop.anchor} label={t.prAdd} onClose={() => setPop(null)} align="end" className="spop--manual">
          <h2 className="spop__title">{t.prAdd}</h2>
          <ManualPanel lang={lang} rows={rows} today={s.today} onChanged={onChanged} />
        </AnchoredPopover>
      )}
      {pop?.kind === "how" && (
        <AnchoredPopover anchor={pop.anchor} label={t.sxStreakHow} onClose={() => setPop(null)} className="spop--how">
          <h2 className="spop__title">{t.sxStreakHow}</h2>
          <p className="scx-how">{fmt(t.sxStreakHowBody, s.goal_minutes)}</p>
        </AnchoredPopover>
      )}
    </div>
  );
}
