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
import { Icon } from "./icons";
import { KindlePushDialog, wantsKindlePush, type KindlePushRequest } from "./KindlePush";
import { SendDialog, useSendQueue } from "./SendToKindle";
import {
  AddDropOverlay,
  ConfirmDialog,
  EmptyLibrary,
  ImportToast,
  LogoutDialog,
  useLocalImport,
} from "./LocalImport";
import { BadgeToasts, StatsPage, StreakButton, useStats } from "./Stats";
import { VocabPage } from "./Vocab";
import { UpdateBanner, useUpdater } from "./Updater";
import "./App.css";

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
  const updater = useUpdater();

  // Send to Kindle: the queue outlives the dialog.
  const [showSend, setShowSend] = useState(false);
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
  const [askLogout, setAskLogout] = useState(false);
  /** A local book waiting for "remove from library?" to be confirmed. */
  const [removing, setRemoving] = useState<LibraryRow | null>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // Dropping files or folders anywhere in the window adds them to the library
  // (Send to Kindle has its own button).
  useEffect(() => {
    if (!hasLib) return;
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
    const rows = await invoke<LibraryRow[]>("get_library");
    setLibrary(rows);
  }

  // Coalesce bursts of metadata events into one library reload.
  const refreshTimer = useRef<number | null>(null);
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

  async function doLogin() {
    setError(null);
    setBusy(t.signingIn);
    try {
      await invoke("login");
    } catch (e) {
      setBusy(null);
      setError(String(e));
    }
  }

  async function startSync() {
    setError(null);
    setBusy(t.syncing);
    setProgress({ done: 0, total: 0 });
    try {
      await invoke<number>("sync_library");
      await refreshLibrary();
      enrich();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
      setProgress(null);
    }
  }

  async function doLogout(clearKindle: boolean) {
    setAskLogout(false);
    try {
      await invoke("logout", { clearKindle });
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

  const pickBooks = () => localImport.pick(t.addBooksHint).catch((e) => setError(String(e)));

  // Only offer the kind filter when the library actually mixes kinds
  // (Kindle purchases, Kindle documents, books from this computer).
  const kinds = useMemo(() => {
    const present = new Set(library.map(bookKind));
    return (["EBOK", "PDOC", "LOCAL"] as const).filter((k) => present.has(k));
  }, [library]);
  const activeFilter: TypeFilter = kinds.length > 1 && (kinds as string[]).includes(filter) ? filter : "all";

  const shown = useMemo(() => {
    let rows = library;
    if (activeFilter !== "all") rows = rows.filter((r) => bookKind(r) === activeFilter);
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
  }, [library, activeFilter, statusFilter, query, sort]);

  const detailRow = detailAsin ? library.find((r) => r.asin === detailAsin) ?? null : null;
  // A status filter ("See all" on a shelf) is a flat collection, never shelves.
  const effectiveView: LibraryView = statusFilter && view === "shelves" ? "grid" : view;

  // Opening a book or its page morphs from the cover that was clicked.
  const actions: BookActions = {
    read: (row, from) =>
      morph(() => {
        setDetailAsin(null);
        setReading(row);
      }, from),
    details: (row, from) => morph(() => setDetailAsin(row.asin), from),
  };

  function closeDetail() {
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
        <div className="brand" data-tauri-drag-region>
          <img className="brand__icon" src="/app-icon.png" alt="" width={26} height={26} draggable={false} />
          <span className="brand__name" data-tauri-drag-region>{t.appName}</span>
        </div>
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
          checkState={updater.checkState}
          onCheckUpdate={updater.checkNow}
        />
        <span className="titlebar__sep" />
        <WindowControls labels={{ minimize: t.winMinimize, maximize: t.winMaximize, restore: t.winRestore, close: t.winClose }} />
      </header>

      {/* Everything below the title bar scrolls; the bar never moves. */}
      <div className="app__body">
      {error && <div className="banner banner--error">{error}</div>}

      {auth === "loading" && <div className="center muted">{t.loading}</div>}

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
            <div className="hero__choice">
              <button className="btn btn--lg" disabled={!!busy} onClick={doLogin}>
                {busy ? busy : t.signIn}
              </button>
              <span className="small muted">{t.welcomeAmazon}</span>
            </div>
          </div>
        </div>
      )}

      {hasLib && showVocab && !showStats && (
        <VocabPage
          lang={lang}
          titles={new Map(library.map((r) => [r.asin, r.title]))}
          onBack={() => setShowVocab(false)}
          onOpen={(asin, cfi) => {
            const row = library.find((r) => r.asin === asin);
            if (!row) return;
            setReadAt(cfi);
            setReading(row);
          }}
        />
      )}

      {hasLib && showStats && (
        <StatsPage lang={lang} s={stats.summary} onBack={() => setShowStats(false)} onChanged={stats.refresh} />
      )}

      {hasLib && !showStats && !showVocab && (
        <main className="library">
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
            <EmptyLibrary lang={lang} onAdd={pickBooks} />
          ) : (
          <Library
            rows={shown}
            all={library}
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

      {detailRow && !reading && (
        <BookDetail
          key={`detail-${detailRow.asin}`}
          row={detailRow}
          lang={lang}
          onClose={closeDetail}
          onRead={(from) => actions.read(detailRow, from)}
          onEdit={() => setEditing(detailRow)}
          onStatus={(st) => setStatus(detailRow.asin, st)}
          onRemove={detailRow.source === "local" ? () => setRemoving(detailRow) : undefined}
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
      {showSend && auth === "in" && <SendDialog lang={lang} queue={sendQueue} onClose={() => setShowSend(false)} />}
      {dragging && <AddDropOverlay lang={lang} />}
      {!reading && (localImport.state.progress || localImport.state.results) && (
        <ImportToast
          lang={lang}
          state={localImport.state}
          onDismiss={localImport.dismiss}
          onOpen={(id) => {
            localImport.dismiss();
            setReading(null);
            setShowStats(false);
            setShowVocab(false);
            setDetailAsin(id);
          }}
        />
      )}
      {askLogout && <LogoutDialog lang={lang} onClose={() => setAskLogout(false)} onConfirm={doLogout} />}
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
      {!reading && <UpdateBanner lang={lang} updater={updater} />}

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
