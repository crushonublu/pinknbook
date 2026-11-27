import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { STR, type Lang } from "../i18n";
import { fmt } from "./format";
import { profileFacts, profileSentence } from "./profile";
import type { PeriodStats, StatsSummary } from "./types";

type Provider = "anthropic" | "deepseek";

/** An AI rewrite kept for a period: the text, the facts it was written from and what the reader said of it. */
interface Rewrite {
  text: string;
  facts: string;
  verdict: "good" | "bad" | null;
}

const storeKey = (p: PeriodStats) => `pntome.profile-ai.${p.kind}.${p.start}`;

function loadRewrite(p: PeriodStats, facts: string): Rewrite | null {
  try {
    const r = JSON.parse(localStorage.getItem(storeKey(p)) ?? "null") as Rewrite | null;
    // Numbers that have changed since make the sentence untrue: drop it.
    return r && r.facts === facts ? r : null;
  } catch {
    return null;
  }
}

function saveRewrite(p: PeriodStats, r: Rewrite | null) {
  try {
    if (r) localStorage.setItem(storeKey(p), JSON.stringify(r));
    else localStorage.removeItem(storeKey(p));
  } catch {
    // Without storage the choice only lasts until the page is left.
  }
}

/** The provider to ask, when the reader has configured an AI key (Claude first). */
function useAiProvider(): Provider | null {
  const [provider, setProvider] = useState<Provider | null>(null);
  useEffect(() => {
    invoke<{ anthropic: string | null; deepseek: string | null }>("ai_key_status")
      .then((k) => setProvider(k.anthropic ? "anthropic" : k.deepseek ? "deepseek" : null))
      .catch(() => setProvider(null));
  }, []);
  return provider;
}

/**
 * "Reading profile": one or two sentences written from the facts of the
 * period by fixed rules (offline), three numbers, and, when an AI key is
 * set, a button that has the AI word it again. The reader can keep or reject
 * the AI's version; rejecting goes back to the rule sentence.
 */
export function ProfileCard({ lang, p, s, genreName, wide = false }: {
  lang: Lang;
  p: PeriodStats;
  s: StatsSummary;
  genreName: (id: string) => string | undefined;
  /** Room for a fourth number (highlights): the desktop page. */
  wide?: boolean;
}) {
  const t = STR[lang];
  const provider = useAiProvider();
  const all = p.kind === "all";
  const parts = useMemo(() => profileSentence(p.persona, lang, { kind: p.kind, genreName }), [p.persona, p.kind, lang, genreName]);
  const facts = useMemo(() => JSON.stringify({ lang, ...profileFacts(p.persona, p.kind, genreName) }), [p.persona, p.kind, lang, genreName]);

  const [rewrite, setRewrite] = useState<Rewrite | null>(() => loadRewrite(p, facts));
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  // Another period or language has its own saved rewrite.
  useEffect(() => {
    setRewrite(loadRewrite(p, facts));
    setFailed(false);
  }, [p.kind, p.start, facts]);

  async function ask() {
    if (!provider) return;
    setBusy(true);
    setFailed(false);
    try {
      const text = await invoke<string>("stats_profile_ai", { provider, factsJson: facts, lang });
      const next: Rewrite = { text, facts, verdict: null };
      setRewrite(next);
      saveRewrite(p, next);
    } catch (e) {
      console.error(e);
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }
  function judge(verdict: "good" | "bad") {
    if (!rewrite) return;
    const next = { ...rewrite, verdict };
    setRewrite(next);
    saveRewrite(p, next);
  }

  const useAi = rewrite !== null && rewrite.verdict !== "bad";
  const hours = p.total_sec / 3600;
  const books = all ? s.books_finished : p.finished.length;
  const streak = all ? s.streak.longest : p.streak_best_in_period;

  return (
    <section className="scx scx-profile scard-theme--wine">
      <div className="scx__row">
        <span className="scx-profile__kicker">{all ? t.sxProfileAll : fmt(t.sxProfile, p.start.slice(0, 4))}</span>
      </div>

      {parts.length === 0 ? (
        <p className="scx-profile__text">{t.sxProfileEmpty}</p>
      ) : useAi ? (
        <p className="scx-profile__text">{rewrite.text}</p>
      ) : (
        <p className="scx-profile__text">
          {parts.map((x, i) => (x.em ? <em key={i}>{x.text}</em> : <span key={i}>{x.text}</span>))}
        </p>
      )}

      {provider && parts.length > 0 && (
        <div className="scx-profile__ai">
          {useAi && <span className="scx-profile__tag">{t.sxAiTag}</span>}
          {useAi && rewrite.verdict === null && (
            <>
              <button onClick={() => judge("good")} aria-label={t.sxAiGood}>👍</button>
              <button onClick={() => judge("bad")} aria-label={t.sxAiBad}>👎</button>
            </>
          )}
          {!useAi && (
            <button className="scx__btn" onClick={ask} disabled={busy} aria-busy={busy}>{busy ? t.sxAiBusy : t.sxAiRewrite}</button>
          )}
          {failed && <span className="scx-profile__err" role="status">{t.sxAiFailed}</span>}
        </div>
      )}

      <div className="scx-profile__tiles">
        <div><b>{books}</b><span>{t.sxBooksRead}</span></div>
        <div><b>{streak}</b><span>{t.sxLongestDays}</span></div>
        <div><b>{hours >= 10 ? Math.round(hours) : Math.round(hours * 10) / 10}</b><span>{t.sxHoursRead}</span></div>
        {wide && <div><b>{p.highlights}</b><span>{t.pcMarksRead}</span></div>}
      </div>
    </section>
  );
}
