import { STR, type Lang } from "../i18n";
import { RefCover } from "./BookCover";
import { fmt, names, unitOf } from "./format";
import type { PeriodStats } from "./types";

/** Covers shown inside a bar; the number at its end has the full count. */
const MAX_COVERS = 4;
/** Covers stacked in a desktop column before the rest is counted. */
const MAX_STACK = 6;

/**
 * Books finished, a row per month of a year (or per year for "all time"): a
 * bar as long as the count, holding the covers of the books finished then.
 * On the desktop page (`desktop`) it is a column per month instead, the
 * covers piled up from the baseline, all twelve months of the year shown.
 */
export function FinishedByMonth({ lang, p, today, desktop = false }: { lang: Lang; p: PeriodStats; today: string; desktop?: boolean }) {
  const t = STR[lang];
  const all = p.kind === "all";
  const monthNames = names(t.sxMonthNames);

  // Rows: key (`YYYY-MM` or `YYYY`), label and the books finished under it.
  const bucket = (key: string) => p.finished.filter((f) => f.day.startsWith(key));
  const rows = all
    ? [...new Set(p.months.map((m) => m.month.slice(0, 4)))].sort().reverse().map((y) => ({ key: y, label: y }))
    : p.months.filter((m) => desktop || m.month <= today.slice(0, 7)).map((m) => ({ key: m.month, label: monthNames[Number(m.month.slice(5, 7)) - 1] }));
  const counts = rows.map((r) => bucket(r.key).length);
  const most = Math.max(1, ...counts);
  const count = all ? p.finished.length + p.finished_undated : p.finished.length;

  return (
    <section className="scx scx-fin">
      <div className="scx__stack">
        <span className="scx__label">{t.sxFinished}</span>
        <span className="scx__hero"><span className="scx__acc">{count}</span> {unitOf(t.sxBooksN)}{desktop && ` ${all ? t.sxAllTime : fmt(t.sxInYear, p.start.slice(0, 4))}`}</span>
        {!desktop && <span className="scx__sub">{all ? t.sxAllTime : fmt(t.sxInYear, p.start.slice(0, 4))}</span>}
      </div>
      {p.finished.length === 0 ? (
        <p className="scx__sub">{t.sxNoFinished}</p>
      ) : desktop ? (
        <div className="scx-fin__cols" style={{ gridTemplateColumns: `repeat(${rows.length}, minmax(0, 1fr))` }}>
          {rows.map((r, i) => {
            const shown = bucket(r.key).slice(0, MAX_STACK);
            return (
              <div key={r.key} className={`scx-fin__col${today.startsWith(r.key) ? " is-now" : ""}`}>
                <div className="scx-fin__stack" aria-label={fmt(t.sxBooksN, counts[i])}>
                  {shown.map((b) => (
                    <span key={b.asin} className="scx-cover scx-cover--stack" title={b.title}><RefCover asin={b.asin} book={p.books[b.asin]} /></span>
                  ))}
                  {counts[i] > shown.length && <span className="scx-fin__more" title={fmt(t.pcMore, counts[i] - shown.length)}>+{counts[i] - shown.length}</span>}
                </div>
                <span className="scx-fin__rule" />
                <span className="scx-fin__label">{r.label}</span>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="scx-fin__rows">
          {rows.map((r, i) => {
            const books = bucket(r.key);
            return (
              <div key={r.key} className="scx-fin__row">
                <span className="scx-fin__label">{r.label}</span>
                <div className="scx-fin__track">
                  {books.length > 0 && (
                    <div className="scx-fin__bar" style={{ width: `${Math.max(18, Math.round((counts[i] / most) * 100))}%` }}>
                      {books.slice(-MAX_COVERS).map((b) => (
                        <span key={b.asin} className="scx-cover scx-cover--fin" title={b.title}><RefCover asin={b.asin} book={p.books[b.asin]} /></span>
                      ))}
                    </div>
                  )}
                </div>
                <span className="scx-fin__n" aria-label={fmt(t.sxBooksN, counts[i])}>{counts[i]}</span>
              </div>
            );
          })}
        </div>
      )}
      {all && p.finished_undated > 0 && <p className="scx__sub">{fmt(t.sxUndated, p.finished_undated)}</p>}
    </section>
  );
}
