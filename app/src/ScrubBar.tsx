import { useEffect, useRef, useState } from "react";

/** A tick on the bar: a bookmark, a highlight, a result, or where the reader was before a jump. */
export interface ScrubMark {
  key: string;
  fraction: number;
  color: string;
  kind: "bookmark" | "highlight" | "search" | "here";
  /** Written above the tick ("here" only). */
  label?: string;
}

/**
 * The preview page is laid out at its real, small size (scaling a full-size
 * page with a transform confuses the paginator's measurements); the reader
 * passes styles with the text shrunk by PREVIEW_SCALE to match.
 */
const PAGE_W = 176;
const PAGE_H = 244;
export const PREVIEW_SCALE = 0.34;
/** Half the slider thumb: where 0 % and 100 % sit on the track. */
const THUMB_HALF = 6.5;

/**
 * The reading-progress bar. Click or drag to go to a place; hover to see a
 * thumbnail of that page (laid out by a second, hidden copy of the book)
 * with its chapter and position; bookmarks and highlights show as ticks.
 */
export function ScrubBar({
  fraction,
  disabled,
  label,
  loadingLabel,
  marks,
  file,
  styles,
  formatPos,
  onSeek,
}: {
  fraction: number;
  disabled: boolean;
  label: string;
  loadingLabel: string;
  marks: ScrubMark[];
  /** The book, for the preview copy (null until it is open). */
  file: File | null;
  /** Reader CSS, so the preview looks like the page will. */
  styles: string;
  formatPos: (fraction: number) => string;
  onSeek: (fraction: number) => void;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const holder = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [chapter, setChapter] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const view = useRef<Promise<any> | null>(null);
  const want = useRef<number | null>(null);
  const going = useRef(false);
  const stylesRef = useRef(styles);
  stylesRef.current = styles;

  const shown = drag ?? fraction;
  const peek = drag ?? hover;

  // Create the preview copy the first time it is needed.
  function previewView() {
    if (!view.current && file && holder.current && customElements.get("foliate-view")) {
      const host = holder.current;
      view.current = (async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const v: any = document.createElement("foliate-view");
        v.style.width = `${PAGE_W}px`;
        v.style.height = `${PAGE_H}px`;
        v.setAttribute("inert", "");
        host.append(v);
        await v.open(file);
        v.renderer.setAttribute("flow", "paginated");
        v.renderer.setAttribute("max-column-count", "1");
        v.renderer.setAttribute("margin", "12px");
        v.renderer.setAttribute("gap", "8%");
        v.renderer.setStyles?.(stylesRef.current);
        v.addEventListener("relocate", (e: CustomEvent) => {
          const l = e.detail?.tocItem?.label;
          setChapter(typeof l === "string" && l.trim() ? l.trim() : null);
        });
        return v;
      })();
    }
    return view.current;
  }

  // Show the page at `f`, coalescing quick moves into the latest one.
  async function showAt(f: number) {
    want.current = f;
    if (going.current) return;
    const p = previewView();
    if (!p) return;
    going.current = true;
    setBusy(true);
    try {
      const v = await p;
      while (want.current != null) {
        const target = want.current;
        want.current = null;
        await v.goToFraction(Math.min(0.9999, Math.max(0, target)));
      }
      setReady(true);
    } catch {
      /* preview is best-effort */
    } finally {
      going.current = false;
      setBusy(false);
    }
  }

  useEffect(() => {
    if (peek != null) showAt(peek);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peek == null ? null : Math.round(peek * 2000)]);

  useEffect(() => {
    view.current?.then((v) => v.renderer?.setStyles?.(styles)).catch(() => undefined);
  }, [styles]);

  useEffect(
    () => () => {
      view.current
        ?.then((v) => {
          v.close?.();
          v.remove();
        })
        .catch(() => undefined);
    },
    [],
  );

  function fracAt(clientX: number) {
    const r = wrap.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - r.left - THUMB_HALF) / Math.max(1, r.width - THUMB_HALF * 2)));
  }

  function commit() {
    if (drag == null) return;
    const f = drag;
    setDrag(null);
    onSeek(Math.max(0.0001, f));
  }

  const tipX = peek == null ? 0 : `calc(${THUMB_HALF}px + ${peek} * (100% - ${THUMB_HALF * 2}px))`;

  return (
    <div
      ref={wrap}
      className="rscrub"
      onPointerMove={(e) => !disabled && setHover(fracAt(e.clientX))}
      onPointerLeave={() => setHover(null)}
    >
      <div className="rscrub__ticks" aria-hidden="true">
        {marks.map((m) => (
          <span
            key={m.key}
            className={`rscrub__tick rscrub__tick--${m.kind}`}
            style={{
              left: `calc(${THUMB_HALF}px + ${m.fraction} * (100% - ${THUMB_HALF * 2}px))`,
              background: m.color,
            }}
            data-label={m.label}
          />
        ))}
      </div>
      <input
        className="reader__scrub"
        type="range"
        min={0}
        max={1000}
        value={Math.round(shown * 1000)}
        style={{ ["--p" as string]: `${shown * 100}%` }}
        onChange={(e) => setDrag(Number(e.target.value) / 1000)}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={() => setDrag(null)}
        aria-label={label}
        title={peek == null ? label : undefined}
        disabled={disabled}
      />
      <div
        className={`rscrub__tip${peek != null && file ? " is-on" : ""}`}
        style={{ left: tipX }}
        aria-hidden="true"
      >
        <div className="rscrub__page" style={{ width: PAGE_W, height: PAGE_H }}>
          <div
            ref={holder}
            className={`rscrub__view${ready ? "" : " is-loading"}${busy ? " is-busy" : ""}`}
            style={{ width: PAGE_W, height: PAGE_H }}
          />
          {!ready && <span className="rscrub__loading">{loadingLabel}</span>}
        </div>
        <div className="rscrub__caption">
          {chapter && ready && <span className="rscrub__chapter">{chapter}</span>}
          <span className="rscrub__pos">{peek != null ? formatPos(peek) : ""}</span>
        </div>
      </div>
    </div>
  );
}
