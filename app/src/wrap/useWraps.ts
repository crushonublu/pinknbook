import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { WrapSummary } from "../stats/types";

export const wrapKey = (w: Pick<WrapSummary, "kind" | "period_start">) => `${w.kind}:${w.period_start}`;

/**
 * The wrap-ups on offer (`wraps_pending`: not opened or dismissed yet) and the
 * saved ones (`wraps_list`), fetched again whenever `refreshKey` changes (pass
 * the stats summary, replaced after every reading session). `open` and
 * `markSeen` tells the backend the reader has seen (opened or dismissed) the
 * wrap, and takes it off the offers at once; `remove` deletes a saved wrap.
 */
export function useWraps(refreshKey: unknown) {
  const [pending, setPending] = useState<WrapSummary[]>([]);
  const [saved, setSaved] = useState<WrapSummary[]>([]);

  const refresh = useCallback(async () => {
    try {
      const [p, s] = await Promise.all([invoke<WrapSummary[]>("wraps_pending"), invoke<WrapSummary[]>("wraps_list")]);
      setPending(p);
      setSaved(s);
    } catch (e) {
      console.error(e);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);

  const markSeen = useCallback(
    (w: WrapSummary) => {
      setPending((list) => list.filter((x) => wrapKey(x) !== wrapKey(w)));
      invoke("wrap_mark_seen", { kind: w.kind, periodStart: w.period_start }).then(refresh, console.error);
    },
    [refresh],
  );

  const remove = useCallback(
    (w: WrapSummary) => {
      setPending((list) => list.filter((x) => wrapKey(x) !== wrapKey(w)));
      setSaved((list) => list.filter((x) => wrapKey(x) !== wrapKey(w)));
      invoke("wrap_delete", { kind: w.kind, periodStart: w.period_start }).then(refresh, (e) => {
        console.error(e);
        void refresh();
      });
    },
    [refresh],
  );

  /** Everything that can be opened: the offers (previews included), then the saved wraps, each once. */
  const all = [...pending, ...saved.filter((s) => !pending.some((p) => wrapKey(p) === wrapKey(s)))];
  return { pending, saved, all, refresh, markSeen, remove };
}
