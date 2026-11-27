// The maths of editing a sticker on a wrap-up card, kept free of the DOM so it
// can be checked on its own (scripts/check-wrap-gestures.mjs). Everything is in
// card coordinates (1080 wide): the editor turns pointer positions into them
// before calling in here.

import { CARD_H, CARD_W, type Format } from "./geometry";
import { STICKER_BASE, type Sticker } from "./layout";

export const MIN_SCALE = 0.4;
export const MAX_SCALE = 3;

export interface Point {
  x: number;
  y: number;
}

/** The part of a sticker a gesture changes. */
export type Pose = Pick<Sticker, "x" | "y" | "scale" | "rotate">;

const RAD = Math.PI / 180;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const dist = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);
const angle = (a: Point, b: Point) => Math.atan2(b.y - a.y, b.x - a.x) / RAD;
const mid = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/** Degrees in (-180, 180]. */
export function wrapDegrees(deg: number): number {
  const d = ((((deg + 180) % 360) + 360) % 360) - 180;
  return d === -180 ? 180 : d;
}

/** Half the width of the box a turned sticker takes up: its square, seen from the side. */
export function reach(p: Pick<Pose, "scale" | "rotate">): number {
  const r = p.rotate * RAD;
  return ((STICKER_BASE * p.scale) / 2) * (Math.abs(Math.cos(r)) + Math.abs(Math.sin(r)));
}

const round = (v: number, places: number) => Math.round(v * 10 ** places) / 10 ** places;

/** A pose kept legal: the scale within its limits, the whole sticker inside the card; rounded for saving. */
export function clampPose(p: Pose, format: Format): Pose {
  const scale = round(clamp(p.scale, MIN_SCALE, MAX_SCALE), 3);
  const rotate = round(wrapDegrees(p.rotate), 1);
  const half = reach({ scale, rotate });
  // The limits are rounded inwards, so rounding the place cannot push the sticker over an edge.
  const within = (v: number, size: number) => clamp(round(v, 1), Math.ceil(half * 10) / 10, Math.floor((size - half) * 10) / 10);
  return { scale, rotate, x: within(p.x, CARD_W), y: within(p.y, CARD_H[format]) };
}

/** One finger or the mouse: the sticker follows the pointer. */
export function dragPose(start: Pose, from: Point, to: Point, format: Format): Pose {
  return clampPose({ ...start, x: start.x + to.x - from.x, y: start.y + to.y - from.y }, format);
}

/**
 * Two fingers: the sticker keeps the same place under them. The distance
 * between the fingers scales it, the angle between them turns it, and it moves
 * with their midpoint, as if it were stuck to the fingers.
 */
export function pinchPose(start: Pose, from: readonly [Point, Point], to: readonly [Point, Point], format: Format): Pose {
  const d0 = dist(from[0], from[1]);
  if (d0 < 1) return clampPose(start, format);
  const scale = clamp((start.scale * dist(to[0], to[1])) / d0, MIN_SCALE, MAX_SCALE);
  const k = scale / start.scale;
  const turn = angle(to[0], to[1]) - angle(from[0], from[1]);
  const m0 = mid(from[0], from[1]);
  const m1 = mid(to[0], to[1]);
  const [cos, sin] = [Math.cos(turn * RAD), Math.sin(turn * RAD)];
  const [ox, oy] = [start.x - m0.x, start.y - m0.y];
  return clampPose({ scale, rotate: start.rotate + turn, x: m1.x + k * (ox * cos - oy * sin), y: m1.y + k * (ox * sin + oy * cos) }, format);
}

/**
 * The corner handle of the desktop: the sticker's centre stays, the handle
 * follows the pointer, so its distance from the centre scales and its
 * direction turns.
 */
export function handlePose(start: Pose, from: Point, to: Point, format: Format): Pose {
  const centre = { x: start.x, y: start.y };
  const d0 = dist(centre, from);
  if (d0 < 1) return clampPose(start, format);
  return clampPose(
    { ...start, scale: (start.scale * dist(centre, to)) / d0, rotate: start.rotate + angle(centre, to) - angle(centre, from) },
    format,
  );
}

/** Arrow keys: a step of 1 card pixel, ten with Shift. */
export const nudgePose = (p: Pose, dx: number, dy: number, big: boolean, format: Format): Pose => {
  const step = big ? 10 : 1;
  return clampPose({ ...p, x: p.x + dx * step, y: p.y + dy * step }, format);
};

/** `[` and `]`: 5 degrees, 15 with Shift. */
export const turnPose = (p: Pose, dir: -1 | 1, big: boolean, format: Format): Pose => clampPose({ ...p, rotate: p.rotate + dir * (big ? 15 : 5) }, format);

/** `+` and `-`: 5 percent of the size, 20 with Shift. */
export const resizePose = (p: Pose, dir: -1 | 1, big: boolean, format: Format): Pose => clampPose({ ...p, scale: p.scale * (1 + dir * (big ? 0.2 : 0.05)) }, format);

/** Where a pointer is in card coordinates, given the card's box on the screen (before and after being scaled). */
export function toCard(clientX: number, clientY: number, box: { left: number; top: number }, scale: number): Point {
  return { x: (clientX - box.left) / scale, y: (clientY - box.top) / scale };
}

/** The stickers with `id` brought in front of the others of its page; the same array when it is there already. */
export function raised(stickers: readonly Sticker[], id: string): Sticker[] {
  const s = stickers.find((x) => x.id === id);
  if (!s) return [...stickers];
  const page = s.page ?? 0;
  const top = Math.max(...stickers.filter((x) => (x.page ?? 0) === page).map((x) => x.z));
  return s.z === top && stickers.filter((x) => (x.page ?? 0) === page && x.z === top).length === 1
    ? (stickers as Sticker[])
    : stickers.map((x) => (x.id === id ? { ...x, z: top + 1 } : x));
}
