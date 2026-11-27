// Where everything sits on a wrap-up card. A card is always 1080 wide; its
// height is the format's (story or post). The fixed content is laid out in
// blocks with a set top and height, so the free zones the stickers go in
// (and the text areas the background keeps clear) are known without measuring
// anything. The templates (cards.tsx) read the blocks; the auto layout reads
// the zones.

import type { Rect } from "./shapes";

export type Format = "story" | "post";
export const FORMATS: readonly Format[] = ["story", "post"];

export const CARD_W = 1080;
export const CARD_H: Record<Format, number> = { story: 1920, post: 1350 };
/** Side margin of the card's content. */
export const SIDE = 80;
export const CONTENT_W = CARD_W - 2 * SIDE;
/** Width of the title column: the corner beside it is for a sticker. */
export const TITLE_W = 620;
/** Pages of a year wrap. */
export const YEAR_PAGES = 6;

/** A band of the card: its top and height. */
export interface Block {
  y: number;
  h: number;
}

export interface Geometry {
  /** The card's bands by name (which ones exist depends on the template). */
  blocks: Record<string, Block>;
  /** Spots free of content a sticker can sit in. */
  zones: Rect[];
  /** Where text sits: shapes drawn there are kept faint. */
  avoid: Rect[];
}

const r = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });

/** The parts every page has: header (kicker and title) and footer. */
function frame(format: Format, head: Block): { blocks: Record<string, Block>; avoid: Rect[]; corner: Rect } {
  const foot: Block = { y: CARD_H[format] - (format === "story" ? 90 : 85), h: 40 };
  return {
    blocks: { head, foot },
    avoid: [r(SIDE, head.y, TITLE_W, head.h), r(SIDE, foot.y, 260, foot.h), r(CARD_W - SIDE - 260, foot.y, 260, foot.h)],
    // The corner beside the title.
    corner: format === "story" ? r(730, 70, 290, 290) : r(740, 50, 280, 250),
  };
}

function monthGeometry(format: Format): Geometry {
  const story = format === "story";
  const f = frame(format, story ? { y: 100, h: 240 } : { y: 80, h: 220 });
  const blocks = story
    ? { covers: { y: 380, h: 800 }, tiles: { y: 1220, h: 400 }, line: { y: 1650, h: 150 } }
    : { covers: { y: 330, h: 400 }, tiles: { y: 760, h: 330 }, line: { y: 1120, h: 120 } };
  const zones = story
    ? [f.corner, r(915, 1190, 150, 150), r(810, 1640, 210, 170)]
    : [f.corner, r(920, 730, 140, 140), r(820, 1100, 200, 150)];
  // The covers and their captions count as text: the captions sit on a half-clear chip, and a vivid shape
  // would show round the covers.
  const text = [r(SIDE, blocks.covers.y, CONTENT_W, blocks.covers.h), r(SIDE, blocks.line.y, 720, blocks.line.h)];
  return { blocks: { ...f.blocks, ...blocks }, zones, avoid: [...f.avoid, ...text] };
}

function weekGeometry(format: Format): Geometry {
  const story = format === "story";
  const f = frame(format, story ? { y: 100, h: 240 } : { y: 80, h: 220 });
  const blocks = story
    ? { days: { y: 400, h: 340 }, hero: { y: 775, h: 340 }, book: { y: 1130, h: 380 }, line: { y: 1560, h: 180 } }
    : { days: { y: 320, h: 240 }, hero: { y: 570, h: 275 }, book: { y: 860, h: 270 }, line: { y: 1135, h: 100 } };
  const zones = story
    ? [f.corner, r(740, 790, 300, 280), r(810, 1140, 220, 260), r(830, 1560, 200, 200)]
    : [f.corner, r(760, 590, 280, 230), r(830, 860, 210, 220), r(840, 1105, 190, 145)];
  const text = [r(SIDE, blocks.line.y, 720, blocks.line.h), r(SIDE, blocks.days.y, CONTENT_W, blocks.days.h), r(SIDE, blocks.hero.y, 650, blocks.hero.h), r(370, blocks.book.y, 440, blocks.book.h)];
  return { blocks: { ...f.blocks, ...blocks }, zones, avoid: [...f.avoid, ...text] };
}

function yearGeometry(format: Format, page: number): Geometry {
  const story = format === "story";
  const f = frame(format, story ? { y: 100, h: 240 } : { y: 70, h: 190 });
  const body = story ? 380 : 290;
  const side = story ? r(760, 380, 260, 180) : r(760, 290, 260, 140);
  const blocks: Record<string, Block> = { ...f.blocks };
  const avoid = [...f.avoid];
  let zones: Rect[];
  switch (page) {
    case 0: // Overview: the year's hours, four numbers, a line.
      Object.assign(blocks, story
        ? { hero: { y: 400, h: 360 }, tiles: { y: 800, h: 430 }, line: { y: 1290, h: 200 } }
        : { hero: { y: 295, h: 285 }, tiles: { y: 590, h: 330 }, line: { y: 950, h: 160 } });
      zones = story ? [f.corner, r(740, 400, 300, 330), r(80, 1520, 430, 260), r(560, 1520, 430, 260)] : [f.corner, r(760, 300, 270, 240), r(80, 1130, 300, 130)];
      avoid.push(r(SIDE, blocks.hero.y, 650, blocks.hero.h), r(SIDE, blocks.line.y, 720, blocks.line.h));
      break;
    case 1: // Books: the cover wall.
      Object.assign(blocks, story ? { head2: { y: body, h: 180 }, wall: { y: 600, h: 904 } } : { head2: { y: body, h: 160 }, wall: { y: 455, h: 663 } });
      zones = story ? [f.corner, side, r(80, 1560, 430, 220), r(580, 1560, 430, 220)] : [f.corner, side];
      break;
    case 2: // Genres: a donut and its legend.
      Object.assign(blocks, story
        ? { head2: { y: body, h: 180 }, donut: { y: 560, h: 660 }, legend: { y: 1260, h: 440 } }
        : { head2: { y: body, h: 160 }, donut: { y: 460, h: 430 }, legend: { y: 920, h: 330 } });
      zones = story ? [f.corner, side, r(440, 790, 200, 200)] : [f.corner, side, r(450, 570, 180, 180)];
      break;
    case 3: // Streak and calendar: twelve small months.
      Object.assign(blocks, story ? { head2: { y: body, h: 190 }, months: { y: 590, h: 1190 } } : { head2: { y: body, h: 160 }, months: { y: 460, h: 780 } });
      zones = [f.corner, side];
      break;
    case 4: // Hours: 24 bars.
      Object.assign(blocks, story ? { head2: { y: body, h: 200 }, chart: { y: 640, h: 640 }, line: { y: 1330, h: 110 } } : { head2: { y: body, h: 160 }, chart: { y: 460, h: 520 }, line: { y: 1010, h: 100 } });
      zones = story ? [f.corner, side, r(80, 1480, 430, 300), r(580, 1480, 430, 300)] : [f.corner, side, r(80, 1120, 430, 130)];
      avoid.push(r(SIDE, blocks.line.y, 720, blocks.line.h));
      break;
    default: // Badges: the ones earned.
      Object.assign(blocks, story ? { head2: { y: body, h: 160 }, badges: { y: 600, h: 920 } } : { head2: { y: body, h: 130 }, badges: { y: 440, h: 700 } });
      zones = story ? [f.corner, side, r(80, 1580, 430, 200), r(580, 1580, 430, 200)] : [f.corner, side];
  }
  const headline = blocks.head2 ? [r(SIDE, blocks.head2.y, 660, blocks.head2.h)] : [];
  return { blocks, zones, avoid: [...avoid, ...headline] };
}

/** The geometry of a card: the template of `kind` in `format` (`page` is for the year's pages). */
export function geometryOf(kind: "week" | "month" | "year", format: Format, page = 0): Geometry {
  if (kind === "week") return weekGeometry(format);
  if (kind === "month") return monthGeometry(format);
  return yearGeometry(format, page);
}

/** Where text sits on any page of the card (the pages of a year share one background). */
export function avoidOf(kind: "week" | "month" | "year", format: Format): Rect[] {
  const seen = new Set<string>();
  const out: Rect[] = [];
  for (let page = 0; page < pagesOf(kind); page++) {
    for (const a of geometryOf(kind, format, page).avoid) {
      const key = `${a.x},${a.y},${a.w},${a.h}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(a);
      }
    }
  }
  return out;
}

/** How many pages a wrap has. */
export const pagesOf = (kind: "week" | "month" | "year") => (kind === "year" ? YEAR_PAGES : 1);
