import type { Annotation, HighlightColor } from "../annotate";

// The command API accepts only Kindle colours. Extra Android presentation is
// local to this installation; the shared annotation remains a yellow highlight.
export type MobileHighlightStyle = HighlightColor | "green" | "underline";
const key = (a: Annotation) => `pntome.android.annotation.${a.id}.${a.cfi}`;
export function mobileAnnotationStyle(a: Annotation): MobileHighlightStyle {
  try {
    const value = localStorage.getItem(key(a));
    if (value === "green" || value === "underline") return value;
  } catch { /* storage unavailable */ }
  return a.color;
}
export function saveMobileAnnotationStyle(a: Annotation, style?: MobileHighlightStyle) {
  try {
    if (style === "green" || style === "underline") localStorage.setItem(key(a), style);
    else localStorage.removeItem(key(a));
  } catch { /* presentation still works for standard colours */ }
}
export const mobileBaseColor = (style: MobileHighlightStyle): HighlightColor =>
  style === "green" || style === "underline" ? "yellow" : style;
