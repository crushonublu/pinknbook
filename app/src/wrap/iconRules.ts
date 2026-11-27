// Which stickers a wrap-up card starts with: a few 3D icons (src/wrap/icons.json)
// and, when the reader holds badges, the badge picture, picked by what the
// numbers say. The first rule that applies comes first; the list is cut at six
// and padded to three from a set of friendly fillers.

import type { BadgeId, PeriodStats, WrapKind } from "../stats/types";
import { YEAR_PAGES } from "./geometry";
import type { Rng } from "./shapes";

/** What goes on a card as a sticker: an icon of the manifest, or a badge picture (`ref` is the badge id). */
export interface StickerSpec {
  kind: "icon" | "badge";
  ref: string;
}

export const MIN_STICKERS = 3;
export const MAX_STICKERS = 6;

/** The numbers the rules read. */
export interface IconFacts {
  kind: WrapKind;
  /** Longest run of goal days inside the period. */
  streakBest: number;
  /** Shares (0..1) of the timed reading at night / in the early morning. */
  nightShare: number;
  earlyShare: number;
  /** Most days of the period met the daily goal. */
  goalMet: boolean;
  finished: number;
  highlights: number;
  notes: number;
  words: number;
  trendPct: number | null;
  topGenre: string | null;
  /** Badges held, best tier first. */
  badges: { id: BadgeId; tier: number }[];
}

/** An icon per genre (`GenreInfo.id`). */
export const GENRE_ICON: Record<string, string> = {
  romance: "heart",
  fantasy: "wand",
  scifi: "rocket",
  mystery: "magnifier",
  horror: "ghost",
  historical_fiction: "hourglass",
  kids_ya: "rainbow",
  comics: "popper",
  poetry_drama: "pencil",
  memoir: "notebook",
  history: "hourglass",
  science: "lightbulb",
  self_help: "leaf",
  business: "chart",
  philosophy: "owl",
  literary: "book",
  nonfiction: "book",
};

/** Icons for when the numbers give fewer than three. */
const FILLERS = ["star", "heart-sparkle", "coffee", "cat", "cloud", "tea", "glasses", "thumbs-up"];

const STREAK_FOR_FLAME = 7;
const NIGHT_SHARE = 0.5;
const EARLY_SHARE = 0.3;
const GOAL_DAYS_SHARE = 0.5;
const TREND_PCT = 15;
const FINISHED_FOR_CROWN = 3;
const HIGHLIGHTS_FOR_BOOKMARK = 20;
const NOTES_FOR_PENCIL = 5;

/** The facts of a period; `badges` are the ones the reader holds (the stats summary knows them). */
export function iconFacts(p: Pick<PeriodStats, "kind" | "days" | "days_met" | "streak_best_in_period" | "finished" | "highlights" | "notes" | "words" | "persona">, badges: IconFacts["badges"] = []): IconFacts {
  return {
    kind: p.kind === "week" || p.kind === "month" || p.kind === "year" ? p.kind : "year",
    streakBest: p.streak_best_in_period,
    nightShare: p.persona.night_share,
    earlyShare: p.persona.early_share,
    goalMet: p.days.length > 0 && p.days_met >= p.days.length * GOAL_DAYS_SHARE,
    finished: p.finished.length,
    highlights: p.highlights,
    notes: p.notes,
    words: p.words,
    trendPct: p.persona.trend_pct,
    topGenre: p.persona.top_genre,
    badges: [...badges].filter((b) => b.tier > 0).sort((a, b) => b.tier - a.tier),
  };
}

/** The stickers for a card, most telling first: 3 to 6 of them, no repeats. */
export function pickStickers(f: IconFacts, rng: Rng): StickerSpec[] {
  const out: StickerSpec[] = [];
  const add = (kind: StickerSpec["kind"], ref: string | undefined) => {
    if (ref && !out.some((s) => s.kind === kind && s.ref === ref)) out.push({ kind, ref });
  };
  const icon = (ref: string | undefined) => add("icon", ref);

  if (f.kind === "year") icon("gift");
  if (f.streakBest >= STREAK_FOR_FLAME) icon("flame");
  if (f.nightShare >= NIGHT_SHARE) icon("moon");
  if (f.earlyShare >= EARLY_SHARE) icon("sun");
  if (f.goalMet) icon("trophy");
  if (f.badges.length) {
    icon("medal");
    add("badge", f.badges[0].id);
  }
  if (f.topGenre) icon(GENRE_ICON[f.topGenre]);
  if (f.trendPct != null && f.trendPct > TREND_PCT) icon(out.some((s) => s.ref === "rocket") ? "lightning" : "rocket");
  if (f.finished >= FINISHED_FOR_CROWN) icon("crown");
  if (f.highlights >= HIGHLIGHTS_FOR_BOOKMARK) icon("bookmark");
  if (f.notes >= NOTES_FOR_PENCIL) icon("pencil");
  if (f.words > 0) icon("lightbulb");
  if (f.kind === "year") icon("popper");

  const fillers = [...FILLERS].sort(() => rng() - 0.5);
  while (out.length < MIN_STICKERS) icon(fillers.shift());
  return out.slice(0, MAX_STICKERS);
}

/** The stickers of one page of a year wrap: each page has its own few, about what it shows. */
export function yearPageStickers(f: IconFacts, page: number, rng: Rng): StickerSpec[] {
  if (page === 0) return pickStickers(f, rng).slice(0, 4);
  const icons: (string | undefined)[][] = [
    [],
    ["book", "crown", "bookmark"],
    [f.topGenre ? GENRE_ICON[f.topGenre] : undefined, "heart-sparkle", "star"],
    [f.streakBest >= STREAK_FOR_FLAME ? "flame" : undefined, "calendar", "trophy"],
    [f.nightShare >= NIGHT_SHARE ? "moon" : f.earlyShare >= EARLY_SHARE ? "sun" : "alarm", "hourglass", "coffee"],
    ["medal", "trophy", "star"],
  ];
  const out: StickerSpec[] = [];
  for (const ref of icons[page] ?? []) if (ref && !out.some((s) => s.ref === ref)) out.push({ kind: "icon", ref });
  if (page === 5 && f.badges.length) out.splice(1, 0, { kind: "badge", ref: f.badges[0].id });
  return out;
}

/**
 * The stickers the rules would use on this wrap, for the sticker tray to show
 * first: what the facts call for, on every page of a year.
 */
export function relevantStickers(f: IconFacts): StickerSpec[] {
  const out: StickerSpec[] = [];
  const rng = () => 0.5;
  const lists = f.kind === "year" ? Array.from({ length: YEAR_PAGES }, (_, page) => yearPageStickers(f, page, rng)) : [pickStickers(f, rng)];
  for (const spec of lists.flat()) if (!out.some((s) => s.kind === spec.kind && s.ref === spec.ref)) out.push(spec);
  return out;
}
