import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { STR, type Lang } from "./i18n";
import { Icon } from "./icons";
import { isAndroid } from "./platform";
import { TIER_KEYS, badgeImg } from "./stats/BadgesCard";
import { DesktopStatsPage } from "./stats/DesktopStatsPage";
import { StatsPage as MobileStatsPage } from "./stats/StatsPage";
import { StreakPopover } from "./stats/StreakPopover";
import type { LibraryRow } from "./types";
import type { AmazonDays, BadgeId, KindleTick, StatsSummary, WrapsAccess } from "./stats/types";

export type { BadgeId, StatsSummary } from "./stats/types";

/** How often Kindle reading is estimated while the app is open. */
const KINDLE_EVERY_MS = 30 * 60_000;
/** The same for the hour after a book's position moved: the reading may still be going on elsewhere. */
const KINDLE_ACTIVE_EVERY_MS = 10 * 60_000;
const KINDLE_ACTIVE_FOR_MS = 60 * 60_000;

export type Toast = { key: string; id: BadgeId | "backfill"; tier: number; count?: number };

/** Stats for the whole app: refreshed on demand, Kindle estimates and missing genres on a timer. */
export function useStats(signedIn: boolean) {
  const [summary, setSummary] = useState<StatsSummary | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  /** The last attempt to load the summary failed (the Stats page then offers to try again). */
  const [failed, setFailed] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const s = await invoke<StatsSummary>("stats_summary");
      setSummary(s);
      setFailed(false);
      const fresh: Toast[] = s.unlocked.map((u) => ({ key: `${u.id}-${u.tier}-${Date.now()}`, id: u.id, tier: u.tier }));
      if (s.backfilled) fresh.push({ key: `bf-${Date.now()}`, id: "backfill", tier: 0, count: s.backfilled });
      if (fresh.length) setToasts((t) => [...t, ...fresh]);
    } catch (e) {
      console.error(e);
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    if (!signedIn) return;
    let stop = false;
    // Genres arrive from Goodreads a few books at a time (see genre.rs `genre_fill`).
    const fillGenres = () =>
      invoke<number>("genre_fill")
        .catch(() => 0)
        .then((n) => {
          if (!stop && n > 0) refresh();
        });
    let timer = 0;
    let movedAt = 0;
    let lastAt = 0;
    let running = false;
    // Each look schedules the next: sooner for an hour after any position moved.
    const tick = () => {
      if (running) return;
      running = true;
      window.clearTimeout(timer);
      lastAt = Date.now();
      invoke<KindleTick>("kindle_activity_tick")
        .catch(() => null)
        .then((r) => {
          running = false;
          if (stop) return;
          if (r?.moved) movedAt = Date.now();
          timer = window.setTimeout(tick, Date.now() - movedAt < KINDLE_ACTIVE_FOR_MS ? KINDLE_ACTIVE_EVERY_MS : KINDLE_EVERY_MS);
          refresh();
          return fillGenres();
        });
    };
    // Back from reading in the Kindle app (Android) or another window: look again at once,
    // at most once a minute.
    const visible = () => {
      if (document.visibilityState === "visible" && Date.now() - lastAt > 60_000) tick();
    };
    // The Android web view does not always report visibility when the app comes back; focus it does.
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("focus", visible);
    refresh();
    timer = window.setTimeout(tick, 4000);
    return () => {
      stop = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("focus", visible);
    };
  }, [signedIn, refresh]);

  const dismiss = useCallback((key: string) => setToasts((t) => t.filter((x) => x.key !== key)), []);
  return { summary, failed, refresh, toasts, dismiss };
}

/**
 * Title-bar flame: streak days and a ring for today's goal. On the desktop it
 * opens a popover (src/stats/StreakPopover) whose button goes to Stats by
 * calling `onClick`; on Android, and while the stats are loading, it goes to
 * Stats straight away.
 */
export function StreakButton({ lang, s, onClick }: { lang: Lang; s: StatsSummary | null; onClick: () => void }) {
  const t = STR[lang];
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const mins = s ? Math.floor((s.today_app_sec + s.today_kindle_sec) / 60) : 0;
  const goal = s?.goal_minutes ?? 10;
  const p = Math.min(1, mins / goal);
  const r = 13;
  const c = 2 * Math.PI * r;
  const label = s
    ? `${t.streakDays.replace("{0}", String(s.streak.current))} · ${t.todayOf.replace("{0}", String(mins)).replace("{1}", String(goal))}`
    : t.stats;
  const popover = !isAndroid && !!s;
  return (
    <>
      <button
        className={`streakbtn${s?.streak.today_done ? " is-done" : ""}${s && s.streak.current > 0 ? " has-streak" : ""}`}
        onClick={(e) => (popover ? setAnchor(anchor ? null : e.currentTarget) : onClick())}
        title={label}
        aria-label={label}
        aria-haspopup={popover ? "dialog" : undefined}
        aria-expanded={popover ? !!anchor : undefined}
      >
        <span className="streakbtn__badge">
          <svg className="streakbtn__ring" viewBox="0 0 32 32" aria-hidden="true">
            <circle cx="16" cy="16" r={r} className="streakbtn__track" />
            <circle cx="16" cy="16" r={r} className="streakbtn__fill" strokeDasharray={`${c * p} ${c}`} />
          </svg>
          <Icon name="flame" size={16} />
        </span>
        <span className="streakbtn__n">{s?.streak.current ?? 0}</span>
      </button>
      {anchor && s && (
        <StreakPopover
          lang={lang}
          s={s}
          anchor={anchor}
          onClose={() => setAnchor(null)}
          onOpenStats={() => {
            setAnchor(null);
            onClick();
          }}
        />
      )}
    </>
  );
}

/** The Stats page: the same cards (src/stats), stacked on Android and in wrapping rows on the desktop. */
export function StatsPage(props: { lang: Lang; s: StatsSummary | null; loadFailed?: boolean; rows: LibraryRow[]; onBack: () => void; onChanged: () => void; wraps?: WrapsAccess }) {
  const { s, onChanged } = props;
  // Opening Stats asks Amazon for its days read when they are due (at most every 6 hours);
  // the numbers load again only if that brought news.
  const known = s?.amazon_days.fetched_at ?? null;
  const ready = !!s;
  useEffect(() => {
    if (!ready) return;
    invoke<AmazonDays>("amazon_days_refresh", { force: false })
      .then((a) => a.fetched_at !== known && onChanged())
      .catch(() => undefined);
    // Once per visit: `known` and `onChanged` are read as they are when Stats opens.
  }, [ready]);
  return isAndroid ? <MobileStatsPage {...props} /> : <DesktopStatsPage {...props} />;
}

/** Badge unlocks: one card at a time in the corner, never blocking. */
export function BadgeToasts({
  lang,
  toasts,
  onDismiss,
  onOpen,
}: {
  lang: Lang;
  toasts: Toast[];
  onDismiss: (key: string) => void;
  onOpen: () => void;
}) {
  const t = STR[lang];
  const cur = toasts[0];
  useEffect(() => {
    if (!cur) return;
    const h = window.setTimeout(() => onDismiss(cur.key), 6500);
    return () => window.clearTimeout(h);
  }, [cur, onDismiss]);
  if (!cur) return null;
  return (
    <div className="btoast" role="status" key={cur.key}>
      <button
        className="btoast__main"
        onClick={() => {
          onDismiss(cur.key);
          onOpen();
        }}
      >
        <span className={`btoast__img bcard--t${cur.tier}`}>
          <img src={cur.id === "backfill" ? badgeImg("books") : badgeImg(cur.id)} alt="" />
        </span>
        <span className="btoast__text">
          <span className="btoast__kicker">{cur.id === "backfill" ? t.badges : t.badgeUnlocked}</span>
          <span className="btoast__name">
            {cur.id === "backfill"
              ? t.backfillNote.replace("{0}", String(cur.count ?? 0))
              : `${t[`bd_${cur.id}` as const]} · ${t[TIER_KEYS[cur.tier]]}`}
          </span>
        </span>
      </button>
      <button className="btoast__x" onClick={() => onDismiss(cur.key)} aria-label={t.closeReader}>
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}
