// The "reading profile" sentence of the Stats page, written offline from the
// `persona` facts of a period by an ordered list of rules. Pure and free of
// imports so `scripts/check-profile.mjs` can run it as it is.

import type { PeriodKind, Persona } from "./types";

type Lang = "vi" | "en";

/** A piece of the sentence; `em` marks the words the card highlights. */
export interface ProfilePart {
  text: string;
  em?: boolean;
}

export interface ProfileOptions {
  kind: PeriodKind;
  /** The display name of a genre id (leave out when the names are not loaded). */
  genreName?: (id: string) => string | undefined;
}

interface Ctx {
  p: Persona;
  lang: Lang;
  kind: PeriodKind;
  genre: string | undefined;
}

/** At least this share of timed reading at night (or early) makes the reader a night owl (or lark). */
const HABIT_SHARE = 0.5;
/** A change smaller than this (percent) is not worth a sentence. */
const MIN_TREND_PCT = 5;

const pct = (x: number) => Math.round(x * 100);
const minutes = (p: Persona) => Math.max(1, Math.round(p.avg_min_per_reading_day));
const lower = (s: string) => s.toLocaleLowerCase();

/** The first sentence: who the reader is. The first rule that applies wins. */
const LEADS: { when: (c: Ctx) => boolean; build: (c: Ctx) => ProfilePart[] }[] = [
  {
    // Night owl: most reading between 00:00 and 04:00.
    when: ({ p }) => p.night_share >= HABIT_SHARE,
    build: ({ p, lang, genre }) =>
      lang === "vi"
        ? [
            { text: "Bạn là " },
            { text: "cú đêm", em: true },
            { text: `${genre ? ` mê ${lower(genre)}` : ""}: ${pct(p.night_share)}% thời gian đọc rơi vào khoảng 0–4 giờ sáng.` },
          ]
        : [
            { text: "You are a " },
            { text: "night owl", em: true },
            { text: `${genre ? ` who loves ${lower(genre)}` : ""}: ${pct(p.night_share)}% of your reading falls between midnight and 4 AM.` },
          ],
  },
  {
    // Early bird: most reading between 04:00 and 06:00.
    when: ({ p }) => p.early_share >= HABIT_SHARE,
    build: ({ p, lang, genre }) =>
      lang === "vi"
        ? [
            { text: "Bạn là " },
            { text: "chim sớm", em: true },
            { text: `${genre ? ` mê ${lower(genre)}` : ""}: ${pct(p.early_share)}% thời gian đọc rơi vào khoảng 4–6 giờ sáng.` },
          ]
        : [
            { text: "You are an " },
            { text: "early bird", em: true },
            { text: `${genre ? ` who loves ${lower(genre)}` : ""}: ${pct(p.early_share)}% of your reading falls between 4 and 6 AM.` },
          ],
  },
  {
    when: ({ genre }) => genre !== undefined,
    build: ({ lang, genre }) =>
      lang === "vi"
        ? [{ text: "Bạn đọc nhiều nhất thể loại " }, { text: lower(genre ?? ""), em: true }, { text: "." }]
        : [{ text: "You read " }, { text: lower(genre ?? ""), em: true }, { text: " more than anything else." }],
  },
  {
    when: ({ p }) => p.avg_min_per_reading_day > 0,
    build: (c) => averageSentence(c),
  },
];

function averageSentence({ p, lang }: Ctx): ProfilePart[] {
  return lang === "vi"
    ? [{ text: "Mỗi ngày đọc, bạn dành trung bình " }, { text: `${minutes(p)} phút`, em: true }, { text: "." }]
    : [{ text: "On the days you read, you spend " }, { text: `${minutes(p)} minutes`, em: true }, { text: " on average." }];
}

/**
 * The second sentence, the first of these that applies. The average is not
 * repeated when the first sentence already said it.
 */
const FOLLOWS: { when: (c: Ctx, lead: number) => boolean; build: (c: Ctx) => ProfilePart[] }[] = [
  {
    // Against the period before (a week, month or year; "all" has none).
    when: ({ p, kind }) => kind !== "all" && p.trend_pct !== null && Math.abs(p.trend_pct) >= MIN_TREND_PCT,
    build: ({ p, lang, kind }) => {
      const up = (p.trend_pct ?? 0) > 0;
      const n = `${Math.round(Math.abs(p.trend_pct ?? 0))}%`;
      if (lang === "vi") {
        const before = kind === "week" ? "tuần trước" : kind === "month" ? "tháng trước" : "năm trước";
        return [{ text: `So với ${before}, bạn đọc ${up ? "nhiều hơn" : "ít hơn"} ` }, { text: n, em: true }, { text: "." }];
      }
      const before = kind === "week" ? "last week" : kind === "month" ? "last month" : "last year";
      return [{ text: `Compared with ${before}, you read ` }, { text: n, em: true }, { text: ` ${up ? "more" : "less"}.` }];
    },
  },
  {
    when: ({ p }) => p.fast_finishes >= 1,
    build: ({ p, lang }) =>
      lang === "vi"
        ? [{ text: `${p.fast_finishes} cuốn bạn đọc xong chỉ trong vòng một tuần kể từ lúc bắt đầu.` }]
        : [{ text: `${p.fast_finishes} ${p.fast_finishes === 1 ? "book" : "books"} finished within a week of starting.` }],
  },
  {
    when: ({ p }, lead) => lead !== LEAD_AVERAGE && p.avg_min_per_reading_day > 0,
    build: (c) => averageSentence(c),
  },
];

/** Index of the average rule in `LEADS`. */
const LEAD_AVERAGE = LEADS.length - 1;

/**
 * One or two sentences about how the reader read in a period, as parts.
 * Empty when there is nothing to say yet (no reading at all).
 */
export function profileSentence(p: Persona, lang: Lang, opts: ProfileOptions): ProfilePart[] {
  const genre = p.top_genre ? opts.genreName?.(p.top_genre) : undefined;
  const ctx: Ctx = { p, lang, kind: opts.kind, genre };
  const lead = LEADS.findIndex((r) => r.when(ctx));
  if (lead < 0) return [];
  const follow = FOLLOWS.find((r) => r.when(ctx, lead));
  return [...LEADS[lead].build(ctx), ...(follow ? [{ text: " " }, ...follow.build(ctx)] : [])];
}

/** The sentence as plain text. */
export const profileText = (parts: ProfilePart[]) => parts.map((x) => x.text).join("");

/** What the optional AI rewrite is given: the facts, nothing else about the reader. */
export function profileFacts(p: Persona, kind: PeriodKind, genreName?: (id: string) => string | undefined) {
  return {
    period: kind,
    night_share: Math.round(p.night_share * 100) / 100,
    early_share: Math.round(p.early_share * 100) / 100,
    top_genre: p.top_genre ? (genreName?.(p.top_genre) ?? null) : null,
    trend_pct: p.trend_pct === null ? null : Math.round(p.trend_pct),
    avg_min_per_reading_day: Math.round(p.avg_min_per_reading_day),
    fast_finishes: p.fast_finishes,
  };
}
