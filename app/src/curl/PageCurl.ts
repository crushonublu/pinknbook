/**
 * Apple-Books-style page curl on top of a foliate-js `<foliate-view>`.
 *
 * foliate keeps turning pages itself (instantly, no `animated` attribute). For
 * each turn we lay an opaque canvas over the reading area that first shows a
 * bitmap of the current page (indistinguishable from the live page), then curl
 * that bitmap away to reveal a bitmap of the next one. foliate is navigated
 * underneath while the canvas covers it, and the canvas is removed once the
 * live page matches the last frame.
 *
 * Pages of the current section are rendered off-screen (see snapshot.ts) and
 * prefetched after every relocation, so a turn normally starts immediately.
 * Crossing into another section navigates first and snapshots the result.
 *
 * Interaction: arrow keys / nav buttons / taps on the page edges run a full
 * automatic curl; dragging from a page edge holds the fold under the finger.
 * Let go past the middle (or flick) and the page turns, otherwise it falls back.
 */
import { mirror, solveCurl, solveCurlInto, type Vec, type Curl } from "./geometry";
import { backTexture, pageTexture, type Scene } from "./render";
import { CanvasCurlRenderer, WebGLCurlRenderer, type CurlRenderer } from "./webgl";
import { snapshotPage } from "./snapshot";

/* eslint-disable @typescript-eslint/no-explicit-any */
type FoliateView = any;
type Dir = 1 | -1;

interface Layout {
  doc: Document;
  index: number;
  page: number;
  pages: number;
  size: number;
  docWidth: number;
  docHeight: number;
  docTop: number;
  containerLeft: number;
  /** Host (canvas) size in CSS px. */
  hostW: number;
  H: number;
  spread: boolean;
  /** Width of one page (half the spread, or the whole single page). */
  W: number;
  spine: number;
  dpr: number;
  paper: string;
  key: string;
}

interface Prep {
  L: Layout;
  dir: Dir;
  cur: HTMLCanvasElement;
  other: HTMLCanvasElement;
  navigated: boolean;
  scene: Scene;
  /** Single-page "previous": the earlier sheet curls back in from the left. */
  reverse: boolean;
}

class NoCurl extends Error {}

const AUTO_MS = 520;
const CACHE_MAX = 6;
const SNAP_TIMEOUT = 2500;

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
const lerp = (p: Vec, q: Vec, t: number): Vec => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = window.setTimeout(() => reject(new Error("snapshot timeout")), ms);
    p.then(
      (v) => (window.clearTimeout(id), resolve(v)),
      (e) => (window.clearTimeout(id), reject(e)),
    );
  });
}

/** Cheap fingerprint of a section's styling: changes when its CSS or fonts do. */
function styleSignature(doc: Document): string {
  let h = 0;
  const add = (t: string | null | undefined) => {
    if (t) for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0;
    h = (h * 31 + 7) | 0;
  };
  for (const st of Array.from(doc.querySelectorAll?.("style") ?? [])) add(st.textContent);
  add(doc.documentElement?.getAttribute?.("style"));
  add(doc.documentElement?.className);
  return `${h}:${doc.fonts?.status ?? ""}`;
}

function opaqueBg(el: Element | null, win: Window = window): string | null {
  if (!el) return null;
  const c = win.getComputedStyle(el).backgroundColor;
  if (!c || c === "transparent" || /rgba\(.*,\s*0\)$/.test(c)) return null;
  return c;
}

interface Drag {
  id: number;
  dir: Dir;
  zone: HTMLElement | null;
  releasing?: boolean;
  x0: number;
  y0: number;
  x: number;
  y: number;
  moved: number;
  samples: { x: number; t: number }[];
  sampleIndex: number;
  prep: Promise<Prep | null | "nocurl">;
  ready: Prep | null;
  G: Vec | null;
  raf: number;
}

export interface PageCurlOptions {
  /** Disable mouse edge overlays for iframe-owned touch gestures. */
  zones?: boolean;
  /** Android opt-in; desktop retains Canvas 2D. */
  renderer?: "webgl";
  /** Use only ready bitmaps: a cold mobile turn must never wait for snapshots. */
  readyOnly?: boolean;
  navigate?: (dir: Dir) => Promise<void>;
}

export class PageCurl {
  /** Turn the effect off to get foliate's plain instant page turns. */
  enabled = true;

  private canvas = document.createElement("canvas");
  private ctx = this.canvas.getContext("2d")!;
  private renderer: CurlRenderer;
  private gpuCurl: Curl = { G: { x: 0, y: 0 }, F: { x: 0, y: 0 }, u: { x: -1, y: 0 }, a: 0, R: 0 };
  private finger: Vec = { x: 0, y: 0 };
  private touchMove = { pointerId: -1, clientX: 0, clientY: 0 };
  private zones: HTMLDivElement[] = [];
  private cache = new Map<string, Promise<HTMLCanvasElement>>();
  private readySnapshots = new Map<string, HTMLCanvasElement>();
  private styleGen = 0;
  private busy = false;
  private hurry = false;
  private queue: Dir[] = [];
  private drag: Drag | null = null;
  private prefetchTimer = 0;
  private resizeObs: ResizeObserver;
  private reduced = matchMedia("(prefers-reduced-motion: reduce)");
  private destroyed = false;

  constructor(
    private host: HTMLElement,
    private view: FoliateView,
    private options: PageCurlOptions = {},
  ) {
    this.canvas.className = "curl-canvas";
    this.canvas.setAttribute("aria-hidden", "true");
    this.canvas.style.display = "none";
    host.append(this.canvas);
    const fallback = new CanvasCurlRenderer(this.ctx);
    this.renderer = fallback;
    if (options.renderer === "webgl") {
      try { this.renderer = new WebGLCurlRenderer(fallback, this.canvas); }
      catch { /* WebGL unavailable: retain Canvas 2D. */ }
    }
    for (const dir of (options.zones === false ? [] : [-1, 1]) as Dir[]) {
      const z = document.createElement("div");
      z.className = `curl-zone curl-zone--${dir < 0 ? "prev" : "next"}`;
      z.setAttribute("aria-hidden", "true");
      z.addEventListener("pointerdown", (e) => this.onDown(e, dir, z));
      z.addEventListener("pointermove", (e) => this.onMove(e));
      z.addEventListener("pointerup", (e) => this.onUp(e, false));
      z.addEventListener("pointercancel", (e) => this.onUp(e, true));
      host.append(z);
      this.zones.push(z);
    }
    view.addEventListener("relocate", this.onRelocate);
    view.addEventListener("load", this.onRelocate);
    this.resizeObs = new ResizeObserver(() => {
      this.hurry = this.busy;
      this.layoutZones();
    });
    this.resizeObs.observe(host);
    this.onRelocate();
  }

  destroy() {
    this.destroyed = true;
    this.hurry = true;
    window.clearTimeout(this.prefetchTimer);
    this.view.removeEventListener("relocate", this.onRelocate);
    this.view.removeEventListener("load", this.onRelocate);
    this.resizeObs.disconnect();
    this.renderer.destroy();
    this.canvas.remove();
    this.zones.forEach((z) => z.remove());
    this.cache.clear();
    this.readySnapshots.clear();
  }

  /** Styles (font size, theme) changed: cached page bitmaps are stale. */
  invalidate() {
    this.styleGen++;
    this.cache.clear();
    this.readySnapshots.clear();
    this.onRelocate();
  }

  /** Turn one page forward (1) or back (-1), with the curl when possible. */
  turn(dir: Dir) {
    if (this.destroyed) return;
    if (this.busy) {
      if (this.queue.length < 2) this.queue.push(dir);
      this.hurry = true;
      return;
    }
    void this.run(() => this.autoTurn(dir));
  }

  // ───────────────────────── layout ─────────────────────────

  /** External touch drag; coordinates are in the main window's client space.
   * False means the effect is busy: the gesture must still be consumed. */
  beginDrag(dir: Dir, clientX: number, clientY: number, startedAt = performance.now()): boolean {
    if (this.destroyed || this.busy || this.drag) return false;
    this.onDown({ button: 0, pointerId: -1, clientX, clientY, preventDefault() {} } as PointerEvent, dir, null, startedAt);
    return true;
  }

  moveDrag(clientX: number, clientY: number) {
    if (this.drag?.releasing) return;
    this.touchMove.clientX=clientX; this.touchMove.clientY=clientY;
    this.onMove(this.touchMove as PointerEvent);
  }

  endDrag(cancelled = false) {
    this.onUp({ pointerId: -1 } as PointerEvent, cancelled);
  }

  get running() { return this.busy; }

  private measure(): Layout | null {
    const r = this.view?.renderer;
    if (!r || r.tagName !== "FOLIATE-PAGINATOR" || r.scrolled) return null;
    if (this.view.book?.dir === "rtl" || r.getAttribute("dir") === "rtl") return null;
    const content = r.getContents?.()[0];
    const doc: Document | undefined = content?.doc;
    const win = doc?.defaultView;
    const frameEl = win?.frameElement as HTMLElement | null | undefined;
    if (!doc || !win || !frameEl || !doc.body) return null;
    if (win.getComputedStyle(doc.body).writingMode.startsWith("vertical")) return null;

    const host = this.host.getBoundingClientRect();
    const fr = frameEl.getBoundingClientRect();
    const size: number = r.size;
    const pages: number = r.pages;
    if (!size || !fr.width || !fr.height || !host.width || pages < 3) return null;

    const rootStyle = doc.documentElement.style;
    const colW = parseFloat(rootStyle.getPropertyValue("column-width"));
    const gap = parseFloat(rootStyle.getPropertyValue("column-gap")) || 0;
    const cols = colW > 0 ? Math.max(1, Math.round(size / (colW + gap))) : 1;
    const spread = cols >= 2;
    // The iframe sits one page-width into foliate's scroller, which is scrolled
    // by `start`; that puts the visible column window here (host-relative):
    const containerLeft = fr.left + r.start - size - host.left;
    const W = spread ? size / 2 : size;
    const dpr = Math.min(2, window.devicePixelRatio || 1);

    let paper = opaqueBg(doc.body, win) ?? opaqueBg(doc.documentElement, win);
    for (let el: Element | null = this.host; !paper && el; el = el.parentElement) paper = opaqueBg(el);
    paper ??= "#ffffff";

    const index: number = content.index;
    const parts: unknown[] = [index, size, fr.width, fr.height, host.height, this.styleGen, dpr, paper];
    // Touch mode (Android): the section's styles can still change after the
    // first relocation (reader CSS, injected styles, web fonts), which would
    // leave stale bitmaps that break lines differently from the live page.
    if (this.options.readyOnly) parts.push(styleSignature(doc));
    const key = parts.join("|");
    return {
      doc,
      index,
      page: r.page,
      pages,
      size,
      docWidth: fr.width,
      docHeight: fr.height,
      docTop: fr.top - host.top,
      containerLeft,
      hostW: host.width,
      H: host.height,
      spread,
      W,
      spine: spread ? containerLeft + W : containerLeft,
      dpr,
      paper,
      key,
    };
  }

  private posKey(): string {
    const r = this.view?.renderer;
    return `${r?.getContents?.()[0]?.index}:${r?.page}`;
  }

  private layoutZones() {
    const L = this.measure();
    const usable = !!L && this.enabled && !this.reduced.matches;
    for (const z of this.zones) z.style.display = usable ? "block" : "none";
    if (!L || !usable || !this.zones.length) return;
    const grab = Math.max(36, Math.min(110, L.W * 0.12));
    const [prev, next] = this.zones;
    prev.style.left = "0px";
    prev.style.width = `${Math.max(grab, L.containerLeft + grab)}px`;
    const right = L.containerLeft + L.size;
    next.style.left = `${right - grab}px`;
    next.style.width = `${Math.max(grab, L.hostW - right + grab)}px`;
  }

  // ───────────────────────── snapshots ─────────────────────────

  private snap(L: Layout, page: number): Promise<HTMLCanvasElement> {
    const key = `${L.key}|${page}`;
    let p = this.cache.get(key);
    if (p) {
      this.cache.delete(key);
      this.cache.set(key, p);
      return p;
    }
    p = withTimeout(
      snapshotPage(L.doc, {
        page,
        size: L.size,
        docWidth: L.docWidth,
        docHeight: L.docHeight,
        docTop: L.docTop,
        height: L.H,
        paper: L.paper,
        dpr: L.dpr,
        layoutKey: `${L.key}`,
      }),
      SNAP_TIMEOUT,
    );
    p.then((canvas) => {
      if (!this.destroyed && this.cache.get(key) === p) this.readySnapshots.set(key, canvas);
    }, () => { this.cache.delete(key); this.readySnapshots.delete(key); });
    this.cache.set(key, p);
    while (this.cache.size > CACHE_MAX) {
      const oldest = this.cache.keys().next().value!;
      this.cache.delete(oldest);
      this.readySnapshots.delete(oldest);
    }
    return p;
  }

  private onRelocate = () => {
    window.clearTimeout(this.prefetchTimer);
    this.prefetchTimer = window.setTimeout(async () => {
      if (this.destroyed) return;
      this.layoutZones();
      if (this.busy || !this.enabled || this.reduced.matches) return;
      const L = this.measure();
      if (!L) return;
      if (this.options.readyOnly && L.doc.fonts?.status === "loading") {
        void L.doc.fonts.ready.then(() => this.onRelocate());
        return;
      }
      for (const p of [L.page, L.page + 1, L.page - 1]) {
        if (p < 1 || p > L.pages - 2 || this.busy) continue;
        await this.snap(L, p).catch(() => undefined);
      }
    }, 200);
  };

  // ───────────────────────── canvas ─────────────────────────

  private show(L: Layout) {
    const w = Math.round(L.hostW * L.dpr);
    const h = Math.round(L.H * L.dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.canvas.style.display = "block";
  }

  private hide() {
    this.renderer.clear();
    this.canvas.style.display = "none";
  }

  /** Paint a page snapshot exactly where the live page is. */
  private paint(snap: HTMLCanvasElement, L: Layout) {
    this.renderer.clear();
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(snap, L.containerLeft * L.dpr, 0);
  }

  private render(prep: Prep, F: Vec, G: Vec) {
    const { W, H } = prep.L;
    this.renderer.setScene(prep.scene);
    this.renderer.draw(this.options.renderer === "webgl" ? solveCurlInto(G, F, W, H, this.gpuCurl) : solveCurl(G, F, W, H));
  }

  // ───────────────────────── turning ─────────────────────────

  private nav(dir: Dir): Promise<void> {
    if (this.destroyed) return Promise.resolve();
    if (this.options.navigate) return this.options.navigate(dir);
    return dir > 0 ? this.view.next() : this.view.prev();
  }

  private async run(job: () => Promise<void>) {
    this.busy = true;
    this.hurry = this.queue.length > 0;
    try {
      await job();
    } catch (e) {
      console.warn("[curl]", e);
      this.hide();
    } finally {
      this.busy = false;
      this.hurry = false;
      const next = this.queue.shift();
      if (next && !this.destroyed) this.turn(next);
      else this.onRelocate();
    }
  }

  /**
   * Show the current page on the canvas and get the bitmap of the page we are
   * turning to. Throws NoCurl if nothing was navigated and the caller should
   * fall back to a plain turn; returns null if foliate already moved (or could
   * not move) and there is nothing left to animate.
   */
  private async prepare(L: Layout, dir: Dir): Promise<Prep | null> {
    if (this.options.readyOnly && (
      !this.readySnapshots.has(`${L.key}|${L.page}`) ||
      !this.readySnapshots.has(`${L.key}|${L.page + dir}`)
    )) throw new NoCurl();
    let cur: HTMLCanvasElement;
    try {
      cur = await this.snap(L, L.page);
    } catch {
      throw new NoCurl();
    }
    if (this.destroyed) return null;
    this.show(L);
    this.paint(cur, L);

    const target = L.page + dir;
    let other: HTMLCanvasElement;
    let navigated = false;
    if (target >= 1 && target <= L.pages - 2) {
      try {
        other = await this.snap(L, target);
      } catch {
        this.hide();
        throw new NoCurl();
      }
    } else {
      // The neighbour lives in another section: let foliate load it first.
      const before = this.posKey();
      await this.nav(dir);
      navigated = true;
      await frame();
      await frame();
      const M = this.measure();
      if (!M || this.posKey() === before || M.spread !== L.spread || M.size !== L.size || M.H !== L.H) {
        this.hide();
        return null;
      }
      try {
        other = await this.snap(M, M.page);
      } catch {
        this.hide();
        return null;
      }
    }
    return { L, dir, cur, other, navigated, scene: this.buildScene(L, dir, cur, other), reverse: !L.spread && dir < 0 };
  }

  private buildScene(L: Layout, dir: Dir, cur: HTMLCanvasElement, other: HTMLCanvasElement): Scene {
    const { W, H, dpr, paper } = L;
    const tex = (src: HTMLCanvasElement, right: boolean, flip: boolean) =>
      pageTexture(src, right ? W : 0, W, H, dpr, flip);
    if (L.spread) {
      // Forward: the right page turns; its back is the next spread's left page.
      // Back: mirror everything (m = −1) so the left page turns to the right.
      const fwd = dir > 0;
      const front = tex(cur, fwd, !fwd);
      return {
        W,
        H,
        dpr,
        paper,
        spread: true,
        spine: L.spine,
        m: fwd ? 1 : -1,
        front,
        back: backTexture(front, tex(other, !fwd, fwd), paper),
        under: tex(other, fwd, !fwd),
        opposite: tex(cur, !fwd, !fwd),
      };
    }
    const sheet = tex(dir > 0 ? cur : other, false, false);
    return {
      W,
      H,
      dpr,
      paper,
      spread: false,
      spine: L.spine,
      m: 1,
      front: sheet,
      back: backTexture(sheet, null, paper),
      under: tex(dir > 0 ? other : cur, false, false),
    };
  }

  /** Put foliate where the last frame shows, then drop the canvas. */
  private async commit(prep: Prep, completed: boolean) {
    this.paint(completed ? prep.other : prep.cur, prep.L);
    if (completed && !prep.navigated) await this.nav(prep.dir);
    else if (!completed && prep.navigated) await this.nav(-prep.dir as Dir);
    await frame();
    await frame();
    this.hide();
  }

  private tween(ms: number, ease: (t: number) => number, step: (t: number) => void): Promise<void> {
    return new Promise((resolve) => {
      const t0 = performance.now();
      const tick = (now: number) => {
        const t = this.hurry || this.destroyed ? 1 : Math.min(1, (now - t0) / ms);
        step(ease(t));
        if (t < 1) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
  }

  /** Animate the held point from `from` to `to`, optionally lifting the corner. */
  private animate(prep: Prep, G: Vec, from: Vec, to: Vec, ms: number, ease: (t: number) => number, arc = 0) {
    const held = this.options.renderer === "webgl" ? { x: 0, y: 0 } : null;
    return this.tween(ms, ease, (t) => {
      const F = held ?? lerp(from, to, t);
      if (held) { F.x=from.x+(to.x-from.x)*t; F.y=from.y+(to.y-from.y)*t; }
      F.y -= arc * Math.sin(Math.PI * t);
      this.render(prep, F, G);
    });
  }

  private async autoTurn(dir: Dir) {
    const L = this.measure();
    if (!L || !this.enabled || this.reduced.matches) return this.nav(dir);
    let prep: Prep | null;
    try {
      prep = await this.prepare(L, dir);
    } catch (e) {
      if (e instanceof NoCurl) return this.nav(dir);
      throw e;
    }
    if (!prep) return;
    const G = { x: prep.L.W * 0.97, y: prep.L.H * 0.86 };
    const [from, to] = prep.reverse ? [mirror(G), G] : [G, mirror(G)];
    await this.animate(prep, G, from, to, AUTO_MS, easeInOut, prep.L.H * 0.05);
    await this.commit(prep, true);
  }

  // ───────────────────────── dragging ─────────────────────────

  /** Finger position in sheet coordinates for the current drag. */
  private fingerOf(d: Drag, prep: Prep, G: Vec, out?: Vec): Vec {
    const dx = (d.x - d.x0) * prep.scene.m;
    const dy = d.y - d.y0;
    const F = out ?? { x: 0, y: 0 };
    F.x = prep.reverse ? -G.x + (dx * 2 * G.x) / prep.L.W : G.x + dx;
    F.y = G.y + dy;
    return F;
  }

  private onDown(e: PointerEvent, dir: Dir, zone: HTMLElement | null, startedAt = performance.now()) {
    if (e.button !== 0 || this.drag) return;
    e.preventDefault();
    if (this.busy) {
      this.turn(dir);
      return;
    }
    zone?.setPointerCapture(e.pointerId);
    const d: Drag = {
      id: e.pointerId,
      dir,
      zone,
      x0: e.clientX,
      y0: e.clientY,
      x: e.clientX,
      y: e.clientY,
      moved: 0,
      samples: zone ? [] : Array.from({ length: 6 }, (_, i) => ({ x: e.clientX, t: i === 0 ? startedAt : -Infinity })),
      sampleIndex: 1,
      prep: Promise.resolve("nocurl"),
      ready: null,
      G: null,
      raf: 0,
    };
    this.drag = d;
    this.busy = true;
    const L = this.enabled && !this.reduced.matches ? this.measure() : null;
    if (!L) return;
    d.prep = this.prepare(L, dir).then(
      (prep) => {
        if (prep && this.drag === d) {
          const host = this.host.getBoundingClientRect();
          const sx = (d.x0 - host.left - prep.scene.spine) * prep.scene.m;
          const sy = d.y0 - host.top;
          const { W, H } = prep.L;
          const y = Math.max(H * 0.02, Math.min(H * 0.98, sy));
          d.G = prep.reverse ? { x: W * 0.97, y } : { x: Math.max(W * 0.6, Math.min(W, sx)), y };
          d.ready = prep;
          this.redraw(d);
        }
        return prep;
      },
      (err) => (err instanceof NoCurl ? "nocurl" : null),
    );
  }

  private redraw(d: Drag) {
    if (d.raf || !d.ready || !d.G) return;
    d.raf = requestAnimationFrame(() => {
      d.raf = 0;
      if (this.drag !== d || !d.ready || !d.G) return;
      this.render(d.ready, this.fingerOf(d, d.ready, d.G, this.options.renderer === "webgl" ? this.finger : undefined), d.G);
    });
  }

  private onMove(e: PointerEvent) {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    d.x = e.clientX;
    d.y = e.clientY;
    d.moved = Math.max(d.moved, Math.hypot(d.x - d.x0, d.y - d.y0));
    if (!d.zone) {
      const sample = d.samples[d.sampleIndex % 6];
      sample.x=d.x; sample.t=performance.now(); d.sampleIndex++;
    } else if (d.ready && d.G) {
      d.samples.push({ x: this.fingerOf(d, d.ready, d.G).x, t: performance.now() });
      if (d.samples.length > 6) d.samples.shift();
    }
    this.redraw(d);
  }

  private onUp(e: PointerEvent, cancelled: boolean) {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    if (d.zone?.hasPointerCapture(e.pointerId)) d.zone.releasePointerCapture(e.pointerId);
    if (d.releasing) return;
    d.releasing = true;
    void this.release(d, cancelled);
  }

  private async release(d: Drag, cancelled: boolean) {
    try {
      const prep = await d.prep;
      if (d.raf) cancelAnimationFrame(d.raf);
      if (prep === "nocurl") {
        // No curl possible: a tap or a real swipe still turns the page plainly.
        this.hide();
        const swipe = (d.x - d.x0) * -d.dir > (d.zone ? 24 : 12);
        if (!cancelled && (d.moved < 4 || swipe)) await this.nav(d.dir);
        return;
      }
      if (!prep || !d.G) {
        this.hide();
        return;
      }
      const G = d.G;
      const { W } = prep.L;
      const F = this.fingerOf(d, prep, G);
      const turned = mirror(G);
      let completed: boolean;
      if (cancelled) completed = false;
      else if (d.moved < 4) completed = true;
      else {
        // Only recent motion counts as a flick (not a fast drag then a pause).
        const recent = d.samples.filter((s) => s.t > performance.now() - 120);
        if (!d.zone) recent.sort((a,b) => a.t-b.t);
        const a = recent[0];
        const b = recent[recent.length - 1];
        const velocityScale = d.zone ? 1 : prep.scene.m * (prep.reverse ? 2 * G.x / W : 1);
        const v = a && b && b.t > a.t ? velocityScale * (b.x - a.x) / (b.t - a.t) : 0; // px/ms, sheet x
        const flick = Math.abs(v) > 0.5 && d.moved > 24;
        // Moving toward the spine (v < 0) carries the sheet over.
        const goingOver = flick ? v < 0 : prep.reverse ? F.x < -W / 2 : F.x < W / 2;
        completed = prep.reverse ? !goingOver : goingOver;
      }
      // Where the sheet must end up: turned over (forward) or flat (reverse).
      const towardTurned = prep.reverse ? !completed : completed;
      const to = towardTurned ? turned : G;
      const dist = Math.hypot(to.x - F.x, to.y - F.y);
      if (d.moved < 4) {
        await this.animate(prep, G, F, to, AUTO_MS, easeInOut, prep.L.H * 0.05);
      } else {
        const ms = completed ? 200 + 160 * Math.min(1, dist / (2 * W)) : 170 + 130 * Math.min(1, dist / W);
        await this.animate(prep, G, F, to, ms, easeOut);
      }
      await this.commit(prep, completed);
    } catch (err) {
      console.warn("[curl]", err);
      this.hide();
    } finally {
      this.drag = null;
      this.busy = false;
      this.hurry = false;
      const next = this.queue.shift();
      if (next) this.turn(next);
      else this.onRelocate();
    }
  }

}
