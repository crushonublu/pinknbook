import { MobilePicker } from "./mobile/MobilePicker";
import { isAndroid } from "./platform";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { STR, type Lang } from "./i18n";
import { Icon } from "./icons";

/** src-tauri/src/stats.rs `Summary`. */
export interface StatsSummary {
  today: string;
  goal_minutes: number;
  kindle_estimates: boolean;
  today_app_sec: number;
  today_kindle_sec: number;
  streak: { current: number; longest: number; today_done: boolean; freeze_left: boolean };
  days: { day: string; app_sec: number; kindle_sec: number; merged: boolean }[];
  total_seconds: number;
  books_finished: number;
  speed: number;
  top_books: { asin: string; title: string; seconds: number }[];
  badges: { id: BadgeId; tier: number; value: number; thresholds: number[] }[];
  unlocked: { id: BadgeId; tier: number }[];
  backfilled: number;
}

export type BadgeId =
  | "streak" | "hours" | "big_day" | "books" | "fast_finish" | "comeback" | "highlights"
  | "notes" | "rainbow" | "night_owl" | "early_bird" | "weekend" | "variety";

const GROUPS: { key: "grpTime" | "grpBooks" | "grpMarks" | "grpHabits"; ids: BadgeId[] }[] = [
  { key: "grpTime", ids: ["streak", "hours", "big_day"] },
  { key: "grpBooks", ids: ["books", "fast_finish", "comeback"] },
  { key: "grpMarks", ids: ["highlights", "notes", "rainbow"] },
  { key: "grpHabits", ids: ["night_owl", "early_bird", "weekend", "variety"] },
];
const TIER_KEYS = ["tierLocked", "tierBronze", "tierSilver", "tierGold", "tierDiamond"] as const;
/** How often Kindle reading is estimated while the app is open. */
const KINDLE_EVERY_MS = 30 * 60_000;

const badgeImg = (id: BadgeId) => `/badges/${id}.png`;

export type Toast = { key: string; id: BadgeId | "backfill"; tier: number; count?: number };

/** Stats for the whole app: refreshed on demand, Kindle estimates on a timer. */
export function useStats(signedIn: boolean) {
  const [summary, setSummary] = useState<StatsSummary | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const refresh = useCallback(async () => {
    try {
      const s = await invoke<StatsSummary>("stats_summary");
      setSummary(s);
      const fresh: Toast[] = s.unlocked.map((u) => ({ key: `${u.id}-${u.tier}-${Date.now()}`, id: u.id, tier: u.tier }));
      if (s.backfilled) fresh.push({ key: `bf-${Date.now()}`, id: "backfill", tier: 0, count: s.backfilled });
      if (fresh.length) setToasts((t) => [...t, ...fresh]);
    } catch (e) {
      console.error(e);
    }
  }, []);

  useEffect(() => {
    if (!signedIn) return;
    let stop = false;
    const tick = () =>
      invoke<number>("kindle_activity_tick")
        .catch(() => 0)
        .then(() => {
          if (!stop) refresh();
        });
    refresh();
    const first = window.setTimeout(tick, 4000);
    const iv = window.setInterval(tick, KINDLE_EVERY_MS);
    return () => {
      stop = true;
      window.clearTimeout(first);
      window.clearInterval(iv);
    };
  }, [signedIn, refresh]);

  const dismiss = useCallback((key: string) => setToasts((t) => t.filter((x) => x.key !== key)), []);
  return { summary, refresh, toasts, dismiss };
}

/** Title-bar flame: streak days and a ring for today's goal. */
export function StreakButton({ lang, s, onClick }: { lang: Lang; s: StatsSummary | null; onClick: () => void }) {
  const t = STR[lang];
  const mins = s ? Math.floor((s.today_app_sec + s.today_kindle_sec) / 60) : 0;
  const goal = s?.goal_minutes ?? 10;
  const p = Math.min(1, mins / goal);
  const r = 13;
  const c = 2 * Math.PI * r;
  const label = s
    ? `${t.streakDays.replace("{0}", String(s.streak.current))} · ${t.todayOf.replace("{0}", String(mins)).replace("{1}", String(goal))}`
    : t.stats;
  return (
    <button className={`streakbtn${s?.streak.today_done ? " is-done" : ""}${s && s.streak.current > 0 ? " has-streak" : ""}`} onClick={onClick} title={label} aria-label={label}>
      <span className="streakbtn__badge">
        <svg className="streakbtn__ring" viewBox="0 0 32 32" aria-hidden="true">
          <circle cx="16" cy="16" r={r} className="streakbtn__track" />
          <circle cx="16" cy="16" r={r} className="streakbtn__fill" strokeDasharray={`${c * p} ${c}`} />
        </svg>
        <Icon name="flame" size={16} />
      </span>
      <span className="streakbtn__n">{s?.streak.current ?? 0}</span>
    </button>
  );
}

function fmtDuration(lang: Lang, sec: number) {
  const t = STR[lang];
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h ? t.durHM.replace("{0}", String(h)).replace("{1}", String(m)) : t.durM.replace("{0}", String(m));
}

const parseDay = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
};
const dayKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** The Stats page. */
export function StatsPage({
  lang,
  s,
  onBack,
  onChanged,
}: {
  lang: Lang;
  s: StatsSummary | null;
  onBack: () => void;
  onChanged: () => void;
}) {
  const t = STR[lang];
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const pageRef = useRef<HTMLDivElement>(null);

  const byDay = useMemo(() => new Map((s?.days ?? []).map((d) => [d.day, d])), [s]);

  if (!s) {
    return (
      <div className="stats">
        <div className="center muted">{t.loading}</div>
      </div>
    );
  }
  const goal = s.goal_minutes;
  const todayMin = Math.floor((s.today_app_sec + s.today_kindle_sec) / 60);

  async function setSettings(p: { goalMinutes?: number; kindleEstimates?: boolean }) {
    await invoke("set_stats_settings", p).catch(() => undefined);
    onChanged();
  }

  function showTip(e: React.MouseEvent, text: string) {
    const box = pageRef.current!.getBoundingClientRect();
    setTip({ x: e.clientX - box.left, y: e.clientY - box.top + pageRef.current!.scrollTop, text });
  }
  function dayText(key: string) {
    const d = byDay.get(key);
    const date = parseDay(key).toLocaleDateString(lang === "vi" ? "vi-VN" : "en-US", { weekday: "short", day: "numeric", month: "numeric" });
    if (!d) return `${date}: ${t.noReading}`;
    const total = Math.round((d.app_sec + d.kindle_sec) / 60);
    const parts = [t.tipApp.replace("{0}", String(Math.round(d.app_sec / 60)))];
    if (d.kindle_sec) parts.push(t.tipKindle.replace("{0}", String(Math.round(d.kindle_sec / 60))) + (d.merged ? ` (${t.merged})` : ""));
    return `${date}: ${t.minutesN.replace("{0}", String(total))} — ${parts.join(", ")}`;
  }

  // Heatmap: 53 weeks ending with this week, Monday first.
  const today = parseDay(s.today);
  const start = new Date(today);
  start.setDate(start.getDate() - ((today.getDay() + 6) % 7) - 52 * 7);
  const weeks: { key: string; date: Date }[][] = [];
  for (let w = 0; w < 53; w++) {
    const col = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + w * 7 + i);
      col.push({ key: dayKey(d), date: d });
    }
    weeks.push(col);
  }
  const level = (key: string) => {
    const d = byDay.get(key);
    if (!d) return 0;
    const m = (d.app_sec + d.kindle_sec) / 60;
    if (m < 1) return 0;
    if (m < goal / 2) return 1;
    if (m < goal) return 2;
    if (m < goal * 2) return 3;
    return 4;
  };
  const months: { col: number; label: string }[] = [];
  weeks.forEach((col, i) => {
    const first = col.find((c) => c.date.getDate() === 1);
    if (first) months.push({ col: i, label: first.date.toLocaleDateString(lang === "vi" ? "vi-VN" : "en-US", { month: "short" }) });
  });

  // Last 30 days, stacked: in-app (bottom) and Kindle estimate (top).
  const last30 = Array.from({ length: 30 }, (_, i) => {
    const d = new Date(today);
    d.setDate(today.getDate() - 29 + i);
    const k = dayKey(d);
    const v = byDay.get(k);
    return { key: k, date: d, app: (v?.app_sec ?? 0) / 60, kin: (v?.kindle_sec ?? 0) / 60 };
  });
  const maxMin = Math.max(goal * 1.25, ...last30.map((d) => d.app + d.kin));
  const yMax = Math.ceil(maxMin / 10) * 10;
  const W = 600;
  const H = 160;
  const bw = W / 30;
  const y = (m: number) => H - (m / yMax) * H;

  return (
    <div className="stats" ref={pageRef}>
      <header className="stats__head">
        <button className="reader__back stats__back" onClick={onBack}>
          <Icon name="arrowL" size={17} />
          <span>{t.backToLibrary}</span>
        </button>
        <h1>{t.stats}</h1>
        <span className="editor__spacer" />
        <label className="stats__goal">
          <span>{t.dailyGoal}</span>
          {isAndroid ? <MobilePicker label={t.dailyGoal} value={goal} options={[5, 10, 15, 20, 30, 45, 60, 90, 120].map((g) => ({ value: g, label: t.minutesN.replace("{0}", String(g)) }))} onChange={(g) => setSettings({ goalMinutes: g })} /> : (<select className="select" value={goal} onChange={(e) => setSettings({ goalMinutes: Number(e.target.value) })}>
            {[5, 10, 15, 20, 30, 45, 60, 90, 120].map((g) => (
              <option key={g} value={g}>
                {t.minutesN.replace("{0}", String(g))}
              </option>
            ))}
          </select>)}
        </label>
        <label className="stats__toggle" title={t.kindleEstHint}>
          <input type="checkbox" checked={s.kindle_estimates} onChange={(e) => setSettings({ kindleEstimates: e.target.checked })} />
          <span>{t.kindleEst}</span>
        </label>
      </header>

      <section className="stats__cards">
        <div className="scard">
          <TodayRing value={todayMin} goal={goal} />
          <div>
            <div className="scard__label">{t.today}</div>
            <div className="scard__big">{t.todayOf.replace("{0}", String(todayMin)).replace("{1}", String(goal))}</div>
            {s.today_kindle_sec > 0 && (
              <div className="scard__sub">{t.ofWhichEst.replace("{0}", String(Math.round(s.today_kindle_sec / 60)))}</div>
            )}
          </div>
        </div>
        <div className={`scard scard--streak${s.streak.today_done ? " is-done" : ""}`}>
          <span className="scard__icon"><Icon name="flame" size={26} /></span>
          <div>
            <div className="scard__label">{t.streak}</div>
            <div className="scard__big">{t.streakDays.replace("{0}", String(s.streak.current))}</div>
            <div className="scard__sub">{t.longest.replace("{0}", String(s.streak.longest))}</div>
          </div>
          <span
            className={`freeze-chip${s.streak.freeze_left ? " is-on" : ""}`}
            title={s.streak.freeze_left ? t.freezeLeft : t.freezeUsed}
            aria-label={s.streak.freeze_left ? t.freezeLeft : t.freezeUsed}
          >
            <Icon name="snow" size={15} />
          </span>
        </div>
        <div className="scard">
          <span className="scard__icon"><Icon name="clock" size={24} /></span>
          <div>
            <div className="scard__label">{t.totalTime}</div>
            <div className="scard__big">{fmtDuration(lang, s.total_seconds)}</div>
          </div>
        </div>
        <div className="scard">
          <span className="scard__icon"><Icon name="book" size={24} /></span>
          <div>
            <div className="scard__label">{t.booksDone}</div>
            <div className="scard__big">{s.books_finished}</div>
          </div>
        </div>
      </section>

      <section className="stats__panel">
        <div className="stats__panelhead">
          <h2>{t.yearOfReading}</h2>
          <div className="hm-legend" aria-hidden="true">
            <span>{t.less}</span>
            {[0, 1, 2, 3, 4].map((l) => (
              <i key={l} className={`hm-cell hm-l${l}`} />
            ))}
            <span>{t.more}</span>
            <i className="hm-cell hm-l2 hm-est" />
            <span>{t.estOnly}</span>
          </div>
        </div>
        <div className="hm" onMouseLeave={() => setTip(null)}>
          <div className="hm-months">
            {months.map((m) => (
              <span key={m.col} style={{ gridColumn: m.col + 1 }}>
                {m.label}
              </span>
            ))}
          </div>
          <div className="hm-grid" role="img" aria-label={t.yearOfReading}>
            {weeks.map((col, wi) => (
              <div key={wi} className="hm-col">
                {col.map((c) => {
                  const d = byDay.get(c.key);
                  const future = c.date > today;
                  const est = d && d.app_sec < 60 && d.kindle_sec > 0;
                  return (
                    <i
                      key={c.key}
                      className={`hm-cell hm-l${level(c.key)}${est ? " hm-est" : ""}${future ? " hm-future" : ""}${c.key === s.today ? " hm-today" : ""}`}
                      onMouseMove={(e) => !future && showTip(e, dayText(c.key))}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </section>

      <div className="stats__row">
        <section className="stats__panel stats__panel--grow">
          <div className="stats__panelhead">
            <h2>{t.last30}</h2>
            <div className="bar-legend">
              <span><i className="sw sw-app" />{t.inApp}</span>
              <span><i className="sw sw-est" />{t.kindleEstShort}</span>
              <span><i className="sw sw-goal" />{t.dailyGoal}</span>
            </div>
          </div>
          <svg className="bars" viewBox={`0 0 ${W} ${H + 18}`} onMouseLeave={() => setTip(null)} role="img" aria-label={t.last30}>
            <line className="bars__goal" x1="0" x2={W} y1={y(goal)} y2={y(goal)} />
            {last30.map((d, i) => {
              const x = i * bw + 3;
              const w = bw - 6;
              const appH = H - y(d.app);
              const kinH = H - y(d.kin);
              return (
                <g key={d.key} onMouseMove={(e) => showTip(e, dayText(d.key))}>
                  <rect className="bars__hit" x={i * bw} y={0} width={bw} height={H} />
                  {d.app > 0 && <rect className="bars__app" x={x} y={H - appH} width={w} height={Math.max(appH, 2)} rx="3" />}
                  {d.kin > 0 && (
                    <rect className="bars__est" x={x} y={H - appH - kinH - (d.app > 0 ? 2 : 0)} width={w} height={Math.max(kinH, 2)} rx="3" />
                  )}
                  {(i % 5 === 4 || i === 29) && (
                    <text className="bars__x" x={i * bw + bw / 2} y={H + 14} textAnchor="middle">
                      {d.date.getDate()}/{d.date.getMonth() + 1}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        </section>
        <section className="stats__panel stats__panel--side">
          <h2>{t.topBooks}</h2>
          {s.top_books.length ? (
            <ol className="topbooks">
              {s.top_books.map((b) => (
                <li key={b.asin}>
                  <span className="topbooks__title">{b.title || b.asin}</span>
                  <span className="topbooks__bar">
                    <i style={{ width: `${(b.seconds / s.top_books[0].seconds) * 100}%` }} />
                  </span>
                  <span className="topbooks__time">{fmtDuration(lang, b.seconds)}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="muted small">{t.noReadingYet}</p>
          )}
        </section>
      </div>

      <section className="stats__panel">
        <div className="stats__panelhead">
          <h2>{t.badges}</h2>
          <span className="muted small">
            {t.badgesEarned.replace("{0}", String(s.badges.filter((b) => b.tier > 0).length)).replace("{1}", String(s.badges.length))}
          </span>
        </div>
        {/* One block of equal tiles in group order (the group is in the
            tooltip), centred so a short last row stays balanced. */}
        <div className="bgrid">
        {GROUPS.flatMap((g) =>
              g.ids.map((id) => {
                const b = s.badges.find((x) => x.id === id);
                if (!b) return null;
                const next = b.thresholds[b.tier] ?? null;
                const prev = b.tier ? b.thresholds[b.tier - 1] : 0;
                const p = next == null ? 1 : Math.min(1, (b.value - prev) / Math.max(1, next - prev));
                return (
                  <div
                    key={id}
                    className={`bcard bcard--t${b.tier}`}
                    title={`${t[`bd_${id}` as const]} · ${t[TIER_KEYS[b.tier]]} (${t[g.key]})\n${t[`bdd_${id}` as const].replace("{0}", String(next ?? b.thresholds[3]))}`}
                  >
                    <div className="bcard__img">
                      <img src={badgeImg(id)} alt="" draggable={false} />
                      {b.tier === 0 && <span className="bcard__lock"><Icon name="lock" size={12} /></span>}
                    </div>
                    <div className="bcard__name">{t[`bd_${id}` as const]}</div>
                    {next == null ? (
                      <div className="bcard__val bcard__val--max">{t[TIER_KEYS[b.tier]]}</div>
                    ) : (
                      <>
                        <div className="bcard__prog" aria-label={`${b.value}/${next}`}>
                          <i style={{ width: `${p * 100}%` }} />
                        </div>
                        <div className="bcard__val">
                          {b.value}/{next}
                        </div>
                      </>
                    )}
                  </div>
                );
              }),
        )}
        </div>
      </section>

      {tip && (
        <div className="stats__tip" style={{ left: tip.x, top: tip.y }}>
          {tip.text}
        </div>
      )}
    </div>
  );
}

function TodayRing({ value, goal }: { value: number; goal: number }) {
  const r = 24;
  const c = 2 * Math.PI * r;
  const p = Math.min(1, value / goal);
  return (
    <svg className={`tring${p >= 1 ? " is-done" : ""}`} viewBox="0 0 60 60" aria-hidden="true">
      <circle cx="30" cy="30" r={r} className="tring__track" />
      <circle cx="30" cy="30" r={r} className="tring__fill" strokeDasharray={`${c * p} ${c}`} />
    </svg>
  );
}

/** Badge unlocks: one card at a time in the corner, never blocking. */
export function BadgeToasts({
  lang,
  toasts,
  onDismiss,
  onOpen,
}: {
  lang: Lang;
  toasts: Toast[];
  onDismiss: (key: string) => void;
  onOpen: () => void;
}) {
  const t = STR[lang];
  const cur = toasts[0];
  useEffect(() => {
    if (!cur) return;
    const h = window.setTimeout(() => onDismiss(cur.key), 6500);
    return () => window.clearTimeout(h);
  }, [cur, onDismiss]);
  if (!cur) return null;
  return (
    <div className="btoast" role="status" key={cur.key}>
      <button
        className="btoast__main"
        onClick={() => {
          onDismiss(cur.key);
          onOpen();
        }}
      >
        <span className={`btoast__img bcard--t${cur.tier}`}>
          <img src={cur.id === "backfill" ? badgeImg("books") : badgeImg(cur.id)} alt="" />
        </span>
        <span className="btoast__text">
          <span className="btoast__kicker">{cur.id === "backfill" ? t.badges : t.badgeUnlocked}</span>
          <span className="btoast__name">
            {cur.id === "backfill"
              ? t.backfillNote.replace("{0}", String(cur.count ?? 0))
              : `${t[`bd_${cur.id}` as const]} · ${t[TIER_KEYS[cur.tier]]}`}
          </span>
        </span>
      </button>
      <button className="btoast__x" onClick={() => onDismiss(cur.key)} aria-label={t.closeReader}>
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}
