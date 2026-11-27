// The model of a wrap-up card and the automatic arrangement of its stickers.
//
// A card is three layers: the generated background (from the seed), the fixed
// content of the template (title, numbers, covers) and the stickers on top. What
// the reader can change is saved with the wrap (`wrap_save_layout`) as a
// `WrapLayout`: the theme, the background's reroll counter, the format and the
// stickers. Stickers are placed by their centre, in card coordinates (1080 wide).

import { CARD_H, CARD_W, FORMATS, YEAR_PAGES, geometryOf, pagesOf, type Format, type Geometry } from "./geometry";
import { isThemeId, type ThemeId } from "./palettes";
import { yearPageStickers, pickStickers, type IconFacts, type StickerSpec } from "./iconRules";
import { mulberry32, seedFor, type Rng } from "./shapes";

export type WrapKind = "week" | "month" | "year";

/** Edge of a sticker at scale 1, in card coordinates. */
export const STICKER_BASE = 240;

export interface Sticker {
  id: string;
  kind: "icon" | "badge";
  /** The icon id of icons.json, or the badge id. */
  ref: string;
  /** Centre. */
  x: number;
  y: number;
  /** 1 = STICKER_BASE wide. */
  scale: number;
  /** Degrees. */
  rotate: number;
  /** Stacking order. */
  z: number;
  /** The page of a year wrap it is on (0 when absent). */
  page?: number;
}

export interface WrapLayout {
  theme: ThemeId;
  /** The background's seed (`seedFor` of the kind, the first day and `reroll`). */
  seed: number;
  /** How many times "Đổi nền" was pressed. */
  reroll: number;
  format: Format;
  stickers: Sticker[];
}

/** The theme a kind of wrap starts in. */
export const DEFAULT_THEME: Record<WrapKind, ThemeId> = { week: "forest", month: "wine", year: "night" };

/** How much of a zone's shorter side a sticker fills (icons are padded, and a turn needs room). */
const ZONE_FILL: readonly [number, number] = [0.72, 0.86];
const MAX_TURN = 16;

const between = (rng: Rng, lo: number, hi: number) => lo + (hi - lo) * rng();

/**
 * Puts the stickers of one page in its free zones: the first (most telling) in
 * the biggest zone, and so on; stickers beyond the zones are left out. A little
 * jitter and a turn make them look placed rather than stamped.
 */
export function placeStickers(specs: readonly StickerSpec[], geo: Geometry, format: Format, page: number, rng: Rng, firstZ = 1): Sticker[] {
  const zones = [...geo.zones].sort((a, b) => b.w * b.h - a.w * a.h);
  const out: Sticker[] = [];
  specs.slice(0, zones.length).forEach((spec, i) => {
    const z = zones[i];
    const size = Math.min(z.w, z.h) * between(rng, ...ZONE_FILL);
    const jitter = (room: number) => (rng() - 0.5) * room * 0.4;
    const half = size / 2;
    // The centre stays inside the card, whatever the jitter.
    const x = Math.min(CARD_W - half, Math.max(half, z.x + z.w / 2 + jitter(z.w - size)));
    const y = Math.min(CARD_H[format] - half, Math.max(half, z.y + z.h / 2 + jitter(z.h - size)));
    out.push({
      id: `s${page}-${i}`,
      kind: spec.kind,
      ref: spec.ref,
      x: Math.round(x),
      y: Math.round(y),
      scale: Math.round((size / STICKER_BASE) * 100) / 100,
      rotate: Math.round(between(rng, -MAX_TURN, MAX_TURN)),
      z: firstZ + i,
      ...(page ? { page } : {}),
    });
  });
  return out;
}

/** The stickers a card starts with for its facts: week and month on one page, a year on six. */
export function autoStickers(kind: WrapKind, format: Format, facts: IconFacts, rng: Rng): Sticker[] {
  if (kind !== "year") return placeStickers(pickStickers(facts, rng), geometryOf(kind, format), format, 0, rng);
  let z = 1;
  const out: Sticker[] = [];
  for (let page = 0; page < YEAR_PAGES; page++) {
    const placed = placeStickers(yearPageStickers(facts, page, rng), geometryOf(kind, format, page), format, page, rng, z);
    z += placed.length;
    out.push(...placed);
  }
  return out;
}

/** A fresh layout: the kind's default theme, the stickers placed by rule, a given reroll. */
export function newLayout(kind: WrapKind, periodStart: string, facts: IconFacts, opts: { format?: Format; reroll?: number; theme?: ThemeId } = {}): WrapLayout {
  const format = opts.format ?? "story";
  const reroll = opts.reroll ?? 0;
  const seed = seedFor(kind, periodStart, reroll);
  // The stickers draw from their own stream, so that rerolling the background leaves them be.
  const stickers = autoStickers(kind, format, facts, mulberry32(seedFor(kind, periodStart, 0) ^ 0x9e3779b9));
  return { theme: opts.theme ?? DEFAULT_THEME[kind], seed, reroll, format, stickers };
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function parseSticker(v: unknown, kind: WrapKind): Sticker | null {
  if (!v || typeof v !== "object") return null;
  const s = v as Record<string, unknown>;
  if (typeof s.id !== "string" || (s.kind !== "icon" && s.kind !== "badge") || typeof s.ref !== "string") return null;
  if (![s.x, s.y, s.scale, s.rotate, s.z].every(isNum)) return null;
  const page = s.page === undefined ? undefined : isNum(s.page) && s.page >= 0 && s.page < pagesOf(kind) ? s.page : null;
  if (page === null) return null;
  return { id: s.id, kind: s.kind, ref: s.ref, x: s.x as number, y: s.y as number, scale: s.scale as number, rotate: s.rotate as number, z: s.z as number, ...(page ? { page } : {}) };
}

/** The saved layout of a wrap, or null when there is none or it cannot be used (a newer or broken one). */
export function parseLayout(json: string | null | undefined, kind: WrapKind): WrapLayout | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as Record<string, unknown>;
    if (!isThemeId(v.theme) || !isNum(v.seed) || !isNum(v.reroll) || !FORMATS.includes(v.format as Format) || !Array.isArray(v.stickers)) return null;
    const stickers = v.stickers.map((s) => parseSticker(s, kind));
    if (stickers.some((s) => !s)) return null;
    return { theme: v.theme, seed: v.seed, reroll: v.reroll, format: v.format as Format, stickers: stickers as Sticker[] };
  } catch {
    return null;
  }
}

export const layoutJson = (l: WrapLayout) => JSON.stringify(l);
