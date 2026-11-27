// Which fact the highlight line of a card states. Kept apart from the wording
// (data.ts) so the choice can be checked on its own.

import type { PeriodStats } from "../stats/types";

/** What a card already says in its numbers, so its highlight line must not say it again. */
export type ShownFact = "trend" | "days" | "highlights" | "finished";

export type FactId = "trend" | "best" | "night" | "early" | "words" | "highlights" | "finished" | "days" | "none";

/** Share of the timed reading that makes a night or early-morning habit worth saying. */
const NIGHT_SHARE = 0.5;
const EARLY_SHARE = 0.3;
/** A period this much (percent) bigger than the one before is worth saying. */
const TREND_PCT = 15;

/**
 * The first of these that the numbers support and the card does not already
 * show (`shown`): a clearly bigger period than the one before, the biggest
 * reading day, a night or early-morning habit, new words, highlights made, books
 * finished, days read.
 */
export function pickFact(p: Pick<PeriodStats, "persona" | "best_day" | "words" | "highlights" | "finished" | "days_read">, shown: readonly ShownFact[] = []): FactId {
  const fresh = (f: ShownFact) => !shown.includes(f);
  const { trend_pct: trend, night_share: night, early_share: early } = p.persona;
  if (trend != null && trend >= TREND_PCT && fresh("trend")) return "trend";
  if (p.best_day) return "best";
  if (night >= NIGHT_SHARE) return "night";
  if (early >= EARLY_SHARE) return "early";
  if (p.words > 0) return "words";
  if (p.highlights > 0 && fresh("highlights")) return "highlights";
  if (p.finished.length > 0 && fresh("finished")) return "finished";
  if (p.days_read > 0 && fresh("days")) return "days";
  return "none";
}
