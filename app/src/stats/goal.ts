import { daysBetween, daysInYear, parseDay } from "./format";

/** Where the yearly book goal stands on a day of that year. */
export interface YearPace {
  /** Books short of an even pace, when a whole book or more. */
  behind: number;
  /** Days of the year after today. */
  daysLeft: number;
  done: boolean;
}

/** An even pace reads `goal` books across the year's days. */
export function yearPace(goal: number, finished: number, today: string): YearPace {
  const year = parseDay(today).getFullYear();
  const dayOfYear = daysBetween(`${year}-01-01`, today) + 1;
  const total = daysInYear(year);
  const expected = (goal * dayOfYear) / total;
  return {
    behind: Math.max(0, Math.floor(expected - finished + 1e-9)),
    daysLeft: total - dayOfYear,
    done: finished >= goal,
  };
}
