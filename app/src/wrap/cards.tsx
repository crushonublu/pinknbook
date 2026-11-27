// The fixed content of the wrap-up cards: the week, the month and the six pages
// of the year. Everything is drawn in card coordinates (1080 wide, see
// geometry.ts): each part is a band placed by its top and height, and the
// stickers have their own zones around them. Sizes are in card pixels; the card
// is scaled as a whole to fit the screen.

import { Fragment, type ReactNode } from "react";
import { STR, type Lang } from "../i18n";
import { fmt, monthTitle, names } from "../stats/format";
import { RefCover } from "../stats/BookCover";
import { badgeImg } from "../stats/BadgesCard";
import { bestWindow } from "../stats/HoursCard";
import type { PeriodDay, PeriodStats, StatsSummary, WrapDoc } from "../stats/types";
import { boldParts, dayMonth, daySeconds, highlightFact, hoursOf, isoWeek, shortDuration, wallBooks, weekDays, weekRange } from "./data";
import { TITLE_W, geometryOf, type Block, type Format } from "./geometry";

export interface ContentProps {
  lang: Lang;
  doc: WrapDoc;
  format: Format;
  /** Page of a year wrap. */
  page: number;
  genreName: (id: string) => string | undefined;
  /** The badges of the stats summary (the year's last page shows the ones earned). */
  badges: StatsSummary["badges"];
}

const hh = (h: number) => `${String(h % 24).padStart(2, "0")}:00`;

/** A band of the card at its block. */
function Band({ at, className = "", children }: { at: Block; className?: string; children: ReactNode }) {
  return <div className={`wc__band ${className}`} style={{ top: at.y, height: at.h }}>{children}</div>;
}

/** Small caps label over a big italic title; the title shrinks to fit the title column. */
function Header({ at, kicker, title, max }: { at: Block; kicker: string; title: string; max: number }) {
  const size = Math.min(max, Math.floor(TITLE_W / (title.length * 0.52)));
  return (
    <Band at={at} className="wc-head">
      <span className="wc__kicker">{kicker}</span>
      <span className="wc__title" style={{ fontSize: size }}>{title}</span>
    </Band>
  );
}

function Footer({ at, left, right }: { at: Block; left: string; right: string }) {
  return (
    <Band at={at} className="wc-foot">
      <span>{left}</span>
      <span>{right}</span>
    </Band>
  );
}

/** A line with its bold values set apart. */
function Rich({ parts }: { parts: { text: string; bold: boolean }[] }) {
  return <>{parts.map((p, i) => (p.bold ? <b key={i}>{p.text}</b> : <Fragment key={i}>{p.text}</Fragment>))}</>;
}

/** "▲ 12% more than the period before", when there is a period before to compare with. */
function Trend({ lang, p }: { lang: Lang; p: PeriodStats }) {
  const t = STR[lang];
  if (p.prev_total_sec <= 0) return null;
  const pct = Math.round(((p.total_sec - p.prev_total_sec) * 100) / p.prev_total_sec);
  if (pct === 0) return null;
  return <span className="wc__trend">{pct > 0 ? "▲ " : "▼ "}{fmt(pct > 0 ? t.wrTrendUp : t.wrTrendDown, Math.abs(pct))}</span>;
}

function Tile({ value, label }: { value: string; label: string }) {
  return (
    <div className="wc-tile">
      <span className="wc-tile__n">{value}</span>
      <span className="wc-tile__l">{label}</span>
    </div>
  );
}

/** The four numbers every card has: days read, time, best streak, highlights (or books for a year). */
function tilesOf(lang: Lang, p: PeriodStats, kind: "month" | "year") {
  const t = STR[lang];
  return [
    kind === "year" ? { value: String(p.finished.length), label: t.wrBooksDone } : { value: String(p.days_read), label: t.wrDaysRead },
    kind === "year" ? { value: String(p.days_read), label: t.wrDaysRead } : { value: shortDuration(lang, p.total_sec), label: t.wrTotalTime },
    { value: String(p.streak_best_in_period), label: t.wrBestStreak },
    { value: String(p.highlights), label: t.wrHighlightsN },
  ];
}

// ---- Month ------------------------------------------------------------------------------------

function MonthContent({ lang, doc, format }: ContentProps) {
  const t = STR[lang];
  const p = doc.stats;
  const g = geometryOf("month", format).blocks;
  const story = format === "story";
  const { shown } = wallBooks(p, story ? 8 : 4);
  // Few books are drawn big; the post's one row always holds four.
  const cols = story && shown.length <= 3 ? 3 : 4;
  const month = doc.period_start.slice(0, 7);
  const [year, mm] = month.split("-");
  return (
    <>
      <Header at={g.head} kicker={fmt(t.wrKicker, year)} title={monthTitle(lang, month)} max={170} />
      <Band at={g.covers} className="wc-covers">
        <div className={`wc-covers__grid wc-covers__grid--${cols}`}>
          {shown.map((b) => (
            <div key={b.asin} className="wc-covers__item">
              <RefCover asin={b.asin} book={p.books[b.asin]} className="wc-cover" />
              <span>{b.finished ? fmt(t.wrFinishedOn, dayMonth(b.finished)) : fmt(t.wrReadFor, shortDuration(lang, b.seconds))}</span>
            </div>
          ))}
        </div>
      </Band>
      <Band at={g.tiles} className="wc-tiles">
        {tilesOf(lang, p, "month").map((x) => <Tile key={x.label} {...x} />)}
      </Band>
      <Band at={g.line} className="wc__line"><p><Rich parts={highlightFact(lang, p, ["days", "highlights", "finished"])} /></p></Band>
      <Footer at={g.foot} left="PNTOME" right={`${mm}/${year}`} />
    </>
  );
}

// ---- Week -------------------------------------------------------------------------------------

function WeekContent({ lang, doc, format }: ContentProps) {
  const t = STR[lang];
  const p = doc.stats;
  const g = geometryOf("week", format).blocks;
  const byDay = new Map(p.days.map((d) => [d.day, d]));
  const days: (PeriodDay | undefined)[] = weekDays(doc.period_start).map((k) => byDay.get(k));
  const most = Math.max(1, ...days.map((d) => (d ? daySeconds(d) : 0)));
  const dow = names(t.sxDow);
  const top = p.top_books[0];
  const year = doc.period_start.slice(0, 4);
  return (
    <>
      <Header at={g.head} kicker={fmt(t.wrKickerWeek, weekRange(lang, doc.period_start, doc.period_end))} title={fmt(t.wrWeekTitle, isoWeek(doc.period_start))} max={170} />
      <Band at={g.days} className="wc-days">
        {days.map((d, i) => {
          const sec = d ? daySeconds(d) : 0;
          // The dot grows with the minutes read, from a small one to a big one.
          const size = sec > 0 ? 64 + 64 * Math.sqrt(sec / most) : 40;
          return (
            <div key={i} className="wc-days__col">
              <span className="wc-days__dow">{dow[i]}</span>
              <span className="wc-days__well">
                <i className={`wc-dot${d?.met ? " is-met" : sec > 0 ? " is-read" : ""}`} style={{ width: size, height: size }} />
              </span>
              <span className="wc-days__min">{sec > 0 ? shortDuration(lang, sec) : "–"}</span>
            </div>
          );
        })}
      </Band>
      <Band at={g.hero} className="wc-hero">
        <span className="wc-hero__num">{shortDuration(lang, p.total_sec)}</span>
        <span className="wc-hero__label">{t.wrTotalTime}</span>
        <Trend lang={lang} p={p} />
      </Band>
      <Band at={g.book} className="wc-book">
        {top ? (
          <>
            <RefCover asin={top.asin} book={p.books[top.asin]} className="wc-cover wc-book__cover" />
            <div className="wc-book__text">
              <span className="wc-book__label">{t.wrMainBook}</span>
              <span className="wc-book__title">{top.title}</span>
              {top.author && <span className="wc-book__author">{top.author}</span>}
              <span className="wc-book__time">{fmt(t.wrReadFor, shortDuration(lang, top.seconds))}</span>
            </div>
          </>
        ) : (
          <span className="wc-book__label">{t.wrNoBook}</span>
        )}
      </Band>
      <Band at={g.line} className="wc__line"><p><Rich parts={highlightFact(lang, p, ["trend", "days"])} /></p></Band>
      <Footer at={g.foot} left="PNTOME" right={`${doc.period_start.slice(5, 7)}/${year}`} />
    </>
  );
}

// ---- Year -------------------------------------------------------------------------------------

/** Genres named in the donut; the rest are lumped as "other". */
const DONUT_SHOWN = 5;

function YearGenres({ lang, p, g, genreName }: { lang: Lang; p: PeriodStats; g: Record<string, Block>; genreName: ContentProps["genreName"] }) {
  const t = STR[lang];
  const known = p.genres.reduce((n, x) => n + x.books, 0);
  const nameOf = (id: string) => genreName(id) ?? id;
  const slices = p.genres.slice(0, DONUT_SHOWN).map((x, i) => ({ name: nameOf(x.id), books: x.books, color: `var(--wc-g${i + 1})` }));
  const rest = p.genres.slice(DONUT_SHOWN).reduce((n, x) => n + x.books, 0);
  if (rest > 0) slices.push({ name: t.sxOther, books: rest, color: "var(--wc-g6)" });
  // Ring drawn with dashed strokes: the circle is 100 long, so a share is its percent.
  let at = 0;
  const arcs = slices.map((s) => {
    const len = (s.books / known) * 100;
    const arc = { ...s, len, from: at };
    at += len;
    return arc;
  });
  return (
    <>
      <Band at={g.head2} className="wc-h2">
        <span className="wc-h2__label">{t.wrYearGenre}</span>
        <span className="wc-h2__big">{p.genres.length ? nameOf(p.genres[0].id) : t.wrYearGenreNone}</span>
      </Band>
      {slices.length > 0 && (
        <>
          <Band at={g.donut} className="wc-donut">
            <svg viewBox="0 0 120 120" role="img" aria-label={slices.map((s) => `${s.name} ${s.books}`).join(", ")}>
              {arcs.map((a) => (
                <circle
                  key={a.name}
                  cx="60" cy="60" r="40" fill="none" stroke={a.color} strokeWidth="20" pathLength="100"
                  strokeDasharray={`${Math.max(0, a.len - (arcs.length > 1 ? 0.8 : 0))} ${100 - a.len + (arcs.length > 1 ? 0.8 : 0)}`}
                  strokeDashoffset={-a.from}
                  transform="rotate(-90 60 60)"
                />
              ))}
            </svg>
          </Band>
          <Band at={g.legend} className="wc-legend">
            <ul>
              {slices.map((s) => (
                <li key={s.name}>
                  <i style={{ background: s.color }} />
                  <b>{s.name}</b>
                  <span>{fmt(t.sxBooksPct, s.books, Math.round((s.books / known) * 100))}</span>
                </li>
              ))}
            </ul>
          </Band>
        </>
      )}
    </>
  );
}

/** Twelve small months: a dot per day, filled when the goal was met, tinted for other reading. */
function YearMonths({ lang, p, year, g }: { lang: Lang; p: PeriodStats; year: number; g: Record<string, Block> }) {
  const t = STR[lang];
  const byDay = new Map(p.days.map((d) => [d.day, d]));
  const label = names(t.sxMonthNames);
  return (
    <>
      <Band at={g.head2} className="wc-h2">
        <span className="wc-h2__big">{p.streak_best_in_period}</span>
        <span className="wc-h2__label">{t.wrBestStreak}</span>
      </Band>
      <Band at={g.months} className="wc-months">
        {Array.from({ length: 12 }, (_, m) => {
          const lead = (new Date(year, m, 1).getDay() + 6) % 7;
          const count = new Date(year, m + 1, 0).getDate();
          return (
            <div key={m} className="wc-month">
              <span>{label[m]}</span>
              <div>
                {Array.from({ length: lead }, (_, i) => <b key={`l${i}`} />)}
                {Array.from({ length: count }, (_, i) => {
                  const d = byDay.get(`${year}-${String(m + 1).padStart(2, "0")}-${String(i + 1).padStart(2, "0")}`);
                  return <i key={i} className={d?.met ? "is-met" : d && daySeconds(d) > 0 ? "is-read" : undefined} />;
                })}
              </div>
            </div>
          );
        })}
      </Band>
    </>
  );
}

function YearContent({ lang, doc, format, page, genreName, badges }: ContentProps) {
  const t = STR[lang];
  const p = doc.stats;
  const g = geometryOf("year", format, page).blocks;
  const year = Number(doc.period_start.slice(0, 4));
  const pageNames = names(t.wrYearPages);
  let body: ReactNode;
  switch (page) {
    case 0:
      body = (
        <>
          <Band at={g.hero} className="wc-hero">
            <span className="wc-hero__num">{hoursOf(p.total_sec)}<small>{t.wrYearHours}</small></span>
            <span className="wc-hero__label">{t.wrYearHoursLabel}</span>
            <Trend lang={lang} p={p} />
          </Band>
          <Band at={g.tiles} className="wc-tiles">
            {tilesOf(lang, p, "year").map((x) => <Tile key={x.label} {...x} />)}
          </Band>
          <Band at={g.line} className="wc__line"><p><Rich parts={highlightFact(lang, p, ["trend", "days", "highlights", "finished"])} /></p></Band>
        </>
      );
      break;
    case 1: {
      const wall = wallBooks({ ...p, top_books: [] }, 24);
      body = (
        <>
          <Band at={g.head2} className="wc-h2">
            <span className="wc-h2__big">{fmt(t.wrYearBooks, p.finished.length)}</span>
            {wall.more > 0 && <span className="wc-h2__label">{fmt(t.wrYearMore, wall.more)}</span>}
          </Band>
          <Band at={g.wall} className="wc-wall">
            {wall.shown.map((b) => <RefCover key={b.asin} asin={b.asin} book={p.books[b.asin]} className="wc-cover" />)}
          </Band>
        </>
      );
      break;
    }
    case 2:
      body = <YearGenres lang={lang} p={p} g={g} genreName={genreName} />;
      break;
    case 3:
      body = <YearMonths lang={lang} p={p} year={year} g={g} />;
      break;
    case 4: {
      const total = p.hours.reduce((a, b) => a + b, 0);
      const win = bestWindow(p.hours);
      const most = Math.max(1, ...p.hours);
      body = (
        <>
          <Band at={g.head2} className="wc-h2">
            <span className="wc-h2__label">{t.wrYearHoursBest}</span>
            <span className="wc-h2__big">{total > 0 ? `${hh(win.start)} – ${hh(win.start + 3)}` : t.wrYearHoursNone}</span>
          </Band>
          {total > 0 && (
            <>
              <Band at={g.chart} className="wc-hours">
                <div className="wc-hours__bars" role="img" aria-label={t.sxHoursAria}>
                  {p.hours.map((v, h) => (
                    <i key={h} className={(h - win.start + 24) % 24 < 3 ? "is-lit" : undefined} style={{ height: `${Math.max(1, (v / most) * 100)}%` }} />
                  ))}
                </div>
                <div className="wc-hours__axis" aria-hidden="true"><span>0h</span><span>6h</span><span>12h</span><span>18h</span><span>23h</span></div>
              </Band>
              <Band at={g.line} className="wc__line"><p><Rich parts={boldParts(t.wrYearHoursShare, [String(Math.round((win.seconds / total) * 100))])} /></p></Band>
            </>
          )}
        </>
      );
      break;
    }
    default: {
      const earned = badges.filter((b) => b.tier > 0);
      body = (
        <>
          <Band at={g.head2} className="wc-h2">
            <span className="wc-h2__big">{earned.length ? fmt(t.wrYearBadges, earned.length) : t.wrYearNoBadges}</span>
          </Band>
          <Band at={g.badges} className="wc-badges">
            {earned.slice(0, 12).map((b) => (
              <div key={b.id}>
                <img src={badgeImg(b.id)} alt="" draggable={false} />
                <span>{t[`bd_${b.id}` as const]}</span>
              </div>
            ))}
          </Band>
        </>
      );
    }
  }
  return (
    <>
      <Header at={g.head} kicker={t.wrKickerYear} title={String(year)} max={format === "story" ? 190 : 160} />
      {body}
      <Footer at={g.foot} left="PNTOME" right={`${page + 1} / 6 · ${pageNames[page]}`} />
    </>
  );
}

/** The fixed content of a card: the template of the wrap's kind (the page for a year). */
export function WrapContent(props: ContentProps) {
  switch (props.doc.kind) {
    case "week":
      return <WeekContent {...props} />;
    case "month":
      return <MonthContent {...props} />;
    default:
      return <YearContent {...props} />;
  }
}
