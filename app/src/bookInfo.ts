import { STR, type Lang } from "./i18n";
import type { LibraryRow, ReadStatus } from "./types";

type T = (typeof STR)[Lang];

export function statusLabel(t: T, s: ReadStatus): string {
  return {
    unread: t.statusUnread,
    reading: t.statusReading,
    finished: t.statusFinished,
    abandoned: t.statusAbandoned,
  }[s];
}

/** A book added from this computer (not from the Kindle library). */
export const isLocal = (row: Pick<LibraryRow, "source">) => row.source === "local";

/** PDOCs and local EPUBs open in the in-app reader; DRM'd store books (EBOK) do not. */
export const isReadable = (row: LibraryRow) =>
  isLocal(row) ? !row.file_missing : row.cde_type !== "EBOK";

/** The library's kind filter: Kindle purchases, Kindle documents, or this computer. */
export function bookKind(row: LibraryRow): "EBOK" | "PDOC" | "LOCAL" {
  return isLocal(row) ? "LOCAL" : row.cde_type === "EBOK" ? "EBOK" : "PDOC";
}

/** "vi" / "vie" / "en" → "Tiếng Việt" / "Vietnamese"… in the UI language. */
export function languageName(lang: Lang, code: string | null): string | null {
  if (!code) return null;
  const c = code.toLowerCase().split(/[-_]/)[0];
  const norm = c === "vie" ? "vi" : c === "eng" ? "en" : c;
  try {
    const name = new Intl.DisplayNames([lang], { type: "language" }).of(norm);
    return name ? name.charAt(0).toUpperCase() + name.slice(1) : code;
  } catch {
    return code;
  }
}

/** SQLite UTC datetime → "3 ngày trước" / "3 days ago". */
export function relativeTime(lang: Lang, sqlite: string | null): string | null {
  if (!sqlite) return null;
  const then = Date.parse(sqlite.replace(" ", "T") + "Z");
  if (Number.isNaN(then)) return null;
  const s = (then - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: "auto" });
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [
    ["second", 60],
    ["minute", 60],
    ["hour", 24],
    ["day", 7],
    ["week", 4.35],
    ["month", 12],
    ["year", Infinity],
  ];
  let v = s;
  for (const [unit, size] of steps) {
    if (Math.abs(v) < size) return rtf.format(Math.round(v), unit);
    v /= size;
  }
  return null;
}

/** The book to offer under "Continue reading": most recently read, else furthest along. */
export function continueBook(rows: LibraryRow[]): LibraryRow | null {
  const reading = rows.filter((r) => r.status === "reading" && isReadable(r));
  if (!reading.length) return null;
  return [...reading].sort(
    (a, b) =>
      (b.last_read ?? "").localeCompare(a.last_read ?? "") || (b.percent ?? 0) - (a.percent ?? 0),
  )[0];
}
