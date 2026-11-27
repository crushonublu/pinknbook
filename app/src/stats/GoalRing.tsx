import { STR, type Lang } from "../i18n";
import { fmt } from "./format";
import type { StatsSummary } from "./types";

const R = 52;
const CIRCUMFERENCE = 2 * Math.PI * R;

/** Today's minutes against the daily goal as a ring (green once reached), the minutes in the middle. Sized by its parent's CSS. */
export function GoalRing({ lang, s }: { lang: Lang; s: StatsSummary }) {
  const t = STR[lang];
  const goal = s.goal_minutes;
  const sec = s.today_app_sec + s.today_kindle_sec;
  const min = Math.floor(sec / 60);
  return (
    <div className="scx-ring" role="img" aria-label={fmt(t.todayOf, min, goal)}>
      <svg viewBox="0 0 120 120" aria-hidden="true">
        <circle cx="60" cy="60" r={R} className="scx-ring__track" />
        <circle cx="60" cy="60" r={R} className={`scx-ring__fill${min >= goal ? " is-done" : ""}`} strokeDasharray={`${CIRCUMFERENCE * Math.min(1, sec / (goal * 60))} ${CIRCUMFERENCE}`} />
      </svg>
      <div><b>{min}′</b><small>/ {goal}′</small></div>
    </div>
  );
}
