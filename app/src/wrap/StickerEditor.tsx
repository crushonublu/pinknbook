import { useCallback, useEffect, useRef } from "react";
import { fmt } from "../stats/format";
import { STR, type Lang } from "../i18n";
import { CARD_W, type Format } from "./geometry";
import { dragPose, handlePose, nudgePose, pinchPose, resizePose, toCard, turnPose, type Point, type Pose } from "./gestures";
import { STICKER_BASE, type Sticker } from "./layout";

/** What a gesture is doing to the selected sticker. */
type Gesture =
  | { mode: "drag" | "handle"; id: string; start: Pose; from: Point }
  | { mode: "pinch"; id: string; start: Pose; from: [Point, Point]; ids: [number, number] };

/** A key pressed in a text field is for the field. */
export const typing = (e: KeyboardEvent) => e.target instanceof Element && e.target.closest("input, textarea, select, [contenteditable]") !== null;

const poseOf = (s: Sticker): Pose => ({ x: s.x, y: s.y, scale: s.scale, rotate: s.rotate });

/** Keys that change the selected sticker, as the change they make. */
function keyChange(e: KeyboardEvent, p: Pose, format: Format): Pose | null {
  const big = e.shiftKey;
  switch (e.key) {
    case "ArrowLeft": return nudgePose(p, -1, 0, big, format);
    case "ArrowRight": return nudgePose(p, 1, 0, big, format);
    case "ArrowUp": return nudgePose(p, 0, -1, big, format);
    case "ArrowDown": return nudgePose(p, 0, 1, big, format);
    case "[": case "{": return turnPose(p, -1, big, format);
    case "]": case "}": return turnPose(p, 1, big, format);
    case "+": case "=": return resizePose(p, 1, big, format);
    case "-": case "_": return resizePose(p, -1, big, format);
    default: return null;
  }
}

/**
 * The layer over the card that edits its stickers. One finger or the mouse
 * moves the sticker under it; a second finger turns and scales it (pinch); on
 * the desktop the corner handle does the same and the keys nudge, turn, scale
 * and delete it. Every pointer is captured by this layer, so a gesture goes on
 * when the fingers leave the sticker. It sits in the card's own coordinates
 * (inside the scaled box) and is not part of the exported picture.
 */
export function StickerEditor({ lang, scale, stickers, format, selected, onSelect, onBegin, onChange, onRemove }: {
  lang: Lang;
  /** Screen pixels per card pixel: the outline and handle keep their size on screen. */
  scale: number;
  /** The stickers of the page shown. */
  stickers: readonly Sticker[];
  format: Format;
  selected: string | null;
  onSelect: (id: string | null) => void;
  /** A change is about to start (the viewer keeps the way back); `key` joins repeated key presses into one. */
  onBegin: (key?: string) => void;
  onChange: (id: string, pose: Pose) => void;
  onRemove: (id: string) => void;
}) {
  const t = STR[lang];
  const root = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<Gesture | null>(null);
  const started = useRef(false);
  const latest = useRef({ stickers, selected, format });
  latest.current = { stickers, selected, format };

  const at = useCallback((e: { clientX: number; clientY: number }): Point => {
    const box = root.current!.getBoundingClientRect();
    return toCard(e.clientX, e.clientY, box, box.width / CARD_W);
  }, []);
  const sticker = (id: string) => latest.current.stickers.find((s) => s.id === id);

  const down = (e: React.PointerEvent) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const p = at(e);
    root.current!.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, p);
    const { selected: cur } = latest.current;
    if (pointers.current.size === 2 && cur && sticker(cur)) {
      // A second finger: turn and scale the selected sticker from here on.
      const [a, b] = [...pointers.current.keys()] as [number, number];
      gesture.current = { mode: "pinch", id: cur, start: poseOf(sticker(cur)!), from: [pointers.current.get(a)!, pointers.current.get(b)!], ids: [a, b] };
      return;
    }
    if (pointers.current.size > 1) return;
    started.current = false;
    const target = e.target as HTMLElement;
    const id = target.closest<HTMLElement>("[data-sticker]")?.dataset.sticker;
    const s = id ? sticker(id) : undefined;
    onSelect(s ? s.id : null);
    gesture.current = s ? { mode: target.closest("[data-handle]") ? "handle" : "drag", id: s.id, start: poseOf(s), from: p } : null;
  };

  const move = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, at(e));
    const g = gesture.current;
    if (!g) return;
    const { format: f } = latest.current;
    const now = pointers.current.get(e.pointerId)!;
    let pose: Pose;
    if (g.mode === "pinch") {
      const [a, b] = g.ids.map((i) => pointers.current.get(i)) as [Point | undefined, Point | undefined];
      if (!a || !b) return;
      pose = pinchPose(g.start, g.from, [a, b], f);
    } else {
      // A tap is not a move: a few card pixels of slack keep a shaky finger from nudging the sticker.
      if (!started.current && Math.hypot(now.x - g.from.x, now.y - g.from.y) < 6) return;
      pose = (g.mode === "drag" ? dragPose : handlePose)(g.start, g.from, now, f);
    }
    if (!started.current) {
      started.current = true;
      onBegin();
    }
    onChange(g.id, pose);
  };

  const up = (e: React.PointerEvent) => {
    if (!pointers.current.delete(e.pointerId)) return;
    const g = gesture.current;
    if (g?.mode === "pinch" && g.ids.includes(e.pointerId)) {
      // One finger stays: it carries on as a drag of the sticker as it is now.
      const [left] = pointers.current.keys();
      const s = sticker(g.id);
      gesture.current = left !== undefined && s ? { mode: "drag", id: g.id, start: poseOf(s), from: pointers.current.get(left)! } : null;
      return;
    }
    if (!pointers.current.size) gesture.current = null;
  };

  // Keys of the desktop. The viewer's own Escape handling deselects.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { selected: id, stickers: list, format: f } = latest.current;
      const s = id ? list.find((x) => x.id === id) : undefined;
      if (!s || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || typing(e)) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        onRemove(s.id);
        return;
      }
      const next = keyChange(e, poseOf(s), f);
      if (!next) return;
      e.preventDefault();
      onBegin(e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown" ? "nudge" : e.key);
      onChange(s.id, next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBegin, onChange, onRemove]);

  return (
    <div ref={root} className="wc-edit" style={{ ["--inv" as string]: 1 / scale }} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
      {stickers.map((s, i) => {
        const size = STICKER_BASE * s.scale;
        return (
          <button
            key={s.id}
            type="button"
            className={`wc-edit__s${s.id === selected ? " is-selected" : ""}`}
            data-sticker={s.id}
            aria-pressed={s.id === selected}
            aria-label={fmt(t.wrStickerN, i + 1)}
            style={{ left: s.x - size / 2, top: s.y - size / 2, width: size, height: size, zIndex: s.z, transform: `rotate(${s.rotate}deg)` }}
            onClick={() => onSelect(s.id)}
          >
            {s.id === selected && <span className="wc-edit__handle" data-handle="" title={t.wrStickerResize} />}
          </button>
        );
      })}
    </div>
  );
}
