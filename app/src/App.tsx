import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { STR, type Lang } from "./i18n";
import type {
  AccountInfo,
  AuthState,
  LibraryRow,
  LibraryView,
  ReadStatus,
  SortKey,
  TypeFilter,
} from "./types";
import Reader from "./Reader";
import BookEditor from "./BookEditor";
import BookDetail from "./BookDetail";
import { Library, type BookActions } from "./Library";
import { bookKind, statusLabel } from "./bookInfo";
import { coverOf, morph } from "./transitions";
import { AccountMenu } from "./AccountMenu";
import { WindowControls } from "./WindowControls";
import { isAndroid } from "./platform";
import { LibrarySkeleton } from "./LibrarySkeleton";
import { Icon } from "./icons";
import { KindlePushDialog, wantsKindlePush, type KindlePushRequest } from "./KindlePush";
import { MobileSendSheet, SendDialog, useSendQueue } from "./SendToKindle";
import {
  AddDropOverlay,
  ConfirmDialog,
  EmptyLibrary,
  ImportToast,
  LocalLibraryDialog,
  LogoutDialog,
  useLocalImport,
} from "./LocalImport";
import { AmazonDevicesDialog, SignInDialog } from "./DeviceDialogs";
import { BadgeToasts, StatsPage, StreakButton, useStats } from "./Stats";
import type { WrapSummary } from "./stats/types";
import { WrapOffers } from "./wrap/WrapOffers";
import { useWraps } from "./wrap/useWraps";
import { WrapViewer } from "./wrap/WrapViewer";
import { VocabPage } from "./Vocab";
import { UpdateBanner, useUpdater } from "./Updater";
import "./App.css";
import { MobileHome, MobileLibrary, MobileTabs, type MobileTab, type MobileSource } from "./mobile/MobileShell";
import MobileBookSheet from "./mobile/MobileBookSheet";
import MobileAccount from "./mobile/MobileAccount";
import { useAndroidBack } from "./mobile/back";
import "./mobile/mobile.css";

const DetailComponent = isAndroid ? MobileBookSheet : BookDetail;

function useStored<T extends string>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      return (localStorage.getItem(key) as T) || initial;
    } catch {
      return initial;
    }
  });
  const set = (nv: T) => {
    setV(nv);
    try {
      localStorage.setItem(key, nv);
    } catch {
      /* ignore */
    }
  };
  return [v, set];
}

export default function App() {
  const [lang, setLang] = useStored<Lang>("lang", "vi");
  const [theme, setTheme] = useStored<"light" | "dark">("theme", "dark");
  const t = STR[lang];

  const [auth, setAuth] = useState<AuthState>("loading");
  /** The library is open: signed in to Amazon, or using the app as a guest. */
  const hasLib = auth === "in" || auth === "guest";
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [library, setLibrary] = useState<LibraryRow[]>([]);
  /** The library has been read once: until then an empty list means "not loaded yet", not "no books". */
  const [libLoaded, setLibLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [sort, setSort] = useStored<SortKey>("sort", "recent");
  const [filter, setFilter] = useStored<TypeFilter>("filter", "all");
  const [reading, setReading] = useState<LibraryRow | null>(null);
  const [editing, setEditing] = useState<LibraryRow | null>(null);
  const [view, setView] = useStored<LibraryView>("view", "shelves");
  const [statusFilter, setStatusFilter] = useState<ReadStatus | null>(null);
  const [detailAsin, setDetailAsin] = useState<string | null>(null);
  /** A status change to offer pushing to Kindle (asks first). */
  const [kindlePush, setKindlePush] = useState<KindlePushRequest | null>(null);
  // Reading stats: streak, minutes, badges.
  const [showStats, setShowStats] = useState(false);
  const [showVocab, setShowVocab] = useState(false);
  /** Where to open the book being read (a saved word's place), if not the saved position. */
  const [readAt, setReadAt] = useState<string | null>(null);
  const stats = useStats(hasLib);
  // Wrap-ups (week, month, year): offered on Home, listed in Stats, shown in a viewer.
  const wraps = useWraps(stats.summary);
  const [wrapOpen, setWrapOpen] = useState<WrapSummary | null>(null);
  const openWrap = (w: WrapSummary) => {
    wraps.markSeen(w);
    setWrapOpen(w);
  };
  const wrapOffers = <WrapOffers lang={lang} offers={wraps.pending} onOpen={openWrap} onDismiss={wraps.markSeen} />;
  const updater = useUpdater();

  // Send to Kindle: the queue outlives the dialog.
  const [showSend, setShowSend] = useState(false);
  /** Before signing in: the kept device, or a new one with a name. */
  const [askSignIn, setAskSignIn] = useState(false);
  /** This app's devices on the Amazon account. */
  const [showDevices, setShowDevices] = useState(false);
  const [dragging, setDragging] = useState(false);
  const sendQueue = useSendQueue(() => {
    refreshLibrary().catch(() => undefined);
    enrich();
  });
  const [metaProgress, setMetaProgress] = useState<{ done: number; total: number } | null>(null);
  /** Books added from this computer (picker or drop). */
  const localImport = useLocalImport(() => {
    refreshLibrary().catch(() => undefined);
  });
  const localImportRef = useRef(localImport);
  localImportRef.current = localImport;
  const sendQueueRef = useRef(sendQueue);
  sendQueueRef.current = sendQueue;

  // Android "Share → pntome" with EPUBs: signed in, they go to Send to Kindle;
  // as a guest, into the library on this phone. Shared before the library is
  // open, they wait until it is.
  useEffect(() => {
    if (!isAndroid || (auth !== "in" && auth !== "guest")) return;
    const take = () =>
      invoke<string[]>("shared_files_take")
        .then((uris) => {
          if (!uris.length) return;
          if (auth === "in") {
            setShowSend(true);
            return sendQueueRef.current.add(uris);
          }
          localImportRef.current.add(uris);
        })
        .catch((e) => setError(String(e)));
    take();
    window.addEventListener("pntome-share", take);
    return () => window.removeEventListener("pntome-share", take);
  }, [auth]);
  const [askLogout, setAskLogout] = useState(false);
  const [showLocalLib, setShowLocalLib] = useState(false);
  /** After a sync: how many local books look like a Kindle book (offer to link). */
  const [matchNotice, setMatchNotice] = useState<number | null>(null);
  /** Show only local books that have a suggested Kindle edition. */
  const [onlyMatches, setOnlyMatches] = useState(false);
  /** A local book waiting for "remove from library?" to be confirmed. */
  const [removing, setRemoving] = useState<LibraryRow | null>(null);
  const [mobileTab, setMobileTab] = useState<MobileTab>("home");
  const [mobileSource, setMobileSource] = useState<MobileSource>("all");
  const [searchFocus, setSearchFocus] = useState(0);

  useAndroidBack(() => {
    if (removing) { setRemoving(null); return true; }
    if (kindlePush) { setKindlePush(null); return true; }
    if (askLogout) { setAskLogout(false); return true; }
    if (showLocalLib) {
      // Respect a disabled close button during a library restore/export.
      document.querySelector<HTMLButtonElement>(".locallib__x:not(:disabled)")?.click();
      return true;
    }
    if (showSend) { setShowSend(false); return true; }
    if (editing) {
      document.querySelector<HTMLButtonElement>('.editor__actions button[type="button"]:last-of-type:not(:disabled)')?.click();
      return true;
    }
    // The Goodreads picker is nested inside the book sheet.
    const pickerCancel = document.querySelector<HTMLButtonElement>(".gr__pickactions button:last-child");
    if (pickerCancel) { pickerCancel.click(); return true; }
    if (reading) {
      const overlay = document.querySelector<HTMLElement>(".reader__modal");
      if (overlay) { overlay.click(); return true; }
      // Use each overlay's own close action, avoiding Escape reaching two layers.
      for (const selector of [".hlnote__actions .btn:not(.btn--primary)", ".dict__tools button:last-child", ".xrg__aipop .dict__actions .btn:not(.btn--primary)", ".xrg__phead .reader__tool", ".xrg__tools > .reader__tool"]) {
        const close = document.querySelector<HTMLButtonElement>(selector);
        if (close) { close.click(); return true; }
      }
    }
    // Reader overlays already handle Escape. Do not close the reader as well.
    if (reading && document.querySelector(".rset, .rside, .dict, .xrg, .hlnote")) {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      return true;
    }
    if (detailAsin) { setDetailAsin(null); return true; }
    if (showStats) { setShowStats(false); return true; }
    if (reading) { setReading(null); setReadAt(null); void refreshLibrary(); stats.refresh(); return true; }
    if (mobileTab !== "home") { setSearchFocus(0); setMobileTab("home"); return true; }
    return false;
  }, setError);

  useEffect(() => {
    if (isAndroid) document.querySelector(".app__body")?.scrollTo({ top: 0 });
  }, [mobileTab, showStats]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // Dropping files or folders anywhere in the window adds them to the library
  // (Send to Kindle has its own button).
  useEffect(() => {
    if (!hasLib || isAndroid) return;
    const un = getCurrentWebview().onDragDropEvent((e) => {
      const p = e.payload;
      if (p.type === "enter") setDragging(p.paths.length > 0);
      else if (p.type === "leave") setDragging(false);
      else if (p.type === "drop") {
        setDragging(false);
        localImportRef.current.add(p.paths);
      }
    });
    return () => {
      un.then((f) => f());
    };
  }, [hasLib]);

  // Initial auth check + library load.
  useEffect(() => {
    (async () => {
      try {
        const info = await invoke<AccountInfo | null>("auth_status");
        if (info) {
          setAccount(info);
          setAuth("in");
          await refreshLibrary();
          enrich();
        } else if (await invoke<boolean>("guest_status")) {
          setAuth("guest");
          await refreshLibrary();
        } else {
          setAuth("out");
        }
      } catch (e) {
        setAuth("out");
        setError(String(e));
      }
    })();
  }, []);

  useEffect(() => {
    if (!isAndroid) return;
    const signin = (event: Event) => {
      if (event.target !== window) return;
      const redirect: unknown = (event as CustomEvent).detail;
      if (redirect === null) {
        setBusy(null);
        void invoke("cancel_mobile_login").catch(() => undefined);
      } else if (typeof redirect === "string") {
        void invoke("complete_mobile_login", { redirect }).catch(() => {
          setBusy(null);
          setError(t.loginFailed);
        });
      }
    };
    window.addEventListener("pntome-signin", signin);
    return () => window.removeEventListener("pntome-signin", signin);
  }, [t]);

  // Login + sync progress events.
  useEffect(() => {
    const unlisteners: Array<Promise<() => void>> = [
      listen<AccountInfo>("login-complete", async (e) => {
        setAccount(e.payload);
        setAuth("in");
        setBusy(null);
        setError(null);
        await startSync();
      }),
      listen<string>("login-error", (e) => {
        setBusy(null);
        setError(`${t.loginFailed}: ${e.payload}`);
      }),
      listen<{ done: number; total: number }>("sync-progress", (e) => {
        setProgress(e.payload);
        // Reading progress arrives book by book: show it as it comes (at most
        // every 1.5 s, so a big library does not reload on every book).
        if (Date.now() - lastSyncRefresh.current > 1500) {
          lastSyncRefresh.current = Date.now();
          scheduleRefresh();
        }
      }),
      // A sync has the book list: show the books now, and start on the
      // covers while reading progress is still being fetched.
      listen("library-changed", () => {
        lastSyncRefresh.current = Date.now();
        refreshLibrary().catch(() => undefined);
        enrich();
      }),
      // Covers/metadata arriving from the background extraction.
      listen<{ done: number; total: number; asin: string }>("meta-progress", (e) => {
        const { done, total } = e.payload;
        setMetaProgress(done >= total ? null : { done, total });
        scheduleRefresh();
      }),
    ];
    return () => {
      unlisteners.forEach((p) => p.then((f) => f()));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t]);

  async function refreshLibrary() {
    try {
      const rows = await invoke<LibraryRow[]>("get_library");
      setLibrary(rows);
      return rows;
    } finally {
      setLibLoaded(true);
    }
  }

  // Books added from watched folders: soon after opening, then every few minutes.
  useEffect(() => {
    if (!hasLib || isAndroid) return;
    const run = () => localImportRef.current.scan();
    const first = window.setTimeout(run, 3000);
    const every = window.setInterval(run, 3 * 60 * 1000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(every);
    };
  }, [hasLib]);

  // Coalesce bursts of metadata events into one library reload.
  const refreshTimer = useRef<number | null>(null);
  const lastSyncRefresh = useRef(0);
  function scheduleRefresh() {
    if (refreshTimer.current) return;
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = null;
      refreshLibrary().catch(() => undefined);
    }, 400);
  }

  /** Fetch covers + metadata for books that have none yet (background). */
  function enrich() {
    invoke("enrich_library").catch(() => undefined);
  }

  /** Sign in: first choose the device (the one kept at sign-out, or a new one with a name). */
  function doLogin() {
    setError(null);
    setAskSignIn(true);
  }

  async function loginNew(deviceName: string) {
    setAskSignIn(false);
    setError(null);
    setBusy(t.signingIn);
    try {
      await invoke("login", { ...(isAndroid ? { title: t.signIn, note: t.mobileSignInNote } : {}), deviceName: deviceName || null });
    } catch (e) {
      setBusy(null);
      setError(String(e));
    }
  }

  /** Sign in again as the device kept at sign-out: no Amazon page, no new device. */
  async function loginResume() {
    setAskSignIn(false);
    setError(null);
    try {
      const info = await invoke<AccountInfo>("resume_login");
      setAccount(info);
      setAuth("in");
      await startSync();
    } catch (e) {
      setError(String(e));
    }
  }

  async function startSync() {
    setError(null);
    setBusy(t.syncing);
    setProgress({ done: 0, total: 0 });
    try {
      await invoke<number>("sync_library");
      const rows = await refreshLibrary();
      enrich();
      const twins = rows.filter((r) => r.kindle_match).length;
      setMatchNotice(twins > 0 ? twins : null);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
      setProgress(null);
    }
  }

  async function doLogout(clearKindle: boolean, forget: boolean) {
    setAskLogout(false);
    try {
      await invoke("logout", { clearKindle, forget });
    } catch (e) {
      setError(String(e));
    }
    setAccount(null);
    setAuth("guest");
    await refreshLibrary().catch(() => setLibrary([]));
  }

  /** "Use without signing in": remembered, so the welcome screen shows once. */
  async function enterGuest() {
    setError(null);
    try {
      await invoke("set_guest", { on: true });
    } catch (e) {
      setError(String(e));
    }
    setAuth("guest");
    await refreshLibrary().catch(() => undefined);
  }

  async function removeLocal(row: LibraryRow) {
    setRemoving(null);
    try {
      await invoke("remove_local_book", { asin: row.asin });
      if (detailAsin === row.asin) setDetailAsin(null);
      await refreshLibrary();
    } catch (e) {
      setError(String(e));
    }
  }

  /** The logo: back to the library as it opens (no page, filter or search on top). */
  function goHome() {
    if (!hasLib) return;
    setDetailAsin(null);
    setEditing(null);
    setShowStats(false);
    setShowVocab(false);
    setStatusFilter(null);
    setOnlyMatches(false);
    setQuery("");
    document.querySelector(".app__body")?.scrollTo({ top: 0, behavior: "smooth" });
  }

  const pickBooks = () => localImport.pick(t.addBooksHint).catch((e) => setError(String(e)));

  /** Link / unlink / "not this book" for a local book and a Kindle book. */
  async function linkAction(cmd: "link_book" | "dismiss_link" | "unlink_book", local: LibraryRow, asin?: string) {
    try {
      await invoke(cmd, cmd === "unlink_book" ? { localId: local.asin } : { localId: local.asin, asin });
      await refreshLibrary();
    } catch (e) {
      setError(String(e));
    }
  }

  /** Send a local EPUB to Kindle through the Send to Kindle dialog. */
  async function sendLocal(row: LibraryRow) {
    try {
      const info = await invoke<{ path: string } | null>("local_book_info", { asin: row.asin });
      if (!info) return;
      // On a phone the dialog takes the screen: the book's sheet goes.
      if (isAndroid) setDetailAsin(null);
      setShowSend(true);
      await sendQueue.add([info.path]);
    } catch (e) {
      setError(String(e));
    }
  }

  // A Kindle book linked to a local one is shown through the local card only.
  const linkedKindle = useMemo(
    () => new Set(library.map((r) => r.linked_asin).filter((a): a is string => !!a)),
    [library],
  );
  const visible = useMemo(() => library.filter((r) => !linkedKindle.has(r.asin)), [library, linkedKindle]);
  // Nothing left to link: drop the "also on Kindle" filter.
  useEffect(() => {
    if (onlyMatches && !visible.some((r) => r.kindle_match)) setOnlyMatches(false);
  }, [onlyMatches, visible]);

  // Only offer the kind filter when the library actually mixes kinds
  // (Kindle purchases, Kindle documents, books from this computer).
  const kinds = useMemo(() => {
    const present = new Set(visible.map(bookKind));
    return (["EBOK", "PDOC", "LOCAL"] as const).filter((k) => present.has(k));
  }, [visible]);
  const activeFilter: TypeFilter = kinds.length > 1 && (kinds as string[]).includes(filter) ? filter : "all";
  const mixedSources = visible.some((r) => r.source === "local") && visible.some((r) => r.source === "amazon");
  const activeMobileSource = mixedSources ? mobileSource : "all";

  const shown = useMemo(() => {
    let rows = visible;
    if (onlyMatches) rows = rows.filter((r) => r.kindle_match);
    if (isAndroid) {
      if (activeMobileSource !== "all") rows = rows.filter((r) => r.source === activeMobileSource);
    } else if (activeFilter !== "all") rows = rows.filter((r) => bookKind(r) === activeFilter);
    if (statusFilter) rows = rows.filter((r) => r.status === statusFilter);
    const q = query.trim().toLowerCase();
    if (q) {
      rows = rows.filter(
        (r) =>
          r.title.toLowerCase().includes(q) ||
          r.author.toLowerCase().includes(q),
      );
    }
    const sorted = [...rows];
    switch (sort) {
      case "title":
        sorted.sort((a, b) => a.title.localeCompare(b.title));
        break;
      case "author":
        sorted.sort((a, b) => a.author.localeCompare(b.author));
        break;
      case "progress":
        sorted.sort((a, b) => (b.percent ?? -1) - (a.percent ?? -1));
        break;
      default:
        break; // recent = DB order
    }
    return sorted;
  }, [visible, onlyMatches, activeFilter, statusFilter, query, sort, activeMobileSource]);

  const detailRow = detailAsin ? library.find((r) => r.asin === detailAsin) ?? null : null;
  const detailTwinAsin = detailRow?.source === "local" ? (detailRow.linked_asin ?? detailRow.kindle_match) : null;
  const detailTwin = detailTwinAsin ? library.find((r) => r.asin === detailTwinAsin) ?? null : null;
  const mobileBlocked = !!(detailRow || editing || removing || kindlePush || askLogout || showLocalLib || showSend || askSignIn || showDevices);
  // A status filter ("See all" on a shelf) is a flat collection, never shelves.
  const effectiveView: LibraryView = (statusFilter || onlyMatches) && view === "shelves" ? "grid" : view;

  // Opening a book or its page morphs from the cover that was clicked.
  const actions: BookActions = {
    read: (row, from) => {
      const open = () => {
        setDetailAsin(null);
        setReading(row);
      };
      if (isAndroid) open();
      else morph(open, from);
    },
    details: (row, from) => isAndroid ? setDetailAsin(row.asin) : morph(() => setDetailAsin(row.asin), from),
  };

  function closeDetail() {
    if (isAndroid) { setDetailAsin(null); return; }
    const asin = detailAsin;
    morph(() => setDetailAsin(null), null, () => (asin ? coverOf(asin) : null));
  }

  /** A book was dragged (or Alt+arrowed) to `status`, whose shelf order is now `order`. */
  async function arrangeBook(asin: string, status: ReadStatus, order: string[]) {
    const moved = library.find((r) => r.asin === asin);
    const changedShelf = !!moved && moved.status !== status;
    // Show the new arrangement immediately; the database catches up.
    setLibrary((lib) =>
      lib.map((r) => {
        const pos = order.indexOf(r.asin);
        let n = r;
        if (r.asin === asin && changedShelf) n = { ...n, status, status_manual: true };
        if (pos >= 0) n = { ...n, shelf_pos: pos };
        return n;
      }),
    );
    try {
      if (changedShelf) await invoke("set_book_status", { asin, status });
      await invoke("set_shelf_order", { asins: order });
      if (changedShelf) offerKindlePush(moved, status);
    } catch (e) {
      setError(String(e));
    } finally {
      refreshLibrary().catch(() => undefined);
    }
  }

  /** After a status change: offer to make Kindle agree (asks first). */
  function offerKindlePush(row: LibraryRow | undefined, status: ReadStatus | null) {
    if (auth !== "in" || row?.source !== "amazon") return;
    if (row && status && wantsKindlePush(row, status)) setKindlePush({ row, status });
  }

  async function setStatus(asin: string, status: ReadStatus | null) {
    const row = library.find((r) => r.asin === asin);
    try {
      await invoke("set_book_status", { asin, status });
      await refreshLibrary();
      offerKindlePush(row, status);
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="app">
      {/* Title bar: the window is frameless, so this is also the drag handle. */}
      <header className="titlebar" data-tauri-drag-region>
        <button className="brand" onClick={goHome} title={t.library} aria-label={t.library}>
          <img className="brand__icon" src="/app-icon.png" alt="" width={26} height={26} draggable={false} />
          <span className="brand__name">{t.appName}</span>
        </button>
        {hasLib && (
          <label className="search titlebar__search">
            <Icon name="search" size={17} />
            <input
              placeholder={t.searchPlaceholder}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
        )}
        <div className="titlebar__spacer" data-tauri-drag-region />
        {hasLib && (
          <button
            className="iconbtn"
            onClick={pickBooks}
            disabled={!!localImport.state.progress}
            title={t.addBooks}
            aria-label={t.addBooks}
          >
            <Icon name="plus" size={20} />
          </button>
        )}
        {hasLib && (
          <button
            className={`iconbtn${showVocab ? " iconbtn--on" : ""}`}
            onClick={() => {
              setShowVocab((v) => !v);
              setShowStats(false);
            }}
            title={t.vbTitle}
            aria-label={t.vbTitle}
          >
            <Icon name="vocab" size={18} />
          </button>
        )}
        {hasLib && (
          <StreakButton
            lang={lang}
            s={stats.summary}
            onClick={() => {
              setShowStats(true);
              setShowVocab(false);
              stats.refresh();
            }}
          />
        )}
        {auth === "in" && (
          <button
            className={`iconbtn${sendQueue.active ? " iconbtn--on" : ""}`}
            onClick={() => setShowSend(true)}
            title={t.stkTitle}
            aria-label={t.stkTitle}
          >
            <Icon name="upload" size={19} />
            {sendQueue.active > 0 && <span className="iconbtn__count">{sendQueue.active}</span>}
          </button>
        )}
        {auth === "in" && (
          <button
            className={`iconbtn${busy === t.syncing ? " iconbtn--on" : ""}`}
            disabled={!!busy}
            onClick={startSync}
            title={t.sync}
            aria-label={t.sync}
          >
            <Icon name="refresh" size={19} className={busy === t.syncing ? "icon--spin" : undefined} />
            {busy === t.syncing && progress && progress.total > 0 && (
              <span className="iconbtn__count">
                {progress.done}/{progress.total}
              </span>
            )}
          </button>
        )}
        <AccountMenu
          lang={lang}
          setLang={setLang}
          theme={theme}
          setTheme={setTheme}
          deviceName={auth === "in" ? account?.device_name : undefined}
          guest={auth === "guest"}
          onSignOut={auth === "in" ? () => setAskLogout(true) : undefined}
          onSignIn={auth === "guest" ? doLogin : undefined}
          onDevices={auth === "in" ? () => setShowDevices(true) : undefined}
          onLocalLibrary={hasLib ? () => setShowLocalLib(true) : undefined}
          checkState={updater.checkState}
          onCheckUpdate={updater.checkNow}
        />
        {!isAndroid && (
          <>
            <span className="titlebar__sep" />
            <WindowControls labels={{ minimize: t.winMinimize, maximize: t.winMaximize, restore: t.winRestore, close: t.winClose }} />
          </>
        )}
      </header>

      {/* Everything below the title bar scrolls; the bar never moves. */}
      <div className="app__body" inert={isAndroid && (mobileBlocked || !!reading)}>
      {error && <div className="banner banner--error">{error}</div>}
      {matchNotice != null && hasLib && (
        <div className="banner banner--info">
          <span>{t.matchNotice.replace("{0}", String(matchNotice))}</span>
          <button
            className="linkbtn"
            onClick={() => {
              setOnlyMatches(true);
              if (isAndroid) { setMobileTab("library"); setMobileSource("all"); setStatusFilter(null); setQuery(""); }
              setShowStats(false);
              setShowVocab(false);
              setMatchNotice(null);
            }}
          >
            {t.matchShow}
          </button>
          <button className="iconbtn banner__x" onClick={() => setMatchNotice(null)} aria-label={t.closeReader} title={t.closeReader}>
            <Icon name="close" size={15} />
          </button>
        </div>
      )}

      {auth === "loading" && (isAndroid
        ? <main className="mobile-content mobile-home mobile-boot"><LibrarySkeleton kind="home" label={t.loading} /></main>
        : <div className="center muted">{t.loading}</div>)}

      {auth === "out" && (
        <div className="hero">
          <img className="hero__mark" src="/app-icon.png" alt="" width={128} height={128} />
          <h1>{t.appName}</h1>
          <p className="muted">{t.tagline}</p>
          <div className="hero__choices">
            <div className="hero__choice">
              <button className="btn btn--primary btn--lg" disabled={!!busy} onClick={enterGuest} autoFocus>
                {t.guestBtn}
              </button>
              <span className="small muted">{t.welcomeLead}</span>
            </div>
            {!isAndroid && (
              <div className="hero__choice">
                <button className="btn btn--lg" disabled={!!busy} onClick={doLogin}>
                  {busy ? busy : t.signIn}
                </button>
                <span className="small muted">{t.welcomeAmazon}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {isAndroid && hasLib && !reading && !showStats && mobileTab === "home" && (
        <MobileHome
          onSync={auth === "in" ? startSync : undefined} syncing={busy === t.syncing} syncBusy={!!busy} progress={progress} meta={metaProgress}
          rows={visible} loading={!libLoaded} lang={lang} summary={stats.summary} wrapOffers={wrapOffers}
          onRead={(r) => actions.read(r, null)} onDetail={(r) => actions.details(r, null)}
          onStats={() => { setShowStats(true); stats.refresh(); }}
          onAdd={pickBooks} adding={!!localImport.state.progress}
          onSearch={() => { setMobileTab("library"); setSearchFocus((v) => v + 1); }}
          onReadingBooks={() => { setSearchFocus(0); setStatusFilter("reading"); setMobileSource("all"); setQuery(""); setMobileTab("library"); }}
        />
      )}
      {isAndroid && hasLib && !reading && !showStats && mobileTab === "library" && (
        <MobileLibrary
          onSync={auth === "in" ? startSync : undefined} syncing={busy === t.syncing} syncBusy={!!busy} progress={progress} meta={metaProgress}
          matchFilter={onlyMatches} onClearMatches={() => setOnlyMatches(false)}
          rows={shown} total={visible.length} loading={!libLoaded} mixed={mixedSources} lang={lang}
          query={query} setQuery={setQuery} sort={sort} setSort={setSort}
          status={statusFilter} setStatus={setStatusFilter}
          source={activeMobileSource} setSource={setMobileSource}
          view={view} setView={setView} focus={searchFocus}
          onAdd={pickBooks} adding={!!localImport.state.progress}
          onRead={(r) => actions.read(r, null)} onDetail={(r) => actions.details(r, null)}
        />
      )}
      {isAndroid && hasLib && !reading && !showStats && mobileTab === "account" && (
        <MobileAccount
          lang={lang} setLang={setLang} theme={theme} setTheme={setTheme}
          goal={stats.summary?.goal_minutes ?? 10} onChanged={stats.refresh}
          onLocalLibrary={() => setShowLocalLib(true)} onSendToKindle={() => setShowSend(true)} onDevices={() => setShowDevices(true)} deviceName={account?.device_name}
          signedIn={auth === "in"} busy={!!busy} onSignIn={doLogin} onSignOut={() => setAskLogout(true)}
        />
      )}

      {hasLib && (isAndroid ? mobileTab === "vocab" && !reading : showVocab) && !showStats && (
        <VocabPage
          lang={lang}
          titles={new Map(library.map((r) => [r.asin, r.title]))}
          onBack={() => isAndroid ? setMobileTab("home") : setShowVocab(false)}
          onOpen={(asin, cfi) => {
            const row = library.find((r) => r.asin === asin);
            if (!row) return;
            setReadAt(cfi);
            setReading(row);
          }}
        />
      )}

      {hasLib && showStats && !isAndroid && (
        <StatsPage lang={lang} s={stats.summary} loadFailed={stats.failed} rows={library} onBack={() => setShowStats(false)} onChanged={stats.refresh} wraps={{ list: wraps.all, onOpen: openWrap, onDelete: wraps.remove }} />
      )}
      {hasLib && showStats && isAndroid && !reading && <div className="mobile-stats">
        <StatsPage lang={lang} s={stats.summary} loadFailed={stats.failed} rows={library} onBack={() => setShowStats(false)} onChanged={stats.refresh} wraps={{ list: wraps.all, onOpen: openWrap, onDelete: wraps.remove }} />
      </div>}

      {!isAndroid && hasLib && !showStats && !showVocab && (
        <main className="library">
          {wrapOffers}
          <div className="libhead">
            <div className="libhead__title">
              <h1>{t.library}</h1>
              <span className="muted">
                {shown.length} {t.books}
              </span>
              {statusFilter && (
                <button className="filter-chip" onClick={() => setStatusFilter(null)} title={t.clearFilter}>
                  {statusLabel(t, statusFilter)}
                  <Icon name="close" size={15} />
                </button>
              )}
              {onlyMatches && (
                <button className="filter-chip" onClick={() => setOnlyMatches(false)} title={t.clearFilter}>
                  {t.matchChip}
                  <Icon name="close" size={15} />
                </button>
              )}
              {metaProgress && (
                <span className="libhead__meta muted">
                  <Icon name="refresh" size={14} className="icon--spin" />
                  {t.fetchingCovers} {metaProgress.done}/{metaProgress.total}
                </span>
              )}
            </div>
            <div className="libhead__tools">
              {kinds.length > 1 && (
                <div className="seg" role="radiogroup">
                  {(["all", ...kinds] as TypeFilter[]).map((f) => (
                    <button
                      key={f}
                      role="radio"
                      aria-checked={activeFilter === f}
                      className={`seg__btn${activeFilter === f ? " seg__btn--on" : ""}`}
                      onClick={() => setFilter(f)}
                    >
                      {f === "all" ? t.all : f === "EBOK" ? t.purchased : f === "PDOC" ? t.docs : t.typeLocal}
                    </button>
                  ))}
                </div>
              )}
              <div className="seg" role="radiogroup" aria-label="View">
                {(
                  [
                    ["shelves", "library", t.viewShelves],
                    ["grid", "grid", t.viewGrid],
                    ["list", "list", t.viewList],
                  ] as const
                ).map(([v, icon, label]) => (
                  <button
                    key={v}
                    role="radio"
                    aria-checked={effectiveView === v}
                    className={`seg__btn${effectiveView === v ? " seg__btn--on" : ""}`}
                    onClick={() => {
                      if (v === "shelves") setStatusFilter(null);
                      setView(v);
                    }}
                    title={label}
                    aria-label={label}
                  >
                    <Icon name={icon} size={16} />
                  </button>
                ))}
              </div>
              <label className="select select--ghost" title={t.sortBy}>
                <Icon name="sort" size={16} />
                <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label={t.sortBy}>
                  <option value="recent">{t.sortRecent}</option>
                  <option value="title">{t.sortTitle}</option>
                  <option value="author">{t.sortAuthor}</option>
                  <option value="progress">{t.sortProgress}</option>
                </select>
              </label>
            </div>
          </div>

          {library.length === 0 ? (
            libLoaded ? <EmptyLibrary lang={lang} onAdd={pickBooks} /> : <LibrarySkeleton kind="grid" label={t.loading} />
          ) : (
          <Library
            rows={shown}
            all={visible}
            view={effectiveView}
            searching={!!query.trim()}
            lang={lang}
            actions={actions}
            onSeeAll={(st) => {
              setStatusFilter(st);
              setView("grid");
            }}
            onArrange={arrangeBook}
          />
          )}
        </main>
      )}

      </div>

      {isAndroid && hasLib && !reading && !showStats && <MobileTabs lang={lang} tab={mobileTab} onTab={(tab) => { setSearchFocus(0); setMobileTab(tab); }} blocked={mobileBlocked} />}

      {detailRow && !reading && (
        <DetailComponent
          key={`detail-${detailRow.asin}`}
          row={detailRow}
          lang={lang}
          onClose={closeDetail}
          onRead={(from) => actions.read(detailRow, from)}
          onEdit={() => setEditing(detailRow)}
          onStatus={(st) => setStatus(detailRow.asin, st)}
          onRemove={detailRow.source === "local" ? () => setRemoving(detailRow) : undefined}
          twin={detailTwin}
          signedIn={auth === "in"}
          onLink={() => detailTwin && linkAction("link_book", detailRow, detailTwin.asin)}
          onDismissLink={() => detailTwin && linkAction("dismiss_link", detailRow, detailTwin.asin)}
          onUnlink={() => linkAction("unlink_book", detailRow)}
          onReadTwin={detailTwin ? () => actions.read(detailTwin, null) : undefined}
          onSendToKindle={detailRow.source === "local" ? () => sendLocal(detailRow) : undefined}
          onGenreChanged={stats.refresh}
        />
      )}

      {editing && (
        <BookEditor
          key={`edit-${editing.asin}`}
          row={editing}
          lang={lang}
          onClose={() => setEditing(null)}
          onSaved={(status) => {
            refreshLibrary();
            if (status !== undefined) offerKindlePush(editing, status);
          }}
        />
      )}

      {hasLib && (
        <BadgeToasts
          lang={lang}
          toasts={stats.toasts}
          onDismiss={stats.dismiss}
          onOpen={() => {
            setReading(null);
            setShowStats(true);
          }}
        />
      )}
      {wrapOpen && <WrapViewer lang={lang} kind={wrapOpen.kind} periodStart={wrapOpen.period_start} summary={stats.summary} onClose={() => setWrapOpen(null)} />}
      {showSend && auth === "in" && (isAndroid
        ? <MobileSendSheet lang={lang} queue={sendQueue} onClose={() => setShowSend(false)} />
        : <SendDialog lang={lang} queue={sendQueue} onClose={() => setShowSend(false)} />)}
      {dragging && <AddDropOverlay lang={lang} />}
      {!reading && (localImport.state.progress || localImport.state.results) && (
        <ImportToast
          lang={lang}
          state={localImport.state}
          onDismiss={localImport.dismiss}
          onCancel={localImport.cancel}
          onOpen={(id) => {
            localImport.dismiss();
            setReading(null);
            setShowStats(false);
            setShowVocab(false);
            setDetailAsin(id);
          }}
        />
      )}
      {showLocalLib && (
        <LocalLibraryDialog
          lang={lang}
          onClose={() => setShowLocalLib(false)}
          onChanged={() => refreshLibrary().catch(() => undefined)}
          onScan={() => localImport.scan()}
        />
      )}
      {askLogout && <LogoutDialog lang={lang} onClose={() => setAskLogout(false)} onConfirm={doLogout} />}
      {askSignIn && <SignInDialog lang={lang} onClose={() => setAskSignIn(false)} onResume={loginResume} onNew={loginNew} />}
      {showDevices && auth === "in" && <AmazonDevicesDialog lang={lang} onClose={() => setShowDevices(false)} />}
      {removing && (
        <ConfirmDialog
          lang={lang}
          icon="trash"
          title={t.removeBook}
          text={t.removeConfirm.replace("{0}", removing.title)}
          confirm={t.removeBook}
          onClose={() => setRemoving(null)}
          onConfirm={() => removeLocal(removing)}
        />
      )}
      {!reading && !isAndroid && <UpdateBanner lang={lang} updater={updater} />}

      {kindlePush && (
        <KindlePushDialog
          key={`kpush-${kindlePush.row.asin}`}
          lang={lang}
          req={kindlePush}
          onClose={() => setKindlePush(null)}
          onPushed={() => refreshLibrary().catch(() => undefined)}
        />
      )}

      {reading && (
        <Reader
          row={reading}
          signedIn={auth === "in"}
          lang={lang}
          theme={theme}
          todaySec={stats.summary ? stats.summary.today_app_sec + stats.summary.today_kindle_sec : 0}
          goalMin={stats.summary?.goal_minutes ?? 10}
          speed={stats.summary?.speed ?? 1500}
          onLogged={stats.refresh}
          startAt={readAt}
          onClose={() => {
            const asin = reading.asin;
            setReadAt(null);
            morph(() => setReading(null), null, () => coverOf(asin));
            refreshLibrary();
          }}
        />
      )}
    </div>
  );
}
