// Dev-only page (stats-preview.html): the stats UI in a plain browser, with the
// Tauri commands answered from statsFixture.ts. Open it through `npm run dev`:
//
//   /stats-preview.html?view=desktop|mobile &theme=dark|light &lang=vi|en
//                       [&open=streak]   (desktop: open the title-bar popover)
//                       [&ai=0]          (no AI key configured)
//                       [&empty=1]       (a new reader: nothing read, no recaps)
//                       [&fail=1]        (every stats command fails: the error states)
//                       [&slow=1]        (stats answer after 8 s: the loading states)
//                       [&open=manual]   (desktop: open the paper-reading popover)
//                       [&exportfail=<message>]   (saving a picture fails with that raw message)
//                       [&usage=granted]          (mobile: Usage access to the Kindle app is already given)
//                       [&amazon=ok|needs_signin|error|none]   (state of the days read from Amazon)
//   /stats-preview.html?view=book &platform=mobile|desktop [&asin=PV0025] [&theme=...] [&lang=...]
//                       (a book's page, with its genre picker; PV0025 has no genre)
//   /stats-preview.html?view=wrap &kind=week|month|year &format=story|post
//                       &platform=mobile|desktop [&theme=...] [&lang=...] [&start=YYYY-MM-DD]
//                       [&card=wine|forest|night|paper|sunset|ocean]
//
// `mobile` draws the Android UI (the `is-android` class) as two 390px phones,
// Home (with the "wrap-up ready" card) and Stats; `desktop` draws the title bar
// with the streak button and the Stats page at the window's width. `wrap` opens
// the wrap-up viewer on its own: in a phone, or in the desktop window.

import { useEffect, useMemo, useState } from "react";
import ReactDOM from "react-dom/client";
import { mockIPC } from "@tauri-apps/api/mocks";
import "../App.css";
import "../mobile/mobile.css";
import "../mobile/reader.css";
import { installFonts } from "../fonts";
import { STR, type Lang } from "../i18n";
import { Icon } from "../icons";
import { StatsPage as MobileStatsPage } from "../stats/StatsPage";
import { iconFacts } from "../wrap/iconRules";
import { layoutJson, newLayout } from "../wrap/layout";
import { isThemeId } from "../wrap/palettes";
import { useWraps } from "../wrap/useWraps";
import { WrapOffers } from "../wrap/WrapOffers";
import { WrapViewer } from "../wrap/WrapViewer";
import { HomeStreakCard, HomeYearRow } from "../stats/HomeCards";
import type { PeriodKind, WrapKind, WrapSummary } from "../stats/types";
import type { Format } from "../wrap/geometry";
import { StatsPage, StreakButton, useStats } from "../Stats";
import BookDetail from "../BookDetail";
import MobileBookSheet from "../mobile/MobileBookSheet";
import { GENRES, amazonDays, bookGenre, deleteManual, deleteWrap, libraryRows, logManual, manualOn, periodStats, setBookGenre, settings, summary, wrapDoc, wrapSummaries, dayMarks } from "./statsFixture";

const q = new URLSearchParams(location.search);
const wrapView = q.get("view") === "wrap";
const bookView = q.get("view") === "book";
const view = wrapView || bookView ? (q.get("platform") === "desktop" ? "desktop" : "mobile") : q.get("view") === "mobile" ? "mobile" : "desktop";
const failing = q.get("fail") === "1";
const slow = q.get("slow") === "1";
const exportFail = q.get("exportfail");
const lang: Lang = q.get("lang") === "en" ? "en" : "vi";
const hasAi = q.get("ai") !== "0";

document.documentElement.dataset.theme = q.get("theme") === "light" ? "light" : "dark";
if (view === "mobile") document.documentElement.classList.add("is-android");
installFonts();

/** The wrap the `wrap` view opens: a finished week and month, the year still running. */
const WRAP_KIND: WrapKind = q.get("kind") === "week" || q.get("kind") === "year" ? (q.get("kind") as WrapKind) : "month";
const WRAP_START = q.get("start") ?? { week: "2026-11-16", month: "2026-10-01", year: "2026-01-01" }[WRAP_KIND];
const WRAP_FORMAT: Format = q.get("format") === "post" ? "post" : "story";

/** What `wrap_save_layout` was given, by wrap, as the app's database would keep it. */
const savedLayouts = new Map<string, { json: string; seed: number }>();
const seenWraps = new Set<string>();
(window as unknown as { __wrapExports: unknown[] }).__wrapExports = [];

type Args = Record<string, unknown>;
/** Stats commands: they can fail (`fail=1`) or answer late (`slow=1`), to see how the page waits and gives up. */
const STATS_COMMANDS = new Set(["stats_summary", "stats_period", "stats_day", "manual_readings", "wraps_pending", "wraps_list", "wrap_get"]);
const later = <T,>(value: () => T): T | Promise<T> => (slow ? new Promise<T>((resolve) => window.setTimeout(() => resolve(value()), 8000)) : value());

mockIPC((cmd, payload) => {
  const a = (payload ?? {}) as Args;
  if (failing && STATS_COMMANDS.has(cmd)) throw new Error("preview: failing on purpose");
  switch (cmd) {
    case "stats_summary":
      return later(summary);
    case "kindle_activity_tick":
      return { minutes: 0, moved: false };
    case "genre_fill":
      return 0;
    // Android's Usage access: the phone view starts without it (`usage=granted` with it); opening the settings grants it.
    case "kindle_usage_status":
      return { supported: view === "mobile", granted: settings.usageGranted, enabled: settings.kindleApp };
    case "kindle_usage_open_settings":
      settings.usageGranted = true;
      return null;
    case "amazon_days_refresh":
      return amazonDays();
    case "stats_period":
      return later(() => periodStats(a.kind as PeriodKind, (a.anchor as string | null) ?? null));
    case "stats_day":
      return dayMarks(a.day as string);
    case "genre_list":
      return GENRES;
    case "manual_readings":
      return manualOn(a.day as string);
    case "log_manual_reading":
      logManual(a.day as string, (a.asin as string | null) ?? null, (a.title as string | null) ?? null, a.minutes as number);
      return null;
    case "delete_manual_reading":
      deleteManual(a.day as string, a.asin as string);
      return null;
    case "book_genre":
      return bookGenre(a.asin as string);
    case "set_book_genre":
      setBookGenre(a.asin as string, (a.genre as string | null) ?? null);
      return null;
    case "goodreads_info":
    case "goodreads_details":
      return goodreadsState(a.asin as string);
    case "local_book_info":
      return null;
    case "ai_key_status":
      return { anthropic: hasAi ? "sk-preview" : null, deepseek: null };
    case "stats_profile_ai":
      return "Một độc giả đêm khuya, đọc đều đặn và kiên nhẫn với những cuốn dày. (Câu do AI viết, dùng thử trên trang xem trước.)";
    case "set_stats_settings":
      if (typeof a.goalMinutes === "number") settings.goalMinutes = a.goalMinutes;
      if (typeof a.goalBooksYear === "number") settings.goalBooksYear = a.goalBooksYear;
      if (typeof a.kindleEstimates === "boolean") settings.kindleEstimates = a.kindleEstimates;
      if (typeof a.kindleAppUsage === "boolean") settings.kindleApp = a.kindleAppUsage;
      return null;
    case "wraps_pending":
      return wrapSummaries().filter((w) => !w.seen && !seenWraps.has(`${w.kind}:${w.period_start}`));
    case "wraps_list":
      return wrapSummaries().filter((w) => !w.preview);
    case "wrap_get": {
      const key = `${a.kind}:${a.periodStart}`;
      const doc = wrapDoc(a.kind as WrapKind, a.periodStart as string);
      const saved = savedLayouts.get(key);
      if (saved) return { ...doc, layout_json: saved.json, seed: saved.seed };
      // The view's own format and colour: a layout made as the app would make it.
      if (wrapView && (WRAP_FORMAT !== "story" || q.get("card"))) {
        const theme = q.get("card");
        const layout = newLayout(doc.kind, doc.period_start, iconFacts(doc.stats, summary().badges), { format: WRAP_FORMAT, theme: isThemeId(theme) ? theme : undefined });
        return { ...doc, layout_json: layoutJson(layout) };
      }
      return doc;
    }
    case "wrap_save_layout":
      savedLayouts.set(`${a.kind}:${a.periodStart}`, { json: a.layoutJson as string, seed: a.seed as number });
      return null;
    case "wrap_mark_seen":
      seenWraps.add(`${a.kind}:${a.periodStart}`);
      return null;
    case "wrap_delete":
      deleteWrap(a.kind as string, a.periodStart as string);
      return null;
    case "wrap_export": {
      if (exportFail) throw new Error(exportFail);
      // The picture arrives as raw bytes; the preview only reports what it got (see `window.__wrapExports`).
      const bytes = payload as unknown as ArrayBuffer | Uint8Array;
      (window as unknown as { __wrapExports: unknown[] }).__wrapExports.push({ bytes: bytes.byteLength, png: Array.from(new Uint8Array(bytes instanceof ArrayBuffer ? bytes : bytes.buffer, 0, 8)) });
      return "preview";
    }
    default:
      console.warn(`[stats preview] unanswered command: ${cmd}`, a);
      return null;
  }
});

/** The Goodreads side of a book's page: a match with genres, or none for the book the story has no genre for. */
function goodreadsState(asin: string) {
  const row = libraryRows().find((r) => r.asin === asin);
  if (!row || asin === "PV0025") return { status: "none", book: null, manual: false, details: null, details_status: "none" };
  const book = { book_id: asin, title: row.title, author: row.author, rating: 4.1, ratings_count: 120000, pages: 320, description: null, series: null, series_pos: null, url: "https://www.goodreads.com/", image_url: null };
  const details = { description: null, genres: ["Fiction", "Classics"], published: null, rating: 4.1, ratings_count: 120000, rating_dist: [], reviews_count: 0, reviews: [] };
  return { status: "found", book, manual: false, details, details_status: "ok" };
}

/** Books behind the title bar of the desktop view, so the popover sits over something. */
function Backdrop() {
  return (
    <div className="pv-library" aria-hidden="true">
      {libraryRows().map((r) => <i key={r.asin} style={{ background: r.spine_color }} />)}
    </div>
  );
}

function Desktop() {
  const t = STR[lang];
  const stats = useStats(true);
  const rows = useMemo(libraryRows, []);
  const [showStats, setShowStats] = useState(!wrapView);
  const wraps = useWraps(stats.summary);
  const [wrapOpen, setWrapOpen] = useState<WrapSummary | null>(
    wrapView ? { kind: WRAP_KIND, period_start: WRAP_START, period_end: "", preview: false, seen: false, seed: 0, has_layout: false } : null,
  );
  const openWrap = (w: WrapSummary) => {
    wraps.markSeen(w);
    setWrapOpen(w);
  };

  useEffect(() => {
    if (q.get("open") === "streak") window.setTimeout(() => document.querySelector<HTMLButtonElement>(".streakbtn")?.click(), 400);
    if (q.get("open") === "manual") window.setTimeout(() => document.querySelector<HTMLButtonElement>(".stx-head [aria-haspopup='dialog']")?.click(), 600);
  }, []);

  return (
    <div className="app">
      <header className="titlebar">
        <button className="brand" onClick={() => setShowStats(false)} aria-label={t.library}>
          <img className="brand__icon" src="/app-icon.png" alt="" width={26} height={26} draggable={false} />
          <span className="brand__name">{t.appName}</span>
        </button>
        <div className="titlebar__spacer" />
        <StreakButton lang={lang} s={stats.summary} onClick={() => { setShowStats(true); stats.refresh(); }} />
        <button className="iconbtn" aria-label={t.sync}><Icon name="sync" size={19} /></button>
      </header>
      <div className="app__body">
        {showStats ? (
          <StatsPage lang={lang} s={stats.summary} loadFailed={stats.failed} rows={rows} onBack={() => setShowStats(false)} onChanged={stats.refresh} wraps={{ list: wraps.all, onOpen: openWrap, onDelete: wraps.remove }} />
        ) : (
          <main className="library">
            <WrapOffers lang={lang} offers={wraps.pending} onOpen={openWrap} onDismiss={wraps.markSeen} />
            <Backdrop />
          </main>
        )}
      </div>
      {wrapOpen && <WrapViewer lang={lang} kind={wrapOpen.kind} periodStart={wrapOpen.period_start} summary={stats.summary} onClose={() => setWrapOpen(null)} />}
    </div>
  );
}

function Phone({ tag, children }: { tag: string; children: React.ReactNode }) {
  return (
    <div className="pv-phone">
      <span className="pv-phone__tag">{tag}</span>
      <div className="app"><div className="app__body">{children}</div></div>
    </div>
  );
}

function Mobile() {
  const stats = useStats(true);
  const rows = useMemo(libraryRows, []);
  const reading = rows.filter((r) => r.status === "reading");
  const noop = () => undefined;
  const wraps = useWraps(stats.summary);
  const [wrapOpen, setWrapOpen] = useState<WrapSummary | null>(null);
  const openWrap = (w: WrapSummary) => {
    wraps.markSeen(w);
    setWrapOpen(w);
  };
  return (
    <div className="pv-phones">
      <Phone tag="Home">
        <div className="mobile-content">
          <div className="mobile-home">
            <WrapOffers lang={lang} offers={wraps.pending} onOpen={openWrap} onDismiss={wraps.markSeen} />
            <HomeStreakCard lang={lang} summary={stats.summary} reading={reading} onOpen={noop} />
            <HomeYearRow lang={lang} summary={stats.summary} rows={rows} onOpen={noop} />
          </div>
        </div>
        {wrapOpen && <WrapViewer lang={lang} kind={wrapOpen.kind} periodStart={wrapOpen.period_start} summary={stats.summary} onClose={() => setWrapOpen(null)} />}
      </Phone>
      <Phone tag="Stats">
        <MobileStatsPage lang={lang} s={stats.summary} loadFailed={stats.failed} rows={rows} onBack={noop} onChanged={stats.refresh} wraps={{ list: wraps.all, onOpen: openWrap, onDelete: wraps.remove }} />
      </Phone>
    </div>
  );
}

/** The `wrap` view on a phone: the viewer alone, in a 390px frame. */
function MobileWrap() {
  const stats = useStats(true);
  return (
    <div className="pv-phones">
      <Phone tag={`${WRAP_KIND} · ${WRAP_FORMAT}`}>
        <WrapViewer lang={lang} kind={WRAP_KIND} periodStart={WRAP_START} summary={stats.summary} onClose={() => undefined} />
      </Phone>
    </div>
  );
}

/** A book's page, as the desktop page or the phone's sheet: it has the genre picker. */
function BookPage() {
  const stats = useStats(true);
  const rows = useMemo(libraryRows, []);
  const row = rows.find((r) => r.asin === q.get("asin")) ?? rows[rows.length - 2];
  const props = {
    row,
    lang,
    onClose: () => undefined,
    onRead: () => undefined,
    onEdit: () => undefined,
    onStatus: () => undefined,
    onGenreChanged: stats.refresh,
  };
  return view === "mobile" ? (
    <div className="pv-phones">
      <Phone tag="Book"><MobileBookSheet {...props} /></Phone>
    </div>
  ) : (
    <div className="app"><div className="app__body"><BookDetail {...props} /></div></div>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(bookView ? <BookPage /> : wrapView && view === "mobile" ? <MobileWrap /> : view === "mobile" ? <Mobile /> : <Desktop />);
