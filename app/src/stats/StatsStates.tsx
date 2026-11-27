import { STR, type Lang } from "../i18n";
import { Icon } from "../icons";

/**
 * Cards standing in while the stats load: grey blocks where the numbers will be.
 * They pulse only for readers who have not asked for less motion (stats.css).
 */
export function StatsSkeleton({ lang }: { lang: Lang }) {
  const t = STR[lang];
  return (
    <div className="scx-skel" role="status" aria-busy="true" aria-label={t.loading}>
      {[0, 1, 2].map((i) => (
        <div key={i} className="scx scx-skel__card" aria-hidden="true">
          <i className="scx-skel__bar scx-skel__bar--short" />
          <i className="scx-skel__bar scx-skel__bar--big" />
          <i className="scx-skel__block" />
        </div>
      ))}
    </div>
  );
}

/** The stats could not be loaded: say so, and offer to try again. */
export function StatsError({ lang, onRetry }: { lang: Lang; onRetry: () => void }) {
  const t = STR[lang];
  return (
    <section className="scx scx-empty" role="alert">
      <Icon name="refresh" size={28} />
      <p className="scx-empty__title">{t.sxLoadFailed}</p>
      <button className="scx__btn" onClick={onRetry}>{t.sxRetry}</button>
    </section>
  );
}

/**
 * A reader with nothing on record yet (no reading, no finished book): one
 * friendly card instead of a page of zeros and empty charts. Paper reading can
 * be added from here, which is the other way to start.
 */
export function EmptyStats({ lang, onAddPaper }: { lang: Lang; onAddPaper: (button: HTMLElement) => void }) {
  const t = STR[lang];
  return (
    <section className="scx scx-empty" aria-labelledby="scx-empty-title">
      <Icon name="chart" size={32} />
      <h2 id="scx-empty-title" className="scx-empty__title">{t.sxEmptyTitle}</h2>
      <p className="scx__sub">{t.sxEmptyBody}</p>
      <button className="scx__btn" onClick={(e) => onAddPaper(e.currentTarget)}>{t.prAdd}</button>
    </section>
  );
}
