// The 3D icons the wrap-up cards use: the manifest (icons.json) and where the
// WebP files are served from (public/wrap-icons/<size>/<file>, made by
// scripts/fetch-wrap-icons.mjs).

import manifest from "./icons.json";

export interface IconEntry {
  id: string;
  file: string;
  tags: string[];
  /** Where the picture comes from (3dicons.reicon.dev). */
  source_url: string;
}

export const ICONS: readonly IconEntry[] = manifest;

/** Sizes the files exist in. */
export type IconSize = 256 | 512;

export const iconUrl = (id: string, size: IconSize = 256): string | null => {
  const icon = ICONS.find((i) => i.id === id);
  return icon ? `/wrap-icons/${size}/${icon.file}` : null;
};
