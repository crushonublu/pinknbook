import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { MobileReaderSheet } from "../mobile/MobileReaderSheet";
import { STR, type Lang } from "../i18n";
import { Icon } from "../icons";
import { RefCover } from "./BookCover";
import { fmt, fmtDuration, longDate, minutesOf, unitOf } from "./format";
import { ManualAdd, ManualEntries } from "./ManualReading";
import { streakDayNumber } from "./streak";
import type { LibraryRow } from "../types";
import type { BookRef, DayMarks, PeriodDay, StatsSummary } from "./types";

interface DayProps {
  lang: Lang;
  s: StatsSummary;
  day: string;
  /** The reading of the day (absent when the period has no row for it). */
  data: PeriodDay | undefined;
  books: Record<string, BookRef>;
  /** The library, for adding paper reading to the day. */
  rows: LibraryRow[];
  /** Reading was added or taken back: the numbers need loading again. */
  onChanged: () => void;
}

/**
 * One day of reading: its place in the streak, the total with the split
 * between pntome, Kindle estimate and paper books, the books read, the paper
 * reading added by hand (with a form to add more), and what was marked and
 * saved that day. The body of the phone sheet and of the
 * desktop popover; the caller supplies the dark tokens (`scx-dark`).
 */
export function DayContent({ lang, s, day, data, books, rows, onChanged, className = "" }: DayProps & { className?: string }) {
  const t = STR[lang];
  const [marks, setMarks] = useState<DayMarks | null>(null);
  useEffect(() => {
    let stale = false;
    setMarks(null);
    invoke<DayMarks>("stats_day", { day })
      .then((m) => !stale && setMarks(m))
      .catch(console.error);
    return () => {
      stale = true;
    };
  }, [day]);

  const app = data?.app_sec ?? 0;
  const kindle = data?.kindle_sec ?? 0;
  const manual = data?.manual_sec ?? 0;
  const total = app + kindle + manual;
  const n = streakDayNumber(s, day);
  const parts = [
    { key: "app", sec: app, label: t.sxInApp },
    { key: "kindle", sec: kindle, label: t.sxKindleEst },
    { key: "manual", sec: manual, label: t.sxManual },
  ].filter((p) => p.sec > 0);
  const hasMarks = !!marks && marks.highlights + marks.words + marks.notes > 0;

  return (
    <div className={`scx-day${className ? ` ${className}` : ""}`}>
      {n !== null && <span className="scx-day__streak"><Icon name="flame" size={14} />{fmt(t.sxDayOfStreak, n)}</span>}

      {total > 0 ? (
        <div className="scx-day__total">
          <div className="scx-day__head">
            <span className="scx-day__min"><span className="scx__acc">{minutesOf(total)}</span> {unitOf(t.minutesN)}</span>
            {data?.met && <span className="scx-day__met"><Icon name="check" size={12} />{fmt(t.sxGoalMet, s.goal_minutes)}</span>}
          </div>
          <div className="scx-day__split" role="img" aria-label={fmt(t.sxSplitAria, Math.round(app / 60), Math.round(kindle / 60), Math.round(manual / 60))}>
            {parts.map((p) => <i key={p.key} className={`is-${p.key}`} style={{ flexGrow: p.sec }} />)}
          </div>
          <div className="scx-day__legend">
            {parts.map((p) => <span key={p.key}><i className={`is-${p.key}`} />{p.label} · {Math.round(p.sec / 60)}′</span>)}
          </div>
        </div>
      ) : (
        !hasMarks && <p className="scx__sub">{t.sxNoReadingDay}</p>
      )}

      {data && data.books.length > 0 && (
        <div className="scx-day__books">
          <h3>{t.sxDayBooks}</h3>
          {data.books.map((b) => (
            <div key={b.asin} className="scx-day__book">
              <span className="scx-cover scx-cover--day" aria-hidden="true"><RefCover asin={b.asin} book={books[b.asin]} /></span>
              <span className="scx-day__title">{books[b.asin]?.title ?? b.asin}</span>
              <span className="scx-day__time">{fmtDuration(lang, b.seconds)}</span>
            </div>
          ))}
        </div>
      )}

      <ManualEntries lang={lang} day={day} version={manual} onChanged={onChanged} />
      <ManualAdd lang={lang} rows={rows} today={s.today} day={day} onChanged={onChanged} />

      {hasMarks && marks && (
        <div className="scx-day__marks">
          <div><b>{marks.highlights}</b><span>{t.sxMarks}</span></div>
          <div><b>{marks.words}</b><span>{t.sxWordsSaved}</span></div>
          <div><b>{marks.notes}</b><span>{t.sxNotes}</span></div>
        </div>
      )}
    </div>
  );
}

/** A day in the phone's bottom sheet. */
export function DaySheet({ onClose, ...props }: DayProps & { onClose: () => void }) {
  const t = STR[props.lang];
  return (
    <MobileReaderSheet title={longDate(props.lang, props.day)} closeLabel={t.xrClose} onClose={onClose}>
      <DayContent {...props} className="scx-dark" />
    </MobileReaderSheet>
  );
}
