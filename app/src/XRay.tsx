import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { STR, type Lang } from "./i18n";
import { Icon, type IconName } from "./icons";
import { wikipediaSummary, type WikiSummary } from "./dictionary";
import {
  buildIndex,
  EMPTY_AI,
  EMPTY_EDITS,
  entities,
  INDEX_VERSION,
  isFirstPerson,
  kinLabel,
  links,
  mentionContexts,
  pairKey,
  rangeAt,
  upTo,
  type Entity,
  type Link,
  type Mention,
  type XrAi,
  type XrEdits,
  type XrIndex,
  type XrType,
} from "./xrayIndex";

export const TYPE_ICON: Record<XrType, IconName> = { person: "person", place: "place", org: "org", term: "term" };
export const TYPE_COLOR: Record<XrType, string> = { person: "#e5679a", place: "#4f8de2", org: "#d99a2b", term: "#3fb26b" };

/**
 * A book's X-Ray: the stored index (built on first use), the reader's edits
 * and the AI's labels, cut at `limit` (the reading fraction) unless the
 * whole book is asked for.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useXray(view: any, asin: string, active: boolean, build: boolean, fraction: number) {
  const [index, setIndex] = useState<XrIndex | null>(null);
  const [edits, setEditsState] = useState<XrEdits>(EMPTY_EDITS);
  const [ai, setAiState] = useState<XrAi>(EMPTY_AI);
  const [progress, setProgress] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [wholeBook, setWholeBook] = useState(false);
  const building = useRef(false);

  // Load what is stored once the reader wants X-Ray.
  useEffect(() => {
    if (!active || loaded) return;
    invoke<{ idx: string | null; edits: string | null; ai: string | null }>("xray_load", { asin })
      .then((s) => {
        try {
          if (s.edits) setEditsState({ ...EMPTY_EDITS, ...JSON.parse(s.edits) });
          if (s.ai) setAiState({ ...EMPTY_AI, ...JSON.parse(s.ai) });
          if (s.idx) {
            const idx = JSON.parse(s.idx) as XrIndex;
            if (idx.version === INDEX_VERSION) setIndex(idx);
          }
        } catch {
          /* start fresh */
        }
      })
      .catch(() => undefined)
      .finally(() => setLoaded(true));
  }, [active, loaded, asin]);

  const rebuild = useCallback(
    async (terms: string[]) => {
      if (!view?.book || building.current) return;
      building.current = true;
      setProgress(0);
      try {
        const idx = await buildIndex(view, terms, setProgress);
        setIndex(idx);
        invoke("xray_save", { asin, part: "idx", json: JSON.stringify(idx) }).catch(() => undefined);
      } finally {
        building.current = false;
        setProgress(null);
      }
    },
    [view, asin],
  );

  // Build (only once X-Ray is opened) when there is no index yet, or the
  // reader's terms changed.
  useEffect(() => {
    if (!active || !build || !loaded || !view?.book) return;
    const same = index && index.terms.join("\u0001") === edits.terms.join("\u0001");
    if (!same) void rebuild(edits.terms);
  }, [active, build, loaded, view, index, edits.terms, rebuild]);

  const setEdits = useCallback(
    (f: (e: XrEdits) => XrEdits) =>
      setEditsState((prev) => {
        const next = f(prev);
        invoke("xray_save", { asin, part: "edits", json: JSON.stringify(next) }).catch(() => undefined);
        return next;
      }),
    [asin],
  );
  const setAi = useCallback(
    (f: (a: XrAi) => XrAi) =>
      setAiState((prev) => {
        const next = f(prev);
        invoke("xray_save", { asin, part: "ai", json: JSON.stringify(next) }).catch(() => undefined);
        return next;
      }),
    [asin],
  );

  // Automatic merges made before family names were guarded against ("Tôi"
  // into "Đinh", "Lý" into "Lý Tam Nhân"): split them once the index is here.
  useEffect(() => {
    if (!index || !edits.autoMerged?.length) return;
    const fixed = splitFamilyMerges(index, edits);
    if (fixed) setEdits(() => fixed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);

  const limit = wholeBook ? 1 : fraction;
  const all = useMemo(() => (index ? entities(index, edits) : []), [index, edits]);
  /** Entities seen up to the limit, by how often. */
  const ents = useMemo(
    () =>
      all
        .map((e) => ({ e, n: upTo(e, limit).length }))
        .filter((x) => x.n > 0)
        .sort((a, b) => b.n - a.n)
        .map((x) => x.e),
    [all, limit],
  );
  const byKey = useMemo(() => new Map(all.map((e) => [e.key, e])), [all]);

  // Labels and descriptions are stored under the names they were made for;
  // after a merge they follow the person they now belong to.
  const owner = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of all) for (const f of e.forms) m.set(f, e.key);
    return m;
  }, [all]);
  const userLabels = useMemo(() => repoint(edits.labels, owner), [edits.labels, owner]);
  const aiLabels = useMemo(() => repoint(ai.labels, owner), [ai.labels, owner]);
  const aiDescriptions = useMemo(() => {
    const m = new Map<string, XrAi["descriptions"][string]>();
    for (const [k, v] of Object.entries(ai.descriptions)) {
      const o = owner.get(k);
      if (o && (o === k || !m.has(o))) m.set(o, v);
    }
    return m;
  }, [ai.descriptions, owner]);

  /** A pair's label: the reader's own, else the AI's if it saw no further than the limit. */
  const labelOf = useCallback(
    (key: string): { text: string; detail?: string; from: "user" | "ai" | "auto" } | null => {
      const u = userLabels.get(key);
      if (u) return { text: u, from: "user" };
      // Narrator and someone they call "bố tôi": the book says what the tie is.
      const [ka, kb] = key.split("");
      const ea = byKey.get(ka);
      const eb = byKey.get(kb);
      if (ea && eb) {
        const kin = ea.narrator && !eb.narrator ? eb.kin : eb.narrator && !ea.narrator ? ea.kin : undefined;
        if (kin) return { text: kinLabel(kin), from: "auto" };
      }
      const a = aiLabels.get(key);
      if (a && a.upTo <= limit + 1e-6) return { text: a.label, detail: a.detail, from: "ai" };
      return null;
    },
    [userLabels, aiLabels, limit, byKey],
  );
  const descriptionOf = useCallback(
    (key: string): string | null => {
      const d = aiDescriptions.get(key);
      return d && d.upTo <= limit + 1e-6 ? d.text : null;
    },
    [aiDescriptions, limit],
  );

  return {
    index,
    edits,
    ai,
    setEdits,
    setAi,
    progress,
    ents,
    byKey,
    limit,
    wholeBook,
    setWholeBook,
    labelOf,
    descriptionOf,
    ready: !!index && progress == null,
  };
}
export type XrayState = ReturnType<typeof useXray>;

/** Pair-keyed records re-keyed to the entities their names now belong to (the record made for the pair itself wins). */
function repoint<T>(rec: Record<string, T>, owner: Map<string, string>): Map<string, T> {
  const out = new Map<string, T>();
  for (const [k, v] of Object.entries(rec)) {
    const [p, q] = k.split("\u0001");
    const a = owner.get(p);
    const b = owner.get(q);
    if (!a || !b || a === b) continue;
    const nk = pairKey(a, b);
    if (nk === k || !out.has(nk)) out.set(nk, v);
  }
  return out;
}

/** Which of two names stays when they are made one person, and which joins it. */
function mergeOrder(a: Entity, b: Entity, roleForms: Set<string>): { to: Entity; from: Entity } {
  const onlyRole = (e: Entity) => e.forms.every((f) => roleForms.has(f));
  const words = (e: Entity) => e.name.split(/\s+/).length;
  // A real name beats "Tôi (người kể)" / "Bố tôi", then the fuller name, then the one seen more.
  const rank = (e: Entity) => [onlyRole(e) ? 0 : 1, words(e), e.mentions.length];
  const ra = rank(a);
  const rb = rank(b);
  const aWins = ra[0] !== rb[0] ? ra[0] > rb[0] : ra[1] !== rb[1] ? ra[1] > rb[1] : ra[2] >= rb[2];
  return aWins ? { to: a, from: b } : { to: b, from: a };
}

/**
 * One-word names that begin two or more other names: a family name ("Đinh"
 * in "Đinh Huy", "Đinh Lượng"), not one person, so never merged by itself.
 */
function familyNames(index: XrIndex): Set<string> {
  const names = index.forms.filter((f) => !f.role).map((f) => f.form);
  const out = new Set<string>();
  for (const n of names) {
    if (n.includes(" ")) continue;
    if (names.filter((m) => m.startsWith(n + " ")).length >= 2) out.add(n);
  }
  return out;
}

/** Edits with automatic merges that joined a family name taken apart (null when there are none). */
function splitFamilyMerges(index: XrIndex, edits: XrEdits): XrEdits | null {
  const family = familyNames(index);
  const merges = { ...edits.merges };
  const names = { ...edits.names };
  let changed = false;
  for (const pk of edits.autoMerged ?? []) {
    const [p, q] = pk.split("\u0001");
    if (!family.has(p) && !family.has(q)) continue;
    for (const [a, b] of [[p, q], [q, p]]) {
      if (merges[a] === b) {
        delete merges[a];
        changed = true;
      }
      // "Đinh (tôi)" back to "Đinh".
      const n = names[b];
      if (n && n !== b && n.startsWith(b + " (")) {
        delete names[b];
        changed = true;
      }
    }
  }
  return changed ? { ...edits, merges, names } : null;
}

/** One name is the other with words added ("Tú Cần" in "Triệu Tú Cần"). */
function nameInside(a: string, b: string): boolean {
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  return ` ${l.toLowerCase()} `.includes(` ${s.toLowerCase()} `);
}

/**
 * Make two names one person. The real name stays (over "Tôi (người kể)" or
 * "Bố tôi", which is kept in brackets: "Đinh Huy (bố tôi)"), else the fuller
 * name, else the one seen more.
 *
 * `auto` (the AI said so): done once per pair, never against a split the
 * reader made, and only when it is plausible from the names themselves: one
 * name inside the other, or the narrator / "bố tôi" being given a name. The AI
 * can be wrong, so anything else stays a suggestion for the reader.
 * Returns "from → to" when a merge was made.
 */
export function mergeAsOne(x: XrayState, aKey: string, bKey: string, auto: boolean): string | null {
  const index = x.index;
  if (!index) return null;
  const roleForms = new Set(index.forms.filter((f) => f.role).map((f) => f.form));
  const onlyRole = (e: Entity) => e.forms.every((f) => roleForms.has(f));
  const pk = pairKey(aKey, bKey);
  const findIn = (list: Iterable<Entity>, k: string) => [...list].find((e) => e.forms.includes(k));
  const a0 = findIn(x.byKey.values(), aKey);
  const b0 = findIn(x.byKey.values(), bKey);
  if (!a0 || !b0 || a0.key === b0.key) return null;
  if (auto) {
    if (x.edits.autoMerged?.includes(pk)) return null;
    if ([...a0.forms, ...b0.forms].some((f) => x.edits.merges[f] === f)) return null;
    if (!onlyRole(a0) && !onlyRole(b0) && !nameInside(a0.name, b0.name)) return null;
    // A family name ("Đinh", "Lý") is many people, never merged by itself.
    const family = familyNames(index);
    if ([...a0.forms, ...b0.forms].some((f) => family.has(f))) return null;
  }
  const plan = mergeOrder(a0, b0, roleForms);
  x.setEdits((ed) => {
    if (auto && ed.autoMerged?.includes(pk)) return ed;
    const ents = entities(index, ed);
    const a = findIn(ents, aKey);
    const b = findIn(ents, bKey);
    if (!a || !b || a.key === b.key) return ed;
    const { to, from } = mergeOrder(a, b, roleForms);
    const merges = { ...ed.merges };
    for (const f of from.forms) merges[f] = to.key;
    let name = to.name;
    if (onlyRole(from) && !onlyRole(to)) {
      const tag = from.narrator ? (from.forms.includes("I (narrator)") ? "I" : "tôi") : from.name[0].toLowerCase() + from.name.slice(1);
      if (!name.includes(`(${tag})`)) name = `${name} (${tag})`;
    }
    return {
      ...ed,
      merges,
      names: { ...ed.names, [to.key]: name },
      autoMerged: auto ? [...(ed.autoMerged ?? []), pk] : ed.autoMerged,
    };
  });
  return `${plan.from.name} → ${plan.to.name}`;
}

/** Go to a mention in the book. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function goToMention(view: any, m: Mention) {
  try {
    const doc = await view.book.sections[m[0]].createDocument();
    const r = rangeAt(doc, m[1], m[2]);
    if (!r) return;
    await view.goTo(view.getCFI(m[0], r));
  } catch {
    /* unreachable place */
  }
}

/** Where an entity appears in the part read so far (`span` of the book): a strip of 60 cells. */
export function Spread({ mentions, span }: { mentions: Mention[]; span: number }) {
  const N = 60;
  const cells = new Array(N).fill(0);
  const s = Math.max(1e-6, span);
  for (const m of mentions) cells[Math.min(N - 1, Math.floor((m[4] / s) * N))]++;
  const max = Math.max(1, ...cells);
  return (
    <div className="xr-spread" aria-hidden="true">
      {cells.map((c, i) => (
        <i key={i} style={{ height: c ? `${25 + (75 * c) / max}%` : undefined, opacity: c ? undefined : 0 }} />
      ))}
    </div>
  );
}

/** The X-Ray tab of the reader's sidebar. */
export function XRayPanel({
  lang,
  x,
  view,
  selected,
  onSelect,
  onOpenGraph,
  formatPos,
  onGo,
}: {
  lang: Lang;
  x: XrayState;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  view: any;
  selected: string | null;
  onSelect: (key: string | null) => void;
  onOpenGraph: () => void;
  formatPos: (f: number) => string;
  onGo: (m: Mention) => void;
}) {
  const t = STR[lang];
  const [type, setType] = useState<XrType | "all">("all");
  const [filter, setFilter] = useState("");
  const [term, setTerm] = useState("");
  const entity = selected ? x.byKey.get(selected) ?? null : null;

  if (entity) {
    return <XRayDetail lang={lang} x={x} view={view} e={entity} formatPos={formatPos} onBack={() => onSelect(null)} onSelect={onSelect} onGo={onGo} />;
  }

  const q = filter.trim().toLowerCase();
  const shown = x.ents.filter((e) => (type === "all" || e.type === type) && (!q || e.forms.some((f) => f.toLowerCase().includes(q))));
  const counts: Record<string, number> = { all: x.ents.length };
  for (const e of x.ents) counts[e.type] = (counts[e.type] ?? 0) + 1;

  return (
    <div className="xr">
      <div className="xr__bar">
        <div className="xr__types" role="radiogroup">
          {(["all", "person", "place", "org", "term"] as const).map((k) => (
            <button key={k} role="radio" aria-checked={type === k} className={type === k ? "is-on" : ""} onClick={() => setType(k)}>
              {k !== "all" && <Icon name={TYPE_ICON[k]} size={13} />}
              {k === "all" ? t.xrAll : t[`xr_${k}` as const]}
              <span>{counts[k] ?? 0}</span>
            </button>
          ))}
        </div>
        <div className="xr__row">
          <label className="xr__whole" title={t.xrWholeBookHint}>
            <input type="checkbox" checked={x.wholeBook} onChange={(e) => x.setWholeBook(e.target.checked)} />
            <span>{x.wholeBook ? t.xrWholeBook : t.xrUpToHere.replace("{0}", String(Math.round(x.limit * 100)))}</span>
          </label>
          <button className="xr__graphbtn" onClick={onOpenGraph}>
            <Icon name="graph" size={15} />
            {t.xrGraph}
          </button>
        </div>
        {x.index?.forms.some((f) => f.role === "narrator") && (
          <label className="xr__whole xr__first" title={t.xrFirstPersonHint}>
            <input
              type="checkbox"
              checked={isFirstPerson(x.index, x.edits)}
              onChange={(e) => x.setEdits((ed) => ({ ...ed, firstPerson: e.target.checked }))}
            />
            <span>{t.xrFirstPerson}</span>
          </label>
        )}
        <input className="xr__filter" value={filter} placeholder={t.xrFilter} onChange={(e) => setFilter(e.target.value)} spellCheck={false} />
        {x.progress != null && (
          <div className="xr__building">
            <span>{t.xrBuilding.replace("{0}", String(Math.round(x.progress * 100)))}</span>
            <div className="bsearch__progress">
              <i style={{ width: `${x.progress * 100}%` }} />
            </div>
          </div>
        )}
      </div>
      <ul className="xr__list">
        {shown.map((e) => {
          const ms = upTo(e, x.limit);
          return (
            <li key={e.key}>
              <button onClick={() => onSelect(e.key)}>
                <span className="xr__icon" style={{ ["--c" as string]: TYPE_COLOR[e.type] }}>
                  <Icon name={TYPE_ICON[e.type]} size={14} />
                </span>
                <span className="xr__main">
                  <span className="xr__name">{e.name}</span>
                  <Spread mentions={ms} span={x.limit} />
                </span>
                <span className="xr__count">{ms.length}</span>
              </button>
            </li>
          );
        })}
        {x.ready && !shown.length && <li className="rside__empty">{t.xrEmpty}</li>}
      </ul>
      <div className="xr__foot">
        <input
          value={term}
          placeholder={t.xrAddTerm}
          title={t.xrAddTermHint}
          onChange={(e) => setTerm(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && term.trim()) {
              const v = term.trim();
              x.setEdits((ed) => (ed.terms.includes(v) ? ed : { ...ed, terms: [...ed.terms, v] }));
              setTerm("");
            }
          }}
        />
        {x.edits.hidden.length > 0 && (
          <button className="xr__unhide" onClick={() => x.setEdits((ed) => ({ ...ed, hidden: [] }))}>
            {t.xrHidden.replace("{0}", String(x.edits.hidden.length))} · {t.xrShowHidden}
          </button>
        )}
      </div>
    </div>
  );
}

function XRayDetail({
  lang,
  x,
  view,
  e,
  formatPos,
  onBack,
  onSelect,
  onGo,
}: {
  lang: Lang;
  x: XrayState;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  view: any;
  e: Entity;
  formatPos: (f: number) => string;
  onBack: () => void;
  onSelect: (key: string) => void;
  onGo: (m: Mention) => void;
}) {
  const t = STR[lang];
  const ms = upTo(e, x.limit);
  const [shown, setShown] = useState(20);
  const [ctx, setCtx] = useState<string[]>([]);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(e.name);
  const [wiki, setWiki] = useState<WikiSummary | null | "busy" | "none">(null);

  useEffect(() => {
    let off = false;
    mentionContexts(view, ms.slice(0, shown)).then((c) => !off && setCtx(c));
    return () => {
      off = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [e.key, shown, x.limit]);
  useEffect(() => {
    setName(e.name);
    setRenaming(false);
    setWiki(null);
    setShown(20);
  }, [e.key, e.name]);

  const rels: { other: Entity; link: Link }[] = useMemo(() => {
    if (e.type !== "person") return [];
    return links(x.ents, x.limit)
      .filter((l) => l.a === e.key || l.b === e.key)
      .slice(0, 12)
      .map((l) => ({ other: x.byKey.get(l.a === e.key ? l.b : l.a)!, link: l }))
      .filter((r) => r.other);
  }, [e, x.ents, x.limit, x.byKey]);

  const desc = x.descriptionOf(e.key);
  const others = x.ents.filter((o) => o.key !== e.key && o.type === e.type).slice(0, 80);

  return (
    <div className="xr xr--detail">
      <div className="xr__dhead">
        <button className="xr__back" onClick={onBack}>
          <Icon name="arrowL" size={15} />
          {t.xrBack}
        </button>
        <button className="xr__hide" onClick={() => { x.setEdits((ed) => ({ ...ed, hidden: [...ed.hidden, e.key] })); onBack(); }} title={t.xrHide} aria-label={t.xrHide}>
          <Icon name="trash" size={15} />
        </button>
      </div>
      <div className="xr__scroll">
        <div className="xr__title">
          <span className="xr__icon xr__icon--lg" style={{ ["--c" as string]: TYPE_COLOR[e.type] }}>
            <Icon name={TYPE_ICON[e.type]} size={18} />
          </span>
          {renaming ? (
            <input
              autoFocus
              className="xr__rename"
              value={name}
              onChange={(ev) => setName(ev.target.value)}
              onBlur={() => {
                const v = name.trim();
                if (v && v !== e.name) x.setEdits((ed) => ({ ...ed, names: { ...ed.names, [e.key]: v } }));
                setRenaming(false);
              }}
              onKeyDown={(ev) => ev.key === "Enter" && (ev.target as HTMLInputElement).blur()}
            />
          ) : (
            <h3 onDoubleClick={() => setRenaming(true)} title={t.xrRename}>
              {e.name}
            </h3>
          )}
          <button className="xr__mini" onClick={() => setRenaming(true)} title={t.xrRename} aria-label={t.xrRename}>
            <Icon name="edit" size={14} />
          </button>
        </div>
        <div className="xr__meta">
          <select
            className="select"
            value={e.type}
            onChange={(ev) => x.setEdits((ed) => ({ ...ed, types: { ...ed.types, [e.key]: ev.target.value as XrType } }))}
          >
            {(["person", "place", "org", "term"] as const).map((k) => (
              <option key={k} value={k}>
                {t[`xr_${k}` as const]}
              </option>
            ))}
          </select>
          <span>{t.xrTimes.replace("{0}", String(ms.length))}</span>
          {ms[0] && <span>· {t.xrFirstSeen} {formatPos(ms[0][4])}</span>}
        </div>
        <Spread mentions={ms} span={x.limit} />

        <h4>{t.xrAbout}</h4>
        {desc ? (
          <p className="xr__desc">
            {desc} <span className="xr__badge">{t.xrAiBadge}</span>
          </p>
        ) : (
          ctx[0] && <p className="xr__desc xr__desc--quote">{ctx[0]}</p>
        )}
        {e.type !== "term" &&
          (wiki === null ? (
            <button
              className="xr__link"
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
            <p className="xr__desc xr__wiki">
              <b>{wiki.title}</b> — {wiki.extract}
            </p>
          ))}

        <h4>{t.xrForms}</h4>
        <div className="xr__forms">
          {e.forms.map((f) => (
            <span key={f} className="xr__chip">
              {f}
              {f !== e.key && (
                <button onClick={() => x.setEdits((ed) => ({ ...ed, merges: { ...ed.merges, [f]: f } }))} title={t.xrSplit} aria-label={t.xrSplit}>
                  <Icon name="close" size={11} />
                </button>
              )}
            </span>
          ))}
          <select
            className="select xr__merge"
            value=""
            onChange={(ev) => {
              const to = ev.target.value;
              if (!to) return;
              x.setEdits((ed) => {
                const merges = { ...ed.merges };
                for (const f of e.forms) merges[f] = to;
                return { ...ed, merges };
              });
              onSelect(to);
            }}
          >
            <option value="">{t.xrMergeInto}</option>
            {others.map((o) => (
              <option key={o.key} value={o.key}>
                {o.name}
              </option>
            ))}
          </select>
        </div>

        {e.type === "person" && (
          <>
            <h4>{t.xrRelations}</h4>
            {rels.length ? (
              <ul className="xr__rels">
                {rels.map(({ other, link }) => {
                  const lab = x.labelOf(link.key);
                  return (
                    <li key={link.key}>
                      <button onClick={() => onSelect(other.key)}>
                        <span className="xr__name">{other.name}</span>
                        {lab ? (
                          <span className="xr__label">
                            {lab.text}
                            {lab.from === "ai" && <span className="xr__badge">{t.xrAiBadge}</span>}
                          </span>
                        ) : (
                          <span className="xr__muted">{t.xrTogether.replace("{0}", String(link.chunks.length))}</span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="xr__muted">{t.xrNoRelations}</p>
            )}
          </>
        )}

        <h4>{t.xrMentions}</h4>
        <ul className="xr__mentions">
          {ms.slice(0, shown).map((m, i) => (
            <li key={i}>
              <button onClick={() => onGo(m)}>
                <span>{ctx[i] ?? "…"}</span>
                <span className="rside__meta">{formatPos(m[4])}</span>
              </button>
            </li>
          ))}
        </ul>
        {ms.length > shown && (
          <button className="xr__link" onClick={() => setShown((n) => n + 30)}>
            {t.xrMoreMentions} ({ms.length - shown})
          </button>
        )}
      </div>
    </div>
  );
}

/** Hover card content for a name in the page. */
export function xrayCardContent(lang: Lang, x: XrayState, e: Entity): DocumentFragment {
  const t = STR[lang];
  const frag = document.createDocumentFragment();
  const head = document.createElement("p");
  const b = document.createElement("b");
  b.textContent = e.name;
  head.append(b, document.createTextNode(` · ${t[`xr_${e.type}` as const]} · ${t.xrTimes.replace("{0}", String(upTo(e, x.limit).length))}`));
  frag.append(head);
  const desc = x.descriptionOf(e.key);
  if (desc) {
    const p = document.createElement("p");
    p.textContent = desc;
    frag.append(p);
  }
  if (e.type === "person") {
    const rels = links(x.ents, x.limit)
      .filter((l) => l.a === e.key || l.b === e.key)
      .slice(0, 4);
    for (const l of rels) {
      const other = x.byKey.get(l.a === e.key ? l.b : l.a);
      if (!other) continue;
      const lab = x.labelOf(l.key);
      const p = document.createElement("p");
      p.className = "xr-card__rel";
      p.textContent = `${other.name}${lab ? ` — ${lab.text}` : ""}`;
      frag.append(p);
    }
  }
  return frag;
}

/** Find the entity whose name is under a point in a section's document. */
export function entityAtPoint(doc: Document, x: number, y: number, forms: Map<string, string>): { key: string; range: Range } | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const caret = (doc as any).caretRangeFromPoint?.(x, y) as Range | null;
  const node = caret?.startContainer;
  if (!node || node.nodeType !== Node.TEXT_NODE) return null;
  const text = (node as Text).data;
  const at = caret!.startOffset;
  for (const [form, key] of forms) {
    let i = text.lastIndexOf(form, at);
    if (i < 0 || i + form.length < at) {
      i = text.indexOf(form, Math.max(0, at - form.length));
      if (i < 0 || i > at) continue;
    }
    // Whole words only.
    const before = text[i - 1];
    const after = text[i + form.length];
    if ((before && /[\p{L}\p{M}]/u.test(before)) || (after && /[\p{L}\p{M}]/u.test(after))) continue;
    const r = doc.createRange();
    r.setStart(node, i);
    r.setEnd(node, i + form.length);
    const box = r.getBoundingClientRect();
    if (x >= box.left - 1 && x <= box.right + 1 && y >= box.top - 1 && y <= box.bottom + 1) return { key, range: r };
  }
  return null;
}

/** Forms → entity key, longest first (so "Ivan Fyodorovich" wins over "Ivan"). */
export function formMap(ents: Entity[]): Map<string, string> {
  const pairs: [string, string][] = [];
  for (const e of ents) for (const f of e.forms) pairs.push([f, e.key]);
  pairs.sort((a, b) => b[0].length - a[0].length);
  return new Map(pairs);
}

export { pairKey };
