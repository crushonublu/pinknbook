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

// ---- Groups -------------------------------------------------------------------

/** Where a group comes from: the reader, the AI, a family name, the narrator's kin, an organisation, a place, or what is left. */
export type GroupKind = "user" | "ai" | "family" | "narrator" | "org" | "place" | "others";

export interface CastGroup {
  /** Stable while the book is read: `family:vance`, `org:<key>`, `place:<key>`, `ai:<name>`, `user:<name>`, `narrator`, `others`. */
  id: string;
  kind: GroupKind;
  /** The family name, organisation or place, or the name the AI or the reader gave. */
  label: string;
  /** Entity keys, most important first. */
  members: string[];
}

export interface GroupOptions {
  /** Entity key → group id the reader moved them to (over everything else). */
  assign?: Record<string, string>;
  /** Entity key → group name the AI gave. */
  ai?: Map<string, string>;
  /** The person the story turns around (groups are ranked by their ties to them). */
  center?: string | null;
  /** The kind of tie between two people (from labels), to bring in-laws into a family. */
  kindOf?: (a: string, b: string) => string;
  /** At most this many groups besides "others". */
  max?: number;
}

/** A group needs this many chunks shared with an organisation, and this share of the person's own. */
const ORG_SHARED = 3;
const ORG_SHARE = 0.3;
export const MAX_GROUPS = 6;

/** The words of a name, without brackets ("Đinh Huy (bố tôi)" → Đinh, Huy). */
export function nameParts(name: string): string[] {
  return name
    .replace(/\([^)]*\)/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{M}’'-]/gu, ""))
    .filter((w) => w.length > 1);
}

/**
 * The people of the story so far (main and minor, no author), in groups: the
 * AI's, then families (people sharing a family name who appear together; the
 * narrator with the kin they name), then organisations someone appears with
 * often, then clusters of people who appear together, named after the place
 * or organisation they share; the reader's moves win over all of it. Groups
 * of one go to "others"; at most `max` groups, the ones closest to the
 * center. Same input, same groups.
 */
export function groups(ents: Entity[], links: Link[], cast: Map<string, CastInfo>, limit: number, opts: GroupOptions = {}): CastGroup[] {
  const max = opts.max ?? MAX_GROUPS;
  const people = ents
    .filter((e) => {
      const c = cast.get(e.key);
      return e.type === "person" && c && !c.author && c.tier !== "passing";
    })
    .sort((a, b) => cast.get(b.key)!.score - cast.get(a.key)!.score || (a.key < b.key ? -1 : 1));
  const rank = new Map(people.map((e, i) => [e.key, i]));
  const chunks = (e: Entity) => new Set(upTo(e.mentions, limit).map((m) => m[3]));
  const pc = new Map(people.map((e) => [e.key, chunks(e)]));
  const weights = new Map(links.map((l) => [l.key, l.chunks.length]));
  const weight = (a: string, b: string) => weights.get(a < b ? `${a}\u0001${b}` : `${b}\u0001${a}`) ?? 0;

  const out = new Map<string, CastGroup>();
  const where = new Map<string, string>();
  const put = (id: string, kind: GroupKind, label: string, key: string) => {
    const old = where.get(key);
    if (old) {
      const g = out.get(old)!;
      g.members = g.members.filter((k) => k !== key);
    }
    let g = out.get(id);
    if (!g) out.set(id, (g = { id, kind, label, members: [] }));
    g.members.push(key);
    where.set(key, id);
  };
  const free = () => people.filter((e) => !where.has(e.key));

  // The AI's groups.
  for (const e of people) {
    const g = opts.ai?.get(e.key)?.trim();
    if (g) put(`ai:${g.toLocaleLowerCase()}`, "ai", g, e.key);
  }

  // Families: the family name is the first word (Vietnamese, Chinese, Korean
  // names) or the last (most others); the book's names say which.
  // The fullest name each goes by ("Tyler Brook", even when shown as "Tyler").
  const fullest = (e: Entity) => [e.name, ...e.forms].map(nameParts).sort((a, b) => b.length - a.length)[0];
  const multi = free().filter((e) => fullest(e).length >= 2);
  const byWord = (pick: (w: string[]) => string) => {
    const m = new Map<string, Entity[]>();
    for (const e of multi) {
      const w = pick(fullest(e)).toLocaleLowerCase();
      (m.get(w) ?? m.set(w, []).get(w)!).push(e);
    }
    return m;
  };
  // How many people a reading of the names puts with someone of the same name they appear with.
  const shared = (m: Map<string, Entity[]>) =>
    [...m.values()].reduce((n, v) => n + v.filter((e) => v.some((o) => o !== e && weight(e.key, o.key) > 0)).length, 0);
  const first = byWord((w) => w[0]);
  const last = byWord((w) => w[w.length - 1]);
  const families = shared(first) > shared(last) ? first : last;
  for (const [word, fam] of [...families.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (fam.length < 2) continue;
    // Only those who appear with another of the same name.
    const kept = fam.filter((e) => fam.some((o) => o !== e && weight(e.key, o.key) > 0));
    if (kept.length < 2) continue;
    const label = fullest(kept[0]).find((w) => w.toLocaleLowerCase() === word) ?? word;
    for (const e of kept) put(`family:${word}`, "family", label, e.key);
  }
  // The narrator and the kin they name ("bố tôi").
  const narrator = people.find((e) => e.narrator);
  if (narrator) {
    const kin = people.filter((e) => e.kin && !e.narrator && !where.has(e.key));
    if (kin.length) {
      const own = where.get(narrator.key);
      const id = own?.startsWith("family:") ? own : "narrator";
      if (id === "narrator") put(id, "narrator", narrator.name, narrator.key);
      const g = out.get(id)!;
      for (const e of kin) put(id, g.kind, g.label, e.key);
    }
  }
  // In-laws and others the labels call family join the family they are tied to.
  if (opts.kindOf) {
    for (const e of free()) {
      const fams = [...out.values()].filter((g) => g.kind === "family" || g.kind === "narrator");
      const best = fams
        .map((g) => ({ g, w: g.members.reduce((n, k) => n + (opts.kindOf!(e.key, k) === "family" ? weight(e.key, k) || 1 : 0), 0) }))
        .filter((v) => v.w > 0)
        .sort((a, b) => b.w - a.w || (a.g.id < b.g.id ? -1 : 1))[0];
      if (best) put(best.g.id, best.g.kind, best.g.label, e.key);
    }
  }

  // Organisations someone appears with often.
  const orgs = ents.filter((e) => e.type === "org").map((o) => ({ o, cs: chunks(o) }));
  for (const e of free()) {
    const mine = pc.get(e.key)!;
    let best: { o: Entity; r: number } | null = null;
    for (const { o, cs } of orgs) {
      let n = 0;
      for (const c of mine) if (cs.has(c)) n++;
      const r = n / Math.max(1, mine.size);
      if (n >= ORG_SHARED && r >= ORG_SHARE && (!best || r > best.r)) best = { o, r };
    }
    if (best) put(`org:${best.o.key}`, "org", best.o.name, e.key);
  }

  // Clusters among the rest: who appears with whom (label propagation, in a fixed order).
  const rest = free();
  const label = new Map(rest.map((e) => [e.key, e.key]));
  for (let round = 0; round < 20; round++) {
    let moved = false;
    for (const e of rest) {
      const score = new Map<string, number>();
      for (const o of rest) {
        if (o === e) continue;
        const w = weight(e.key, o.key);
        const l = label.get(o.key)!;
        if (w > 0) score.set(l, (score.get(l) ?? 0) + w);
      }
      let pick = label.get(e.key)!;
      let top = score.get(pick) ?? 0;
      for (const [l, w] of [...score.entries()].sort((a, b) => rank.get(a[0])! - rank.get(b[0])!)) {
        if (w > top) {
          pick = l;
          top = w;
        }
      }
      if (pick !== label.get(e.key)) {
        label.set(e.key, pick);
        moved = true;
      }
    }
    if (!moved) break;
  }
  const clusters = new Map<string, Entity[]>();
  for (const e of rest) {
    const l = label.get(e.key)!;
    (clusters.get(l) ?? clusters.set(l, []).get(l)!).push(e);
  }
  const anchors = ents.filter((e) => e.type === "place" || e.type === "org").map((a) => ({ a, cs: chunks(a) }));
  for (const members of clusters.values()) {
    if (members.length < 2) continue;
    // Named after the place or organisation its people appear with most.
    let best: { a: Entity; n: number } | null = null;
    for (const { a, cs } of anchors) {
      let n = 0;
      for (const e of members) for (const c of pc.get(e.key)!) if (cs.has(c)) n++;
      if (n >= ORG_SHARED * members.length && (!best || n > best.n || (n === best.n && a.key < best.a.key))) best = { a, n };
    }
    if (!best) continue;
    const kind: GroupKind = best.a.type === "org" ? "org" : "place";
    for (const e of members) put(`${kind}:${best.a.key}`, kind, best.a.name, e.key);
  }

  // The reader's moves win over everything.
  for (const [key, id] of Object.entries(opts.assign ?? {})) {
    if (!rank.has(key)) continue;
    const at = id.indexOf(":");
    const prefix = at > 0 ? id.slice(0, at) : id;
    const known = out.get(id);
    const kind: GroupKind = known?.kind ?? (["family", "org", "place", "ai", "narrator"].includes(prefix) ? (prefix as GroupKind) : "user");
    put(id, kind, known?.label ?? (at > 0 ? id.slice(at + 1) : id), key);
  }

  // Groups of one go to "others" (not the reader's own); keep the groups closest to the center.
  const tie = (g: CastGroup) => (opts.center ? g.members.reduce((n, k) => n + (k === opts.center ? 0 : weight(k, opts.center!)), 0) : 0);
  const real = [...out.values()].filter((g) => g.members.length >= 2 || (g.kind === "user" && g.members.length > 0));
  real.sort((a, b) => tie(b) - tie(a) || b.members.length - a.members.length || (a.id < b.id ? -1 : 1));
  const kept = real.slice(0, max);
  const keptIds = new Set(kept.map((g) => g.id));
  const others: CastGroup = { id: "others", kind: "others", label: "", members: [] };
  for (const e of people) if (!keptIds.has(where.get(e.key) ?? "")) others.members.push(e.key);
  for (const g of kept) g.members.sort((a, b) => rank.get(a)! - rank.get(b)!);
  return others.members.length ? [...kept, others] : kept;
}
