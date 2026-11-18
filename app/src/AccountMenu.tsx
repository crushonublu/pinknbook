import { useEffect, useRef, useState } from "react";
import { STR, type Lang } from "./i18n";
import { Icon } from "./icons";

/**
 * One title-bar button for everything that is not about the books: device,
 * language, light/dark, sign out. Keeps the bar quiet.
 */
export function AccountMenu({
  lang,
  setLang,
  theme,
  setTheme,
  deviceName,
  onSignOut,
}: {
  lang: Lang;
  setLang: (l: Lang) => void;
  theme: "light" | "dark";
  setTheme: (t: "light" | "dark") => void;
  deviceName?: string;
  onSignOut?: () => void;
}) {
  const t = STR[lang];
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="menu" ref={ref}>
      <button
        className={`iconbtn${open ? " iconbtn--on" : ""}`}
        onClick={() => setOpen((v) => !v)}
        title={t.account}
        aria-label={t.account}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Icon name="user" size={20} />
      </button>
      {open && (
        <div className="menu__panel" role="menu">
          {deviceName && (
            <div className="menu__head">
              <Icon name="monitor" size={18} />
              <div>
                <div className="menu__label">{t.thisDevice}</div>
                <div className="menu__value">{deviceName}</div>
              </div>
            </div>
          )}
          <div className="menu__row">
            <span className="menu__label">
              <Icon name="globe" size={16} />
              {t.language}
            </span>
            <div className="seg seg--sm" role="radiogroup">
              {(["vi", "en"] as Lang[]).map((l) => (
                <button
                  key={l}
                  role="radio"
                  aria-checked={lang === l}
                  className={`seg__btn${lang === l ? " seg__btn--on" : ""}`}
                  onClick={() => setLang(l)}
                >
                  {l.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
          <div className="menu__row">
            <span className="menu__label">
              <Icon name={theme === "dark" ? "moon" : "sun"} size={16} />
              {t.theme}
            </span>
            <div className="seg seg--sm" role="radiogroup">
              {(["light", "dark"] as const).map((m) => (
                <button
                  key={m}
                  role="radio"
                  aria-checked={theme === m}
                  className={`seg__btn${theme === m ? " seg__btn--on" : ""}`}
                  onClick={() => setTheme(m)}
                  title={m === "light" ? t.themeLight : t.themeDark}
                  aria-label={m === "light" ? t.themeLight : t.themeDark}
                >
                  <Icon name={m === "light" ? "sun" : "moon"} size={15} />
                </button>
              ))}
            </div>
          </div>
          {onSignOut && (
            <>
              <div className="menu__sep" />
              <button
                className="menu__item"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  onSignOut();
                }}
              >
                <Icon name="logout" size={17} />
                {t.signOut}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
