import { useEffect, useRef, type ReactNode } from "react";
import { Icon } from "../icons";

/** Shared Android sheet shell; book content stays mounted behind the scrim. */
export function MobileReaderSheet({ title, closeLabel, onClose, children }: {
  title: string; closeLabel: string; onClose: () => void; children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => { if (before?.isConnected) before.focus(); };
  }, []);
  return <div className="mr-sheet-layer">
    <div className="mr-sheet-scrim" onClick={onClose} />
    <section className="mr-sheet" ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title}
      onKeyDown={(e) => {
        if (e.key !== "Tab") return;
        const els = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select, textarea, [tabindex="0"]') ?? []);
        const first = els[0], last = els[els.length - 1];
        if (!first) { e.preventDefault(); return; }
        if (e.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && (document.activeElement === last || document.activeElement === ref.current)) { e.preventDefault(); first.focus(); }
      }}>
      <div className="mr-sheet__handle" aria-hidden="true"><span /></div>
      <div className="mr-sheet__head"><h2>{title}</h2><button onClick={onClose} aria-label={closeLabel}><Icon name="close" size={18} /></button></div>
      <div className="mr-sheet__content">{children}</div>
    </section>
  </div>;
}
