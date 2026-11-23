import { isAndroid } from "./platform";
import { MobileReaderSheet } from "./mobile/MobileReaderSheet";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { STR, type Lang } from "./i18n";
import { Icon } from "./icons";
import { relativeTime } from "./bookInfo";
import { COLOR_HEX, HIGHLIGHT_COLORS, type Annotation, type HighlightColor } from "./annotate";

export interface TocItem {
  label?: string;
  href?: string;
  subitems?: TocItem[] | null;
}

export interface Bookmark {
  id: number;
  cfi: string;
  fraction: number;
  chapter: string | null;
  excerpt: string | null;
  created_at: string;
}

export type SidebarTab = "toc" | "marks" | "notes" | "search" | "words" | "xray";

/** Kindle sync status shown in the notes tab. */
export type NotesSync = { state: "idle" | "busy" | "done" | "fail"; message?: string };

/**
 * Left panel of the reader: the book's table of contents (current chapter
 * highlighted) and the bookmarks, in reading order.
 */
export function ReaderSidebar({
  lang,
  tab,
  setTab,
  toc,
  currentHref,
  bookmarks,
  formatPos,
  onGo,
  onDelete,
  onClose,
  annotations,
  onEditNote,
  onDeleteAnnotation,
  notesSync,
  onSyncNotes,
  kindleCapable,
  local = false,
  searchPanel,
  wordsPanel,
  wordCount = 0,
  xrayPanel,
}: {
  lang: Lang;
  tab: SidebarTab;
  setTab: (t: SidebarTab) => void;
  toc: TocItem[];
  currentHref: string | null;
  bookmarks: Bookmark[];
  formatPos: (fraction: number) => string;
  onGo: (target: string) => void;
  onDelete: (id: number) => void;
  onClose: () => void;
  annotations: Annotation[];
  onEditNote: (a: Annotation) => void;
  onDeleteAnnotation: (id: number) => void;
  notesSync: NotesSync;
  onSyncNotes: () => void;
  /** The book can address text by Kindle position (KF8). */
  kindleCapable: boolean;
  /** A book added from this computer (never on Kindle). */
  local?: boolean;
  /** The Find tab's content. */
  searchPanel: ReactNode;
  /** The saved-words tab's content (none when the dictionary is off). */
  wordsPanel?: ReactNode;
  wordCount?: number;
  /** The X-Ray tab's content (none when X-Ray is off). */
  xrayPanel?: ReactNode;
}) {
  const t = STR[lang];
  const listRef = useRef<HTMLDivElement>(null);
  // The new tab's content slides in from the side its tab is on.
  const ORDER: SidebarTab[] = ["toc", "marks", "notes", "search", "xray", "words"];
  const prevTab = useRef(tab);
  const dir = ORDER.indexOf(tab) >= ORDER.indexOf(prevTab.current) ? "next" : "prev";
  useEffect(() => {
    prevTab.current = tab;
  }, [tab]);
  const [filter, setFilter] = useState<HighlightColor | "all" | "note">("all");
  const shown = annotations.filter((a) =>
    filter === "all" ? true : filter === "note" ? !!a.note : a.color === filter,
  );

  // Bring the current chapter into view when the contents open.
  useEffect(() => {
    if (tab !== "toc") return;
    listRef.current?.querySelector<HTMLElement>(".rside__item.is-current")?.scrollIntoView({ block: "center" });
  }, [tab]);

  // Escape closes the panel (before it can close the book).
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      // The relationship map, when open, takes Escape first.
      if (e.key === "Escape" && !document.querySelector(".xrg")) {
        e.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [onClose]);

  const panel = (
      <aside
        className="rside"
        aria-label={
          tab === "toc" ? t.contents : tab === "marks" ? t.bookmarks : tab === "notes" ? t.notes : tab === "search" ? t.bsTab : tab === "xray" ? t.xrTab : t.vbTitle
        }
      >
        <div className="rside__head" hidden={isAndroid && !["toc", "marks", "notes"].includes(tab)}>
          <div className="rset__seg rside__tabs" role="tablist">
            <button role="tab" aria-selected={tab === "toc"} className={tab === "toc" ? "is-on" : ""} onClick={() => setTab("toc")}>
              <Icon name="toc" size={15} />
              <span className="rside__tablabel">{t.contents}</span>
            </button>
            <button role="tab" aria-selected={tab === "marks"} className={tab === "marks" ? "is-on" : ""} onClick={() => setTab("marks")}>
              <Icon name="bookmark" size={15} />
              <span className="rside__tablabel">{t.bookmarks}</span>
              {bookmarks.length > 0 && <span className="rside__count">{bookmarks.length}</span>}
            </button>
            <button role="tab" aria-selected={tab === "notes"} className={tab === "notes" ? "is-on" : ""} onClick={() => setTab("notes")}>
              <Icon name="notes" size={15} />
              <span className="rside__tablabel">{t.notes}</span>
              {annotations.length > 0 && <span className="rside__count">{annotations.length}</span>}
            </button>
            {!isAndroid && <button role="tab" aria-selected={tab === "search"} className={tab === "search" ? "is-on" : ""} onClick={() => setTab("search")} title={`${t.bsTab} (Ctrl+F)`}>
              <Icon name="search" size={15} />
              <span className="rside__tablabel">{t.bsTab}</span>
            </button>}
            {!isAndroid && xrayPanel && (
              <button role="tab" aria-selected={tab === "xray"} className={tab === "xray" ? "is-on" : ""} onClick={() => setTab("xray")}>
                <Icon name="xray" size={15} />
                <span className="rside__tablabel">{t.xrTab}</span>
              </button>
            )}
            {!isAndroid && wordsPanel && (
              <button role="tab" aria-selected={tab === "words"} className={tab === "words" ? "is-on" : ""} onClick={() => setTab("words")}>
                <Icon name="vocab" size={15} />
                <span className="rside__tablabel">{t.vbTab}</span>
                {wordCount > 0 && <span className="rside__count">{wordCount}</span>}
              </button>
            )}
          </div>
          {!isAndroid && <button className="reader__tool" onClick={onClose} aria-label={t.closeReader} title={t.closeReader}>
            <Icon name="close" size={18} />
          </button>}
        </div>

        <div
          key={tab}
          className={`rside__body rside__body--${dir}${tab === "search" || tab === "xray" ? " rside__body--search" : ""}`}
          ref={listRef}
        >
          {tab === "search" && searchPanel}
          {tab === "words" && wordsPanel}
          {tab === "xray" && xrayPanel}
          {tab === "toc" &&
            (toc.length ? (
              <ol className="rside__toc">
                <TocList items={toc} depth={0} currentHref={currentHref} onGo={onGo} />
              </ol>
            ) : (
              <p className="rside__empty">{t.noToc}</p>
            ))}

          {tab === "marks" &&
            (bookmarks.length ? (
              <ul className="rside__marks">
                {bookmarks.map((b) => (
                  <li key={b.id} className="rside__mark">
                    <button className="rside__mark-main" onClick={() => onGo(b.cfi)}>
                      <span className="rside__mark-top">
                        <Icon name="bookmarkOn" size={13} className="rside__ribbon" />
                        <span className="rside__mark-chapter">{b.chapter || formatPos(b.fraction)}</span>
                      </span>
                      {b.excerpt && <span className="rside__excerpt">{b.excerpt}</span>}
                      <span className="rside__meta">
                        {formatPos(b.fraction)}
                        {relativeTime(lang, b.created_at) ? ` · ${relativeTime(lang, b.created_at)}` : ""}
                      </span>
                    </button>
                    <button
                      className="rside__del"
                      onClick={() => onDelete(b.id)}
                      aria-label={t.deleteBookmark}
                      title={t.deleteBookmark}
                    >
                      <Icon name="close" size={16} />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="rside__empty">{t.noBookmarks}</p>
            ))}

          {tab === "notes" && (
            <>
              <div className="rside__notes-head">
                <div className="rside__filters" role="radiogroup" aria-label={t.notes}>
                  <button role="radio" aria-checked={filter === "all"} className={filter === "all" ? "is-on" : ""} onClick={() => setFilter("all")}>
                    {t.notesAll}
                  </button>
                  {HIGHLIGHT_COLORS.map((c) => (
                    <button
                      key={c}
                      role="radio"
                      aria-checked={filter === c}
                      className={`rside__fdot${filter === c ? " is-on" : ""}`}
                      style={{ ["--c" as string]: COLOR_HEX[c] }}
                      onClick={() => setFilter(filter === c ? "all" : c)}
                      title={t[`hl_${c}` as const]}
                      aria-label={t[`hl_${c}` as const]}
                    />
                  ))}
                  <button role="radio" aria-checked={filter === "note"} className={filter === "note" ? "is-on" : ""} onClick={() => setFilter(filter === "note" ? "all" : "note")}>
                    {t.notesWithNote}
                  </button>
                </div>
                {isAndroid ? null : kindleCapable ? (
                  <button className="rside__sync" onClick={onSyncNotes} disabled={notesSync.state === "busy"}>
                    <Icon name="sync" size={15} className={notesSync.state === "busy" ? "icon--spin" : undefined} />
                    <span>
                      {notesSync.state === "busy"
                        ? t.notesSyncing
                        : notesSync.message ?? (notesSync.state === "fail" ? t.notesSyncFail : notesSync.state === "done" ? t.notesSyncDone : t.notesSyncNow)}
                    </span>
                  </button>
                ) : (
                  <p className="rside__meta rside__nokpos">{local ? t.notesLocalOnly : t.notesNoKindlePos}</p>
                )}
              </div>
              {shown.length ? (
                <ul className="rside__marks">
                  {shown.map((a) => (
                    <li key={a.id} className="rside__mark rside__ann" style={{ ["--c" as string]: COLOR_HEX[a.color] }}>
                      <button className="rside__mark-main" onClick={() => onGo(a.cfi)}>
                        {a.excerpt && <span className="rside__quote">{a.excerpt}</span>}
                        {a.note && <span className="rside__note">{a.note}</span>}
                        <span className="rside__meta">
                          {a.chapter ? `${a.chapter} · ` : ""}
                          {formatPos(a.fraction)}
                          {!a.synced && kindleCapable && a.kstart != null ? ` · ${t.notesUnsynced}` : ""}
                        </span>
                      </button>
                      <div className="rside__ann-tools">
                        <button className="rside__del rside__edit" onClick={() => onEditNote(a)} aria-label={a.note ? t.hlEditNote : t.hlAddNote} title={a.note ? t.hlEditNote : t.hlAddNote}>
                          <Icon name="edit" size={15} />
                        </button>
                        <button className="rside__del" onClick={() => onDeleteAnnotation(a.id)} aria-label={t.hlDelete} title={t.hlDelete}>
                          <Icon name="trash" size={15} />
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="rside__empty">{t.noNotes}</p>
              )}
            </>
          )}
        </div>
      </aside>
  );
  if (isAndroid) return <MobileReaderSheet title={["toc", "marks", "notes"].includes(tab) ? t.mrContents : tab === "search" ? t.bsTab : tab === "xray" ? t.xrTab : t.mrWords} closeLabel={t.closeReader} onClose={onClose}>{panel}</MobileReaderSheet>;
  return <><div className="rside__scrim" onClick={onClose} />{panel}</>;
}

function TocList({
  items,
  depth,
  currentHref,
  onGo,
}: {
  items: TocItem[];
  depth: number;
  currentHref: string | null;
  onGo: (href: string) => void;
}) {
  return (
    <>
      {items.map((it, i) => (
        <li key={`${depth}-${i}-${it.href ?? ""}`}>
          {it.href ? (
            <button
              className={`rside__item${it.href === currentHref ? " is-current" : ""}`}
              style={{ paddingLeft: 14 + depth * 16 }}
              onClick={() => onGo(it.href!)}
              aria-current={it.href === currentHref ? "location" : undefined}
            >
              {it.label?.trim() || "—"}
            </button>
          ) : (
            <div className="rside__item rside__item--plain" style={{ paddingLeft: 14 + depth * 16 }}>
              {it.label?.trim()}
            </div>
          )}
          {it.subitems && it.subitems.length > 0 && (
            <ol>
              <TocList items={it.subitems} depth={depth + 1} currentHref={currentHref} onGo={onGo} />
            </ol>
          )}
        </li>
      ))}
    </>
  );
}
