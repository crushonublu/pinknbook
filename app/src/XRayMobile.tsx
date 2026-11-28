/**
 * X-Ray on a phone: the cast list (main, minor, passing), a person's page
 * and the sheet that edits them. The desktop keeps `XRayPanel` / `XRayDetail`.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { STR, type Lang } from "./i18n";
import { Icon } from "./icons";
import { MobilePicker } from "./mobile/MobilePicker";
import { useMobileDismiss } from "./mobile/back";
import { Switch } from "./stats/Switch";
import { wikipediaSummary, type WikiSummary } from "./dictionary";
import { relKind, type RelKind } from "./graphLayout";
import { castOrder, groups, type CastGroup, type Tier } from "./xrayCast";
import { isFirstPerson, links, mentionContexts, pairKey, upTo, type Entity, type Link, type Mention, type XrType } from "./xrayIndex";
import { avatarColor, initialOf, MentionList, TYPE_COLOR, TYPE_ICON, type XrayState } from "./XRay";

/** Colours of the kinds of tie, the same in lists and maps (always with words beside them). */
export const KIND_COLOR: Record<RelKind, string> = {
  family: "#74c0fc",
  love: "#ff7aa0",
  social: "#8ce99a",
  conflict: "#ffc078",
  same: "#9aa3b2",
  none: "#6b7280",
};

/** The person the story turns around: the narrator, else the most important so far. */
export function centerOf(x: XrayState): Entity | null {
  const order = castOrder(x.cast);
  const people = order.map((k) => x.byKey.get(k)).filter((e): e is Entity => !!e && e.type === "person");
  return people.find((e) => e.narrator && x.cast.get(e.key)?.tier === "main") ?? people[0] ?? null;
}

/**
 * One side of a pair's label, the side that is `who` ("cha – con gái"
 * between Chris and Elizabeth: "cha" for Chris). Labels name the first
 * person of the pair first; the narrator's kin labels name the kin first.
 */
export function sideOf(x: XrayState, who: string, other: string): { text: string; kind: RelKind; from: "user" | "ai" | "auto" } | null {
  const key = pairKey(who, other);
  const lab = x.labelOf(key);
  if (!lab) return null;
  const kind = relKind(lab.text);
  if (kind === "same") return null;
  const bare = lab.text.replace(/\s*\([^)]*\)\s*$/, "").trim();
  const parts = bare.split(/\s+[–—-]\s+/);
  if (parts.length !== 2) return { text: bare, kind, from: lab.from };
  const first = lab.from === "auto" ? !x.byKey.get(who)?.narrator : key.split("\u0001")[0] === who;
  return { text: first ? parts[0] : parts[1], kind, from: lab.from };
}

/** The map's groups for the reader's place (the reader's moves, the AI's groups, then the rules). */
export function useCastGroups(x: XrayState): { groups: CastGroup[]; center: Entity | null } {
  return useMemo(() => {
    const center = centerOf(x);
    const gs = groups(x.ents, links(x.ents, x.limit), x.cast, x.limit, {
      center: center?.key ?? null,
      assign: x.edits.groups,
      ai: x.aiGroups,
      kindOf: (a, b) => relKind(x.labelOf(pairKey(a, b))?.text),
    });
    return { groups: gs, center };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [x.ents, x.limit, x.cast, x.edits.groups, x.aiGroups, x.labelOf, x.byKey]);
}

/** A group's name as the reader sees it. */
export function groupName(lang: Lang, x: XrayState, g: CastGroup): string {
  const t = STR[lang];
  const own = x.edits.groupNames?.[g.id];
  if (own) return own;
  switch (g.kind) {
    case "family":
      return t.mxGroupFamily.replace("{0}", g.label);
    case "narrator":
      return t.mxGroupNarrator;
    case "place":
      return t.mxGroupPlace.replace("{0}", g.label);
    case "others":
      return t.mxGroupOthers;
    default:
      return g.label;
  }
}

const cap = (s: string) => (s ? s[0].toLocaleUpperCase() + s.slice(1) : s);

/** The first clause of a description, at most ~8 words. */
function clause(s: string): string {
  const c = s.split(/[.;:!?]|,\s|\s[–—]\s/)[0].trim();
  const w = c.split(/\s+/);
  return w.length > 8 ? w.slice(0, 8).join(" ") + "…" : c;
}

/**
 * The short line under a person's name: what the AI wrote for it, else their
 * tie to the person the story turns around ("Cha của Elizabeth"), else the
 * start of the AI's description; nothing rather than a guess.
 */
export function roleLine(lang: Lang, x: XrayState, e: Entity, center: Entity | null): string {
  const t = STR[lang];
  const caption = x.captionOf?.(e.key);
  if (caption) return caption;
  if (center && center.key !== e.key) {
    const s = sideOf(x, e.key, center.key);
    if (s) return cap(t.mxRoleOf.replace("{0}", s.text).replace("{1}", center.name));
  }
  const d = x.descriptionOf(e.key);
  if (d) return clause(d);
  // A named tie to someone else ("Cháu của George Brook"), the most important first.
  if (e.type === "person") {
    for (const k of castOrder(x.cast)) {
      if (k === e.key || k === center?.key) continue;
      const s = sideOf(x, e.key, k);
      if (s) return cap(t.mxRoleOf.replace("{0}", s.text).replace("{1}", x.byKey.get(k)?.name ?? k));
    }
  }
  return "";
}

export function Avatar({ e, size = 40 }: { e: Entity; size?: number }) {
  if (e.type !== "person") {
    return (
      <span className="mx-av mx-av--type" style={{ width: size, height: size, ["--c" as string]: TYPE_COLOR[e.type] }} aria-hidden="true">
        <Icon name={TYPE_ICON[e.type]} size={Math.round(size * 0.45)} />
      </span>
    );
  }
  return (
    <span className="mx-av" style={{ width: size, height: size, background: avatarColor(e.key), fontSize: Math.round(size * 0.38) }} aria-hidden="true">
      {initialOf(e.name)}
    </span>
  );
}

export interface MobileXRayProps {
  lang: Lang;
  x: XrayState;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  view: any;
  bookTitle?: string;
  selected: string | null;
  onSelect: (key: string | null) => void;
  onOpenGraph: () => void;
  /** Open the map centred on someone. */
  onFocus?: (key: string) => void;
  formatPos: (f: number) => string;
  onGo: (m: Mention) => void;
  chapterOf?: (section: number) => string;
  openMention?: string | null;
  onOpenMention?: (key: string | null) => void;
  /** A line under the map card (the groups found, phase 4). */
  mapLine?: string;
}

/** The X-Ray sheet's content on a phone: the list, or one entity's page. */
export function MobileXRay(p: MobileXRayProps) {
  const { x, selected } = p;
  const entity = selected ? x.byKey.get(selected) ?? null : null;
  if (entity) return <MobileXRayDetail {...p} e={entity} />;
  return <MobileXRayList {...p} />;
}

type Tab = "person" | "place" | "term";

function MobileXRayList({ lang, x, bookTitle, onSelect, onOpenGraph, mapLine }: MobileXRayProps) {
  const t = STR[lang];
  const [tab, setTab] = useState<Tab>("person");
  const [q, setQ] = useState("");
  const [passingOpen, setPassingOpen] = useState(false);
  const [term, setTerm] = useState("");
  const center = useMemo(() => centerOf(x), [x]);
  const inTab = (e: Entity) => (tab === "term" ? e.type === "term" || e.type === "org" : e.type === tab);
  const counts = { person: 0, place: 0, term: 0 };
  for (const e of x.ents) counts[e.type === "org" ? "term" : (e.type as Tab)]++;

  const query = q.trim().toLowerCase();
  const tierOf = (e: Entity): Tier => x.cast.get(e.key)?.tier ?? "minor";
  const people = useMemo(() => {
    const order = castOrder(x.cast);
    const pos = new Map(order.map((k, i) => [k, i]));
    return x.ents.filter((e) => e.type === "person").sort((a, b) => (pos.get(a.key) ?? 1e9) - (pos.get(b.key) ?? 1e9));
  }, [x.ents, x.cast]);
  const matches = query ? x.ents.filter((e) => inTab(e) && e.forms.some((f) => f.toLowerCase().includes(query))) : [];

  const { groups: gs } = useCastGroups(x);
  const named = gs.filter((g) => g.kind !== "others").map((g) => groupName(lang, x, g));
  const groupLine = named.length ? t.mxMapGroups.replace("{0}", named.slice(0, 3).join(", ") + (named.length > 3 ? "…" : "")) : null;
  const scope = (x.wholeBook ? t.mxScopeWhole : t.mxScope).replace("{0}", bookTitle ?? "").replace("{1}", String(Math.round(x.here * 100)));
  const ties = links(x.ents, x.limit).length;

  const row = (e: Entity, line?: string) => {
    const n = upTo(e, x.limit).length;
    return (
      <li key={e.key}>
        <button className="mx-row" onClick={() => onSelect(e.key)}>
          <Avatar e={e} />
          <span className="mx-row__main">
            <span className="mx-row__name">{e.name}</span>
            {line && <span className="mx-row__line">{line}</span>}
          </span>
          <span className="mx-row__n">{n}</span>
        </button>
      </li>
    );
  };
  const chip = (e: Entity) => (
    <button key={e.key} className="mx-chip" onClick={() => onSelect(e.key)}>
      <span className="mx-chip__av" aria-hidden="true">{initialOf(e.name)}</span>
      {e.name}
    </button>
  );

  let body: ReactNode;
  if (query) {
    body = matches.length ? <ul className="mx-rows">{matches.map((e) => row(e, e.type === "person" ? roleLine(lang, x, e, center) : undefined))}</ul> : x.ready && <p className="rside__empty">{t.xrEmpty}</p>;
  } else if (tab === "person") {
    const main = people.filter((e) => tierOf(e) === "main");
    const minor = people.filter((e) => tierOf(e) === "minor");
    const passing = people.filter((e) => tierOf(e) === "passing");
    body = (
      <>
        {main.length > 0 && (
          <>
            <h4 className="mx-h">{t.mxTier_main}</h4>
            <ul className="mx-rows">{main.map((e) => row(e, roleLine(lang, x, e, center)))}</ul>
          </>
        )}
        {minor.length > 0 && (
          <>
            <h4 className="mx-h">{t.mxTier_minor}</h4>
            <div className="mx-chips">{minor.map(chip)}</div>
          </>
        )}
        {passing.length > 0 && (
          <>
            <button className="mx-fold" aria-expanded={passingOpen} onClick={() => setPassingOpen((v) => !v)}>
              <span>
                {t.mxPassingRow.replace("{0}", String(passing.length))}
                {!passingOpen && <span className="mx-fold__tag"> {t.mxHiddenTag}</span>}
              </span>
              <Icon name="chevronDown" size={16} className={passingOpen ? "mx-flip" : undefined} />
            </button>
            {passingOpen && <div className="mx-chips mx-chips--quiet">{passing.map(chip)}</div>}
          </>
        )}
        {x.ready && !people.length && <p className="rside__empty">{t.xrEmpty}</p>}
      </>
    );
  } else {
    const list = x.ents.filter(inTab);
    body = list.length ? <ul className="mx-rows">{list.map((e) => row(e, x.descriptionOf(e.key) ? clause(x.descriptionOf(e.key)!) : undefined))}</ul> : x.ready && <p className="rside__empty">{t.xrEmpty}</p>;
  }

  return (
    <div className="xr mx">
      <p className="mx-scope">{scope}</p>
      <div className="xr__types" role="tablist">
        {(["person", "place", "term"] as const).map((k) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "is-on" : ""} onClick={() => setTab(k)}>
            {t[`xr_${k}` as const]}
            <span>{counts[k]}</span>
          </button>
        ))}
      </div>
      <input className="xr__filter mx-search" type="search" value={q} placeholder={t.xrFilter} onChange={(e) => setQ(e.target.value)} spellCheck={false} />
      {x.progress != null && (
        <div className="xr__building">
          <span>{t.xrBuilding.replace("{0}", String(Math.round(x.progress * 100)))}</span>
          <div className="bsearch__progress">
            <i style={{ width: `${x.progress * 100}%` }} />
          </div>
        </div>
      )}
      <div className="mx-scroll">
        {tab === "person" && !query && x.ready && people.length > 1 && (
          <button className="mx-mapcard" onClick={onOpenGraph}>
            <span className="mx-mapcard__icon" aria-hidden="true">
              <Icon name="graph" size={22} />
            </span>
            <span className="mx-mapcard__main">
              <b>{t.mxMap}</b>
              <span>{mapLine ?? groupLine ?? t.mxMapSub.replace("{0}", String(people.length)).replace("{1}", String(ties))}</span>
            </span>
            <Icon name="chevronDown" size={16} className="mx-right" />
          </button>
        )}
        {body}
        <div className="mx-opts">
          <label className="mx-opt">
            <span>
              {t.xrWholeBook}
              <small>{t.mxSpoilerWarn}</small>
            </span>
            <Switch on={x.wholeBook} onChange={x.setWholeBook} />
          </label>
          {x.index?.forms.some((f) => f.role === "narrator") && (
            <label className="mx-opt">
              <span>{t.xrFirstPerson}</span>
              <Switch on={isFirstPerson(x.index, x.edits)} onChange={(v) => x.setEdits((ed) => ({ ...ed, firstPerson: v }))} />
            </label>
          )}
          {tab === "term" && (
            <input
              className="xr__filter"
              value={term}
              placeholder={t.xrAddTerm}
              onChange={(e) => setTerm(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && term.trim()) {
                  const v = term.trim();
                  x.setEdits((ed) => (ed.terms.includes(v) ? ed : { ...ed, terms: [...ed.terms, v] }));
                  setTerm("");
                }
              }}
            />
          )}
          {x.edits.hidden.length > 0 && (
            <button className="mx-link" onClick={() => x.setEdits((ed) => ({ ...ed, hidden: [] }))}>
              {t.xrHidden.replace("{0}", String(x.edits.hidden.length))} · {t.xrShowHidden}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Where someone appears over the whole book: what has been read is drawn,
 * what lies ahead is a blank, faded track (nothing about it is told), and a
 * mark says where the reader is.
 */
function BookSpread({ ms, here, limit, label }: { ms: Mention[]; here: number; limit: number; label: string }) {
  const N = 60;
  const cells = new Array(N).fill(0);
  for (const m of ms) if (m[4] <= limit + 1e-9) cells[Math.min(N - 1, Math.floor(m[4] * N))]++;
  const max = Math.max(1, ...cells);
  const at = Math.min(1, Math.max(0, here));
  return (
    <div className="mx-spread" aria-hidden="true">
      <div className="mx-spread__ahead" style={{ left: `${at * 100}%` }} />
      {cells.map((c, i) => (
        <i key={i} className={(i + 0.5) / N > at ? "is-ahead" : ""} style={{ left: `${(i / N) * 100}%`, height: c ? `${25 + (75 * c) / max}%` : 0 }} />
      ))}
      <span className="mx-spread__here" style={{ left: `${at * 100}%` }}>
        <span>{label}</span>
      </span>
    </div>
  );
}

const TIER_LABEL = (t: (typeof STR)[Lang], tier: Tier) => t[`mxTier_${tier}` as const];

function MobileXRayDetail({ lang, x, view, e, onSelect, onFocus, onOpenGraph, formatPos, onGo, chapterOf, openMention = null, onOpenMention }: MobileXRayProps & { e: Entity }) {
  const t = STR[lang];
  const ms = upTo(e, x.limit);
  const [about, setAbout] = useState<string | null>(null);
  const [wiki, setWiki] = useState<WikiSummary | null | "busy" | "none">(null);
  const [editing, setEditing] = useState(false);
  const center = useMemo(() => centerOf(x), [x]);
  const info = x.cast.get(e.key);

  useEffect(() => {
    setWiki(null);
    setAbout(null);
    let off = false;
    if (ms[0]) mentionContexts(view, [ms[0]]).then((c) => !off && setAbout(c[0] ?? null));
    return () => {
      off = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [e.key, view]);

  const rels: { other: Entity; link: Link }[] = useMemo(() => {
    if (e.type !== "person") return [];
    return links(x.ents, x.limit)
      .filter((l) => l.a === e.key || l.b === e.key)
      .map((l) => ({ other: x.byKey.get(l.a === e.key ? l.b : l.a)!, link: l }))
      .filter((r) => r.other && !x.cast.get(r.other.key)?.author)
      // Named ties first, then by how often the two appear together.
      .sort((a, b) => Number(!!x.labelOf(b.link.key)) - Number(!!x.labelOf(a.link.key)) || b.link.chunks.length - a.link.chunks.length)
      .slice(0, 6);
  }, [e, x]);

  const desc = x.descriptionOf(e.key);
  const line = e.type === "person" ? roleLine(lang, x, e, center) : "";
  const first = ms[0];
  const firstChap = first ? chapterOf?.(first[0]) : "";
  const appears = first
    ? firstChap
      ? t.mxAppears.replace("{0}", String(ms.length)).replace("{1}", firstChap).replace("{2}", formatPos(first[4]))
      : t.mxAppearsNoChap.replace("{0}", String(ms.length)).replace("{1}", formatPos(first[4]))
    : "";

  return (
    <div className="xr xr--detail mx mx-detail">
      <div className="mx-dhead">
        <button className="mx-iconbtn" onClick={() => onSelect(null)} aria-label={t.xrBack}>
          <Icon name="arrowL" size={18} />
        </button>
        <button className="mx-iconbtn" onClick={() => setEditing(true)} aria-label={t.mxEdit}>
          <Icon name="more" size={18} />
        </button>
      </div>
      <div className="mx-scroll">
        <div className="mx-title">
          <Avatar e={e} size={56} />
          <div className="mx-title__main">
            <h3>{e.name}</h3>
            <div className="mx-title__tags">
              {e.type === "person" && info ? (
                <span className={`mx-tier mx-tier--${info.tier}`}>{TIER_LABEL(t, info.tier)}</span>
              ) : (
                <span className="mx-tier">{t[`xr_${e.type}` as const]}</span>
              )}
              {line && <span className="mx-title__line">{line}</span>}
            </div>
          </div>
        </div>
        {appears && <p className="mx-appears">{appears}</p>}
        <BookSpread ms={e.mentions} here={x.here} limit={x.limit} label={t.mxHereMark} />

        <section className="mx-sec">
          <h4 className="mx-h">{t.xrAbout}</h4>
          {desc ? (
            <p className="mx-about">
              {desc} <span className="xr__badge">{t.xrAiBadge}</span>
            </p>
          ) : (
            about && <p className="mx-about mx-about--quote">{about}</p>
          )}
          {e.type !== "term" &&
            (wiki === null ? (
              <button
                className="mx-link"
                onClick={() => {
                  setWiki("busy");
                  wikipediaSummary(e.name, lang === "vi").then((w) => setWiki(w ?? "none")).catch(() => setWiki("none"));
                }}
              >
                {t.xrWiki}
              </button>
            ) : wiki === "busy" ? (
              <p className="xr__muted">{t.dcLoading}</p>
            ) : wiki === "none" ? (
              <p className="xr__muted">{t.dcNotFound.replace("{0}", e.name)}</p>
            ) : (
              <p className="mx-about">
                <b>{wiki.title}</b> — {wiki.extract}
              </p>
            ))}
        </section>

        {e.type === "person" && (
          <section className="mx-sec">
            <h4 className="mx-h">{t.xrRelations}</h4>
            {rels.length ? (
              <ul className="mx-rows">
                {rels.map(({ other, link }) => {
                  const s = sideOf(x, other.key, e.key);
                  return (
                    <li key={link.key}>
                      <button className="mx-row mx-row--rel" onClick={() => (onFocus ? onFocus(other.key) : onSelect(other.key))}>
                        <Avatar e={other} size={34} />
                        <span className="mx-row__main">
                          <span className="mx-row__name">{other.name}</span>
                        </span>
                        {s ? (
                          <span className="mx-rel" style={{ ["--k" as string]: KIND_COLOR[s.kind] }}>
                            {s.text}
                            {s.from === "ai" && <span className="xr__badge">{t.xrAiBadge}</span>}
                          </span>
                        ) : (
                          <span className="mx-row__n">{t.xrTogether.replace("{0}", String(link.chunks.length))}</span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="xr__muted">{t.xrNoRelations}</p>
            )}
            {rels.length > 0 && (
              <button className="mx-link" onClick={() => (onFocus ? onFocus(e.key) : onOpenGraph())}>
                {t.mxSeeOnMap}
              </button>
            )}
          </section>
        )}

        <section className="mx-sec">
          <h4 className="mx-h">{t.xrMentions}</h4>
          <MentionList
            key={e.key}
            lang={lang}
            view={view}
            ms={x.wholeBook ? e.mentions : ms}
            here={x.here}
            formatPos={formatPos}
            chapterOf={chapterOf}
            open={openMention}
            onOpen={(k) => onOpenMention?.(k)}
            onGo={onGo}
          />
        </section>
      </div>
      {editing && <XRayEditSheet lang={lang} x={x} e={e} onClose={() => setEditing(false)} onSelect={onSelect} />}
    </div>
  );
}

/** Everything that changes one entity, out of the way of reading (opened from •••). */
function XRayEditSheet({ lang, x, e, onClose, onSelect }: { lang: Lang; x: XrayState; e: Entity; onClose: () => void; onSelect: (key: string | null) => void }) {
  const t = STR[lang];
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(e.name);
  useMobileDismiss(true, onClose, true);
  const info = x.cast.get(e.key);
  const pinned = x.edits.tiers?.[e.key];
  const others = x.ents.filter((o) => o.key !== e.key && o.type === e.type).slice(0, 120);
  const { groups: gs } = useCastGroups(x);
  const moved = x.edits.groups?.[e.key];
  const autoGroup = moved ? null : gs.find((g) => g.members.includes(e.key));
  const host = document.querySelector<HTMLElement>(".reader") ?? document.body;

  const saveName = () => {
    const v = name.trim();
    if (v && v !== e.name) x.setEdits((ed) => ({ ...ed, names: { ...ed.names, [e.key]: v } }));
    setRenaming(false);
  };
  // The tier the rules (or the AI) give, to show beside "Automatic".
  const autoTier: Tier | null = info ? (pinned ? null : info.tier) : null;
  const tierOptions: { value: string; label: string }[] = [
    { value: "", label: autoTier ? t.mxTierAuto.replace("{0}", TIER_LABEL(t, autoTier)) : t.mxTierAutoBare },
    { value: "main", label: t.mxTier_main },
    { value: "minor", label: t.mxTier_minor },
    { value: "passing", label: t.mxTier_passing },
  ];

  return createPortal(
    <div className="mr-sheet-layer mx-edit-layer">
      <div className="mr-sheet-scrim" onClick={onClose} />
      <section className="mr-sheet mx-edit" role="dialog" aria-modal="true" aria-label={t.mxEditTitle.replace("{0}", e.name)}>
        <div className="mr-sheet__handle" aria-hidden="true">
          <span />
        </div>
        <div className="mx-edit__head">
          <h2>{t.mxEditTitle.replace("{0}", e.name)}</h2>
          <span>{t.mxEditNote}</span>
        </div>
        <div className="mr-sheet__content mx-edit__body">
          <div className="mx-edit__group">
            {renaming ? (
              <input autoFocus className="xr__filter" value={name} onChange={(ev) => setName(ev.target.value)} onBlur={saveName} onKeyDown={(ev) => ev.key === "Enter" && (ev.target as HTMLInputElement).blur()} />
            ) : (
              <button className="mx-edit__row" onClick={() => setRenaming(true)}>
                <span>{t.mxRename}</span>
                <span className="mx-edit__val">{e.name}</span>
              </button>
            )}
            <div className="mx-edit__row mx-edit__row--pick">
              <span>{t.mxType}</span>
              <MobilePicker
                label={t.mxType}
                value={e.type}
                options={(["person", "place", "org", "term"] as const).map((k) => ({ value: k, label: t[`xr_${k}` as const] }))}
                onChange={(type: XrType) => x.setEdits((ed) => ({ ...ed, types: { ...ed.types, [e.key]: type } }))}
              />
            </div>
            {e.type === "person" && (
              <div className="mx-edit__row mx-edit__row--pick">
                <span>{t.mxTier}</span>
                <MobilePicker
                  label={t.mxTier}
                  value={pinned ?? ""}
                  options={tierOptions}
                  onChange={(v: string) =>
                    x.setEdits((ed) => {
                      const tiers = { ...(ed.tiers ?? {}) };
                      if (v) tiers[e.key] = v as Tier;
                      else delete tiers[e.key];
                      return { ...ed, tiers };
                    })
                  }
                />
              </div>
            )}
            {e.type === "person" && x.cast.get(e.key)?.tier !== "passing" && gs.length > 0 && (
              <div className="mx-edit__row mx-edit__row--pick">
                <span>{t.mxGroup}</span>
                <MobilePicker
                  label={t.mxGroup}
                  value={moved ?? ""}
                  options={[
                    { value: "", label: autoGroup ? t.mxGroupAuto.replace("{0}", groupName(lang, x, autoGroup)) : t.mxTierAutoBare },
                    ...gs.filter((g) => g.kind !== "others").map((g) => ({ value: g.id, label: groupName(lang, x, g) })),
                  ]}
                  onChange={(v: string) =>
                    x.setEdits((ed) => {
                      const next = { ...(ed.groups ?? {}) };
                      if (v) next[e.key] = v;
                      else delete next[e.key];
                      return { ...ed, groups: next };
                    })
                  }
                />
              </div>
            )}
          </div>

          <div className="mx-edit__group mx-edit__group--forms">
            <span className="mx-edit__label">{t.mxFormsOf.replace("{0}", e.name)}</span>
            <div className="mx-chips">
              {e.forms.map((f) => (
                <span key={f} className="mx-chip mx-chip--form">
                  {f}
                  {f !== e.key && (
                    <button onClick={() => x.setEdits((ed) => ({ ...ed, merges: { ...ed.merges, [f]: f } }))} aria-label={`${t.xrSplit}: ${f}`}>
                      <Icon name="close" size={12} />
                    </button>
                  )}
                </span>
              ))}
            </div>
            <MobilePicker
              label={t.xrMergeInto}
              triggerLabel={t.mxMerge}
              value=""
              options={[{ value: "", label: t.xrMergeInto }, ...others.map((o) => ({ value: o.key, label: o.name }))]}
              onChange={(to: string) => {
                if (!to) return;
                x.setEdits((ed) => {
                  const merges = { ...ed.merges };
                  for (const f of e.forms) merges[f] = to;
                  return { ...ed, merges };
                });
                onClose();
                onSelect(to);
              }}
            />
          </div>

          <button
            className="mx-edit__hide"
            onClick={() => {
              x.setEdits((ed) => ({ ...ed, hidden: [...ed.hidden, e.key] }));
              onClose();
              onSelect(null);
            }}
          >
            <Icon name="trash" size={16} />
            {t.mxHide}
          </button>
          <button className="mx-edit__done" onClick={onClose}>
            {t.mxDone}
          </button>
        </div>
      </section>
    </div>,
    host,
  );
}
