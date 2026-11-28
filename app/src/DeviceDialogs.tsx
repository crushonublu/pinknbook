/**
 * The Amazon device this install signs in as: choosing it before signing in
 * (the one kept at sign-out, or a new one with a name), and the list of this
 * app's devices on the Amazon account, with a way to the page that removes
 * the old ones.
 */
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { STR, type Lang } from "./i18n";
import { Icon } from "./icons";
import { useMobileDismiss } from "./mobile/back";
import type { AccountInfo } from "./types";

/** Amazon's own page for the devices on the account (where old ones are removed). */
export const AMAZON_DEVICES_URL = "https://www.amazon.com/hz/mycd/digital-console/alldevices";

/** Before the Amazon sign-in: sign in again as the kept device, or as a new one under a name. */
export function SignInDialog({
  lang,
  onClose,
  onResume,
  onNew,
}: {
  lang: Lang;
  onClose: () => void;
  onResume: () => void;
  onNew: (name: string) => void;
}) {
  const t = STR[lang];
  const [saved, setSaved] = useState<AccountInfo | null | undefined>(undefined);
  const [name, setName] = useState("");
  const [other, setOther] = useState(false);
  useMobileDismiss(true, onClose, true);
  useEffect(() => {
    invoke<AccountInfo | null>("saved_device").then(setSaved, () => setSaved(null));
    invoke<string>("default_device_name").then((n) => setName((v) => v || n), () => undefined);
  }, []);
  const showNew = saved === null || other;
  return (
    <div className="modal" onMouseDown={onClose}>
      <div className="kpush devd" role="dialog" aria-modal="true" aria-labelledby="signin-title" onMouseDown={(e) => e.stopPropagation()}>
        <div className="kpush__icon" aria-hidden="true">
          <Icon name="key" size={22} />
        </div>
        <h2 id="signin-title" className="kpush__title">
          {t.signIn}
        </h2>
        {saved && (
          <button className="devd__saved" onClick={onResume} autoFocus>
            <Icon name="monitor" size={20} />
            <span>
              <b>{t.devResume}</b>
              <small>{t.devResumeSub.replace("{0}", saved.device_name)}</small>
            </span>
          </button>
        )}
        {saved && !other && (
          <button className="devd__other" onClick={() => setOther(true)}>
            {t.devOther}
          </button>
        )}
        {showNew && (
          <>
            <label className="devd__name">
              <span>{t.devName}</span>
              <input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} autoFocus={!saved} spellCheck={false} />
              <small>{t.devNameSub}</small>
            </label>
            {saved && <p className="devd__warn">{t.devReplaces.replace("{0}", saved.device_name)}</p>}
          </>
        )}
        <div className="kpush__actions">
          <button className="btn" onClick={onClose}>
            {t.cancel}
          </button>
          {showNew && (
            <button className="btn btn--primary" disabled={saved === undefined} onClick={() => onNew(name.trim())}>
              {t.devSignInNew}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

interface StkDevice {
  name: string;
  serial: string;
  app_made: boolean;
  this_device: boolean;
}

/** This app's devices on the Amazon account: which one is this install, and the way to remove the rest. */
export function AmazonDevicesDialog({ lang, onClose }: { lang: Lang; onClose: () => void }) {
  const t = STR[lang];
  const [devices, setDevices] = useState<StkDevice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useMobileDismiss(true, onClose, true);
  useEffect(() => {
    invoke<StkDevice[]>("stk_devices").then(setDevices, (e) => setError(String(e)));
  }, []);
  const mine = (devices ?? []).filter((d) => d.app_made).sort((a, b) => Number(b.this_device) - Number(a.this_device));
  const old = mine.filter((d) => !d.this_device).length;
  return (
    <div className="modal" onMouseDown={onClose}>
      <div className="kpush devd devd--list" role="dialog" aria-modal="true" aria-labelledby="devices-title" onMouseDown={(e) => e.stopPropagation()}>
        <h2 id="devices-title" className="kpush__title">
          {t.devTitle}
        </h2>
        <p className="kpush__text">{t.devBody}</p>
        {error ? (
          <p className="devd__warn" role="alert">{error}</p>
        ) : devices == null ? (
          <p className="muted">{t.loading}</p>
        ) : (
          <ul className="devd__list">
            {mine.map((d) => (
              <li key={d.serial} className={d.this_device ? "is-this" : undefined}>
                <Icon name={d.this_device ? "check" : "monitor"} size={16} />
                <span>{d.name}</span>
                {d.this_device && <b>{t.devThis}</b>}
              </li>
            ))}
            {!mine.length && <li className="muted">{t.devNone}</li>}
          </ul>
        )}
        {old > 0 && <p className="devd__hint">{t.devOldHint.replace("{0}", String(old))}</p>}
        <div className="kpush__actions">
          <button className="btn" onClick={onClose}>
            {t.xrClose}
          </button>
          <button className="btn btn--primary" onClick={() => openUrl(AMAZON_DEVICES_URL).catch((e) => setError(String(e)))}>
            {t.devOpenAmazon}
          </button>
        </div>
      </div>
    </div>
  );
}
