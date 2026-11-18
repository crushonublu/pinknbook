import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { STR, type Lang } from "./i18n";
import type { LibraryRow } from "./types";
import { PageCurl } from "./curl/PageCurl";
import { contentCSS, FONT_STACKS, loadPrefs, MARGIN_LAYOUT, resolveTheme, savePrefs, THEMES, type ReaderPrefs } from "./readerPrefs";
import { ReaderSettings } from "./ReaderSettings";
import { ReaderSidebar, type Bookmark, type NotesSync, type SidebarTab, type TocItem } from "./ReaderSidebar";
import { COLOR_HEX, drawHighlight, fractionOf, screenRect, type Annotation, type HighlightColor, type KindleRecord } from "./annotate";
import { HighlightBar, NoteEditor } from "./AnnotationPopup";
import { PREVIEW_SCALE, ScrubBar, type ScrubMark } from "./ScrubBar";
import { kindleToRange, rangeToKindle, sectionOfPos, supportsKindlePos } from "./kindlePos";
import { Icon } from "./icons";
import { drawSearchHit, searchBook, type SearchHit } from "./bookSearch";
import { EMPTY_SEARCH, SearchPanel, type SearchState } from "./SearchPanel";
import { DictPopup, type DictRequest } from "./DictPopup";
import { WordsPanel, type VocabItem } from "./Vocab";
import { entityAtPoint, formMap, goToMention, useXray, xrayCardContent, XRayPanel } from "./XRay";
import { XRayGraph } from "./XRayGraph";
import { isLookupSize, lookupCandidates, selectionContext, sentenceAround } from "./dictionary";
import { FootnotePopup, isNoteRef, loadFootnote, noteContent, type FootnotePeek } from "./Footnote";
import { WindowControls } from "./WindowControls";

interface ReaderStart {
  cfi: string | null;
  amazon_location: number | null;
  amazon_fraction: number | null;
}

interface Furthest {
  location: number;
  fraction: number | null;
  percent: number | null;
}

type SyncDialog =
  | { state: "checking" }
  | { state: "ask"; curFrac: number; farFrac: number }
  | { state: "already"; farFrac: number }
  | { state: "none" }
  | { state: "error" };

/**
 * Jump to the Amazon furthest-page-read point.
 *
 * The Kindle sidecar "location" is a position-map value, not a raw byte offset,
 * so `location / textLength` gives the correct reading FRACTION (verified: it
 * lands on the same content Kindle shows, and foliate's own % then matches
 * Kindle's). We navigate with `goToFraction`; an earlier attempt to map the
 * location to an exact `kindle:pos:` target landed at the wrong place (the
 * chapter start) and was dropped. Returns true if it navigated.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function jumpToAmazon(view: any, fraction: number | null) {
  if (fraction == null || fraction <= 0) return false;
  try {
    await view.goToFraction(fraction);
    return true;
  } catch {
    return false;
  }
}

/**
 * The total Kindle "locations" for the book, read from the KF8 `DATP` record
 * (Kindle's location↔position map) — exactly the "of Y" Kindle shows. Stored
 * per-book (u16 at the DATP record's offset 10), not a byte division; falls back
 * to textLength/150 when there is no DATP.
 */
interface LocMap {
  total: number;
}

function parseKindleLocations(buf: ArrayBuffer): LocMap | null {
  try {
    const dv = new DataView(buf);
    const bytes = new Uint8Array(buf);
    if (bytes.length < 82) return null;
    if (String.fromCharCode(...bytes.slice(60, 68)) !== "BOOKMOBI") return null;
    const nrec = dv.getUint16(76);
    const rec0 = dv.getUint32(78);
    const textLength = dv.getUint32(rec0 + 4);
    const legacy = textLength > 0 ? Math.round(textLength / 150) : 0;
    for (let i = 0; i < nrec; i++) {
      const off = dv.getUint32(78 + i * 8);
      if (
        bytes[off] === 0x44 && bytes[off + 1] === 0x41 &&
        bytes[off + 2] === 0x54 && bytes[off + 3] === 0x50 // "DATP"
      ) {
        const total = dv.getUint16(off + 10);
        if (total > 0) return { total };
      }
    }
    return legacy > 0 ? { total: legacy } : null;
  } catch {
    return null;
  }
}

/**
 * Current Kindle location for a reading fraction. We use fraction × total: the
 * reader's fraction tracks Kindle's own location-based progress closely (both
 * show the same %), so this stays consistent with the % and within ~0.5% of
 * Kindle. (A byte-offset → DATP position-map lookup was tried but was worse,
 * because foliate's fraction is layout-weighted, not a raw byte offset.)
 */
function locationAt(fraction: number, info: LocMap | null): number | null {
  if (!info) return null;
  return Math.round(fraction * info.total);
}

/**
 * Load the vendored foliate-js reader by injecting a module <script> tag.
 * Vite forbids importing files from /public via `import()`, but a <script>
 * tag referencing a public file is allowed and loads as a native ES module
 * (its own relative imports resolve against /foliate/ in dev and prod alike).
 */
let foliateReady: Promise<void> | null = null;
function loadFoliate(): Promise<void> {
  if (customElements.get("foliate-view")) return Promise.resolve();
  if (foliateReady) return foliateReady;
  foliateReady = new Promise<void>((resolve, reject) => {
    if (!document.getElementById("foliate-view-script")) {
      const s = document.createElement("script");
      s.type = "module";
      s.id = "foliate-view-script";
      s.src = "/foliate/view.js";
      s.onerror = () => {
        foliateReady = null;
        reject(new Error("failed to load /foliate/view.js"));
      };
      document.head.append(s);
    }
    const timeout = window.setTimeout(() => {
      foliateReady = null;
      reject(new Error("foliate-view did not register (timeout)"));
    }, 15000);
    customElements.whenDefined("foliate-view").then(() => {
      window.clearTimeout(timeout);
      resolve();
    });
  });
  return foliateReady;
}

/**
 * Ids of the bookmarks whose position lies inside `visible` (the range shown
 * on screen), so the bookmark button and ribbon reflect the current page
 * whatever the font size or layout.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function marksOnPage(view: any, marks: Bookmark[], visible: Range | null): number[] {
  if (!view || !visible || !marks.length) return [];
  const content = view.renderer?.getContents?.()?.[0];
  if (!content) return [];
  const out: number[] = [];
  for (const m of marks) {
    try {
      const { index, anchor } = view.resolveCFI(m.cfi);
      if (index !== content.index) continue;
      const r = anchor(content.doc);
      if (r && "startContainer" in r && visible.comparePoint(r.startContainer, r.startOffset) === 0) out.push(m.id);
    } catch {
      /* stale or foreign cfi */
    }
  }
  return out;
}

/** Paginator layout: margins, line length, one or two pages. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyLayout(view: any, p: ReaderPrefs) {
  const r = view?.renderer;
  if (!r) return;
  const m = MARGIN_LAYOUT[p.margins];
  r.setAttribute("margin", `${m.margin}px`);
  r.setAttribute("gap", m.gap);
  r.setAttribute("max-inline-size", `${m.inline}px`);
  r.setAttribute("max-column-count", p.spread ? "2" : "1");
}

/** No input for this long and the reader stops counting (and drops the wait). */
const IDLE_MS = 3 * 60_000;
const TICK_MS = 15_000;
const FLUSH_MS = 60_000;

export default function Reader({
  row,
  lang,
  theme,
  onClose,
  todaySec = 0,
  goalMin = 10,
  speed = 1500,
  onLogged,
  startAt,
}: {
  row: LibraryRow;
  lang: Lang;
  theme: "light" | "dark";
  onClose: () => void;
  /** Minutes already read today (from the stats), in seconds. */
  todaySec?: number;
  goalMin?: number;
  /** Kindle positions per minute, for "time left". */
  speed?: number;
  /** Called after a stretch of reading was saved. */
  onLogged?: () => void;
  /** Open at this place (a CFI) instead of the saved position. */
  startAt?: string | null;
}) {
  const t = STR[lang];
  const hostRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const viewRef = useRef<any>(null);
  const saveTimer = useRef<number | null>(null);
  const lastFractionRef = useRef(0);
  const curlRef = useRef<PageCurl | null>(null);

  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errMsg, setErrMsg] = useState("");
  const [fraction, setFraction] = useState(0);
  const [sync, setSync] = useState<SyncDialog | null>(null);
  const [locMap, setLocMap] = useState<LocMap | null>(null);
  const [prefs, setPrefs] = useState<ReaderPrefs>(loadPrefs);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const setPref = (patch: Partial<ReaderPrefs>) => setPrefs((p) => ({ ...p, ...patch }));
  const [showSettings, setShowSettings] = useState(false);
  const [chapter, setChapter] = useState<string | null>(null);
  const [toc, setToc] = useState<TocItem[]>([]);
  const [tocHref, setTocHref] = useState<string | null>(null);
  const [sidebar, setSidebar] = useState<SidebarTab | null>(null);
  const sidebarRef = useRef(sidebar);
  sidebarRef.current = sidebar;

  // ---- X-Ray --------------------------------------------------------------
  const [xrSel, setXrSel] = useState<string | null>(null);
  const [xrGraph, setXrGraph] = useState(false);

  // ---- Find in book -------------------------------------------------------
  const [search, setSearch] = useState<SearchState>(EMPTY_SEARCH);
  const searchRef = useRef(search);
  searchRef.current = search;
  const searchRun = useRef({ cancelled: false });
  /** First section of each TOC entry, for the chapter of a result. */
  const tocStarts = useRef<{ index: number; label: string }[]>([]);
  const [tocStartsVer, setTocStartsVer] = useState(0);
  const chapterOf = useMemo(() => {
    const starts = tocStarts.current;
    return (index: number) => {
      let label = "";
      for (const s of starts) {
        if (s.index > index) break;
        label = s.label;
      }
      return label;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tocStartsVer]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function buildTocStarts(view: any) {
    const flat: { href: string; label: string }[] = [];
    const walk = (items: TocItem[]) => {
      for (const it of items) {
        if (it.href) flat.push({ href: it.href, label: it.label?.trim() ?? "" });
        if (it.subitems) walk(it.subitems);
      }
    };
    walk(Array.isArray(view.book?.toc) ? view.book.toc : []);
    const out: { index: number; label: string }[] = [];
    for (const it of flat) {
      try {
        const r = await view.resolveNavigation(it.href);
        if (r && typeof r.index === "number") out.push({ index: r.index, label: it.label });
      } catch {
        /* unresolvable entry */
      }
    }
    out.sort((a, b) => a.index - b.index);
    tocStarts.current = out;
    setTocStartsVer((v) => v + 1);
  }

  /** Sections on screen now (only they can show marks). */
  const loadedSections = (): number[] =>
    (viewRef.current?.renderer?.getContents?.() ?? []).map((c: { index: number }) => c.index);

  /** Show (or with `remove`, take off) the result marks in loaded sections. */
  function paintHits(hits: SearchHit[], current: number, remove = false, only?: number) {
    const view = viewRef.current;
    if (!view) return;
    const loaded = new Set(only != null ? [only] : loadedSections());
    hits.forEach((h, i) => {
      if (!loaded.has(h.index)) return;
      const a = { value: h.cfi, search: true, current: i === current };
      (remove ? view.deleteAnnotation(a) : view.addAnnotation(a))?.catch?.(() => undefined);
    });
  }
  const paintedRef = useRef<SearchState | null>(null);
  useEffect(() => {
    const prev = paintedRef.current;
    const show = sidebar === "search" && search.hits.length > 0;
    if (prev && (!show || prev.hits !== search.hits)) {
      paintHits(prev.hits, -1, true);
      drawAll(); // a result may have sat on a highlight's exact place
    }
    if (show) paintHits(search.hits, search.current);
    paintedRef.current = show ? search : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sidebar, search.hits, search.current]);

  async function runSearch(q: string) {
    searchRun.current.cancelled = true;
    const signal = { cancelled: false };
    searchRun.current = signal;
    if (!q.trim()) {
      setSearch(EMPTY_SEARCH);
      return;
    }
    setSearch({ query: q, hits: [], running: true, progress: 0, current: -1 });
    let all: SearchHit[] = [];
    await searchBook(
      viewRef.current,
      q,
      (hits, progress) => {
        if (hits.length) all = all.concat(hits);
        const list = all;
        setSearch((s) => ({ ...s, hits: list, progress }));
      },
      signal,
    );
    if (signal.cancelled) return;
    setSearch((s) => ({ ...s, running: false, progress: 1 }));
  }

  function pickHit(i: number) {
    const hit = searchRef.current.hits[i];
    if (!hit) return;
    setSearch((s) => ({ ...s, current: i }));
    viewRef.current?.goTo(hit.cfi)?.catch?.(() => undefined);
  }
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  /** Bookmarks that fall on the page shown now. */
  const [pageMarks, setPageMarks] = useState<number[]>([]);
  /** Where the reader is: cfi + visible range, for bookmarking. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const locRef = useRef<{ cfi: string; fraction: number; range: Range | null; chapter: string | null } | null>(null);
  // Highlights and notes.
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const annRef = useRef<Annotation[]>([]);
  annRef.current = annotations;
  /** A fresh text selection in the book. */
  const [sel, setSel] = useState<{ range: Range; index: number; doc: Document; rect: DOMRect; dict?: DictRequest } | null>(null);
  const selRef = useRef(sel);
  selRef.current = sel;
  /** An existing highlight that was clicked. */
  const [active, setActive] = useState<{ ann: Annotation; rect: DOMRect } | null>(null);
  const [noteEdit, setNoteEdit] = useState<{ ann: Annotation; rect: DOMRect } | null>(null);
  const [notesSync, setNotesSync] = useState<NotesSync>({ state: "idle" });

  // ---- Footnote peek ------------------------------------------------------
  // Hovering a footnote mark shows the note's text; it stays open while the
  // pointer is on the mark or on the box.
  const [peek, setPeek] = useState<FootnotePeek | null>(null);
  /** What the peek is for: a footnote link, or a highlight's id. */
  const peekLink = useRef<unknown>(null);
  const peekTimer = useRef<number | null>(null);
  const hideTimer = useRef<number | null>(null);
  const noteCache = useRef(new WeakMap<Element, DocumentFragment | null>());
  const clearTimer = (t: { current: number | null }) => {
    if (t.current != null) window.clearTimeout(t.current);
    t.current = null;
  };
  const hidePeekSoon = () => {
    clearTimer(hideTimer);
    hideTimer.current = window.setTimeout(() => setPeek(null), 250);
  };
  const closePeek = () => {
    clearTimer(peekTimer);
    clearTimer(hideTimer);
    peekLink.current = null;
    setPeek(null);
  };
  const enterLink = (a: Element, index: number) => {
    clearTimer(hideTimer);
    if (peekLink.current === a) return;
    peekLink.current = a;
    clearTimer(peekTimer);
    peekTimer.current = window.setTimeout(async () => {
      let content = noteCache.current.get(a);
      if (content === undefined) {
        content = await loadFootnote(viewRef.current, index, a).catch(() => null);
        noteCache.current.set(a, content);
      }
      if (!content || peekLink.current !== a) return;
      const r = a.ownerDocument.createRange();
      r.selectNodeContents(a);
      const rect = screenRect(r);
      if (rect) setPeek({ rect, content });
    }, 300);
  };
  /** The pointer is over a highlight: show its note, if it has one. */
  const overHighlight = (doc: Document, x: number, y: number) => {
    const view = viewRef.current;
    const contents = view?.renderer?.getContents?.() ?? [];
    const overlayer = contents.find((c: { doc: Document }) => c.doc === doc)?.overlayer;
    const [value, range] = overlayer?.hitTest?.({ x, y }) ?? [];
    const ann = value ? annRef.current.find((a) => a.cfi === value && a.note?.trim()) : undefined;
    if (!ann) {
      if (typeof peekLink.current === "number") leaveLink(peekLink.current);
      return false;
    }
    clearTimer(hideTimer);
    if (peekLink.current === ann.id) return;
    peekLink.current = ann.id;
    clearTimer(peekTimer);
    peekTimer.current = window.setTimeout(() => {
      if (peekLink.current !== ann.id) return;
      const rect = range ? screenRect(range as Range) : null;
      if (!rect) return;
      setPeek({
        rect,
        content: noteContent(ann.note ?? ""),
        label: { text: t.hlNoteTitle, color: COLOR_HEX[ann.color as HighlightColor] ?? COLOR_HEX.yellow },
      });
    }, 300);
  };
  const leaveLink = (a: unknown) => {
    if (peekLink.current === a) peekLink.current = null;
    clearTimer(peekTimer);
    hidePeekSoon();
  };
  const [kindleCapable, setKindleCapable] = useState(false);
  const [bookFile, setBookFile] = useState<File | null>(null);
  const pushTimer = useRef<number | null>(null);

  // ---- Reading time -------------------------------------------------------
  // Seconds count while the window is shown and the reader is in use. Time
  // since the last input is held back ("pending") and only kept once the
  // reader does something again within IDLE_MS; otherwise it is dropped.
  const lastInput = useRef(Date.now());
  const pending = useRef(0);
  const committed = useRef(0);
  /** Progress made by reading (page turns), as a fraction of the book. */
  const progressAcc = useRef(0);
  const prevFrac = useRef<number | null>(null);
  const [sessionSec, setSessionSec] = useState(0);
  const onLoggedRef = useRef(onLogged);
  onLoggedRef.current = onLogged;
  const noteInput = () => {
    const now = Date.now();
    if (now - lastInput.current < IDLE_MS) {
      committed.current += pending.current;
      if (pending.current) setSessionSec((x) => x + pending.current);
    }
    pending.current = 0;
    lastInput.current = now;
  };
  const noteInputRef = useRef(noteInput);
  noteInputRef.current = noteInput;
  const flushReading = () => {
    const secs = Math.round(committed.current);
    if (secs < 5) return;
    committed.current = 0;
    // Saved seconds now come back through `todaySec`.
    setSessionSec((x) => Math.max(0, x - secs));
    const positions = Math.round(progressAcc.current * (row.text_length ?? 0));
    progressAcc.current = 0;
    invoke("log_reading", { asin: row.asin, seconds: secs, positions })
      .then(() => onLoggedRef.current?.())
      .catch(() => undefined);
  };
  const flushRef = useRef(flushReading);
  flushRef.current = flushReading;
  useEffect(() => {
    const input = () => noteInputRef.current();
    const evs = ["keydown", "pointerdown", "pointermove", "wheel"] as const;
    for (const e of evs) window.addEventListener(e, input, { passive: true });
    const tick = window.setInterval(() => {
      const shown = document.visibilityState === "visible" && document.hasFocus();
      if (shown && Date.now() - lastInput.current < IDLE_MS) pending.current += TICK_MS / 1000;
      else pending.current = 0;
    }, TICK_MS);
    const flush = window.setInterval(() => flushRef.current(), FLUSH_MS);
    return () => {
      for (const e of evs) window.removeEventListener(e, input);
      window.clearInterval(tick);
      window.clearInterval(flush);
      noteInputRef.current();
      flushRef.current();
    };
  }, []);
  const rTheme = resolveTheme(prefs, theme);
  const palette = THEMES[rTheme];

  // One-time open of the book.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const buf = await invoke<ArrayBuffer>("download_book", {
          asin: row.asin,
          cdeType: row.cde_type,
        });
        if (cancelled) return;
        setLocMap(parseKindleLocations(buf));

        // Load the vendored foliate-js reader (served statically from /foliate).
        await loadFoliate();
        if (cancelled || !hostRef.current) return;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const view: any = document.createElement("foliate-view");
        viewRef.current = view;
        view.style.width = "100%";
        view.style.height = "100%";
        hostRef.current.append(view);

        const file = new File([buf], `${row.asin}.azw3`);
        // Highlight hooks go on before open: sections load during it.
        view.addEventListener("load", (e: CustomEvent) => watchSelection(e.detail.doc, e.detail.index));
        view.addEventListener("draw-annotation", (e: CustomEvent) => {
          const { draw, annotation } = e.detail;
          if (annotation.search) {
            draw(drawSearchHit, {
              current: !!annotation.current,
              dark: THEMES[resolveTheme(prefsRef.current, theme)].dark,
            });
            return;
          }
          draw(drawHighlight, {
            color: COLOR_HEX[annotation.color as HighlightColor] ?? COLOR_HEX.yellow,
            note: !!annotation.note,
            dark: THEMES[resolveTheme(prefsRef.current, theme)].dark,
          });
        });
        view.addEventListener("create-overlay", (e: CustomEvent) => {
          drawAll();
          const s = searchRef.current;
          if (sidebarRef.current === "search" && s.hits.length) paintHits(s.hits, s.current, false, e.detail?.index);
        });
        view.addEventListener("show-annotation", (e: CustomEvent) => {
          const ann = annRef.current.find((a) => a.cfi === e.detail.value);
          const rect = e.detail.range ? screenRect(e.detail.range) : null;
          if (ann && rect) {
            setSel(null);
            setActive({ ann, rect });
          }
        });
        await view.open(file);
        if (cancelled) return;
        setBookFile(file);
        setKindleCapable(supportsKindlePos(view.book));
        setToc(Array.isArray(view.book?.toc) ? view.book.toc : []);
        void buildTocStarts(view);

        view.renderer.setAttribute("flow", "paginated");
        applyLayout(view, prefsRef.current);
        view.renderer.setStyles?.(contentCSS(prefsRef.current, theme));

        view.addEventListener("relocate", (e: CustomEvent) => {
          const d = e.detail ?? {};
          closePeek();
          if (typeof d.fraction === "number") {
            setFraction(d.fraction);
            lastFractionRef.current = d.fraction;
            // Only page-sized steps forward count as reading; jumps (opening
            // at the saved place, the contents, the progress bar) do not.
            const step = prevFrac.current == null ? 0 : d.fraction - prevFrac.current;
            if (step > 0 && step < 0.01) progressAcc.current += step;
            prevFrac.current = d.fraction;
          }
          noteInputRef.current();
          const label = d.tocItem?.label;
          const chap = typeof label === "string" && label.trim() ? label.trim() : null;
          setChapter(chap);
          setTocHref(d.tocItem?.href ?? null);
          if (d.cfi) {
            locRef.current = { cfi: d.cfi, fraction: d.fraction ?? 0, range: d.range ?? null, chapter: chap };
            setPageMarks(marksOnPage(view, bookmarksRef.current, d.range ?? null));
          }
          if (d.cfi) queueSave(row.asin, d.cfi, d.fraction ?? 0);
          // Popups point at text that has just moved.
          setSel(null);
          setActive(null);
        });

        const start = await invoke<ReaderStart>("reader_start", {
          asin: row.asin,
        });
        if (cancelled) return;

        if (startAt) {
          await view.init({ lastLocation: startAt });
        } else if (start.cfi) {
          // Default (like Kindle): resume the exact local in-app position.
          await view.init({ lastLocation: start.cfi });
        } else {
          // No local position yet (first open) — continue from Kindle's point.
          await view.init({ showTextStart: true });
          await jumpToAmazon(view, start.amazon_fraction);
        }

        if (!cancelled && hostRef.current) {
          const curl = new PageCurl(hostRef.current, view);
          curl.enabled = prefsRef.current.curl;
          curlRef.current = curl;
        }
        if (!cancelled) setStatus("ready");
        if (!cancelled) {
          await loadAnnotations();
          loadWords();
          await fixKindlePositions();
          pullKindle(false);
        }
      } catch (e) {
        if (!cancelled) {
          setErrMsg(String(e));
          setStatus("error");
        }
      }
    })();

    return () => {
      cancelled = true;
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      // Push the last reading position up to Amazon so other devices can sync.
      // Fire-and-forget: the component is unmounting.
      if (lastFractionRef.current > 0) {
        invoke("push_reading_position", {
          asin: row.asin,
          cdeType: row.cde_type,
          fraction: lastFractionRef.current,
        }).catch(() => undefined);
      }
      if (pushTimer.current) window.clearTimeout(pushTimer.current);
      if (prefsRef.current.kindleSync) {
        invoke("kindle_push_annotations", { asin: row.asin, cdeType: row.cde_type }).catch(() => undefined);
      }
      curlRef.current?.destroy();
      curlRef.current = null;
      try {
        viewRef.current?.close?.();
        viewRef.current?.remove?.();
      } catch {
        /* ignore */
      }
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-apply styles and layout whenever a preference (or the app theme) changes.
  useEffect(() => {
    const view = viewRef.current;
    if (view?.renderer) {
      applyLayout(view, prefs);
      view.renderer.setStyles?.(contentCSS(prefs, theme));
    }
    if (curlRef.current) curlRef.current.enabled = prefs.curl;
    curlRef.current?.invalidate();
    savePrefs(prefs);
    drawAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs, theme]);

  // ---- Highlights and notes -------------------------------------------------

  /** Notice text selections in a section as it loads. */
  function watchSelection(doc: Document, index: number) {
    const check = () => {
      const s = doc.getSelection();
      if (!s || s.isCollapsed || !s.rangeCount) return;
      const range = s.getRangeAt(0).cloneRange();
      if (!range.toString().trim()) return;
      const rect = screenRect(range);
      if (!rect) return;
      setActive(null);
      setSel({ range, index, doc, rect, dict: dictRequest(range, index, doc, rect) });
    };
    doc.addEventListener("pointerup", () => window.setTimeout(check, 0));
    doc.addEventListener("pointerover", (e) => {
      const a = (e.target as Element | null)?.closest?.("a[href]");
      if (a && isNoteRef(a)) enterLink(a, index);
    });
    doc.addEventListener("pointerout", (e) => {
      const a = (e.target as Element | null)?.closest?.("a[href]");
      if (a && !a.contains(e.relatedTarget as Node | null)) leaveLink(a);
    });
    doc.addEventListener("pointerdown", () => closePeek());
    doc.addEventListener("wheel", (e) => onWheelRef.current(e), { passive: false });
    doc.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setSidebar("search");
      }
    });
    let moveFrame = 0;
    doc.addEventListener("pointermove", (e) => {
      if (e.buttons) return;
      cancelAnimationFrame(moveFrame);
      moveFrame = requestAnimationFrame(() => {
        if (overHighlight(doc, e.clientX, e.clientY) === false) overName(doc, e.clientX, e.clientY);
      });
    });
    for (const ev of ["keydown", "pointerdown", "pointermove", "wheel"]) {
      doc.addEventListener(ev, () => noteInputRef.current(), { passive: true });
    }
    doc.addEventListener("keyup", (e) => {
      if (e.shiftKey) check();
    });
    doc.addEventListener("selectionchange", () => {
      const s = doc.getSelection();
      if ((!s || s.isCollapsed) && selRef.current?.doc === doc) setSel(null);
    });
  }

  const xr = useXray(viewRef.current, row.asin, prefs.xray && status === "ready", sidebar === "xray" || xrGraph, fraction);
  const xrRef = useRef(xr);
  xrRef.current = xr;
  const xrForms = useMemo(() => formMap(xr.ents), [xr.ents]);
  const xrFormsRef = useRef(xrForms);
  xrFormsRef.current = xrForms;

  /** The pointer is over a name the X-Ray knows: show its card. */
  const overName = (doc: Document, cx: number, cy: number) => {
    const forms = xrFormsRef.current;
    const hit = prefsRef.current.xray && forms.size ? entityAtPoint(doc, cx, cy, forms) : null;
    if (!hit) {
      if (typeof peekLink.current === "string" && peekLink.current.startsWith("xr:")) leaveLink(peekLink.current);
      return;
    }
    const id = `xr:${hit.key}`;
    clearTimer(hideTimer);
    if (peekLink.current === id) return;
    peekLink.current = id;
    clearTimer(peekTimer);
    peekTimer.current = window.setTimeout(() => {
      if (peekLink.current !== id) return;
      const x = xrRef.current;
      const e = x.byKey.get(hit.key);
      const rect = screenRect(hit.range);
      if (!e || !rect) return;
      setPeek({ rect, content: xrayCardContent(lang, x, e), label: { text: t.xrTab, color: "var(--accent)" } });
    }, 450);
  };

  // ---- Saved words of this book ---------------------------------------------
  const [words, setWords] = useState<VocabItem[]>([]);
  function loadWords() {
    invoke<VocabItem[]>("vocab_list", { asin: row.asin })
      .then(setWords)
      .catch(() => undefined);
  }

  /** A dictionary request for a short selection (when lookups are on). */
  function dictRequest(range: Range, index: number, doc: Document, rect: DOMRect): DictRequest | undefined {
    if (!prefsRef.current.dict || !isLookupSize(range.toString())) return undefined;
    const ctx = selectionContext(range);
    if (!ctx) return undefined;
    const candidates = lookupCandidates(ctx);
    if (!candidates.length) return undefined;
    const view = viewRef.current;
    let cfi: string | null = null;
    let fraction: number | null = null;
    try {
      cfi = view?.getCFI(index, range) ?? null;
      fraction = view ? fractionOf(view, index, doc, range) : null;
    } catch {
      /* position unknown */
    }
    return {
      rect,
      candidates,
      context: sentenceAround(ctx),
      bookLang: String(view?.book?.metadata?.language ?? "vi"),
      asin: row.asin,
      cfi,
      fraction,
    };
  }

  function drawOne(a: Annotation) {
    viewRef.current?.addAnnotation?.({ value: a.cfi, color: a.color, note: a.note })?.catch?.(() => undefined);
  }
  function drawAll() {
    for (const a of annRef.current) drawOne(a);
  }

  async function loadAnnotations() {
    try {
      const list = await invoke<Annotation[]>("list_annotations", { asin: row.asin });
      annRef.current = list;
      setAnnotations(list);
      drawAll();
    } catch (e) {
      console.error(e);
    }
  }

  /**
   * Recompute the Kindle position of highlights Kindle does not have yet from
   * where they are in the book (so a better position formula, or a re-made
   * book file, never sends a stale one).
   */
  async function fixKindlePositions() {
    const view = viewRef.current;
    if (!view || !supportsKindlePos(view.book)) return;
    const docs = new Map<number, Document>();
    for (const a of annRef.current) {
      if (a.on_kindle) continue;
      try {
        const { index, anchor } = view.resolveCFI(a.cfi);
        let doc = docs.get(index);
        if (!doc) {
          doc = (await view.book.sections[index].createDocument()) as Document;
          docs.set(index, doc);
        }
        const range = anchor(doc);
        const k = range ? await rangeToKindle(view.book, index, doc, range) : null;
        if (k && (k.start !== a.kstart || k.end !== a.kend)) {
          await invoke("set_annotation_kpos", { id: a.id, kstart: k.start, kend: k.end });
          a.kstart = k.start;
          a.kend = k.end;
        }
      } catch {
        /* unresolvable cfi: leave it */
      }
    }
  }

  /** Send local changes to Kindle soon, if the reader allows it. */
  function queuePush() {
    if (!prefsRef.current.kindleSync || !supportsKindlePos(viewRef.current?.book)) return;
    if (pushTimer.current) window.clearTimeout(pushTimer.current);
    pushTimer.current = window.setTimeout(async () => {
      pushTimer.current = null;
      try {
        await invoke("kindle_push_annotations", { asin: row.asin, cdeType: row.cde_type });
        const list = await invoke<Annotation[]>("list_annotations", { asin: row.asin });
        annRef.current = list;
        setAnnotations(list);
      } catch (e) {
        setNotesSync({ state: "fail" });
        console.error(e);
      }
    }, 1500);
  }

  /**
   * Bring in Kindle's highlights: the backend merges what it already has;
   * new ones are placed here (Kindle position -> range -> CFI). A manual
   * sync also sends local changes first.
   */
  async function pullKindle(manual: boolean) {
    const view = viewRef.current;
    if (!view || !supportsKindlePos(view.book)) return;
    if (manual) setNotesSync({ state: "busy" });
    try {
      if (manual) await invoke("kindle_push_annotations", { asin: row.asin, cdeType: row.cde_type });
      const res = await invoke<{ new: KindleRecord[]; changed: number }>("kindle_pull_annotations", {
        asin: row.asin,
        cdeType: row.cde_type,
      });
      const docs = new Map<number, Document>();
      let added = 0;
      for (const r of res.new) {
        const index = sectionOfPos(view.book, r.start);
        if (index < 0) continue;
        let doc = docs.get(index);
        if (!doc) {
          doc = (await view.book.sections[index].createDocument()) as Document;
          docs.set(index, doc);
        }
        const range = await kindleToRange(view.book, index, doc, r.start, r.end);
        if (!range) continue;
        let chapter: string | null = null;
        try {
          chapter = view.getProgressOf(index, range)?.tocItem?.label ?? null;
        } catch {
          /* no toc */
        }
        await invoke("add_annotation", {
          asin: row.asin,
          cfi: view.getCFI(index, range),
          kstart: r.start,
          kend: r.end,
          fraction: fractionOf(view, index, doc, range),
          color: r.color ?? "yellow",
          note: r.text,
          excerpt: range.toString().replace(/\s+/g, " ").trim(),
          chapter,
          fromKindle: true,
        });
        added++;
      }
      if (added || res.changed) {
        for (const a of annRef.current) view.deleteAnnotation?.({ value: a.cfi });
        await loadAnnotations();
      }
      if (manual || added) {
        setNotesSync({
          state: "done",
          message: added ? t.notesFromKindle.replace("{0}", String(added)) : undefined,
        });
      }
    } catch (e) {
      console.error(e);
      if (manual) setNotesSync({ state: "fail" });
    }
  }

  async function highlightSelection(color: HighlightColor, thenNote = false) {
    const s = selRef.current;
    const view = viewRef.current;
    if (!s || !view) return;
    try {
      const k = await rangeToKindle(view.book, s.index, s.doc, s.range).catch(() => null);
      const a = await invoke<Annotation>("add_annotation", {
        asin: row.asin,
        cfi: view.getCFI(s.index, s.range),
        kstart: k?.start ?? null,
        kend: k?.end ?? null,
        fraction: fractionOf(view, s.index, s.doc, s.range),
        color,
        note: null,
        excerpt: s.range.toString().replace(/\s+/g, " ").trim(),
        chapter: locRef.current?.chapter ?? null,
        fromKindle: false,
      });
      s.doc.getSelection()?.removeAllRanges();
      setSel(null);
      const list = [...annRef.current, a].sort((x, y) => x.fraction - y.fraction || x.id - y.id);
      annRef.current = list;
      setAnnotations(list);
      drawOne(a);
      queuePush();
      if (thenNote) setNoteEdit({ ann: a, rect: s.rect });
    } catch (e) {
      console.error(e);
    }
  }

  async function updateAnnotation(a: Annotation, patch: { color?: HighlightColor; note?: string }) {
    try {
      const u = await invoke<Annotation>("update_annotation", {
        id: a.id,
        color: patch.color ?? null,
        note: patch.note ?? null,
      });
      const list = annRef.current.map((x) => (x.id === u.id ? u : x));
      annRef.current = list;
      setAnnotations(list);
      drawOne(u);
      queuePush();
      return u;
    } catch (e) {
      console.error(e);
      return a;
    }
  }

  async function deleteAnnotation(id: number) {
    const a = annRef.current.find((x) => x.id === id);
    if (!a) return;
    await invoke("remove_annotation", { id }).catch(() => undefined);
    viewRef.current?.deleteAnnotation?.({ value: a.cfi });
    const list = annRef.current.filter((x) => x.id !== id);
    annRef.current = list;
    setAnnotations(list);
    setActive(null);
    queuePush();
  }

  function copyText(text: string) {
    navigator.clipboard?.writeText(text).catch(() => undefined);
  }

  // Bookmarks: load once, and keep "is this page bookmarked" current.
  const bookmarksRef = useRef<Bookmark[]>([]);
  bookmarksRef.current = bookmarks;
  useEffect(() => {
    invoke<Bookmark[]>("list_bookmarks", { asin: row.asin })
      .then(setBookmarks)
      .catch(() => undefined);
  }, [row.asin]);
  useEffect(() => {
    setPageMarks(marksOnPage(viewRef.current, bookmarks, locRef.current?.range ?? null));
  }, [bookmarks]);

  async function toggleBookmark() {
    const loc = locRef.current;
    if (!loc) return;
    try {
      if (pageMarksRef.current.length) {
        for (const id of pageMarksRef.current) await invoke("remove_bookmark", { id });
      } else {
        let excerpt: string | null = null;
        try {
          excerpt = loc.range?.toString() ?? null;
        } catch {
          /* detached range */
        }
        await invoke<Bookmark>("add_bookmark", {
          asin: row.asin,
          cfi: loc.cfi,
          fraction: loc.fraction,
          chapter: loc.chapter,
          excerpt,
        });
      }
      setBookmarks(await invoke<Bookmark[]>("list_bookmarks", { asin: row.asin }));
    } catch (e) {
      console.error(e);
    }
  }
  async function deleteBookmark(id: number) {
    await invoke("remove_bookmark", { id }).catch(() => undefined);
    setBookmarks((b) => b.filter((x) => x.id !== id));
  }
  async function goTo(target: string) {
    setSidebar(null);
    try {
      await viewRef.current?.goTo(target);
    } catch {
      /* unresolvable target */
    }
  }
  const pageMarksRef = useRef<number[]>([]);
  pageMarksRef.current = pageMarks;
  // Keyboard shortcuts read the latest handlers through this ref.
  const keysRef = useRef({ toggleBookmark, toggleSidebar: () => setSidebar((v) => (v ? null : "toc")) });
  keysRef.current = { toggleBookmark, toggleSidebar: () => setSidebar((v) => (v ? null : "toc")) };

  // ---- Mouse wheel turns pages ----------------------------------------------
  // Down (or right) is the next page. A mouse notch turns one page; a
  // touchpad swipe adds up small steps and turns once, its glide after the
  // turn is ignored until the fingers stop.
  const wheel = useRef({ acc: 0, last: 0, lockUntil: 0 });
  const onWheelTurn = (e: WheelEvent) => {
    if (e.ctrlKey || e.defaultPrevented) return;
    const v = viewRef.current;
    if (!v || v.renderer?.getAttribute?.("flow") === "scrolled") return;
    const raw = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    if (!raw) return;
    e.preventDefault();
    const d = e.deltaMode === 1 ? raw * 40 : e.deltaMode === 2 ? raw * 800 : raw;
    const now = performance.now();
    const w = wheel.current;
    const notch = Math.abs(d) >= 50;
    if (now - w.last > 220) w.acc = 0;
    w.last = now;
    if (now < w.lockUntil) {
      // Touchpad glide: stay locked while it keeps coming.
      if (!notch) w.lockUntil = now + 180;
      return;
    }
    w.acc += d;
    if (Math.abs(w.acc) < 60) return;
    const forward = w.acc > 0;
    w.acc = 0;
    w.lockUntil = now + (notch ? 260 : 420);
    const rtl = v.book?.dir === "rtl";
    if (forward !== rtl) turnRight();
    else turnLeft();
  };
  const onWheelRef = useRef(onWheelTurn);
  onWheelRef.current = onWheelTurn;
  useEffect(() => {
    // Over the page only, not the panels, popups or progress bar.
    const onWin = (e: WheelEvent) => {
      if ((e.target as Element | null)?.closest?.(".reader__host")) onWheelRef.current(e);
    };
    window.addEventListener("wheel", onWin, { passive: false });
    return () => window.removeEventListener("wheel", onWin);
  }, []);

  // Keyboard navigation.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Sliders and other controls keep their own arrow keys.
      if ((e.target as Element | null)?.closest?.("input, select, textarea, .rset")) return;
      if (e.key === "ArrowLeft" || e.key === "PageUp") turnLeft();
      else if (e.key === "ArrowRight" || e.key === "PageDown") turnRight();
      // Escape closes the book only when no overlay (map, dictionary…) is up.
      else if (e.key === "Escape") {
        if (!document.querySelector(".xrg, .dict, .hlnote, .rside")) onClose();
      }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setSidebar("search");
      } else if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === "b") keysRef.current.toggleBookmark();
      else if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === "t") keysRef.current.toggleSidebar();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Page turns go through the curl (it falls back to a plain turn by itself
  // when it cannot animate, e.g. right-to-left books or scrolled flow).
  function turnLeft() {
    const v = viewRef.current;
    if (!v) return;
    if (curlRef.current && v.book?.dir !== "rtl") curlRef.current.turn(-1);
    else v.goLeft?.();
  }
  function turnRight() {
    const v = viewRef.current;
    if (!v) return;
    if (curlRef.current && v.book?.dir !== "rtl") curlRef.current.turn(1);
    else v.goRight?.();
  }

  function queueSave(asin: string, cfi: string, frac: number) {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      invoke("set_reading_position", { asin, cfi, fraction: frac }).catch(
        () => undefined,
      );
    }, 500);
  }

  // Manual sync: fetch the CURRENT furthest-page-read live from Amazon, then ask
  // before jumping (like Kindle's "Sync to Furthest Page Read" dialog).
  async function checkSync() {
    setSync({ state: "checking" });
    try {
      const f = await invoke<Furthest | null>("kindle_furthest", {
        asin: row.asin,
        cdeType: row.cde_type,
      });
      if (!f) {
        setSync({ state: "none" });
        return;
      }
      const far = f.fraction ?? (f.percent != null ? f.percent / 100 : null);
      if (far == null) {
        setSync({ state: "none" });
        return;
      }
      if (far <= fraction + 0.002) {
        setSync({ state: "already", farFrac: far });
      } else {
        setSync({ state: "ask", curFrac: fraction, farFrac: far });
      }
    } catch {
      setSync({ state: "error" });
    }
  }

  async function applySync() {
    if (sync?.state !== "ask") return;
    const { farFrac } = sync;
    setSync(null);
    await jumpToAmazon(viewRef.current, farFrac);
  }

  const scrubMarksXray = xr.ready && xrSel && prefs.xray
    ? (xr.byKey.get(xrSel)?.mentions ?? [])
        .filter((m) => m[4] <= xr.limit + 1e-9)
        .slice(0, 400)
        .map((m, i) => ({ key: `x${i}`, fraction: m[4], color: "var(--accent)", kind: "search" as const }))
    : [];
  const scrubMarks: ScrubMark[] = [
    ...scrubMarksXray,
    ...bookmarks.map((b) => ({ key: `b${b.id}`, fraction: b.fraction, color: "var(--accent)", kind: "bookmark" as const })),
    ...annotations.map((a) => ({ key: `a${a.id}`, fraction: a.fraction, color: COLOR_HEX[a.color], kind: "highlight" as const })),
    ...(sidebar === "search"
      ? search.hits.slice(0, 400).map((h, i) => ({
          key: `s${i}`,
          fraction: h.fraction,
          color: i === search.current ? "#f0a91e" : "color-mix(in srgb, #f0a91e 60%, transparent)",
          kind: "search" as const,
        }))
      : []),
  ];

  const pct = Math.round(fraction * 100);
  // Today's minutes (saved + this session) and time left at the reader's speed.
  const todayMin = Math.floor((todaySec + sessionSec) / 60);
  const leftMin = (frac: number) => Math.max(0, Math.round((frac * (row.text_length ?? 0)) / Math.max(1, speed)));
  const fmtLeft = (m: number) => (m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}` : `${m}′`);
  let chapterLeft: number | null = null;
  {
    const fr: number[] = viewRef.current?.getSectionFractions?.() ?? [];
    const i = fr.findIndex((f, k) => fraction >= f && fraction < (fr[k + 1] ?? 1));
    if (i >= 0 && row.text_length) chapterLeft = leftMin((fr[i + 1] ?? 1) - fraction);
  }
  const bookLeft = row.text_length ? leftMin(1 - fraction) : null;
  const loc = locationAt(fraction, locMap);
  // Format a reading position: Kindle-style location if we have the map, else %.
  const fmtPos = (frac: number) => {
    const l = locationAt(frac, locMap);
    return l != null && locMap
      ? `${t.location} ${l.toLocaleString()} / ${locMap.total.toLocaleString()}`
      : `${Math.round(frac * 100)}%`;
  };

  return (
    <div
      className="reader"
      data-rtheme={rTheme}
      style={{
        ["--r-bg" as string]: palette.bg,
        ["--r-fg" as string]: palette.fg,
        ["--r-muted" as string]: palette.muted,
        colorScheme: palette.dark ? "dark" : "light",
      }}
    >
      <header className="reader__bar" data-tauri-drag-region>
        <button className="reader__back" onClick={onClose} title={t.closeReader}>
          <Icon name="arrowL" size={17} />
          <span>{t.backToLibrary}</span>
        </button>
        <button
          className={`reader__tool${sidebar ? " is-on" : ""}`}
          onClick={() => setSidebar((v) => (v ? null : "toc"))}
          aria-expanded={!!sidebar}
          title={t.sidebarHint}
          aria-label={t.sidebarHint}
        >
          <Icon name="toc" size={19} />
        </button>
        <div className="reader__heading" data-tauri-drag-region>
          <div className="reader__title" title={row.title} data-tauri-drag-region>
            {row.title || row.asin}
          </div>
          {row.author && (
            <div className="reader__author" data-tauri-drag-region>
              {row.author}
            </div>
          )}
        </div>
        <div className="reader__spacer" data-tauri-drag-region />
        <button
          className={`reader__tool${pageMarks.length ? " reader__tool--marked" : ""}`}
          onClick={toggleBookmark}
          disabled={status !== "ready"}
          aria-pressed={pageMarks.length > 0}
          title={pageMarks.length ? t.removeBookmark : t.addBookmark}
          aria-label={pageMarks.length ? t.removeBookmark : t.addBookmark}
        >
          <Icon name={pageMarks.length ? "bookmarkOn" : "bookmark"} size={19} />
        </button>
        <button
          className="reader__tool"
          onClick={checkSync}
          disabled={sync?.state === "checking"}
          title={t.syncKindle}
          aria-label={t.syncKindle}
        >
          <Icon name="sync" size={18} />
        </button>
        <button
          className={`reader__tool reader__tool--aa${showSettings ? " is-on" : ""}`}
          onClick={() => setShowSettings((v) => !v)}
          aria-expanded={showSettings}
          title={t.readingSettings}
          aria-label={t.readingSettings}
          data-settings-toggle
        >
          <span className="reader__aa-s">A</span>
          <span className="reader__aa-l">a</span>
        </button>
        <span className="titlebar__sep" />
        <WindowControls
          labels={{ minimize: t.winMinimize, maximize: t.winMaximize, restore: t.winRestore, close: t.winClose }}
        />
        {showSettings && (
          <ReaderSettings
            prefs={prefs}
            set={setPref}
            lang={lang}
            appTheme={theme}
            onClose={() => setShowSettings(false)}
          />
        )}
      </header>

      <div className={`reader__stage${sidebar === "search" || sidebar === "xray" ? " reader__stage--dock" : ""}`}>
        {pageMarks.length > 0 && <div className="reader__ribbon" aria-hidden="true" />}
        {sidebar && (
          <ReaderSidebar
            lang={lang}
            tab={sidebar}
            setTab={setSidebar}
            toc={toc}
            currentHref={tocHref}
            bookmarks={bookmarks}
            formatPos={fmtPos}
            onGo={goTo}
            onDelete={deleteBookmark}
            onClose={() => setSidebar(null)}
            annotations={annotations}
            onEditNote={(a) => {
              setSidebar(null);
              setNoteEdit({ ann: a, rect: new DOMRect(window.innerWidth / 2 - 1, window.innerHeight / 2 - 120, 2, 2) });
            }}
            onDeleteAnnotation={deleteAnnotation}
            notesSync={notesSync}
            onSyncNotes={() => pullKindle(true)}
            kindleCapable={kindleCapable}
            wordsPanel={
              prefs.dict || words.length ? (
                <WordsPanel
                  lang={lang}
                  words={words}
                  onGo={(w) => w.cfi && goTo(w.cfi)}
                  onChanged={loadWords}
                />
              ) : undefined
            }
            wordCount={words.length}
            xrayPanel={
              prefs.xray ? (
                <XRayPanel
                  lang={lang}
                  x={xr}
                  view={viewRef.current}
                  selected={xrSel}
                  onSelect={setXrSel}
                  onOpenGraph={() => setXrGraph(true)}
                  formatPos={fmtPos}
                  onGo={(m) => goToMention(viewRef.current, m)}
                />
              ) : undefined
            }
            searchPanel={
              <SearchPanel
                lang={lang}
                state={search}
                chapterOf={chapterOf}
                formatPos={fmtPos}
                onSearch={runSearch}
                onPick={pickHit}
              />
            }
          />
        )}
        {status === "loading" && (
          <div className="reader__overlay muted">{t.openingBook}</div>
        )}
        {status === "error" && (
          <div className="reader__overlay reader__overlay--error">
            <div>{t.readerError}</div>
            <div className="small muted reader__err">{errMsg}</div>
          </div>
        )}
        <button
          className="reader__nav reader__nav--left"
          onClick={turnLeft}
          aria-label={t.prevPage}
          title={t.prevPage}
        >
          <Icon name="prev" size={26} />
        </button>
        <div ref={hostRef} className="reader__host" />
        <button
          className="reader__nav reader__nav--right"
          onClick={turnRight}
          aria-label={t.nextPage}
          title={t.nextPage}
        >
          <Icon name="next" size={26} />
        </button>
      </div>

      <footer className="reader__foot">
        <span className="reader__chapter" title={chapter ?? undefined}>
          {chapter ?? ""}
          {chapterLeft != null && status === "ready" && (
            <span className="reader__left" title={bookLeft != null ? t.bookLeft.replace("{0}", fmtLeft(bookLeft)) : undefined}>
              {" · "}
              {t.chapterLeft.replace("{0}", fmtLeft(chapterLeft))}
            </span>
          )}
        </span>
        <ScrubBar
          fraction={fraction}
          disabled={status !== "ready"}
          label={t.seekTo}
          loadingLabel={t.previewLoading}
          marks={scrubMarks}
          file={bookFile}
          styles={contentCSS({ ...prefs, size: Math.round(prefs.size * PREVIEW_SCALE) }, theme)}
          formatPos={fmtPos}
          onSeek={(f) => jumpToAmazon(viewRef.current, f)}
        />
        <span className="reader__pos">
          <span className={`reader__today${todayMin >= goalMin ? " is-done" : ""}`} title={t.dailyGoal}>
            <Icon name="flame" size={13} />
            {t.readerToday.replace("{0}", String(todayMin)).replace("{1}", String(goalMin))}
          </span>
          {loc != null && locMap && (
            <span className="reader__loc">
              {t.location} {loc.toLocaleString()} / {locMap.total.toLocaleString()} ·{" "}
            </span>
          )}
          {pct}%
        </span>
      </footer>

      {xrGraph && prefs.xray && xr.ready && (
        <XRayGraph
          lang={lang}
          x={xr}
          view={viewRef.current}
          title={row.title || row.asin}
          provider={prefs.aiProvider}
          onClose={() => setXrGraph(false)}
          onOpenEntity={(k) => {
            setXrGraph(false);
            setXrSel(k);
            setSidebar("xray");
          }}
        />
      )}
      {peek && !sel && !active && !noteEdit && (
        <FootnotePopup
          peek={peek}
          font={FONT_STACKS[prefs.font] ?? FONT_STACKS.book ?? "serif"}
          onEnter={() => clearTimer(hideTimer)}
          onLeave={hidePeekSoon}
          onClose={closePeek}
        />
      )}
      {sel?.dict && !noteEdit && (
        <DictPopup
          key={sel.dict.candidates.join("|")}
          lang={lang}
          req={sel.dict}
          onClose={() => setSel((s) => (s ? { ...s, dict: undefined } : s))}
          onSaved={() => loadWords()}
        />
      )}
      {sel && !noteEdit && (
        <HighlightBar
          lang={lang}
          anchor={sel.rect}
          onColor={(c) => highlightSelection(c)}
          onNote={() => highlightSelection("yellow", true)}
          onCopy={() => {
            copyText(sel.range.toString());
            sel.doc.getSelection()?.removeAllRanges();
            setSel(null);
          }}
          onClose={() => {
            sel.doc.getSelection()?.removeAllRanges();
            setSel(null);
          }}
        />
      )}
      {active && !noteEdit && (
        <HighlightBar
          lang={lang}
          anchor={active.rect}
          current={active.ann.color}
          hasNote={!!active.ann.note}
          onColor={(c) => {
            updateAnnotation(active.ann, { color: c });
            setActive(null);
          }}
          onNote={() => {
            setNoteEdit({ ann: active.ann, rect: active.rect });
            setActive(null);
          }}
          onCopy={() => {
            copyText(active.ann.excerpt ?? "");
            setActive(null);
          }}
          onDelete={() => deleteAnnotation(active.ann.id)}
          onClose={() => setActive(null)}
        />
      )}
      {noteEdit && (
        <NoteEditor
          key={noteEdit.ann.id}
          lang={lang}
          anchor={noteEdit.rect}
          excerpt={noteEdit.ann.excerpt ?? ""}
          color={noteEdit.ann.color}
          initial={noteEdit.ann.note ?? ""}
          onCancel={() => setNoteEdit(null)}
          onSave={async (text) => {
            const ann = noteEdit.ann;
            setNoteEdit(null);
            if ((ann.note ?? "") !== text.trim()) await updateAnnotation(ann, { note: text.trim() });
          }}
        />
      )}

      {sync && (
        <div className="reader__modal" onClick={() => sync.state !== "checking" && setSync(null)}>
          <div className="reader__dialog" onClick={(e) => e.stopPropagation()}>
            {sync.state === "checking" && <p>{t.syncChecking}</p>}
            {sync.state === "ask" && (
              <>
                <p>
                  {t.syncCurrent} <b>{fmtPos(sync.curFrac)}</b>. {t.syncFurthest}{" "}
                  <b>{fmtPos(sync.farFrac)}</b>. {t.syncGoQuestion}
                </p>
                <div className="reader__dialog-actions">
                  <button className="btn" onClick={() => setSync(null)}>
                    {t.syncLater}
                  </button>
                  <button className="btn btn--primary" onClick={applySync}>
                    {t.syncGoTo}
                  </button>
                </div>
              </>
            )}
            {sync.state === "already" && (
              <>
                <p>{t.syncAlready.replace("{0}", fmtPos(sync.farFrac))}</p>
                <div className="reader__dialog-actions">
                  <button className="btn btn--primary" onClick={() => setSync(null)}>
                    OK
                  </button>
                </div>
              </>
            )}
            {(sync.state === "none" || sync.state === "error") && (
              <>
                <p>{sync.state === "none" ? t.syncNone : t.syncError}</p>
                <div className="reader__dialog-actions">
                  <button className="btn btn--primary" onClick={() => setSync(null)}>
                    OK
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
