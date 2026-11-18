import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { STR, type Lang } from "./i18n";
import { Icon } from "./icons";
import {
  canSpeak,
  firstTab,
  hasVietnameseMarks,
  lookup,
  safeFragment,
  speak,
  wikipediaSummary,
  wiktionaryHtml,
  type DictEntry,
  type DictLookup,
  type DictTab,
  type WikiSummary,
} from "./dictionary";

/** What the reader asks the dictionary for. */
export interface DictRequest {
  rect: DOMRect;
  candidates: string[];
  /** The sentence around the word (saved with it). */
  context: string;
  bookLang: string;
  asin: string;
  cfi: string | null;
  fraction: number | null;
}

type Install = { phase: "idle" | "download" | "build" | "done" | "error"; file?: string; done?: number; total?: number; message?: string };

const BAR_H = 44;
const GAP = 10;

/** Place the card on the side of the selection the highlight bar is not on. */
function usePlacement(anchor: DOMRect, deps: unknown[]) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const left = Math.max(8, Math.min(vw - w - 8, anchor.left + anchor.width / 2 - w / 2));
    const barBelow = anchor.top - BAR_H - GAP < 56;
    let top: number;
    if (!barBelow) {
      top = anchor.bottom + GAP;
      if (top + h > vh - 8) top = Math.max(56, anchor.top - GAP - BAR_H - 8 - h);
    } else {
      top = Math.min(vh - h - 8, anchor.bottom + GAP + BAR_H + 8);
    }
    setPos({ left, top: Math.max(8, top) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor.left, anchor.top, anchor.bottom, ...deps]);
  return { ref, pos };
}

/** Dictionary card shown next to a selected word. */
export function DictPopup({
  lang,
  req,
  onClose,
  onSaved,
}: {
  lang: Lang;
  req: DictRequest;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const t = STR[lang];
  const [res, setRes] = useState<DictLookup | null>(null);
  const [tab, setTab] = useState<DictTab>("vi");
  const [install, setInstall] = useState<Install>({ phase: "idle" });
  const [later, setLater] = useState(false);
  const [parts, setParts] = useState<DictLookup[] | null>(null);
  const [wikt, setWikt] = useState<{ state: "idle" | "busy" | "none" | "fail" | "ok"; frag?: DocumentFragment; url?: string }>({ state: "idle" });
  const [wiki, setWiki] = useState<{ state: "idle" | "busy" | "none" | "fail" | "ok"; data?: WikiSummary }>({ state: "idle" });
  const [saved, setSaved] = useState(false);
  const wiktBody = useRef<HTMLDivElement>(null);
  const preferVi = req.bookLang.toLowerCase().startsWith("vi");

  const run = () =>
    lookup(req.candidates)
      .then((r) => {
        setRes(r);
        setTab(r.missing ? (later ? "wikt" : "vi") : firstTab(r, req.bookLang));
      })
      .catch(() => setRes({ word: req.candidates[req.candidates.length - 1] ?? "", vi: [], envi: [], enen: [], missing: true }));

  useEffect(() => {
    setRes(null);
    setParts(null);
    setSaved(false);
    setWikt({ state: "idle" });
    setWiki({ state: "idle" });
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req.candidates.join("|")]);

  // Install progress (the download may already be running from another popup).
  useEffect(() => {
    let off: (() => void) | undefined;
    listen<Install>("dict-progress", (e) => {
      setInstall(e.payload);
      if (e.payload.phase === "done") run();
    }).then((u) => (off = u));
    invoke<{ ready: boolean; installing: boolean }>("dict_status")
      .then((s) => s.installing && setInstall({ phase: "download" }))
      .catch(() => undefined);
    return () => off?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const word = res?.word ?? "";

  // Online tabs load when first opened.
  useEffect(() => {
    if (!word) return;
    if (tab === "wikt" && wikt.state === "idle") {
      setWikt({ state: "busy" });
      wiktionaryHtml(word)
        .then((p) => setWikt(p ? { state: "ok", frag: safeFragment(p.html), url: p.url } : { state: "none" }))
        .catch(() => setWikt({ state: "fail" }));
    }
    if (tab === "wiki" && wiki.state === "idle") {
      setWiki({ state: "busy" });
      wikipediaSummary(word, preferVi)
        .then((d) => setWiki(d ? { state: "ok", data: d } : { state: "none" }))
        .catch(() => setWiki({ state: "fail" }));
    }
  }, [tab, word, wikt.state, wiki.state, preferVi]);
  useEffect(() => {
    if (tab === "wikt" && wikt.frag && wiktBody.current) wiktBody.current.replaceChildren(wikt.frag.cloneNode(true));
  }, [tab, wikt.frag]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [onClose]);

  const { ref, pos } = usePlacement(req.rect, [res, tab, install.phase, wikt.state, wiki.state, parts]);

  const entries: DictEntry[] = res && (tab === "vi" || tab === "envi" || tab === "enen") ? res[tab] : [];
  const wordLang: "vi" | "en" = tab === "vi" || (tab !== "envi" && tab !== "enen" && (hasVietnameseMarks(word) || preferVi)) ? "vi" : "en";
  const syllables = word.split(/\s+/).filter(Boolean);
  const tabs: { id: DictTab; label: string }[] = [
    ...(res && !res.missing
      ? ([
          res.vi.length ? { id: "vi", label: t.dcViVi } : null,
          res.envi.length ? { id: "envi", label: t.dcEnVi } : null,
          res.enen.length ? { id: "enen", label: t.dcEnEn } : null,
        ].filter(Boolean) as { id: DictTab; label: string }[])
      : res?.missing && !later
        ? [{ id: "vi" as DictTab, label: t.dcLookup }]
        : []),
    { id: "wikt", label: t.dcWiktionary },
    { id: "wiki", label: t.dcWikipedia },
  ];

  const save = async () => {
    const gloss = entries[0]?.body.senses[0]?.g[0] ?? wiki.data?.extract?.split(". ")[0] ?? null;
    try {
      await invoke("vocab_add", {
        word,
        lang: wordLang,
        gloss,
        asin: req.asin,
        cfi: req.cfi,
        fraction: req.fraction,
        context: req.context,
      });
      setSaved(true);
      onSaved?.();
    } catch (e) {
      console.error(e);
    }
  };

  const openSource = () => {
    const url =
      tab === "wiki"
        ? wiki.data?.url
        : tab === "enen"
          ? `https://en-word.net/lemma/${encodeURIComponent(word)}`
          : wikt.url ?? `https://${tab === "envi" || tab === "vi" ? "vi" : "en"}.wiktionary.org/wiki/${encodeURIComponent(word)}`;
    if (url) openUrl(url).catch(() => undefined);
  };

  const showSetup = res?.missing && !later && (tab === "vi" || tab === "envi" || tab === "enen");
  const pct = install.total ? Math.round(((install.done ?? 0) / install.total) * 100) : 0;
  const mb = (n?: number) => `${((n ?? 0) / 1048576).toFixed(1)} MB`;

  return (
    <div
      ref={ref}
      className="dict"
      style={pos ? { left: pos.left, top: pos.top } : { visibility: "hidden" }}
      role="dialog"
      aria-label={t.dcLookup}
      onPointerDown={(e) => e.preventDefault() /* keep the selection */}
    >
      <div className="dict__head">
        <div className="dict__word">
          <span className="dict__hw">{word || req.candidates[req.candidates.length - 1]}</span>
          {entries[0]?.body.ipa && <span className="dict__ipa">/{entries[0].body.ipa}/</span>}
        </div>
        <div className="dict__tools">
          {canSpeak(wordLang) && (
            <button onClick={() => speak(word, wordLang)} aria-label={t.dcSpeak} title={t.dcSpeak}>
              <Icon name="speaker" size={16} />
            </button>
          )}
          <button
            onClick={save}
            className={saved ? "is-on" : undefined}
            disabled={!word}
            aria-label={saved ? t.dcSaved : t.dcSave}
            title={saved ? t.dcSaved : t.dcSave}
          >
            <Icon name={saved ? "checkRead" : "saveWord"} size={16} />
          </button>
          <button onClick={openSource} disabled={!word} aria-label={t.dcOpen} title={t.dcOpen}>
            <Icon name="external" size={16} />
          </button>
          <button onClick={onClose} aria-label={t.closeReader} title={t.closeReader}>
            <Icon name="close" size={16} />
          </button>
        </div>
      </div>

      <div className="dict__tabs" role="tablist">
        {tabs.map((x) => (
          <button key={x.id} role="tab" aria-selected={tab === x.id} className={tab === x.id ? "is-on" : ""} onClick={() => setTab(x.id)}>
            {x.label}
          </button>
        ))}
      </div>

      <div className="dict__body">
        {!res && <p className="dict__muted">{t.dcLoading}</p>}

        {showSetup && (
          <div className="dict__setup">
            <b>{t.dcSetupTitle}</b>
            <p>{t.dcSetupBody}</p>
            {install.phase === "download" || install.phase === "build" ? (
              <>
                <div className="dict__bar">
                  <i style={{ width: `${pct}%` }} />
                </div>
                <p className="dict__muted">
                  {install.phase === "download"
                    ? t.dcSetupPhase_download.replace("{0}", install.file ?? "").replace("{1}", install.total ? `${mb(install.done)} / ${mb(install.total)}` : "")
                    : t.dcSetupPhase_build.replace("{0}", `${pct}%`)}
                </p>
              </>
            ) : (
              <>
                {install.phase === "error" && <p className="dict__err">{t.dcSetupFail.replace("{0}", install.message ?? "")}</p>}
                <div className="dict__actions">
                  <button
                    className="btn btn--primary"
                    onClick={() => {
                      setInstall({ phase: "download", file: "Wiktionary" });
                      invoke("dict_install").catch(() => undefined);
                    }}
                  >
                    {t.dcSetupStart}
                  </button>
                  <button
                    className="btn"
                    onClick={() => {
                      setLater(true);
                      setTab("wikt");
                    }}
                  >
                    {t.dcSetupLater}
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {res && !res.missing && (tab === "vi" || tab === "envi" || tab === "enen") && (
          <>
            {tab === "vi" && syllables.length > 1 && (
              <div className="dict__parts">
                <button
                  className={parts ? "" : "is-on"}
                  onClick={() => setParts(null)}
                >
                  {t.dcWhole}
                </button>
                <button
                  className={parts ? "is-on" : ""}
                  onClick={() => Promise.all(syllables.map((s) => lookup([s]))).then(setParts).catch(() => undefined)}
                >
                  {t.dcSyllables}
                </button>
              </div>
            )}
            {parts && tab === "vi" ? (
              parts.map((p, i) => (
                <div key={i} className="dict__part">
                  <h4>{syllables[i]}</h4>
                  {p.vi.length ? <Entries list={p.vi} max={2} /> : <p className="dict__muted">{t.dcNotFound.replace("{0}", syllables[i])}</p>}
                </div>
              ))
            ) : entries.length ? (
              <Entries list={entries} />
            ) : (
              <p className="dict__muted">{t.dcNotFound.replace("{0}", word)}</p>
            )}
          </>
        )}

        {tab === "wikt" &&
          (wikt.state === "busy" || wikt.state === "idle" ? (
            <p className="dict__muted">{t.dcLoading}</p>
          ) : wikt.state === "ok" ? (
            <div className="dict__html" ref={wiktBody} />
          ) : (
            <p className="dict__muted">{wikt.state === "fail" ? t.dcOffline : t.dcNotFound.replace("{0}", word)}</p>
          ))}

        {tab === "wiki" &&
          (wiki.state === "busy" || wiki.state === "idle" ? (
            <p className="dict__muted">{t.dcLoading}</p>
          ) : wiki.state === "ok" && wiki.data ? (
            <div className="dict__wiki">
              <h4>{wiki.data.title}</h4>
              <p>{wiki.data.extract}</p>
            </div>
          ) : (
            <p className="dict__muted">{wiki.state === "fail" ? t.dcOffline : t.dcNotFound.replace("{0}", word)}</p>
          ))}
      </div>

      <div className="dict__foot">
        {t.dcSource.replace(
          "{0}",
          tab === "enen" ? "Open English WordNet (CC BY 4.0)" : tab === "wiki" ? "Wikipedia (CC BY-SA)" : "Wiktionary (CC BY-SA)",
        )}
      </div>
    </div>
  );
}

function Entries({ list, max = 6 }: { list: DictEntry[]; max?: number }) {
  return (
    <>
      {list.slice(0, max).map((e, i) => (
        <div key={i} className="dict__entry">
          {(e.body.pos || (i > 0 && e.word !== list[0].word)) && (
            <div className="dict__pos">
              {e.word !== list[0].word && <b>{e.word}</b>}
              {e.body.pos}
            </div>
          )}
          <ol className="dict__senses">
            {e.body.senses.map((s, k) => (
              <li key={k}>
                <span>{s.g.join("; ")}</span>
                {s.ex?.map((x, j) => (
                  <span key={j} className="dict__ex">
                    {x[0]}
                    {x[1] && <span className="dict__tr"> — {x[1]}</span>}
                  </span>
                ))}
                {s.syn && s.syn.length > 0 && <span className="dict__syn">≈ {s.syn.join(", ")}</span>}
              </li>
            ))}
          </ol>
        </div>
      ))}
    </>
  );
}
