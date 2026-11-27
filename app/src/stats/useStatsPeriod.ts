import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { PeriodKind, PeriodStats } from "./types";

/** Last answer per period, shown at once while a fresh one is fetched. */
const cache = new Map<string, PeriodStats>();

const keyOf = (kind: PeriodKind, anchor: string | undefined) => `${kind}:${anchor ?? ""}`;

/**
 * `stats_period` for one period. The cached answer (if any) is returned on
 * the first render and the period is fetched again whenever `refreshKey`
 * changes: pass the stats summary, which is replaced after every reading
 * session, sync and settings change. `enabled = false` skips the fetch.
 */
export function useStatsPeriod(kind: PeriodKind, anchor: string | undefined, refreshKey: unknown, enabled = true) {
  const key = keyOf(kind, anchor);
  const [state, setState] = useState<{ key: string; stats: PeriodStats | null; failed: boolean }>(() => ({
    key,
    stats: cache.get(key) ?? null,
    failed: false,
  }));

  useEffect(() => {
    if (!enabled) return;
    let stale = false;
    invoke<PeriodStats>("stats_period", { kind, anchor: anchor ?? null })
      .then((stats) => {
        cache.set(key, stats);
        if (!stale) setState({ key, stats, failed: false });
      })
      .catch((e) => {
        console.error(e);
        if (!stale) setState((s) => ({ key, stats: s.key === key ? s.stats : (cache.get(key) ?? null), failed: true }));
      });
    return () => {
      stale = true;
    };
  }, [kind, anchor, key, refreshKey, enabled]);

  // A period that has just been switched to shows its cache, not the last one.
  const stats = state.key === key ? state.stats : (cache.get(key) ?? null);
  return { stats, failed: state.key === key && state.failed && !stats };
}
