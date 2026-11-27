//! One main genre per book, from a fixed set of groups.
//!
//! Goodreads lists a book's genres (most telling first) and Amazon gives
//! BISAC-like subjects (`Fiction / Romance / Contemporary`). Both are free
//! text, so every label is matched against a keyword table that maps it to
//! one of 17 groups. The result is cached in `book_genre`; the reader can
//! also pick a genre by hand, which is never recomputed.

use std::collections::HashMap;

use chrono::{Duration, NaiveDate};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::db::Db;

pub const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS book_genre (
    asin   TEXT PRIMARY KEY,
    genre  TEXT,                 -- NULL = no genre could be told
    source TEXT NOT NULL         -- 'auto' | 'user'
);
";

/// A genre group as the UI lists it.
#[derive(Debug, Clone, Serialize)]
pub struct GenreInfo {
    pub id: &'static str,
    pub vi: &'static str,
    pub en: &'static str,
    pub fiction: bool,
}

const fn g(id: &'static str, vi: &'static str, en: &'static str, fiction: bool) -> GenreInfo {
    GenreInfo { id, vi, en, fiction }
}

/// The fixed taxonomy: ten fiction groups, then seven non-fiction ones.
pub const GROUPS: [GenreInfo; 17] = [
    g("literary", "Văn học", "Literature", true),
    g("fantasy", "Kỳ ảo", "Fantasy", true),
    g("scifi", "Khoa học viễn tưởng", "Science Fiction", true),
    g("romance", "Lãng mạn", "Romance", true),
    g("mystery", "Trinh thám & Giật gân", "Mystery & Thriller", true),
    g("horror", "Kinh dị", "Horror", true),
    g("historical_fiction", "Tiểu thuyết lịch sử", "Historical Fiction", true),
    g("kids_ya", "Thiếu nhi & YA", "Children's & YA", true),
    g("comics", "Truyện tranh & Manga", "Comics & Manga", true),
    g("poetry_drama", "Thơ & Kịch", "Poetry & Drama", true),
    g("memoir", "Tiểu sử & Hồi ký", "Biography & Memoir", false),
    g("history", "Lịch sử", "History", false),
    g("science", "Khoa học & Công nghệ", "Science & Technology", false),
    g("self_help", "Tâm lý & Phát triển bản thân", "Psychology & Self-Help", false),
    g("business", "Kinh doanh & Kinh tế", "Business & Economics", false),
    g("philosophy", "Triết học & Tôn giáo", "Philosophy & Religion", false),
    g("nonfiction", "Phi hư cấu khác", "Other Nonfiction", false),
];

fn group_id(id: &str) -> Option<&'static str> {
    GROUPS.iter().find(|x| x.id == id).map(|x| x.id)
}

/// Labels that say nothing about the kind of book. Compared whole, after
/// `normalize`.
const GENERIC: &[&str] = &[
    "fiction", "nonfiction", "non fiction", "classics", "classic", "audiobook", "audiobooks", "audio",
    "literature", "novels", "novel", "novella", "novellas", "adult", "adult fiction", "book club",
    "books", "ebook", "ebooks", "kindle", "owned", "to read", "favorites", "general", "library", "series",
];

/// Keyword rules, tried in this order; the first rule with a keyword in the
/// label wins, so the order is the precedence ("Historical Fiction" and
/// "Science Fiction" come before "History" and "Science", "Romantasy" is
/// fantasy before romance, "True Crime" is not a mystery). A keyword matches
/// from a word start (`comic` also finds "comics"); `kw$` must also end at a
/// word end; `=kw` must be the whole label.
const RULES: &[(&str, &[&str])] = &[
    ("comics", &["manga", "manhwa", "manhua", "webtoon", "graphic novel", "comic", "sequential art"]),
    ("kids_ya", &["young adult", "ya$", "middle grade", "children", "juvenile", "picture book", "teen", "kids"]),
    ("historical_fiction", &["historical fiction", "=historical"]),
    (
        "scifi",
        &["science fiction", "sci fi", "scifi", "dystopia", "space opera", "cyberpunk", "post apocalyptic", "alternate history"],
    ),
    ("fantasy", &["fantasy", "romantasy", "fairy tale", "paranormal"]),
    ("horror", &["horror"]),
    ("nonfiction", &["true crime"]),
    ("mystery", &["mystery", "thriller", "crime", "suspense", "detective", "noir", "whodunit", "espionage", "spy$"]),
    ("romance", &["romance", "love story", "chick lit", "erotica", "new adult"]),
    ("poetry_drama", &["poetry", "poem", "plays$", "drama$", "theater", "theatre"]),
    ("memoir", &["biograph", "memoir", "autobiograph"]),
    ("history", &["history", "world war", "ancient", "military"]),
    ("nonfiction", &["political science", "social science", "politic"]),
    (
        "self_help",
        &["self help", "psycholog", "personal development", "self improvement", "personal growth", "productivity", "mental health", "motivation"],
    ),
    ("business", &["business", "economic", "finance", "money", "management", "leadership", "entrepreneur", "marketing", "investing"]),
    (
        "science",
        &[
            "science", "neuroscience", "technology", "physics", "biology", "chemistry", "mathematic", "math$", "astronomy",
            "computer", "nature$", "medicine", "medical", "engineering", "environment", "ecology", "programming",
            "artificial intelligence",
        ],
    ),
    (
        "philosophy",
        &["philosoph", "religio", "spiritual", "theology", "christianity$", "buddhis", "islam", "hindu", "bible", "occult", "stoic"],
    ),
    (
        "literary",
        &["literary", "contemporary", "magical realism", "short stories", "satire", "humor", "coming of age", "womens fiction", "literature"],
    ),
];

/// Lower case, every run of other characters one space: "Self-Help" and
/// "Children's" become "self help" and "children s".
fn normalize(label: &str) -> String {
    let mut out = String::new();
    for c in label.chars().flat_map(char::to_lowercase) {
        if c.is_alphanumeric() {
            out.push(c);
        } else if !out.is_empty() && !out.ends_with(' ') {
            out.push(' ');
        }
    }
    out.trim_end().to_string()
}

fn has_keyword(norm: &str, kw: &str) -> bool {
    let padded = format!(" {norm} ");
    if let Some(whole) = kw.strip_prefix('=') {
        padded == format!(" {whole} ")
    } else if let Some(word) = kw.strip_suffix('$') {
        padded.contains(&format!(" {word} "))
    } else {
        padded.contains(&format!(" {kw}"))
    }
}

/// The group a single label belongs to, if any.
fn match_label(norm: &str) -> Option<&'static str> {
    RULES.iter().find(|(_, kws)| kws.iter().any(|kw| has_keyword(norm, kw))).map(|(id, _)| *id)
}

/// First specific label's group; else, if a bare "Fiction" / "Nonfiction"
/// label comes first, literary / nonfiction.
fn classify<'a>(labels: impl Iterator<Item = &'a str>) -> Option<&'static str> {
    let mut weak = None;
    for label in labels {
        let norm = normalize(label);
        if norm.is_empty() {
            continue;
        }
        if GENERIC.contains(&norm.as_str()) {
            if weak.is_none() {
                weak = match norm.as_str() {
                    "fiction" => Some("literary"),
                    "nonfiction" | "non fiction" => Some("nonfiction"),
                    _ => None,
                };
            }
        } else if let Some(id) = match_label(&norm) {
            return Some(id);
        }
    }
    weak
}

/// The main genre of a book from its Goodreads genres (in the order
/// Goodreads gives them) and, failing that, its Amazon subjects (each may be
/// a `A / B / C` path). `None` when nothing tells.
pub fn primary_genre(goodreads_genres: &[String], amazon_subjects: &[String]) -> Option<&'static str> {
    classify(goodreads_genres.iter().map(String::as_str))
        .or_else(|| classify(amazon_subjects.iter().flat_map(|s| s.split('/'))))
}

// ---- Cache ----------------------------------------------------------------------

/// What `goodreads.details` holds that matters here.
#[derive(Deserialize)]
struct GrGenres {
    #[serde(default)]
    genres: Vec<String>,
}

/// Genres of the Goodreads match of a book, if it has one with details.
fn goodreads_genres(conn: &Connection, asin: &str) -> Vec<String> {
    conn.query_row("SELECT details FROM goodreads WHERE asin = ?1 AND book IS NOT NULL", [asin], |r| {
        r.get::<_, Option<String>>(0)
    })
    .ok()
    .flatten()
    .and_then(|json| serde_json::from_str::<GrGenres>(&json).ok())
    .map(|d| d.genres)
    .unwrap_or_default()
}

/// The genre of each book: the reader's own choice if there is one, else
/// worked out from the book's current Goodreads / Amazon data. Worked-out
/// values are written to `book_genre` (rewritten whenever they change, so a
/// new Goodreads match or details show up straight away); it is cheap since
/// only the books asked about are looked at.
///
/// `books` is (asin, Amazon subjects).
pub(crate) fn resolve(conn: &Connection, books: &[(&str, &[String])]) -> HashMap<String, Option<&'static str>> {
    let mut out = HashMap::new();
    for (asin, subjects) in books {
        let stored: Option<(Option<String>, String)> = conn
            .query_row("SELECT genre, source FROM book_genre WHERE asin = ?1", [asin], |r| Ok((r.get(0)?, r.get(1)?)))
            .ok();
        if let Some((Some(genre), source)) = &stored {
            if source == "user" {
                if let Some(id) = group_id(genre) {
                    out.insert(asin.to_string(), Some(id));
                    continue;
                }
            }
        }
        let auto = primary_genre(&goodreads_genres(conn, asin), subjects);
        let unchanged = matches!(&stored, Some((g, s)) if s == "auto" && g.as_deref() == auto);
        if !unchanged {
            let _ = conn.execute(
                "INSERT INTO book_genre (asin, genre, source) VALUES (?1, ?2, 'auto')
                 ON CONFLICT(asin) DO UPDATE SET genre = excluded.genre, source = 'auto'",
                rusqlite::params![asin, auto],
            );
        }
        out.insert(asin.to_string(), auto);
    }
    out
}

/// How many books one background fill looks up on Goodreads.
const FILL_PER_RUN: usize = 3;
/// A book read within this many days is worth a lookup.
const FILL_DAYS: i64 = 365;
/// Reading under this many seconds does not count as having read a book.
const FILL_MIN_SECONDS: i64 = 60;

/// Books that should be looked up on Goodreads to learn their genre, most
/// read first: read since `since`, no genre known (not chosen by the reader,
/// not told by the Amazon subjects) and nothing on Goodreads that could still
/// tell. Left out are books whose page details are cached, books Goodreads
/// does not know (within the retry time of `goodreads.rs`, or for good when
/// the reader said so) and books whose page was refused a moment ago, so the
/// few slots of a run go to books that can actually be answered.
pub(crate) fn fill_candidates(conn: &Connection, since: NaiveDate, limit: usize) -> Vec<String> {
    let Ok(mut st) = conn.prepare(
        "SELECT l.asin, IFNULL(m.subjects, '')
         FROM reading_log l
         JOIN book b ON b.asin = l.asin
         LEFT JOIN book_meta m ON m.asin = l.asin
         LEFT JOIN goodreads g ON g.asin = l.asin
         LEFT JOIN book_genre bg ON bg.asin = l.asin
         WHERE l.day >= ?1
           AND bg.genre IS NULL
           AND (g.asin IS NULL OR (
                g.details IS NULL
                AND NOT (g.book IS NULL AND (g.manual = 1 OR julianday('now') - julianday(g.matched_at) < ?2))
                AND NOT (g.book IS NOT NULL AND g.details_ok = 0
                         AND IFNULL((julianday('now') - julianday(g.details_at)) * 1440 < ?3, 0))))
         GROUP BY l.asin
         HAVING SUM(l.seconds) >= ?4
         ORDER BY SUM(l.seconds) DESC, l.asin",
    ) else {
        return vec![];
    };
    let rows = st.query_map(
        rusqlite::params![
            since.to_string(),
            crate::goodreads::NONE_TTL_DAYS,
            crate::goodreads::BLOCKED_RETRY_MINUTES,
            FILL_MIN_SECONDS
        ],
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
    );
    let Ok(rows) = rows else { return vec![] };
    rows.flatten()
        .filter(|(_, subjects)| {
            let subjects: Vec<String> = subjects.lines().map(str::to_string).collect();
            primary_genre(&[], &subjects).is_none()
        })
        .map(|(asin, _)| asin)
        .take(limit)
        .collect()
}

/// Look a few of the books without a genre up on Goodreads (match, then the
/// book page), through the same cached calls the book page uses, so the
/// cache times and the back-off after a refused page hold. Stops at the
/// first book Goodreads cannot be asked about (offline). Returns how many
/// books got page details, i.e. may have a genre now.
#[tauri::command]
pub async fn genre_fill(app: AppHandle) -> Result<i64, String> {
    use std::sync::atomic::{AtomicBool, Ordering};
    static RUNNING: AtomicBool = AtomicBool::new(false);
    if RUNNING.swap(true, Ordering::AcqRel) {
        return Ok(0);
    }
    let result = fill(&app).await;
    RUNNING.store(false, Ordering::Release);
    Ok(result)
}

async fn fill(app: &AppHandle) -> i64 {
    let since = crate::stats::today() - Duration::days(FILL_DAYS);
    let books = {
        let db: State<Db> = app.state();
        let conn = db.0.lock().unwrap();
        fill_candidates(&conn, since, FILL_PER_RUN)
    };
    let mut got = 0;
    for asin in books {
        let Ok(found) = crate::goodreads::goodreads_info(app.clone(), asin.clone(), false).await else { break };
        if found.status != "found" {
            continue;
        }
        match crate::goodreads::goodreads_details(app.clone(), asin, false).await {
            Ok(s) if s.details.is_some() && s.details_status == "ok" => got += 1,
            Ok(_) => {}
            Err(_) => break,
        }
    }
    got
}

/// The genre groups, with their Vietnamese and English names.
#[tauri::command]
pub fn genre_list() -> Vec<GenreInfo> {
    GROUPS.to_vec()
}

/// Pick a book's genre by hand (`Some(id)`), or go back to the automatic one
/// (`None`).
#[tauri::command]
pub fn set_book_genre(db: State<Db>, asin: String, genre: Option<String>) -> Result<(), String> {
    let conn = db.0.lock().unwrap();
    match genre {
        Some(id) => {
            let id = group_id(&id).ok_or_else(|| format!("unknown genre: {id}"))?;
            conn.execute(
                "INSERT INTO book_genre (asin, genre, source) VALUES (?1, ?2, 'user')
                 ON CONFLICT(asin) DO UPDATE SET genre = excluded.genre, source = 'user'",
                rusqlite::params![asin, id],
            )
        }
        None => conn.execute("DELETE FROM book_genre WHERE asin = ?1", [&asin]),
    }
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// A book's genre as the book page shows it.
#[derive(Debug, Serialize)]
pub struct BookGenre {
    /// A `GenreInfo.id`; `None` when no genre could be told.
    pub genre: Option<&'static str>,
    /// Chosen by the reader, not worked out.
    pub user: bool,
}

/// The genre of one book, worked out now if the reader has not chosen one.
#[tauri::command]
pub fn book_genre(db: State<Db>, asin: String) -> Result<BookGenre, String> {
    let subjects: Vec<String> = {
        let conn = db.0.lock().unwrap();
        conn.query_row("SELECT IFNULL(subjects, '') FROM book_meta WHERE asin = ?1", [&asin], |r| r.get::<_, String>(0))
            .map(|s| s.lines().map(str::to_string).collect())
            .unwrap_or_default()
    };
    let conn = db.0.lock().unwrap();
    let genre = resolve(&conn, &[(asin.as_str(), &subjects[..])]).remove(&asin).flatten();
    let user = conn
        .query_row("SELECT source FROM book_genre WHERE asin = ?1", [&asin], |r| r.get::<_, String>(0))
        .is_ok_and(|s| s == "user");
    Ok(BookGenre { genre, user })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gr(labels: &[&str]) -> Option<&'static str> {
        let v: Vec<String> = labels.iter().map(|s| s.to_string()).collect();
        primary_genre(&v, &[])
    }

    fn amazon(subjects: &[&str]) -> Option<&'static str> {
        let v: Vec<String> = subjects.iter().map(|s| s.to_string()).collect();
        primary_genre(&[], &v)
    }

    #[test]
    fn taxonomy_is_17_unique_groups() {
        let ids: std::collections::HashSet<_> = GROUPS.iter().map(|x| x.id).collect();
        assert_eq!(ids.len(), 17);
        assert_eq!(GROUPS.iter().filter(|x| x.fiction).count(), 10);
        // Every rule points at a real group.
        assert!(RULES.iter().all(|(id, _)| group_id(id).is_some()));
    }

    #[test]
    fn fiction_groups() {
        assert_eq!(gr(&["Fiction", "Contemporary", "Literary Fiction"]), Some("literary"));
        assert_eq!(gr(&["Fiction", "Magical Realism", "Latin American"]), Some("literary"));
        assert_eq!(gr(&["Fantasy", "Fiction", "Young Adult"]), Some("fantasy"));
        assert_eq!(gr(&["High Fantasy", "Fantasy", "Adventure"]), Some("fantasy"));
        assert_eq!(gr(&["Urban Fantasy", "Paranormal", "Fiction"]), Some("fantasy"));
        assert_eq!(gr(&["Science Fiction", "Fiction", "Classics"]), Some("scifi"));
        assert_eq!(gr(&["Dystopia", "Science Fiction", "Young Adult"]), Some("scifi"));
        assert_eq!(gr(&["Space Opera", "Science Fiction"]), Some("scifi"));
        assert_eq!(gr(&["Romance", "Contemporary", "Fiction"]), Some("romance"));
        assert_eq!(gr(&["Contemporary Romance", "Romance"]), Some("romance"));
        assert_eq!(gr(&["Thriller", "Mystery", "Fiction"]), Some("mystery"));
        assert_eq!(gr(&["Crime", "Mystery", "Detective"]), Some("mystery"));
        assert_eq!(gr(&["Suspense", "Fiction", "Audiobook"]), Some("mystery"));
        assert_eq!(gr(&["Horror", "Fiction", "Classics"]), Some("horror"));
        assert_eq!(gr(&["Horror", "Thriller", "Gothic"]), Some("horror"));
        assert_eq!(gr(&["Historical Fiction", "Fiction", "War"]), Some("historical_fiction"));
        assert_eq!(gr(&["Historical", "Fiction", "Romance"]), Some("historical_fiction"));
        assert_eq!(gr(&["Young Adult", "Fantasy", "Fiction"]), Some("kids_ya"));
        assert_eq!(gr(&["Childrens", "Picture Books", "Classics"]), Some("kids_ya"));
        assert_eq!(gr(&["Middle Grade", "Adventure", "Fiction"]), Some("kids_ya"));
        assert_eq!(gr(&["Graphic Novels", "Comics", "Fantasy"]), Some("comics"));
        assert_eq!(gr(&["Manga", "Sequential Art", "Fantasy"]), Some("comics"));
        assert_eq!(gr(&["Poetry", "Fiction", "Classics"]), Some("poetry_drama"));
        assert_eq!(gr(&["Plays", "Drama", "Classics"]), Some("poetry_drama"));
    }

    #[test]
    fn nonfiction_groups() {
        assert_eq!(gr(&["Biography", "Nonfiction", "History"]), Some("memoir"));
        assert_eq!(gr(&["Memoir", "Autobiography", "Nonfiction"]), Some("memoir"));
        assert_eq!(gr(&["History", "Nonfiction", "Military History"]), Some("history"));
        assert_eq!(gr(&["Nonfiction", "World War II", "History"]), Some("history"));
        assert_eq!(gr(&["Science", "Nonfiction", "Popular Science"]), Some("science"));
        assert_eq!(gr(&["Technology", "Computer Science", "Nonfiction"]), Some("science"));
        assert_eq!(gr(&["Physics", "Science", "Nonfiction"]), Some("science"));
        assert_eq!(gr(&["Self Help", "Nonfiction", "Psychology"]), Some("self_help"));
        assert_eq!(gr(&["Personal Development", "Productivity", "Business"]), Some("self_help"));
        assert_eq!(gr(&["Business", "Economics", "Nonfiction"]), Some("business"));
        assert_eq!(gr(&["Finance", "Money", "Personal Finance"]), Some("business"));
        assert_eq!(gr(&["Philosophy", "Nonfiction", "Classics"]), Some("philosophy"));
        assert_eq!(gr(&["Religion", "Spirituality", "Nonfiction"]), Some("philosophy"));
        assert_eq!(gr(&["True Crime", "Nonfiction", "Crime"]), Some("nonfiction"));
        assert_eq!(gr(&["Nonfiction", "Cooking"]), Some("nonfiction"));
        assert_eq!(gr(&["Political Science", "Nonfiction"]), Some("nonfiction"));
    }

    #[test]
    fn precedence() {
        // "Historical Fiction" is not "History"; "Science Fiction" not "Science".
        assert_eq!(gr(&["Historical Fiction"]), Some("historical_fiction"));
        assert_eq!(gr(&["History"]), Some("history"));
        assert_eq!(gr(&["Science Fiction"]), Some("scifi"));
        assert_eq!(gr(&["Science Fiction & Fantasy"]), Some("scifi"));
        assert_eq!(gr(&["Science"]), Some("science"));
        // Romantasy is fantasy, not romance.
        assert_eq!(gr(&["Romantasy", "Fantasy", "Romance"]), Some("fantasy"));
        assert_eq!(gr(&["Fantasy Romance"]), Some("fantasy"));
        assert_eq!(gr(&["Historical Romance"]), Some("romance"));
        // The first specific label decides, generic ones are skipped.
        assert_eq!(gr(&["Fiction", "Classics", "Audiobook", "Horror", "Romance"]), Some("horror"));
        assert_eq!(gr(&["Adult", "Book Club", "Young Adult"]), Some("kids_ya"));
        // Case and punctuation do not matter.
        assert_eq!(gr(&["SELF-HELP"]), Some("self_help"));
        assert_eq!(gr(&["Children's Books"]), Some("kids_ya"));
        // A word is matched from its start only ("Spy" is not in "Spyware").
        assert_eq!(gr(&["Spyware"]), None);
    }

    #[test]
    fn weak_fallbacks_and_unknown() {
        assert_eq!(gr(&["Fiction", "Classics", "Novels"]), Some("literary"));
        assert_eq!(gr(&["Nonfiction", "Audiobook"]), Some("nonfiction"));
        assert_eq!(gr(&["Audiobook", "Owned"]), None);
        assert_eq!(gr(&[]), None);
        assert_eq!(primary_genre(&[], &[]), None);
    }

    #[test]
    fn amazon_subjects_are_the_fallback() {
        assert_eq!(amazon(&["Fiction / Romance / Contemporary"]), Some("romance"));
        assert_eq!(amazon(&["Biography & Autobiography / Political"]), Some("memoir"));
        assert_eq!(amazon(&["Juvenile Fiction / Fantasy & Magic"]), Some("kids_ya"));
        assert_eq!(amazon(&["Business & Economics / Leadership"]), Some("business"));
        assert_eq!(amazon(&["Computers / Programming / General"]), Some("science"));
        assert_eq!(amazon(&["Fiction / General"]), Some("literary"));
        assert_eq!(amazon(&["Cooking / Methods"]), None);
        // Goodreads wins when it has a say.
        let v = |s: &[&str]| s.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        assert_eq!(primary_genre(&v(&["Horror"]), &v(&["Fiction / Romance"])), Some("horror"));
        assert_eq!(primary_genre(&v(&["Audiobook"]), &v(&["Fiction / Romance"])), Some("romance"));
    }

    #[test]
    fn cache_follows_data_and_respects_the_users_choice() {
        let t = crate::stats::testing::TempDb::new("genre");
        let conn = t.db().0.lock().unwrap();
        let none: Vec<String> = vec![];
        let r = resolve(&conn, &[("A", &none)]);
        assert_eq!(r["A"], None);
        // A Goodreads match with details appears on the next call.
        conn.execute(
            "INSERT INTO goodreads (asin, book, matched_at, details) VALUES ('A', '{}', datetime('now'), ?1)",
            [r#"{"genres":["Fantasy","Fiction"],"rating":4.1}"#],
        )
        .unwrap();
        assert_eq!(resolve(&conn, &[("A", &none)])["A"], Some("fantasy"));
        let stored: (Option<String>, String) = conn
            .query_row("SELECT genre, source FROM book_genre WHERE asin = 'A'", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!(stored, (Some("fantasy".into()), "auto".into()));
        // A user's choice sticks even when the data changes ...
        conn.execute("UPDATE book_genre SET genre = 'horror', source = 'user' WHERE asin = 'A'", []).unwrap();
        assert_eq!(resolve(&conn, &[("A", &none)])["A"], Some("horror"));
        // ... until it is cleared.
        conn.execute("DELETE FROM book_genre WHERE asin = 'A'", []).unwrap();
        assert_eq!(resolve(&conn, &[("A", &none)])["A"], Some("fantasy"));
        // A Goodreads row without a match is ignored.
        conn.execute("UPDATE goodreads SET book = NULL WHERE asin = 'A'", []).unwrap();
        assert_eq!(resolve(&conn, &[("A", &none)])["A"], None);
    }

    #[test]
    fn background_fill_picks_books_that_a_lookup_can_help() {
        use crate::stats::testing::d;
        let t = crate::stats::testing::TempDb::new("genre-fill");
        let sql = |q: &str| t.db().0.lock().unwrap().execute(q, []).unwrap();
        for a in ["A", "B", "C", "D", "E", "F", "G", "H", "I", "OLD", "BRIEF"] {
            t.add_book(a, a);
            t.log("2026-11-10", a, "app", "h20", 600);
        }
        t.log("2026-11-11", "B", "app", "h20", 600); // B is the most read, A next
        t.log("2026-11-12", "A", "app", "h20", 100);
        // Read long ago, and read for a few seconds only.
        t.log("2024-01-10", "OLD", "app", "h20", 600);
        sql("DELETE FROM reading_log WHERE asin = 'OLD' AND day > '2025-01-01'");
        sql("UPDATE reading_log SET seconds = 20 WHERE asin = 'BRIEF'");
        let pick = |limit| fill_candidates(&t.db().0.lock().unwrap(), d("2025-11-27"), limit);
        let all = ["B", "A", "C", "D", "E", "F", "G", "H", "I"];
        assert_eq!(pick(20), all);
        // Only as many as asked for, the most read first.
        assert_eq!(pick(3), ["B", "A", "C"]);

        // C: details already cached. D: the reader chose a genre. E: Amazon's subjects tell.
        sql("INSERT INTO goodreads (asin, book, matched_at, details, details_ok) VALUES ('C', '{}', datetime('now'), '{\"genres\":[]}', 1)");
        sql("INSERT INTO book_genre (asin, genre, source) VALUES ('D', 'horror', 'user')");
        sql("INSERT INTO book_meta (asin, subjects) VALUES ('E', 'Fiction / Romance / Contemporary')");
        // F: not on Goodreads a day ago (retry after a week). G: same, a month ago.
        sql("INSERT INTO goodreads (asin, book, matched_at) VALUES ('F', NULL, datetime('now', '-1 day'))");
        sql("INSERT INTO goodreads (asin, book, matched_at) VALUES ('G', NULL, datetime('now', '-30 day'))");
        // H: page refused 5 minutes ago (back off), I: refused 3 hours ago, A: matched, page never fetched.
        sql("INSERT INTO goodreads (asin, book, matched_at, details_at, details_ok) VALUES ('H', '{}', datetime('now'), datetime('now', '-5 minutes'), 0)");
        sql("INSERT INTO goodreads (asin, book, matched_at, details_at, details_ok) VALUES ('I', '{}', datetime('now'), datetime('now', '-3 hours'), 0)");
        sql("INSERT INTO goodreads (asin, book, matched_at) VALUES ('A', '{}', datetime('now'))");
        assert_eq!(pick(20), ["B", "A", "G", "I"]);
        // A book the reader said is not on Goodreads is never asked again.
        sql("UPDATE goodreads SET manual = 1 WHERE asin = 'G'");
        assert_eq!(pick(20), ["B", "A", "I"]);
    }
}
