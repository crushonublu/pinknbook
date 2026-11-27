// The colours of the wrap-up card themes. The first four are the card themes of
// the stats cards (`.scard-theme--*` in stats/stats.css, which the profile and
// hours cards already use); `sunset` and `ocean` are the brighter ones. The
// CSS and this table say the same thing twice (the CSS colours the live card,
// this table the generated background), and scripts/check-wrap.mjs fails when
// they drift apart, and when any text colour falls under 4.5:1 on its ground.

import type { ShapePalette } from "./shapes";

export const THEME_IDS = ["wine", "forest", "night", "paper", "sunset", "ocean"] as const;
export type ThemeId = (typeof THEME_IDS)[number];

export interface WrapTheme extends ShapePalette {
  id: ThemeId;
  /** A light card: dark ink. */
  light: boolean;
  border: string;
  /** Stat tiles. */
  tile: string;
  btn: string;
  /** Main text. */
  ink: string;
  /** Secondary text. */
  sub: string;
  /** Small caps labels. */
  kicker: string;
  /** Numbers and highlights. */
  hi: string;
  /** Unfilled marks (the dots of days not read). */
  dim: string;
}

export const THEMES: Record<ThemeId, WrapTheme> = {
  wine: {
    id: "wine", light: false, bg: "#26121c", border: "#3d1d2c", tile: "#331826", btn: "#3a1a29",
    ink: "#fbe9ef", sub: "#e8b9c9", kicker: "#f3b6ca", hi: "#ff5c8a", dim: "#4a2636",
    shapes: ["#ff5c8a", "#a8234f", "#f3b6ca", "#7a2146"], grain: "#ffffff",
  },
  forest: {
    id: "forest", light: false, bg: "#12231b", border: "#1a3326", tile: "#1a3326", btn: "#22402f",
    ink: "#e6f5ec", sub: "#a9cdb9", kicker: "#bfe3cf", hi: "#7cc4a4", dim: "#2d4a3a",
    shapes: ["#7cc4a4", "#2f7a5a", "#bfe3cf", "#3d9470"], grain: "#ffffff",
  },
  night: {
    id: "night", light: false, bg: "#121a2a", border: "#22314a", tile: "#1a2740", btn: "#22314a",
    ink: "#e3ecfa", sub: "#a5b6cf", kicker: "#b9cbe6", hi: "#9cc3ff", dim: "#2f4466",
    shapes: ["#9cc3ff", "#4a6fd0", "#8a7bff", "#b9cbe6"], grain: "#ffffff",
  },
  paper: {
    id: "paper", light: false, bg: "#2a241b", border: "#3a3226", tile: "#3a3226", btn: "#4a4132",
    ink: "#f3ead8", sub: "#cdbf9f", kicker: "#e3d3a8", hi: "#f0a35e", dim: "#4f4532",
    shapes: ["#f0a35e", "#c97a3a", "#e3d3a8", "#8c6a3a"], grain: "#ffffff",
  },
  sunset: {
    id: "sunset", light: true, bg: "#ffd8b5", border: "#f0b98c", tile: "#ffc596", btn: "#ffc596",
    ink: "#3a1408", sub: "#5e2c12", kicker: "#6e2a0e", hi: "#a3210d", dim: "#f0b080",
    shapes: ["#ff7a59", "#ff4f79", "#ffb347", "#c24a8a"], grain: "#3a1408",
  },
  ocean: {
    id: "ocean", light: true, bg: "#cdeaff", border: "#a9d3f2", tile: "#b3dcfb", btn: "#b3dcfb",
    ink: "#0a2540", sub: "#1f4766", kicker: "#16405f", hi: "#0a559f", dim: "#9bc9ec",
    shapes: ["#3aa0ff", "#2dd4bf", "#6c7bff", "#7fd4ff"], grain: "#0a2540",
  },
};

export const isThemeId = (v: unknown): v is ThemeId => typeof v === "string" && (THEME_IDS as readonly string[]).includes(v);
