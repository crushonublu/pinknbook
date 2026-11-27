import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { MobilePicker } from "../mobile/MobilePicker";
import { STR, type Lang } from "../i18n";
import { isAndroid } from "../platform";
import { useGenres } from "./useGenres";
import type { BookGenre } from "./types";

/**
 * A book's genre on its page: the one worked out from Goodreads / Amazon (or
 * "unknown"), and a choice to set another from the fixed groups or to go back
 * to the automatic one. `refreshKey` changes when new Goodreads details may
 * have changed the automatic genre; `onChanged` tells the app to reload the
 * stats, whose genre charts follow the choice.
 */
export function BookGenreField({ asin, lang, refreshKey, onChanged }: {
  asin: string;
  lang: Lang;
  refreshKey?: unknown;
  onChanged?: () => void;
}) {
  const t = STR[lang];
  const genres = useGenres(lang);
  const [book, setBook] = useState<BookGenre | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(() => {
    let stale = false;
    invoke<BookGenre>("book_genre", { asin })
      .then((g) => !stale && setBook(g))
      .catch((e) => {
        console.error(e);
        if (!stale) setFailed(true);
      });
    return () => {
      stale = true;
    };
  }, [asin]);
  useEffect(() => {
    setBook(null);
    setFailed(false);
    return load();
  }, [load, refreshKey]);

  if (!book || genres.list.length === 0) return failed ? <p className="scx-genre__err small muted">{t.gnLoadFailed}</p> : null;

  const name = book.genre ? genres.name(book.genre) : undefined;
  const auto = book.user ? t.gnAuto : `${t.gnAuto} (${name ?? t.gnUnknown})`;
  const options = [
    { value: "auto", label: auto },
    ...genres.list.map((g) => ({ value: g.id, label: g[lang] })),
  ];
  const value = book.user && book.genre ? book.genre : "auto";

  const change = async (v: string) => {
    setFailed(false);
    try {
      await invoke("set_book_genre", { asin, genre: v === "auto" ? null : v });
      load();
      onChanged?.();
    } catch (e) {
      console.error(e);
      setFailed(true);
    }
  };

  return (
    <div className="scx-genre">
      <span className="scx-genre__label">{t.gnLabel}</span>
      {isAndroid ? (
        <MobilePicker label={t.gnLabel} value={value} options={options} onChange={change} />
      ) : (
        <select className="stx-select scx-genre__select" aria-label={t.gnLabel} value={value} onChange={(e) => change(e.target.value)}>
          {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      )}
      {failed && <span className="scx-genre__err small" role="alert">{t.gnSaveFailed}</span>}
    </div>
  );
}
