import { isAndroid } from "./platform";
import { MobileReaderSheet } from "./mobile/MobileReaderSheet";
import { useMobileDismiss } from "./mobile/back";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { STR, type Lang } from "./i18n";
import { Icon } from "./icons";
import { XRayDetail, mergeAsOne, TYPE_COLOR, TYPE_ICON, type XrayState } from "./XRay";
import { chunkTexts, links, mentionContexts, pairKey, upTo, type Entity, type Link, type XrEdits, type XrType } from "./xrayIndex";
import { KIND_ORDER, bounds, initials, layout, nodeBoxes, placeLabels, relKind, shortLabel, type GNode, type LabelItem, type RelKind } from "./graphLayout";

export type AiProvider = "anthropic" | "deepseek";
export const PROVIDER_NAME: Record<AiProvider, string> = { anthropic: "Claude", deepseek: "DeepSeek" };

let measureCtx: CanvasRenderingContext2D | null = null;
/** Width of a text in a given CSS font. */
function textWidth(s: string, font: string): number {
  measureCtx ??= document.createElement("canvas").getContext("2d");
  if (!measureCtx) return s.length * 7;
  measureCtx.font = font;
  return measureCtx.measureText(s).width;
}

const PILL_H = 22;
/** Each person keeps at most this many of their own ties on the map (plus any labelled one). */
const TIES_EACH = 4;

interface Viewport {
  k: number;
  tx: number;
  ty: number;
}

type Gesture = { kind: "pan" | "node"; node?: GNode; sx: number; sy: number; ox: number; oy: number; moved: boolean };

/** Full-screen map of who appears with whom, with labels from the reader or the AI. */
export function XRayGraph({
  lang,
  x,
  view,
  title,
  provider,
  onClose,
  onOpenEntity,
  formatPos,
  onGo,
}: {
  lang: Lang;
  x: XrayState;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  view: any;
  title: string;
  provider: AiProvider;
  onClose: () => void;
  onOpenEntity: (key: string) => void;
  formatPos: (f: number) => string;
  onGo: (m: import("./xrayIndex").Mention) => void;
}) {
  const t = STR[lang];
  const [settings, setSettings] = useState(false);
  const [entityKey, setEntityKey] = useState<string | null>(null);
  const people = useMemo(() => x.ents.filter((e) => e.type === "person"), [x.ents]);
  const [count, setCount] = useState(() => Math.min(20, people.length));
  const [focus, setFocus] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [hoverEdge, setHoverEdge] = useState<string | null>(null);
  const [edgeKey, setEdgeKey] = useState<string | null>(null);
  const [off, setOff] = useState<Set<RelKind>>(() => new Set());
  const [showLabels, setShowLabels] = useState(true);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [vp, setVp] = useState<Viewport>({ k: 1, tx: 0, ty: 0 });
  const [font, setFont] = useState("serif");
  /** Names merged automatically while the map is open, with what to go back to. */
  const [merged, setMerged] = useState<{ text: string[]; before: XrEdits; pairs: string[] } | null>(null);
  const [, redraw] = useState(0);
  const stageRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const kept = useRef(new Map<string, { x: number; y: number }>());
  const gesture = useRef<Gesture | null>(null);

  useMobileDismiss(isAndroid, () => {
    if (document.querySelector("[data-mobile-picker]")) return;
    if (settings) setSettings(false);
    else if (entityKey) setEntityKey(null);
    else if (edgeKey) setEdgeKey(null);
    else if (focus) setFocus(null);
    else onClose();
  });
  const suppressClick = useRef(false);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ distance: number; x: number; y: number; vp: Viewport } | null>(null);
  const shown = people.slice(0, Math.max(2, count));
  const shownKey = shown.map((e) => e.key).join("|");
  const allLinks = useMemo(() => links(x.ents, x.limit), [x.ents, x.limit]);
  // Each person keeps their strongest few ties, so the map stays readable.
  const edges = useMemo(() => {
    const keys = new Set(shown.map((e) => e.key));
    const inside = allLinks.filter((l) => keys.has(l.a) && keys.has(l.b));
    const per = new Map<string, number>();
    return inside.filter((l) => {
      const na = per.get(l.a) ?? 0;
      const nb = per.get(l.b) ?? 0;
      per.set(l.a, na + 1);
      per.set(l.b, nb + 1);
      const labelled = !!x.labelOf(l.key);
      // The narrator is with everyone; keep only their closest ties.
      if (x.byKey.get(l.a)?.narrator) return labelled || na < 6;
      if (x.byKey.get(l.b)?.narrator) return labelled || nb < 6;
      return na < TIES_EACH || nb < TIES_EACH || labelled;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allLinks, shownKey, x.labelOf]);
  const edgesKey = edges.map((l) => l.key).join("|");
  const kindOf = useMemo(() => new Map(edges.map((l) => [l.key, relKind(x.labelOf(l.key)?.text)])), [edges, x.labelOf]);
  const maxW = Math.max(1, ...edges.map((e) => e.chunks.length));

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    setFont(getComputedStyle(el).fontFamily || "serif");
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const nameFont = (big: boolean) => `${big ? 700 : 600} ${isAndroid ? 14 : big ? 14 : 12.5}px ${font}`;
  const pillFont = `500 12px ${font}`;

  // Lay people out once per set of people; dragging moves them by hand.
  const nodes = useMemo(() => {
    const maxN = Math.max(1, ...shown.map((e) => upTo(e, x.limit).length));
    const ns: GNode[] = shown.map((e, i) => {
      const n = upTo(e, x.limit).length;
      return { key: e.key, r: 13 + 18 * Math.sqrt(n / maxN), w: textWidth(e.name, nameFont(i < 3)), x: 0, y: 0, vx: 0, vy: 0 };
    });
    const at = new Map(ns.map((n, i) => [n.key, i]));
    layout(
      ns,
      edges.map((l) => ({ a: at.get(l.a)!, b: at.get(l.b)!, s: l.chunks.length / maxW })),
      kept.current,
    );
    for (const n of ns) kept.current.set(n.key, { x: n.x, y: n.y });
    return ns;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownKey, edgesKey, x.limit, font]);
  const byKey = useMemo(() => new Map(nodes.map((n) => [n.key, n])), [nodes]);
  const rank = useMemo(() => new Map(shown.map((e, i) => [e.key, i])), [shownKey]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Fit everyone on screen, leaving room for the legend at the bottom. */
  const fit = () => {
    if (!size.w || !nodes.length) return;
    const b = bounds(nodes);
    const top = 16;
    const bottom = 96;
    const k = Math.max(0.3, Math.min(1.35, (size.w - 64) / (b.x1 - b.x0 || 1), (size.h - top - bottom) / (b.y1 - b.y0 || 1)));
    setVp({ k, tx: size.w / 2 - k * (b.x0 + b.x1) / 2, ty: top + (size.h - top - bottom) / 2 - k * (b.y0 + b.y1) / 2 });
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(fit, [nodes, size.w, size.h]);

  // Zoom around the pointer with the wheel (the page itself does not scroll).
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = svg.getBoundingClientRect();
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      setVp((v) => {
        const k = Math.max(0.3, Math.min(3, v.k * Math.exp(-e.deltaY * 0.0015)));
        const f = k / v.k;
        return { k, tx: px - (px - v.tx) * f, ty: py - (py - v.ty) * f };
      });
    };
    svg.addEventListener("wheel", wheel, { passive: false });
    return () => svg.removeEventListener("wheel", wheel);
  }, []);
  const zoomBy = (f: number) =>
    setVp((v) => {
      const k = Math.max(0.3, Math.min(3, v.k * f));
      const cx = size.w / 2;
      const cy = size.h / 2;
      return { k, tx: cx - (cx - v.tx) * (k / v.k), ty: cy - (cy - v.ty) * (k / v.k) };
    });

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      if (edgeKey) setEdgeKey(null);
      else if (focus) setFocus(null);
      else onClose();
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [edgeKey, focus, onClose]);

  // Screen positions (names and labels keep their size whatever the zoom).
  const S = (n: GNode) => ({ x: vp.tx + vp.k * n.x, y: vp.ty + vp.k * n.y, r: Math.max(isAndroid ? 16 : 6, n.r * vp.k) });
  const active = hover ?? focus;
  const near = active ? new Set([active, ...edges.filter((l) => l.a === active || l.b === active).flatMap((l) => [l.a, l.b])]) : null;
  const visible = edges.filter((l) => !off.has(kindOf.get(l.key)!));

  // Labels: around the person in focus (all of them), else as many as fit without covering anything.
  const pills = useMemo(() => {
    const screen = nodes.map((n) => {
      const s = S(n);
      return { ...n, x: s.x, y: s.y, r: s.r };
    });
    const at = new Map(screen.map((n) => [n.key, n]));
    const obstacles = screen.flatMap(nodeBoxes);
    const item = (l: Link): (LabelItem & { text: string; full: string; kind: RelKind }) | null => {
      const lab = x.labelOf(l.key);
      const a = at.get(l.a);
      const b = at.get(l.b);
      if (!lab || !a || !b) return null;
      const text = shortLabel(lab.text);
      // Start and end at the rims, so a label never sits on a disc.
      const d = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const ux = (b.x - a.x) / d;
      const uy = (b.y - a.y) / d;
      return {
        key: l.key,
        x1: a.x + ux * a.r,
        y1: a.y + uy * a.r,
        x2: b.x - ux * b.r,
        y2: b.y - uy * b.r,
        w: textWidth(text, pillFont) + 28,
        h: PILL_H,
        text,
        full: lab.text,
        kind: kindOf.get(l.key)!,
      };
    };
    const pick = (ls: Link[]) => ls.map(item).filter((i): i is NonNullable<ReturnType<typeof item>> => !!i);
    const strong = (ls: Link[]) => [...ls].sort((p, q) => q.chunks.length - p.chunks.length);
    let chosen: ReturnType<typeof pick>;
    let force = false;
    if (active) {
      chosen = pick(strong(visible.filter((l) => l.a === active || l.b === active)));
      force = true;
    } else if (showLabels) chosen = pick(strong(visible));
    else chosen = [];
    if (hoverEdge && !chosen.some((c) => c.key === hoverEdge)) {
      const l = visible.find((v) => v.key === hoverEdge);
      if (l) chosen = [...pick([l]), ...chosen];
    }
    const spots = placeLabels(chosen, obstacles, force);
    return chosen.filter((c) => spots.has(c.key)).map((c) => ({ ...c, ...spots.get(c.key)! }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, vp, active, hoverEdge, showLabels, off, edges, x.labelOf, font]);

  const counts = new Map<RelKind, number>();
  for (const l of edges) counts.set(kindOf.get(l.key)!, (counts.get(kindOf.get(l.key)!) ?? 0) + 1);
  const legend = [...KIND_ORDER, "same" as RelKind].filter((k) => counts.get(k));

  const point = (e: React.PointerEvent) => ({ x: e.clientX, y: e.clientY });
  const onDown = (e: React.PointerEvent, node?: GNode) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    svgRef.current?.setPointerCapture(e.pointerId);
    const p = point(e);
    if (!pointers.current.size) suppressClick.current = false;
    if (isAndroid && e.pointerType === "touch") {
      pointers.current.set(e.pointerId, p);
      if (pointers.current.size === 2) {
        const [a, b] = [...pointers.current.values()];
        pinch.current = { distance: Math.hypot(b.x - a.x, b.y - a.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, vp };
        gesture.current = null;
        suppressClick.current = true;
        return;
      }
    }
    gesture.current = node
      ? { kind: "node", node, sx: p.x, sy: p.y, ox: node.x, oy: node.y, moved: false }
      : { kind: "pan", sx: p.x, sy: p.y, ox: vp.tx, oy: vp.ty, moved: false };
  };
  const onMove = (e: React.PointerEvent) => {
    if (isAndroid && pointers.current.has(e.pointerId)) {
      pointers.current.set(e.pointerId, point(e));
      const initial = pinch.current;
      if (initial && pointers.current.size === 2) {
        const [a, b] = [...pointers.current.values()];
        const box = svgRef.current!.getBoundingClientRect();
        const k = Math.max(.3, Math.min(3, initial.vp.k * Math.hypot(b.x - a.x, b.y - a.y) / Math.max(1, initial.distance)));
        const factor = k / initial.vp.k;
        setVp({ k, tx: (a.x + b.x) / 2 - box.left - (initial.x - box.left - initial.vp.tx) * factor, ty: (a.y + b.y) / 2 - box.top - (initial.y - box.top - initial.vp.ty) * factor });
        return;
      }
    }
    const g = gesture.current;
    if (!g) return;
    const dx = e.clientX - g.sx;
    const dy = e.clientY - g.sy;
    if (!g.moved && Math.hypot(dx, dy) < 4) return;
    g.moved = true;
    suppressClick.current = true;
    if (g.kind === "pan") setVp((v) => ({ ...v, tx: g.ox + dx, ty: g.oy + dy }));
    else if (g.node) {
      g.node.x = g.ox + dx / vp.k;
      g.node.y = g.oy + dy / vp.k;
      kept.current.set(g.node.key, { x: g.node.x, y: g.node.y });
      redraw((v) => v + 1);
    }
  };
  const onUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pinch.current) { if (!pointers.current.size) pinch.current = null; gesture.current = null; return; }
    const g = gesture.current;
    gesture.current = null;
    if (!g || g.moved) return;
    setEdgeKey(null);
    if (isAndroid && g.kind === "node" && g.node) { setEntityKey(g.node.key); return; }
    if (g.kind === "node" && g.node) setFocus((f) => (f === g.node!.key ? null : g.node!.key));
    else setFocus(null);
  };

  /** Merge pairs the AI called one person; returns the ones left as suggestions. */
  const autoMerge = (pairs: [string, string][]): [string, string][] => {
    const before = x.edits;
    const did: string[] = [];
    const keys: string[] = [];
    const left: [string, string][] = [];
    for (const [a, b] of pairs) {
      const r = mergeAsOne(x, a, b, true);
      if (r) {
        did.push(r);
        keys.push(pairKey(a, b));
      } else left.push([a, b]);
    }
    if (did.length)
      setMerged((m) =>
        m ? { ...m, text: [...new Set([...m.text, ...did])], pairs: [...new Set([...m.pairs, ...keys])] } : { text: did, before, pairs: keys },
      );
    return left;
  };
  const undoMerge = () => {
    if (!merged) return;
    const { before, pairs } = merged;
    // Back to how it was; these pairs are not merged again by themselves.
    x.setEdits(() => ({ ...before, autoMerged: [...new Set([...(before.autoMerged ?? []), ...pairs])] }));
    setMerged(null);
  };

  // Pairs the AI already called one person (from earlier runs): merge them once.
  useEffect(() => {
    const done = new Set(x.edits.autoMerged ?? []);
    const todo = Object.entries(x.ai.labels)
      .filter(([k, v]) => !done.has(k) && relKind(v.label) === "same")
      .map(([k]) => k.split("\u0001") as [string, string]);
    if (todo.length) autoMerge(todo);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [x.ai.labels]);

  const edge = edgeKey ? (allLinks.find((l) => l.key === edgeKey) ?? null) : null;
  const person = focus && !edge ? x.byKey.get(focus) : undefined;

  // When a panel opens over what was picked, slide the map left so it stays in view.
  useEffect(() => {
    const free = size.w - 420;
    if (free < 300) return;
    let wx: number | null = null;
    if (edgeKey) {
      const l = edges.find((v) => v.key === edgeKey);
      const a = l && byKey.get(l.a);
      const b = l && byKey.get(l.b);
      if (a && b) wx = (a.x + b.x) / 2;
    } else if (focus) wx = byKey.get(focus)?.x ?? null;
    if (wx == null) return;
    setVp((v) => {
      const sx = v.tx + v.k * wx!;
      return sx > free - 40 ? { ...v, tx: v.tx - (sx - free / 2) } : v;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, edgeKey]);
  const scopeHere = t.xrUpToHere.replace(" ({0}%)", "").replace(" ({0})", "");

  const controls = (
    <div className="xrg__tools">
          <label className="xrg__count">
            <span>{t.xrPeople}</span>
            <input type="range" min={2} max={Math.max(2, Math.min(80, people.length))} value={count} onChange={(e) => setCount(Number(e.target.value))} />
            <b>{Math.min(count, people.length)}</b>
          </label>
          <div className="xrg__scope" role="group" aria-label={t.xrgScope}>
            <button className={!x.wholeBook ? "is-on" : undefined} onClick={() => x.setWholeBook(false)} title={t.xrWholeBookHint}>
              {scopeHere}
            </button>
            <button className={x.wholeBook ? "is-on" : undefined} onClick={() => x.setWholeBook(true)}>
              {t.xrWholeBook}
            </button>
          </div>
          <AiButton lang={lang} x={x} view={view} title={title} provider={provider} people={shown} edges={edges} onSame={autoMerge} />
          {/* The Android sheet has its own close button in the header. */}
          {!isAndroid && (
            <button className="reader__tool" onClick={onClose} aria-label={t.xrClose} title={t.xrClose}>
              <Icon name="close" size={20} />
            </button>
          )}
        </div>
  );

  return (
    <div className="xrg" role="dialog" aria-label={t.xrGraph}>
      <header className="xrg__head">
        <div className="xrg__brand">
          {isAndroid ? <button className="reader__tool" onClick={onClose} aria-label={t.xrBack}><Icon name="arrowL" size={22} /></button> : <span className="xrg__logo"><Icon name="graph" size={18} /></span>}
          <div>
            <h2>{t.xrGraph}</h2>
            <p>
              <span className="xrg__book">{title}</span> · {t.xrgStats.replace("{0}", String(shown.length)).replace("{1}", String(edges.length))}
            </p>
          </div>
        </div>
        {isAndroid ? <button className="reader__tool mx-settings" onClick={() => setSettings(true)} aria-label={t.mxSettings}><Icon name="more" size={22} /></button> : controls}
      </header>
        {isAndroid && settings && <MobileReaderSheet title={t.mxSettings} closeLabel={t.xrClose} onClose={() => setSettings(false)}>{controls}</MobileReaderSheet>}

      {merged && (
        <div className="xrg__notice" role="status">
          <Icon name="check" size={16} />
          <span>
            {t.xrgAutoMerged.replace("{0}", String(merged.text.length))} <b>{merged.text.slice(0, 4).join(" · ")}</b>
            {merged.text.length > 4 ? " …" : ""}
          </span>
          <button className="xrg__undo" onClick={undoMerge}>
            {t.xrgUndo}
          </button>
          <button className="xrg__x" onClick={() => setMerged(null)} aria-label={t.xrClose}>
            <Icon name="close" size={15} />
          </button>
        </div>
      )}
      <div className="xrg__stage" ref={stageRef}>
        {shown.length < 2 ? (
          <p className="xrg__empty">{t.xrgEmpty}</p>
        ) : (
          <svg
            ref={svgRef}
            className={`xrg__svg${gesture.current?.kind === "pan" ? " is-panning" : ""}`}
            width={size.w}
            height={size.h}
            onPointerDown={(e) => onDown(e)}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={(e) => { pointers.current.delete(e.pointerId); pinch.current = null; gesture.current = null; }}
            onPointerLeave={() => setHover(null)}
          >
            <g className="xrg__edges">
              {visible.map((l) => {
                const a = byKey.get(l.a);
                const b = byKey.get(l.b);
                if (!a || !b) return null;
                const A = S(a);
                const B = S(b);
                const kind = kindOf.get(l.key)!;
                const dim = near && !(l.a === active || l.b === active);
                const on = edgeKey === l.key || hoverEdge === l.key;
                return (
                  <g
                    key={l.key}
                    className={`xrg__edge xrg__edge--${kind}${dim ? " is-dim" : ""}${on ? " is-on" : ""}`}
                    onPointerEnter={() => setHoverEdge(l.key)}
                    onPointerLeave={() => setHoverEdge(null)}
                    onPointerDown={(e) => { if (isAndroid) onDown(e); else e.stopPropagation(); }}
                    onClick={() => {
                      if (isAndroid && suppressClick.current) return;
                      setFocus(null);
                      setEdgeKey(l.key);
                    }}
                  >
                    <line x1={A.x} y1={A.y} x2={B.x} y2={B.y} className="xrg__hit" />
                    <line x1={A.x} y1={A.y} x2={B.x} y2={B.y} style={{ strokeWidth: 1.25 + (2.75 * l.chunks.length) / maxW }} />
                  </g>
                );
              })}
            </g>
            <g className="xrg__pills">
              {pills.map((p) => {
                const dim = near && !(edges.find((l) => l.key === p.key && (l.a === active || l.b === active)));
                return (
                  <g
                    key={p.key}
                    className={`xrg__pill xrg__pill--${p.kind}${dim ? " is-dim" : ""}${edgeKey === p.key ? " is-on" : ""}`}
                    transform={`translate(${p.x},${p.y})`}
                    onPointerEnter={() => setHoverEdge(p.key)}
                    onPointerLeave={() => setHoverEdge(null)}
                    onPointerDown={(e) => { if (isAndroid) onDown(e); else e.stopPropagation(); }}
                    onClick={() => {
                      if (isAndroid && suppressClick.current) return;
                      setFocus(null);
                      setEdgeKey(p.key);
                    }}
                  >
                    <title>{p.full}</title>
                    <rect x={-p.w / 2} y={-PILL_H / 2} width={p.w} height={PILL_H} rx={PILL_H / 2} />
                    <circle cx={-p.w / 2 + 12} cy={0} r={3.5} />
                    <text x={-p.w / 2 + 20} y={0.5}>
                      {p.text}
                    </text>
                  </g>
                );
              })}
            </g>
            <g className="xrg__nodes">
              {nodes.map((n) => {
                const e = x.byKey.get(n.key);
                if (!e) return null;
                const s = S(n);
                const big = (rank.get(n.key) ?? 99) < 3;
                const dim = near && !near.has(n.key);
                return (
                  <g
                    key={n.key}
                    className={`xrg__node${big ? " is-main" : ""}${e.narrator ? " is-narrator" : ""}${dim ? " is-dim" : ""}${focus === n.key ? " is-on" : ""}${hover === n.key ? " is-hover" : ""}`}
                    transform={`translate(${s.x},${s.y})`}
                    onPointerDown={(ev) => onDown(ev, n)}
                    onPointerEnter={() => setHover(n.key)}
                    onPointerLeave={() => setHover((h) => (h === n.key ? null : h))}
                    onDoubleClick={() => onOpenEntity(n.key)}
                  >
                    <circle className="xrg__halo" r={s.r + 6} />
                    <circle className="xrg__disc" r={s.r} />
                    {s.r >= 13 && (
                      <text className="xrg__ini" style={{ fontSize: Math.min(15, s.r * 0.72) }}>
                        {initials(e.name)}
                      </text>
                    )}
                    <text className="xrg__name" y={s.r + 16} style={{ font: nameFont(big) }}>
                      {e.name}
                    </text>
                  </g>
                );
              })}
            </g>
          </svg>
        )}

        <div className="xrg__legend">
          <div className="xrg__chips">
            {legend.map((k) => (
              <button
                key={k}
                className={`xrg__chip${off.has(k) ? " is-off" : ""}`}
                aria-pressed={!off.has(k)}
                onClick={() =>
                  setOff((o) => {
                    const n = new Set(o);
                    if (n.has(k)) n.delete(k);
                    else n.add(k);
                    return n;
                  })
                }
              >
                <svg width="22" height="8" className={`xrg__swatch xrg__edge--${k}`} aria-hidden>
                  <line x1="2" y1="4" x2="20" y2="4" />
                </svg>
                {t[`xrg_${k}` as const]}
                <span className="xrg__n">{counts.get(k)}</span>
              </button>
            ))}
            <span className="xrg__sep" />
            <label className="xrg__switch">
              <input type="checkbox" checked={showLabels} onChange={(e) => setShowLabels(e.target.checked)} />
              <i aria-hidden />
              {t.xrgLabels}
            </label>
          </div>
          <p className="xrg__hint">{t.xrgHint}</p>
        </div>

        <div className="xrg__zoom" role="group">
          <button onClick={() => zoomBy(1.25)} title={t.xrgZoomIn} aria-label={t.xrgZoomIn}>
            <Icon name="zoomIn" size={18} />
          </button>
          <button onClick={() => zoomBy(0.8)} title={t.xrgZoomOut} aria-label={t.xrgZoomOut}>
            <Icon name="zoomOut" size={18} />
          </button>
          <button onClick={fit} title={t.xrgFit} aria-label={t.xrgFit}>
            <Icon name="fit" size={18} />
          </button>
        </div>
      </div>

      {edge && (
        <EdgePanel
          key={edge.key}
          lang={lang}
          x={x}
          view={view}
          link={edge}
          onClose={() => setEdgeKey(null)}
          onPick={(k) => {
            setEdgeKey(null);
            setFocus(k);
          }}
          onMerged={() => setEdgeKey(null)}
        />
      )}
      {isAndroid && entityKey && x.byKey.get(entityKey) && <MobileReaderSheet title={x.byKey.get(entityKey)!.name} closeLabel={t.xrClose} onClose={() => setEntityKey(null)}><XRayDetail key={entityKey} lang={lang} x={x} view={view} e={x.byKey.get(entityKey)!} formatPos={formatPos} onBack={() => setEntityKey(null)} onSelect={setEntityKey} onGo={onGo} /></MobileReaderSheet>}
      {person && (
        <PersonPanel
          key={person.key}
          lang={lang}
          x={x}
          e={person}
          rels={allLinks.filter((l) => l.a === person.key || l.b === person.key).slice(0, 14)}
          onClose={() => setFocus(null)}
          onPickEdge={(k) => setEdgeKey(k)}
          onOpenEntity={() => onOpenEntity(person.key)}
          onRetype={(type) => {
            const key = person.key;
            setFocus(null);
            x.setEdits((ed) => (type === "hide" ? { ...ed, hidden: [...ed.hidden, key] } : { ...ed, types: { ...ed.types, [key]: type } }));
          }}
        />
      )}
    </div>
  );
}

/** A person picked on the map: who they are, their ties, and a way out if they are not a character. */
function PersonPanel({
  lang,
  x,
  e,
  rels,
  onClose,
  onPickEdge,
  onOpenEntity,
  onRetype,
}: {
  lang: Lang;
  x: XrayState;
  e: Entity;
  rels: Link[];
  onClose: () => void;
  onPickEdge: (key: string) => void;
  onOpenEntity: () => void;
  onRetype: (type: Exclude<XrType, "person"> | "hide") => void;
}) {
  const t = STR[lang];
  const desc = x.descriptionOf(e.key);
  return (
    <aside className="xrg__panel" aria-label={e.name}>
      <div className="xrg__phead">
        <span className="xrg__avatar">{initials(e.name)}</span>
        <div className="xrg__ptitle">
          <h3>{e.name}</h3>
          <span>{t.xrTimes.replace("{0}", String(upTo(e, x.limit).length))}</span>
        </div>
        <button className="reader__tool" onClick={onClose} aria-label={t.xrClose}>
          <Icon name="close" size={18} />
        </button>
      </div>
      {desc && (
        <p className="xr__desc">
          {desc} <span className="xr__badge">{t.xrAiBadge}</span>
        </p>
      )}
      <h4>
        {t.xrRelations} <span className="xrg__n">{rels.length}</span>
      </h4>
      {rels.length ? (
        <ul className="xrg__rels">
          {rels.map((l) => {
            const other = x.byKey.get(l.a === e.key ? l.b : l.a);
            if (!other) return null;
            const lab = x.labelOf(l.key);
            const kind = relKind(lab?.text);
            return (
              <li key={l.key}>
                <button onClick={() => onPickEdge(l.key)}>
                  <i className={`xrg__dot xrg__edge--${kind}`} aria-hidden />
                  <span className="xrg__rname">{other.name}</span>
                  <span className="xrg__rlab">{lab ? shortLabel(lab.text, 40) : t.xrTogether.replace("{0}", String(l.chunks.length))}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="xr__muted">{t.xrNoRelations}</p>
      )}
      <button className="btn xrg__open" onClick={onOpenEntity}>
        <Icon name="xray" size={16} />
        {t.xrgOpenXray}
      </button>
      <div className="xrg__notp">
        <span>{t.xrNotPerson.replace("{0}", e.name)}</span>
        <div>
          {(["place", "org", "term"] as const).map((k) => (
            <button key={k} className="xrg__notb" onClick={() => onRetype(k)}>
              <span className="xrg__noti" style={{ color: TYPE_COLOR[k] }}>
                <Icon name={TYPE_ICON[k]} size={15} />
              </span>
              {t[`xr_${k}` as const]}
            </button>
          ))}
          <button className="xrg__notb" onClick={() => onRetype("hide")}>
            <Icon name="trash" size={15} />
            {t.xrHideShort}
          </button>
        </div>
      </div>
    </aside>
  );
}

/** A tie picked on the map: the label (editable), the AI's reason, the passages behind it. */
function EdgePanel({
  lang,
  x,
  view,
  link,
  onClose,
  onPick,
  onMerged,
}: {
  lang: Lang;
  x: XrayState;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  view: any;
  link: Link;
  onClose: () => void;
  onPick: (key: string) => void;
  onMerged: () => void;
}) {
  const t = STR[lang];
  const a = x.byKey.get(link.a);
  const b = x.byKey.get(link.b);
  const lab = x.labelOf(link.key);
  const kind = relKind(lab?.text);
  const [text, setText] = useState(x.edits.labels[link.key] ?? "");
  const [passages, setPassages] = useState<string[] | null>(null);
  useEffect(() => {
    let gone = false;
    chunkTexts(view, x.index!, link.chunks.slice(0, 6)).then((m) => !gone && setPassages(link.chunks.slice(0, 6).map((c) => m.get(c) ?? "")));
    return () => {
      gone = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [link.key]);
  const save = () =>
    x.setEdits((ed) => {
      const labels = { ...ed.labels };
      if (text.trim()) labels[link.key] = text.trim();
      else delete labels[link.key];
      return { ...ed, labels };
    });
  if (!a || !b) return null;
  // The fuller name stays ("Tống Đình Đình" over "Đình Đình"), else the one seen more often.
  const words = (e: Entity) => e.name.split(/\s+/).length;
  const [big, small] = words(a) !== words(b) ? (words(a) > words(b) ? [a, b] : [b, a]) : a.mentions.length >= b.mentions.length ? [a, b] : [b, a];
  const merge = () => {
    mergeAsOne(x, a.key, b.key, false);
    onMerged();
  };
  return (
    <aside className="xrg__panel" aria-label={`${a.name} & ${b.name}`}>
      <div className="xrg__phead">
        <div className="xrg__pair">
          <button onClick={() => onPick(a.key)}>{a.name}</button>
          <span>&</span>
          <button onClick={() => onPick(b.key)}>{b.name}</button>
        </div>
        <button className="reader__tool" onClick={onClose} aria-label={t.xrClose}>
          <Icon name="close" size={18} />
        </button>
      </div>
      <span className={`xrg__kind xrg__edge--${kind}`}>
        <i className="xrg__dot" aria-hidden />
        {t[`xrg_${kind}` as const]}
      </span>
      {kind === "same" && (
        <div className="xrg__merge">
          <p>{t.xrgMergeHint}</p>
          <button className="btn btn--primary" onClick={merge}>
            {t.xrgMerge.replace("{0}", small.name).replace("{1}", big.name)}
          </button>
        </div>
      )}
      {lab?.from === "ai" && (
        <p className="xr__desc">
          <b>{lab.text}</b> <span className="xr__badge">{t.xrAiBadge}</span>
          {lab.detail && (
            <>
              <br />
              {lab.detail}
            </>
          )}
        </p>
      )}
      <label className="xrg__label">
        <span>
          {t.xrLabel}
          {x.edits.labels[link.key] && <span className="xr__badge xr__badge--you">{t.xrYours}</span>}
        </span>
        <input value={text} placeholder={lab?.text ?? t.xrLabelPlaceholder} onChange={(e) => setText(e.target.value)} onBlur={save} onKeyDown={(e) => e.key === "Enter" && save()} />
      </label>
      <h4>{t.xrTogether.replace("{0}", String(link.chunks.length))}</h4>
      <div className="xrg__passages">
        {passages == null ? <p className="xr__muted">{t.dcLoading}</p> : passages.map((p, i) => <p key={i}>{p.length > 600 ? p.slice(0, 600) + "…" : p}</p>)}
      </div>
    </aside>
  );
}

interface Estimate {
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  exact_input: boolean;
  model: string;
}
interface RunResult {
  result: { people?: { id: string; description: string; same_as?: string }[]; pairs?: { id: string; label: string; detail: string }[] };
  cost_usd: number;
}

/** People and pairs per request: small answers that never hit the output limit. */
const BATCH_PEOPLE = 8;
const BATCH_PAIRS = 12;

function batches(job: Job): Job[] {
  const out: Job[] = [];
  for (let i = 0; i * BATCH_PEOPLE < job.people.length || i * BATCH_PAIRS < job.pairs.length; i++) {
    out.push({
      ...job,
      people: job.people.slice(i * BATCH_PEOPLE, (i + 1) * BATCH_PEOPLE),
      pairs: job.pairs.slice(i * BATCH_PAIRS, (i + 1) * BATCH_PAIRS),
    });
  }
  return out;
}

function halves(job: Job): Job[] {
  const p = Math.ceil(job.people.length / 2);
  const r = Math.ceil(job.pairs.length / 2);
  return [
    { ...job, people: job.people.slice(0, p), pairs: job.pairs.slice(0, r) },
    { ...job, people: job.people.slice(p), pairs: job.pairs.slice(r) },
  ].filter((j) => j.people.length || j.pairs.length);
}

interface Job {
  title: string;
  lang: string;
  people: { id: string; name: string; aliases: string[]; previous?: string; passages: string[] }[];
  pairs: { id: string; a: string; b: string; previous?: string; passages: string[] }[];
  /** Everyone on the map with their ids, so `same_as` can name someone in another batch. */
  roster: { id: string; name: string }[];
}

function trimPassage(s: string, names: string[]): string {
  if (s.length <= 700) return s;
  // Keep the part around the first name.
  const at = Math.max(0, Math.min(...names.map((n) => (s.indexOf(n) < 0 ? s.length : s.indexOf(n)))) - 250);
  return (at > 0 ? "…" : "") + s.slice(at, at + 700) + (at + 700 < s.length ? "…" : "");
}

/** "Label with AI": build the job from what is new since last time, show the cost, send. */
function AiButton({
  lang,
  x,
  view,
  title,
  provider,
  people,
  edges,
  onSame,
}: {
  lang: Lang;
  x: XrayState;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  view: any;
  title: string;
  provider: AiProvider;
  people: Entity[];
  edges: Link[];
  /** Pairs the AI says are one person; returns those not merged (left as suggestions). */
  onSame: (pairs: [string, string][]) => [string, string][];
}) {
  const t = STR[lang];
  const [stage, setStage] = useState<
    | { s: "idle" }
    | { s: "preparing" }
    | { s: "nokey" }
    | { s: "confirm"; job: Job; ids: Map<string, string>; est: { input_tokens: number; output_tokens: number; cost_usd: number; exact_input: boolean; model: string }; passages: number }
    | { s: "running"; done: number; total: number }
    | { s: "done"; msg: string }
    | { s: "error"; msg: string }
  >({ s: "idle" });
  const [key, setKey] = useState("");
  const name = PROVIDER_NAME[provider];
  const usd = (v: number) => (v < 0.01 ? "< $0.01" : `$${v.toFixed(2)}`);

  async function prepare() {
    setStage({ s: "preparing" });
    try {
      const status = await invoke<{ anthropic: string | null; deepseek: string | null }>("ai_key_status");
      if (!status[provider]) {
        setStage({ s: "nokey" });
        return;
      }
      const limit = x.limit;
      const ids = new Map<string, string>();
      // Written for the reader, in the app's language (the book's own tag is often wrong).
      const listed = people.slice(0, 40);
      const job: Job = { title, lang, people: [], pairs: [], roster: listed.map((e, i) => ({ id: `p${i + 1}`, name: e.name })) };
      listed.forEach((e, i) => ids.set(`p${i + 1}`, e.key));
      const roleForms = new Set(x.index!.forms.filter((f) => f.role).map((f) => f.form));
      let passages = 0;
      // People: a few sentences each from what was read since the last run.
      for (const [i, e] of listed.entries()) {
        const old = x.ai.descriptions[e.key];
        const prev = old?.lang === lang ? old : undefined;
        // "Tôi (người kể)" / "Bố tôi" not yet tied to a name: always ask, with more to go on.
        const unnamed = e.forms.every((f) => roleForms.has(f));
        const seen = upTo(e, limit);
        const fresh = unnamed ? seen : seen.filter((m) => !prev || m[4] > prev.upTo);
        if (!fresh.length) continue;
        const spots = unnamed ? [0, 0.2, 0.4, 0.6, 0.8, 1] : [0, 0.5, 1];
        const pick = spots.map((f) => fresh[Math.min(fresh.length - 1, Math.floor(f * (fresh.length - 1)))]).filter((m, k, arr) => arr.indexOf(m) === k);
        const ctx = await mentionContexts(view, pick);
        const id = `p${i + 1}`;
        job.people.push({ id, name: e.name, aliases: e.forms.filter((f) => f !== e.name).slice(0, 4), previous: prev?.text, passages: ctx });
        passages += ctx.length;
      }
      // Pairs: up to three new passages where both appear (not the ones the reader labelled).
      let r = 0;
      for (const l of edges.slice(0, 50)) {
        if (x.edits.labels[l.key] || x.labelOf(l.key)?.from === "auto") continue;
        const old = x.ai.labels[l.key];
        const prev = old?.lang === lang ? old : undefined;
        const fresh = l.chunks.filter((c) => !prev || x.index!.chunks[c].fraction > prev.upTo);
        if (!fresh.length) continue;
        const pick = fresh.length <= 3 ? fresh : [fresh[0], fresh[Math.floor(fresh.length / 2)], fresh[fresh.length - 1]];
        const texts = await chunkTexts(view, x.index!, pick);
        const a = x.byKey.get(l.a)!;
        const b = x.byKey.get(l.b)!;
        const id = `r${++r}`;
        ids.set(id, l.key);
        job.pairs.push({
          id,
          a: a.name,
          b: b.name,
          previous: prev?.label,
          passages: pick.map((c) => trimPassage(texts.get(c) ?? "", [...a.forms, ...b.forms])).filter(Boolean),
        });
        passages += pick.length;
      }
      if (!job.people.length && !job.pairs.length) {
        setStage({ s: "done", msg: t.xrAiNothing });
        return;
      }
      // Estimate every batch (the instructions repeat in each) and add them up.
      const est = { input_tokens: 0, output_tokens: 0, cost_usd: 0, exact_input: true, model: "" };
      for (const b of batches(job)) {
        const e = await invoke<Estimate>("xray_ai_estimate", { provider, job: b });
        est.input_tokens += e.input_tokens;
        est.output_tokens += e.output_tokens;
        est.cost_usd += e.cost_usd;
        est.exact_input &&= e.exact_input;
        est.model = e.model;
      }
      setStage({ s: "confirm", job, ids, est, passages });
    } catch (e) {
      setStage({ s: "error", msg: String(e) });
    }
  }

  async function run(job: Job, ids: Map<string, string>) {
    const limit = x.limit;
    const queue = batches(job);
    let total = queue.length;
    let done = 0;
    let nl = 0;
    let nd = 0;
    let spent = 0;
    setStage({ s: "running", done, total });
    try {
      while (queue.length) {
        const b = queue.shift()!;
        let res: RunResult;
        try {
          res = await invoke<RunResult>("xray_ai_run", { provider, job: b });
        } catch (e) {
          // Cut off: send the batch again in two halves.
          const size = b.people.length + b.pairs.length;
          if (String(e) === "max_tokens" && size > 1) {
            queue.unshift(...halves(b));
            total += 1;
            setStage({ s: "running", done, total });
            continue;
          }
          throw e;
        }
        spent += res.cost_usd;
        const people = (res.result.people ?? []).filter((p) => ids.has(p.id) && p.description?.trim());
        const pairs = (res.result.pairs ?? []).filter((p) => ids.has(p.id) && p.label?.trim());
        nd += people.length;
        nl += pairs.length;
        // The AI says two names are one person: merge them now (or suggest it, when not plausible from the names).
        const same: [string, string][] = [];
        for (const p of people) {
          const other = p.same_as?.trim();
          if (other && other !== p.id && ids.has(other)) same.push([ids.get(p.id)!, ids.get(other)!]);
        }
        for (const p of pairs) if (relKind(p.label) === "same") same.push(ids.get(p.id)!.split("\u0001") as [string, string]);
        const suggest = onSame(same);
        // Save each batch as it comes, so a later failure keeps what was done.
        x.setAi((ai) => {
          const next = { ...ai, upTo: Math.max(ai.upTo, limit), provider, descriptions: { ...ai.descriptions }, labels: { ...ai.labels } };
          for (const p of people) next.descriptions[ids.get(p.id)!] = { text: p.description.trim(), upTo: limit, lang };
          for (const p of pairs) next.labels[ids.get(p.id)!] = { label: p.label.trim(), detail: p.detail?.trim() ?? "", upTo: limit, lang };
          // A "same as" that was not merged shows on the map as a suggestion with a merge button.
          for (const [a, b] of suggest) {
            const k = pairKey(a, b);
            if (relKind(next.labels[k]?.label) !== "same") next.labels[k] = { label: t.xrgSameLabel, detail: "", upTo: limit, lang };
          }
          return next;
        });
        done++;
        setStage({ s: "running", done, total });
      }
      setStage({ s: "done", msg: t.xrAiDone.replace("{0}", String(nl)).replace("{1}", String(nd)).replace("{2}", usd(spent)) });
    } catch (e) {
      const msg = String(e);
      const why = msg === "max_tokens" ? t.xrAiTooLong : msg === "refusal" ? t.xrAiRefused : msg === "no_key" ? t.xrAiNoKey.replace("{0}", name) : msg;
      setStage({ s: "error", msg: done ? `${why} (${t.xrAiPartial.replace("{0}", String(nl)).replace("{1}", String(nd))})` : why });
    }
  }

  const hasAi = Object.keys(x.ai.labels).length > 0;
  return (
    <div className="xrg__ai">
      <button className="btn btn--primary xrg__aibtn" onClick={prepare} disabled={stage.s === "preparing" || stage.s === "running"}>
        <Icon name="sparkle" size={15} />
        {hasAi ? t.xrAiUpdate : t.xrAiRun} · {name}
      </button>
      {stage.s !== "idle" && stage.s !== "preparing" && (
        <div className="xrg__aipop">
          {stage.s === "nokey" && (
            <>
              <p>{t.xrAiNoKey.replace("{0}", name)}</p>
              <div className="xrg__keyrow">
                <input type="password" value={key} placeholder={t.rsKeyPlaceholder} onChange={(e) => setKey(e.target.value)} />
                <button
                  className="btn btn--primary"
                  onClick={() =>
                    invoke("ai_key_set", { provider, key })
                      .then(() => {
                        setKey("");
                        prepare();
                      })
                      .catch((e) => setStage({ s: "error", msg: String(e) === "bad key" ? t.rsKeyBad : t.rsKeySaveFailed.replace("{0}", String(e)) }))
                  }
                >
                  {t.rsKeySave}
                </button>
              </div>
            </>
          )}
          {stage.s === "confirm" && (
            <>
              <b>{t.xrAiConfirmTitle.replace("{0}", `${name} (${stage.est.model})`)}</b>
              <p>{t.xrAiConfirmBody.replace("{0}", String(stage.job.pairs.length)).replace("{1}", String(stage.job.people.length)).replace("{2}", String(stage.passages))}</p>
              <p className="xr__muted">
                {t.xrAiCost
                  .replace("{0}", stage.est.input_tokens.toLocaleString())
                  .replace("{1}", stage.est.output_tokens.toLocaleString())
                  .replace("{2}", usd(stage.est.cost_usd))}{" "}
                {!stage.est.exact_input && t.xrAiCostRough}
              </p>
              <div className="dict__actions">
                <button className="btn btn--primary" onClick={() => run(stage.job, stage.ids)}>
                  {t.xrAiSend}
                </button>
                <button className="btn" onClick={() => setStage({ s: "idle" })}>
                  {t.xrAiCancel}
                </button>
              </div>
            </>
          )}
          {stage.s === "running" && (
            <>
              <p>
                {t.xrAiWorking.replace("{0}", name)} {stage.total > 1 ? `(${stage.done}/${stage.total})` : ""}
              </p>
              <div className="bsearch__progress">
                <i style={{ width: `${(stage.done / Math.max(1, stage.total)) * 100}%` }} />
              </div>
            </>
          )}
          {(stage.s === "done" || stage.s === "error") && (
            <>
              <p className={stage.s === "error" ? "dict__err" : undefined}>{stage.s === "error" ? t.xrAiFail.replace("{0}", stage.msg) : stage.msg}</p>
              <div className="dict__actions">
                <button className="btn" onClick={() => setStage({ s: "idle" })}>
                  {t.xrClose}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
