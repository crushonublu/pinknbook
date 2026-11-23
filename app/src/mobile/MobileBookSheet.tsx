import { useEffect, useRef, useState, type ComponentProps } from "react";
import BookDetail from "../BookDetail";
import { BookCover } from "../BookCover";
import { isReadable, statusLabel } from "../bookInfo";
import GoodreadsCard, { useGoodreads } from "../GoodreadsCard";
import { STR } from "../i18n";
import { Icon } from "../icons";
import { STATUS_ORDER, type ReadStatus } from "../types";
import { percent } from "./MobileShell";
import { useMobileDismiss } from "./back";

export default function MobileBookSheet({ row, lang, onClose, onRead, onEdit, onStatus, onRemove, twin, onLink, onUnlink, onDismissLink }: ComponentProps<typeof BookDetail>) {
  const t = STR[lang]; const gr = useGoodreads(row.asin);
  const [menu, setMenu] = useState(false); const [expanded, setExpanded] = useState(false);
  const close = useRef<HTMLButtonElement>(null); const sheet = useRef<HTMLElement>(null);
  const drag = useRef<number | null>(null);
  const latest = useRef({ menu, onClose });
  latest.current = { menu, onClose };
  useMobileDismiss(menu, () => setMenu(false));
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    close.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (document.querySelector(".modal")) return;
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        const cancel = sheet.current?.querySelector<HTMLButtonElement>(".gr__pickactions button:last-child");
        if (cancel) cancel.click();
        else if (latest.current.menu) setMenu(false);
        else latest.current.onClose();
      }
      if (e.key === "Tab") {
        const items = sheet.current?.querySelectorAll<HTMLElement>('button:not(:disabled), select, input, a[href], [tabindex="0"]');
        if (!items?.length) return;
        const first = items[0], last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener("keydown", key, true);
    return () => { window.removeEventListener("keydown", key, true); previous?.focus(); };
  }, []);
  const description = gr.st?.details?.description || gr.st?.book?.description;
  const rating = gr.st?.details?.rating ?? gr.st?.book?.rating;
  return <div className="mobile-sheet-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <section ref={sheet} className="mobile-sheet" role="dialog" aria-modal="true" aria-label={row.title}>
      <div className="mobile-sheet__handle" onPointerDown={(e) => { drag.current = e.clientY; e.currentTarget.setPointerCapture(e.pointerId); }} onPointerUp={(e) => { if (drag.current != null && e.clientY - drag.current > 70) onClose(); drag.current = null; }} onPointerCancel={() => { drag.current = null; }}><span /></div>
      <div className="mobile-sheet__tools"><button className="iconbtn" aria-label={t.mobileMore} aria-expanded={menu} onClick={() => setMenu(!menu)}>•••</button><button ref={close} className="iconbtn" aria-label={t.closeReader} onClick={onClose}><Icon name="close" size={22} /></button></div>
      {menu && <div className="mobile-sheet__menu" role="menu"><button role="menuitem" onClick={() => { setMenu(false); onEdit(); }}>{t.customize}</button>{onRemove && <button role="menuitem" onClick={() => { setMenu(false); onRemove(); }}>{t.removeBook}</button>}{twin && <><button role="menuitem" onClick={() => { setMenu(false); row.linked_asin ? onUnlink?.() : onLink?.(); }}>{row.linked_asin ? t.unlinkBtn : t.linkBtn}</button>{!row.linked_asin && <button role="menuitem" onClick={() => { setMenu(false); onDismissLink?.(); }}>{t.linkNot}</button>}</>}</div>}
      <div className="mobile-sheet__body"><div className="mobile-sheet__cover"><BookCover row={row} /></div><h2>{row.title}</h2><p className="mobile-sheet__author">{row.author || t.noAuthor}</p>
        <div className="mobile-sheet__stats"><div><b>{rating != null ? `★ ${new Intl.NumberFormat(lang, { maximumFractionDigits: 2 }).format(rating)}` : "—"}</b><small>{t.mobileGoodreads}</small></div><div><b>{percent(row)}%</b><small>{t.progressDone}</small></div><div><b>{gr.st?.book?.pages ?? "—"}</b><small>{t.grPages}</small></div></div>
        <label className="mobile-sheet__status"><span className="muted">{t.status}</span><select className="select" aria-label={t.status} value={row.status_manual ? row.status : "auto"} onChange={(e) => onStatus(e.target.value === "auto" ? null : e.target.value as ReadStatus)}><option value="auto">{t.statusAuto} ({statusLabel(t, (row.percent ?? 0) >= 97.5 ? "finished" : (row.percent ?? 0) > .5 ? "reading" : "unread")})</option>{STATUS_ORDER.map((s) => <option key={s} value={s}>{statusLabel(t, s)}</option>)}</select></label>
        {twin && <p className="muted">{row.linked_asin ? t.kindleTwin : t.linkSuggest}: {twin.title}</p>}
        {description && <section><h3>{t.about}</h3><p className={expanded ? "mobile-description is-open" : "mobile-description"}>{description}</p><button className="linkbtn" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? t.showLess : t.showMore}</button></section>}
        {!!row.subjects.length && <div className="tags">{row.subjects.map((tag) => <span className="tag" key={tag}>{tag}</span>)}</div>}
        <GoodreadsCard row={row} lang={lang} gr={gr} />
      </div>
      <footer className="mobile-sheet__footer">{isReadable(row) ? <button className="btn btn--primary" onClick={() => onRead(null)}><Icon name="play" size={18} />{percent(row) > 0 ? t.continueBtn : t.startReading}</button> : <p className="muted">{row.source === "local" ? t.fileMissing : t.notReadable}</p>}</footer>
    </section>
  </div>;
}
