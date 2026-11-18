import { useRef, type KeyboardEvent } from "react";
import { STR, type Lang } from "./i18n";
import { type LibraryRow, type LibraryView, type ReadStatus } from "./types";
import { BookCover } from "./BookCover";
import { Icon } from "./icons";
import { continueBook, isReadable, statusLabel } from "./bookInfo";
import { Bookcase } from "./Bookcase";

type T = (typeof STR)[Lang];

export interface BookActions {
  /** Open the book (reader) from this cover element. */
  read: (row: LibraryRow, from: Element | null) => void;
  /** Open the detail page from this cover element. */
  details: (row: LibraryRow, from: Element | null) => void;
}

/** Reading progress as a thin bar along the foot of the cover (no number). */
function CoverProgress({ percent }: { percent: number | null }) {
  if (percent == null || percent <= 0) return null;
  const p = Math.min(100, Math.max(0, percent));
  return (
    <div className="cover-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(p)}>
      <div className="cover-progress__fill" style={{ width: `${p}%` }} />
    </div>
  );
}

/** A book is its cover: click to read (or to see details if it can't be read here). */
export function BookCard({ row, t, actions, size }: { row: LibraryRow; t: T; actions: BookActions; size?: "lg" }) {
  const readable = isReadable(row);
  const coverEl = () => document.querySelector(`[data-cover-asin="${CSS.escape(row.asin)}"]`);
  const open = (e: { currentTarget: Element }) => {
    const el = e.currentTarget.querySelector("[data-cover-asin]") ?? coverEl();
    if (readable) actions.read(row, el);
    else actions.details(row, el);
  };
  return (
    <article
      className={`card${size === "lg" ? " card--lg" : ""}`}
      onClick={open}
      onKeyDown={(e: KeyboardEvent<HTMLElement>) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open(e);
        } else if (e.key.toLowerCase() === "i") {
          actions.details(row, e.currentTarget.querySelector("[data-cover-asin]"));
        }
      }}
      role="button"
      tabIndex={0}
      aria-label={`${readable ? t.readBook : t.details}: ${row.title}${row.author ? ` — ${row.author}` : ""}`}
      title={row.author ? `${row.title}\n${row.author}` : row.title}
    >
      <div className="card__cover" data-cover-asin={row.asin}>
        <BookCover row={row} />
        <CoverProgress percent={row.percent} />
      </div>
      <button
        className="card__info"
        onClick={(e) => {
          e.stopPropagation();
          actions.details(row, e.currentTarget.parentElement?.querySelector("[data-cover-asin]") ?? null);
        }}
        title={t.details}
        aria-label={`${t.details}: ${row.title}`}
      >
        <Icon name="info" size={18} />
      </button>
    </article>
  );
}

/** "Continue reading": the book you were in the middle of, front and centre. */
function Hero({ row, t, actions }: { row: LibraryRow; t: T; actions: BookActions }) {
  const pct = Math.round(row.percent ?? 0);
  const ref = useRef<HTMLDivElement>(null);
  return (
    <section className="hero-book" style={{ ["--tint" as string]: row.spine_color }}>
      <div
        className="hero-book__cover"
        ref={ref}
        data-cover-asin={row.asin}
        onClick={() => actions.read(row, ref.current)}
        role="button"
        tabIndex={-1}
      >
        <BookCover row={row} />
      </div>
      <div className="hero-book__body">
        <div className="eyebrow">{t.continueReading}</div>
        <h2 className="hero-book__title">{row.title}</h2>
        {row.author && <div className="hero-book__author">{row.author}</div>}
        <div className="meter" aria-label={`${pct}%`}>
          <div className="meter__bar">
            <div className="meter__fill" style={{ width: `${pct}%` }} />
          </div>
          <span className="meter__text">
            {pct}% {t.progressDone}
          </span>
        </div>
        {row.description && <p className="hero-book__desc">{row.description}</p>}
        <div className="hero-book__actions">
          <button className="btn btn--primary btn--lg" onClick={() => actions.read(row, ref.current)}>
            <Icon name="play" size={18} />
            {t.continueBtn}
          </button>
          <button className="btn btn--ghost btn--lg" onClick={() => actions.details(row, ref.current)}>
            <Icon name="info" size={18} />
            {t.details}
          </button>
        </div>
      </div>
    </section>
  );
}

function ListRow({ row, t, actions }: { row: LibraryRow; t: T; actions: BookActions }) {
  const pct = row.percent != null ? Math.round(row.percent) : null;
  const readable = isReadable(row);
  const cover = () => document.querySelector(`.list__row [data-cover-asin="${CSS.escape(row.asin)}"]`);
  return (
    <div
      className="list__row"
      role="button"
      tabIndex={0}
      onClick={() => (readable ? actions.read(row, cover()) : actions.details(row, cover()))}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          if (readable) actions.read(row, cover());
          else actions.details(row, cover());
        }
      }}
    >
      <div className="list__cover" data-cover-asin={row.asin}>
        <BookCover row={row} />
      </div>
      <div className="list__main">
        <div className="list__title">{row.title}</div>
        <div className="list__author muted">{row.author || t.noAuthor}</div>
      </div>
      <span className={`status-pill status-pill--${row.status}`}>{statusLabel(t, row.status)}</span>
      <div className="list__progress">
        {pct != null && pct > 0 && (
          <>
            <div className="meter__bar">
              <div className="meter__fill" style={{ width: `${pct}%` }} />
            </div>
            <span className="muted small">{pct}%</span>
          </>
        )}
      </div>
      <button
        className="iconbtn"
        onClick={(e) => {
          e.stopPropagation();
          actions.details(row, cover());
        }}
        title={t.details}
        aria-label={`${t.details}: ${row.title}`}
      >
        <Icon name="info" size={18} />
      </button>
    </div>
  );
}

/**
 * The library body. Shelves: "continue reading" + a 3D bookcase with one
 * shelf per reading status. Grid / list: every (filtered, sorted) book. A search always shows
 * a flat grid of matches.
 */
export function Library({
  rows,
  all,
  view,
  searching,
  lang,
  actions,
  onSeeAll,
  onArrange,
}: {
  rows: LibraryRow[];
  all: LibraryRow[];
  view: LibraryView;
  searching: boolean;
  lang: Lang;
  actions: BookActions;
  onSeeAll: (s: ReadStatus) => void;
  onArrange: (asin: string, status: ReadStatus, order: string[]) => void;
}) {
  const t = STR[lang];
  if (rows.length === 0) {
    return <div className="center muted">{searching ? t.noResults : t.empty}</div>;
  }
  if (view === "list" && !searching) {
    return (
      <div className="list">
        {rows.map((r) => (
          <ListRow key={r.asin} row={r} t={t} actions={actions} />
        ))}
      </div>
    );
  }
  if (view === "grid" || searching) {
    return (
      <div className="grid">
        {rows.map((r) => (
          <BookCard key={r.asin} row={r} t={t} actions={actions} />
        ))}
      </div>
    );
  }

  const hero = continueBook(all);
  return (
    <div className="shelves">
      {hero && <Hero row={hero} t={t} actions={actions} />}
      <Bookcase
        rows={rows.filter((r) => r.asin !== hero?.asin)}
        lang={lang}
        actions={actions}
        onSeeAll={onSeeAll}
        onArrange={onArrange}
      />
    </div>
  );
}
