import { MobilePicker } from "./MobilePicker";
import { useEffect, useRef, type ReactNode } from "react";
import { STR, type Lang } from "../i18n";
import { BookCover } from "../BookCover";
import { continueBook, isLocal, isReadable, statusLabel } from "../bookInfo";
import { EmptyLibrary } from "../LocalImport";
import { LibrarySkeleton } from "../LibrarySkeleton";
import { Icon } from "../icons";
import { HomeStreakCard, HomeYearRow } from "../stats/HomeCards";
import type { StatsSummary } from "../Stats";
import type { LibraryRow, LibraryView, ReadStatus, SortKey } from "../types";

export type MobileTab = "home" | "library" | "vocab" | "account";
export type MobileSource = "all" | "local" | "amazon";
export function TabIcon({ tab }: { tab: MobileTab }) {
  return <Icon name={tab === "account" ? "user" : tab} size={24} />;
}
export function MobileTabs({ tab, onTab, lang, blocked = false }: { tab: MobileTab; onTab: (t: MobileTab) => void; lang: Lang; blocked?: boolean }) {
  const t = STR[lang];
  return <nav className="mobile-tabs" inert={blocked} aria-label={t.mobileNavigation}>{(["home", "library", "vocab", "account"] as const).map((id) => <button key={id} aria-current={tab === id ? "page" : undefined} onClick={() => onTab(id)}><TabIcon tab={id} /><span>{id === "home" ? t.mobileHome : id === "library" ? t.library : id === "vocab" ? t.vbTitle : t.account}</span></button>)}</nav>;
}
export function MobileHeader({ title, children, count }: { title: string; children?: ReactNode; count?: string }) {
  return <header className="mobile-header"><h1>{title} {count && <span>· {count}</span>}</h1><div className="mobile-header__actions">{children}</div></header>;
}
export const percent = (row: LibraryRow) => Math.min(100, Math.max(0, Math.round(row.percent ?? 0)));
export function MobileBook({ row, lang, onRead, onDetail, list = false }: { row: LibraryRow; lang: Lang; onRead: (r: LibraryRow) => void; onDetail: (r: LibraryRow) => void; list?: boolean }) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const held = useRef(false);
  const start = useRef({ x: 0, y: 0 });
  const cancel = () => clearTimeout(timer.current);
  useEffect(() => cancel, []);
  const t = STR[lang];
  return <button className={`mobile-book${list ? " mobile-book--list" : ""}`} onPointerDown={(e) => {
    if (e.button !== 0) return;
    held.current = false; start.current = { x: e.clientX, y: e.clientY };
    timer.current = setTimeout(() => { held.current = true; onDetail(row); }, 500);
  }} onPointerMove={(e) => { if (Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > 10) cancel(); }} onPointerUp={cancel} onPointerCancel={cancel} onPointerLeave={cancel}
    onContextMenu={(e) => { e.preventDefault(); cancel(); if (!held.current) onDetail(row); held.current = true; }}
    onClick={() => { if (held.current) { held.current = false; return; } (isReadable(row) ? onRead : onDetail)(row); }}>
    <span className="mobile-book__cover" data-asin={row.asin}><BookCover row={row} /><span className="mobile-book__bar"><i style={{ width: `${percent(row)}%` }} /></span>{isLocal(row) && <span className="mobile-book__badge" aria-label={t.localBadge}><Icon name="monitor" size={13} /></span>}</span>
    <span className="mobile-book__info"><strong>{row.title}</strong>{list && <span className="muted">{row.author || t.noAuthor}</span>}<span className="muted">{row.percent != null ? `${percent(row)}%` : statusLabel(t, row.status)}</span></span>
  </button>;
}

type MobileSyncProps = { onSync?: () => void; syncing: boolean; syncBusy: boolean; progress: { done: number; total: number } | null };
function MobileSyncButton({ onSync, syncing, syncBusy, lang }: MobileSyncProps & { lang: Lang }) {
  const t = STR[lang];
  return onSync && <button className="iconbtn" onClick={onSync} disabled={syncBusy} aria-label={t.sync} title={t.sync} aria-busy={syncing}><Icon name="refresh" size={20} className={syncing ? "icon--spin" : undefined} /></button>;
}
function MobileSyncProgress({ syncing, progress, lang }: { syncing: boolean; progress: MobileSyncProps["progress"]; lang: Lang }) {
  return syncing && <p className="mobile-sync-progress" role="status">{STR[lang].mobileSyncProgress.replace("{0}", String(progress?.done ?? 0)).replace("{1}", String(progress?.total ?? 0))}</p>;
}

export function MobileHome({ rows, loading, lang, summary, wrapOffers, onRead, onDetail, onStats, onAdd, onSearch, onReadingBooks, adding, onSync, syncing, syncBusy, progress }: { rows: LibraryRow[]; loading?: boolean; lang: Lang; summary: StatsSummary | null; wrapOffers?: ReactNode; onRead: (r: LibraryRow) => void; onDetail: (r: LibraryRow) => void; onStats: () => void; onAdd: () => void; onSearch: () => void; onReadingBooks?: () => void; adding: boolean } & MobileSyncProps) {
  const t = STR[lang]; const book = continueBook(rows);
  const reading = rows.filter((r) => r.status === "reading" && r.asin !== book?.asin);
  const unread = rows.filter((r) => r.status === "unread").sort((a, b) => b.purchase_date.localeCompare(a.purchase_date));
  const shelves: { title: string; books: LibraryRow[] }[] = [
    { title: t.mobileInProgress, books: reading },
    { title: t.mobileNext, books: unread },
  ];
  return <><MobileHeader title={t.mobileHome}><button className="iconbtn" onClick={onSearch} aria-label={t.searchPlaceholder}><Icon name="search" size={20} /></button><MobileSyncButton onSync={onSync} syncing={syncing} syncBusy={syncBusy} progress={progress} lang={lang} /><button className="iconbtn" onClick={onAdd} disabled={adding} aria-label={t.addBooks}><Icon name="plus" size={20} /></button></MobileHeader>
    <MobileSyncProgress syncing={syncing} progress={progress} lang={lang} />
    <main className="mobile-content mobile-home">{loading ? <LibrarySkeleton kind="home" label={t.loading} /> : !rows.length ? <EmptyLibrary lang={lang} onAdd={onAdd} /> : <>
      {wrapOffers}
      <HomeStreakCard lang={lang} summary={summary} reading={book ? [book, ...reading] : reading} onOpen={onStats} />
      {book && <button className="mobile-continue" onClick={() => onRead(book)}><span className="mobile-continue__cover"><BookCover row={book} /></span><span className="mobile-continue__info"><small>{t.statusReading}</small><strong>{book.title}</strong><em>{book.author || t.noAuthor}</em><span className="mobile-progress"><span><i style={{ width: `${percent(book)}%` }} /></span><span>{percent(book)}%</span></span></span></button>}
      <HomeYearRow lang={lang} summary={summary} rows={rows} onOpen={onStats} />
      {shelves.map(({ title, books }, index) => books.length > 0 && <section key={title}><div className="mobile-home__shelfhead"><h2>{title}</h2>{index === 0 && onReadingBooks && <button className="linkbtn" onClick={onReadingBooks}>{t.seeAll}</button>}</div><div className="mobile-book-row">{books.map((r) => <MobileBook key={r.asin} row={r} lang={lang} onRead={onRead} onDetail={onDetail} />)}</div></section>)}
    </>}</main></>;
}

export function MobileLibrary({ rows, total, loading, mixed, lang, query, setQuery, sort, setSort, status, setStatus, source, setSource, view, setView, focus, onAdd, adding, onRead, onDetail, onSync, syncing, syncBusy, progress, matchFilter, onClearMatches }: {
  rows: LibraryRow[]; total: number; loading?: boolean; mixed: boolean; lang: Lang; query: string; setQuery: (q: string) => void; sort: SortKey; setSort: (s: SortKey) => void; status: ReadStatus | null; setStatus: (s: ReadStatus | null) => void; source: MobileSource; setSource: (s: MobileSource) => void; view: LibraryView; setView: (v: LibraryView) => void; focus: number; onAdd: () => void; adding: boolean; onRead: (r: LibraryRow) => void; onDetail: (r: LibraryRow) => void; matchFilter: boolean; onClearMatches: () => void;
} & MobileSyncProps) {
  const t = STR[lang]; const search = useRef<HTMLInputElement>(null);
  useEffect(() => { if (focus) search.current?.focus(); }, [focus]);
  return <><MobileHeader title={t.library} count={`${total} ${t.books}`}><MobileSyncButton onSync={onSync} syncing={syncing} syncBusy={syncBusy} progress={progress} lang={lang} /><button className="iconbtn" onClick={onAdd} disabled={adding} aria-label={t.addBooks}><Icon name="plus" size={20} /></button></MobileHeader>
    <MobileSyncProgress syncing={syncing} progress={progress} lang={lang} />
    <main className="mobile-content mobile-library"><label className="search"><Icon name="search" size={18} /><input ref={search} type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t.searchPlaceholder} aria-label={t.searchPlaceholder} /></label>
      <div className="mobile-chips">{matchFilter && <button className="is-active mobile-match-filter" onClick={onClearMatches}>{t.matchChip}<Icon name="close" size={16} /></button>}<button className={!status && source === "all" ? "is-active" : ""} onClick={() => { setStatus(null); setSource("all"); }}>{t.all}</button>{(["reading", "unread", "finished", "abandoned"] as const).map((s) => <button key={s} className={status === s ? "is-active" : ""} onClick={() => setStatus(status === s ? null : s)}>{statusLabel(t, s)}</button>)}{mixed && (["local", "amazon"] as const).map((s) => <button key={s} className={source === s ? "is-active" : ""} onClick={() => setSource(source === s ? "all" : s)}>{s === "local" ? t.typeLocal : t.mobileKindle}</button>)}</div>
      <div className="mobile-library__tools"><div className="mobile-library__sort"><Icon name="sort" size={16} /><MobilePicker label={t.sortBy} value={sort} options={[{ value: "recent", label: t.sortRecent }, { value: "title", label: t.sortTitle }, { value: "author", label: t.sortAuthor }, { value: "progress", label: t.sortProgress }]} onChange={setSort} /></div><div className="seg">{(["grid", "list"] as const).map((v) => <button key={v} className={`seg__btn${(view === "list" ? "list" : "grid") === v ? " seg__btn--on" : ""}`} aria-label={v === "grid" ? t.viewGrid : t.viewList} aria-pressed={(view === "list" ? "list" : "grid") === v} onClick={() => setView(v)}><Icon name={v} size={18} /></button>)}</div></div>
      {loading ? <LibrarySkeleton kind="grid" label={t.loading} /> : !total ? <EmptyLibrary lang={lang} onAdd={onAdd} /> : !rows.length ? <p className="center muted">{t.mobileNoResults}</p> : <div className={view === "list" ? "mobile-book-list" : "mobile-book-grid"}>{rows.map((r) => <MobileBook key={r.asin} row={r} lang={lang} list={view === "list"} onRead={onRead} onDetail={onDetail} />)}</div>}
    </main></>;
}
