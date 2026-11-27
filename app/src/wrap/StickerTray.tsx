import { useMemo, useState } from "react";
import { STR, type Lang } from "../i18n";
import { Icon } from "../icons";
import { badgeImg } from "../stats/BadgesCard";
import type { BadgeId } from "../stats/types";
import { isAndroid } from "../platform";
import { ICONS, iconUrl } from "./icons";
import type { StickerSpec } from "./iconRules";

/**
 * The list of stickers to add: the 3D icons (the ones this wrap's numbers call
 * for first, then the rest, filtered by tag) and the badges the reader has
 * earned. A bottom sheet on the phone, a popover over the side panel on the
 * desktop; the credit for the icons is its last line.
 */
export function StickerTray({ lang, relevant, badges, onPick, onClose }: {
  lang: Lang;
  relevant: readonly StickerSpec[];
  /** Badges the reader holds. */
  badges: readonly BadgeId[];
  onPick: (spec: StickerSpec) => void;
  onClose: () => void;
}) {
  const t = STR[lang];
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();

  const icons = useMemo(() => {
    const first = new Map(relevant.filter((s) => s.kind === "icon").map((s, i) => [s.ref, i]));
    const rank = (id: string) => first.get(id) ?? first.size;
    return ICONS.filter((i) => !q || i.id.includes(q) || i.tags.some((tag) => tag.includes(q))).sort((a, b) => rank(a.id) - rank(b.id));
  }, [relevant, q]);
  const shownBadges = badges.filter((id) => !q || id.includes(q) || t[`bd_${id}` as const].toLowerCase().includes(q));

  return (
    <>
      <button type="button" className="wt__backdrop" tabIndex={-1} aria-label={t.wrTrayClose} onClick={onClose} />
      <div className="wt" role="dialog" aria-label={t.wrTrayTitle}>
        <header className="wt__head">
          <h2>{t.wrTrayTitle}</h2>
          <button type="button" className="wv__round" onClick={onClose} aria-label={t.wrTrayClose}><Icon name="close" size={18} /></button>
        </header>
        <input
          className="wt__filter"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t.wrTrayFilter}
          aria-label={t.wrTrayFilter}
          autoFocus={!isAndroid}
        />
        <div className="wt__scroll">
          {icons.length > 0 && (
            <section aria-label={t.wrTrayIcons}>
              <h3>{t.wrTrayIcons}</h3>
              <ul>
                {icons.map((i) => (
                  <li key={i.id}>
                    <button type="button" aria-label={i.tags.slice(0, 2).join(", ")} onClick={() => onPick({ kind: "icon", ref: i.id })}>
                      <img src={iconUrl(i.id, 256) ?? ""} alt="" draggable={false} loading="lazy" />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {shownBadges.length > 0 && (
            <section aria-label={t.wrTrayBadges}>
              <h3>{t.wrTrayBadges}</h3>
              <ul>
                {shownBadges.map((id) => (
                  <li key={id}>
                    <button type="button" aria-label={t[`bd_${id}` as const]} onClick={() => onPick({ kind: "badge", ref: id })}>
                      <img src={badgeImg(id)} alt="" draggable={false} />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {icons.length === 0 && shownBadges.length === 0 && <p className="muted">{t.wrTrayNone}</p>}
        </div>
        <p className="wt__credit">{t.wrTrayCredit}</p>
      </div>
    </>
  );
}
