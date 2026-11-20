import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
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

  async function run() {
    if (running.current) return;
    running.current = true;
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
      setState({ progress: null, results: all });
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
  return { state, add, pick, dismiss };
}

/** Progress while adding, then a short summary with the details on demand. */
export function ImportToast({
  lang,
  state,
  onDismiss,
  onOpen,
}: {
  lang: Lang;
  state: ImportState;
  onDismiss: () => void;
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
