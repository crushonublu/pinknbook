import { STR, type Lang } from "../i18n";
import { Icon } from "../icons";
import { AnchoredPopover } from "./AnchoredPopover";
import { fmt } from "./format";
import { GoalRing } from "./GoalRing";
import { StreakLine } from "./StreakLine";
import { secOfDay } from "./streak";
import type { StatsSummary } from "./types";
import { WeekDots } from "./WeekDots";

/**
 * The title-bar streak button's popover: today's ring, the streak and what is
 * left of today's goal, the week, the longest streak and the shield, and a
 * button to the Stats page.
 */
export function StreakPopover({ lang, s, anchor, onClose, onOpenStats }: {
  lang: Lang;
  s: StatsSummary;
  anchor: HTMLElement;
  onClose: () => void;
  onOpenStats: () => void;
}) {
  const t = STR[lang];
  const [lead, tail] = t.sxHomeStreak.split("{0}");
  const [before, after] = t.longest.split("{0}");
  return (
    <AnchoredPopover anchor={anchor} label={t.pcStreakTitle} onClose={onClose} align="end" className="spop--streak">
      <div className="spop-streak__head">
        <GoalRing lang={lang} s={s} />
        <div className="spop-streak__text">
          <span className="spop-streak__title">
            {s.streak.current > 0 ? <>{lead}<span>{s.streak.current}</span>{tail}</> : t.sxHomeNone}
          </span>
          <span className="spop-streak__sub"><StreakLine lang={lang} s={s} /></span>
        </div>
      </div>
      <WeekDots lang={lang} today={s.today} goalSec={s.goal_minutes * 60} secOf={secOfDay(s)} />
      <div className="spop-streak__foot">
        <span>{before}<b>{fmt(t.streakDays, s.streak.longest)}</b>{after}</span>
        <span className={s.streak.freeze_left ? "is-shield" : undefined}>{s.streak.freeze_left ? t.sxShieldLeft : t.sxShieldUsed}</span>
      </div>
      <button className="spop-streak__open" onClick={onOpenStats}>
        {t.pcOpenStats}
        <Icon name="arrowR" size={16} />
      </button>
    </AnchoredPopover>
  );
}
