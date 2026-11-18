import { invoke } from "@tauri-apps/api/core";

/** One dictionary entry as stored by the app (see src-tauri/src/dict.rs). */
export interface DictSense {
  g: string[];
  ex?: string[][];
  syn?: string[];
}
export interface DictEntry {
  word: string;
  body: { pos?: string; ipa?: string; senses: DictSense[] };
}
export interface DictLookup {
  word: string;
  vi: DictEntry[];
  envi: DictEntry[];
  enen: DictEntry[];
  missing: boolean;
}
export type DictTab = "vi" | "envi" | "enen" | "wikt" | "wiki";

/** Letters of any script, plus marks, apostrophes and inner hyphens. */
const WORD = /[\p{L}\p{M}][\p{L}\p{M}'’-]*/gu;
const BREAK = /[.,;:!?…"“”«»()[\]{}–—/\\]/;
const VI_MARKS = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i;

export function hasVietnameseMarks(s: string): boolean {
  return VI_MARKS.test(s);
}

/** Whether a selection is short enough to look up (1–3 words). */
export function isLookupSize(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 40) return false;
  const words = t.match(WORD) ?? [];
  return words.length >= 1 && words.length <= 3 && words.join("").length >= 1 && !/\d{3,}/.test(t);
}

/**
 * What the selection sits in: its block's text, where the selection starts
 * and ends in it.
 */
export function selectionContext(range: Range): { text: string; start: number; end: number } | null {
  const node = range.startContainer;
  const el = (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement) as Element | null;
  const block = el?.closest("p, li, dd, dt, blockquote, td, h1, h2, h3, h4, h5, h6, div") ?? el?.ownerDocument.body;
  if (!block) return null;
  const pre = block.ownerDocument.createRange();
  pre.selectNodeContents(block);
  try {
    pre.setEnd(range.startContainer, range.startOffset);
  } catch {
    return null;
  }
  const start = pre.toString().length;
  const sel = range.toString();
  return { text: block.textContent ?? "", start, end: start + sel.length };
}

/**
 * Phrases to try, longest first, each containing the selection: the
 * selection with up to 3 words before and after it (a Vietnamese word is
 * often 2–3 syllables: clicking "thuyết" should find "tiểu thuyết"). Stops
 * at punctuation. The selection itself comes last.
 */
export function lookupCandidates(ctx: { text: string; start: number; end: number }): string[] {
  const sel = ctx.text.slice(ctx.start, ctx.end).trim();
  const selWords = sel.match(WORD) ?? [];
  if (!selWords.length) return [];
  const beforeText = ctx.text.slice(0, ctx.start);
  const afterText = ctx.text.slice(ctx.end);
  const cutBefore = Math.max(...[...beforeText].map((c, i) => (BREAK.test(c) ? i : -1)));
  const cutAfterIdx = [...afterText].findIndex((c) => BREAK.test(c));
  const before = (beforeText.slice(cutBefore + 1).match(WORD) ?? []).slice(-3);
  const after = (cutAfterIdx < 0 ? afterText : afterText.slice(0, cutAfterIdx)).match(WORD)?.slice(0, 3) ?? [];
  const out: string[] = [];
  const maxLen = 4;
  for (let len = Math.min(maxLen, before.length + selWords.length + after.length); len > selWords.length; len--) {
    for (let b = Math.min(before.length, len - selWords.length); b >= 0; b--) {
      const a = len - selWords.length - b;
      if (a > after.length) continue;
      out.push([...before.slice(before.length - b), ...selWords, ...after.slice(0, a)].join(" "));
    }
  }
  out.push(selWords.join(" "));
  return [...new Set(out)];
}

/** The sentence around the selection, for the word list. */
export function sentenceAround(ctx: { text: string; start: number; end: number }): string {
  const t = ctx.text;
  let s = ctx.start;
  while (s > 0 && !/[.!?…]/.test(t[s - 1])) s--;
  let e = ctx.end;
  while (e < t.length && !/[.!?…]/.test(t[e])) e++;
  // A long sentence keeps about 90 characters on each side of the word.
  const end = Math.min(t.length, e + 1);
  let a = s;
  let b = end;
  if (ctx.start - a > 90) a = t.indexOf(" ", ctx.start - 90) + 1 || ctx.start - 90;
  if (b - ctx.end > 90) {
    const sp = t.lastIndexOf(" ", ctx.end + 90);
    b = sp > ctx.end ? sp : ctx.end + 90;
  }
  const body = t.slice(a, b).replace(/\s+/g, " ").trim();
  return (a > s ? "…" : "") + body + (b < end ? "…" : "");
}

export function lookup(candidates: string[]): Promise<DictLookup> {
  return invoke<DictLookup>("dict_lookup", { candidates });
}

/** The tab to open first. */
export function firstTab(r: DictLookup, bookLang: string): DictTab {
  const vi = hasVietnameseMarks(r.word) || bookLang.toLowerCase().startsWith("vi");
  if (r.vi.length && vi) return "vi";
  if (r.envi.length) return "envi";
  if (r.enen.length) return "enen";
  if (r.vi.length) return "vi";
  // A name ("Dmitri", "Hà Nội") is more likely on Wikipedia.
  return /^\p{Lu}/u.test(r.word) ? "wiki" : "wikt";
}

// ---- Online sources -----------------------------------------------------------

const DROP_SELECTORS =
  ".mw-editsection, .reference, .references, sup.reference, table, .noprint, .thumb, figure, style, script, .mw-empty-elt, .navbox, .metadata, .ambox";

/** The Vietnamese Wiktionary page for a word, as HTML from the API. */
export async function wiktionaryHtml(word: string): Promise<{ html: string; url: string; host: string } | null> {
  for (const host of ["vi.wiktionary.org", ...(/^[\x00-\x7f]+$/.test(word) ? ["en.wiktionary.org"] : [])]) {
    const api = `https://${host}/w/api.php?action=parse&format=json&origin=*&redirects=1&prop=text&disableeditsection=1&page=${encodeURIComponent(word)}`;
    const r = await fetch(api);
    if (!r.ok) continue;
    const j = await r.json();
    const html: string | undefined = j?.parse?.text?.["*"];
    if (html) {
      return { html, url: `https://${host}/wiki/${encodeURIComponent(j.parse.title ?? word)}`, host };
    }
  }
  return null;
}

/** Strip a fetched page to text and simple formatting (no links, scripts, media). */
export function safeFragment(html: string): DocumentFragment {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll(DROP_SELECTORS).forEach((n) => n.remove());
  const frag = document.createDocumentFragment();
  copySafe(doc.body, frag);
  return frag;
}

const KEEP: Record<string, string> = {
  p: "p", div: "div", blockquote: "blockquote", li: "li", ul: "ul", ol: "ol", dl: "div", dd: "p", dt: "b",
  b: "b", strong: "b", i: "i", em: "i", cite: "i", u: "u", sup: "sup", sub: "sub", small: "small", br: "br",
  span: "span", a: "span", code: "code", h1: "h4", h2: "h4", h3: "h4", h4: "h5", h5: "h5", h6: "h5",
};
const DROP = new Set(["script", "style", "img", "svg", "video", "audio", "object", "iframe", "math", "table", "link", "meta"]);

function copySafe(src: Node, into: Node) {
  for (const n of Array.from(src.childNodes)) {
    if (n.nodeType === Node.TEXT_NODE) into.appendChild(document.createTextNode(n.textContent ?? ""));
    else if (n.nodeType === Node.ELEMENT_NODE) {
      const tag = (n as Element).localName.toLowerCase();
      if (DROP.has(tag)) continue;
      const as = KEEP[tag];
      if (as) {
        const el = document.createElement(as);
        if (as !== "br") copySafe(n, el);
        into.appendChild(el);
      } else copySafe(n, into);
    }
  }
}

export interface WikiSummary {
  title: string;
  extract: string;
  url: string;
  thumb?: string;
}

/** A short Wikipedia summary (Vietnamese first for Vietnamese books). */
export async function wikipediaSummary(word: string, preferVi: boolean): Promise<WikiSummary | null> {
  for (const lang of preferVi ? ["vi", "en"] : ["en", "vi"]) {
    const r = await fetch(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(word)}?redirect=true`);
    if (!r.ok) continue;
    const j = await r.json();
    if (!j?.extract) continue;
    return {
      title: j.title ?? word,
      extract: j.extract,
      url: j.content_urls?.desktop?.page ?? `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(word)}`,
    };
  }
  return null;
}

/** Say a word with a Windows voice of its language, if one is installed. */
export function speak(text: string, lang: "vi" | "en") {
  const synth = window.speechSynthesis;
  if (!synth) return false;
  synth.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = lang === "vi" ? "vi-VN" : "en-US";
  const voice = synth.getVoices().find((v) => v.lang.toLowerCase().startsWith(lang));
  if (voice) u.voice = voice;
  u.rate = 0.9;
  synth.speak(u);
  return true;
}

export function canSpeak(lang: "vi" | "en"): boolean {
  return !!window.speechSynthesis?.getVoices().some((v) => v.lang.toLowerCase().startsWith(lang));
}
