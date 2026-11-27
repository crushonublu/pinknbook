import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useMobileDismiss } from "../mobile/back";
import { STR, type Lang } from "../i18n";
import { Icon } from "../icons";
import { isAndroid } from "../platform";
import { fmt, names } from "../stats/format";
import { useGenres } from "../stats/useGenres";
import type { StatsSummary, WrapDoc, WrapKind } from "../stats/types";
import { cardPng, copyPng, deliver } from "./exportImage";
import { CARD_H, CARD_W, pagesOf, type Format } from "./geometry";
import { raised, type Pose } from "./gestures";
import { iconFacts, relevantStickers, type StickerSpec } from "./iconRules";
import { autoStickers, layoutJson, newLayout, parseLayout, type Sticker, type WrapLayout } from "./layout";
import { THEMES, THEME_IDS, type ThemeId } from "./palettes";
import { mulberry32, seedFor } from "./shapes";
import { StickerEditor, typing } from "./StickerEditor";
import { StickerTray } from "./StickerTray";
import { ScaledCard, WrapCard } from "./WrapCard";
import { exportError } from "./exportError";
import { wrapTitle } from "./wording";
import "./wrap.css";

const THEME_NAME = { wine: "wrThemeWine", forest: "wrThemeForest", night: "wrThemeNight", paper: "wrThemePaper", sunset: "wrThemeSunset", ocean: "wrThemeOcean" } as const;

/** How long the layout waits for the next change before it is saved, and how long a notice stays. */
const SAVE_DELAY_MS = 500;
const NOTICE_MS = 3500;
/** Repeated key presses on the same sticker within this time are one change to undo. */
const COALESCE_MS = 800;
/** A sticker added from the tray starts at this size, in the middle of the card. */
const NEW_STICKER_SCALE = 0.6;

/** Loads a wrap (`wrap_get`): the saved numbers, or live ones for a period that is not over. */
function useWrapDoc(kind: WrapKind, periodStart: string) {
  const [state, setState] = useState<{ doc: WrapDoc | null; failed: boolean }>({ doc: null, failed: false });
  useEffect(() => {
    let stale = false;
    setState({ doc: null, failed: false });
    invoke<WrapDoc>("wrap_get", { kind, periodStart })
      .then((doc) => !stale && setState({ doc, failed: false }))
      .catch((e) => {
        console.error(e);
        if (!stale) setState({ doc: null, failed: true });
      });
    return () => {
      stale = true;
    };
  }, [kind, periodStart]);
  return state;
}

/** Fits a card to the room its box has: the scale that shows all of it. */
function useFit(format: Format) {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.3);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const { width, height } = el.getBoundingClientRect();
      if (width > 0 && height > 0) setScale(Math.min(width / CARD_W, height / CARD_H[format]));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [format]);
  return { ref, scale };
}

/**
 * The layout of a wrap as the reader edits it: what is on screen at once, the
 * save a moment after the last change (and when the viewer closes), and a single
 * step back. `change` is one step to undo; `live` is the stream of a gesture,
 * which `remember` marks the start of.
 */
function useLayoutState(kind: WrapKind, periodStart: string) {
  const [layout, setLayout] = useState<WrapLayout | null>(null);
  const [undo, setUndo] = useState<WrapLayout | null>(null);
  const current = useRef<WrapLayout | null>(null);
  const pending = useRef<{ kind: WrapKind; periodStart: string; layout: WrapLayout } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const lastKey = useRef({ key: "", at: 0 });

  const flush = useCallback(() => {
    window.clearTimeout(timer.current);
    const p = pending.current;
    pending.current = null;
    if (p) invoke("wrap_save_layout", { kind: p.kind, periodStart: p.periodStart, layoutJson: layoutJson(p.layout), seed: p.layout.reroll }).catch(console.error);
  }, []);
  // Another wrap, or closing: nothing is left unsaved.
  useEffect(() => flush, [kind, periodStart, flush]);

  /** Shows a layout and schedules its save. */
  const live = useCallback(
    (next: WrapLayout) => {
      current.current = next;
      setLayout(next);
      pending.current = { kind, periodStart, layout: next };
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(flush, SAVE_DELAY_MS);
    },
    [kind, periodStart, flush],
  );
  /** The layout as it is now becomes the one `back` returns to; calls with the same `key` close together are one step. */
  const remember = useCallback((key = "") => {
    const now = performance.now();
    const last = lastKey.current;
    lastKey.current = { key, at: now };
    if (key && key === last.key && now - last.at < COALESCE_MS) return;
    setUndo(current.current);
  }, []);
  const change = useCallback((next: WrapLayout) => {
    remember();
    live(next);
  }, [remember, live]);
  const back = useCallback(() => {
    if (!undo) return null;
    live(undo);
    setUndo(null);
    return undo;
  }, [undo, live]);
  /** A freshly loaded layout: nothing to undo, nothing to save. */
  const load = useCallback((next: WrapLayout) => {
    window.clearTimeout(timer.current);
    pending.current = null;
    current.current = next;
    setLayout(next);
    setUndo(null);
  }, []);
  return { layout, current, canUndo: undo !== null, change, live, remember, back, load };
}

/**
 * A wrap-up card: the week, the month or the year (six pages) at full screen on
 * Android and in a window over the library on the desktop. The reader picks the
 * card's colour, rerolls the background, chooses the story or post format and
 * arranges the stickers (move, turn, scale, add, remove, arrange again); every
 * choice is saved with the wrap. The picture can be saved, shared (Android) or
 * copied (desktop).
 */
export function WrapViewer({ lang, kind, periodStart, summary, onClose }: {
  lang: Lang;
  kind: WrapKind;
  /** First day of the period. */
  periodStart: string;
  summary: StatsSummary | null;
  onClose: () => void;
}) {
  const t = STR[lang];
  const { doc, failed } = useWrapDoc(kind, periodStart);
  const genres = useGenres(lang);
  const { layout, current, canUndo, change, live, remember, back, load } = useLayoutState(kind, periodStart);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [trayOpen, setTrayOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean; detail?: string } | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);
  // Back (Android) and Escape close the tray first, then deselect, then the viewer.
  useMobileDismiss(true, () => (trayOpen ? setTrayOpen(false) : selected ? setSelected(null) : onClose()), true);
  useEffect(() => closeBtn.current?.focus(), []);
  useEffect(() => {
    if (!notice) return;
    const id = window.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => window.clearTimeout(id);
  }, [notice]);

  const badges = useMemo(() => summary?.badges.map((b) => ({ id: b.id, tier: b.tier })) ?? [], [summary]);
  const facts = useMemo(() => (doc ? iconFacts(doc.stats, badges) : null), [doc, badges]);
  // The saved arrangement, or the one the rules make (the same every time for a finished period).
  // Only a newly loaded wrap sets it: later changes are in `layout` and saved.
  const latest = useRef(facts);
  latest.current = facts;
  useEffect(() => {
    if (!doc || !latest.current) return;
    load(parseLayout(doc.layout_json, kind) ?? newLayout(kind, periodStart, latest.current, { reroll: doc.seed }));
    setPage(0);
    setSelected(null);
  }, [doc, kind, periodStart, load]);
  useEffect(() => setSelected(null), [page]);

  const format = layout?.format ?? "story";
  const { ref: stage, scale } = useFit(format);
  const pages = pagesOf(kind);
  const pageNames = names(t.wrYearPages);
  const go = (to: number) => setPage(Math.min(pages - 1, Math.max(0, to)));
  useEffect(() => {
    // With a sticker selected the arrows nudge it instead (StickerEditor).
    if (pages < 2 || selected) return;
    const onKey = (e: KeyboardEvent) => {
      if (typing(e)) return;
      if (e.key === "ArrowLeft") setPage((p) => Math.max(0, p - 1));
      if (e.key === "ArrowRight") setPage((p) => Math.min(pages - 1, p + 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pages, selected]);

  const title = wrapTitle(lang, kind);
  const setTheme = (theme: ThemeId) => layout && change({ ...layout, theme });
  const reroll = () => layout && change({ ...layout, reroll: layout.reroll + 1, seed: seedFor(kind, periodStart, layout.reroll + 1) });
  /** The stickers the rules place for a format: the same ones every time. */
  const arranged = (f: Format): Sticker[] => (facts ? autoStickers(kind, f, facts, mulberry32(seedFor(kind, periodStart, 0) ^ 0x9e3779b9)) : []);
  // Another format has another height: the stickers are placed again for it.
  const setFormat = (f: Format) => layout && facts && f !== layout.format && change({ ...layout, format: f, stickers: arranged(f) });
  const autoArrange = () => {
    if (!layout) return;
    change({ ...layout, stickers: arranged(layout.format) });
    setSelected(null);
  };

  // ---- Stickers ----
  const select = useCallback(
    (id: string | null) => {
      setSelected(id);
      const l = current.current;
      if (!id || !l) return;
      const stickers = raised(l.stickers, id);
      if (stickers !== l.stickers) live({ ...l, stickers });
    },
    [current, live],
  );
  const restyle = useCallback(
    (id: string, pose: Pose) => {
      const l = current.current;
      if (l) live({ ...l, stickers: l.stickers.map((s) => (s.id === id ? { ...s, ...pose } : s)) });
    },
    [current, live],
  );
  const remove = useCallback(
    (id: string) => {
      const l = current.current;
      if (!l) return;
      change({ ...l, stickers: l.stickers.filter((s) => s.id !== id) });
      setSelected(null);
    },
    [current, change],
  );
  const add = (spec: StickerSpec) => {
    if (!layout) return;
    const z = Math.max(0, ...layout.stickers.map((s) => s.z)) + 1;
    const sticker: Sticker = { id: `u${Date.now().toString(36)}`, kind: spec.kind, ref: spec.ref, x: CARD_W / 2, y: CARD_H[layout.format] / 2, scale: NEW_STICKER_SCALE, rotate: 0, z, ...(page ? { page } : {}) };
    change({ ...layout, stickers: [...layout.stickers, sticker] });
    setSelected(sticker.id);
    setTrayOpen(false);
  };
  const undo = () => {
    const before = back();
    if (before && !before.stickers.some((s) => s.id === selected)) setSelected(null);
  };
  const shown = layout ? layout.stickers.filter((s) => (s.page ?? 0) === page) : [];
  const relevant = useMemo(() => (facts ? relevantStickers(facts) : []), [facts]);
  const owned = useMemo(() => summary?.badges.filter((b) => b.tier > 0).map((b) => b.id) ?? [], [summary]);

  // ---- The picture ----
  const say = (text: string, error = false, detail?: string) => setNotice({ text, error, detail });
  const makePicture = async (action: "save" | "share" | "copy") => {
    const el = card.current;
    if (!el || !layout || busy) return;
    setBusy(true);
    try {
      const png = cardPng(el, CARD_W, CARD_H[layout.format]);
      if (action === "copy") {
        await copyPng(png);
        say(t.wrCopied);
      } else {
        const name = `pntome-${kind}-${periodStart}${kind === "year" ? `-${page + 1}` : ""}-${layout.format}.png`;
        const result = await deliver(await png, name, action);
        if (result.done && action === "save") say(isAndroid ? t.wrSavedPhotos : t.wrSavedFile);
      }
    } catch (e) {
      console.error(e);
      const failure = exportError(lang, e);
      say(failure.text, true, failure.detail);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wv" role="dialog" aria-modal="true" aria-label={title}>
      <div className="wv__panel">
        <header className="wv__head">
          <button ref={closeBtn} className="wv__round" onClick={onClose} aria-label={t.wrClose}><Icon name="close" size={18} /></button>
          <h1>{title}</h1>
          {doc?.preview && <span className="wv__tag">{t.wrPreview}</span>}
          <div className="wv__edit">
            <button className="wv__round" onClick={undo} disabled={!canUndo} aria-label={t.wrUndo} title={t.wrUndo}><Icon name="reset" size={18} /></button>
            <button className="wv__round" onClick={() => selected && remove(selected)} disabled={!selected} aria-label={t.wrRemoveSticker} title={t.wrRemoveSticker}><Icon name="trash" size={18} /></button>
          </div>
        </header>

        <div className="wv__stage" ref={stage}>
          {layout && doc ? (
            <ScaledCard format={format} scale={scale}>
              <WrapCard cardRef={card} lang={lang} doc={doc} layout={layout} page={page} genreName={genres.name} badges={summary?.badges ?? []} />
              <StickerEditor lang={lang} scale={scale} stickers={shown} format={format} selected={selected} onSelect={select} onBegin={remember} onChange={restyle} onRemove={remove} />
            </ScaledCard>
          ) : (
            <p className="muted center">{failed ? t.wrLoadFailed : t.loading}</p>
          )}
          {notice && <div className={`wv__notice${notice.error ? " is-error" : ""}`} role={notice.error ? "alert" : "status"}>{notice.text}{notice.detail && <small>{notice.detail}</small>}</div>}
        </div>

        {pages > 1 && (
          <div className="wv__pages">
            <button className="wv__round" onClick={() => go(page - 1)} disabled={page === 0} aria-label={t.wrPrevPage}><Icon name="arrowL" size={18} /></button>
            <div role="group" aria-label={t.wrPages}>
              {Array.from({ length: pages }, (_, i) => (
                <button key={i} className="wv__dot" aria-pressed={i === page} aria-label={fmt(t.wrPageN, i + 1, pages, pageNames[i])} onClick={() => go(i)} />
              ))}
            </div>
            <button className="wv__round" onClick={() => go(page + 1)} disabled={page === pages - 1} aria-label={t.wrNextPage}><Icon name="arrowR" size={18} /></button>
          </div>
        )}

        <div className="wv__side">
          <div className="wv__swatches" role="group" aria-label={t.wrSwatches}>
            {THEME_IDS.map((id) => (
              <button
                key={id}
                className="wv__swatch"
                style={{ background: THEMES[id].bg, ["--ring" as string]: THEMES[id].hi }}
                aria-label={t[THEME_NAME[id]]}
                title={t[THEME_NAME[id]]}
                aria-pressed={layout?.theme === id}
                onClick={() => setTheme(id)}
                disabled={!layout}
              />
            ))}
          </div>
          <div className="wv__row">
            <button className="wv__btn" onClick={reroll} disabled={!layout}><Icon name="refresh" size={17} />{t.wrReroll}</button>
            <div className="wv__seg" role="group" aria-label={t.wrFormat}>
              {(["story", "post"] as const).map((f) => (
                <button key={f} aria-pressed={format === f} onClick={() => setFormat(f)} disabled={!layout}>{f === "story" ? t.wrFormatStory : t.wrFormatPost}</button>
              ))}
            </div>
          </div>
          <div className="wv__row wv__row--tools">
            <button className="wv__btn" onClick={() => setTrayOpen(true)} disabled={!layout} aria-haspopup="dialog"><Icon name="plus" size={17} />{t.wrAddSticker}</button>
            <button className="wv__btn" onClick={autoArrange} disabled={!layout}><Icon name="sparkle" size={17} />{t.wrAutoLayout}</button>
          </div>
          <div className="wv__row wv__row--actions">
            <button className="wv__btn" onClick={() => makePicture("save")} disabled={!layout || busy} aria-busy={busy}><Icon name="image" size={17} />{busy ? t.wrExporting : t.wrSave}</button>
            {isAndroid ? (
              <button className="wv__btn wv__btn--primary" onClick={() => makePicture("share")} disabled={!layout || busy}><Icon name="upload" size={17} />{t.wrShare}</button>
            ) : (
              <button className="wv__btn wv__btn--primary" onClick={() => makePicture("copy")} disabled={!layout || busy}><Icon name="copy" size={17} />{t.wrCopy}</button>
            )}
          </div>
        </div>

        {trayOpen && <StickerTray lang={lang} relevant={relevant} badges={owned} onPick={add} onClose={() => setTrayOpen(false)} />}
      </div>
    </div>
  );
}
