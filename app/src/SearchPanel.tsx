import { useEffect, useMemo, useRef, useState } from "react";
import { STR, type Lang } from "./i18n";
import { Icon } from "./icons";
import { MAX_HITS, type SearchHit } from "./bookSearch";

export interface SearchState {
  query: string;
  hits: SearchHit[];
  running: boolean;
  progress: number;
  /** Index into `hits` of the chosen result, or -1. */
  current: number;
}

export const EMPTY_SEARCH: SearchState = { query: "", hits: [], running: false, progress: 0, current: -1 };

/**
 * The Find tab: a box, a count with previous/next, and the results grouped by
 * chapter with the words around each match.
 */
export function SearchPanel({
  lang,
  state,
  chapterOf,
  formatPos,
  onSearch,
  onPick,
}: {
  lang: Lang;
  state: SearchState;
  chapterOf: (index: number) => string;
  formatPos: (fraction: number) => string;
  onSearch: (q: string) => void;
  onPick: (i: number) => void;
}) {
  const t = STR[lang];
  const [text, setText] = useState(state.query);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const debounce = useRef<number | null>(null);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  // Search a moment after typing stops (Enter searches at once).
  const change = (v: string) => {
    setText(v);
    if (debounce.current != null) window.clearTimeout(debounce.current);
    debounce.current = window.setTimeout(() => onSearch(v), 350);
  };
  useEffect(() => () => {
    if (debounce.current != null) window.clearTimeout(debounce.current);
  }, []);

  // Keep the chosen result in view.
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(".bsearch__hit.is-current")?.scrollIntoView({ block: "nearest" });
  }, [state.current]);

  const step = (d: number) => {
    const n = state.hits.length;
    if (!n) return;
    onPick(state.current < 0 ? (d > 0 ? 0 : n - 1) : (state.current + d + n) % n);
  };

  const groups = useMemo(() => {
    const out: { label: string; items: { hit: SearchHit; i: number }[] }[] = [];
    state.hits.forEach((hit, i) => {
      const label = chapterOf(hit.index);
      const last = out[out.length - 1];
      if (last && last.label === label) last.items.push({ hit, i });
      else out.push({ label, items: [{ hit, i }] });
    });
    return out;
  }, [state.hits, chapterOf]);

  const n = state.hits.length;
  const status = state.running
    ? t.bsSearching.replace("{0}", String(Math.round(state.progress * 100)))
    : state.query.trim()
      ? n
        ? t.bsCount.replace("{0}", n.toLocaleString())
        : t.bsNone.replace("{0}", state.query.trim())
      : t.bsHint;

  return (
    <div className="bsearch">
      <div className="bsearch__bar">
        <label className="bsearch__field">
          <Icon name="search" size={16} />
          <input
            ref={input}
            type="search"
            value={text}
            placeholder={t.bsPlaceholder}
            aria-label={t.bsPlaceholder}
            spellCheck={false}
            onChange={(e) => change(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (debounce.current != null) window.clearTimeout(debounce.current);
                if (text !== state.query) onSearch(text);
                else step(e.shiftKey ? -1 : 1);
              }
            }}
          />
          {text && (
            <button
              className="bsearch__clear"
              onClick={() => {
                setText("");
                onSearch("");
                input.current?.focus();
              }}
              aria-label={t.bsClear}
              title={t.bsClear}
            >
              <Icon name="close" size={14} />
            </button>
          )}
        </label>
        <div className="bsearch__status">
          <span className={state.running ? "bsearch__busy" : undefined} aria-live="polite">
            {n > 0 && state.current >= 0 && !state.running ? `${state.current + 1} / ${n.toLocaleString()}` : status}
          </span>
          {n > 0 && (
            <span className="bsearch__nav">
              <button onClick={() => step(-1)} aria-label={t.bsPrev} title={t.bsPrev}>
                <Icon name="arrowUp" size={15} />
              </button>
              <button onClick={() => step(1)} aria-label={t.bsNext} title={t.bsNext}>
                <Icon name="arrowDown" size={15} />
              </button>
            </span>
          )}
        </div>
        {state.running && (
          <div className="bsearch__progress">
            <i style={{ width: `${state.progress * 100}%` }} />
          </div>
        )}
      </div>
      <div className="bsearch__list" ref={list}>
        {groups.map((g, gi) => (
          <section key={gi} className="bsearch__group">
            {g.label && <h4>{g.label}</h4>}
            {g.items.map(({ hit, i }) => (
              <button
                key={i}
                className={`bsearch__hit${i === state.current ? " is-current" : ""}`}
                onClick={() => onPick(i)}
              >
                <span className="bsearch__text">
                  {hit.pre}
                  <mark>{hit.match}</mark>
                  {hit.post}
                </span>
                <span className="rside__meta">{formatPos(hit.fraction)}</span>
              </button>
            ))}
          </section>
        ))}
        {!state.running && n >= MAX_HITS && <p className="rside__empty">{t.bsCapped.replace("{0}", String(MAX_HITS))}</p>}
      </div>
    </div>
  );
}
