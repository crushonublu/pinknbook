import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { MobilePicker } from "../mobile/MobilePicker";
import { STR, type Lang } from "../i18n";
import { Icon } from "../icons";
import { isAndroid } from "../platform";
import type { LibraryRow } from "../types";
import { addDays, fmt, shortDate } from "./format";
import type { ManualEntry } from "./types";

/** How many days before today reading can still be added by hand, and the minutes a stepper moves, and its range. */
const DAYS_BACK = 7;
const STEP = 5;
const MIN_MINUTES = 5;
const MAX_MINUTES = 600;
const DEFAULT_MINUTES = 30;

/** Can paper reading still be added for `day` (today or one of the 7 days before)? */
export function canAddManual(today: string, day: string) {
  return day <= today && day >= addDays(today, -DAYS_BACK);
}

/** The backend's complaints (src-tauri/src/stats.rs `log_manual`) in the reader's words. */
function manualError(t: (typeof STR)[Lang], e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  if (raw.startsWith("at most")) return t.prErrCap;
  if (raw.startsWith("reading can only be added")) return t.prErrDay;
  if (raw.startsWith("minutes must be")) return t.prErrMinutes;
  if (raw.startsWith("the title needs")) return t.prErrTitleChars;
  if (raw.startsWith("a book or a title")) return t.prErrBook;
  return t.prErrUnknown;
}

/** A choice from a list: the phone's option sheet, a plain select on the desktop. */
function Choice({ label, value, options, onChange }: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  if (isAndroid) return <MobilePicker label={label} value={value} options={options} onChange={onChange} />;
  return (
    <select className="pr-select" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

/**
 * "Thêm thời gian đọc sách giấy": the day (today and the 7 before), the book (one
 * of the library, or a paper book by its title) and the minutes (5 to 600, in
 * steps of 5). Mistakes are told before anything is sent; what the backend
 * refuses afterwards (more than 10 hours in a day) is told in the same place.
 */
export function ManualForm({ lang, rows, today, day, onDay, onSaved }: {
  lang: Lang;
  /** The library, for the book list. */
  rows: LibraryRow[];
  today: string;
  /** The day it opens on (when it may be added to; else today). */
  day: string;
  /** The day chosen changed. */
  onDay?: (day: string) => void;
  /** Reading was added. */
  onSaved: (day: string, minutes: number) => void;
}) {
  const t = STR[lang];
  const id = useId();
  const [chosen, setChosen] = useState(canAddManual(today, day) ? day : today);
  const [paper, setPaper] = useState(rows.length === 0);
  const [asin, setAsin] = useState("");
  const [title, setTitle] = useState("");
  const [minutes, setMinutes] = useState(DEFAULT_MINUTES);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const days = useMemo(
    () => Array.from({ length: DAYS_BACK + 1 }, (_, i) => addDays(today, -i)).map((d, i) => ({
      value: d,
      label: i === 0 ? t.prToday : i === 1 ? t.prYesterday : shortDate(lang, d),
    })),
    [today, lang, t],
  );
  const books = useMemo(() => {
    const sorted = [...rows].sort((a, b) => a.title.localeCompare(b.title, lang));
    return [{ value: "", label: t.prPickBook }, ...sorted.map((r) => ({ value: r.asin, label: r.title }))];
  }, [rows, lang, t]);

  const clamp = (n: number) => Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, n));
  /** The stepper starts from the default when the field is empty or not a number. */
  const whole = (m: number) => (Number.isFinite(m) ? m : DEFAULT_MINUTES);
  const pickDay = (d: string) => {
    setChosen(d);
    setError(null);
    onDay?.(d);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!Number.isInteger(minutes) || minutes < MIN_MINUTES || minutes > MAX_MINUTES) return setError(t.prErrMinutes);
    if (!canAddManual(today, chosen)) return setError(t.prErrDay);
    if (!paper && !asin) return setError(t.prErrBook);
    if (paper && !title.trim()) return setError(t.prErrTitle);
    setBusy(true);
    setError(null);
    try {
      await invoke("log_manual_reading", { day: chosen, asin: paper ? null : asin, title: paper ? title.trim() : null, minutes });
      setTitle("");
      onSaved(chosen, minutes);
    } catch (err) {
      console.error(err);
      setError(manualError(t, err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="pr-form" onSubmit={submit} noValidate>
      <div className="pr-field">
        <span className="pr-label">{t.prDay}</span>
        <Choice label={t.prDay} value={chosen} options={days} onChange={pickDay} />
      </div>

      <div className="pr-field">
        <span className="pr-label">{t.prBook}</span>
        <div className="pr-seg" role="group" aria-label={t.prBook}>
          <button type="button" aria-pressed={!paper} disabled={rows.length === 0} onClick={() => { setPaper(false); setError(null); }}>{t.prLibraryBook}</button>
          <button type="button" aria-pressed={paper} onClick={() => { setPaper(true); setError(null); }}>{t.prPaperBook}</button>
        </div>
        {paper ? (
          <input
            className="pr-input"
            type="text"
            maxLength={200}
            value={title}
            placeholder={t.prTitlePlaceholder}
            aria-label={t.prTitleLabel}
            aria-invalid={!!error && !title.trim()}
            onChange={(e) => { setTitle(e.target.value); setError(null); }}
          />
        ) : (
          <Choice label={t.prPickBook} value={asin} options={books} onChange={(v) => { setAsin(v); setError(null); }} />
        )}
      </div>

      <div className="pr-field">
        <label className="pr-label" htmlFor={`${id}-min`}>{t.prMinutes}</label>
        <div className="pr-step">
          <button type="button" aria-label={fmt(t.prLess, STEP)} disabled={minutes <= MIN_MINUTES} onClick={() => setMinutes((m) => clamp(Math.ceil(whole(m) / STEP) * STEP - STEP))}>−</button>
          <input
            id={`${id}-min`}
            type="number"
            inputMode="numeric"
            min={MIN_MINUTES}
            max={MAX_MINUTES}
            step={STEP}
            value={Number.isNaN(minutes) ? "" : minutes}
            aria-invalid={minutes < MIN_MINUTES || minutes > MAX_MINUTES || Number.isNaN(minutes)}
            onChange={(e) => { setMinutes(e.target.value === "" ? NaN : Number(e.target.value)); setError(null); }}
          />
          <button type="button" aria-label={fmt(t.prMore, STEP)} disabled={minutes >= MAX_MINUTES} onClick={() => setMinutes((m) => clamp(Math.floor(whole(m) / STEP) * STEP + STEP))}>+</button>
        </div>
      </div>

      <p className="pr-hint">{t.prHint}</p>
      {error && <p className="pr-error" role="alert">{error}</p>}
      <button className="pr-submit" type="submit" disabled={busy}>{busy ? t.prSaving : t.prSave}</button>
    </form>
  );
}

/** What was added by hand on a day, each entry with a button to take it back. Nothing is drawn when there is none. */
export function ManualEntries({ lang, day, version, onChanged }: {
  lang: Lang;
  day: string;
  /** Changes when entries may have been added (load again). */
  version: unknown;
  onChanged: () => void;
}) {
  const t = STR[lang];
  const [entries, setEntries] = useState<ManualEntry[]>([]);
  const [failed, setFailed] = useState(false);
  const [bump, setBump] = useState(0);

  useEffect(() => {
    let stale = false;
    invoke<ManualEntry[]>("manual_readings", { day })
      .then((list) => !stale && setEntries(list))
      .catch((e) => {
        console.error(e);
        if (!stale) setEntries([]);
      });
    return () => {
      stale = true;
    };
  }, [day, version, bump]);

  const remove = useCallback(
    async (e: ManualEntry) => {
      setFailed(false);
      try {
        await invoke("delete_manual_reading", { day, asin: e.asin });
        setBump((n) => n + 1);
        onChanged();
      } catch (err) {
        console.error(err);
        setFailed(true);
      }
    },
    [day, onChanged],
  );

  if (!entries.length) return null;
  return (
    <div className="pr-entries">
      <h3>{t.prEntries}</h3>
      {entries.map((e) => (
        <div key={e.asin} className="pr-entry">
          <span className="pr-entry__title">{e.title}</span>
          <span className="pr-entry__time">{fmt(t.prMinutesShort, Math.round(e.seconds / 60))}</span>
          <button className="pr-entry__del" onClick={() => remove(e)} aria-label={fmt(t.prDelete, e.title)}><Icon name="trash" size={16} /></button>
        </div>
      ))}
      {failed && <p className="pr-error" role="alert">{t.prDeleteFailed}</p>}
    </div>
  );
}

/** The button in a day's sheet that opens the form for that day. */
export function ManualAdd({ lang, rows, today, day, onChanged }: {
  lang: Lang;
  rows: LibraryRow[];
  today: string;
  day: string;
  onChanged: () => void;
}) {
  const t = STR[lang];
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState<number | null>(null);
  useEffect(() => {
    setOpen(false);
    setSaved(null);
  }, [day]);
  if (!canAddManual(today, day)) return null;
  if (!open) {
    return (
      <div className="pr-add">
        <button className="pr-add__btn" onClick={() => { setOpen(true); setSaved(null); }}>
          <Icon name="plus" size={16} />
          {t.prAdd}
        </button>
        {saved !== null && <p className="pr-ok" role="status">{fmt(t.prSaved, saved)}</p>}
      </div>
    );
  }
  return (
    <div className="pr-add">
      <h3>{t.prAdd}</h3>
      <ManualForm
        lang={lang}
        rows={rows}
        today={today}
        day={day}
        onSaved={(_, m) => {
          setOpen(false);
          setSaved(m);
          onChanged();
        }}
      />
      <button className="pr-add__cancel" onClick={() => setOpen(false)}>{t.prCancel}</button>
    </div>
  );
}

/** The form with the day's entries under it, for the stats settings. */
export function ManualPanel({ lang, rows, today, onChanged }: { lang: Lang; rows: LibraryRow[]; today: string; onChanged: () => void }) {
  const t = STR[lang];
  const [day, setDay] = useState(today);
  const [version, setVersion] = useState(0);
  const [saved, setSaved] = useState<number | null>(null);
  return (
    <div className="pr-panel">
      <ManualForm
        lang={lang}
        rows={rows}
        today={today}
        day={day}
        onDay={(d) => { setDay(d); setSaved(null); }}
        onSaved={(d, m) => {
          setDay(d);
          setSaved(m);
          setVersion((n) => n + 1);
          onChanged();
        }}
      />
      {saved !== null && <p className="pr-ok" role="status">{fmt(t.prSaved, saved)}</p>}
      <ManualEntries lang={lang} day={day} version={version} onChanged={() => { setSaved(null); onChanged(); }} />
    </div>
  );
}
