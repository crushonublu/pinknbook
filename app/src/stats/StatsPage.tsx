import { useState } from "react";
import { MobileReaderSheet } from "../mobile/MobileReaderSheet";
import { useMobileDismiss } from "../mobile/back";
import { STR, type Lang } from "../i18n";
import { Icon } from "../icons";
import { BadgeGrid, BadgesCard } from "./BadgesCard";
import { DaySheet } from "./DaySheet";
import { FinishedByMonth } from "./FinishedByMonth";
import { fmt } from "./format";
import { GenreDonut } from "./GenreDonut";
import { GoalCard } from "./GoalCard";
import { HoursCard } from "./HoursCard";
import { ProfileCard } from "./ProfileCard";
import { ReadingTimeCard } from "./ReadingTimeCard";
import { saveStatsSettings } from "./settings";
import { SettingsSheet } from "./SettingsSheet";
import { EmptyStats, StatsError, StatsSkeleton } from "./StatsStates";
import { StreakCalendar } from "./StreakCalendar";
import { TopBooks } from "./TopBooks";
import { isNewReader } from "./streak";
import { useStatsPage } from "./useStatsPage";
import { WrapList } from "../wrap/WrapOffers";
import type { LibraryRow } from "../types";
import type { StatsSummary, WrapsAccess } from "./types";
import "./stats.css";

/**
 * The Stats page on Android: a header with the stats settings, the period
 * chips (all time, this year, earlier years that have reading) and a column
 * of cards for the chosen period. The cards about "now" (goals, the 7 and 30
 * day chart, the streak calendar's current streak) do not follow the chips.
 */
export function StatsPage({ lang, s, loadFailed = false, rows, onBack, onChanged, wraps }: {
  lang: Lang;
  s: StatsSummary | null;
  /** The summary could not be loaded (it is then still null). */
  loadFailed?: boolean;
  /** The library's books, for the spines on the yearly shelf. */
  rows: LibraryRow[];
  onBack: () => void;
  onChanged: () => void;
  /** The wrap-ups to list at the bottom; omitted, no list. */
  wraps?: WrapsAccess;
}) {
  const t = STR[lang];
  const { currentYear, sel, setPick, years, genres, main, thisYear, recent, rowsByAsin, mainDays } = useStatsPage(lang, s, rows);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [badgesOpen, setBadgesOpen] = useState(false);
  const [howOpen, setHowOpen] = useState(false);
  const [dayOpen, setDayOpen] = useState<string | null>(null);
  // The settings sheet holds pickers, which take Back first: they are nested inside it.
  useMobileDismiss(settingsOpen, () => setSettingsOpen(false));
  useMobileDismiss(badgesOpen || howOpen || dayOpen !== null, () => {
    setBadgesOpen(false);
    setHowOpen(false);
    setDayOpen(null);
  }, true);

  const header = (
    <header className="scx-head">
      <button className="scx-head__btn" onClick={onBack} aria-label={t.sxBack}><Icon name="arrowL" size={20} /></button>
      <h1>{t.stats}</h1>
      <button className="scx-head__btn" onClick={() => setSettingsOpen(true)} aria-label={t.sxSettings} disabled={!s}><Icon name="more" size={20} /></button>
    </header>
  );
  if (!s) {
    return (
      <div className="scx-page">
        {header}
        {loadFailed ? <StatsError lang={lang} onRetry={onChanged} /> : <StatsSkeleton lang={lang} />}
      </div>
    );
  }

  const p = main.stats;
  const chip = (key: "all" | number, label: string) => (
    <button key={key} aria-pressed={sel === key} onClick={() => setPick(key)}>{label}</button>
  );

  return (
    <div className="scx-page">
      {header}
      <div className="scx-chips" role="group" aria-label={t.sxRange}>
        {chip("all", t.sxAll)}
        {years.map((y) => chip(y, String(y)))}
      </div>

      {!p || !thisYear ? (
        main.failed ? <StatsError lang={lang} onRetry={onChanged} /> : <StatsSkeleton lang={lang} />
      ) : isNewReader(s) ? (
        <>
          <EmptyStats lang={lang} onAddPaper={() => setSettingsOpen(true)} />
          {wraps && <WrapList lang={lang} wraps={wraps.list} onOpen={wraps.onOpen} onDelete={wraps.onDelete} />}
        </>
      ) : (
        <>
          <ProfileCard lang={lang} p={p} s={s} genreName={genres.name} />
          <GoalCard lang={lang} s={s} days={recent} rows={rowsByAsin} books={thisYear.books} onChangeGoal={() => setSettingsOpen(true)} />
          <StreakCalendar lang={lang} s={s} period={p} year={sel === "all" ? currentYear : sel} onDay={setDayOpen} onHow={() => setHowOpen(true)} />
          <ReadingTimeCard lang={lang} today={s.today} goalMinutes={s.goal_minutes} days={recent} />
          <FinishedByMonth lang={lang} p={p} today={s.today} />
          <TopBooks lang={lang} p={p} />
          <GenreDonut lang={lang} p={p} genreName={genres.name} />
          <HoursCard lang={lang} p={p} />
          <BadgesCard lang={lang} s={s} onOpenAll={() => setBadgesOpen(true)} />
          {wraps && <WrapList lang={lang} wraps={wraps.list} onOpen={wraps.onOpen} onDelete={wraps.onDelete} />}
          <label className="scx-toggle">
            <span>{t.sxKindleToggle}<small>{t.sxKindleToggleHint}</small></span>
            <input type="checkbox" checked={s.kindle_estimates} onChange={(e) => saveStatsSettings({ kindleEstimates: e.target.checked }, onChanged)} />
          </label>
        </>
      )}

      {settingsOpen && <SettingsSheet lang={lang} s={s} rows={rows} onChanged={onChanged} onClose={() => setSettingsOpen(false)} />}
      {badgesOpen && (
        <MobileReaderSheet title={t.badges} closeLabel={t.xrClose} onClose={() => setBadgesOpen(false)}>
          <div className="scx-dark ms-badgesheet"><BadgeGrid lang={lang} s={s} /></div>
        </MobileReaderSheet>
      )}
      {howOpen && (
        <MobileReaderSheet title={t.sxStreakHow} closeLabel={t.xrClose} onClose={() => setHowOpen(false)}>
          <p className="scx-dark scx-how">{fmt(t.sxStreakHowBody, s.goal_minutes)}</p>
        </MobileReaderSheet>
      )}
      {dayOpen && p && <DaySheet lang={lang} s={s} day={dayOpen} data={mainDays.get(dayOpen)} books={p.books} rows={rows} onChanged={onChanged} onClose={() => setDayOpen(null)} />}
    </div>
  );
}
