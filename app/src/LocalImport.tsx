import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { STR, type Lang } from "./i18n";
import { Icon, type IconName } from "./icons";

/** One file's outcome (mirrors `local::ImportResult`). */
export interface ImportResult {
  path: string;
  name: string;
  status: "added" | "duplicate" | "not_epub" | "drm" | "corrupt" | "error";
  id: string | null;
  title: string | null;
  similar: string | null;
  large: boolean;
  error: string | null;
}

export interface ImportState {
  progress: { done: number; total: number } | null;
  results: ImportResult[] | null;
  /** The user stopped the import part way. */
  cancelled?: boolean;
}

/** 12 345 678 → "11,8 MB". */
export function fmtBytes(n: number, lang: Lang): string {
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${new Intl.NumberFormat(lang, { maximumFractionDigits: u >= 2 ? 1 : 0 }).format(v)} ${units[u]}`;
}

/**
 * Adding books from this computer: files or folders, from the picker or a
 * drop. Runs one import at a time; a drop during an import is queued.
 */
export function useLocalImport(onAdded: () => void) {
  const [state, setState] = useState<ImportState>({ progress: null, results: null });
  const queue = useRef<string[][]>([]);
  const running = useRef(false);
  const onAddedRef = useRef(onAdded);
  onAddedRef.current = onAdded;

  useEffect(() => {
    const un = listen<{ done: number; total: number }>("import-progress", (e) =>
      setState((s) => ({ ...s, progress: e.payload })),
    );
    return () => {
      un.then((f) => f());
    };
  }, []);

  const cancelled = useRef(false);
  async function run() {
    if (running.current) return;
    running.current = true;
    cancelled.current = false;
    const all: ImportResult[] = [];
    try {
      while (queue.current.length) {
        const paths = queue.current.shift()!;
        setState({ progress: { done: 0, total: 0 }, results: null });
        try {
          all.push(...(await invoke<ImportResult[]>("import_books", { paths })));
        } catch (e) {
          all.push(...paths.map((p) => ({
            path: p,
            name: p.split(/[\\/]/).pop() ?? p,
            status: "error" as const,
            id: null,
            title: null,
            similar: null,
            large: false,
            error: String(e),
          })));
        }
        if (all.some((r) => r.status === "added")) onAddedRef.current();
      }
    } finally {
      running.current = false;
      setState({ progress: null, results: all, cancelled: cancelled.current });
    }
  }

  const add = (paths: string[]) => {
    if (!paths.length) return;
    queue.current.push(paths);
    void run();
  };
  /** The file picker; `title` is the dialog's caption. */
  const pick = async (title: string) => {
    const r = await openDialog({ multiple: true, filters: [{ name: "EPUB", extensions: ["epub"] }], title });
    if (r) add(Array.isArray(r) ? r : [r]);
  };
  const dismiss = () => setState({ progress: null, results: null });
  /** Stop after the current file (and drop what is still queued). */
  const cancel = () => {
    cancelled.current = true;
    queue.current = [];
    invoke("cancel_import").catch(() => undefined);
  };
  /** Pick up new EPUBs in the watched folders; reports only when something happened. */
  const scan = async () => {
    if (running.current) return;
    running.current = true;
    try {
      const r = await invoke<ImportResult[]>("scan_watch_folders");
      if (r.length) {
        setState({ progress: null, results: r });
        if (r.some((x) => x.status === "added")) onAddedRef.current();
      }
    } catch {
      /* next scan */
    } finally {
      running.current = false;
    }
  };
  return { state, add, pick, dismiss, cancel, scan };
}

/** Progress while adding, then a short summary with the details on demand. */
export function ImportToast({
  lang,
  state,
  onDismiss,
  onOpen,
  onCancel,
}: {
  lang: Lang;
  state: ImportState;
  onDismiss: () => void;
  onCancel: () => void;
  /** Jump to a book (an added one, or the one a file duplicates). */
  onOpen: (id: string) => void;
}) {
  const t = STR[lang];
  const [open, setOpen] = useState(false);
  const { progress, results } = state;

  // A clean import fades away by itself; one with problems stays.
  const clean = !!results && results.every((r) => r.status === "added" && !r.similar && !r.large);
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  useEffect(() => {
    if (!clean) return;
    const id = window.setTimeout(() => dismissRef.current(), 6000);
    return () => window.clearTimeout(id);
  }, [clean, results]);
  useEffect(() => setOpen(false), [results]);

  if (progress) {
    return (
      <div className="imptoast" role="status">
        <div className="imptoast__head">
          <Icon name="refresh" size={18} className="icon--spin" />
          <span>
            {progress.total > 0
              ? t.impBusy.replace("{0}", String(progress.done)).replace("{1}", String(progress.total))
              : t.impBusy.replace(" {0}/{1}", "…")}
          </span>
          <button className="linkbtn imptoast__stop" onClick={onCancel}>
            {t.impCancel}
          </button>
        </div>
      </div>
    );
  }
  if (!results || results.length === 0) return null;

  const added = results.filter((r) => r.status === "added").length;
  const dup = results.filter((r) => r.status === "duplicate").length;
  const bad = results.filter((r) => r.status !== "added" && r.status !== "duplicate").length;
  const similar = results.filter((r) => r.status === "added" && r.similar).length;
  const parts = [
    added ? t.impAdded.replace("{0}", String(added)) : t.impNone,
    dup ? t.impDuplicate.replace("{0}", String(dup)) : null,
    bad ? t.impProblem.replace("{0}", String(bad)) : null,
    similar ? t.impSimilar.replace("{0}", String(similar)) : null,
    state.cancelled ? t.impCancelled : null,
  ].filter(Boolean);

  return (
    <div className={`imptoast${bad ? " imptoast--warn" : ""}`} role="status">
      <div className="imptoast__head">
        <Icon name={added ? "check" : "info"} size={18} />
        <span className="imptoast__sum">{parts.join(" · ")}</span>
        <button className="linkbtn" onClick={() => setOpen((v) => !v)}>
          {open ? t.impHide : t.impDetails}
        </button>
        <button className="iconbtn imptoast__x" onClick={onDismiss} aria-label={t.closeReader} title={t.closeReader}>
          <Icon name="close" size={16} />
        </button>
      </div>
      {open && (
        <ul className="imptoast__list">
          {results.map((r, i) => {
            const notes = [
              r.status === "added" && r.similar ? t.impSimilarTo.replace("{0}", r.similar) : null,
              r.large ? t.impLarge : null,
              r.error,
            ].filter(Boolean);
            const goto = r.id && (r.status === "added" || r.status === "duplicate") ? r.id : null;
            return (
              <li key={`${r.path}-${i}`} className={`imptoast__item imptoast__item--${r.status}`}>
                <div className="imptoast__name" title={r.path}>
                  {goto ? (
                    <button className="linkbtn" onClick={() => onOpen(goto)}>
                      {r.title || r.name}
                    </button>
                  ) : (
                    r.name
                  )}
                </div>
                <div className="imptoast__st small">
                  {t[`impSt_${r.status}` as const]}
                  {notes.length > 0 && ` · ${notes.join(" · ")}`}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Full-window hint while files are dragged over the app. */
export function AddDropOverlay({ lang }: { lang: Lang }) {
  const t = STR[lang];
  return (
    <div className="stkdrop" aria-hidden="true">
      <div className="stkdrop__box">
        <Icon name="plus" size={34} />
        <span>{t.dropAdd}</span>
      </div>
    </div>
  );
}

/** The library with no books yet (guest, or nothing added). */
export function EmptyLibrary({ lang, onAdd }: { lang: Lang; onAdd: () => void }) {
  const t = STR[lang];
  return (
    <div className="hero hero--empty">
      <Icon name="library" size={56} />
      <h2>{t.emptyGuest}</h2>
      <p className="muted">{t.emptyGuestHint}</p>
      <button className="btn btn--primary btn--lg" onClick={onAdd}>
        <Icon name="plus" size={18} />
        {t.addBooks}
      </button>
    </div>
  );
}

/**
 * "Books on this computer": the space they take, the folders that add books
 * by themselves, and moving the local library to another computer.
 */
export function LocalLibraryDialog({
  lang,
  onClose,
  onChanged,
  onScan,
}: {
  lang: Lang;
  onClose: () => void;
  /** The library changed (a restore added books). */
  onChanged: () => void;
  /** Check the watched folders now. */
  onScan: () => void;
}) {
  const t = STR[lang];
  const [usage, setUsage] = useState<{ count: number; bytes: number } | null>(null);
  const [folders, setFolders] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);

  const load = () => {
    invoke<{ count: number; bytes: number }>("local_usage").then(setUsage, () => undefined);
    invoke<string[]>("watch_folders").then(setFolders, () => undefined);
  };
  useEffect(load, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  async function saveFolders(next: string[]) {
    try {
      setFolders(await invoke<string[]>("set_watch_folders", { folders: next }));
      setMsg(null);
      onScan();
    } catch (e) {
      setMsg({ text: String(e), error: true });
    }
  }
  async function addFolder() {
    const r = await openDialog({ directory: true, multiple: false, title: t.watchAdd });
    if (typeof r === "string") await saveFolders([...folders, r]);
  }
  async function doExport() {
    const name = await invoke<string>("export_file_name").catch(() => "pntome.zip");
    const dest = await saveDialog({ defaultPath: name, filters: [{ name: "ZIP", extensions: ["zip"] }] });
    if (!dest) return;
    setBusy(true);
    setMsg({ text: t.backupBusy });
    try {
      const r = await invoke<{ books: number; bytes: number }>("export_local_library", { dest });
      setMsg({ text: t.backupExported.replace("{0}", String(r.books)).replace("{1}", fmtBytes(r.bytes, lang)) });
    } catch (e) {
      setMsg({ text: String(e), error: true });
    } finally {
      setBusy(false);
    }
  }
  async function doImport() {
    const src = await openDialog({ multiple: false, filters: [{ name: "ZIP", extensions: ["zip"] }], title: t.backupImport });
    if (typeof src !== "string") return;
    setBusy(true);
    setMsg({ text: t.backupBusy });
    try {
      const r = await invoke<{ added: number; existing: number; failed: number; rows: number }>("import_local_library", { src });
      const parts = [t.backupRestored.replace("{0}", String(r.added)).replace("{1}", String(r.existing)).replace("{2}", String(r.rows))];
      if (r.failed) parts.push(t.backupFailed.replace("{0}", String(r.failed)));
      setMsg({ text: parts.join(" · "), error: r.failed > 0 });
      onChanged();
      load();
    } catch (e) {
      setMsg({ text: String(e) === "not_backup" ? t.backupNotFile : String(e), error: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal" onMouseDown={() => !busy && onClose()}>
      <div
        className="kpush locallib"
        role="dialog"
        aria-modal="true"
        aria-labelledby="locallib-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="locallib__head">
          <div className="kpush__icon" aria-hidden="true">
            <Icon name="library" size={22} />
          </div>
          <div>
            <h2 id="locallib-title" className="kpush__title">
              {t.localLib}
            </h2>
            <div className="small muted">
              {usage && usage.count > 0
                ? t.localLibSub.replace("{0}", String(usage.count)).replace("{1}", fmtBytes(usage.bytes, lang))
                : t.localLibEmpty}
            </div>
          </div>
          <button className="iconbtn locallib__x" onClick={onClose} disabled={busy} aria-label={t.closeReader} title={t.closeReader}>
            <Icon name="close" size={18} />
          </button>
        </div>

        <section className="locallib__sec">
          <h3>{t.watchTitle}</h3>
          <p className="small muted">{t.watchHint}</p>
          {folders.length ? (
            <ul className="locallib__folders">
              {folders.map((f) => (
                <li key={f}>
                  <span title={f}>{f}</span>
                  <button
                    className="iconbtn"
                    onClick={() => saveFolders(folders.filter((x) => x !== f))}
                    aria-label={`${t.watchRemove}: ${f}`}
                    title={t.watchRemove}
                  >
                    <Icon name="trash" size={15} />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="small muted locallib__none">{t.watchNone}</p>
          )}
          <div className="locallib__row">
            <button className="btn" onClick={addFolder} disabled={busy}>
              <Icon name="plus" size={16} />
              {t.watchAdd}
            </button>
            {folders.length > 0 && (
              <button className="btn btn--ghost" onClick={onScan} disabled={busy}>
                <Icon name="refresh" size={16} />
                {t.watchScan}
              </button>
            )}
          </div>
        </section>

        <section className="locallib__sec">
          <h3>{t.backupTitle}</h3>
          <p className="small muted">{t.backupHint}</p>
          <div className="locallib__row">
            <button className="btn" onClick={doExport} disabled={busy || !usage?.count}>
              <Icon name="upload" size={16} />
              {t.backupExport}
            </button>
            <button className="btn" onClick={doImport} disabled={busy}>
              <Icon name="arrowDown" size={16} />
              {t.backupImport}
            </button>
          </div>
        </section>

        {msg && <p className={`small locallib__msg${msg.error ? " locallib__msg--error" : ""}`}>{msg.text}</p>}
      </div>
    </div>
  );
}

/** Ask before something that cannot be undone from here. */
export function ConfirmDialog({
  lang,
  icon,
  title,
  text,
  confirm,
  onClose,
  onConfirm,
}: {
  lang: Lang;
  icon: IconName;
  title: string;
  text: string;
  confirm: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const t = STR[lang];
  return (
    <div className="modal" onMouseDown={onClose}>
      <div
        className="kpush"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="kpush__icon" aria-hidden="true">
          <Icon name={icon} size={22} />
        </div>
        <h2 id="confirm-title" className="kpush__title">
          {title}
        </h2>
        <p className="kpush__text">{text}</p>
        <div className="kpush__actions">
          <button className="btn" onClick={onClose} autoFocus>
            {t.cancel}
          </button>
          <button className="btn btn--primary" onClick={onConfirm}>
            {confirm}
          </button>
        </div>
      </div>
    </div>
  );
}

/** "Sign out of Amazon?" — keep or clear the Kindle books on this computer. */
export function LogoutDialog({
  lang,
  onClose,
  onConfirm,
}: {
  lang: Lang;
  onClose: () => void;
  onConfirm: (clearKindle: boolean) => void;
}) {
  const t = STR[lang];
  const [clear, setClear] = useState(false);
  return (
    <div className="modal" onMouseDown={onClose}>
      <div
        className="kpush"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="logout-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="kpush__icon" aria-hidden="true">
          <Icon name="logout" size={22} />
        </div>
        <h2 id="logout-title" className="kpush__title">
          {t.logoutTitle}
        </h2>
        <p className="kpush__text">{t.logoutBody}</p>
        <div className="choice" role="radiogroup">
          {[false, true].map((c) => (
            <label key={String(c)} className={`choice__opt${clear === c ? " is-on" : ""}`}>
              <input type="radio" name="logout-clear" checked={clear === c} onChange={() => setClear(c)} />
              <span>
                <span className="choice__name">{c ? t.logoutClear : t.logoutKeep}</span>
                <span className="choice__sub small muted">{c ? t.logoutClearSub : t.logoutKeepSub}</span>
              </span>
            </label>
          ))}
        </div>
        <div className="kpush__actions">
          <button className="btn" onClick={onClose} autoFocus>
            {t.cancel}
          </button>
          <button className="btn btn--primary" onClick={() => onConfirm(clear)}>
            {t.signOut}
          </button>
        </div>
      </div>
    </div>
  );
}
