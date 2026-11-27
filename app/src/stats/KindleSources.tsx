import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { STR, type Lang } from "../i18n";
import { Icon } from "../icons";
import { fmt } from "./format";
import { saveStatsSettings } from "./settings";
import { Switch } from "./Switch";
import type { AmazonDays, KindleUsage } from "./types";

/**
 * Android only (`kindle_usage_status` says so; nothing is drawn elsewhere): time reading in the Kindle app on this phone. Without
 * "Usage access" there is a button to the system settings; once it is granted
 * (checked again whenever the app comes back to the front) a toggle.
 * Granting it starts measuring at once.
 */
export function KindleAppRow({ lang, onChanged }: { lang: Lang; onChanged: () => void }) {
  const t = STR[lang];
  const [usage, setUsage] = useState<KindleUsage | null>(null);
  const was = useRef<KindleUsage | null>(null);

  const load = useCallback(() => {
    invoke<KindleUsage>("kindle_usage_status")
      .then((u) => {
        const justGranted = !!was.current && !was.current.granted && u.granted;
        was.current = u;
        setUsage(u);
        if (justGranted) invoke("kindle_activity_tick").catch(() => undefined).then(onChanged);
      })
      .catch(() => undefined);
  }, [onChanged]);

  useEffect(() => {
    load();
    const visible = () => document.visibilityState === "visible" && load();
    window.addEventListener("focus", load);
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.removeEventListener("focus", load);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [load]);

  if (!usage?.supported) return null;
  if (!usage.granted) {
    return (
      <div className="scx-settings__row">
        <span>{t.sxKindleAppTitle}<small>{t.sxKindleAppNeeds}</small></span>
        <button className="scx__btn scx__btn--small" onClick={() => invoke("kindle_usage_open_settings").catch(() => undefined)}>{t.sxKindleAppGrant}</button>
      </div>
    );
  }
  return (
    <label className="scx-settings__row scx-settings__row--toggle">
      <span>{t.sxKindleAppTitle}<small>{t.sxKindleAppHint}</small></span>
      <Switch on={usage.enabled} onChange={(on) => saveStatsSettings({ kindleAppUsage: on }, () => { load(); onChanged(); })} />
    </label>
  );
}

/**
 * The days Amazon says were read on a Kindle: when they were fetched, a
 * refresh button and, when the web session is gone, a way to sign in again.
 * Nothing until the first try.
 */
export function AmazonDaysRow({ lang, days, onChanged }: { lang: Lang; days: AmazonDays; onChanged: () => void }) {
  const t = STR[lang];
  const [busy, setBusy] = useState(false);
  const unlisten = useRef<UnlistenFn[]>([]);
  useEffect(() => () => unlisten.current.forEach((u) => u()), []);

  const refresh = () => {
    setBusy(true);
    invoke("amazon_days_refresh", { force: true })
      .catch(() => undefined)
      .then(() => {
        setBusy(false);
        onChanged();
      });
  };
  // The sign-in window opens; when it is done the days are fetched again.
  const signIn = async () => {
    const stop = () => {
      unlisten.current.forEach((u) => u());
      unlisten.current = [];
    };
    stop();
    unlisten.current = await Promise.all([
      listen("login-complete", () => {
        stop();
        refresh();
      }),
      listen("login-error", stop),
    ]);
    invoke("login").catch(stop);
  };

  if (days.status === "none") return null;
  const at = days.fetched_at
    ? new Date(days.fetched_at * 1000).toLocaleString(lang === "vi" ? "vi-VN" : "en-GB", { hour: "2-digit", minute: "2-digit", day: "numeric", month: "numeric" })
    : "";
  const state = days.status === "needs_signin" ? t.sxAmazonDaysSignIn : days.status === "error" ? t.sxAmazonDaysError : fmt(t.sxAmazonDaysAt, at);
  return (
    <div className="scx-settings__row scx-source" title={t.sxAmazonDaysHint}>
      <span>{t.sxAmazonDaysTitle}<small>{state}</small></span>
      <span className="scx-source__actions">
        {days.status === "needs_signin" && <button className="scx__btn scx__btn--small" onClick={signIn}>{t.sxAmazonDaysSignInBtn}</button>}
        <button className="scx-source__refresh" disabled={busy} onClick={refresh} aria-label={t.sxAmazonDaysRefresh} title={t.sxAmazonDaysRefresh}>
          <Icon name="refresh" size={16} />
        </button>
      </span>
    </div>
  );
}
