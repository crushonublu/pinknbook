import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { STR, type Lang } from "./i18n";
import type { LibraryRow, ReadStatus } from "./types";
import { Icon } from "./icons";

/** A status change that Kindle could be told about. */
export type KindlePushRequest = { row: LibraryRow; status: ReadStatus };

/**
 * Whether changing `row` to `status` is worth offering to push to Kindle:
 * only "unread" and "finished" map onto a Kindle position (start / end),
 * and only when Kindle's progress disagrees with the new status.
 */
export function wantsKindlePush(row: LibraryRow | undefined, status: ReadStatus | null): boolean {
  if (!row || !status) return false;
  const p = row.percent;
  if (status === "unread") return p != null && p > 0.5;
  if (status === "finished") return p == null || p < 97.5;
  return false;
}

type Phase = { k: "ask" } | { k: "pushing" } | { k: "done"; percent: number | null } | { k: "error"; msg: string };

/**
 * Asks before overwriting the reading position on Kindle. Kindle keeps no
 * read/unread label, so "Unread" moves its position to the start of the book
 * and "Finished" to the end, on every Kindle app and device.
 */
export function KindlePushDialog({
  lang,
  req,
  onClose,
  onPushed,
}: {
  lang: Lang;
  req: KindlePushRequest;
  onClose: () => void;
  onPushed: () => void;
}) {
  const t = STR[lang];
  const [phase, setPhase] = useState<Phase>({ k: "ask" });
  const pct = (p: number | null | undefined) => (p == null ? "—" : `${Math.round(p)}%`);
  const finished = req.status === "finished";

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && phase.k !== "pushing") {
        e.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [phase.k, onClose]);

  async function push() {
    setPhase({ k: "pushing" });
    try {
      const percent = await invoke<number | null>("push_status_to_kindle", {
        asin: req.row.asin,
        cdeType: req.row.cde_type,
        status: req.status,
      });
      setPhase({ k: "done", percent });
      onPushed();
    } catch (e) {
      setPhase({ k: "error", msg: String(e) });
    }
  }

  return (
    <div className="modal" onMouseDown={() => phase.k !== "pushing" && onClose()}>
      <div
        className="kpush"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="kpush-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="kpush__icon" aria-hidden="true">
          <Icon name="sync" size={22} />
        </div>
        <h2 id="kpush-title" className="kpush__title">
          {t.kpushTitle}
        </h2>
        <p className="kpush__book">{req.row.title}</p>

        {(phase.k === "ask" || phase.k === "pushing") && (
          <>
            <p className="kpush__text">
              {(finished ? t.kpushFinished : t.kpushUnread).replace("{0}", pct(req.row.percent))}
            </p>
            <p className="kpush__note muted small">{t.kpushNote}</p>
            <div className="kpush__actions">
              <button className="btn" onClick={onClose} disabled={phase.k === "pushing"} autoFocus>
                {t.kpushLocalOnly}
              </button>
              <button className="btn btn--primary" onClick={push} disabled={phase.k === "pushing"}>
                {phase.k === "pushing" ? t.kpushPushing : finished ? t.kpushToEnd : t.kpushToStart}
              </button>
            </div>
          </>
        )}

        {phase.k === "done" && (
          <>
            <p className="kpush__text">{t.kpushDone.replace("{0}", pct(phase.percent))}</p>
            <div className="kpush__actions">
              <button className="btn btn--primary" onClick={onClose} autoFocus>
                OK
              </button>
            </div>
          </>
        )}

        {phase.k === "error" && (
          <>
            <p className="kpush__text">{t.kpushError}</p>
            <p className="kpush__note muted small">{phase.msg}</p>
            <div className="kpush__actions">
              <button className="btn" onClick={onClose}>
                {t.kpushLocalOnly}
              </button>
              <button className="btn btn--primary" onClick={push} autoFocus>
                {t.kpushRetry}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
