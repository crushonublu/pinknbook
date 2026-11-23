import { MobilePicker } from "./mobile/MobilePicker";
import { isAndroid } from "./platform";
import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { STR, type Lang } from "./i18n";
import { Icon } from "./icons";
import { relativeTime } from "./bookInfo";
import { speak } from "./dictionary";

export interface VocabItem {
  id: number;
  word: string;
  lang: "vi" | "en" | string;
  gloss: string | null;
  asin: string | null;
  cfi: string | null;
  fraction: number | null;
  context: string | null;
  learned: boolean;
  created_at: string;
}

/** The context sentence with the word set in bold. */
function Context({ text, word }: { text: string; word: string }) {
  const i = text.toLowerCase().indexOf(word.toLowerCase());
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <b>{text.slice(i, i + word.length)}</b>
      {text.slice(i + word.length)}
    </>
  );
}

/** One saved word with its meaning, sentence and actions. */
function WordRow({
  lang,
  w,
  bookTitle,
  onGo,
  onChanged,
}: {
  lang: Lang;
  w: VocabItem;
  bookTitle?: string;
  onGo?: (w: VocabItem) => void;
  onChanged: () => void;
}) {
  const t = STR[lang];
  const setLearned = async () => {
    await invoke("vocab_set_learned", { id: w.id, learned: !w.learned }).catch(() => undefined);
    onChanged();
  };
  const remove = async () => {
    await invoke("vocab_remove", { id: w.id }).catch(() => undefined);
    onChanged();
  };
  return (
    <li className={`vword${w.learned ? " is-learned" : ""}`}>
      <div className="vword__main">
        <div className="vword__top">
          <span className="vword__word">{w.word}</span>
          <span className="vword__lang">{w.lang === "vi" ? "VI" : "EN"}</span>
        </div>
        {w.gloss && <div className="vword__gloss">{w.gloss}</div>}
        {w.context && (
          <div className="vword__ctx">
            <Context text={w.context} word={w.word} />
          </div>
        )}
        <div className="vword__meta">
          {bookTitle ? `${bookTitle} · ` : ""}
          {relativeTime(lang, w.created_at)}
        </div>
      </div>
      <div className="vword__tools">
        <button onClick={() => speak(w.word, w.lang === "vi" ? "vi" : "en")} aria-label={t.dcSpeak} title={t.dcSpeak}>
          <Icon name="speaker" size={15} />
        </button>
        {onGo && w.cfi && (
          <button onClick={() => onGo(w)} aria-label={t.vbOpenBook} title={t.vbOpenBook}>
            <Icon name="book" size={15} />
          </button>
        )}
        <button
          onClick={setLearned}
          className={w.learned ? "is-on" : undefined}
          aria-label={w.learned ? t.vbMarkLearning : t.vbMarkLearned}
          title={w.learned ? t.vbMarkLearning : t.vbMarkLearned}
        >
          <Icon name="checkRead" size={15} />
        </button>
        <button onClick={remove} aria-label={t.vbDelete} title={t.vbDelete}>
          <Icon name="trash" size={15} />
        </button>
      </div>
    </li>
  );
}

/** The reader's Words tab: words saved from this book. */
export function WordsPanel({
  lang,
  words,
  onGo,
  onChanged,
}: {
  lang: Lang;
  words: VocabItem[];
  onGo: (w: VocabItem) => void;
  onChanged: () => void;
}) {
  const t = STR[lang];
  if (!words.length) return <p className="rside__empty">{t.vbEmptyBook}</p>;
  return (
    <ul className="vlist vlist--side">
      {words.map((w) => (
        <WordRow key={w.id} lang={lang} w={w} onGo={onGo} onChanged={onChanged} />
      ))}
    </ul>
  );
}

/** The Word list page: every saved word, by book and language, learning or learned. */
export function VocabPage({
  lang,
  titles,
  onBack,
  onOpen,
}: {
  lang: Lang;
  /** Book titles by ASIN. */
  titles: Map<string, string>;
  onBack: () => void;
  onOpen: (asin: string, cfi: string) => void;
}) {
  const t = STR[lang];
  const [words, setWords] = useState<VocabItem[] | null>(null);
  const [book, setBook] = useState("all");
  const [wlang, setWlang] = useState("all");
  const [state, setState] = useState<"learning" | "learned">("learning");

  const load = () =>
    invoke<VocabItem[]>("vocab_list", { asin: null })
      .then(setWords)
      .catch(() => setWords([]));
  useEffect(() => {
    load();
  }, []);

  const books = useMemo(() => {
    const ids = [...new Set((words ?? []).map((w) => w.asin).filter(Boolean) as string[])];
    return ids.map((a) => ({ asin: a, title: titles.get(a) ?? a })).sort((a, b) => a.title.localeCompare(b.title));
  }, [words, titles]);

  const shown = (words ?? []).filter(
    (w) =>
      (book === "all" || w.asin === book) &&
      (wlang === "all" || w.lang === wlang) &&
      (state === "learned" ? w.learned : !w.learned),
  );
  const learnedCount = (words ?? []).filter((w) => w.learned).length;

  return (
    <div className="stats vocab">
      <header className="stats__head">
        <button className="reader__back stats__back" onClick={onBack}>
          <Icon name="arrowL" size={17} />
          <span>{t.vbBack}</span>
        </button>
        <h1>{t.vbTitle}</h1>
        {words && <span className="muted">{t.vbCount.replace("{0}", String(words.length))}</span>}
        <span className="editor__spacer" />
        <div className="seg" role="tablist">
          <button role="tab" aria-selected={state === "learning"} className={`seg__btn${state === "learning" ? " seg__btn--on" : ""}`} onClick={() => setState("learning")}>
            {t.vbLearning} <span className="vocab__n">{(words?.length ?? 0) - learnedCount}</span>
          </button>
          <button role="tab" aria-selected={state === "learned"} className={`seg__btn${state === "learned" ? " seg__btn--on" : ""}`} onClick={() => setState("learned")}>
            {t.vbLearned} <span className="vocab__n">{learnedCount}</span>
          </button>
        </div>
        {isAndroid ? <MobilePicker label={t.vbAllBooks} value={book} options={[{ value: "all", label: t.vbAllBooks }, ...books.map((b) => ({ value: b.asin, label: b.title }))]} onChange={setBook} /> : (<select className="select" value={book} onChange={(e) => setBook(e.target.value)} aria-label={t.vbAllBooks}>
          <option value="all">{t.vbAllBooks}</option>
          {books.map((b) => (
            <option key={b.asin} value={b.asin}>
              {b.title}
            </option>
          ))}
        </select>)}
        {isAndroid ? <MobilePicker label={t.vbAllLangs} value={wlang} options={[{ value: "all", label: t.vbAllLangs }, { value: "vi", label: t.vbLangVi }, { value: "en", label: t.vbLangEn }]} onChange={setWlang} /> : (<select className="select" value={wlang} onChange={(e) => setWlang(e.target.value)} aria-label={t.vbAllLangs}>
          <option value="all">{t.vbAllLangs}</option>
          <option value="vi">{t.vbLangVi}</option>
          <option value="en">{t.vbLangEn}</option>
        </select>)}
      </header>
      {words == null ? (
        <div className="center muted">{t.loading}</div>
      ) : shown.length ? (
        <ul className="vlist">
          {shown.map((w) => (
            <WordRow
              key={w.id}
              lang={lang}
              w={w}
              bookTitle={w.asin ? titles.get(w.asin) : undefined}
              onGo={w.asin && w.cfi ? () => onOpen(w.asin!, w.cfi!) : undefined}
              onChanged={load}
            />
          ))}
        </ul>
      ) : (
        <p className="vocab__empty muted">{t.vbEmpty}</p>
      )}
    </div>
  );
}
