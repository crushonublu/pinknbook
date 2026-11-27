import { invoke } from "@tauri-apps/api/core";

/** Save stats settings (any of them), then let the page reload its numbers. */
export async function saveStatsSettings(
  p: { goalMinutes?: number; goalBooksYear?: number; kindleEstimates?: boolean },
  onChanged: () => void,
) {
  await invoke("set_stats_settings", p).catch(() => undefined);
  onChanged();
}

/** Daily goals offered, in minutes. */
export const DAILY_GOALS = [5, 10, 15, 20, 30, 45, 60, 90, 120];
const YEARLY_GOALS = [6, 12, 18, 24, 30, 36, 48, 52, 60, 100];

/** Yearly book goals offered; a goal set earlier (or from another device) stays selectable. */
export const yearlyGoals = (current: number) => [...new Set([...YEARLY_GOALS, current])].sort((a, b) => a - b);
