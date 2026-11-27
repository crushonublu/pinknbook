import { STR, type Lang } from "../i18n";
import { fmt } from "./format";
import type { PeriodStats } from "./types";

/** Genres named in the donut; the rest are lumped as "other". */
const SHOWN = 5;
/** A gap, in percent of the circle, between segments. */
const GAP = 0.8;

/**
 * The genres of the books read as a donut: the five biggest and "other",
 * coloured to differ in lightness (`--st-g1`..`--st-g6`), with the number of
 * genres in the middle. Books whose genre is not known are only counted in a
 * note.
 */
export function GenreDonut({ lang, p, genreName }: { lang: Lang; p: PeriodStats; genreName: (id: string) => string | undefined }) {
  const t = STR[lang];
  const known = p.genres.reduce((n, g) => n + g.books, 0);
  if (!p.genres.length) {
    return (
      <section className="scx scx-genre">
        <span className="scx__label">{t.sxGenreTop}</span>
        <p className="scx__sub">{t.sxNoGenre}</p>
        {p.genre_unknown_books > 0 && <p className="scx__sub">{fmt(t.sxGenreUnknown, p.genre_unknown_books)}</p>}
      </section>
    );
  }

  const nameOf = (id: string) => genreName(id) ?? id;
  const slices = p.genres.slice(0, SHOWN).map((g, i) => ({ name: nameOf(g.id), books: g.books, color: `var(--st-g${i + 1})` }));
  const rest = p.genres.slice(SHOWN).reduce((n, g) => n + g.books, 0);
  if (rest > 0) slices.push({ name: t.sxOther, books: rest, color: "var(--st-g6)" });

  // Conic stops with a card-coloured gap before each segment (none when there is only one).
  let at = 0;
  const stops = slices.flatMap((s) => {
    const from = at;
    at += (s.books / known) * 100;
    return slices.length === 1
      ? [`${s.color} 0 100%`]
      : [`var(--surface) ${from}% ${from + GAP}%`, `${s.color} ${from + GAP}% ${at - GAP}%`, `var(--surface) ${at - GAP}% ${at}%`];
  });
  const top = p.genres[0];

  return (
    <section className="scx scx-genre">
      <div className="scx__stack">
        <span className="scx__label">{t.sxGenreTop}</span>
        <span className="scx__hero scx__hero--title scx__acc">{nameOf(top.id)}</span>
        <span className="scx__sub">{fmt(t.sxGenreSub, top.books, known + p.genre_unknown_books)}</span>
      </div>
      <div className="scx-genre__body">
        <div
          className="scx-donut"
          style={{ background: `conic-gradient(${stops.join(", ")})` }}
          role="img"
          aria-label={fmt(t.sxGenreAria, slices.map((s) => `${s.name} ${s.books}`).join(", "))}
        >
          <div><b>{p.genres.length}</b><small>{t.sxGenreCenter}</small></div>
        </div>
        <ul className="scx-genre__legend">
          {slices.map((s) => (
            <li key={s.name}>
              <i style={{ background: s.color }} />
              <div>
                <b>{s.name}</b>
                <small>{fmt(t.sxBooksPct, s.books, Math.round((s.books / known) * 100))}</small>
              </div>
            </li>
          ))}
        </ul>
      </div>
      {p.genre_unknown_books > 0 && <p className="scx__sub">{fmt(t.sxGenreUnknown, p.genre_unknown_books)}</p>}
    </section>
  );
}
