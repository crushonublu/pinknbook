/**
 * X-Ray: the people, places, organisations and terms of a book, where they
 * appear, and who appears with whom.
 *
 * Names are found offline: runs of capitalised words that appear several
 * times and not only at the start of sentences. Honorifics ("anh", "bà",
 * "Mr") are dropped, a short form that begins exactly one longer name
 * ("Ivan" → "Ivan Fyodorovich") joins it, and the reader can merge, rename,
 * retype or hide anything. Everything shown can be cut off at the reader's
 * place in the book so nothing is spoiled.
 */

export type XrType = "person" | "place" | "org" | "term";

/** One appearance: section, character offset in the section text, length, chunk, reading fraction. */
export type Mention = [number, number, number, number, number];

export interface XrForm {
  form: string;
  type: XrType;
  mentions: Mention[];
  /** First-person books: the narrator ("tôi"), or someone the narrator calls by kinship ("bố tôi"). */
  role?: "narrator" | "kin";
  /** For `kin`: the kinship word ("bố", "father"). */
  kin?: string;
}

/** A stretch of a section (a few paragraphs): the unit for "appear together". */
export interface Chunk {
  sec: number;
  start: number;
  end: number;
  fraction: number;
}

export interface XrIndex {
  version: number;
  /** Terms the index was built with (rebuild when they change). */
  terms: string[];
  forms: XrForm[];
  chunks: Chunk[];
  /** Words of narration (outside dialogue) and how many of them were "tôi" / "I". */
  narration?: { words: number; first: number };
}

export interface XrEdits {
  /** form → form it is merged into. */
  merges: Record<string, string>;
  /** Forms not to show. */
  hidden: string[];
  /** Entity key → display name. */
  names: Record<string, string>;
  /** Entity key → type. */
  types: Record<string, XrType>;
  /** Words the reader added (searched without case). */
  terms: string[];
  /** Pair key → the reader's own relationship label. */
  labels: Record<string, string>;
  /** Told in the first person: true / false as the reader set it, else guessed. */
  firstPerson?: boolean;
  /** Pairs already merged because the AI said they are one person (never redone after a split). */
  autoMerged?: string[];
  /** Entity key → how much the reader says the person matters (over the AI and the rules; see xrayCast.ts). */
  tiers?: Record<string, "main" | "minor" | "passing">;
  /** Entity key → the map group the reader moved them to (a group id, see xrayCast.ts `groups`). */
  groups?: Record<string, string>;
  /** Group id → the reader's name for it. */
  groupNames?: Record<string, string>;
}

export interface XrAi {
  /** Reading fraction the AI last saw up to. */
  upTo: number;
  provider?: string;
  /** `lang`: the language it was written in (redone when the reader's language differs). */
  descriptions: Record<string, { text: string; upTo: number; lang?: string }>;
  labels: Record<string, { label: string; detail: string; upTo: number; lang?: string }>;
  /** Name → how much the person matters, as the AI judged up to `upTo` (see xrayCast.ts `AiRole`). */
  roles?: Record<string, { role: "main" | "supporting" | "minor" | "not_a_character"; upTo: number }>;
  /** Name → a few words on who they are ("Elizabeth's father"), for the line under the name. */
  captions?: Record<string, { text: string; upTo: number; lang?: string }>;
  /** Name → the group or side they belong to ("Theranos board"), for the map's groups. */
  groups?: Record<string, { text: string; upTo: number; lang?: string }>;
}

export const EMPTY_EDITS: XrEdits = { merges: {}, hidden: [], names: {}, types: {}, terms: [], labels: {} };
export const EMPTY_AI: XrAi = { upTo: 0, descriptions: {}, labels: {} };
export const INDEX_VERSION = 3;

const BLOCKS = "p, li, dd, dt, blockquote, h1, h2, h3, h4, h5, h6, td, div";
const SKIP = new Set(["script", "style", "head", "title", "svg", "math", "rt"]);
const WORD = /[\p{L}\p{M}][\p{L}\p{M}'’-]*/gu;
const CHUNK_CHARS = 600;

const words = (s: string) => new Set(s.split(/\s+/).filter(Boolean));

const HONORIFICS = words(
  "ông bà anh chị cô cậu em bác chú thím mợ dì dượng cụ lão ngài thầy mụ ả gã cha mẹ bố má con cháu " +
    "mr mrs ms miss dr sir lady lord madame monsieur mademoiselle saint st",
);
/** Verbs a person does, said right after their name ("Tom nói", "Tom said"). */
const ACTS = words(
  "nói bảo hỏi đáp kêu gọi la hét quát cười khóc gật lắc nhìn ngó liếc nghĩ đứng ngồi nằm bước chạy quay mỉm thở nhăn cau giơ cầm nắm ngẩng cúi lẩm thì nhún " +
    "liền bèn vội nghe cảm thầm hỏi " +
    "said says asked asks replied answered cried shouted whispered laughed smiled nodded looked thought muttered turned sighed grinned stood sat walked",
);
/** Words right before a name that point to a person ("hỏi Tom", "said Tom", "nói với Tom"). */
const ACTS_BEFORE = new Set(["bảo", "hỏi", "nhìn", "gọi", "said", "asked", "replied", "told", "nói với", "bảo với", "hỏi lại", "nói chuyện với"]);
/** Words for a kind of place right before its name ("bang Texas", "người Mỹ", "city of"). */
const KINDS = new Set([
  ...words(
    "bang tỉnh huyện quận xã làng thôn ấp trấn phố đường sông núi đảo hồ biển vịnh miền vùng xứ nước người tiếng dân trại châu đô quân lính",
  ),
  "thành phố", "thị trấn", "thủ đô", "kinh đô", "thị xã", "dãy", "dãy núi", "con sông", "ngọn núi",
  "city of", "state of", "town of", "province of", "kingdom of", "republic of", "county of", "village of",
]);
/** Words of place ("ở", "in", "from"); people get some of these too. */
/** Ranks and titles written in lower case before a name ("đại úy Beck", "công chúa Irulan"). */
const TITLES = new Set([
  ...words(
    "vua ngài tướng sơ cha mục sư bác sĩ " +
      "captain colonel general doctor professor father sister brother uncle aunt king queen prince princess duke count baron lieutenant sergeant major inspector officer",
  ),
  "đại úy", "trung úy", "thượng úy", "thiếu úy", "đại tá", "trung tá", "thiếu tá", "thiếu tướng", "trung tướng", "đại tướng", "trung sĩ", "hạ sĩ",
  "bác sĩ", "giáo sư", "linh mục", "mục sư", "đức vua", "nhà vua", "hoàng đế", "hoàng hậu", "nữ hoàng", "hoàng tử", "công chúa", "thái tử",
  "công tước", "bá tước", "nam tước", "hầu tước", "tử tước", "phu nhân", "tiểu thư", "quận chúa", "đồng chí", "thanh tra", "luật sư", "thẩm phán",
]);
const AT = words("ở tại tới đến từ sang khỏi khắp qua in at to from into across through near toward towards outside");
/** Words often written with a capital that are not names (interjections, sentence words). */
const NOT_NAMES = new Set(
  (
    "ôi ồ ơ à ừ ờ ê này nào vâng dạ thưa chao trời ối ái úi hừ hử hả hở thế vậy rồi nhưng và còn nếu khi " +
    "oh ah yes no well the a an and but if when"
  ).split(" "),
);
const ORG_HEADS = new Set(
  "công hãng hội đảng trường viện bộ sở ngân tòa phủ báo nhà tu company bank church university college party ministry".split(" "),
);

/** Whether a word is written like a name: capital first, then lower case. */
function isCapitalised(w: string): boolean {
  const first = w[0];
  if (first.toUpperCase() === first.toLowerCase() || first !== first.toUpperCase()) return false;
  const rest = w.slice(1).replace(/[^\p{L}]/gu, "");
  // Single letters are initials; ALL-CAPS words are headings, not names.
  return !!rest && rest !== rest.toUpperCase();
}

/** Does a sentence (or a line of dialogue) start just before `at`? */
function sentenceStartsAt(text: string, at: number): boolean {
  for (let i = at - 1; i >= 0; i--) {
    const c = text[i];
    if (c === " " || c === " " || c === "\t") continue;
    return /[\n.!?…:;“"«(—–\-*]/.test(c);
  }
  return true;
}

interface SectionText {
  text: string;
  chunks: { start: number; end: number }[];
}

/** A section's text with paragraph breaks, cut into chunks of a few paragraphs. */
export function sectionText(doc: Document): SectionText & { nodes: Text[]; starts: number[] } {
  const root = doc.body ?? doc.documentElement;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      SKIP.has((n.parentElement?.localName ?? "").toLowerCase()) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  const nodes: Text[] = [];
  const starts: number[] = [];
  let text = "";
  let block: Element | null = null;
  const paras: number[] = [0];
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    const b = n.parentElement?.closest(BLOCKS) ?? null;
    if (b !== block && text) {
      text += "\n";
      paras.push(text.length);
    }
    block = b;
    nodes.push(n);
    starts.push(text.length);
    text += n.data;
  }
  const chunks: { start: number; end: number }[] = [];
  let cs = 0;
  for (let i = 1; i <= paras.length; i++) {
    const end = i < paras.length ? paras[i] : text.length;
    if (end - cs >= CHUNK_CHARS || i === paras.length) {
      if (end > cs) chunks.push({ start: cs, end });
      cs = end;
    }
  }
  return { text, chunks, nodes, starts };
}

/** The range of [offset, offset+length) in a section built by `sectionText`. */
export function rangeAt(doc: Document, offset: number, length: number): Range | null {
  const { nodes, starts } = sectionText(doc);
  const point = (o: number): [Text, number] | null => {
    let lo = 0;
    let hi = starts.length - 1;
    if (hi < 0) return null;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= o) lo = mid;
      else hi = mid - 1;
    }
    return [nodes[lo], Math.max(0, Math.min(o - starts[lo], nodes[lo].data.length))];
  };
  const a = point(offset);
  const b = point(offset + length);
  if (!a || !b) return null;
  const r = doc.createRange();
  try {
    r.setStart(a[0], a[1]);
    r.setEnd(b[0], b[1]);
  } catch {
    return null;
  }
  return r;
}

/**
 * Scan the whole book. `terms` are extra words to find (any case).
 * Reports progress 0–1.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function buildIndex(view: any, terms: string[], onProgress?: (p: number) => void): Promise<XrIndex> {
  const sections = view?.book?.sections ?? [];
  const fr: number[] = view.getSectionFractions?.() ?? [];
  const scan = new Scanner(terms);
  for (let s = 0; s < sections.length; s++) {
    if (!sections[s].createDocument) continue;
    let doc: Document;
    try {
      doc = await sections[s].createDocument();
    } catch {
      continue;
    }
    const { text, chunks } = sectionText(doc);
    scan.add(s, text, chunks, fr[s] ?? s / sections.length, fr[s + 1] ?? (s + 1) / sections.length);
    onProgress?.((s + 1) / sections.length);
    await new Promise((r) => setTimeout(r, 0));
  }
  return scan.finish();
}

/** What the words around a name say about it, counted over its appearances. */
export interface Evidence {
  /** After a title or kinship word ("anh Tom", "Mr Joad"). */
  title: number;
  /** Next to a verb of speech or a person's action ("Tom nói", "said Tom"). */
  act: number;
  /** After a word for a kind of place ("bang Texas", "người Mỹ"). */
  kind: number;
  /** After "ở", "in", "from" … (people get these too, places far more). */
  at: number;
  /** Starts with a word for a body ("Công ty", "Hội"). */
  head: number;
}

interface Rec {
  mentions: Mention[];
  mid: number;
  ev: Evidence;
  /** Lower-case words right after it ("Đại" → "úy"), to spot titles and common nouns. */
  nexts: Map<string, number>;
}

const SPACE = /^[  ]$/;
const SPACE_COMMA = /^,?[  ]$/;

/** Collects names section by section; `finish` sorts them out. */
export class Scanner {
  terms: string[];
  chunks: Chunk[] = [];
  found = new Map<string, Rec>();
  lowerCount = new Map<string, number>();
  /** Words of narration (outside dialogue). */
  narrWords = 0;

  constructor(terms: string[]) {
    this.terms = terms.map((t) => t.trim()).filter(Boolean);
  }

  add(s: number, text: string, cs: { start: number; end: number }[], f0: number, f1: number) {
    if (!text) return;
    const { chunks, found, lowerCount } = this;
    const fracAt = (o: number) => f0 + (f1 - f0) * (o / text.length);
    const firstChunk = chunks.length;
    for (const c of cs) chunks.push({ sec: s, start: c.start, end: c.end, fraction: fracAt(c.start) });
    const chunkOf = (o: number) => {
      let lo = firstChunk;
      let hi = chunks.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (chunks[mid].start <= o) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    };
    const rec = (form: string) => {
      let r = found.get(form);
      if (!r) found.set(form, (r = { mentions: [], mid: 0, ev: { title: 0, act: 0, kind: 0, at: 0, head: 0 }, nexts: new Map() }));
      return r;
    };

    // Words, in order, with their offsets.
    const words: { w: string; at: number }[] = [];
    for (const m of text.matchAll(WORD)) words.push({ w: m[0], at: m.index ?? 0 });
    for (const { w } of words) {
      if (w[0] === w[0].toLowerCase()) lowerCount.set(w, (lowerCount.get(w) ?? 0) + 1);
    }
    const gap = (k: number) => text.slice(words[k].at + words[k].w.length, words[k + 1].at);
    /** Only a space (and maybe a comma) between word k and the next. */
    const close = (k: number) => k >= 0 && k + 1 < words.length && SPACE_COMMA.test(gap(k));
    for (let i = 0; i < words.length; i++) {
      if (!isCapitalised(words[i].w)) continue;
      // A run of capitalised words separated by single spaces.
      let j = i;
      while (j + 1 < words.length && j - i < 3 && isCapitalised(words[j + 1].w) && SPACE.test(gap(j))) j++;
      const nameOf = (from: number) => text.slice(words[from].at, words[j].at + words[j].w.length).replace(/\s+/g, " ").toLowerCase();
      const isKnown = (s: string) => PLACES.has(s) || NOT_PEOPLE.has(s) || ORGS.has(s);
      // A known name may start with a one-letter word ("Ả Rập").
      const one = words[i - 1]?.w;
      if (i > 0 && one.length === 1 && one !== one.toLowerCase() && SPACE.test(gap(i - 1)) && isKnown(nameOf(i - 1))) i--;
      let a = i;
      let titled = false;
      const atStart = sentenceStartsAt(text, words[i].at);
      // A known name that starts like a title stays whole ("Ả Rập", "Ông Trời").
      const known = i < j && isKnown(nameOf(i));
      // Drop honorifics, and at a sentence start an ordinary word ("Nhưng").
      while (a <= j && !known) {
        const low = words[a].w.toLowerCase();
        if (HONORIFICS.has(low.replace(/\.$/, ""))) {
          a++;
          titled = true;
        } else if (a === i && atStart && a < j && (lowerCount.get(low) ?? 0) >= 2) a++;
        else break;
      }
      if (a <= j) {
        const start = words[a].at;
        const end = words[j].at + words[j].w.length;
        const form = text.slice(start, end).replace(/\s+/g, " ");
        const r = rec(form);
        r.mentions.push([s, start, end - start, chunkOf(start), fracAt(start)]);
        if (!(a === i && atStart)) r.mid++;
        const prev = close(a - 1) ? words[a - 1].w.toLowerCase() : "";
        const prev2 = prev && close(a - 2) ? `${words[a - 2].w.toLowerCase()} ${prev}` : "";
        const next = close(j) ? words[j + 1].w.toLowerCase() : "";
        const ev = r.ev;
        if (titled || HONORIFICS.has(prev) || TITLES.has(prev) || TITLES.has(prev2)) ev.title++;
        if (ACTS.has(next) || ACTS_BEFORE.has(prev) || ACTS_BEFORE.has(prev2)) ev.act++;
        if (KINDS.has(prev) || KINDS.has(prev2)) ev.kind++;
        else if (AT.has(prev)) ev.at++;
        if (ORG_HEADS.has(words[a].w.toLowerCase())) ev.head++;
        if (j + 1 < words.length && SPACE.test(gap(j)) && !isCapitalised(words[j + 1].w)) {
          const w = words[j + 1].w.toLowerCase();
          r.nexts.set(w, (r.nexts.get(w) ?? 0) + 1);
        }
      }
      i = j;
    }

    // The reader's own terms, matched without case.
    if (this.terms.length) {
      const low = text.toLowerCase();
      for (const t of this.terms) {
        const q = t.toLowerCase();
        const r = rec(`term:${t}`);
        for (let at = low.indexOf(q); at >= 0; at = low.indexOf(q, at + q.length)) {
          r.mentions.push([s, at, q.length, chunkOf(at), fracAt(at)]);
          r.mid++;
        }
      }
    }

    // First person: "tôi" / "I" in the narration (not inside quotes or dialogue
    // lines), and the people the narrator calls by kinship ("bố tôi", "my father").
    const talk = dialogueMask(text);
    for (const w of words) if (!talk[w.at]) this.narrWords++;
    const push = (key: string, at: number, len: number) => rec(key).mentions.push([s, at, len, chunkOf(at), fracAt(at)]);
    for (const m of text.matchAll(ME_VI)) {
      const at = (m.index ?? 0) + m[1].length;
      if (!talk[at]) push("\u0002me:vi", at, m[2].length);
    }
    for (const m of text.matchAll(ME_EN)) {
      const at = (m.index ?? 0) + m[1].length;
      if (!talk[at]) push("\u0002me:en", at, 1);
    }
    for (const [re, lang] of [[KIN_VI, "vi"], [KIN_EN, "en"]] as const) {
      for (const m of text.matchAll(re)) {
        const at = (m.index ?? 0) + m[1].length;
        if (!talk[at]) push(`\u0002kin:${lang}:${m[2].toLowerCase()}`, at, m[0].length - m[1].length);
      }
    }
  }

  /** Names worth keeping, as forms. */
  kept(): [string, Rec][] {
    return [...this.found].filter(([key, r]) => {
      if (key.startsWith("\u0002")) return false;
      if (key.startsWith("term:")) return true;
      // A name appears several times, at least twice inside a sentence, and is
      // not just an ordinary word written with a capital.
      const low = key.toLowerCase();
      const n = r.mentions.length;
      if (n < 3 || r.mid < 2 || NOT_NAMES.has(low)) return false;
      // Nearly always followed by the same word: part of a title or a common
      // noun ("Đại úy", "Trưởng phòng", "Sơn ca"), not a name.
      for (const c of r.nexts.values()) if (c >= 3 && c >= n / 2) return false;
      return key.includes(" ") || (this.lowerCount.get(low) ?? 0) <= n / 2;
    });
  }

  finish(): XrIndex {
    const forms: XrForm[] = this.kept().map(([key, r]) =>
      key.startsWith("term:")
        ? { form: key.slice(5), type: "term" as XrType, mentions: r.mentions }
        : { form: key, type: classify(key, r.mentions.length, r.ev), mentions: r.mentions },
    );
    // The narrator, in the language the book uses, and their kin.
    const vi = this.found.get("\u0002me:vi")?.mentions ?? [];
    const en = this.found.get("\u0002me:en")?.mentions ?? [];
    const lang = vi.length >= en.length ? "vi" : "en";
    const me = lang === "vi" ? vi : en;
    if (me.length >= 30) {
      forms.push({ form: lang === "vi" ? "Tôi (người kể)" : "I (narrator)", type: "person", mentions: me, role: "narrator" });
      for (const [key, r] of this.found) {
        if (!key.startsWith(`\u0002kin:${lang}:`) || r.mentions.length < 5) continue;
        const kin = key.slice(`\u0002kin:${lang}:`.length);
        const form = lang === "vi" ? `${kin[0].toUpperCase()}${kin.slice(1)} tôi` : `My ${kin}`;
        forms.push({ form, type: "person", mentions: r.mentions, role: "kin", kin });
      }
    }
    forms.sort((a, b) => b.mentions.length - a.mentions.length);
    return {
      version: INDEX_VERSION,
      terms: this.terms,
      forms,
      chunks: this.chunks,
      narration: { words: this.narrWords, first: me.length },
    };
  }
}

// ---- First person -------------------------------------------------------------

const ME_VI = /(^|[^\p{L}])(tôi)(?=$|[^\p{L}])/giu;
const ME_EN = /(^|[^\p{L}])(I)(?=$|[^\p{L}])/gu;
/** Kinship words before "tôi", longest first ("ông nội" before "ông"). */
const KIN_VI_WORDS =
  "ông nội|bà nội|ông ngoại|bà ngoại|anh trai|chị gái|em trai|em gái|con trai|con gái|bố|cha|mẹ|má|ông|bà|chú|thím|bác|cô|dì|cậu|mợ|vợ|chồng|anh|chị";
const KIN_VI = new RegExp(`(^|[^\\p{L}])(${KIN_VI_WORDS}) tôi(?=$|[^\\p{L}])`, "giu");
const KIN_EN_WORDS = "grandfather|grandmother|grandpa|grandma|father|mother|dad|mum|mom|uncle|aunt|brother|sister|wife|husband|son|daughter";
const KIN_EN = new RegExp(`(^|[^\\p{L}])my (${KIN_EN_WORDS})(?=$|[^\\p{L}])`, "giu");

/** Characters inside dialogue: between quotes, or on a line that opens with a dash. */
function dialogueMask(text: string): Uint8Array {
  const m = new Uint8Array(text.length);
  let quoted = false;
  let straight = false;
  let dashLine = false;
  let lineStart = true;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\n") {
      quoted = straight = dashLine = false;
      lineStart = true;
      continue;
    }
    if (lineStart) {
      if (c === " " || c === "\t" || c === "\u00a0") continue;
      lineStart = false;
      if (c === "–" || c === "—" || c === "-") dashLine = true;
    }
    if (c === "“" || c === "«") quoted = true;
    if (c === '"') straight = !straight;
    if (quoted || straight || dashLine || c === '"') m[i] = 1;
    if (c === "”" || c === "»") quoted = false;
  }
  return m;
}

/** "tôi" / "I" per 1000 words of narration from which a book counts as told in the first person. */
export const FIRST_PERSON_RATE = 9;

/** Whether the book is told in the first person: the reader's choice, else a guess from the narration. */
export function isFirstPerson(index: XrIndex, edits: XrEdits): boolean {
  if (edits.firstPerson != null) return edits.firstPerson;
  return firstPersonGuess(index);
}
export function firstPersonGuess(index: XrIndex): boolean {
  const n = index.narration;
  if (!n || n.words < 1000) return false;
  return n.first >= 50 && (n.first / n.words) * 1000 >= FIRST_PERSON_RATE;
}

/** The tie between the narrator and someone they call by kinship ("bố" → "bố – con"). */
export function kinLabel(kin: string): string {
  const k = kin.toLowerCase();
  const rules: [RegExp, string][] = [
    [/^(bố|cha|mẹ|má)$/, "con"],
    [/^(ông|bà)/, "cháu"],
    [/^(chú|thím|bác|cô|dì|cậu|mợ)$/, "cháu"],
    [/^vợ$/, "chồng"],
    [/^chồng$/, "vợ"],
    [/^(anh|chị)/, "em"],
    [/^em/, "anh chị"],
    [/^con/, "cha mẹ"],
    [/^(father|mother|dad|mum|mom)$/, "child"],
    [/^grand/, "grandchild"],
    [/^(uncle|aunt)$/, "nephew / niece"],
    [/^(brother|sister)$/, "sibling"],
    [/^wife$/, "husband"],
    [/^husband$/, "wife"],
    [/^(son|daughter)$/, "parent"],
  ];
  for (const [re, other] of rules) if (re.test(k)) return `${k} – ${other}`;
  return k;
}

const list = (s: string) => new Set(s.split("|").map((w) => w.trim().toLowerCase()).filter(Boolean));

/** Well-known places, so a book that never says "in Texas" still gets them right. */
const PLACES = list(
  // Countries and regions (Vietnamese and English).
  "Việt Nam|Mỹ|Hoa Kỳ|Anh|Pháp|Đức|Nga|Liên Xô|Trung Quốc|Trung Hoa|Nhật|Nhật Bản|Triều Tiên|Hàn Quốc|Lào|Campuchia|Thái Lan|Ấn Độ|Ý|Italia|" +
    "Tây Ban Nha|Bồ Đào Nha|Hà Lan|Bỉ|Thụy Sĩ|Thụy Điển|Na Uy|Đan Mạch|Phần Lan|Ba Lan|Áo|Hy Lạp|Thổ Nhĩ Kỳ|Ai Cập|Ba Tư|Iran|Iraq|Israel|" +
    "Do Thái|Ả Rập|Mexico|Canada|Brazil|Argentina|Úc|Châu Âu|Châu Á|Châu Phi|Châu Mỹ|Bắc Mỹ|Nam Mỹ|Đông Dương|Xiêm|Miến Điện|Mông Cổ|Tây Tạng|" +
    "Hungary|Tiệp Khắc|Séc|Romania|Bulgaria|Nam Tư|Ukraina|Ukraine|Siberia|Scotland|Ireland|Ái Nhĩ Lan|Libya|Algeria|Ma Rốc|Ethiopia|" +
    "America|England|Britain|France|Germany|Russia|China|Japan|Korea|India|Italy|Spain|Portugal|Holland|Poland|Austria|Greece|Egypt|Europe|Asia|Africa|" +
    // US states.
    "Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|" +
    "Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|" +
    "North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|" +
    "Virginia|Washington|West Virginia|Wisconsin|Wyoming|" +
    // Cities.
    "Hà Nội|Sài Gòn|Huế|Đà Nẵng|Hải Phòng|Nam Định|Chợ Lớn|Gia Định|Biên Hòa|Cần Thơ|Đà Lạt|Nha Trang|Thanh Hóa|Nghệ An|Hà Đông|Hà Tĩnh|" +
    "Bắc Kinh|Thượng Hải|Nam Kinh|Quảng Châu|Hồng Kông|Hương Cảng|Đài Loan|Trùng Khánh|Thiên Tân|Tây An|Lạc Dương|Hàng Châu|Tô Châu|Thành Đô|Vũ Hán|" +
    "Hà Nam|Hà Bắc|Sơn Đông|Sơn Tây|Tứ Xuyên|Vân Nam|Quảng Tây|Quảng Đông|Phúc Kiến|Hồ Nam|Hồ Bắc|Giang Tô|Chiết Giang|Thiểm Tây|Cam Túc|" +
    "Hoàng Hà|Trường Giang|Dương Tử|Hoa Hạ|Tokyo|Đông Kinh|Kyoto|Osaka|Seoul|Bình Nhưỡng|Moskva|Mát-xcơ-va|Mátxcơva|Petersburg|Petrograd|Leningrad|" +
    "Paris|London|Luân Đôn|Berlin|Roma|Rome|Vienna|Viên|Madrid|Lisbon|Amsterdam|Brussels|Geneva|Praha|Prague|Warsaw|Vác-sa-va|Budapest|Athens|" +
    "Istanbul|Constantinople|Cairo|Jerusalem|Mecca|Bombay|Calcutta|Delhi|Singapore|Bangkok|Manila|Jakarta|Sydney|Melbourne|" +
    "Chicago|Boston|Philadelphia|Los Angeles|San Francisco|Las Vegas|Hollywood|Manhattan|Brooklyn|Harlem|Detroit|Seattle|Miami|Atlanta|Dallas|Houston|" +
    "Oxford|Cambridge|Manchester|Liverpool|Edinburgh|Dublin|Marseille|Lyon|Normandy|Normandie|Bretagne|Provence|Munich|Hamburg|Frankfurt|Venice|Venezia|" +
    "Florence|Milan|Napoli|Naples|Sicily|Havana|Rio|Toronto|Montreal|Vancouver|Quebec",
);
/** Gods, holidays and the like: written with a capital, never a character to map. */
const NOT_PEOPLE = list(
  "Chúa|Chúa Trời|Đức Chúa|Đức Chúa Trời|Chúa Jesus|Chúa Giê-su|Chúa Giêsu|Giê-su|Giêsu|Jesus|Jesus Christ|Christ|Thượng Đế|Đấng|Đấng Tạo Hóa|" +
    "Đức Thánh Thần|Thánh Thần|Đức Mẹ|Đức Phật|Phật|Phật Tổ|Bồ Tát|Quan Âm|Ngọc Hoàng|Ông Trời|Trời|Allah|God|Lord|Heaven|Satan|Lucifer|" +
    "Tết|Giáng Sinh|Noel|Phục Sinh|Trung Thu|Christmas|Easter|Thanksgiving|" +
    "Thứ Hai|Thứ Ba|Thứ Tư|Thứ Năm|Thứ Sáu|Thứ Bảy|Chủ Nhật|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|" +
    "January|February|March|April|June|July|August|September|October|November|December|" +
    "Ford|Chevrolet|Dodge|Buick|Cadillac|Packard|Plymouth|Studebaker|Oldsmobile|Pontiac|Hudson|La Salle|Mercedes|Volkswagen|Coca-Cola|" +
    "Okies|Kinh Thánh|Bible|Phúc Âm|Koran",
);
const ORGS = list(
  "Gestapo|SS|Wehrmacht|Quốc Xã|Đức Quốc Xã|Nazi|KGB|NKVD|CIA|FBI|NATO|Liên Hợp Quốc|Hồng Quân|Hồng Vệ Binh|Quốc Dân Đảng|Cộng Sản|Hồng Thập Tự|Chữ Thập Đỏ|" +
    "Vatican|Quốc Hội|Bộ Chính Trị|Congress|Parliament|Senate|Scotland Yard|Hogwarts",
);

/**
 * Person, place, organisation or thing, from the name and the words around
 * it. A character is someone the book shows talking or acting, or calls by
 * a title; a name with none of that (a god, a brand, a famous name only
 * mentioned) is kept out of the people.
 */
export function classify(form: string, n: number, ev: Evidence): XrType {
  const low = form.toLowerCase();
  const person = (ev.title + ev.act) / n;
  const place = (ev.kind + ev.at) / n;
  if (NOT_PEOPLE.has(low) && person < 0.25) return "term";
  if (ORGS.has(low) || ev.head / n > 0.5) return "org";
  if (PLACES.has(low)) return person >= 0.25 ? "person" : "place";
  if (place >= 0.2 && place > person) return "place";
  // Few appearances say too little either way.
  if (person >= 0.03 || n < 15) return "person";
  return "term";
}

// ---- Entities -----------------------------------------------------------------

export interface Entity {
  key: string;
  name: string;
  type: XrType;
  forms: string[];
  mentions: Mention[];
  /** Is (or was merged with) the narrator of a first-person book. */
  narrator?: boolean;
  /** Is (or was merged with) someone the narrator calls by this kinship word. */
  kin?: string;
}

/**
 * Group forms into entities: the reader's merges, then a short form that
 * begins exactly one longer form joins it.
 */
export function entities(index: XrIndex, edits: XrEdits): Entity[] {
  const parent = new Map<string, string>();
  const find = (f: string): string => {
    let r = f;
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!;
    return r;
  };
  // Narrator and kin only when the book is told in the first person.
  const forms = isFirstPerson(index, edits) ? index.forms : index.forms.filter((f) => !f.role);
  const byForm = new Map(forms.map((f) => [f.form, f]));
  for (const f of forms) parent.set(f.form, f.form);

  // Automatic: "Ivan" → "Ivan Fyodorovich" when that is the only longer form starting so.
  const names = forms.filter((f) => f.type !== "term" && !f.role).map((f) => f.form);
  for (const short of names) {
    if (edits.merges[short] !== undefined) continue;
    const longer = names.filter((l) => l !== short && l.startsWith(short + " "));
    if (longer.length === 1) parent.set(short, longer[0]);
  }
  for (const [from, to] of Object.entries(edits.merges)) {
    if (byForm.has(from) && byForm.has(to) && from !== to) {
      // Never make a loop.
      if (find(to) !== from) parent.set(from, find(to));
    } else if (byForm.has(from) && from === to) parent.set(from, from); // explicit split
  }

  const groups = new Map<string, XrForm[]>();
  for (const f of forms) {
    if (edits.hidden.includes(f.form)) continue;
    const root = find(f.form);
    if (edits.hidden.includes(root)) continue;
    (groups.get(root) ?? groups.set(root, []).get(root)!).push(f);
  }
  const out: Entity[] = [];
  for (const [key, fs] of groups) {
    const mentions = fs.flatMap((f) => f.mentions).sort((a, b) => a[4] - b[4]);
    const byCount = [...fs].sort((a, b) => b.mentions.length - a.mentions.length);
    // A real name beats "Tôi (người kể)" / "Bố tôi" once they are merged.
    const most = byCount.find((f) => !f.role) ?? byCount[0];
    const kin = fs.find((f) => f.role === "kin")?.kin;
    out.push({
      key,
      name: edits.names[key] ?? most.form,
      type: edits.types[key] ?? byForm.get(key)?.type ?? most.type,
      forms: fs.map((f) => f.form),
      mentions,
      ...(fs.some((f) => f.role === "narrator") ? { narrator: true } : {}),
      ...(kin ? { kin } : {}),
    });
  }
  return out.sort((a, b) => b.mentions.length - a.mentions.length);
}

/** Mentions up to a reading fraction. */
export function upTo(e: Entity, limit: number): Mention[] {
  if (limit >= 1) return e.mentions;
  return e.mentions.filter((m) => m[4] <= limit + 1e-9);
}

export const pairKey = (a: string, b: string) => (a < b ? `${a}\u0001${b}` : `${b}\u0001${a}`);

export interface Link {
  a: string;
  b: string;
  key: string;
  /** Chunks where both appear. */
  chunks: number[];
}

/** Who appears with whom (in the same few paragraphs), up to `limit`. */
export function links(ents: Entity[], limit: number, minShared = 2): Link[] {
  const people = ents.filter((e) => e.type === "person");
  const sets = people.map((e) => new Set(upTo(e, limit).map((m) => m[3])));
  const out: Link[] = [];
  for (let i = 0; i < people.length; i++) {
    for (let j = i + 1; j < people.length; j++) {
      const shared: number[] = [];
      for (const c of sets[i]) if (sets[j].has(c)) shared.push(c);
      if (shared.length >= minShared) {
        out.push({ a: people[i].key, b: people[j].key, key: pairKey(people[i].key, people[j].key), chunks: shared.sort((x, y) => x - y) });
      }
    }
  }
  return out.sort((x, y) => y.chunks.length - x.chunks.length);
}

/** Text of some chunks (loads their sections). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function chunkTexts(view: any, index: XrIndex, ids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const bySec = new Map<number, number[]>();
  for (const id of ids) {
    const c = index.chunks[id];
    if (c) (bySec.get(c.sec) ?? bySec.set(c.sec, []).get(c.sec)!).push(id);
  }
  for (const [sec, list] of bySec) {
    try {
      const doc = await view.book.sections[sec].createDocument();
      const { text } = sectionText(doc);
      for (const id of list) {
        const c = index.chunks[id];
        out.set(id, text.slice(c.start, c.end).replace(/\s+/g, " ").trim());
      }
    } catch {
      /* section unavailable */
    }
  }
  return out;
}

const STOP = /[.!?…\n]/;
const CLOSERS = /[.!?…"”’»)\]]/;

/**
 * Where the sentence around `[start, end)` begins and ends in a section's
 * text, with `around` more sentences on each side (each at most ~400 chars).
 */
export function sentenceSpan(text: string, start: number, end: number, around = 0): [number, number] {
  let s = start;
  for (let k = 0; k <= around && s > 0; k++) {
    if (k > 0) while (s > 0 && (STOP.test(text[s - 1]) || /\s/.test(text[s - 1]))) s--;
    const floor = s - 400;
    while (s > 0 && !STOP.test(text[s - 1]) && s > floor) s--;
  }
  let e = end;
  for (let k = 0; k <= around && e < text.length; k++) {
    if (k > 0) while (e < text.length && (STOP.test(text[e]) || /\s/.test(text[e]))) e++;
    const ceil = e + 400;
    while (e < text.length && !STOP.test(text[e]) && e < ceil) e++;
    while (e < text.length && CLOSERS.test(text[e])) e++;
  }
  while (s < start && /\s/.test(text[s])) s++;
  return [s, Math.max(end, e)];
}

/** A mention with the sentences around it, the name apart (for the excerpt opened in place). */
export interface Passage {
  before: string;
  name: string;
  after: string;
  /** More text before / after than shown. */
  cutStart: boolean;
  cutEnd: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function mentionPassage(view: any, m: Mention, around = 2): Promise<Passage | null> {
  try {
    const { text } = sectionText(await view.book.sections[m[0]].createDocument());
    const [s, e] = sentenceSpan(text, m[1], m[1] + m[2], around);
    const tidy = (x: string) => x.replace(/[ \t\r\f\v]+/g, " ").replace(/\s*\n\s*/g, "\n");
    return {
      before: tidy(text.slice(s, m[1])).replace(/^\s+/, ""),
      name: text.slice(m[1], m[1] + m[2]),
      after: tidy(text.slice(m[1] + m[2], e)).replace(/\s+$/, ""),
      cutStart: s > 0,
      cutEnd: e < text.length,
    };
  } catch {
    return null;
  }
}

/** The sentence around a mention (for lists and the first-mention description). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function mentionContexts(view: any, ms: Mention[]): Promise<string[]> {
  const out: string[] = [];
  const cache = new Map<number, string>();
  for (const m of ms) {
    let text = cache.get(m[0]);
    if (text === undefined) {
      try {
        text = sectionText(await view.book.sections[m[0]].createDocument()).text;
      } catch {
        text = "";
      }
      cache.set(m[0], text);
    }
    let s = m[1];
    while (s > 0 && !/[.!?…\n]/.test(text[s - 1]) && m[1] - s < 160) s--;
    let e = m[1] + m[2];
    while (e < text.length && !/[.!?…\n]/.test(text[e]) && e - m[1] < 220) e++;
    out.push(((s > 0 && !/[.!?…\n]/.test(text[s - 1]) ? "…" : "") + text.slice(s, Math.min(text.length, e + 1))).replace(/\s+/g, " ").trim());
  }
  return out;
}
