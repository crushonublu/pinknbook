import { useMemo, useState } from "react";
import { STR, type Lang } from "../i18n";
import { Icon } from "../icons";
import type { WrapSummary } from "../stats/types";
import { iconUrl } from "./icons";
import { wrapKey } from "./useWraps";
import { WRAP_ICON, kindBadge, listLabel, offerTitle, rowPeriod } from "./wording";
import "./wrap.css";

/**
 * The wrap-ups on offer, as cards at the top of Home: "Tổng kết tháng 11 đã sẵn
 * sàng". The card opens the wrap; the small cross hides it (it is not offered
 * again, but stays in the list in Stats).
 */
export function WrapOffers({ lang, offers, onOpen, onDismiss }: {
  lang: Lang;
  offers: WrapSummary[];
  onOpen: (w: WrapSummary) => void;
  onDismiss: (w: WrapSummary) => void;
}) {
  const t = STR[lang];
  if (!offers.length) return null;
  return (
    <div className="wo-list">
      {offers.map((w) => (
        <div key={wrapKey(w)} className="wo scard-theme--wine">
          <button className="wo__main" onClick={() => onOpen(w)}>
            <img src={iconUrl(WRAP_ICON[w.kind], 256) ?? undefined} alt="" width={56} height={56} draggable={false} />
            <span className="wo__text">
              <span className="wo__title">{offerTitle(lang, w)}</span>
              <span className="wo__see">{t.wrHomeSee}<Icon name="arrowR" size={16} /></span>
            </span>
          </button>
          <button className="wo__x" onClick={() => onDismiss(w)} aria-label={`${t.wrHomeDismiss}: ${offerTitle(lang, w)}`}><Icon name="close" size={16} /></button>
        </div>
      ))}
    </div>
  );
}

/**
 * "Các bản tổng kết": every wrap that can be opened again, newest first, under
 * the year it ended in. Each row has its kind as a badge; a saved wrap can be
 * deleted after one more tap (a preview is not saved, so it has nothing to delete).
 */
export function WrapList({ lang, wraps, onOpen, onDelete }: {
  lang: Lang;
  wraps: WrapSummary[];
  onOpen: (w: WrapSummary) => void;
  onDelete: (w: WrapSummary) => void;
}) {
  const t = STR[lang];
  const [asking, setAsking] = useState<string | null>(null);
  const years = useMemo(() => {
    const groups = new Map<string, WrapSummary[]>();
    for (const w of wraps) groups.set(w.period_end.slice(0, 4), [...(groups.get(w.period_end.slice(0, 4)) ?? []), w]);
    return [...groups].sort((a, b) => b[0].localeCompare(a[0]));
  }, [wraps]);
  return (
    <section className="scx wl" aria-label={t.wrListTitle}>
      <h2 className="scx__h2">{t.wrListTitle}</h2>
      {wraps.length === 0 ? (
        <p className="scx__sub">{t.wrListEmpty}</p>
      ) : (
        years.map(([year, list]) => (
          <div key={year} className="wl__year">
            <h3 className="wl__yearname">{year}</h3>
            <ul className="wl__list">
              {list.map((w) => {
                const key = wrapKey(w);
                const label = listLabel(lang, w);
                return (
                  <li key={key} className={asking === key ? "is-asking" : undefined}>
                    {asking === key ? (
                      <div className="wl__ask" role="group" aria-label={`${t.wrDeleteAsk}: ${label}`}>
                        <span className="wl__asktext">{t.wrDeleteAsk}<small>{label} · {t.wrDeleteNote}</small></span>
                        <button className="wl__yes" onClick={() => { setAsking(null); onDelete(w); }}>{t.wrDeleteYes}</button>
                        <button className="wl__no" onClick={() => setAsking(null)} autoFocus>{t.wrDeleteKeep}</button>
                      </div>
                    ) : (
                      <>
                        <button className="wl__open" onClick={() => onOpen(w)} aria-label={label}>
                          <img src={iconUrl(WRAP_ICON[w.kind], 256) ?? undefined} alt="" width={40} height={40} draggable={false} />
                          <span className={`wl__kind wl__kind--${w.kind}`}>{kindBadge(lang, w)}</span>
                          <span className="wl__label">{rowPeriod(lang, w)}</span>
                          {w.preview && <span className="wl__tag">{t.wrPreview}</span>}
                          <Icon name="arrowR" size={16} />
                        </button>
                        {w.preview ? (
                          <span className="wl__del" aria-hidden="true" />
                        ) : (
                          <button className="wl__del" onClick={() => setAsking(key)} aria-label={`${t.wrDelete}: ${label}`}><Icon name="trash" size={16} /></button>
                        )}
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ))
      )}
    </section>
  );
}
