import { useCallback, useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { STR, type Lang } from "./i18n";
import type { LibraryRow } from "./types";
import { Icon } from "./icons";
import {
  grCandidates,
  grChoose,
  grDetails,
  grInfo,
  grReset,
  type GrBook,
  type GrReview,
  type GrState,
  type GrTranslation,
  grTranslate,
} from "./goodreads";

type T = (typeof STR)[Lang];

const open = (url: string) => openUrl(url).catch(() => undefined);

/**
 * Goodreads state for one book: the cached match first, then the book page
 * (genres, full description, reviews) when it is missing or stale. Shared by
 * the book page (its "About" text) and the Goodreads section.
 */
export function useGoodreads(asin: string) {
  const [st, setSt] = useState<GrState | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [detailsBusy, setDetailsBusy] = useState(false);
  const token = useRef(0);

  const loadDetails = useCallback(
    async (s: GrState, retry: boolean, my: number) => {
      if (s.status !== "found" || (!retry && s.details_status !== "pending")) return;
      setDetailsBusy(true);
      try {
        const next = await grDetails(asin, retry);
        if (token.current === my) setSt(next);
      } catch {
        /* keep what we have */
      } finally {
        if (token.current === my) setDetailsBusy(false);
      }
    },
    [asin],
  );

  const load = useCallback(
    async (refresh: boolean) => {
      const my = ++token.current;
      setPhase("loading");
      setDetailsBusy(false);
      try {
        const s = await grInfo(asin, refresh);
        if (token.current !== my) return;
        setSt(s);
        setPhase("ready");
        void loadDetails(s, false, my);
      } catch {
        if (token.current === my) setPhase("error");
      }
    },
    [asin, loadDetails],
  );

  useEffect(() => {
    setSt(null);
    void load(false);
  }, [load]);

  const apply = useCallback(
    (s: GrState) => {
      const my = ++token.current;
      setSt(s);
      setPhase("ready");
      void loadDetails(s, false, my);
    },
    [loadDetails],
  );

  const retryDetails = useCallback(() => {
    if (st) void loadDetails(st, true, token.current);
  }, [st, loadDetails]);

  return { st, phase, detailsBusy, load, apply, retryDetails };
}

export type GoodreadsData = ReturnType<typeof useGoodreads>;

/**
 * Goodreads section of a book's page: rating, series, pages, genres, rating
 * breakdown and a few top reviews. Matches are cached on the Rust side; the
 * reviews come from the book page, which Goodreads sometimes withholds (bot
 * challenge), in which case we link to Goodreads instead. The description is
 * shown in the page's "About" section (BookDetail).
 */
export default function GoodreadsCard({ row, lang, gr }: { row: LibraryRow; lang: Lang; gr: GoodreadsData }) {
  const t = STR[lang];
  const { st, phase, detailsBusy } = gr;
  const [picking, setPicking] = useState(false);

  useEffect(() => setPicking(false), [row.asin]);

  const book = st?.book ?? null;
  const details = st?.details ?? null;

  return (
    <section className="detail__about gr" aria-label="Goodreads">
      <div className="gr__head">
        <h3>{t.grTitle}</h3>
        {book && !picking && (
          <button className="linkbtn" onClick={() => open(book.url)}>
            <Icon name="external" size={14} />
            {t.grOpen}
          </button>
        )}
      </div>

      {picking ? (
        <Picker
          t={t}
          lang={lang}
          row={row}
          manual={!!st?.manual}
          onPick={async (b) => {
            gr.apply(await grChoose(row.asin, b));
            setPicking(false);
          }}
          onAuto={async () => {
            await grReset(row.asin);
            setPicking(false);
            void gr.load(false);
          }}
          onCancel={() => setPicking(false)}
        />
      ) : phase === "loading" ? (
        <p className="gr__status muted">
          <Icon name="refresh" size={15} className="icon--spin" />
          {t.grLoading}
        </p>
      ) : phase === "error" || !st ? (
        <p className="gr__status muted">
          {t.grError}
          <button className="linkbtn" onClick={() => gr.load(false)}>
            {t.grRetry}
          </button>
        </p>
      ) : !book ? (
        <div className="gr__status muted">
          <span>{st.manual ? t.grNotFoundManual : t.grNotFound}</span>
          <button className="linkbtn" onClick={() => setPicking(true)}>
            <Icon name="search" size={14} />
            {t.grSearchManually}
          </button>
        </div>
      ) : (
        <>
          <Summary t={t} lang={lang} book={book} state={st} />
          <div className="gr__match small muted">
            <span>
              {t.grMatched} “{book.title}”{book.author && ` · ${book.author}`}
            </span>
            <button className="linkbtn" onClick={() => setPicking(true)}>
              {t.grWrongMatch}
            </button>
          </div>

          {details && details.genres.length > 0 && (
            <div className="tags" aria-label={t.grGenres}>
              {details.genres.slice(0, 10).map((g) => (
                <span key={g} className="tag">
                  {g}
                </span>
              ))}
            </div>
          )}

          {details && details.rating_dist.length === 5 && <Distribution t={t} lang={lang} dist={details.rating_dist} />}

          <Reviews
            t={t}
            lang={lang}
            state={st}
            busy={detailsBusy}
            onRetry={gr.retryDetails}
            onOpen={() => open(`${book.url}#CommunityReviews`)}
          />
          <p className="gr__source small muted">{t.grSource}</p>
        </>
      )}
    </section>
  );
}

function Summary({ t, lang, book, state }: { t: T; lang: Lang; book: GrBook; state: GrState }) {
  const d = state.details;
  const rating = d?.rating ?? book.rating;
  const count = d?.ratings_count ?? book.ratings_count;
  const nf = new Intl.NumberFormat(lang);
  const year = d?.published != null ? new Date(d.published).getUTCFullYear() : null;
  return (
    <div className="gr__summary">
      {rating != null && (
        <div className="gr__score">
          <Stars value={rating} label={t.grRatingOf.replace("{0}", rating.toFixed(2))} size="lg" />
          <span className="gr__num">{rating.toFixed(2)}</span>
          <span className="gr__counts muted">
            {[
              count > 0 && t.grRatings.replace("{0}", nf.format(count)),
              d?.reviews_count && t.grReviewsCount.replace("{0}", nf.format(d.reviews_count)),
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </div>
      )}
      <dl className="facts gr__facts">
        {book.series && (
          <div>
            <dt>{t.grSeries}</dt>
            <dd>
              {book.series}
              {book.series_pos && ` #${book.series_pos}`}
            </dd>
          </div>
        )}
        {book.pages != null && (
          <div>
            <dt>{t.grPages}</dt>
            <dd>{nf.format(book.pages)}</dd>
          </div>
        )}
        {year != null && (
          <div>
            <dt>{t.grFirstPublished}</dt>
            <dd>{year}</dd>
          </div>
        )}
      </dl>
    </div>
  );
}

function Stars({ value, label, size }: { value: number; label: string; size?: "lg" }) {
  const pct = Math.max(0, Math.min(100, (value / 5) * 100));
  return (
    <span className={`stars${size ? ` stars--${size}` : ""}`} role="img" aria-label={label}>
      <span className="stars__on" style={{ width: `${pct}%` }} aria-hidden="true">
        ★★★★★
      </span>
      <span aria-hidden="true">★★★★★</span>
    </span>
  );
}

function Distribution({ t, lang, dist }: { t: T; lang: Lang; dist: number[] }) {
  const total = dist.reduce((a, b) => a + b, 0);
  if (!total) return null;
  const nf = new Intl.NumberFormat(lang);
  return (
    <div className="gr__dist" aria-label={t.grDistribution}>
      {[5, 4, 3, 2, 1].map((s) => {
        const n = dist[s - 1] ?? 0;
        const pct = (n / total) * 100;
        return (
          <div key={s} className="gr__distrow" title={nf.format(n)}>
            <span className="gr__distlabel">{t.grStars.replace("{0}", String(s))}</span>
            <span className="gr__distbar">
              <span style={{ width: `${pct}%` }} />
            </span>
            <span className="gr__distpct">{Math.round(pct)}%</span>
          </div>
        );
      })}
    </div>
  );
}

function Reviews({
  t,
  lang,
  state,
  busy,
  onRetry,
  onOpen,
}: {
  t: T;
  lang: Lang;
  state: GrState;
  busy: boolean;
  onRetry: () => void;
  onOpen: () => void;
}) {
  const reviews = state.details?.reviews ?? [];
  const link = (
    <button className="linkbtn" onClick={onOpen}>
      <Icon name="external" size={14} />
      {t.grReadReviews}
    </button>
  );
  return (
    <div className="gr__reviews">
      <h4>{t.grReviews}</h4>
      {reviews.length > 0 ? (
        <>
          <ul className="gr__reviewlist">
            {reviews.map((r, i) => (
              <ReviewItem key={i} t={t} lang={lang} r={r} />
            ))}
          </ul>
          {link}
        </>
      ) : busy || state.details_status === "pending" ? (
        <p className="gr__status muted">
          <Icon name="refresh" size={15} className="icon--spin" />
          {t.grReviewsLoading}
        </p>
      ) : (
        <div className="gr__status muted">
          <span>{state.details_status === "blocked" ? t.grReviewsBlocked : t.grReviewsNone}</span>
          {state.details_status === "blocked" && (
            <button className="linkbtn" onClick={onRetry}>
              {t.grRetry}
            </button>
          )}
          {link}
        </div>
      )}
    </div>
  );
}

function ReviewItem({ t, lang, r }: { t: T; lang: Lang; r: GrReview }) {
  const [expanded, setExpanded] = useState(false);
  const [tr, setTr] = useState<GrTranslation | null>(null);
  const [showTr, setShowTr] = useState(false);
  const [trState, setTrState] = useState<"idle" | "busy" | "error" | "limited">("idle");
  const date =
    r.created != null
      ? new Date(r.created).toLocaleDateString(lang, { year: "numeric", month: "short" })
      : null;
  const initial = r.name.trim().charAt(0).toUpperCase() || "?";
  const sameLang = !!tr?.source_lang && tr.source_lang.toLowerCase().startsWith(lang);
  const shown = showTr && tr && !sameLang ? tr.text : r.text;

  const translate = async () => {
    if (tr) {
      setShowTr((v) => !v);
      return;
    }
    setTrState("busy");
    try {
      setTr(await grTranslate(r.text, lang));
      setShowTr(true);
      setExpanded(true);
      setTrState("idle");
    } catch (e) {
      setTrState(String(e) === "rate_limited" ? "limited" : "error");
    }
  };

  return (
    <li className="gr__review">
      <div className="gr__reviewhead">
        {r.avatar ? (
          <img className="gr__avatar" src={r.avatar} alt="" loading="lazy" referrerPolicy="no-referrer" />
        ) : (
          <span className="gr__avatar gr__avatar--blank" aria-hidden="true">
            {initial}
          </span>
        )}
        <div className="gr__who">
          {r.profile_url ? (
            <button className="gr__name" onClick={() => open(r.profile_url!)}>
              {r.name}
            </button>
          ) : (
            <span className="gr__name">{r.name}</span>
          )}
          <span className="small muted">
            {r.rating != null && (
              <Stars value={r.rating} label={t.grRatingOf.replace("{0}", String(r.rating))} />
            )}
            {date && <span>{date}</span>}
            {r.likes > 0 && <span>{t.grLikes.replace("{0}", new Intl.NumberFormat(lang).format(r.likes))}</span>}
          </span>
        </div>
        <button
          className="linkbtn gr__translate"
          onClick={translate}
          disabled={trState === "busy" || sameLang}
          aria-pressed={showTr && !sameLang}
        >
          <Icon name="translate" size={14} className={trState === "busy" ? "icon--spin" : undefined} />
          {trState === "busy"
            ? t.grTranslating
            : sameLang
              ? t.grAlreadyInLang
              : showTr
                ? t.grShowOriginal
                : t.grTranslate}
        </button>
      </div>
      <button
        className={`gr__reviewtext${expanded ? " is-open" : ""}`}
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        lang={shown === r.text ? (tr?.source_lang ?? undefined) : lang}
      >
        {shown.split(/\n{2,}/).map((p, i) => (
          <p key={i}>{p}</p>
        ))}
      </button>
      {(trState === "error" || trState === "limited") && (
        <p className="gr__trnote small muted">{trState === "limited" ? t.grTranslateLimited : t.grTranslateFailed}</p>
      )}
      {showTr && tr && !sameLang && <p className="gr__trnote small muted">{t.grTranslatedBy}</p>}
    </li>
  );
}

function Picker({
  t,
  lang,
  row,
  manual,
  onPick,
  onAuto,
  onCancel,
}: {
  t: T;
  lang: Lang;
  row: LibraryRow;
  manual: boolean;
  onPick: (b: GrBook | null) => Promise<void>;
  onAuto: () => Promise<void>;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState("");
  const [list, setList] = useState<GrBook[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const nf = new Intl.NumberFormat(lang);

  const search = useCallback(
    async (q?: string) => {
      setBusy(true);
      setError(false);
      try {
        setList(await grCandidates(row.asin, q));
      } catch {
        setError(true);
        setList([]);
      } finally {
        setBusy(false);
      }
    },
    [row.asin],
  );

  useEffect(() => {
    void search();
  }, [search]);

  return (
    <div className="gr__picker">
      <p className="small muted">{t.grPickTitle}</p>
      <form
        className="gr__pickform"
        onSubmit={(e) => {
          e.preventDefault();
          void search(query);
        }}
      >
        <label className="search">
          <Icon name="search" size={16} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t.grPickPlaceholder}
            aria-label={t.grPickPlaceholder}
            autoFocus
          />
        </label>
        <button className="btn" type="submit" disabled={busy}>
          {t.grPickSearch}
        </button>
      </form>

      {busy ? (
        <p className="gr__status muted">
          <Icon name="refresh" size={15} className="icon--spin" />
          {t.grPickSearching}
        </p>
      ) : error ? (
        <p className="gr__status muted">{t.grError}</p>
      ) : list && list.length === 0 ? (
        <p className="gr__status muted">{t.grPickEmpty}</p>
      ) : (
        <ul className="gr__candidates">
          {list?.map((b) => (
            <li key={b.book_id}>
              <button className="gr__candidate" onClick={() => onPick(b)}>
                {b.image_url ? (
                  <img src={b.image_url} alt="" loading="lazy" referrerPolicy="no-referrer" />
                ) : (
                  <span className="gr__thumb" aria-hidden="true">
                    <Icon name="book" size={18} />
                  </span>
                )}
                <span className="gr__candinfo">
                  <span className="gr__candtitle">
                    {b.title}
                    {b.series && (
                      <span className="muted">
                        {" "}
                        ({b.series}
                        {b.series_pos && ` #${b.series_pos}`})
                      </span>
                    )}
                  </span>
                  <span className="small muted">
                    {b.author}
                    {b.rating != null && ` · ★ ${b.rating.toFixed(2)}`}
                    {b.ratings_count > 0 && ` · ${t.grRatings.replace("{0}", nf.format(b.ratings_count))}`}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="gr__pickactions">
        <button className="btn btn--ghost" onClick={() => onPick(null)}>
          {t.grPickNone}
        </button>
        {manual && (
          <button className="btn btn--ghost" onClick={() => onAuto()}>
            <Icon name="refresh" size={15} />
            {t.grPickAuto}
          </button>
        )}
        <span className="editor__spacer" />
        <button className="btn btn--ghost" onClick={onCancel}>
          {t.cancel}
        </button>
      </div>
    </div>
  );
}
