// What went wrong when a wrap-up picture was saved, shared or copied, in the reader's
// words. The messages come from wrap_export.rs and MainActivity.kt (English, raw), from
// the clipboard (a DOMException) and from exportImage.ts.

import { STR, type Lang } from "../i18n";

/** The raw messages the app itself produces, to the i18n key that says it. */
const KNOWN: [RegExp, keyof (typeof STR)["vi"]][] = [
  [/needs Android 10/i, "wrErrOldAndroid"],
  [/gallery did not accept/i, "wrErrGalleryRefused"],
  [/gallery gave no place/i, "wrErrGalleryWrite"],
  [/only available on the phone/i, "wrErrNoShare"],
  [/not available on this platform/i, "wrErrUnsupported"],
  [/Android could not take/i, "wrErrAndroid"],
  [/Could not write/i, "wrErrWriteFile"],
  [/could not be made/i, "wrErrPicture"],
  [/permission|denied|not allowed|NotAllowedError|SecurityException/i, "wrErrPermission"],
];

/**
 * The text of a failed export: a sentence in `lang` for the failures that are
 * known, else a general one; `detail` (the original message) is for small print
 * under it, and only given when the sentence is the general one.
 */
export function exportError(lang: Lang, e: unknown): { text: string; detail?: string } {
  const t = STR[lang];
  const raw = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  const known = KNOWN.find(([pattern]) => pattern.test(raw));
  if (known) return { text: t[known[1]] };
  return { text: t.wrExportFailed, detail: e instanceof Error ? e.message : raw };
}
