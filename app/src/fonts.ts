/**
 * App and reading typeface: Bookerly, falling back to Literata.
 *
 * Bookerly is Amazon's proprietary Kindle font, so it is NOT shipped with the
 * app. It is used when available:
 *   - installed in Windows (picked up through `local()`), or
 *   - dropped into `public/fonts/` as Bookerly-Regular.ttf, Bookerly-Italic.ttf,
 *     Bookerly-Bold.ttf, Bookerly-BoldItalic.ttf (e.g. copied from your own
 *     Kindle's `fonts` folder — for personal use only, do not redistribute).
 * Otherwise text falls back to Literata (OFL), an open book face with full
 * Vietnamese coverage, bundled from @fontsource-variable/literata.
 *
 * The same @font-face CSS is injected into the app document and into every
 * book section (the reader iframes), with absolute URLs so they resolve there.
 */
import latinN from "@fontsource-variable/literata/files/literata-latin-wght-normal.woff2?url";
import latinI from "@fontsource-variable/literata/files/literata-latin-wght-italic.woff2?url";
import latinExtN from "@fontsource-variable/literata/files/literata-latin-ext-wght-normal.woff2?url";
import latinExtI from "@fontsource-variable/literata/files/literata-latin-ext-wght-italic.woff2?url";
import viN from "@fontsource-variable/literata/files/literata-vietnamese-wght-normal.woff2?url";
import viI from "@fontsource-variable/literata/files/literata-vietnamese-wght-italic.woff2?url";

export const BOOK_FONT = `"Bookerly", "Literata", Georgia, serif`;

const abs = (u: string) => new URL(u, location.href).href;

const RANGES = {
  latin:
    "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD",
  latinExt:
    "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF",
  vi: "U+0102-0103,U+0110-0111,U+0128-0129,U+0168-0169,U+01A0-01A1,U+01AF-01B0,U+0300-0301,U+0303-0304,U+0308-0309,U+0323,U+0329,U+1EA0-1EF9,U+20AB",
};

function literata(url: string, style: "normal" | "italic", range: string) {
  return `@font-face{font-family:"Literata";font-style:${style};font-weight:200 900;font-display:swap;src:url("${abs(url)}") format("woff2");unicode-range:${range};}`;
}

function bookerly(file: string, local: string[], weight: number, style: "normal" | "italic") {
  const locals = local.map((n) => `local("${n}")`).join(",");
  return `@font-face{font-family:"Bookerly";font-style:${style};font-weight:${weight};font-display:swap;src:${locals},url("${abs(`/fonts/${file}`)}") format("truetype");}`;
}

/** @font-face rules for Bookerly (if available) and the Literata fallback. */
export const FONT_FACE_CSS = [
  bookerly("Bookerly-Regular.ttf", ["Bookerly", "Bookerly Regular", "Bookerly-Regular"], 400, "normal"),
  bookerly("Bookerly-Italic.ttf", ["Bookerly Italic", "Bookerly-Italic"], 400, "italic"),
  bookerly("Bookerly-Bold.ttf", ["Bookerly Bold", "Bookerly-Bold"], 700, "normal"),
  bookerly("Bookerly-BoldItalic.ttf", ["Bookerly Bold Italic", "Bookerly-BoldItalic"], 700, "italic"),
  literata(viN, "normal", RANGES.vi),
  literata(viI, "italic", RANGES.vi),
  literata(latinExtN, "normal", RANGES.latinExt),
  literata(latinExtI, "italic", RANGES.latinExt),
  literata(latinN, "normal", RANGES.latin),
  literata(latinI, "italic", RANGES.latin),
].join("\n");

/** Register the faces in the app document (call once at startup). */
export function installFonts() {
  if (document.getElementById("app-fonts")) return;
  const style = document.createElement("style");
  style.id = "app-fonts";
  style.textContent = FONT_FACE_CSS;
  document.head.append(style);
}
