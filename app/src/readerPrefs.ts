/**
 * Reading preferences (theme, typeface, size, spacing, layout), kept per
 * viewer in localStorage and turned into the CSS injected into every book
 * section plus the paginator's layout attributes.
 */
import { isAndroid } from "./platform";
import { BOOK_FONT, FONT_FACE_CSS } from "./fonts";

export type ReaderTheme = "auto" | "paper" | "sepia" | "dusk" | "night" | "bold" | "forest";
export type ReaderFont = "book" | "palatino" | "times" | "sans" | "original";
export type Spacing = "tight" | "normal" | "loose";
export type Margins = "narrow" | "normal" | "wide";

export interface ReaderPrefs {
  theme: ReaderTheme;
  font: ReaderFont;
  /** Text size, % of the book's own size. */
  size: number;
  spacing: Spacing;
  margins: Margins;
  /** Two pages side by side when the window is wide enough. */
  spread: boolean;
  justify: boolean;
  curl: boolean;
  mobileMotion?: "curl" | "slide" | "none";
  /** Send highlights and notes made here to Kindle automatically. */
  kindleSync: boolean;
  /** Selecting a word shows the dictionary. */
  dict: boolean;
  /** X-Ray: names, places, relationships. */
  xray: boolean;
  /** Which AI writes X-Ray labels. */
  aiProvider: "anthropic" | "deepseek";
}

export const SIZE_MIN = 70;
export const SIZE_MAX = 200;

export const DEFAULT_PREFS: ReaderPrefs = {
  theme: "auto",
  font: "book",
  size: 100,
  spacing: "normal",
  margins: "normal",
  spread: true,
  justify: true,
  curl: true,
  ...(isAndroid ? { mobileMotion: "curl" as const } : {}),
  kindleSync: false,
  dict: true,
  xray: true,
  aiProvider: "anthropic",
};

/** Page colours of each reading theme. */
export const THEMES: Record<Exclude<ReaderTheme, "auto">, { bg: string; fg: string; muted: string; link: string; dark: boolean }> = {
  paper: { bg: "#fbfaf6", fg: "#1f1d1a", muted: "#7a746a", link: "#2f5fb3", dark: false },
  sepia: { bg: "#f3e9d2", fg: "#4a3b2a", muted: "#8a7558", link: "#8a4b1f", dark: false },
  dusk: { bg: "#23242a", fg: "#d9d4ca", muted: "#8f8b84", link: "#8ab4ff", dark: true },
  bold: { bg: "#f6f7f9", fg: "#111318", muted: "#626773", link: "#2f5fb3", dark: false },
  forest: { bg: "#2a2d24", fg: "#d7dcc4", muted: "#9ba38a", link: "#b4cfa0", dark: true },
  night: { bg: "#000000", fg: "#b9b3a8", muted: "#6f6a62", link: "#7ea6e8", dark: true },
};

export const FONT_STACKS: Record<ReaderFont, string | null> = {
  book: BOOK_FONT,
  palatino: `"Palatino Linotype", "Book Antiqua", Palatino, serif`,
  times: `"Times New Roman", Times, serif`,
  sans: `"Segoe UI", "Helvetica Neue", Arial, sans-serif`,
  original: null,
};

const LINE_HEIGHT: Record<Spacing, number> = { tight: 1.4, normal: 1.65, loose: 1.95 };
/** Paginator margin (px, top/bottom) and max line length (px) per setting. */
export const MARGIN_LAYOUT: Record<Margins, { margin: number; inline: number; gap: string }> = {
  narrow: { margin: 32, inline: 860, gap: "4%" },
  normal: { margin: 48, inline: 720, gap: "6%" },
  wide: { margin: 72, inline: 600, gap: "9%" },
};

export function resolveTheme(p: ReaderPrefs, app: "light" | "dark"): Exclude<ReaderTheme, "auto"> {
  if (p.theme !== "auto") return p.theme;
  return app === "dark" ? "dusk" : "paper";
}

export function loadPrefs(): ReaderPrefs {
  try {
    const saved = JSON.parse(localStorage.getItem(isAndroid ? "androidReaderPrefs" : "readerPrefs") ?? "null");
    const p = { ...DEFAULT_PREFS, ...(saved ?? {}) } as ReaderPrefs;
    if (isAndroid && !saved) p.theme = "dusk";
    // Older builds stored only these two.
    if (!saved) {
      const size = Number(localStorage.getItem("readerFont"));
      if (size >= SIZE_MIN && size <= SIZE_MAX) p.size = size;
      if (localStorage.getItem("readerCurl") === "0") p.curl = false;
    }
    p.size = Math.min(SIZE_MAX, Math.max(SIZE_MIN, Number(p.size) || 100));
    return p;
  } catch {
    return { ...DEFAULT_PREFS, ...(isAndroid ? { theme: "dusk" as const } : {}) };
  }
}

export function savePrefs(p: ReaderPrefs) {
  try {
    localStorage.setItem(isAndroid ? "androidReaderPrefs" : "readerPrefs", JSON.stringify(p));
  } catch {
    /* private mode etc. */
  }
}

/** CSS injected into every book section document. */
export function contentCSS(p: ReaderPrefs, app: "light" | "dark"): string {
  const th = THEMES[resolveTheme(p, app)];
  const font = FONT_STACKS[p.font];
  const lh = LINE_HEIGHT[p.spacing];
  return `
    @namespace epub "http://www.idpf.org/2007/ops";
    ${FONT_FACE_CSS}
    html { color-scheme: ${th.dark ? "dark" : "light"}; font-size: ${p.size}%; }
    html, body { background: ${th.bg} !important; color: ${th.fg} !important; }
    /* Book CSS often hard-codes black text: take the theme's ink instead. */
    body :is(p, div, span, li, dd, dt, td, th, blockquote, h1, h2, h3, h4, h5, h6, em, i, b, strong, small, cite) {
      color: inherit !important; background-color: transparent !important;
    }
    a:link, a:visited { color: ${th.link} !important; }
    ${font ? `html, body, body :is(p, div, span, li, dd, blockquote, h1, h2, h3, h4, h5, h6) { font-family: ${font} !important; }` : ""}
    p, li, blockquote, dd {
      line-height: ${lh} !important;
      text-align: ${p.justify ? "justify" : "start"} !important;
      -webkit-hyphens: auto; hyphens: auto;
    }
    ${isAndroid && p.theme === "bold" ? "p, li, blockquote, dd { font-weight: 700 !important; }" : ""}
    pre { white-space: pre-wrap !important; }
    img { max-width: 100% !important; height: auto !important; }
    ${th.dark ? "img { filter: brightness(.9); }" : ""}
  `;
}
