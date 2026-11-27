import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Lang } from "../i18n";
import type { GenreInfo } from "./types";

let loaded: GenreInfo[] | null = null;

/** The genre groups (loaded once) and a lookup from a genre id to its name. */
export function useGenres(lang: Lang) {
  const [list, setList] = useState<GenreInfo[]>(loaded ?? []);
  useEffect(() => {
    if (loaded) return;
    invoke<GenreInfo[]>("genre_list")
      .then((g) => {
        loaded = g;
        setList(g);
      })
      .catch(console.error);
  }, []);
  const name = (id: string) => {
    const g = list.find((x) => x.id === id);
    return g ? g[lang] : undefined;
  };
  return { list, name };
}
