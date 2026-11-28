/**
 * The relationship map on a phone, in three views:
 * - by group (the default): a poster, the central characters on top and
 *   the groups below them (families, organisations, places), each person
 *   with a short line on who they are; no lines between people;
 * - in focus: one person in the middle and their direct ties around them;
 * - as a list of ties by kind ("A là cha của B").
 * The desktop keeps the free-form map (XRayGraph).
 */
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { STR, type Lang } from "./i18n";
import { Icon } from "./icons";
import { MobileReaderSheet } from "./mobile/MobileReaderSheet";
import { useMobileDismiss } from "./mobile/back";
import { Switch } from "./stats/Switch";
import { KIND_ORDER, radialLayout, relKind, type RelKind, type RingNode } from "./graphLayout";
import { castOrder, type CastGroup } from "./xrayCast";
import { links, pairKey, upTo, type Entity, type Link } from "./xrayIndex";
import { avatarColor, initialOf, mergeAsOne, type XrayState } from "./XRay";
import { AiButton, EdgePanel, type AiProvider } from "./XRayGraph";
import { Avatar, groupName, KIND_COLOR, roleLine, sideOf, useCastGroups } from "./XRayMobile";

/** People shown per group before "+N" (unless the supporting cast is switched on). */
const PER_FRAME = 4;
/** A tie this strong (passages together) counts as close. */
const CLOSE = 3;

let measureCtx: CanvasRenderingContext2D | null = null;
function textW(s: string, font: string): number {
  measureCtx ??= document.createElement("canvas").getContext("2d");
  if (!measureCtx) return s.length * 7;
  measureCtx.font = font;
  return Math.ceil(measureCtx.measureText(s).width);
}

/** "{a} là {side} của {b}" with the names in bold. */
function sentence(tpl: string, parts: Record<string, ReactNode>): ReactNode[] {
  return tpl.split(/(\{a\}|\{b\}|\{side\})/).map((p, i) => {
    const k = p.slice(1, -1);
    return p.startsWith("{") && k in parts ? <span key={i}>{parts[k]}</span> : p;
  });
}

export function MobileRelationMap({
  lang,
  x,
  view,
  title,
  provider,
  initialFocus = null,
  onClose,
  onOpenEntity,
}: {
  lang: Lang;
  x: XrayState;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  view: any;
  title: string;
  provider: AiProvider;
  initialFocus?: string | null;
  onClose: () => void;
  onOpenEntity: (key: string) => void;
}) {
  const t = STR[lang];
  const [tab, setTab] = useState<"groups" | "list">("groups");
  const [trail, setTrail] = useState<string[]>(initialFocus ? [initialFocus] : []);
  const [showMinor, setShowMinor] = useState(false);
  const [opened, setOpened] = useState<Set<string>>(() => new Set());
  const [settings, setSettings] = useState(false);
  const [groupSheet, setGroupSheet] = useState<string | null>(null);
  const [moreSheet, setMoreSheet] = useState(false);
  const [edgeKey, setEdgeKey] = useState<string | null>(null);
  const focus = trail[trail.length - 1] ?? null;

  useMobileDismiss(true, () => {
    if (document.querySelector("[data-mobile-picker]")) return;
    if (edgeKey) setEdgeKey(null);
    else if (groupSheet) setGroupSheet(null);
    else if (moreSheet) setMoreSheet(false);
    else if (settings) setSettings(false);
    else if (trail.length) setTrail((tr) => tr.slice(0, -1));
    else onClose();
  });

  const { groups: gs, center } = useCastGroups(x);
  const allLinks = useMemo(() => links(x.ents, x.limit), [x.ents, x.limit]);
  const linkOf = useMemo(() => new Map(allLinks.map((l) => [l.key, l])), [allLinks]);
  const weight = (a: string, b: string) => linkOf.get(pairKey(a, b))?.chunks.length ?? 0;
  const inMap = (k: string) => {
    const c = x.cast.get(k);
    return !!c && !c.author && x.byKey.get(k)?.type === "person";
  };

  // The one or two the story turns around.
  const centers = useMemo(() => {
    if (!center) return [] as Entity[];
    const c0 = x.cast.get(center.key)!;
    const partner = allLinks
      .filter((l) => (l.a === center.key || l.b === center.key) && inMap(l.a === center.key ? l.b : l.a))
      .map((l) => x.byKey.get(l.a === center.key ? l.b : l.a)!)
      .find((e) => x.cast.get(e.key)?.tier === "main");
    const second = partner && x.cast.get(partner.key)!.score >= 0.6 * c0.score ? partner : null;
    return second ? [center, second] : [center];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [center, allLinks, x.cast, x.byKey]);
  const centerKeys = new Set(centers.map((e) => e.key));

  const edge = edgeKey ? linkOf.get(edgeKey) ?? null : null;
  const name = (k: string) => x.byKey.get(k)?.name ?? k;
  const scope = x.wholeBook ? t.xrWholeBook : t.xrUpToHere.replace("{0}", String(Math.round(x.here * 100)));
  const push = (k: string) => setTrail((tr) => (tr[tr.length - 1] === k ? tr : [...tr.filter((v) => v !== k), k]));

  return (
    <div className="xrg xrm" role="dialog" aria-label={t.mxMap}>
      <header className="xrm-head">
        <div className="xrm-head__row">
          <button className="mx-iconbtn" onClick={() => (trail.length ? setTrail((tr) => tr.slice(0, -1)) : onClose())} aria-label={t.xrBack}>
            <Icon name="arrowL" size={18} />
          </button>
          <div className="xrm-head__title">
            <h2>{t.mxMap}</h2>
            <span>
              {title} · {scope}
            </span>
          </div>
          <button className="mx-iconbtn" onClick={() => setSettings(true)} aria-label={t.mxSettings}>
            <Icon name="more" size={18} />
          </button>
        </div>
        {focus ? (
          <nav className="xrm-trail" aria-label={t.mxTrail}>
            <button onClick={() => setTrail([])}>
              <Icon name="graph" size={14} />
              {tab === "groups" ? t.mxByGroup : t.mxAsList}
            </button>
            {trail.map((k, i) => {
              const e = x.byKey.get(k);
              const last = i === trail.length - 1;
              return (
                <span key={k} className="xrm-trail__step">
                  <Icon name="chevronDown" size={12} className="mx-right" />
                  <button aria-current={last ? "page" : undefined} className={last ? "is-on" : ""} onClick={() => setTrail(trail.slice(0, i + 1))}>
                    {e && (
                      <span className="xrm-trail__av" style={{ background: avatarColor(e.key) }}>
                        {initialOf(e.name)}
                      </span>
                    )}
                    {name(k)}
                  </button>
                </span>
              );
            })}
          </nav>
        ) : (
          <div className="xr__types xrm-tabs" role="tablist">
            <button role="tab" aria-selected={tab === "groups"} className={tab === "groups" ? "is-on" : ""} onClick={() => setTab("groups")}>
              {t.mxByGroup}
            </button>
            <button role="tab" aria-selected={tab === "list"} className={tab === "list" ? "is-on" : ""} onClick={() => setTab("list")}>
              {t.mxAsList}
            </button>
          </div>
        )}
      </header>

      {focus && x.byKey.get(focus) ? (
        <FocusView lang={lang} x={x} focus={x.byKey.get(focus)!} allLinks={allLinks} center={center} onPick={push} onEdge={setEdgeKey} onMore={() => setMoreSheet(true)} onOpenEntity={onOpenEntity} inMap={inMap} />
      ) : tab === "groups" ? (
        <div className="xrm-scroll">
          <Poster
            lang={lang}
            x={x}
            gs={gs}
            centers={centers}
            centerKeys={centerKeys}
            weight={weight}
            showMinor={showMinor}
            setShowMinor={setShowMinor}
            opened={opened}
            onOpen={(id) => setOpened((s) => new Set(s).add(id))}
            onPick={push}
            onGroup={setGroupSheet}
            onEdge={setEdgeKey}
          />
        </div>
      ) : (
        <div className="xrm-scroll">
          <TieList lang={lang} x={x} allLinks={allLinks} inMap={inMap} onPick={push} />
        </div>
      )}

      {edge && (
        <EdgePanel
          lang={lang}
          x={x}
          view={view}
          link={edge}
          onClose={() => setEdgeKey(null)}
          onPick={(k) => {
            setEdgeKey(null);
            push(k);
          }}
          onMerged={() => setEdgeKey(null)}
        />
      )}
      {groupSheet && (() => {
        const g = gs.find((v) => v.id === groupSheet);
        return g ? <GroupSheet lang={lang} x={x} g={g} onClose={() => setGroupSheet(null)} onPick={(k) => { setGroupSheet(null); push(k); }} /> : null;
      })()}
      {moreSheet && focus && (
        <MobileReaderSheet title={t.mxMoreTies.replace("{0}", name(focus))} closeLabel={t.xrClose} onClose={() => setMoreSheet(false)}>
          <ul className="mx-rows">
            {allLinks
              .filter((l) => (l.a === focus || l.b === focus) && inMap(l.a === focus ? l.b : l.a))
              .map((l) => {
                const o = x.byKey.get(l.a === focus ? l.b : l.a)!;
                const s = sideOf(x, o.key, focus);
                return (
                  <li key={l.key}>
                    <button className="mx-row mx-row--rel" onClick={() => { setMoreSheet(false); push(o.key); }}>
                      <Avatar e={o} size={34} />
                      <span className="mx-row__main"><span className="mx-row__name">{o.name}</span></span>
                      {s ? <span className="mx-rel" style={{ ["--k" as string]: KIND_COLOR[s.kind] }}>{s.text}</span> : <span className="mx-row__n">{t.xrTogether.replace("{0}", String(l.chunks.length))}</span>}
                    </button>
                  </li>
                );
              })}
          </ul>
        </MobileReaderSheet>
      )}
      {settings && (
        <MobileReaderSheet title={t.mxSettings} closeLabel={t.xrClose} onClose={() => setSettings(false)}>
          <div className="xrg__tools xrm-tools">
            <label className="mx-opt">
              <span>
                {t.xrWholeBook}
                <small>{t.mxSpoilerWarn}</small>
              </span>
              <Switch on={x.wholeBook} onChange={x.setWholeBook} />
            </label>
            <label className="mx-opt">
              <span>{t.mxShowMinor}</span>
              <Switch on={showMinor} onChange={setShowMinor} />
            </label>
            <AiButton
              lang={lang}
              x={x}
              view={view}
              title={title}
              provider={provider}
              people={castOrder(x.cast).map((k) => x.byKey.get(k)!).filter((e) => e && e.type === "person" && x.cast.get(e.key)?.tier !== "passing")}
              edges={allLinks.filter((l) => inMap(l.a) && inMap(l.b))}
              onSame={(pairs) => pairs.filter(([a, b]) => !mergeAsOne(x, a, b, true))}
            />
          </div>
        </MobileReaderSheet>
      )}
    </div>
  );
}

/** The kind most of a group's labelled ties to the center are (nothing when none is labelled). */
function groupKind(x: XrayState, g: CastGroup, center: string | null, centers: Set<string>): RelKind | null {
  if (!center) return null;
  const n = new Map<RelKind, number>();
  for (const k of g.members) {
    if (centers.has(k)) continue;
    const kind = relKind(x.labelOf(pairKey(k, center))?.text);
    if (kind !== "none" && kind !== "same") n.set(kind, (n.get(kind) ?? 0) + 1);
  }
  return [...n.entries()].sort((a, b) => b[1] - a[1] || KIND_ORDER.indexOf(a[0]) - KIND_ORDER.indexOf(b[0]))[0]?.[0] ?? null;
}

function Poster({
  lang,
  x,
  gs,
  centers,
  centerKeys,
  weight,
  showMinor,
  setShowMinor,
  opened,
  onOpen,
  onPick,
  onGroup,
  onEdge,
}: {
  lang: Lang;
  x: XrayState;
  gs: CastGroup[];
  centers: Entity[];
  centerKeys: Set<string>;
  weight: (a: string, b: string) => number;
  showMinor: boolean;
  setShowMinor: (v: boolean) => void;
  opened: Set<string>;
  onOpen: (id: string) => void;
  onPick: (k: string) => void;
  onGroup: (id: string) => void;
  onEdge: (key: string) => void;
}) {
  const t = STR[lang];
  const c0 = centers[0] ?? null;
  if (!c0) return <p className="rside__empty">{t.xrEmpty}</p>;
  const between = centers[1] ? sideOf(x, centers[1].key, c0.key) : null;
  const card = (e: Entity) => (
    <button className="xrm-center" onClick={() => onPick(e.key)}>
      <Avatar e={e} size={64} />
      <b>{e.name}</b>
      <small>{roleLine(lang, x, e, e.key === c0.key ? null : c0) || t[`mxTier_${x.cast.get(e.key)?.tier ?? "main"}` as const]}</small>
    </button>
  );
  const close = (k: string) => centers.some((c) => weight(k, c.key) >= CLOSE || !!x.labelOf(pairKey(k, c.key)));
  return (
    <div className="xrm-poster">
      <div className="xrm-centers">
        {card(c0)}
        {centers[1] && (
          <>
            <button className="xrm-between" onClick={() => onEdge(pairKey(c0.key, centers[1].key))} style={{ ["--k" as string]: KIND_COLOR[between?.kind ?? "none"] }}>
              {between?.text ?? t.xrTogether.replace("{0}", String(weight(c0.key, centers[1].key)))}
            </button>
            {card(centers[1])}
          </>
        )}
      </div>
      <div className="xrm-frames">
        {gs.map((g) => {
          const members = g.members.filter((k) => !centerKeys.has(k));
          if (!members.length) return null;
          const all = showMinor || opened.has(g.id);
          const pick = all ? members : members.filter((k) => x.cast.get(k)?.tier === "main" || close(k));
          const shown = all ? pick : pick.slice(0, PER_FRAME);
          const hidden = members.length - shown.length;
          const kind = groupKind(x, g, c0.key, centerKeys);
          return (
            <section key={g.id} className="xrm-frame" style={{ ["--k" as string]: KIND_COLOR[kind ?? "none"] }}>
              <i className="xrm-frame__dot" aria-hidden="true" />
              <header>
                <button className="xrm-frame__name" onClick={() => onGroup(g.id)}>
                  <b>{groupName(lang, x, g)}</b>
                  <span>{t.mxPeopleN.replace("{0}", String(members.length))}</span>
                </button>
                {kind && <span className="mx-rel">{t[`xrg_${kind}` as const]}</span>}
              </header>
              <div className="xrm-grid">
                {shown.map((k) => {
                  const e = x.byKey.get(k);
                  if (!e) return null;
                  const line = roleLine(lang, x, e, c0);
                  return (
                    <button key={k} className="xrm-person" onClick={() => onPick(k)}>
                      <Avatar e={e} size={46} />
                      <b>{e.name}</b>
                      {line && <small>{line}</small>}
                    </button>
                  );
                })}
                {hidden > 0 && (
                  <button className="xrm-person xrm-person--more" onClick={() => onOpen(g.id)} aria-label={t.mxShowMore.replace("{0}", String(hidden))}>
                    <span className="xrm-more">+{hidden}</span>
                  </button>
                )}
              </div>
            </section>
          );
        })}
      </div>
      <label className="mx-opt xrm-minor">
        <span>{t.mxShowMinor}</span>
        <Switch on={showMinor} onChange={setShowMinor} />
      </label>
      <p className="xrm-note">{t.mxGroupsNote}</p>
    </div>
  );
}

function FocusView({
  lang,
  x,
  focus,
  allLinks,
  center,
  onPick,
  onEdge,
  onMore,
  onOpenEntity,
  inMap,
}: {
  lang: Lang;
  x: XrayState;
  focus: Entity;
  allLinks: Link[];
  center: Entity | null;
  onPick: (k: string) => void;
  onEdge: (key: string) => void;
  onMore: () => void;
  onOpenEntity: (k: string) => void;
  inMap: (k: string) => boolean;
}) {
  const t = STR[lang];
  const stage = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0, font: "serif" });
  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    const font = getComputedStyle(el).fontFamily || "serif";
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight, font }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const ties = allLinks.filter((l) => (l.a === focus.key || l.b === focus.key) && inMap(l.a === focus.key ? l.b : l.a));
  // Only labelled or strong ties around the one in focus.
  const strong = ties.filter((l) => !!x.labelOf(l.key) || l.chunks.length >= CLOSE);
  const used = strong.length ? strong : ties.slice(0, 6);
  const nameFont = `600 12.5px ${size.font}`;
  const labelFont = `500 12.5px ${size.font}`;
  const ring: RingNode[] = used.map((l) => {
    const o = l.a === focus.key ? l.b : l.a;
    const s = sideOf(x, o, focus.key);
    return { key: o, kind: s?.kind ?? relKind(x.labelOf(l.key)?.text), strength: l.chunks.length, nameW: textW(x.byKey.get(o)?.name ?? o, nameFont), labelW: s ? textW(s.text, labelFont) : 0 };
  });
  // A few ties of theirs, outside: the strongest labelled one of each of the closest.
  const inRing = new Set([focus.key, ...ring.map((r) => r.key)]);
  const outer: RingNode[] = [];
  for (const r of [...ring].sort((a, b) => b.strength - a.strength).slice(0, 4)) {
    const l = allLinks.find((v) => (v.a === r.key || v.b === r.key) && !inRing.has(v.a === r.key ? v.b : v.a) && inMap(v.a === r.key ? v.b : v.a) && !!x.labelOf(v.key));
    if (!l) continue;
    const q = l.a === r.key ? l.b : l.a;
    const s = sideOf(x, q, r.key);
    inRing.add(q);
    outer.push({ key: q, via: r.key, kind: s?.kind ?? "none", strength: l.chunks.length, nameW: textW(x.byKey.get(q)?.name ?? q, nameFont), labelW: s ? textW(s.text, labelFont) : 0 });
  }
  const L = size.w ? radialLayout(size.w, size.h, ring, outer, { top: 8, bottom: 8 }) : null;
  const sideText = (k: string, of: string) => sideOf(x, k, of)?.text ?? "";
  const kindOfNode = (k: string, of: string) => sideOf(x, k, of)?.kind ?? "none";
  const ms = upTo(focus, x.limit).length;
  const line = roleLine(lang, x, focus, center);
  const desc = x.descriptionOf(focus.key);

  return (
    <>
      <div className="xrm-stage" ref={stage}>
        {L && (
          <>
            <svg className="xrm-lines" width={size.w} height={size.h} aria-hidden="true">
              {L.nodes.map((v) => {
                const from = v.outer ? L.nodes.find((m) => m.key === v.via)! : L.center;
                const of = v.outer ? v.via! : focus.key;
                return (
                  <line
                    key={v.key}
                    x1={from.x}
                    y1={from.y}
                    x2={v.x}
                    y2={v.y}
                    stroke={KIND_COLOR[kindOfNode(v.key, of)]}
                    strokeOpacity={kindOfNode(v.key, of) === "none" ? 0.6 : 0.9}
                    strokeWidth={v.outer ? 1.5 : 2.5}
                    strokeDasharray={v.outer ? "4 5" : undefined}
                  />
                );
              })}
            </svg>
            {L.labels.map((b) => {
              const v = L.nodes.find((m) => m.key === b.key)!;
              const of = v.outer ? v.via! : focus.key;
              const text = sideText(b.key, of);
              return (
                <button
                  key={`l${b.key}`}
                  className={`xrm-label${b.short ? " is-short" : ""}`}
                  style={{ left: b.x, top: b.y, width: b.w, height: b.h, ["--k" as string]: KIND_COLOR[kindOfNode(b.key, of)] }}
                  onClick={() => onEdge(pairKey(b.key, of))}
                  title={text}
                >
                  {text}
                </button>
              );
            })}
            {L.nodes.map((v) => {
              const e = x.byKey.get(v.key);
              if (!e) return null;
              return (
                <button key={v.key} className={`xrm-node${v.outer ? " is-outer" : ""}`} style={{ left: v.x, top: v.y }} onClick={() => onPick(v.key)}>
                  <Avatar e={e} size={v.r * 2} />
                  <span style={{ width: v.name.w, left: v.name.x - v.x + v.r }}>{e.name}</span>
                </button>
              );
            })}
            <button className="xrm-node xrm-node--center" style={{ left: L.center.x, top: L.center.y }} onClick={() => onOpenEntity(focus.key)} aria-label={t.mxOpenPage}>
              <span className="xrm-node__glow" style={{ ["--c" as string]: avatarColor(focus.key) }}>
                <Avatar e={focus} size={L.center.r * 2} />
              </span>
            </button>
            {L.more.length > 0 && (
              <button className="xrm-ringmore" onClick={onMore}>
                {t.mxShowMore.replace("{0}", String(L.more.length))}
              </button>
            )}
            {!ring.length && <p className="xrm-alone">{t.xrNoRelations}</p>}
          </>
        )}
      </div>
      <section className="xrm-card" aria-label={focus.name}>
        <div className="xrm-card__head">
          <Avatar e={focus} size={44} />
          <div>
            <h3>{focus.name}</h3>
            <span>{[line, t.mxTimesTies.replace("{0}", String(ms)).replace("{1}", String(ties.length))].filter(Boolean).join(" · ")}</span>
          </div>
        </div>
        {desc && <p>{desc}</p>}
        <button className="xrm-card__open" onClick={() => onOpenEntity(focus.key)}>
          {t.mxOpenPage}
        </button>
      </section>
    </>
  );
}

const LIST_KINDS: RelKind[] = ["family", "love", "social", "conflict", "none"];
/** Unlabelled ties listed at most. */
const LIST_PLAIN = 30;

function TieList({ lang, x, allLinks, inMap, onPick }: { lang: Lang; x: XrayState; allLinks: Link[]; inMap: (k: string) => boolean; onPick: (k: string) => void }) {
  const t = STR[lang];
  const rows = allLinks.filter((l) => inMap(l.a) && inMap(l.b) && x.cast.get(l.a)?.tier !== "passing" && x.cast.get(l.b)?.tier !== "passing");
  const byKind = new Map<RelKind, Link[]>();
  for (const l of rows) {
    const k = relKind(x.labelOf(l.key)?.text);
    if (k === "same") continue;
    (byKind.get(k) ?? byKind.set(k, []).get(k)!).push(l);
  }
  const plain = (byKind.get("none") ?? []).slice(0, LIST_PLAIN);
  if (plain.length) byKind.set("none", plain);
  if (!rows.length) return <p className="rside__empty">{t.xrNoRelations}</p>;
  return (
    <div className="xrm-list">
      {LIST_KINDS.filter((k) => byKind.get(k)?.length).map((k) => (
        <section key={k} className="xrm-list__kind">
          <h4 className="mx-h">
            <i style={{ background: KIND_COLOR[k] }} aria-hidden="true" />
            {t[`xrg_${k}` as const]}
          </h4>
          <ul className="mx-rows">
            {byKind.get(k)!.map((l) => {
              const a = x.byKey.get(l.a)!;
              const b = x.byKey.get(l.b)!;
              const s = sideOf(x, a.key, b.key);
              return (
                <li key={l.key}>
                  <button className="mx-row xrm-tie" onClick={() => onPick(a.key)}>
                    <span className="xrm-tie__avs" aria-hidden="true">
                      <Avatar e={a} size={32} />
                      <Avatar e={b} size={32} />
                    </span>
                    <span className="mx-row__main">
                      <span className="xrm-tie__text">
                        {s
                          ? sentence(t.mxTieRow, { a: <b>{a.name}</b>, b: <b>{b.name}</b>, side: <span className="xrm-tie__side">{s.text}</span> })
                          : sentence(t.mxTiePlain, { a: <b>{a.name}</b>, b: <b>{b.name}</b> })}
                      </span>
                      <span className="mx-row__line">{t.xrTogether.replace("{0}", String(l.chunks.length))}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** A group's people (tap one to centre on them) and its name, which the reader can change. */
function GroupSheet({ lang, x, g, onClose, onPick }: { lang: Lang; x: XrayState; g: CastGroup; onClose: () => void; onPick: (k: string) => void }) {
  const t = STR[lang];
  const [nameText, setNameText] = useState(groupName(lang, x, g));
  const save = () => {
    const v = nameText.trim();
    x.setEdits((ed) => {
      const groupNames = { ...(ed.groupNames ?? {}) };
      if (v && v !== groupName(lang, { ...x, edits: { ...x.edits, groupNames: {} } }, g)) groupNames[g.id] = v;
      else delete groupNames[g.id];
      return { ...ed, groupNames };
    });
  };
  return (
    <MobileReaderSheet title={groupName(lang, x, g)} closeLabel={t.xrClose} onClose={onClose}>
      <div className="xrm-group">
        {g.kind !== "others" && (
          <label className="xrm-group__name">
            <span>{t.mxRenameGroup}</span>
            <input className="xr__filter" value={nameText} onChange={(e) => setNameText(e.target.value)} onBlur={save} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
          </label>
        )}
        <ul className="mx-rows">
          {g.members.map((k) => {
            const e = x.byKey.get(k);
            if (!e) return null;
            return (
              <li key={k}>
                <button className="mx-row" onClick={() => onPick(k)}>
                  <Avatar e={e} size={36} />
                  <span className="mx-row__main">
                    <span className="mx-row__name">{e.name}</span>
                  </span>
                  <span className="mx-row__n">{t.xrTimes.replace("{0}", String(upTo(e, x.limit).length))}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </MobileReaderSheet>
  );
}
