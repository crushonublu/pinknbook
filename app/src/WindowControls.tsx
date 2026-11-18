import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Icon } from "./icons";

/** The current Tauri window, or null outside Tauri (plain browser preview). */
function appWindow() {
  try {
    return getCurrentWindow();
  } catch {
    return null;
  }
}

/**
 * Minimise / maximise-restore / close for the frameless main window
 * (`decorations: false` in tauri.conf.json). Sits at the right end of a
 * title bar marked with `data-tauri-drag-region`.
 */
export function WindowControls({
  labels,
}: {
  labels: { minimize: string; maximize: string; restore: string; close: string };
}) {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const w = appWindow();
    if (!w) return;
    let unlisten: (() => void) | undefined;
    let alive = true;
    const sync = () => w.isMaximized().then((m) => alive && setMaximized(m)).catch(() => undefined);
    sync();
    w.onResized(sync)
      .then((f) => (alive ? (unlisten = f) : f()))
      .catch(() => undefined);
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  const w = appWindow();
  return (
    <div className="winctl">
      <button className="winctl__btn" onClick={() => w?.minimize()} title={labels.minimize} aria-label={labels.minimize}>
        <Icon name="winMin" size={18} />
      </button>
      <button
        className="winctl__btn"
        onClick={() => w?.toggleMaximize()}
        title={maximized ? labels.restore : labels.maximize}
        aria-label={maximized ? labels.restore : labels.maximize}
      >
        <Icon name={maximized ? "winRestore" : "winMax"} size={18} />
      </button>
      <button
        className="winctl__btn winctl__btn--close"
        onClick={() => w?.close()}
        title={labels.close}
        aria-label={labels.close}
      >
        <Icon name="winClose" size={18} />
      </button>
    </div>
  );
}
