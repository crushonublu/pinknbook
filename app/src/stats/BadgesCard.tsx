import { STR, type Lang } from "../i18n";
import { Icon } from "../icons";
import { fmt } from "./format";
import type { BadgeId, StatsSummary } from "./types";

const GROUPS: { key: "grpTime" | "grpBooks" | "grpMarks" | "grpHabits"; ids: BadgeId[] }[] = [
  { key: "grpTime", ids: ["streak", "hours", "big_day"] },
  { key: "grpBooks", ids: ["books", "fast_finish", "comeback"] },
  { key: "grpMarks", ids: ["highlights", "notes", "rainbow"] },
  { key: "grpHabits", ids: ["night_owl", "early_bird", "weekend", "variety"] },
];
export const TIER_KEYS = ["tierLocked", "tierBronze", "tierSilver", "tierGold", "tierDiamond"] as const;

export const badgeImg = (id: BadgeId) => `/badges/${id}.png`;

type Badge = StatsSummary["badges"][number];

/** Progress inside the current tier, 0..1 (1 at the top tier). */
const tierProgress = (b: Badge) => {
  const next = b.thresholds[b.tier] ?? null;
  const prev = b.tier ? b.thresholds[b.tier - 1] : 0;
  return next == null ? 1 : Math.min(1, (b.value - prev) / Math.max(1, next - prev));
};

/** Every badge in group order, as equal tiles with their progress. */
export function BadgeGrid({ lang, s }: { lang: Lang; s: StatsSummary }) {
  const t = STR[lang];
  return (
    <section className="stats__panel">
      <div className="stats__panelhead">
        <h2>{t.badges}</h2>
        <span className="muted small">{fmt(t.badgesEarned, s.badges.filter((b) => b.tier > 0).length, s.badges.length)}</span>
      </div>
      {/* One block of equal tiles in group order (the group is in the
          tooltip), centred so a short last row stays balanced. */}
      <div className="bgrid">
        {GROUPS.flatMap((g) =>
          g.ids.map((id) => {
            const b = s.badges.find((x) => x.id === id);
            if (!b) return null;
            const next = b.thresholds[b.tier] ?? null;
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
                      <i style={{ width: `${tierProgress(b) * 100}%` }} />
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
  );
}

/**
 * Badges as a row to scroll sideways, unlocked ones first; "see all" opens the
 * grid. On the desktop page (`grid`) every badge is shown at once, in group
 * order, each with its tier and progress.
 */
export function BadgesCard({ lang, s, onOpenAll, grid = false }: { lang: Lang; s: StatsSummary; onOpenAll?: () => void; grid?: boolean }) {
  const t = STR[lang];
  if (grid) {
    return (
      <section className="scx scx-badges scx-badges--grid">
        <div className="scx__row">
          <h2 className="scx__h2">{t.badges}</h2>
          <span className="scx__sub">{fmt(t.badgesEarned, s.badges.filter((b) => b.tier > 0).length, s.badges.length)}</span>
        </div>
        <div className="scx-badges__tiles">
          {GROUPS.flatMap((g) => g.ids).map((id) => {
            const b = s.badges.find((x) => x.id === id);
            if (!b) return null;
            const next = b.thresholds[b.tier] ?? null;
            const name = t[`bd_${id}` as const];
            return (
              <div key={id} className={`scx-badges__tile${b.tier === 0 ? " is-locked" : ""}`} title={`${name}
${t[`bdd_${id}` as const].replace("{0}", String(next ?? b.thresholds[3]))}`}>
                <span className="scx-badges__img">
                  <img src={badgeImg(id)} alt="" draggable={false} />
                  {b.tier === 0 && <Icon name="lock" size={11} />}
                </span>
                <span className="scx-badges__name">{name}</span>
                {next != null && (
                  <span className="scx-badges__prog" aria-label={`${b.value}/${next}`}>
                    <i style={{ width: `${tierProgress(b) * 100}%` }} />
                  </span>
                )}
                <small>{t[TIER_KEYS[b.tier]]}{next != null && ` · ${b.value}/${next}`}</small>
              </div>
            );
          })}
        </div>
      </section>
    );
  }
  const ordered = [...s.badges].sort((a, b) => (b.tier > 0 ? b.tier : -1 + tierProgress(b)) - (a.tier > 0 ? a.tier : -1 + tierProgress(a)));
  return (
    <section className="scx scx-badges">
      <div className="scx__row">
        <h2 className="scx__h2">{t.badges}</h2>
        <button className="scx__link" onClick={onOpenAll}>
          {fmt(t.sxSeeAllN, s.badges.filter((b) => b.tier > 0).length, s.badges.length)}
        </button>
      </div>
      <div className="scx-badges__list">
        {ordered.map((b) => {
          const next = b.thresholds[b.tier] ?? null;
          return (
            <button key={b.id} className={b.tier === 0 ? "is-locked" : undefined} onClick={onOpenAll}>
              <span className="scx-badges__img">
                <img src={badgeImg(b.id)} alt="" draggable={false} />
                {b.tier === 0 && <Icon name="lock" size={11} />}
              </span>
              <span className="scx-badges__name">{t[`bd_${b.id}`]}</span>
              <small>{b.tier === 0 ? t.tierLocked : next == null ? t[TIER_KEYS[b.tier]] : `${t[TIER_KEYS[b.tier]]} · ${b.value}/${next}`}</small>
              {next != null && (
                <span className="scx-badges__prog" aria-hidden="true">
                  <i style={{ width: `${tierProgress(b) * 100}%` }} />
                </span>
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}
