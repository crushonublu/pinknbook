import { useCallback, useEffect, useRef, useState } from "react";
import { check, type DownloadEvent } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { STR, type Lang } from "./i18n";
import { Icon } from "./icons";

/**
 * Self-update from GitHub Releases (see docs/release.md).
 *
 * A quiet check runs a few seconds after launch; the account menu can run one
 * by hand. A newer version shows a small banner; "Update now" downloads with
 * progress, runs the installer (passive on Windows) and relaunches.
 */

/** What the banner needs from the plugin's `Update` (also met by the dev mock). */
type Available = {
  version: string;
  currentVersion: string;
  body?: string;
  downloadAndInstall: (onEvent?: (e: DownloadEvent) => void) => Promise<void>;
};

/** State of the manual check, shown in the account menu. */
export type CheckState = "idle" | "checking" | "latest" | "failed";

type Phase =
  | { kind: "none" }
  | { kind: "available" }
  | { kind: "downloading"; done: number; total?: number }
  | { kind: "installing" }
  | { kind: "failed" };

const AUTO_CHECK_DELAY_MS = 5000;

/**
 * Dev only: `?mockUpdate` in the URL fakes an available update, so the banner
 * can be looked at without a release (also works in a plain browser tab).
 */
function mockUpdate(): Available | null {
  if (!import.meta.env.DEV || !new URLSearchParams(location.search).has("mockUpdate")) return null;
  return {
    version: "9.9.9",
    currentVersion: "0.1.0",
    body: "## pntome 9.9.9\n- Kiểm tra và cài bản cập nhật ngay trong ứng dụng\n- Sửa lỗi kệ sách nhấp nháy khi rê chuột\n- Đồng bộ vị trí đọc nhanh hơn\n- Một dòng thứ tư bị ẩn",
    async downloadAndInstall(onEvent) {
      const total = 8_000_000;
      onEvent?.({ event: "Started", data: { contentLength: total } });
      for (let done = 0; done < total; done += 400_000) {
        await new Promise((r) => setTimeout(r, 120));
        onEvent?.({ event: "Progress", data: { chunkLength: 400_000 } });
      }
      onEvent?.({ event: "Finished" });
    },
  };
}

async function findUpdate(): Promise<Available | null> {
  return mockUpdate() ?? (await check());
}

export function useUpdater() {
  const [update, setUpdate] = useState<Available | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "none" });
  const [checkState, setCheckState] = useState<CheckState>("idle");
  const busy = useRef(false);
  /** Set once "Update now" is pressed; later checks must not reset the banner. */
  const installing = useRef(false);

  const runCheck = useCallback(async (manual: boolean) => {
    if (busy.current || installing.current) return;
    busy.current = true;
    if (manual) setCheckState("checking");
    try {
      const u = await findUpdate();
      if (u) {
        setUpdate(u);
        setPhase({ kind: "available" });
        setCheckState("idle");
      } else if (manual) {
        setCheckState("latest");
      }
    } catch (e) {
      // The quiet launch check never bothers anyone (offline, no release yet…).
      console.warn("update check failed", e);
      if (manual) setCheckState("failed");
    } finally {
      busy.current = false;
    }
  }, []);

  useEffect(() => {
    const h = window.setTimeout(() => runCheck(false), AUTO_CHECK_DELAY_MS);
    return () => window.clearTimeout(h);
  }, [runCheck]);

  // The menu's "up to date" / "failed" note fades back to the version line.
  useEffect(() => {
    if (checkState !== "latest" && checkState !== "failed") return;
    const h = window.setTimeout(() => setCheckState("idle"), 6000);
    return () => window.clearTimeout(h);
  }, [checkState]);

  const install = useCallback(async () => {
    if (!update || installing.current) return;
    installing.current = true;
    let done = 0;
    let total: number | undefined;
    setPhase({ kind: "downloading", done: 0 });
    try {
      await update.downloadAndInstall((e) => {
        if (e.event === "Started") total = e.data.contentLength;
        else if (e.event === "Progress") done += e.data.chunkLength;
        if (e.event === "Finished") setPhase({ kind: "installing" });
        else setPhase({ kind: "downloading", done, total });
      });
      setPhase({ kind: "installing" });
      // On Windows the installer closes the app itself; elsewhere restart now.
      if (!mockUpdate()) await relaunch();
    } catch (e) {
      console.warn("update install failed", e);
      installing.current = false;
      setPhase({ kind: "failed" });
    }
  }, [update]);

  const dismiss = useCallback(() => setPhase({ kind: "none" }), []);

  return {
    update: phase.kind === "none" ? null : update,
    phase,
    checkState,
    checkNow: () => runCheck(true),
    install,
    dismiss,
  };
}

/** First few readable lines of the release notes, markdown markers stripped. */
function changelog(body: string | undefined, max = 3): string[] {
  if (!body) return [];
  return body
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/, "").replace(/\*\*|__|`/g, "").trim())
    .filter((l) => l && !/^pntome\s+v?\d/i.test(l))
    .slice(0, max);
}

export function UpdateBanner({
  lang,
  updater,
}: {
  lang: Lang;
  updater: ReturnType<typeof useUpdater>;
}) {
  const t = STR[lang];
  const { update, phase, install, dismiss } = updater;
  if (!update || phase.kind === "none") return null;
  const notes = changelog(update.body);
  const working = phase.kind === "downloading" || phase.kind === "installing";
  const pct =
    phase.kind === "downloading" && phase.total ? Math.min(100, Math.round((phase.done / phase.total) * 100)) : null;

  return (
    <div className="upd" role="status" aria-live="polite">
      <div className="upd__head">
        <span className="upd__icon">
          <Icon name="sparkle" size={18} />
        </span>
        <span className="upd__text">
          <span className="upd__kicker">{t.updAvailable}</span>
          <span className="upd__title">
            {t.appName} {update.version}
            <span className="upd__from"> · {t.updCurrent.replace("{0}", update.currentVersion)}</span>
          </span>
        </span>
        {!working && (
          <button className="upd__x" onClick={dismiss} aria-label={t.updLater}>
            <Icon name="close" size={15} />
          </button>
        )}
      </div>

      {notes.length > 0 && phase.kind === "available" && (
        <ul className="upd__notes">
          {notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}

      {working ? (
        <div className="upd__progress">
          <div className="upd__bar">
            <div
              className={`upd__fill${pct === null ? " upd__fill--busy" : ""}`}
              style={pct === null ? undefined : { width: `${pct}%` }}
            />
          </div>
          <span className="upd__status muted">
            {phase.kind === "installing" ? t.updInstalling : `${t.updDownloading}${pct === null ? "" : ` ${pct}%`}`}
          </span>
        </div>
      ) : (
        <>
          {phase.kind === "failed" && <div className="upd__error">{t.updFailed}</div>}
          <div className="upd__actions">
            <button className="btn btn--ghost btn--sm" onClick={dismiss}>
              {t.updLater}
            </button>
            <button className="btn btn--primary btn--sm" onClick={install}>
              {phase.kind === "failed" ? t.updRetry : t.updNow}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
