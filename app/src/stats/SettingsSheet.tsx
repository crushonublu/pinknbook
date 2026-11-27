import { useState } from "react";
import { MobilePicker } from "../mobile/MobilePicker";
import { MobileReaderSheet } from "../mobile/MobileReaderSheet";
import { STR, type Lang } from "../i18n";
import { Icon } from "../icons";
import { fmt } from "./format";
import { ManualPanel } from "./ManualReading";
import { DAILY_GOALS, saveStatsSettings, yearlyGoals } from "./settings";
import type { LibraryRow } from "../types";
import type { StatsSummary } from "./types";

/** Goals, the Kindle estimate and adding paper reading, in a sheet opened from the Stats header. */
export function SettingsSheet({ lang, s, rows, onChanged, onClose }: { lang: Lang; s: StatsSummary; rows: LibraryRow[]; onChanged: () => void; onClose: () => void }) {
  const t = STR[lang];
  const [manualOpen, setManualOpen] = useState(false);
  const set = (p: Parameters<typeof saveStatsSettings>[0]) => saveStatsSettings(p, onChanged);
  const yearly = yearlyGoals(s.goal_books_year);
  return (
    <MobileReaderSheet title={t.sxSettings} closeLabel={t.xrClose} onClose={onClose}>
      <div className="scx-dark scx-settings">
        <div className="scx-settings__row">
          <span>{t.dailyGoal}</span>
          <MobilePicker label={t.dailyGoal} value={s.goal_minutes} options={DAILY_GOALS.map((g) => ({ value: g, label: fmt(t.minutesN, g) }))} onChange={(g) => set({ goalMinutes: g })} />
        </div>
        <div className="scx-settings__row">
          <span>{t.sxYearGoal}</span>
          <MobilePicker label={t.sxYearGoal} value={s.goal_books_year} options={yearly.map((g) => ({ value: g, label: fmt(t.sxBooksN, g) }))} onChange={(g) => set({ goalBooksYear: g })} />
        </div>
        <label className="scx-settings__row scx-settings__row--toggle">
          <span>{t.sxKindleToggle}<small>{t.sxKindleToggleHint}</small></span>
          <input type="checkbox" checked={s.kindle_estimates} onChange={(e) => set({ kindleEstimates: e.target.checked })} />
        </label>
        <button className="scx-settings__row scx-settings__row--button" aria-expanded={manualOpen} onClick={() => setManualOpen((o) => !o)}>
          <span>{t.prAdd}</span>
          <Icon name={manualOpen ? "chevronDown" : "arrowR"} size={18} />
        </button>
        {manualOpen && <ManualPanel lang={lang} rows={rows} today={s.today} onChanged={onChanged} />}
      </div>
    </MobileReaderSheet>
  );
}
