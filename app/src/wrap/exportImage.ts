// Turning a wrap-up card into a PNG, and handing the PNG to the person.
//
// The card is ordinary DOM, so the picture is made from that same DOM and not
// from a second renderer: the card is cloned with the styles it is drawn with
// written into each element, every picture and the fonts are read into data
// URLs, and the clone is wrapped in an SVG <foreignObject>. A browser draws such
// an SVG when it is loaded as an image, and with nothing left to fetch it does
// not taint the canvas it is drawn onto, so `toBlob` works (WebView2 and
// Android System WebView are Chromium). What is on screen is what is exported.

import { invoke } from "@tauri-apps/api/core";
import { FONT_FACE_CSS } from "../fonts";
import { isAndroid } from "../platform";

const SVG_NS = "http://www.w3.org/2000/svg";

/** A file read into a `data:` URL; null when it cannot be had (or is a page, as a missing file of the dev server is). */
async function fetchDataUrl(url: string): Promise<string | null> {
  try {
    const res = await fetch(url);
    if (!res.ok || (res.headers.get("content-type") ?? "").startsWith("text/html")) return null;
    return await blobDataUrl(await res.blob());
  } catch {
    return null;
  }
}

const blobDataUrl = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

let fontCss: Promise<string> | null = null;

/** The app's @font-face rules with each font file inside the rule, so the picture needs nothing from outside. A face that cannot be read is left out (the next family of the stack is used). */
function inlineFontCss(): Promise<string> {
  fontCss ??= Promise.all(
    FONT_FACE_CSS.split("\n").map(async (rule) => {
      const url = rule.match(/url\("([^"]+)"\)/);
      if (!url) return rule;
      const data = await fetchDataUrl(url[1]);
      return data ? rule.replace(url[0], () => `url("${data}")`) : "";
    }),
  ).then((rules) => rules.filter(Boolean).join("\n"));
  fontCss.catch(() => (fontCss = null));
  return fontCss;
}

/** The styles an element of each kind has with none of the app's CSS, read once in a blank frame. */
class Defaults {
  private frame = document.createElement("iframe");
  private svgHost: SVGSVGElement;
  private seen = new Map<string, CSSStyleDeclaration>();

  constructor() {
    this.frame.setAttribute("aria-hidden", "true");
    this.frame.style.cssText = "position:fixed;left:-9999px;top:0;width:10px;height:10px;border:0;visibility:hidden";
    document.body.append(this.frame);
    const doc = this.frame.contentDocument!;
    this.svgHost = doc.createElementNS(SVG_NS, "svg");
    doc.body.append(this.svgHost);
  }

  of(el: Element): CSSStyleDeclaration {
    const key = `${el.namespaceURI}|${el.localName}`;
    let style = this.seen.get(key);
    if (!style) {
      const doc = this.frame.contentDocument!;
      const probe = doc.createElementNS(el.namespaceURI, el.localName);
      (el.namespaceURI === SVG_NS && el.localName !== "svg" ? this.svgHost : doc.body).append(probe);
      style = doc.defaultView!.getComputedStyle(probe);
      this.seen.set(key, style);
    }
    return style;
  }

  dispose() {
    this.frame.remove();
  }
}

/**
 * A copy of `source` that looks the same on its own: each element carries, as
 * its own style, the computed values that its kind does not have by default or
 * that differ from its parent's (so an inherited value is cancelled where the
 * element differs from its parent). Pictures are read into data URLs: `tasks`
 * collects that work.
 */
function cloneStyled(source: Element, defaults: Defaults, tasks: Promise<void>[], pictures: Map<string, Promise<string | null>>): Element {
  const copy = source.cloneNode(false) as Element;
  const style = getComputedStyle(source);
  const base = defaults.of(source);
  const parent = source.parentElement ? getComputedStyle(source.parentElement) : base;
  const out = (copy as HTMLElement).style;
  for (let i = 0; i < style.length; i++) {
    const name = style[i];
    const value = style.getPropertyValue(name);
    if (value !== base.getPropertyValue(name) || value !== parent.getPropertyValue(name)) out.setProperty(name, value, style.getPropertyPriority(name));
  }
  if (source instanceof HTMLImageElement) {
    copy.removeAttribute("loading");
    const src = source.currentSrc || source.src;
    if (!src.startsWith("data:")) {
      if (!pictures.has(src)) pictures.set(src, fetchDataUrl(src));
      tasks.push(
        pictures.get(src)!.then((data) => {
          if (data) {
            copy.setAttribute("src", data);
            return;
          }
          // A picture that cannot be read (a remote cover the page may show but not copy) becomes a plain block with the book's name.
          const card = getComputedStyle(source.closest(".wc") ?? source);
          const stand = document.createElement("div");
          stand.setAttribute("style", copy.getAttribute("style") ?? "");
          stand.style.cssText += `;display:flex;align-items:center;justify-content:center;box-sizing:border-box;padding:24px;text-align:center;font-size:26px;overflow:hidden;background:${card.getPropertyValue("--sc-dim")};color:${card.getPropertyValue("--sc-sub")}`;
          stand.textContent = source.alt;
          copy.replaceWith(stand);
        }),
      );
    }
  }
  for (const child of source.childNodes) {
    if (child.nodeType === Node.ELEMENT_NODE) copy.append(cloneStyled(child as Element, defaults, tasks, pictures));
    else if (child.nodeType === Node.TEXT_NODE) copy.append(child.cloneNode());
  }
  return copy;
}

/** The card as one standalone SVG document, `width` x `height` card pixels. */
export async function cardSvg(card: HTMLElement, width: number, height: number): Promise<string> {
  await document.fonts.ready;
  const [fonts, defaults] = [inlineFontCss(), new Defaults()];
  const tasks: Promise<void>[] = [];
  let html: Element;
  try {
    html = cloneStyled(card, defaults, tasks, new Map());
  } finally {
    defaults.dispose();
  }
  await Promise.all(tasks);
  const body = new XMLSerializer().serializeToString(html);
  return `<svg xmlns="${SVG_NS}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><style>${await fonts}</style><foreignObject x="0" y="0" width="${width}" height="${height}">${body}</foreignObject></svg>`;
}

/** The card as a PNG, `width` x `height` pixels (the card's own size: one card pixel is one picture pixel). */
export async function cardPng(card: HTMLElement, width: number, height: number): Promise<Blob> {
  const svg = await cardSvg(card, width, height);
  const image = new Image();
  // A data URL, not a blob URL: Chromium keeps a canvas clean for the first and taints it for the second.
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d")!.drawImage(image, 0, 0, width, height);
  return new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("The picture could not be made."))), "image/png"));
}

/** Base64 of some bytes, a slice at a time (a spread of millions of arguments would overflow the stack). */
function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** What happened to a picture handed to the system. */
export type Delivered = { done: true; where: string | null } | { done: false };

/**
 * Hands a PNG to the system: `save` (a file dialog on the desktop, the Photos
 * gallery on Android) or `share` (the Android share sheet). The bytes go as the
 * raw body of the command, not as a JSON list; the name (plain ASCII) and the
 * action in headers.
 */
export async function deliver(png: Blob, fileName: string, action: "save" | "share"): Promise<Delivered> {
  const bytes = new Uint8Array(await png.arrayBuffer());
  // Android's IPC carries JSON only: a raw body does not arrive there as bytes, so the PNG goes as base64.
  const where = isAndroid
    ? await invoke<string | null>("wrap_export_base64", { data: toBase64(bytes), fileName, action })
    : await invoke<string | null>("wrap_export", bytes, { headers: { "x-file-name": fileName, "x-action": action } });
  // The file dialog was closed without saving.
  return where === null && action === "save" ? { done: false } : { done: true, where };
}

/** Puts a PNG on the clipboard (the WebView's own clipboard: nothing native is needed). The promise form keeps the click's permission while the picture is still being made. */
export async function copyPng(png: Promise<Blob>): Promise<void> {
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}
