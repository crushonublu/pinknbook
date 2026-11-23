import { STR, type Lang } from "../i18n";
import { SIZE_MAX, SIZE_MIN, THEMES, type ReaderPrefs, type ReaderTheme } from "../readerPrefs";

export function MobileReaderThemes({ prefs, set, lang, onCustomize, onTools }: {
  prefs: ReaderPrefs; set: (patch: Partial<ReaderPrefs>) => void; lang: Lang;
  onCustomize: () => void; onTools: () => void;
}) {
  const t = STR[lang];
  const themes: [Exclude<ReaderTheme, "auto">, string][] = [
    ["dusk", t.mrKindle], ["sepia", t.mrSepia], ["paper", t.mrAiry],
    ["bold", t.mrBold], ["night", t.mrNight], ["forest", t.mrForest],
  ];
  return <div className="mr-themes">
    <div className="mr-themes__size">
      <button disabled={prefs.size <= SIZE_MIN} aria-label={t.fontSmaller} onClick={() => set({ size: Math.max(SIZE_MIN, prefs.size - 10) })}>A−</button>
      <button disabled={prefs.size >= SIZE_MAX} aria-label={t.fontLarger} onClick={() => set({ size: Math.min(SIZE_MAX, prefs.size + 10) })}>A+</button>
    </div>
    <div className="mr-themes__grid" role="radiogroup" aria-label={t.rsTheme}>
      {themes.map(([id, label]) => <button key={id} role="radio" aria-checked={prefs.theme === id}
        style={{ background: THEMES[id].bg, color: THEMES[id].fg }}
        onClick={() => set({ theme: id, spacing: id === "paper" ? "loose" : "normal" })}>
        <b style={{ fontWeight: id === "bold" ? 800 : id === "paper" ? 400 : 600 }}>Aa</b><span>{label}</span>
      </button>)}
    </div>
    <label className="mr-themes__row">{t.mrTurn}<select aria-label={t.mrTurn} value={prefs.mobileMotion ?? "curl"} onChange={(e) => set({ mobileMotion: e.target.value as "curl" | "slide" | "none" })}>
      <option value="curl">{t.mrCurl}</option><option value="slide">{t.mrSlide}</option><option value="none">{t.mrNone}</option>
    </select></label>
    <button className="mr-themes__row" onClick={onCustomize}>{t.mrCustomize}<span>›</span></button>
    <button className="mr-themes__row" onClick={onTools}>{t.mrTools}<span>›</span></button>
  </div>;
}
