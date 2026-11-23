import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isAndroid } from "./platform";
import { Icon } from "./icons";
import { STR, type Lang } from "./i18n";
import {
  FONT_STACKS,
  SIZE_MAX,
  SIZE_MIN,
  THEMES,
  type Margins,
  type ReaderFont,
  type ReaderPrefs,
  type ReaderTheme,
  type Spacing,
} from "./readerPrefs";


/** The "Aa" panel: reading theme, typeface, size, spacing, margins, layout. */
export function ReaderSettings({
  prefs,
  set,
  lang,
  appTheme,
  onClose,
  kindle = true,
  mobileSection = "customize",
}: {
  prefs: ReaderPrefs;
  set: (patch: Partial<ReaderPrefs>) => void;
  lang: Lang;
  appTheme: "light" | "dark";
  onClose: () => void;
  /** The book can sync with Kindle (false for books added from this computer). */
  kindle?: boolean;
  mobileSection?: "customize" | "tools";
}) {
  const t = STR[lang];
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click / Escape (Escape must not also close the book).
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (isAndroid) return;
      if (ref.current && !ref.current.contains(target) && !target?.closest("[data-settings-toggle]")) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (isAndroid && document.querySelector("[data-mobile-picker]")) return;
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [onClose]);

  const themes: [ReaderTheme, string][] = [
    ["auto", t.rtAuto],
    ["paper", t.rtPaper],
    ["sepia", t.rtSepia],
    ["dusk", t.rtDusk],
    ["night", t.rtNight],
  ];
  const fonts: [ReaderFont, string][] = [
    ["book", "Bookerly"],
    ["palatino", "Palatino"],
    ["times", "Times"],
    ["sans", "Segoe UI"],
    ["original", t.rfOriginal],
  ];

  return (
    <div className="rset" ref={ref} role={isAndroid ? undefined : "dialog"} aria-label={t.readingSettings}>
      {(!isAndroid) && <Section title={t.rsTheme}>
        <div className="rset__themes" role="radiogroup" aria-label={t.rsTheme}>
          {themes.map(([id, label]) => {
            const th = THEMES[id === "auto" ? (appTheme === "dark" ? "dusk" : "paper") : id];
            return (
              <button
                key={id}
                role="radio"
                aria-checked={prefs.theme === id}
                className={`rset__theme${prefs.theme === id ? " is-on" : ""}${id === "auto" ? " rset__theme--auto" : ""}`}
                style={{ ["--tbg" as string]: th.bg, ["--tfg" as string]: th.fg }}
                onClick={() => set({ theme: id })}
              >
                <span className="rset__swatch">Aa</span>
                <span className="rset__label">{label}</span>
              </button>
            );
          })}
        </div>
      </Section>}

      {(!isAndroid || mobileSection === "customize") && <>
      <Section title={t.rsFont}>
        <div className="rset__fonts" role="radiogroup" aria-label={t.rsFont}>
          {fonts.filter(([id]) => !isAndroid || id !== "sans").map(([id, label]) => (
            <button
              key={id}
              role="radio"
              aria-checked={prefs.font === id}
              className={`rset__font${prefs.font === id ? " is-on" : ""}`}
              style={{ fontFamily: FONT_STACKS[id] ?? undefined }}
              onClick={() => set({ font: id })}
            >
              {label}
            </button>
          ))}
        </div>
      </Section>

      <Section title={`${t.rsSize} · ${prefs.size}%`}>
        <div className="rset__size">
          <button
            className="rset__step"
            onClick={() => set({ size: Math.max(SIZE_MIN, prefs.size - 10) })}
            aria-label={t.fontSmaller}
            title={t.fontSmaller}
          >
            <span style={{ fontSize: 13 }}>A</span>
          </button>
          <input
            type="range"
            min={SIZE_MIN}
            max={SIZE_MAX}
            step={5}
            value={prefs.size}
            onChange={(e) => set({ size: Number(e.target.value) })}
            aria-label={t.rsSize}
          />
          <button
            className="rset__step"
            onClick={() => set({ size: Math.min(SIZE_MAX, prefs.size + 10) })}
            aria-label={t.fontLarger}
            title={t.fontLarger}
          >
            <span style={{ fontSize: 21 }}>A</span>
          </button>
        </div>
      </Section>

      <div className="rset__grid">
        <Section title={t.rsSpacing}>
          <Seg<Spacing>
            value={prefs.spacing}
            onChange={(spacing) => set({ spacing })}
            options={[
              ["tight", <Lines key="t" gap={2} />, t.rsTight],
              ["normal", <Lines key="n" gap={3.5} />, t.rsNormal],
              ["loose", <Lines key="l" gap={5} />, t.rsLoose],
            ]}
          />
        </Section>
        <Section title={t.rsMargins}>
          <Seg<Margins>
            value={prefs.margins}
            onChange={(margins) => set({ margins })}
            options={[
              ["narrow", <Page key="n" inset={2} />, t.rsNarrow],
              ["normal", <Page key="m" inset={4} />, t.rsNormal],
              ["wide", <Page key="w" inset={6} />, t.rsWide],
            ]}
          />
        </Section>
      </div>

      {!isAndroid && <Section title={t.rsLayout}>
        <Seg<"spread" | "single">
          value={prefs.spread ? "spread" : "single"}
          onChange={(v) => set({ spread: v === "spread" })}
          options={[
            ["spread", <span key="s">{t.rsSpread}</span>, t.rsSpread],
            ["single", <span key="o">{t.rsSingle}</span>, t.rsSingle],
          ]}
        />
      </Section>}

      </>}
      <div className="rset__toggles">
        {(!isAndroid || mobileSection === "customize") && <Toggle label={t.rsJustify} on={prefs.justify} onChange={(justify) => set({ justify })} />}
        {!isAndroid && <Toggle label={t.pageCurlShort} on={prefs.curl} onChange={(curl) => set({ curl })} />}
        {!isAndroid && kindle && <Toggle label={t.rsKindleSync} on={prefs.kindleSync} onChange={(kindleSync) => set({ kindleSync })} />}
        {(!isAndroid || mobileSection === "tools") && <>
        <Toggle label={t.rsDict} on={prefs.dict} onChange={(dict) => set({ dict })} />
        <Toggle label={t.rsXray} on={prefs.xray} onChange={(xray) => set({ xray })} />
        </>}
      </div>
      {(!isAndroid || mobileSection === "tools") && prefs.xray && <AiSettings lang={lang} provider={prefs.aiProvider} setProvider={(aiProvider) => set({ aiProvider })} />}
      {!isAndroid && kindle && <p className="rset__hint">{t.rsKindleSyncHint}</p>}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rset__sec">
      <h3 className="rset__title">{title}</h3>
      {children}
    </section>
  );
}

function Seg<V extends string>({
  value,
  onChange,
  options,
}: {
  value: V;
  onChange: (v: V) => void;
  options: [V, React.ReactNode, string][];
}) {
  return (
    <div className="rset__seg" role="radiogroup">
      {options.map(([v, content, label]) => (
        <button
          key={v}
          role="radio"
          aria-checked={value === v}
          aria-label={label}
          title={label}
          className={value === v ? "is-on" : ""}
          onClick={() => onChange(v)}
        >
          {content}
        </button>
      ))}
    </div>
  );
}

/** Which AI labels X-Ray relationships, and its API key. */
export function AiSettings({
  lang,
  provider,
  setProvider,
}: {
  lang: Lang;
  provider: "anthropic" | "deepseek";
  setProvider: (p: "anthropic" | "deepseek") => void;
}) {
  const t = STR[lang];
  const [status, setStatus] = useState<{ anthropic: string | null; deepseek: string | null } | null>(null);
  const [key, setKey] = useState("");
  const [err, setErr] = useState(false);
  const load = () => invoke<{ anthropic: string | null; deepseek: string | null }>("ai_key_status").then(setStatus).catch(() => undefined);
  useEffect(() => {
    load();
  }, []);
  const saved = status?.[provider];
  return (
    <section className="rset__sec rset__ai">
      <h3 className="rset__title">{t.rsAi}</h3>
      <div className="rset__seg" role="radiogroup">
        {(["anthropic", "deepseek"] as const).map((p) => (
          <button key={p} role="radio" aria-checked={provider === p} className={provider === p ? "is-on" : ""} onClick={() => setProvider(p)}>
            {p === "anthropic" ? "Claude" : "DeepSeek"}
          </button>
        ))}
      </div>
      {saved ? (
        <div className="rset__keyrow">
          <span>{t.rsKeySaved.replace("{0}", saved)}</span>
          <button className="btn" onClick={() => invoke("ai_key_clear", { provider }).then(load)}>
            {t.rsKeyClear}
          </button>
        </div>
      ) : (
        <div className="rset__keyrow">
          <input
            type="password"
            value={key}
            placeholder={t.rsKeyPlaceholder}
            onChange={(e) => {
              setKey(e.target.value);
              setErr(false);
            }}
          />
          <button
            className="btn btn--primary"
            disabled={!key.trim()}
            onClick={() =>
              invoke("ai_key_set", { provider, key })
                .then(() => {
                  setKey("");
                  load();
                })
                .catch(() => setErr(true))
            }
          >
            {t.rsKeySave}
          </button>
        </div>
      )}
      <p className="rset__hint">{err ? t.rsKeyBad : isAndroid ? t.mrAiHint : t.rsAiHint}</p>
    </section>
  );
}

function Toggle({ label, on, onChange }: { label: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="rset__toggle">
      <span>{label}</span>
      <input type="checkbox" role="switch" checked={on} onChange={(e) => onChange(e.target.checked)} />
      <span className="rset__switch" aria-hidden="true" />
    </label>
  );
}

/** Tiny icons: three text lines with a given leading / a page with margins. */
function Lines({ gap }: { gap: number }) {
  if (isAndroid) return <Icon name="text" size={22} />;
  return (
    <svg width="22" height="18" viewBox="0 0 22 18" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <rect key={i} x="2" y={9 - gap - 1 + i * gap} width="18" height="1.6" rx=".8" fill="currentColor" />
      ))}
    </svg>
  );
}
function Page({ inset }: { inset: number }) {
  if (isAndroid) return <Icon name="pages" size={22} />;
  return (
    <svg width="22" height="18" viewBox="0 0 22 18" aria-hidden="true">
      <rect x="1.5" y="1.5" width="19" height="15" rx="2" fill="none" stroke="currentColor" strokeWidth="1.2" opacity=".5" />
      <rect x={1.5 + inset} y="5" width={19 - inset * 2} height="1.4" rx=".7" fill="currentColor" />
      <rect x={1.5 + inset} y="8.3" width={19 - inset * 2} height="1.4" rx=".7" fill="currentColor" />
      <rect x={1.5 + inset} y="11.6" width={19 - inset * 2} height="1.4" rx=".7" fill="currentColor" />
    </svg>
  );
}
