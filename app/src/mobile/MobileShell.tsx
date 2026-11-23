import { useEffect, useRef, type ReactNode } from "react";
import { STR, type Lang } from "../i18n";
import { BookCover } from "../BookCover";
import { continueBook, isLocal, isReadable, statusLabel } from "../bookInfo";
import { EmptyLibrary } from "../LocalImport";
import { Icon } from "../icons";
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

export function MobileHome({ rows, lang, summary, onRead, onDetail, onStats, onAdd, onSearch, onReadingBooks, adding }: { rows: LibraryRow[]; lang: Lang; summary: StatsSummary | null; onRead: (r: LibraryRow) => void; onDetail: (r: LibraryRow) => void; onStats: () => void; onAdd: () => void; onSearch: () => void; onReadingBooks?: () => void; adding: boolean }) {
  const t = STR[lang]; const book = continueBook(rows);
  const minutes = Math.floor(((summary?.today_app_sec ?? 0) + (summary?.today_kindle_sec ?? 0)) / 60);
  const goal = summary?.goal_minutes ?? 10;
  const reading = rows.filter((r) => r.status === "reading" && r.asin !== book?.asin);
  const unread = rows.filter((r) => r.status === "unread").sort((a, b) => b.purchase_date.localeCompare(a.purchase_date));
  const shelves: { title: string; books: LibraryRow[] }[] = [
    { title: t.mobileInProgress, books: reading },
    { title: t.mobileNext, books: unread },
  ];
  return <><MobileHeader title={t.mobileHome}><button className="iconbtn" onClick={onSearch} aria-label={t.searchPlaceholder}><Icon name="search" size={20} /></button><button className="iconbtn" onClick={onAdd} disabled={adding} aria-label={t.addBooks}><Icon name="plus" size={20} /></button></MobileHeader>
    <main className="mobile-content mobile-home">{!rows.length ? <EmptyLibrary lang={lang} onAdd={onAdd} /> : <>
      {book && <button className="mobile-continue" onClick={() => onRead(book)}><span className="mobile-continue__cover"><BookCover row={book} /></span><span className="mobile-continue__info"><small>{t.statusReading}</small><strong>{book.title}</strong><em>{book.author || t.noAuthor}</em><span className="mobile-progress"><span><i style={{ width: `${percent(book)}%` }} /></span><span>{percent(book)}%</span></span></span></button>}
      <div className="mobile-tiles"><button onClick={onStats}><svg width="46" height="46" viewBox="0 0 46 46" aria-hidden="true"><circle cx="23" cy="23" r="19" fill="none" stroke="var(--border)" strokeWidth="5" /><circle cx="23" cy="23" r="19" fill="none" stroke="var(--accent)" strokeWidth="5" strokeDasharray={`${Math.min(1, minutes / Math.max(1, goal)) * 120} 120`} transform="rotate(-90 23 23)" /></svg><span><b>{t.minutesN.replace("{0}", `${minutes}/${goal}`)}</b><small>{t.mobileTodayGoal}</small></span></button><button onClick={onStats}><Icon name="flame" size={34} /><span><b>{t.streakDays.replace("{0}", String(summary?.streak.current ?? 0))}</b><small>{t.mobileStreak}</small></span></button></div>
      {shelves.map(({ title, books }, index) => books.length > 0 && <section key={title}><div className="mobile-home__shelfhead"><h2>{title}</h2>{index === 0 && onReadingBooks && <button className="linkbtn" onClick={onReadingBooks}>{t.seeAll}</button>}</div><div className="mobile-book-row">{books.map((r) => <MobileBook key={r.asin} row={r} lang={lang} onRead={onRead} onDetail={onDetail} />)}</div></section>)}
    </>}</main></>;
}

export function MobileLibrary({ rows, total, mixed, lang, query, setQuery, sort, setSort, status, setStatus, source, setSource, view, setView, focus, onAdd, adding, onRead, onDetail }: {
  rows: LibraryRow[]; total: number; mixed: boolean; lang: Lang; query: string; setQuery: (q: string) => void; sort: SortKey; setSort: (s: SortKey) => void; status: ReadStatus | null; setStatus: (s: ReadStatus | null) => void; source: MobileSource; setSource: (s: MobileSource) => void; view: LibraryView; setView: (v: LibraryView) => void; focus: number; onAdd: () => void; adding: boolean; onRead: (r: LibraryRow) => void; onDetail: (r: LibraryRow) => void;
}) {
  const t = STR[lang]; const search = useRef<HTMLInputElement>(null);
  useEffect(() => { if (focus) search.current?.focus(); }, [focus]);
  return <><MobileHeader title={t.library} count={`${total} ${t.books}`}><button className="iconbtn" onClick={onAdd} disabled={adding} aria-label={t.addBooks}><Icon name="plus" size={20} /></button></MobileHeader>
    <main className="mobile-content mobile-library"><label className="search"><Icon name="search" size={18} /><input ref={search} type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t.searchPlaceholder} aria-label={t.searchPlaceholder} /></label>
      <div className="mobile-chips"><button className={!status && source === "all" ? "is-active" : ""} onClick={() => { setStatus(null); setSource("all"); }}>{t.all}</button>{(["reading", "unread", "finished", "abandoned"] as const).map((s) => <button key={s} className={status === s ? "is-active" : ""} onClick={() => setStatus(status === s ? null : s)}>{statusLabel(t, s)}</button>)}{mixed && (["local", "amazon"] as const).map((s) => <button key={s} className={source === s ? "is-active" : ""} onClick={() => setSource(source === s ? "all" : s)}>{s === "local" ? t.typeLocal : t.mobileKindle}</button>)}</div>
      <div className="mobile-library__tools"><label className="select select--ghost"><Icon name="sort" size={16} /><select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label={t.sortBy}>{([['recent', t.sortRecent], ['title', t.sortTitle], ['author', t.sortAuthor], ['progress', t.sortProgress]] as const).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label><div className="seg">{(["grid", "list"] as const).map((v) => <button key={v} className={`seg__btn${(view === "list" ? "list" : "grid") === v ? " seg__btn--on" : ""}`} aria-label={v === "grid" ? t.viewGrid : t.viewList} aria-pressed={(view === "list" ? "list" : "grid") === v} onClick={() => setView(v)}><Icon name={v} size={18} /></button>)}</div></div>
      {!total ? <EmptyLibrary lang={lang} onAdd={onAdd} /> : !rows.length ? <p className="center muted">{t.mobileNoResults}</p> : <div className={view === "list" ? "mobile-book-list" : "mobile-book-grid"}>{rows.map((r) => <MobileBook key={r.asin} row={r} lang={lang} list={view === "list"} onRead={onRead} onDetail={onDetail} />)}</div>}
    </main></>;
}
