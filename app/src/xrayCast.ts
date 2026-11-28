/**
 * The cast of a book, from what X-Ray found: how much each person matters
 * (main, minor, passing), who is the author rather than a character, and
 * (phase 4) the groups people belong to. Pure functions over the entities
 * and links of `xrayIndex.ts`, cut at the reader's place like everything else.
 */
import type { Entity, Link, Mention } from "./xrayIndex";

/** How much a person matters to the story so far. */
export type Tier = "main" | "minor" | "passing";
/** What the AI said a person is (optional; see ai.rs). */
export type AiRole = "main" | "supporting" | "minor" | "not_a_character";

export interface CastInfo {
  tier: Tier;
  /** Importance, for ordering: mentions, spread over the book, ties. */
  score: number;
  mentions: number;
  /** Sections (roughly chapters) the person appears in. */
  sections: number;
  /** People they appear with. */
  degree: number;
  /** The book's author or translator, not a character. */
  author?: boolean;
  /** The tier came from the reader, the AI, or the rules. */
  from: "user" | "ai" | "auto";
}

/** At most this many main characters (the narrator counts). */
export const MAX_MAIN = 8;
/** A main character scores at least this share of the top score. */
const MAIN_SHARE = 0.35;
/** Fewer mentions than this: passing. */
const MIN_MENTIONS = 5;
/** Front and back matter: mentions only here are the book's, not the story's. */
const FRONT = 0.02;
const BACK = 0.97;

const upTo = (ms: Mention[], limit: number) => (limit >= 1 ? ms : ms.filter((m) => m[4] <= limit + 1e-9));

/** Lower case, no marks ("Đinh" → "dinh"), words. */
export function nameWords(s: string): string[] {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** The people credited on the book ("A, B & C", "A và B", "A; dịch: B"), each as words. */
export function creditedPeople(credits: string[]): string[][] {
  const out: string[][] = [];
  for (const c of credits) {
    for (const part of c.split(/[,;&/]|\s(?:and|và|with|cùng)\s|\b(?:dịch|translated by|translator|người dịch)\b:?/i)) {
      const w = nameWords(part);
      if (w.length) out.push(w);
    }
  }
  return out;
}

/**
 * Is this name one of the credited people? The same words in any order
 * ("Carreyrou John"), a fuller form of the name, but never one shared word
 * with a longer different name ("John Smith" is not "John Carreyrou").
 *
 * One word alone ("Carreyrou") counts only for the credits in `short`: those
 * whose full name the book also uses, so a character who happens to share a
 * given name with the author ("Hoài" in a book by Tô Hoài) stays.
 */
export function isCredited(name: string, credited: string[][], short: Set<number> = new Set()): boolean {
  const n = nameWords(name);
  if (!n.length) return false;
  for (const [i, p] of credited.entries()) {
    if (n.length === 1) {
      if (p.length === 1 && p[0] === n[0]) return true;
      if (short.has(i) && p.length >= 2 && n[0] === p[p.length - 1] && n[0].length >= 3) return true;
      continue;
    }
    const inP = n.every((w) => p.includes(w));
    const pInN = p.every((w) => n.includes(w));
    if (inP || pInN) return true;
  }
  return false;
}

export interface CastOptions {
  /** Author, translator… as written on the book. */
  credits?: string[];
  /** Entity key → the reader's choice. */
  overrides?: Record<string, Tier>;
  /** Entity key → what the AI said. */
  roles?: Map<string, AiRole>;
}

/**
 * Tiers for the people seen up to `limit`. `links` are the ties up to the
 * same limit. The narrator of a first-person book is always main; the
 * reader's choice beats the AI's, which beats the rules.
 */
export function castOf(ents: Entity[], links: Link[], limit: number, opts: CastOptions = {}): Map<string, CastInfo> {
  const credited = creditedPeople(opts.credits ?? []);
  // Credits the book names in full: their family name alone counts too.
  const short = new Set<number>();
  for (const e of ents) {
    if (e.type !== "person") continue;
    for (const f of [e.name, ...e.forms]) {
      const w = nameWords(f);
      if (w.length < 2) continue;
      credited.forEach((p, i) => {
        if (p.length >= 2 && p.every((x) => w.includes(x))) short.add(i);
      });
    }
  }
  const degree = new Map<string, number>();
  for (const l of links) {
    degree.set(l.a, (degree.get(l.a) ?? 0) + 1);
    degree.set(l.b, (degree.get(l.b) ?? 0) + 1);
  }
  const out = new Map<string, CastInfo>();
  const people = ents.filter((e) => e.type === "person");
  for (const e of people) {
    const ms = upTo(e.mentions, limit);
    if (!ms.length) continue;
    const sections = new Set(ms.map((m) => m[0])).size;
    const d = degree.get(e.key) ?? 0;
    const score = Math.log1p(ms.length) * (1 + Math.log2(Math.max(1, sections))) * (1 + 0.5 * Math.log2(1 + d));
    const author = !e.narrator && (isCredited(e.name, credited, short) || e.forms.some((f) => isCredited(f, credited, short)));
    out.set(e.key, { tier: "minor", score, mentions: ms.length, sections, degree: d, from: "auto", ...(author ? { author: true } : {}) });
  }

  // Rules: passing first, then the main few among the rest.
  const top = Math.max(0, ...[...out.values()].filter((c) => !c.author).map((c) => c.score));
  for (const e of people) {
    const c = out.get(e.key);
    if (!c) continue;
    const ms = upTo(e.mentions, limit);
    const matterOnly = ms.every((m) => m[4] <= FRONT || m[4] >= BACK);
    if (c.author || c.mentions < MIN_MENTIONS || matterOnly || (c.sections <= 1 && c.degree <= 1)) c.tier = "passing";
  }
  const ranked = people
    .map((e) => ({ e, c: out.get(e.key) }))
    .filter((x): x is { e: Entity; c: CastInfo } => !!x.c && x.c.tier !== "passing")
    .sort((a, b) => b.c.score - a.c.score);
  let mains = 0;
  for (const { e, c } of ranked) {
    if (e.narrator || (mains < MAX_MAIN && c.score >= MAIN_SHARE * top)) {
      c.tier = "main";
      mains++;
    }
  }
  for (const e of people) {
    const c = out.get(e.key);
    if (c && e.narrator) c.tier = "main";
  }

  // The AI, then the reader.
  const fromAi: Record<AiRole, Tier | null> = { main: "main", supporting: "minor", minor: "passing", not_a_character: "passing" };
  for (const [key, role] of opts.roles ?? []) {
    const c = out.get(key);
    const t = fromAi[role];
    if (c && t && !c.author) {
      c.tier = t;
      c.from = "ai";
    }
  }
  for (const [key, t] of Object.entries(opts.overrides ?? {})) {
    const c = out.get(key);
    if (c) {
      c.tier = t;
      c.from = "user";
      // Pinned by the reader: shown even if the name is also on the cover.
      delete c.author;
    }
  }
  return out;
}

/** People in the order lists show them: main, then minor, then passing; by importance within each. */
export function castOrder(cast: Map<string, CastInfo>): string[] {
  const rank: Record<Tier, number> = { main: 0, minor: 1, passing: 2 };
  return [...cast.entries()]
    .filter(([, c]) => !c.author)
    .sort((a, b) => rank[a[1].tier] - rank[b[1].tier] || b[1].score - a[1].score)
    .map(([k]) => k);
}
