import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { STR, type Lang } from "./i18n";
import type { LibraryRow } from "./types";
import { Icon } from "./icons";
import { isAndroid } from "./platform";
import { MobileReaderSheet } from "./mobile/MobileReaderSheet";

/** What Rust reports about a picked file (src-tauri/src/stk.rs). */
interface EpubInfo {
  path: string;
  name: string;
  size: number;
  title: string | null;
  author: string | null;
  cover: string | null;
  problems: string[];
}

interface StkDevice {
  name: string;
  serial: string;
  app_made: boolean;
}

type Status =
  | { k: "ready" }
  | { k: "invalid" }
  | { k: "prepare" }
  | { k: "upload"; done: number; total: number }
  | { k: "send" }
  /** Sent; waiting for the converted book to appear in the library. */
  | { k: "converting"; since: number; known: string[] }
  | { k: "done"; asin: string }
  | { k: "timeout"; known: string[] }
  | { k: "error"; msg: string };

export interface SendItem {
  id: string;
  info: EpubInfo;
  title: string;
  author: string;
  coverPath: string | null;
  coverPreview: string | null;
  status: Status;
}

const DEVICES_KEY = "stkDevices";
/** How often, and how long, to look for the converted book. */
const POLL_MS = 30_000;
const WATCH_MS = 10 * 60_000;

function loadDevices(): string[] | null {
  try {
    const v = localStorage.getItem(DEVICES_KEY);
    return v ? (JSON.parse(v) as string[]) : null;
  } catch {
    return null;
  }
}
function saveDevices(s: string[]) {
  try {
    localStorage.setItem(DEVICES_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

const norm = (s: string) =>
  s.normalize("NFD").replace(/\p{M}/gu, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export const isEpub = (p: string) => /\.epub$/i.test(p);

/**
 * The send-to-Kindle queue. It lives at the app level so sending and the
 * wait for Amazon's conversion carry on when the dialog is closed.
 */
export function useSendQueue(onArrived: () => void) {
  const [items, setItems] = useState<SendItem[]>([]);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const sending = useRef(false);
  const arrivedRef = useRef(onArrived);
  arrivedRef.current = onArrived;

  const patch = useCallback((id: string, p: Partial<SendItem>) => {
    setItems((list) => list.map((x) => (x.id === id ? { ...x, ...p } : x)));
  }, []);

  // Progress from Rust.
  useEffect(() => {
    const un = listen<{ job: string; phase: string; done: number; total: number }>("stk-progress", (e) => {
      const { job, phase, done, total } = e.payload;
      const status: Status =
        phase === "upload" ? { k: "upload", done, total } : phase === "send" ? { k: "send" } : { k: "prepare" };
      patch(job, { status });
    });
    return () => {
      un.then((f) => f());
    };
  }, [patch]);

  async function add(paths: string[]) {
    // Android hands out content:// URIs, often without the file name: Rust copies and checks them.
    const fresh = paths
      .filter((p) => isEpub(p) || p.startsWith("content://"))
      .filter((p) => !itemsRef.current.some((x) => x.info.path === p && x.status.k !== "done"));
    if (!fresh.length) return;
    const infos = await invoke<EpubInfo[]>("epub_inspect", { paths: fresh });
    setItems((list) => [
      ...list,
      ...infos.map((info) => ({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        info,
        title: info.title ?? info.name.replace(/\.epub$/i, ""),
        author: info.author ?? "",
        coverPath: null,
        coverPreview: null,
        status: (info.problems.some((p) => p !== "no_title") ? { k: "invalid" } : { k: "ready" }) as Status,
      })),
    ]);
  }

  function remove(id: string) {
    setItems((list) => list.filter((x) => x.id !== id));
  }

  function clearFinished() {
    setItems((list) => list.filter((x) => x.status.k !== "done"));
  }

  /** Send every ready item, one after another. */
  async function sendAll(devices: string[]) {
    if (sending.current) return;
    sending.current = true;
    try {
      for (;;) {
        const it = itemsRef.current.find((x) => x.status.k === "ready" && x.title.trim());
        if (!it) break;
        patch(it.id, { status: { k: "prepare" } });
        try {
          const known = (await invoke<LibraryRow[]>("get_library")).map((r) => r.asin);
          await invoke<string>("stk_send", {
            job: it.id,
            path: it.info.path,
            title: it.title.trim(),
            author: it.author.trim(),
            coverPath: it.coverPath,
            devices,
          });
          patch(it.id, { status: { k: "converting", since: Date.now(), known } });
        } catch (e) {
          patch(it.id, { status: { k: "error", msg: String(e) } });
        }
        // Let React apply the status before looking for the next one.
        await new Promise((r) => setTimeout(r, 0));
      }
    } finally {
      sending.current = false;
    }
  }

  /** Send a failed item again, or keep waiting for one that timed out. */
  function retry(id: string) {
    const it = itemsRef.current.find((x) => x.id === id);
    if (it?.status.k === "timeout") {
      patch(id, { status: { k: "converting", since: Date.now(), known: it.status.known } });
      return;
    }
    patch(id, { status: { k: "ready" } });
    window.setTimeout(() => sendAll(loadDevices() ?? []), 0);
  }

  // Watch the library for converted books.
  const waiting = items.some((x) => x.status.k === "converting");
  useEffect(() => {
    if (!waiting) return;
    let stop = false;
    const tick = async () => {
      try {
        await invoke("sync_library");
        const rows = await invoke<LibraryRow[]>("get_library");
        let any = false;
        for (const it of itemsRef.current) {
          if (it.status.k !== "converting") continue;
          const st = it.status;
          const fresh = rows.filter((r) => !st.known.includes(r.asin) && r.cde_type !== "EBOK" && r.source === "amazon");
          const want = norm(it.title);
          const hit =
            fresh.find((r) => norm(r.title) === want) ??
            fresh.find((r) => norm(r.title).includes(want) || want.includes(norm(r.title))) ??
            (fresh.length === 1 ? fresh[0] : undefined);
          if (hit) {
            // Fetch it now so it opens straight away.
            await invoke("download_book", { asin: hit.asin, cdeType: hit.cde_type }).catch(() => undefined);
            patch(it.id, { status: { k: "done", asin: hit.asin } });
            any = true;
          } else if (Date.now() - st.since > WATCH_MS) {
            patch(it.id, { status: { k: "timeout", known: st.known } });
          }
        }
        if (any) arrivedRef.current();
      } catch {
        /* try again next tick */
      }
    };
    const first = window.setTimeout(tick, 20_000);
    const iv = window.setInterval(() => !stop && tick(), POLL_MS);
    return () => {
      stop = true;
      window.clearTimeout(first);
      window.clearInterval(iv);
    };
  }, [waiting]);

  const active = items.filter((x) => ["prepare", "upload", "send", "converting"].includes(x.status.k)).length;
  return { items, add, remove, patch, sendAll, retry, clearFinished, active };
}

type Queue = ReturnType<typeof useSendQueue>;

function fmtSize(n: number) {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

/**
 * What both Send to Kindle views share: the devices Amazon offers (the app's
 * own registrations hidden unless asked for), the ones picked (remembered),
 * the file and cover pickers, and sending.
 */
function useSendForm(lang: Lang, queue: Queue) {
  const t = STR[lang];
  const [devices, setDevices] = useState<StkDevice[] | null>(null);
  const [devErr, setDevErr] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>(() => loadDevices() ?? []);
  const [showApp, setShowApp] = useState(false);
  const firstTime = useRef(loadDevices() == null);

  useEffect(() => {
    invoke<StkDevice[]>("stk_devices")
      .then((d) => {
        setDevices(d);
        // Forget devices that no longer exist.
        setPicked((p) => p.filter((s) => d.some((x) => x.serial === s)));
      })
      .catch((e) => setDevErr(String(e)));
  }, []);

  async function pickFiles() {
    const r = await openDialog({ multiple: true, filters: [{ name: "EPUB", extensions: ["epub"] }] });
    if (r) await queue.add(Array.isArray(r) ? r : [r]);
  }
  async function pickCover(it: SendItem) {
    const r = await openDialog({ multiple: false, filters: [{ name: t.stkImages, extensions: ["jpg", "jpeg", "png"] }] });
    if (!r || Array.isArray(r)) return;
    try {
      const preview = await invoke<string>("image_preview", { path: r });
      queue.patch(it.id, { coverPath: r, coverPreview: preview });
    } catch {
      /* not an image */
    }
  }

  function toggle(serial: string) {
    setPicked((p) => (p.includes(serial) ? p.filter((s) => s !== serial) : [...p, serial]));
  }

  const ready = queue.items.filter((x) => x.status.k === "ready" && x.title.trim()).length;
  const shown = (devices ?? []).filter((d) => showApp || !d.app_made || picked.includes(d.serial));
  const hiddenCount = (devices ?? []).filter((d) => d.app_made).length;
  const devNote = picked.length ? t.stkDevNote : firstTime.current ? t.stkDevFirst : t.stkDevNone;

  function send() {
    saveDevices(picked);
    firstTime.current = false;
    queue.sendAll(picked);
  }

  return { devices, devErr, picked, toggle, showApp, setShowApp, shown, hiddenCount, devNote, ready, pickFiles, pickCover, send };
}

/**
 * Device names as Amazon gives them carry the account's name ("Hieu's Kindle
 * for PC"); when every one of them starts the same way, that part is left out
 * so the list reads "Kindle for PC", "2nd Android Device"…
 */
function shortDeviceNames(devices: StkDevice[]): Map<string, string> {
  const owner = (n: string) => /^(.+?'s )/.exec(n)?.[1];
  const owners = new Set(devices.map((d) => owner(d.name)).filter(Boolean));
  const prefix = owners.size === 1 ? [...owners][0]! : null;
  return new Map(devices.map((d) => [d.serial, prefix && d.name.startsWith(prefix) ? d.name.slice(prefix.length) : d.name]));
}

/** Android: the Send to Kindle sheet, laid out for a phone. */
export function MobileSendSheet({ lang, queue, onClose }: { lang: Lang; queue: Queue; onClose: () => void }) {
  const t = STR[lang];
  const f = useSendForm(lang, queue);
  const names = shortDeviceNames(f.devices ?? []);
  const hasItems = queue.items.length > 0;
  return (
    <div className="mobile-stk-sheet">
      <MobileReaderSheet title={t.stkTitle} closeLabel={t.closeReader} onClose={onClose}>
        {hasItems ? (
          <div className="mstk__list">
            {queue.items.map((it) => (
              <MobileQueueRow key={it.id} lang={lang} it={it} queue={queue} onCover={() => f.pickCover(it)} />
            ))}
            <button className="mstk__add" onClick={f.pickFiles}>
              <Icon name="plus" size={16} />
              {t.stkAdd}
            </button>
          </div>
        ) : (
          <button className="mstk__empty" onClick={f.pickFiles}>
            <span className="mstk__empty-icon"><Icon name="upload" size={26} /></span>
            <b>{t.stkEmptyMobile}</b>
            <small>{t.stkSub}</small>
          </button>
        )}

        <section className="mstk__devices">
          <h3>{t.stkDevices}</h3>
          {f.devErr ? (
            <p className="mstk__err">{t.stkDevErr}</p>
          ) : f.devices == null ? (
            <p className="mstk__note">{t.loading}</p>
          ) : (
            <div className="mobile-group">
              {f.shown.map((d) => {
                const on = f.picked.includes(d.serial);
                return (
                  <button key={d.serial} className={`mobile-setting mstk__dev${on ? " is-on" : ""}`} role="checkbox" aria-checked={on} onClick={() => f.toggle(d.serial)}>
                    <span>{names.get(d.serial)}</span>
                    <span className="mstk__check" aria-hidden="true">{on && <Icon name="check" size={16} />}</span>
                  </button>
                );
              })}
              {f.hiddenCount > 0 && (
                <button className="mobile-setting mstk__more" onClick={() => f.setShowApp((v) => !v)}>
                  <span>{f.showApp ? t.stkHideApp : t.stkShowApp.replace("{0}", String(f.hiddenCount))}</span>
                </button>
              )}
            </div>
          )}
          <p className="mstk__note">{f.devNote}</p>
        </section>

        <footer className="mstk__foot">
          {queue.items.some((x) => x.status.k === "done") && (
            <button className="stk__link" onClick={queue.clearFinished}>{t.stkClearDone}</button>
          )}
          <button className="btn btn--primary mstk__send" onClick={f.send} disabled={!f.ready}>
            {f.ready ? t.stkSend.replace("{0}", String(f.ready)) : t.stkTitle}
          </button>
        </footer>
      </MobileReaderSheet>
    </div>
  );
}

/** One book in the phone sheet: cover (tap to change), title and author edited in place, its progress. */
function MobileQueueRow({ lang, it, queue, onCover }: { lang: Lang; it: SendItem; queue: Queue; onCover: () => void }) {
  const t = STR[lang];
  const s = it.status;
  const editable = s.k === "ready" || s.k === "error" || s.k === "invalid";
  const cover = it.coverPreview ?? it.info.cover;
  const pct = s.k === "upload" && s.total ? Math.round((s.done / s.total) * 100) : null;
  const problems = it.info.problems.filter((p) => p !== "no_title" || !it.title.trim());
  const line = statusLine(t, s, pct);
  return (
    <div className={`mstk__item mstk__item--${s.k}`}>
      <button className="mstk__cover" onClick={onCover} disabled={!editable} aria-label={t.stkCover}>
        {cover ? <img src={cover} alt="" /> : <Icon name="book" size={22} />}
        {editable && <span className="mstk__cover-edit"><Icon name="edit" size={12} /></span>}
      </button>
      <div className="mstk__fields">
        <input className="mstk__title" value={it.title} onChange={(e) => queue.patch(it.id, { title: e.target.value })} placeholder={t.stkTitleField} aria-label={t.stkTitleField} disabled={!editable} />
        <input className="mstk__author" value={it.author} onChange={(e) => queue.patch(it.id, { author: e.target.value })} placeholder={t.stkAuthorField} aria-label={t.stkAuthorField} disabled={!editable} />
        <span className="mstk__meta">{fmtSize(it.info.size)}{it.coverPath ? ` · ${t.stkNewCover}` : ""}</span>
        {problems.length > 0 && <span className="mstk__problems">{problems.map((p) => t[`stkP_${p}` as keyof typeof t] ?? p).join(" · ")}</span>}
        {line && (
          <span className="mstk__status">
            {(s.k === "prepare" || s.k === "send" || s.k === "converting") && <Icon name="refresh" size={13} className="icon--spin" />}
            {s.k === "done" && <Icon name="check" size={14} />}
            <span>{line}</span>
            {(s.k === "error" || s.k === "timeout") && <button className="stk__link" onClick={() => queue.retry(it.id)}>{t.kpushRetry}</button>}
          </span>
        )}
        {s.k === "upload" && <div className="stk__bar"><div style={{ width: `${pct ?? 0}%` }} /></div>}
      </div>
      {(editable || s.k === "done" || s.k === "timeout") && (
        <button className="mstk__remove" onClick={() => queue.remove(it.id)} aria-label={t.stkRemove}>
          <Icon name="close" size={16} />
        </button>
      )}
    </div>
  );
}

/** The words for where a book is in the send, if any. */
function statusLine(t: (typeof STR)[Lang], s: Status, pct: number | null): string | null {
  switch (s.k) {
    case "prepare": return t.stkPrepare;
    case "upload": return t.stkUploading.replace("{0}", String(pct ?? 0));
    case "send": return t.stkSending;
    case "converting": return t.stkConverting;
    case "done": return t.stkDone;
    case "timeout": return t.stkTimeout;
    case "error": return `${t.stkError}: ${s.msg}`;
    default: return null;
  }
}

/** The "Send to Kindle" dialog: queue, metadata, devices. */
export function SendDialog({ lang, queue, onClose }: { lang: Lang; queue: Queue; onClose: () => void }) {
  const t = STR[lang];
  const { devErr, devices, showApp, setShowApp, shown, hiddenCount, picked, toggle, devNote, ready, pickFiles, pickCover, send } = useSendForm(lang, queue);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [onClose]);

  return (
    <div className="modal" onMouseDown={onClose}>
      <div className="stk" role="dialog" aria-label={t.stkTitle} onMouseDown={(e) => e.stopPropagation()}>
        <header className="stk__head">
          <div>
            <h2 className="stk__title">{t.stkTitle}</h2>
            <p className="stk__sub muted small">{t.stkSub}</p>
          </div>
          <button className="btn" onClick={pickFiles}>
            <Icon name="upload" size={17} />
            {t.stkAdd}
          </button>
          <button className="iconbtn" onClick={onClose} aria-label={t.closeReader} title={t.closeReader}>
            <Icon name="close" size={18} />
          </button>
        </header>

        <div className="stk__list">
          {queue.items.length === 0 && (
            <button className="stk__empty" onClick={pickFiles}>
              <Icon name="upload" size={28} />
              <span>{isAndroid ? t.stkEmptyMobile : t.stkEmpty}</span>
            </button>
          )}
          {queue.items.map((it) => (
            <QueueRow key={it.id} lang={lang} it={it} queue={queue} onCover={() => pickCover(it)} />
          ))}
        </div>

        <section className="stk__devices">
          <div className="stk__devhead">
            <h3>{t.stkDevices}</h3>
            {hiddenCount > 0 && (
              <button className="stk__link" onClick={() => setShowApp((v) => !v)}>
                {showApp ? t.stkHideApp : t.stkShowApp.replace("{0}", String(hiddenCount))}
              </button>
            )}
          </div>
          {devErr ? (
            <p className="stk__err small">{t.stkDevErr}</p>
          ) : devices == null ? (
            <p className="muted small">{t.loading}</p>
          ) : (
            <div className="stk__devlist">
              {shown.map((d) => (
                <label key={d.serial} className={`stk__dev${picked.includes(d.serial) ? " is-on" : ""}`}>
                  <input type="checkbox" checked={picked.includes(d.serial)} onChange={() => toggle(d.serial)} />
                  <span>{d.name}</span>
                </label>
              ))}
            </div>
          )}
          <p className="muted small stk__devnote">{devNote}</p>
        </section>

        <footer className="stk__foot">
          {queue.items.some((x) => x.status.k === "done") && (
            <button className="stk__link" onClick={queue.clearFinished}>
              {t.stkClearDone}
            </button>
          )}
          <span className="editor__spacer" />
          <button className="btn" onClick={onClose}>
            {t.stkClose}
          </button>
          <button className="btn btn--primary" onClick={send} disabled={!ready}>
            {ready ? t.stkSend.replace("{0}", String(ready)) : t.stkTitle}
          </button>
        </footer>
      </div>
    </div>
  );
}

function QueueRow({ lang, it, queue, onCover }: { lang: Lang; it: SendItem; queue: Queue; onCover: () => void }) {
  const t = STR[lang];
  const s = it.status;
  const editable = s.k === "ready" || s.k === "error" || s.k === "invalid";
  const cover = it.coverPreview ?? it.info.cover;
  const pct = s.k === "upload" && s.total ? Math.round((s.done / s.total) * 100) : null;
  const problems = it.info.problems.filter((p) => p !== "no_title" || !it.title.trim());

  const line = statusLine(t, s, pct);

  return (
    <div className={`stk__item stk__item--${s.k}`}>
      <button className="stk__cover" onClick={onCover} disabled={!editable} title={t.stkCover} aria-label={t.stkCover}>
        {cover ? <img src={cover} alt="" /> : <Icon name="book" size={22} />}
        {editable && (
          <span className="stk__cover-edit">
            <Icon name="image" size={14} />
          </span>
        )}
      </button>
      <div className="stk__fields">
        <input
          className="stk__input stk__input--title"
          value={it.title}
          onChange={(e) => queue.patch(it.id, { title: e.target.value })}
          placeholder={t.stkTitleField}
          aria-label={t.stkTitleField}
          disabled={!editable}
        />
        <input
          className="stk__input"
          value={it.author}
          onChange={(e) => queue.patch(it.id, { author: e.target.value })}
          placeholder={t.stkAuthorField}
          aria-label={t.stkAuthorField}
          disabled={!editable}
        />
        <div className="stk__meta muted small">
          {it.info.name} · {fmtSize(it.info.size)}
          {it.coverPath ? ` · ${t.stkNewCover}` : ""}
        </div>
        {problems.length > 0 && (
          <div className="stk__problems small">{problems.map((p) => t[`stkP_${p}` as keyof typeof t] ?? p).join(" · ")}</div>
        )}
        {line && (
          <div className="stk__status small">
            {(s.k === "prepare" || s.k === "send" || s.k === "converting") && <Icon name="refresh" size={13} className="icon--spin" />}
            {s.k === "done" && <Icon name="check" size={14} />}
            <span>{line}</span>
          </div>
        )}
        {s.k === "upload" && (
          <div className="stk__bar">
            <div style={{ width: `${pct ?? 0}%` }} />
          </div>
        )}
      </div>
      <div className="stk__actions">
        {s.k === "error" || s.k === "timeout" ? (
          <button className="stk__link" onClick={() => queue.retry(it.id)}>
            {t.kpushRetry}
          </button>
        ) : null}
        {editable || s.k === "done" || s.k === "timeout" ? (
          <button className="iconbtn" onClick={() => queue.remove(it.id)} aria-label={t.stkRemove} title={t.stkRemove}>
            <Icon name="close" size={16} />
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** Full-window hint while EPUB files are dragged over the app. */
export function DropOverlay({ lang }: { lang: Lang }) {
  const t = STR[lang];
  return (
    <div className="stkdrop" aria-hidden="true">
      <div className="stkdrop__box">
        <Icon name="upload" size={34} />
        <span>{t.stkDrop}</span>
      </div>
    </div>
  );
}
