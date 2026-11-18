/**
 * Rasterise one page of foliate's live iframe document into a canvas.
 *
 * foliate lays a section out as one tall-and-wide CSS-column document inside an
 * iframe and "turns" pages by scrolling it. A page-curl needs bitmaps, so we
 * serialise that document into an SVG `<foreignObject>`, shift it so the wanted
 * column window sits at x = 0, and draw the SVG image into a canvas. This works
 * fully off-screen, so neighbouring pages can be rendered ahead of time.
 *
 * SVG images may not load any external resource, so every `blob:` URL the book
 * uses (images, fonts, linked stylesheets) is inlined as a `data:` URL first.
 * The canvas may end up "tainted"; that is fine because we only ever draw it.
 */

const dataUrlCache = new Map<string, Promise<string>>();

function blobToDataUrl(url: string): Promise<string> {
  let p = dataUrlCache.get(url);
  if (!p) {
    p = fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.blob();
      })
      .then(
        (b) =>
          new Promise<string>((resolve, reject) => {
            const fr = new FileReader();
            fr.onload = () => resolve(String(fr.result));
            fr.onerror = () => reject(fr.error);
            fr.readAsDataURL(b);
          }),
      )
      .catch(() => url);
    dataUrlCache.set(url, p);
  }
  return p;
}

// Every non-data url(): blob: resources from the book, plus the app's own web
// fonts (absolute http(s) URLs) — an SVG image can load neither.
const URL_RE = /url\(\s*(['"]?)((?:blob:|https?:)[^'")\s]+)\1\s*\)/g;

async function inlineCssUrls(css: string): Promise<string> {
  const urls = new Set<string>();
  for (const m of css.matchAll(URL_RE)) urls.add(m[2]);
  if (!urls.size) return css;
  const map = new Map<string, string>();
  await Promise.all(
    [...urls].map(async (u) => map.set(u, await blobToDataUrl(u))),
  );
  return css.replace(URL_RE, (_, _q, u: string) => `url("${map.get(u) ?? u}")`);
}

const XLINK = "http://www.w3.org/1999/xlink";

/** Serialise the section document into self-contained XHTML. */
async function serialise(doc: Document): Promise<string> {
  const root = doc.documentElement.cloneNode(true) as HTMLElement;
  const jobs: Promise<unknown>[] = [];

  root.querySelectorAll("script").forEach((s) => s.remove());

  // Linked stylesheets → inline <style>.
  root.querySelectorAll('link[rel~="stylesheet"]').forEach((link) => {
    const href = (link as HTMLLinkElement).getAttribute("href");
    if (!href) return link.remove();
    jobs.push(
      fetch(new URL(href, doc.baseURI).href)
        .then((r) => r.text())
        .then(inlineCssUrls)
        .then((css) => {
          const style = doc.createElement("style");
          style.textContent = css;
          link.replaceWith(style);
        })
        .catch(() => link.remove()),
    );
  });
  root.querySelectorAll("style").forEach((style) => {
    jobs.push(
      inlineCssUrls(style.textContent ?? "").then((css) => {
        style.textContent = css;
      }),
    );
  });
  root.querySelectorAll("[style]").forEach((el) => {
    const css = el.getAttribute("style") ?? "";
    if (css.includes("blob:"))
      jobs.push(inlineCssUrls(css).then((v) => el.setAttribute("style", v)));
  });
  root.querySelectorAll("img").forEach((img) => {
    const src = img.getAttribute("src");
    img.removeAttribute("srcset");
    img.removeAttribute("loading");
    if (src?.startsWith("blob:"))
      jobs.push(blobToDataUrl(src).then((d) => img.setAttribute("src", d)));
  });
  root.querySelectorAll("image").forEach((im) => {
    const href = im.getAttribute("href") ?? im.getAttributeNS(XLINK, "href");
    if (href?.startsWith("blob:"))
      jobs.push(
        blobToDataUrl(href).then((d) => {
          im.removeAttribute("href");
          im.setAttributeNS(XLINK, "xlink:href", d);
        }),
      );
  });
  await Promise.all(jobs);

  // Inside the foreignObject the <html> is no longer the viewport, so its
  // `overflow: hidden` would clip every column but the first.
  root.style.setProperty("overflow", "visible", "important");
  // `color-scheme` does not carry into an SVG image, so default (CanvasText)
  // colours would come out black in the dark theme. Pin the computed ones.
  const win = doc.defaultView;
  if (win) {
    root.style.setProperty("color", win.getComputedStyle(doc.documentElement).color);
    const body = root.querySelector("body");
    if (body && doc.body)
      (body as HTMLElement).style.setProperty("color", win.getComputedStyle(doc.body).color);
  }
  return new XMLSerializer().serializeToString(root);
}

const serialCache = new WeakMap<Document, { key: string; p: Promise<string> }>();

function serialised(doc: Document, key: string): Promise<string> {
  const hit = serialCache.get(doc);
  if (hit && hit.key === key) return hit.p;
  const p = serialise(doc);
  serialCache.set(doc, { key, p });
  return p;
}

export interface SnapshotGeometry {
  /** Paginator page index (1 … pages-2 are text pages). */
  page: number;
  /** Width of one paginator page (the whole visible spread) in CSS px. */
  size: number;
  /** Full laid-out width of the iframe (all columns of the section). */
  docWidth: number;
  /** Height of the column area (the iframe). */
  docHeight: number;
  /** Canvas height (host height); the column area is placed at `docTop`. */
  height: number;
  docTop: number;
  paper: string;
  dpr: number;
  /** Changes whenever styles/layout change; part of the serialisation key. */
  layoutKey: string;
}

/** Render paginator page `g.page` of `doc` into a new canvas (size × height). */
export async function snapshotPage(
  doc: Document,
  g: SnapshotGeometry,
): Promise<HTMLCanvasElement> {
  const html = await serialised(doc, g.layoutKey);
  const x = -(g.page - 1) * g.size;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${g.size}" height="${g.docHeight}">` +
    `<foreignObject x="${x}" y="0" width="${g.docWidth}" height="${g.docHeight}">` +
    html +
    `</foreignObject></svg>`;
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = Math.round(g.size * g.dpr);
    c.height = Math.round(g.height * g.dpr);
    const ctx = c.getContext("2d")!;
    ctx.setTransform(g.dpr, 0, 0, g.dpr, 0, 0);
    ctx.fillStyle = g.paper;
    ctx.fillRect(0, 0, g.size, g.height);
    ctx.drawImage(img, 0, g.docTop, g.size, g.docHeight);
    return c;
  } finally {
    URL.revokeObjectURL(url);
  }
}
