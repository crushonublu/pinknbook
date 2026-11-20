//! Goodreads info for a book's page. Goodreads has had no public API since
//! 2020, so:
//! - matching uses the site's search-suggestion JSON (`/book/auto_complete`):
//!   first with the ISBN / ASIN (exact), then the title (+ author), scored
//!   against our title and author;
//! - genres, the full description, the rating breakdown and a few top reviews
//!   come from the public book page's embedded Next.js data. That page sits
//!   behind an anti-bot challenge (AWS WAF answers `202` +
//!   `x-amzn-waf-action`). A challenge just means "not available right now":
//!   we never try to get past it, and the UI links to Goodreads instead.
//!
//! Everything is cached in the `goodreads` table, so a book costs a handful of
//! requests the first time it is opened and none after that.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager, State};
use unicode_normalization::char::is_combining_mark;
use unicode_normalization::UnicodeNormalization;

use crate::db::Db;
use crate::meta;

const BASE: &str = "https://www.goodreads.com";
/// Re-match (and refresh the rating) after this many days.
const FOUND_TTL_DAYS: f64 = 30.0;
/// Try again for a book Goodreads did not know after this many days.
const NONE_TTL_DAYS: f64 = 7.0;
/// Refresh genres / reviews after this many days.
const DETAILS_TTL_DAYS: f64 = 30.0;
/// After a blocked book page, wait this long before trying on our own again.
const BLOCKED_RETRY_MINUTES: f64 = 60.0;
const MAX_REVIEWS: usize = 5;
const REVIEW_CHARS: usize = 700;

pub const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS goodreads (
    asin       TEXT PRIMARY KEY,
    book       TEXT,                       -- JSON GrBook; NULL = not on Goodreads
    manual     INTEGER NOT NULL DEFAULT 0, -- the user picked the match
    matched_at TEXT NOT NULL,
    details    TEXT,                       -- JSON GrDetails (from the book page)
    details_at TEXT,                       -- last attempt at the book page
    details_ok INTEGER NOT NULL DEFAULT 0  -- that attempt succeeded
);
CREATE TABLE IF NOT EXISTS gr_translation (
    source TEXT NOT NULL,      -- original text
    target TEXT NOT NULL,      -- 'vi' | 'en'
    text   TEXT NOT NULL,      -- translation
    lang   TEXT,               -- detected language of the original
    PRIMARY KEY (source, target)
);
";

/// One Goodreads book, as the search suggestions describe it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GrBook {
    pub book_id: String,
    /// Title without the "(Series, #1)" suffix.
    pub title: String,
    pub author: String,
    pub rating: Option<f64>,
    pub ratings_count: i64,
    pub pages: Option<i64>,
    /// Short (truncated) blurb.
    pub description: Option<String>,
    pub series: Option<String>,
    pub series_pos: Option<String>,
    pub url: String,
    pub image_url: Option<String>,
}

/// What only the book page has.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct GrDetails {
    pub description: Option<String>,
    pub genres: Vec<String>,
    /// First publication, ms since the epoch (may be negative).
    pub published: Option<i64>,
    pub rating: Option<f64>,
    pub ratings_count: Option<i64>,
    /// Number of 1★ … 5★ ratings.
    pub rating_dist: Vec<i64>,
    pub reviews_count: Option<i64>,
    pub reviews: Vec<GrReview>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GrReview {
    pub name: String,
    pub avatar: Option<String>,
    pub profile_url: Option<String>,
    pub rating: Option<i64>,
    pub text: String,
    pub likes: i64,
    /// ms since the epoch.
    pub created: Option<i64>,
}

/// What the book page shows.
#[derive(Debug, Clone, Serialize)]
pub struct GrState {
    /// "found" | "none"
    pub status: &'static str,
    pub book: Option<GrBook>,
    pub manual: bool,
    pub details: Option<GrDetails>,
    /// "ok" | "blocked" (the page was unavailable recently) | "pending"
    /// (never fetched or stale: call `goodreads_details`) | "none".
    pub details_status: &'static str,
}

struct Cached {
    book: Option<GrBook>,
    manual: bool,
    match_age_days: f64,
    details: Option<GrDetails>,
    details_age_min: Option<f64>,
    details_ok: bool,
}

impl Cached {
    fn state(&self) -> GrState {
        let details_status = match (&self.book, self.details_age_min) {
            (None, _) => "none",
            (Some(_), Some(m)) if self.details_ok && m < DETAILS_TTL_DAYS * 1440.0 => "ok",
            (Some(_), Some(m)) if !self.details_ok && m < BLOCKED_RETRY_MINUTES => "blocked",
            _ => "pending",
        };
        GrState {
            status: if self.book.is_some() { "found" } else { "none" },
            book: self.book.clone(),
            manual: self.manual,
            details: self.details.clone(),
            details_status,
        }
    }

    fn match_fresh(&self) -> bool {
        let ttl = if self.book.is_some() { FOUND_TTL_DAYS } else { NONE_TTL_DAYS };
        self.match_age_days < ttl
    }
}

// ---------------------------------------------------------------- cache

fn load(db: &Db, asin: &str) -> Option<Cached> {
    let conn = db.0.lock().unwrap();
    conn.query_row(
        "SELECT book, manual, julianday('now') - julianday(matched_at),
                details, (julianday('now') - julianday(details_at)) * 1440, details_ok
         FROM goodreads WHERE asin = ?1",
        [asin],
        |r| {
            let book: Option<String> = r.get(0)?;
            let details: Option<String> = r.get(3)?;
            Ok(Cached {
                book: book.and_then(|s| serde_json::from_str(&s).ok()),
                manual: r.get::<_, i64>(1)? != 0,
                match_age_days: r.get::<_, Option<f64>>(2)?.unwrap_or(f64::MAX),
                details: details.and_then(|s| serde_json::from_str(&s).ok()),
                details_age_min: r.get(4)?,
                details_ok: r.get::<_, i64>(5)? != 0,
            })
        },
    )
    .ok()
}

/// Store a match. A different Goodreads book drops the old page details.
fn save_match(db: &Db, asin: &str, book: Option<&GrBook>, manual: bool) -> Result<(), String> {
    let json = book.map(|b| serde_json::to_string(b).unwrap_or_default());
    let conn = db.0.lock().unwrap();
    conn.execute(
        "INSERT INTO goodreads (asin, book, manual, matched_at) VALUES (?1, ?2, ?3, datetime('now'))
         ON CONFLICT(asin) DO UPDATE SET
           details    = CASE WHEN json_extract(goodreads.book, '$.book_id') IS json_extract(excluded.book, '$.book_id')
                             THEN goodreads.details ELSE NULL END,
           details_at = CASE WHEN json_extract(goodreads.book, '$.book_id') IS json_extract(excluded.book, '$.book_id')
                             THEN goodreads.details_at ELSE NULL END,
           details_ok = CASE WHEN json_extract(goodreads.book, '$.book_id') IS json_extract(excluded.book, '$.book_id')
                             THEN goodreads.details_ok ELSE 0 END,
           book = excluded.book, manual = excluded.manual, matched_at = excluded.matched_at",
        rusqlite::params![asin, json, manual as i64],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Record a book-page attempt: new details on success, the old ones kept otherwise.
fn save_details(db: &Db, asin: &str, details: Option<&GrDetails>) -> Result<(), String> {
    let conn = db.0.lock().unwrap();
    match details {
        Some(d) => conn.execute(
            "UPDATE goodreads SET details = ?2, details_at = datetime('now'), details_ok = 1 WHERE asin = ?1",
            rusqlite::params![asin, serde_json::to_string(d).unwrap_or_default()],
        ),
        None => conn.execute(
            "UPDATE goodreads SET details_at = datetime('now'), details_ok = 0 WHERE asin = ?1",
            [asin],
        ),
    }
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------- network

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(concat!("pntome/", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())
}

/// Goodreads' bot challenge: `202` with `x-amzn-waf-action`, empty body.
fn is_challenge(resp: &reqwest::Response) -> bool {
    resp.status() == reqwest::StatusCode::ACCEPTED || resp.headers().contains_key("x-amzn-waf-action")
}

/// Search suggestions (at most ~5–10 books).
async fn suggest(client: &reqwest::Client, q: &str) -> Result<Vec<GrBook>, String> {
    let url = reqwest::Url::parse_with_params(&format!("{BASE}/book/auto_complete"), &[("format", "json"), ("q", q)])
        .map_err(|e| e.to_string())?;
    let resp = client.get(url).send().await.map_err(|e| e.to_string())?;
    if is_challenge(&resp) {
        return Err("Goodreads is not answering right now".into());
    }
    if !resp.status().is_success() {
        return Err(format!("Goodreads: HTTP {}", resp.status()));
    }
    let v: Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(v.as_array().map(|a| a.iter().filter_map(parse_suggestion).collect()).unwrap_or_default())
}

fn parse_suggestion(v: &Value) -> Option<GrBook> {
    let book_id = match &v["bookId"] {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        _ => return None,
    };
    let full = v["title"].as_str()?.trim();
    let (title, series, series_pos) = split_series(full);
    let url = v["bookUrl"].as_str().map(|u| u.split('?').next().unwrap_or(u).to_string())
        .map(|u| if u.starts_with("http") { u } else { format!("{BASE}{u}") })
        .unwrap_or_else(|| format!("{BASE}/book/show/{book_id}"));
    let rating = match &v["avgRating"] {
        Value::String(s) => s.parse().ok(),
        Value::Number(n) => n.as_f64(),
        _ => None,
    }
    .filter(|r: &f64| *r > 0.0);
    let description = v["description"]["html"]
        .as_str()
        .map(meta::strip_html)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    Some(GrBook {
        book_id,
        title: meta::unescape_html(&title),
        author: v["author"]["name"].as_str().unwrap_or("").trim().to_string(),
        rating,
        ratings_count: v["ratingsCount"].as_i64().unwrap_or(0),
        pages: v["numPages"].as_i64().filter(|p| *p > 0),
        description,
        series,
        series_pos,
        url,
        image_url: v["imageUrl"].as_str().filter(|u| !u.contains("nophoto")).map(String::from),
    })
}

/// "Dune (Dune, #1)" → ("Dune", Some("Dune"), Some("1")).
fn split_series(full: &str) -> (String, Option<String>, Option<String>) {
    if let (Some(open), true) = (full.rfind('('), full.ends_with(')')) {
        let inner = &full[open + 1..full.len() - 1];
        if let Some(hash) = inner.rfind('#') {
            let name = inner[..hash].trim().trim_end_matches(',').trim();
            let pos = inner[hash + 1..].trim();
            if !name.is_empty() {
                return (
                    full[..open].trim().to_string(),
                    Some(name.to_string()),
                    (!pos.is_empty()).then(|| pos.to_string()),
                );
            }
        }
    }
    (full.to_string(), None, None)
}

/// The book page's embedded data, or `None` when it is challenged / missing.
async fn fetch_page(client: &reqwest::Client, book_id: &str) -> Result<Option<GrDetails>, String> {
    let resp = client
        .get(format!("{BASE}/book/show/{book_id}"))
        .header(reqwest::header::ACCEPT, "text/html")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if is_challenge(&resp) || !resp.status().is_success() {
        return Ok(None);
    }
    let html = resp.text().await.map_err(|e| e.to_string())?;
    Ok(parse_page(&html))
}

fn parse_page(html: &str) -> Option<GrDetails> {
    const TAG: &str = r#"<script id="__NEXT_DATA__" type="application/json">"#;
    let start = html.find(TAG)? + TAG.len();
    let end = start + html[start..].find("</script>")?;
    let data: Value = serde_json::from_str(&html[start..end]).ok()?;
    let state = &data["props"]["pageProps"]["apolloState"];
    let root = state["ROOT_QUERY"].as_object()?;
    let deref = |v: &Value| -> Value {
        v["__ref"].as_str().and_then(|r| state.get(r)).cloned().unwrap_or(Value::Null)
    };
    let root_field = |prefix: &str| root.iter().find(|(k, _)| k.starts_with(prefix)).map(|(_, v)| v.clone());

    let book = deref(&root_field("getBookByLegacyId")?);
    if book.is_null() {
        return None;
    }
    let work = deref(&book["work"]);
    let stats = &work["stats"];

    let description = book["description"]
        .as_str()
        .map(meta::strip_html)
        .filter(|s| !s.trim().is_empty());
    let genres = book["bookGenres"]
        .as_array()
        .map(|a| a.iter().filter_map(|g| g["genre"]["name"].as_str().map(String::from)).collect())
        .unwrap_or_default();
    let published = work["details"]["publicationTime"]
        .as_i64()
        .or_else(|| book["details"]["publicationTime"].as_i64());

    let reviews = root_field("getReviews")
        .and_then(|r| r["edges"].as_array().cloned())
        .unwrap_or_default()
        .iter()
        .map(|e| deref(&e["node"]))
        .filter(|r| !r.is_null() && r["spoilerStatus"].as_bool() != Some(true))
        .filter_map(|r| {
            let text = clip(&meta::strip_html(r["text"].as_str()?), REVIEW_CHARS);
            if text.is_empty() {
                return None;
            }
            let user = deref(&r["creator"]);
            Some(GrReview {
                name: user["name"].as_str().unwrap_or("Goodreads").to_string(),
                avatar: user["imageUrlSquare"].as_str().filter(|s| s.starts_with("http")).map(String::from),
                profile_url: user["webUrl"].as_str().filter(|s| s.starts_with("http")).map(String::from),
                rating: r["rating"].as_i64().filter(|n| *n > 0),
                text,
                likes: r["likeCount"].as_i64().unwrap_or(0),
                created: r["createdAt"].as_f64().map(|t| t as i64),
            })
        })
        .take(MAX_REVIEWS)
        .collect();

    Some(GrDetails {
        description,
        genres,
        published,
        rating: stats["averageRating"].as_f64().filter(|r| *r > 0.0),
        ratings_count: stats["ratingsCount"].as_i64(),
        rating_dist: stats["ratingsCountDist"]
            .as_array()
            .map(|a| a.iter().map(|n| n.as_i64().unwrap_or(0)).collect())
            .unwrap_or_default(),
        reviews_count: stats["textReviewsCount"].as_i64(),
        reviews,
    })
}

/// At most `max` characters, cut at a word and marked with "…".
fn clip(s: &str, max: usize) -> String {
    let s = s.trim();
    if s.chars().count() <= max {
        return s.to_string();
    }
    let cut: String = s.chars().take(max).collect();
    let cut = cut.rfind(char::is_whitespace).map(|i| &cut[..i]).unwrap_or(&cut);
    format!("{}…", cut.trim_end_matches(|c: char| c.is_whitespace() || c.is_ascii_punctuation()))
}

// ---------------------------------------------------------------- matching

/// Lower-case words without diacritics ("Nhà Giả Kim" → ["nha", "gia", "kim"]).
fn words(s: &str) -> Vec<String> {
    let folded: String = s
        .nfd()
        .filter(|c| !is_combining_mark(*c))
        .map(|c| match c {
            'đ' | 'Đ' => 'd',
            c => c,
        })
        .collect::<String>()
        .to_lowercase();
    folded
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(String::from)
        .collect()
}

fn dice(a: &[String], b: &[String]) -> f64 {
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let common = a.iter().filter(|w| b.contains(w)).count();
    (2.0 * common as f64 / (a.len() + b.len()) as f64).min(1.0)
}

/// How alike two titles are (0…1), also comparing the part before a subtitle.
fn title_score(ours: &str, theirs: &str) -> f64 {
    let main = |s: &str| s.split([':', '–', '—']).next().unwrap_or(s).to_string();
    dice(&words(ours), &words(theirs))
        .max(dice(&words(&main(ours)), &words(&main(theirs))))
}

/// 1 when the authors share a surname-sized word, 0 when not, `None` if we
/// have no author to compare.
fn author_score(ours: &str, theirs: &str) -> Option<f64> {
    let ours: Vec<String> = words(ours).into_iter().filter(|w| w.len() >= 3).collect();
    if ours.is_empty() || ours.iter().all(|w| w == "unknown" || w == "khong") {
        return None;
    }
    let theirs = words(theirs);
    Some(if ours.iter().any(|w| theirs.contains(w)) { 1.0 } else { 0.0 })
}

/// Is `b` our book? Exact-identifier searches need only a loose check.
fn score(title: &str, author: &str, b: &GrBook, by_id: bool) -> Option<f64> {
    let t = title_score(title, &b.title);
    let a = author_score(author, &b.author);
    let ok = if by_id {
        t >= 0.3 || a == Some(1.0)
    } else {
        match a {
            Some(a) => t >= 0.6 && a > 0.0,
            None => t >= 0.9,
        }
    };
    ok.then(|| t * 2.0 + a.unwrap_or(0.5) + ((b.ratings_count + 1) as f64).ln() / 20.0)
}

struct Lookup {
    title: String,
    author: String,
    isbn: Option<String>,
    asin: Option<String>,
}

fn lookup_for(app: &AppHandle, asin: &str) -> Result<Lookup, String> {
    let db: State<Db> = app.state();
    let row = db
        .list_library()
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|r| r.asin == asin)
        .ok_or("book not in the library")?;
    // Store books: the Kindle ASIN is what Goodreads knows. Personal
    // documents: read ISBN / ASIN out of the downloaded file, if any.
    if crate::local::is_local(asin) {
        // Books added from this computer: the ISBN read from the EPUB.
        return Ok(Lookup {
            title: row.title,
            author: row.author,
            isbn: db.local_file(asin).and_then(|f| f.isbn),
            asin: None,
        });
    }
    let file = (row.cde_type != "EBOK")
        .then(|| app.path().app_data_dir().ok())
        .flatten()
        .and_then(|d| std::fs::read(d.join("books").join(format!("{asin}.azw3"))).ok())
        .and_then(|b| meta::parse_mobi(&b));
    Ok(Lookup {
        title: row.title,
        author: row.author,
        isbn: file.as_ref().and_then(|f| f.isbn.clone()),
        asin: if row.cde_type == "EBOK" { Some(asin.to_string()) } else { file.and_then(|f| f.asin) },
    })
}

/// Find the book on Goodreads: `Ok(None)` = not there, `Err` = no answer at all.
async fn find_match(client: &reqwest::Client, l: &Lookup) -> Result<Option<GrBook>, String> {
    let mut queries: Vec<(String, bool)> = Vec::new();
    queries.extend(l.isbn.iter().map(|q| (q.clone(), true)));
    queries.extend(l.asin.iter().map(|q| (q.clone(), true)));
    if !l.title.trim().is_empty() {
        queries.push((l.title.clone(), false));
        if !l.author.trim().is_empty() {
            queries.push((format!("{} {}", l.title, l.author), false));
        }
    }
    let mut last_err = None;
    let mut answered = false;
    for (q, by_id) in queries {
        match suggest(client, &q).await {
            Ok(list) => {
                answered = true;
                let best = list
                    .into_iter()
                    .filter_map(|b| score(&l.title, &l.author, &b, by_id).map(|s| (s, b)))
                    .max_by(|a, b| a.0.total_cmp(&b.0));
                if let Some((_, b)) = best {
                    return Ok(Some(b));
                }
            }
            Err(e) => last_err = Some(e),
        }
    }
    match (answered, last_err) {
        (false, Some(e)) => Err(e),
        _ => Ok(None),
    }
}

/// Fresh numbers for a book we already matched: search its title and pick the
/// same Goodreads id.
async fn refresh_known(client: &reqwest::Client, b: &GrBook) -> Result<GrBook, String> {
    let q = if b.author.is_empty() { b.title.clone() } else { format!("{} {}", b.title, b.author) };
    let list = suggest(client, &q).await?;
    Ok(list.into_iter().find(|x| x.book_id == b.book_id).unwrap_or_else(|| b.clone()))
}

// ---------------------------------------------------------------- commands

/// The Goodreads match for a book, from the cache when it is fresh. `refresh`
/// matches again (a book the user matched by hand keeps its choice).
#[tauri::command]
pub async fn goodreads_info(app: AppHandle, asin: String, refresh: bool) -> Result<GrState, String> {
    let cached = {
        let db: State<Db> = app.state();
        load(&db, &asin)
    };
    if let Some(c) = &cached {
        let settled = c.manual && c.book.is_none();
        if settled || (!refresh && c.match_fresh()) {
            return Ok(c.state());
        }
    }
    let client = client()?;
    let result = match cached.as_ref().filter(|c| c.manual).and_then(|c| c.book.as_ref()) {
        Some(known) => refresh_known(&client, known).await.map(Some),
        None => {
            let l = lookup_for(&app, &asin)?;
            find_match(&client, &l).await
        }
    };
    let db: State<Db> = app.state();
    match result {
        Ok(book) => {
            save_match(&db, &asin, book.as_ref(), cached.as_ref().is_some_and(|c| c.manual))?;
            load(&db, &asin).map(|c| c.state()).ok_or_else(|| "cache write failed".into())
        }
        // Offline / refused: show what we had, if anything.
        Err(e) => cached.map(|c| c.state()).ok_or(e),
    }
}

/// Genres, rating breakdown and top reviews from the book page. Skips the
/// request while the cached copy is fresh or the page was blocked a moment
/// ago, unless `retry`.
#[tauri::command]
pub async fn goodreads_details(app: AppHandle, asin: String, retry: bool) -> Result<GrState, String> {
    let cached = {
        let db: State<Db> = app.state();
        load(&db, &asin).ok_or("no Goodreads match yet")?
    };
    let Some(book) = cached.book.clone() else { return Ok(cached.state()) };
    let status = cached.state().details_status;
    if status == "ok" || (status == "blocked" && !retry) {
        return Ok(cached.state());
    }
    let details = fetch_page(&client()?, &book.book_id).await.unwrap_or(None);
    let db: State<Db> = app.state();
    save_details(&db, &asin, details.as_ref())?;
    load(&db, &asin).map(|c| c.state()).ok_or_else(|| "cache write failed".into())
}

/// Goodreads books to choose from when the automatic match is wrong. Without
/// a query, searches the book's title (and title + author).
#[tauri::command]
pub async fn goodreads_candidates(app: AppHandle, asin: String, query: Option<String>) -> Result<Vec<GrBook>, String> {
    let l = lookup_for(&app, &asin)?;
    let client = client()?;
    let queries: Vec<String> = match query.map(|q| q.trim().to_string()).filter(|q| !q.is_empty()) {
        Some(q) => vec![q],
        None if l.author.trim().is_empty() => vec![l.title.clone()],
        None => vec![l.title.clone(), format!("{} {}", l.title, l.author)],
    };
    let mut out: Vec<GrBook> = Vec::new();
    let mut last_err = None;
    for q in &queries {
        match suggest(&client, q).await {
            Ok(list) => {
                for b in list {
                    if !out.iter().any(|x| x.book_id == b.book_id) {
                        out.push(b);
                    }
                }
            }
            Err(e) => last_err = Some(e),
        }
    }
    if out.is_empty() {
        if let Some(e) = last_err {
            return Err(e);
        }
    }
    Ok(out)
}

/// Use `book` as this book's Goodreads match (or `None`: "not on Goodreads").
#[tauri::command]
pub fn goodreads_choose(db: State<Db>, asin: String, book: Option<GrBook>) -> Result<GrState, String> {
    save_match(&db, &asin, book.as_ref(), true)?;
    load(&db, &asin).map(|c| c.state()).ok_or_else(|| "cache write failed".into())
}

#[derive(Debug, Clone, Serialize)]
pub struct Translation {
    pub text: String,
    /// Detected language of the original ("en", "vi", …), if known.
    pub source_lang: Option<String>,
}

/// Translate a review into `target` ("vi" / "en") with Google Translate's free
/// web endpoint (no key). Results are cached, so each text is sent once.
#[tauri::command]
pub async fn goodreads_translate(app: AppHandle, text: String, target: String) -> Result<Translation, String> {
    if target != "vi" && target != "en" {
        return Err("unsupported language".into());
    }
    let text = text.trim().to_string();
    if text.is_empty() {
        return Ok(Translation { text, source_lang: None });
    }
    {
        let db: State<Db> = app.state();
        let conn = db.0.lock().unwrap();
        let hit = conn
            .query_row(
                "SELECT text, lang FROM gr_translation WHERE source = ?1 AND target = ?2",
                [&text, &target],
                |r| Ok(Translation { text: r.get(0)?, source_lang: r.get(1)? }),
            )
            .ok();
        if let Some(t) = hit {
            return Ok(t);
        }
    }
    let out = translate_with_retry(&text, &target).await?;
    let db: State<Db> = app.state();
    let conn = db.0.lock().unwrap();
    let _ = conn.execute(
        "INSERT OR REPLACE INTO gr_translation (source, target, text, lang) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![text, target, out.text, out.source_lang],
    );
    Ok(out)
}

/// Error text the UI recognises: Google is limiting requests for a while.
const RATE_LIMITED: &str = "rate_limited";

/// Google answers bursts with 429 for a while (seen per client, not only per
/// IP). Wait a moment and try once more, over Windows' own TLS stack.
async fn translate_with_retry(text: &str, target: &str) -> Result<Translation, String> {
    match google_translate(&client()?, text, target).await {
        Err(e) if e == RATE_LIMITED => {
            tokio::time::sleep(Duration::from_millis(1500)).await;
            let alt = reqwest::Client::builder()
                .use_native_tls()
                .user_agent(concat!("pntome/", env!("CARGO_PKG_VERSION")))
                .timeout(Duration::from_secs(15))
                .build()
                .map_err(|e| e.to_string())?;
            google_translate(&alt, text, target).await
        }
        other => other,
    }
}

async fn google_translate(client: &reqwest::Client, text: &str, target: &str) -> Result<Translation, String> {
    // The text goes in a form body: in the URL, a long review (≈20 000
    // encoded characters) is refused with 400.
    let url = reqwest::Url::parse_with_params(
        "https://translate.googleapis.com/translate_a/single",
        &[("client", "gtx"), ("sl", "auto"), ("tl", target), ("dt", "t")],
    )
    .map_err(|e| e.to_string())?;
    let resp = client.post(url).form(&[("q", text)]).send().await.map_err(|e| e.to_string())?;
    if resp.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err(RATE_LIMITED.into());
    }
    if !resp.status().is_success() {
        return Err(format!("Google Translate: HTTP {}", resp.status()));
    }
    let v: Value = resp.json().await.map_err(|e| e.to_string())?;
    parse_google(&v).ok_or_else(|| "Google Translate: unexpected answer".into())
}

/// `[[["dịch", "orig", …], …], null, "en", …]` → joined translation + "en".
fn parse_google(v: &Value) -> Option<Translation> {
    let text: String = v.get(0)?.as_array()?.iter().filter_map(|seg| seg.get(0)?.as_str()).collect();
    (!text.trim().is_empty()).then(|| Translation {
        text: text.trim().to_string(),
        source_lang: v.get(2).and_then(Value::as_str).map(String::from),
    })
}

/// Forget the cached match (and a hand-picked one), so it is searched again.
#[tauri::command]
pub fn goodreads_reset(db: State<Db>, asin: String) -> Result<(), String> {
    let conn = db.0.lock().unwrap();
    conn.execute("DELETE FROM goodreads WHERE asin = ?1", [&asin]).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn series_suffix() {
        assert_eq!(
            split_series("Dune (Dune, #1)"),
            ("Dune".into(), Some("Dune".into()), Some("1".into()))
        );
        assert_eq!(split_series("The Hobbit"), ("The Hobbit".into(), None, None));
        assert_eq!(split_series("Sapiens (Illustrated)"), ("Sapiens (Illustrated)".into(), None, None));
    }

    #[test]
    fn matching() {
        let b = |title: &str, author: &str| GrBook {
            book_id: "1".into(),
            title: title.into(),
            author: author.into(),
            rating: None,
            ratings_count: 1000,
            pages: None,
            description: None,
            series: None,
            series_pos: None,
            url: String::new(),
            image_url: None,
        };
        let atomic = b("Atomic Habits: An Easy & Proven Way to Build Good Habits", "James Clear");
        assert!(score("Atomic Habits", "Clear, James", &atomic, false).is_some());
        assert!(score("Atomic Habits", "Someone Else", &atomic, false).is_none());
        let nha = b("Nhà Giả Kim", "Paulo Coelho");
        assert!(score("Nha gia kim", "", &nha, false).is_some());
        assert!(score("The Hobbit", "Tolkien", &b("The Art of The Hobbit", "Wayne G. Hammond"), false).is_none());
    }

    /// Hits goodreads.com: `cargo test goodreads::tests::live -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn live() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let c = client().unwrap();
            let l = Lookup { title: "The Hobbit".into(), author: "Tolkien, J.R.R.".into(), isbn: None, asin: None };
            let b = find_match(&c, &l).await.unwrap().expect("match");
            println!("{b:#?}");
            assert!(b.ratings_count > 1000);
            let d = fetch_page(&c, &b.book_id).await.unwrap();
            println!("{d:#?}");
        });
    }

    /// `cargo test --lib goodreads::tests::translate_live -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn translate_live() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let short = rt.block_on(translate_with_retry("Summer nights are for dreamers.", "vi"));
        println!("short: {short:?}");
        let long_text = "‘But how could you live and have no story to tell?’ Summer nights are for dreamers. ".repeat(220);
        let long = rt.block_on(translate_with_retry(&long_text, "vi"));
        println!("long ({} chars): {:?}", long_text.chars().count(), long.as_ref().map(|t| t.text.chars().count()));
        assert!(short.is_ok() && long.is_ok());
    }

    #[test]
    fn google_answer() {
        let v: Value = serde_json::from_str(
            r#"[[["Sách nói đầu tiên! ","My first audiobook! ",null],["Tôi rất thích.","I loved it.",null]],null,"en"]"#,
        )
        .unwrap();
        let t = parse_google(&v).unwrap();
        assert_eq!(t.text, "Sách nói đầu tiên! Tôi rất thích.");
        assert_eq!(t.source_lang.as_deref(), Some("en"));
    }

    #[test]
    fn clipping() {
        assert_eq!(clip("short", 10), "short");
        assert_eq!(clip("one two three four", 10), "one two…");
    }
}
