import { useEffect, useRef } from "react";
import { exit, onBackButtonPress } from "@tauri-apps/api/app";
import { isAndroid } from "../platform";

// Nested mobile UI consumes Back before App handles its navigation state.
export function useMobileDismiss(open: boolean, close: () => void, priority = false) {
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => {
    if (!open) return;
    const back = (e: Event) => { e.preventDefault(); if (priority) e.stopImmediatePropagation(); latest.current(); };
    const key = (e: KeyboardEvent) => {
      if (!priority && document.querySelector("[data-mobile-picker]")) return;
      if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); latest.current(); }
    };
    window.addEventListener("mobile-dismiss", back, priority);
    window.addEventListener("keydown", key, true);
    return () => { window.removeEventListener("mobile-dismiss", back, priority); window.removeEventListener("keydown", key, true); };
  }, [open, priority]);
}

export function useAndroidBack(back: () => boolean, onError: (e: string) => void) {
  const latest = useRef({ back, onError });
  latest.current = { back, onError };
  useEffect(() => {
    if (!isAndroid) return;
    let disposed = false;
    let unregister: (() => Promise<void>) | undefined;
    onBackButtonPress(() => {
      const nested = new Event("mobile-dismiss", { cancelable: true });
      if (!window.dispatchEvent(nested)) return;
      if (!latest.current.back()) void exit(0).catch((e) => latest.current.onError(String(e)));
    }).then((listener) => {
      if (disposed) void listener.unregister();
      else unregister = () => listener.unregister();
    }).catch((e) => latest.current.onError(String(e)));
    return () => { disposed = true; void unregister?.(); };
  }, []);
}
