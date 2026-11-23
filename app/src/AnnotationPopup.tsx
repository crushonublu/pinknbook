import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { STR, type Lang } from "./i18n";
import { COLOR_HEX, HIGHLIGHT_COLORS, type HighlightColor } from "./annotate";
import { Icon } from "./icons";
import { isAndroid } from "./platform";
import type { MobileHighlightStyle } from "./mobile/annotationStyle";

/** Keep a floating box on screen: above the anchor, else below it. */
/** `extra`: anything else that changes the box size (re-measure when it changes). */
export function usePlace(anchor: DOMRect, gap = 10, extra?: unknown, belowGap = gap, keepOnScreen = false) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; below: boolean } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = anchor.left + anchor.width / 2 - w / 2;
    left = Math.max(8, Math.min(vw - w - 8, left));
    const above = anchor.top - h - gap;
    const below = anchor.bottom + belowGap;
    const useBelow = above < 56 && below + h < vh - 8;
    const preferredTop = useBelow ? below : Math.max(56, above);
    const top = keepOnScreen ? Math.max(8, Math.min(vh - h - 8, preferredTop)) : preferredTop;
    setPos({ left, top, below: useBelow });
  }, [anchor.left, anchor.top, anchor.width, anchor.height, anchor.bottom, extra]);
  return { ref, pos };
}

/**
 * The small bar over a selection or a highlight: the four colours, note,
 * copy, and (for an existing highlight) delete.
 */
export function HighlightBar({
  lang,
  anchor,
  current,
  hasNote,
  onColor,
  onNote,
  onCopy,
  onDelete,
  onClose,
  mobileCurrent,
  onMobileColor,
}: {
  lang: Lang;
  anchor: DOMRect;
  /** The highlight's colour; none for a fresh selection. */
  current?: HighlightColor;
  mobileCurrent?: MobileHighlightStyle;
  onMobileColor?: (style: MobileHighlightStyle) => void;
  hasNote?: boolean;
  onColor: (c: HighlightColor) => void;
  onNote: () => void;
  onCopy: () => void;
  onDelete?: () => void;
  onClose: () => void;
}) {
  const t = STR[lang];
  const [more, setMore] = useState(false);
  const { ref, pos } = usePlace(anchor, isAndroid ? 12 : 10, more, isAndroid ? 32 : 10, isAndroid);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [onClose]);

  if (isAndroid) return <div ref={ref} className={`hlbar mc-bar${pos?.below ? " is-below" : ""}`}
    style={pos ? { left: pos.left, top: pos.top } : { visibility: "hidden" }} role="toolbar" aria-label={t.hlToolbar}
    onPointerDown={(e) => e.preventDefault()}>
    <div className="mc-bar__colors" role="group" aria-label={t.hlColor}>
      {(["yellow", "green", "blue", "pink", "underline"] as const).map((c) => <button key={c}
        className={`mc-dot${(mobileCurrent ?? current) === c ? " is-on" : ""}${c === "underline" ? " mc-dot--underline" : ""}`}
        style={{ background: c === "underline" ? "transparent" : c === "green" ? "#7ed18c" : COLOR_HEX[c] }}
        aria-label={t[`hl_${c}`]} aria-pressed={(mobileCurrent ?? current) === c}
        onClick={() => onMobileColor ? onMobileColor(c) : onColor(c === "green" || c === "underline" ? "yellow" : c)}>
        {c === "underline" && <Icon name="underline" size={20} />}
      </button>)}
    </div>
    <div className="mc-bar__actions">
      <button onClick={onNote} aria-label={hasNote ? t.hlEditNote : t.hlAddNote}><Icon name="edit" size={18} />{t.hlNoteTitle}</button>
      <button onClick={onCopy}><Icon name="copy" size={18} />{t.hlCopy}</button>
      <button onClick={() => setMore((v) => !v)} aria-label={t.mcMore} aria-expanded={more}><Icon name="more" size={20} /></button>
    </div>
    {more && <div className="mc-bar__more">
      {onDelete && <button onClick={onDelete}><Icon name="trash" size={18} />{t.hlDelete}</button>}
      <button onClick={onClose}><Icon name="close" size={18} />{t.closeReader}</button>
    </div>}
  </div>;

  return (
    <div
      ref={ref}
      className={`hlbar${pos?.below ? " is-below" : ""}`}
      style={pos ? { left: pos.left, top: pos.top } : { visibility: "hidden" }}
      role="toolbar"
      aria-label={t.hlToolbar}
      onPointerDown={(e) => e.preventDefault() /* keep the selection */}
    >
      {HIGHLIGHT_COLORS.map((c) => (
        <button
          key={c}
          className={`hlbar__dot${current === c ? " is-on" : ""}`}
          style={{ ["--c" as string]: COLOR_HEX[c] }}
          onClick={() => onColor(c)}
          aria-label={`${t.hlColor} ${t[`hl_${c}` as const]}`}
          aria-pressed={current === c}
          title={t[`hl_${c}` as const]}
        />
      ))}
      <span className="hlbar__sep" />
      <button className="hlbar__btn" onClick={onNote} title={hasNote ? t.hlEditNote : t.hlAddNote}>
        <Icon name="edit" size={16} />
        <span>{hasNote ? t.hlEditNote : t.hlAddNote}</span>
      </button>
      <button className="hlbar__btn" onClick={onCopy} title={t.hlCopy} aria-label={t.hlCopy}>
        <Icon name="copy" size={16} />
      </button>
      {onDelete && (
        <button className="hlbar__btn hlbar__btn--del" onClick={onDelete} title={t.hlDelete} aria-label={t.hlDelete}>
          <Icon name="trash" size={16} />
        </button>
      )}
    </div>
  );
}

/** Write or edit the note on a highlight. */
export function NoteEditor({
  lang,
  anchor,
  excerpt,
  color,
  initial,
  onSave,
  onCancel,
}: {
  lang: Lang;
  anchor: DOMRect;
  excerpt: string;
  color: HighlightColor;
  initial: string;
  onSave: (text: string) => void;
  onCancel: () => void;
}) {
  const t = STR[lang];
  const [text, setText] = useState(initial);
  const { ref, pos } = usePlace(anchor, 12);
  const area = useRef<HTMLTextAreaElement>(null);

  // Focus once placed (a hidden box cannot take focus).
  const placed = pos != null;
  useEffect(() => {
    if (!placed) return;
    area.current?.focus();
    area.current?.setSelectionRange(text.length, text.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placed]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        onCancel();
      }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [onCancel]);

  return (
    <div
      ref={ref}
      className="hlnote"
      style={pos ? { left: pos.left, top: pos.top } : { visibility: "hidden" }}
      role="dialog"
      aria-label={t.hlNoteTitle}
    >
      <blockquote className="hlnote__quote" style={{ ["--c" as string]: COLOR_HEX[color] }}>
        {excerpt}
      </blockquote>
      <textarea
        ref={area}
        className="hlnote__input"
        value={text}
        placeholder={t.hlNotePlaceholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) onSave(text);
          e.stopPropagation();
        }}
        rows={4}
        maxLength={4000}
      />
      <div className="hlnote__actions">
        <span className="hlnote__hint">{t.hlNoteHint}</span>
        <button className="btn" onClick={onCancel}>
          {t.cancel}
        </button>
        <button className="btn btn--primary" onClick={() => onSave(text)}>
          {t.save}
        </button>
      </div>
    </div>
  );
}
