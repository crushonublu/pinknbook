import { MobilePicker } from "./MobilePicker";
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import { STR, type Lang } from "../i18n";
import { fmtBytes } from "../LocalImport";
import { AiSettings } from "../ReaderSettings";
import { loadPrefs, savePrefs } from "../readerPrefs";
import { Icon } from "../icons";
import { MobileHeader } from "./MobileShell";
import { useMobileDismiss } from "./back";

export default function MobileAccount({ lang, setLang, theme, setTheme, goal, onChanged, onLocalLibrary, deviceName, signedIn, busy, onSignIn, onSignOut }: { lang: Lang; setLang: (l: Lang) => void; theme: "light" | "dark"; setTheme: (t: "light" | "dark") => void; goal: number; onChanged: () => void; onLocalLibrary: () => void; deviceName?: string; signedIn: boolean; busy: boolean; onSignIn: () => void; onSignOut: () => void }) {
  const t = STR[lang];
  const [usage, setUsage] = useState<{ count: number; bytes: number } | null>(null);
  const [dict, setDict] = useState<{ ready: boolean; installing: boolean } | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [panel, setPanel] = useState<"dict" | "ai" | null>(null);
  const [provider, setProvider] = useState(() => loadPrefs().aiProvider);
  const [error, setError] = useState<string | null>(null);
  const [installText, setInstallText] = useState("");
  const [keys, setKeys] = useState(false);
  useMobileDismiss(!!panel, () => setPanel(null));
  useEffect(() => {
    const fail = (e: unknown) => setError(String(e));
    invoke<{ count: number; bytes: number }>("local_usage").then(setUsage, fail);
    invoke<{ ready: boolean; installing: boolean }>("dict_status").then(setDict, fail);
    invoke<{ anthropic: string | null; deepseek: string | null }>("ai_key_status").then((s) => setKeys(!!(s.anthropic || s.deepseek)), fail);
    getVersion().then(setVersion, fail);
    const off = listen<{ phase: string; file?: string; done?: number; total?: number; message?: string }>("dict-progress", ({ payload: p }) => {
      if (p.phase === "done") { setDict({ ready: true, installing: false }); setInstallText(""); }
      else if (p.phase === "error") { setDict({ ready: false, installing: false }); setError(p.message ?? t.mobileInstallFailed); }
      else { setDict({ ready: false, installing: true }); setInstallText(p.phase === "download" ? t.dcSetupPhase_download.replace("{0}", p.file ?? "").replace("{1}", p.total ? `${Math.round((p.done ?? 0) / p.total * 100)}%` : "") : t.dcSetupPhase_build.replace("{0}", p.total ? `${Math.round((p.done ?? 0) / p.total * 100)}%` : "")); }
    });
    return () => { void off.then((f) => f()); };
  }, [t, panel]);
  return <><MobileHeader title={t.account} /><main className="mobile-content mobile-account">
    <section className="mobile-account__guest"><Icon name="user" size={32} /><div><b>{signedIn ? deviceName || t.mobileAmazonSignedIn : `${t.guest} \u00b7 ${t.mobileGuestAmazon}`}</b><p className="muted">{signedIn ? t.mobileAmazonSignedIn : t.mobileSignInNote}</p></div><button className={signedIn ? "iconbtn mobile-signout" : "btn btn--primary mobile-amazon-signin"} aria-label={signedIn ? t.signOut : undefined} title={signedIn ? t.signOut : undefined} disabled={busy} onClick={signedIn ? onSignOut : onSignIn}>{signedIn ? <Icon name="logout" size={22} /> : busy ? t.signingIn : t.signIn}</button></section>
    <section><h2>{t.library}</h2><div className="mobile-group"><button className="mobile-setting" onClick={onLocalLibrary}><span>{t.localLib}</span><small>{usage ? `${usage.count} · ${fmtBytes(usage.bytes, lang)}` : t.loading} ›</small></button><button className="mobile-setting" onClick={() => setPanel("dict")}><span>{t.mobileOfflineDictionary}</span><small>{dict?.ready ? t.mobileInstalled : dict?.installing ? t.loading : t.dcSetupStart} ›</small></button></div></section>
    <section><h2>{t.mobileReading}</h2><div className="mobile-group"><div className="mobile-setting"><span>{t.dailyGoal}</span><MobilePicker label={t.dailyGoal} value={goal} options={[5, 10, 15, 20, 30, 45, 60, 90, 120].map((g) => ({ value: g, label: t.minutesN.replace("{0}", String(g)) }))} onChange={(g) => { setError(null); invoke("set_stats_settings", { goalMinutes: g }).then(onChanged, (e) => setError(String(e))); }} /></div><button className="mobile-setting" onClick={() => setPanel("ai")}><span>{t.rsAi}</span><small>{keys ? t.mobileConfigured : t.mobileNoKey} ›</small></button></div></section>
    <section><h2>{t.mobileApplication}</h2><div className="mobile-group"><div className="mobile-setting"><span>{t.language}</span><MobilePicker label={t.language} value={lang} options={[{ value: "vi", label: t.vbLangVi }, { value: "en", label: t.vbLangEn }]} onChange={setLang} /></div><div className="mobile-setting"><span>{t.theme}</span><MobilePicker label={t.theme} value={theme} options={[{ value: "light", label: t.themeLight }, { value: "dark", label: t.themeDark }]} onChange={setTheme} /></div><div className="mobile-setting"><span>{t.mobileVersion}</span><small>{version ?? "—"}</small></div></div></section>
    {error && !panel && <p role="alert" className="mobile-error">{error}</p>}
    {panel && <div className="mobile-settings-backdrop" onClick={(e) => { if (e.target === e.currentTarget) setPanel(null); }}><section className="mobile-settings-panel" role="dialog" aria-modal="true" aria-label={panel === "dict" ? t.mobileOfflineDictionary : t.rsAi}><button className="iconbtn" autoFocus onClick={() => setPanel(null)} aria-label={t.closeReader}><Icon name="close" size={22} /></button>{error && <p role="alert" className="mobile-error">{error}</p>}{panel === "ai" ? <AiSettings lang={lang} provider={provider} setProvider={(p) => { setProvider(p); savePrefs({ ...loadPrefs(), aiProvider: p }); }} /> : <><h2>{t.mobileOfflineDictionary}</h2><p className="muted">{dict?.ready ? t.mobileInstalled : installText || t.dcSetupBody}</p>{!dict?.ready && <button className="btn btn--primary" disabled={!dict || dict.installing} onClick={() => { setError(null); setDict({ ready: false, installing: true }); invoke("dict_install").then(() => setDict({ ready: true, installing: false }), (e) => { setError(String(e)); setDict({ ready: false, installing: false }); }); }}>{dict?.installing ? t.loading : t.dcSetupStart}</button>}</>}</section></div>}
  </main></>;
}
