import { useMemo } from "react";
import type { Lang } from "../i18n";
import { badgeImg } from "../stats/BadgesCard";
import type { StatsSummary, WrapDoc } from "../stats/types";
import { WrapContent } from "./cards";
import { CARD_H, CARD_W, avoidOf, type Format } from "./geometry";
import { iconUrl } from "./icons";
import { STICKER_BASE, type Sticker, type WrapLayout } from "./layout";
import { THEMES } from "./palettes";
import { generateBackground } from "./shapes";

/** One sticker: an icon or a badge picture, centred at its place, turned and scaled. */
function StickerView({ s }: { s: Sticker }) {
  const src = s.kind === "icon" ? iconUrl(s.ref, 512) : badgeImg(s.ref as never);
  if (!src) return null;
  const size = STICKER_BASE * s.scale;
  return (
    <img
      className="wc-sticker"
      src={src}
      alt=""
      draggable={false}
      style={{ left: s.x - size / 2, top: s.y - size / 2, width: size, height: size, zIndex: s.z, transform: `rotate(${s.rotate}deg)` }}
    />
  );
}

/**
 * A wrap-up card at its true size (1080 wide): the generated background, the
 * fixed content of the template and the stickers on top. Show it through
 * `ScaledCard` to fit a screen.
 */
export function WrapCard({ cardRef, lang, doc, layout, page, genreName, badges }: {
  /** The card's own element: the exported picture is made from it. */
  cardRef?: React.Ref<HTMLDivElement>;
  lang: Lang;
  doc: WrapDoc;
  layout: WrapLayout;
  page: number;
  genreName: (id: string) => string | undefined;
  badges: StatsSummary["badges"];
}) {
  const { format } = layout;
  const theme = THEMES[layout.theme];
  // Pages of a year share one background, so it does not jump as they are turned.
  const bg = useMemo(
    () => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(generateBackground(layout.seed, theme, CARD_W, CARD_H[format], avoidOf(doc.kind, format)))}`,
    [layout.seed, theme, format, doc.kind],
  );
  return (
    <div ref={cardRef} className={`wc wc--${format} scard-theme--${layout.theme}`} style={{ width: CARD_W, height: CARD_H[format] }}>
      <img className="wc__bg" src={bg} alt="" draggable={false} />
      <WrapContent lang={lang} doc={doc} format={format} page={page} genreName={genreName} badges={badges} />
      {layout.stickers.filter((s) => (s.page ?? 0) === page).map((s) => <StickerView key={s.id} s={s} />)}
    </div>
  );
}

/** A card (laid out at 1080 wide) scaled by `scale`, in a box of the scaled size. */
export function ScaledCard({ format, scale, children }: { format: Format; scale: number; children: React.ReactNode }) {
  return (
    <div className="wc-stage__card" style={{ width: CARD_W * scale, height: CARD_H[format] * scale }}>
      <div style={{ position: "relative", width: CARD_W, height: CARD_H[format], transform: `scale(${scale})`, transformOrigin: "top left" }}>{children}</div>
    </div>
  );
}
