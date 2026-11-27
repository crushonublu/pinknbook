import { STR, type Lang } from "../i18n";
import { RefCover } from "./BookCover";
import { fmtDuration } from "./format";
import type { PeriodStats } from "./types";

/** The books read longest in the period: the first as a headline, then bars. */
export function TopBooks({ lang, p }: { lang: Lang; p: PeriodStats }) {
  const t = STR[lang];
  const top = p.top_books[0];
  if (!top) {
    return (
      <section className="scx scx-top">
        <span className="scx__label">{t.sxTopTitle}</span>
        <p className="scx__sub">{t.noReadingYet}</p>
      </section>
    );
  }
  return (
    <section className="scx scx-top">
      <div className="scx__stack">
        <span className="scx__label">{t.sxTopTitle}</span>
        <span className="scx__hero scx__hero--title scx__acc">{top.title || top.asin}</span>
        <span className="scx__sub">{[fmtDuration(lang, top.seconds), top.author].filter(Boolean).join(" · ")}</span>
      </div>
      <ol className="scx-top__list">
        {p.top_books.map((b, i) => (
          <li key={b.asin}>
            <span className="scx-cover scx-cover--top" aria-hidden="true"><RefCover asin={b.asin} book={p.books[b.asin]} /></span>
            <div>
              <div className="scx-top__line"><span>{b.title || b.asin}</span><span>{fmtDuration(lang, b.seconds)}</span></div>
              <div className="scx-top__bar"><i className={i === 0 ? "is-first" : undefined} style={{ width: `${(b.seconds / top.seconds) * 100}%` }} /></div>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
