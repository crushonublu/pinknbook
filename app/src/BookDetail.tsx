import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { STR, type Lang } from "./i18n";
import { STATUS_ORDER, type LibraryRow, type ReadStatus } from "./types";
import { BookCover, coverUrl } from "./BookCover";
import { Icon } from "./icons";
import { isReadable, languageName, relativeTime, statusLabel } from "./bookInfo";
import { SHARED } from "./transitions";

/**
 * A book's page: big cover on a blurred wash of itself, title and author,
 * progress, status, genres and the description. The cover carries the shared
 * transition name so it morphs from / back into the library cover.
 */
export default function BookDetail({
  row,
  lang,
  onClose,
  onRead,
  onEdit,
  onStatus,
}: {
  row: LibraryRow;
  lang: Lang;
  onClose: () => void;
  onRead: (from: Element | null) => void;
  onEdit: () => void;
  onStatus: (s: ReadStatus | null) => void;
}) {
  const t = STR[lang];
  const coverRef = useRef<HTMLDivElement>(null);
  const descRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const readable = isReadable(row);
  const pct = row.percent != null ? Math.round(row.percent) : 0;
  const bg = coverUrl(row);
  const lastRead = relativeTime(lang, row.last_read);
  const language = languageName(lang, row.language);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useLayoutEffect(() => {
    const el = descRef.current;
    setOverflows(!!el && el.scrollHeight > el.clientHeight + 4);
  }, [row.description]);

  return (
    <div className="detail" role="dialog" aria-modal="true" aria-label={row.title}>
      <div className="detail__wash" style={{ ["--tint" as string]: row.spine_color }}>
        {bg && <img src={bg} alt="" aria-hidden="true" />}
      </div>
      <button className="detail__close iconbtn" onClick={onClose} title={t.closeReader} aria-label={t.closeReader}>
        <Icon name="close" size={22} />
      </button>

      <div className="detail__inner">
        <div className="detail__cover" ref={coverRef} style={{ viewTransitionName: SHARED }}>
          <BookCover row={row} />
        </div>

        <div className="detail__info">
          <div className={`eyebrow eyebrow--${row.status}`}>{statusLabel(t, row.status)}</div>
          <h1 className="detail__title">{row.title}</h1>
          <div className="detail__author">{row.author || t.noAuthor}</div>

          {pct > 0 && (
            <div className="meter detail__meter">
              <div className="meter__bar">
                <div className="meter__fill" style={{ width: `${pct}%` }} />
              </div>
              <span className="meter__text">
                {pct}% {t.progressDone}
                {lastRead && ` · ${t.lastRead} ${lastRead}`}
              </span>
            </div>
          )}

          <div className="detail__actions">
            {readable ? (
              <button className="btn btn--primary btn--lg" onClick={() => onRead(coverRef.current)} autoFocus>
                <Icon name="play" size={18} />
                {pct > 0 ? t.continueBtn : t.startReading}
              </button>
            ) : (
              <span className="muted small">{t.notReadable}</span>
            )}
            <button className="btn btn--ghost btn--lg" onClick={onEdit}>
              <Icon name="edit" size={17} />
              {t.customize}
            </button>
            <label className="select select--ghost detail__status" title={t.status}>
              <Icon name="flag" size={16} />
              <select
                value={row.status_manual ? row.status : "auto"}
                onChange={(e) => onStatus(e.target.value === "auto" ? null : (e.target.value as ReadStatus))}
                aria-label={t.status}
              >
                <option value="auto">
                  {t.statusAuto} ({statusLabel(t, row.status_manual ? autoGuess(row) : row.status)})
                </option>
                {STATUS_ORDER.map((s) => (
                  <option key={s} value={s}>
                    {statusLabel(t, s)}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <dl className="facts">
            {language && (
              <div>
                <dt>{t.fieldLanguage}</dt>
                <dd>{language}</dd>
              </div>
            )}
            <div>
              <dt>{t.fieldType}</dt>
              <dd>{row.cde_type === "EBOK" ? t.purchased : t.docs}</dd>
            </div>
            {row.publisher && (
              <div>
                <dt>NXB</dt>
                <dd>{row.publisher}</dd>
              </div>
            )}
          </dl>

          {row.subjects.length > 0 && (
            <div className="tags" aria-label={t.fieldSubjects}>
              {row.subjects.map((s) => (
                <span key={s} className="tag">
                  <Icon name="tag" size={13} />
                  {s}
                </span>
              ))}
            </div>
          )}

          {row.description && (
            <section className="detail__about">
              <h3>{t.about}</h3>
              <div ref={descRef} className={`detail__desc${expanded ? " is-open" : ""}`}>
                {row.description.split(/\n{2,}/).map((p, i) => (
                  <p key={i}>{p}</p>
                ))}
              </div>
              {(overflows || expanded) && (
                <button className="linkbtn" onClick={() => setExpanded((v) => !v)}>
                  {expanded ? t.showLess : t.showMore}
                </button>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

/** What the automatic status would be (mirrors the Rust rule). */
function autoGuess(row: LibraryRow): ReadStatus {
  const p = row.percent ?? 0;
  return p >= 97.5 ? "finished" : p > 0.5 ? "reading" : "unread";
}
