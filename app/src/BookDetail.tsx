import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isAndroid } from "./platform";
import { STR, type Lang } from "./i18n";
import { STATUS_ORDER, type LibraryRow, type ReadStatus } from "./types";
import { BookCover, coverUrl } from "./BookCover";
import { Icon } from "./icons";
import { isReadable, relativeTime, statusLabel } from "./bookInfo";
import { SHARED } from "./transitions";
import GoodreadsCard, { useGoodreads } from "./GoodreadsCard";

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
  onRemove,
  twin,
  signedIn = false,
  onLink,
  onUnlink,
  onDismissLink,
  onReadTwin,
  onSendToKindle,
}: {
  row: LibraryRow;
  lang: Lang;
  onClose: () => void;
  onRead: (from: Element | null) => void;
  onEdit: () => void;
  onStatus: (s: ReadStatus | null) => void;
  /** Local books only: take it off the library (asks first). */
  onRemove?: () => void;
  /** Local books: the linked (or suggested) Kindle edition. */
  twin?: LibraryRow | null;
  signedIn?: boolean;
  onLink?: () => void;
  onUnlink?: () => void;
  onDismissLink?: () => void;
  onReadTwin?: () => void;
  onSendToKindle?: () => void;
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
  const gr = useGoodreads(row.asin);
  // "About" comes from Goodreads only: the book file's own description is
  // often a download-site watermark. Full description from the book page,
  // else the short blurb from the search suggestion.
  const description = gr.st?.details?.description || gr.st?.book?.description || null;
  const descFromGr = !!description;
  const local = row.source === "local";
  const [origin, setOrigin] = useState<{ original_name: string | null; original_path: string | null } | null>(null);
  const [revealErr, setRevealErr] = useState<string | null>(null);
  useEffect(() => {
    if (!local) return;
    invoke<{ original_name: string | null; original_path: string | null } | null>("local_book_info", { asin: row.asin })
      .then(setOrigin)
      .catch(() => undefined);
  }, [local, row.asin]);

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
  }, [description]);

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
              <span className="muted small">{local ? t.fileMissing : t.notReadable}</span>
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

          {(row.publisher || (local && origin?.original_name)) && (
            <dl className="facts">
              {row.publisher && (
                <div>
                  <dt>NXB</dt>
                  <dd>{row.publisher}</dd>
                </div>
              )}
              {local && origin?.original_name && (
                <div>
                  <dt>{t.localFrom}</dt>
                  <dd title={origin.original_path ?? undefined}>{origin.original_name}</dd>
                </div>
              )}
            </dl>
          )}

          {local && (
            <div className="detail__local">
              <span className="tag tag--local">
                <Icon name="monitor" size={13} />
                {t.localBadge}
              </span>
              {!row.file_missing && !isAndroid && (
                <button
                  className="linkbtn"
                  onClick={() =>
                    invoke("reveal_local_book", { asin: row.asin }).catch((e) => setRevealErr(String(e)))
                  }
                >
                  {t.revealFile}
                </button>
              )}
              {onRemove && (
                <button className="linkbtn linkbtn--danger" onClick={onRemove}>
                  {t.removeBook}
                </button>
              )}
              {!row.file_missing && !isAndroid && (
                <button
                  className="linkbtn"
                  onClick={onSendToKindle}
                  disabled={!signedIn || !onSendToKindle}
                  title={signedIn ? undefined : t.sendNeedsLogin}
                >
                  {t.sendLocal}
                </button>
              )}
              {revealErr && <span className="small muted">{revealErr}</span>}
            </div>
          )}

          {local && twin && (
            <div className={`twin${row.linked_asin ? " twin--linked" : ""}`}>
              <div className="twin__cover">
                <BookCover row={twin} />
              </div>
              <div className="twin__body">
                <div className="twin__label small muted">{row.linked_asin ? t.kindleTwin : t.linkSuggest}</div>
                <div className="twin__title">{twin.title}</div>
                <div className="small muted">
                  {[twin.author, twin.cde_type === "EBOK" ? t.purchased : t.docs, twin.percent ? `${Math.round(twin.percent)}%` : null]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
                {row.linked_asin && <p className="small muted twin__note">{t.linkedNote}</p>}
                <div className="twin__actions">
                  {row.linked_asin ? (
                    <>
                      {isReadable(twin) && onReadTwin && (
                        <button className="btn btn--ghost" onClick={onReadTwin}>
                          <Icon name="play" size={15} />
                          {t.readKindle}
                        </button>
                      )}
                      <button className="linkbtn" onClick={onUnlink}>
                        {t.unlinkBtn}
                      </button>
                    </>
                  ) : (
                    <>
                      <button className="btn" onClick={onLink}>
                        {t.linkBtn}
                      </button>
                      <button className="linkbtn" onClick={onDismissLink}>
                        {t.linkNot}
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
          )}

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

          {description && (
            <section className="detail__about">
              <div className="detail__about-head">
                <h3>{t.about}</h3>
                {descFromGr && <span className="small muted">{t.grAboutSource}</span>}
              </div>
              <div ref={descRef} className={`detail__desc${expanded ? " is-open" : ""}`}>
                {description.split(/\n{2,}/).map((p, i) => (
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

          <GoodreadsCard row={row} lang={lang} gr={gr} />
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
