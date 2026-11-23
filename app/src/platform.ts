/**
 * Where the app runs. Android has one window and no mouse: window controls,
 * drag and drop, watched folders, Explorer and the self-updater are desktop
 * only, and Amazon sign-in is not wired up there yet.
 */
export const isAndroid = typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);
