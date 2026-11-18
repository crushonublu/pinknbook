//! Reading time, streaks and badges.
//!
//! Minutes come from two places:
//! - the in-app reader, measured: it logs active seconds (idle over 3 minutes
//!   is dropped on the reader side) plus how far it got (Kindle positions);
//! - Kindle apps and devices, estimated: Amazon only tells us the last-read
//!   position, so every so often we look at how far each book has moved and
//!   turn that into minutes at the reader's own speed.
//!
//! A day starts at 04:00 local time, so late-night reading counts for the
//! evening it began. A day "counts" when its minutes reach the daily goal;
//! one missed day a week is forgiven (a freeze) so a streak survives it.

use std::collections::{BTreeMap, HashMap, HashSet};

use chrono::{Datelike, Duration, Local, NaiveDate, Timelike};
use tauri::{AppHandle, Manager, State};

use crate::adp::client;
use crate::creds;
use crate::db::Db;

pub const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS reading_log (
    day       TEXT NOT NULL,
    asin      TEXT NOT NULL,
    source    TEXT NOT NULL,
    slot      TEXT NOT NULL,
    seconds   INTEGER NOT NULL DEFAULT 0,
    positions INTEGER NOT NULL DEFAULT 0,
    merged    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, asin, source, slot)
);
CREATE TABLE IF NOT EXISTS kindle_obs (
    asin        TEXT PRIMARY KEY,
    location    INTEGER NOT NULL,
    observed_at INTEGER NOT NULL,
    rebase      INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS badge_unlock (
    badge       TEXT NOT NULL,
    tier        INTEGER NOT NULL,
    unlocked_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (badge, tier)
);
CREATE TABLE IF NOT EXISTS book_event (
    asin TEXT NOT NULL,
    kind TEXT NOT NULL,
    day  TEXT NOT NULL,
    PRIMARY KEY (asin, kind)
);
CREATE TABLE IF NOT EXISTS app_setting (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
";

/// Kindle positions per minute until the reader has measured its own speed
/// (about 250 words a minute of Vietnamese text with its markup).
const DEFAULT_POS_PER_MIN: f64 = 1500.0;
/// In-app reading needed before trusting the measured speed.
const MIN_SPEED_SECONDS: i64 = 600;
/// A jump bigger than this share of the book is navigation, not reading.
const MAX_JUMP: f64 = 0.15;
/// Books checked per Kindle activity pass.
const KINDLE_BOOKS: usize = 10;
/// Default daily goal, minutes.
pub const DEFAULT_GOAL: i64 = 10;

/// Reading day (starts 04:00) and time-of-day slot for a local moment.
fn day_and_slot(now: chrono::DateTime<Local>) -> (NaiveDate, &'static str) {
    let day = (now - Duration::hours(4)).date_naive();
    let slot = match now.hour() {
        0..=3 => "night",
        4..=5 => "early",
        _ => "day",
    };
    (day, slot)
}

pub fn today() -> NaiveDate {
    day_and_slot(Local::now()).0
}

fn setting(db: &Db, key: &str) -> Option<String> {
    let conn = db.0.lock().unwrap();
    conn.query_row("SELECT value FROM app_setting WHERE key = ?1", [key], |r| r.get(0))
        .ok()
}

fn set_setting(db: &Db, key: &str, value: &str) -> Result<(), String> {
    let conn = db.0.lock().unwrap();
    conn.execute(
        "INSERT INTO app_setting (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [key, value],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

pub fn goal_minutes(db: &Db) -> i64 {
    setting(db, "goal_minutes")
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_GOAL)
        .clamp(5, 120)
}

pub fn kindle_estimates_on(db: &Db) -> bool {
    setting(db, "kindle_estimates").map(|v| v != "0").unwrap_or(true)
}

fn add_log(db: &Db, day: NaiveDate, asin: &str, source: &str, slot: &str, seconds: i64, positions: i64, merged: bool) {
    let conn = db.0.lock().unwrap();
    let _ = conn.execute(
        "INSERT INTO reading_log (day, asin, source, slot, seconds, positions, merged)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(day, asin, source, slot) DO UPDATE SET
           seconds = seconds + excluded.seconds,
           positions = positions + excluded.positions,
           merged = max(merged, excluded.merged)",
        rusqlite::params![day.to_string(), asin, source, slot, seconds, positions, merged],
    );
    let _ = conn.execute(
        "INSERT OR IGNORE INTO book_event (asin, kind, day) VALUES (?1, 'first_read', ?2)",
        rusqlite::params![asin, day.to_string()],
    );
}

/// The in-app reader reports a stretch of active reading.
#[tauri::command]
pub fn log_reading(db: State<Db>, asin: String, seconds: i64, positions: i64) -> Result<(), String> {
    if seconds <= 0 {
        return Ok(());
    }
    let (day, slot) = day_and_slot(Local::now());
    add_log(&db, day, &asin, "app", slot, seconds.min(3600), positions.clamp(0, 2_000_000), false);
    Ok(())
}

/// The app itself moved the Kindle position (pushing where the reader got
/// to): the next Kindle check must not count that as reading elsewhere.
pub fn note_own_position(db: &Db, asin: &str) {
    let conn = db.0.lock().unwrap();
    let _ = conn.execute("UPDATE kindle_obs SET rebase = 1 WHERE asin = ?1", [asin]);
}

/// Positions per minute, measured from in-app reading when there is enough.
fn reading_speed(db: &Db) -> f64 {
    let conn = db.0.lock().unwrap();
    let (sec, pos): (i64, i64) = conn
        .query_row(
            "SELECT IFNULL(SUM(seconds),0), IFNULL(SUM(positions),0) FROM reading_log
             WHERE source = 'app' AND positions > 0",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap_or((0, 0));
    if sec >= MIN_SPEED_SECONDS && pos > 0 {
        (pos as f64 / (sec as f64 / 60.0)).clamp(300.0, 6000.0)
    } else {
        DEFAULT_POS_PER_MIN
    }
}

/// Look at how far the books being read have moved on Kindle and credit the
/// estimated minutes to today. Returns the minutes added.
#[tauri::command]
pub async fn kindle_activity_tick(app: AppHandle) -> Result<i64, String> {
    let db: State<Db> = app.state();
    if !kindle_estimates_on(&db) {
        return Ok(0);
    }
    let Some(creds) = creds::load()? else { return Ok(0) };
    let rows = db.list_library().map_err(|e| e.to_string())?;
    let mut books: Vec<_> = rows
        .into_iter()
        .filter(|r| r.status == "reading" || r.percent.is_some_and(|p| p > 0.5 && p < 97.5))
        .collect();
    books.sort_by(|a, b| b.last_read.cmp(&a.last_read));
    books.truncate(KINDLE_BOOKS);
    let speed = reading_speed(&db);
    let now = Local::now();
    let mut added = 0i64;
    for b in books {
        let book = client::Book {
            asin: b.asin.clone(),
            cde_type: b.cde_type.clone(),
            ..Default::default()
        };
        let Ok(st) = client::reading_state(&creds, &book).await else { continue };
        let Some(pos) = st.position else { continue };
        let prev: Option<(i64, i64, bool)> = {
            let conn = db.0.lock().unwrap();
            conn.query_row(
                "SELECT location, observed_at, rebase FROM kindle_obs WHERE asin = ?1",
                [&b.asin],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .ok()
        };
        if let Some((loc, at, rebase)) = prev {
            let delta = pos - loc;
            let total = b.text_length.unwrap_or(0).max(1);
            if !rebase && delta > 0 && (delta as f64) <= MAX_JUMP * total as f64 {
                let elapsed_min = ((now.timestamp() - at).max(0) as f64) / 60.0;
                let minutes = (delta as f64 / speed).min(elapsed_min).min(240.0);
                let secs = (minutes * 60.0).round() as i64;
                if secs >= 30 {
                    let merged = now.timestamp() - at > 36 * 3600;
                    add_log(&db, today(), &b.asin, "kindle", "day", secs, delta, merged);
                    added += secs / 60;
                }
            }
        }
        let conn = db.0.lock().unwrap();
        let _ = conn.execute(
            "INSERT INTO kindle_obs (asin, location, observed_at, rebase) VALUES (?1, ?2, ?3, 0)
             ON CONFLICT(asin) DO UPDATE SET location = excluded.location,
               observed_at = excluded.observed_at, rebase = 0",
            rusqlite::params![b.asin, pos, now.timestamp()],
        );
    }
    Ok(added)
}

// ---- Streaks ------------------------------------------------------------------

#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
pub struct Streak {
    pub current: i64,
    pub longest: i64,
    /// The goal is already reached today.
    pub today_done: bool,
    /// This week's forgiven day is still unused.
    pub freeze_left: bool,
}

fn week_of(d: NaiveDate) -> (i32, u32) {
    let w = d.iso_week();
    (w.year(), w.week())
}

/// Streak over `met` (days that reached the goal), up to `today`. A missed
/// day is forgiven once per ISO week while a streak is running; today does
/// not break the streak before it is over.
pub fn compute_streak(met: &HashSet<NaiveDate>, today: NaiveDate) -> Streak {
    let Some(first) = met.iter().min().copied() else {
        return Streak { freeze_left: true, ..Default::default() };
    };
    let mut used: HashSet<(i32, u32)> = HashSet::new();
    let (mut cur, mut longest) = (0i64, 0i64);
    let mut d = first;
    while d <= today {
        if met.contains(&d) {
            cur += 1;
        } else if d == today {
            // still time to read today
        } else if cur > 0 && !used.contains(&week_of(d)) {
            used.insert(week_of(d));
        } else {
            cur = 0;
        }
        longest = longest.max(cur);
        d += Duration::days(1);
    }
    Streak {
        current: cur,
        longest,
        today_done: met.contains(&today),
        freeze_left: !used.contains(&week_of(today)),
    }
}

// ---- Badges -------------------------------------------------------------------

/// Badge id, its four tier thresholds (bronze, silver, gold, diamond).
pub const BADGES: [(&str, [i64; 4]); 13] = [
    ("streak", [7, 30, 100, 365]),
    ("hours", [1, 10, 100, 500]),
    ("big_day", [60, 120, 180, 240]),
    ("books", [1, 5, 25, 50]),
    ("fast_finish", [1, 3, 10, 20]),
    ("comeback", [1, 3, 5, 10]),
    ("highlights", [10, 100, 500, 1000]),
    ("notes", [5, 25, 50, 200]),
    ("rainbow", [1, 3, 10, 25]),
    ("night_owl", [1, 7, 30, 100]),
    ("early_bird", [1, 7, 30, 100]),
    ("weekend", [1, 4, 12, 52]),
    ("variety", [3, 7, 14, 30]),
];

#[derive(Debug, Clone, serde::Serialize)]
pub struct Badge {
    pub id: String,
    /// 0 = locked, 1..=4 = bronze..diamond.
    pub tier: u8,
    pub value: i64,
    pub thresholds: [i64; 4],
}

fn tier_for(value: i64, t: &[i64; 4]) -> u8 {
    t.iter().filter(|&&x| value >= x).count() as u8
}

/// Everything the badges are computed from.
#[derive(Debug, Default)]
pub struct Facts {
    /// Day → (seconds counted, top book that day).
    pub days: BTreeMap<NaiveDate, (i64, Option<String>)>,
    pub met: HashSet<NaiveDate>,
    pub night_days: i64,
    pub early_days: i64,
    pub total_seconds: i64,
    pub books_finished: i64,
    pub fast_finishes: i64,
    pub comebacks: i64,
    pub highlights: i64,
    pub notes: i64,
    pub rainbow_books: i64,
    pub today: NaiveDate,
}

pub fn compute_badges(f: &Facts) -> Vec<Badge> {
    let streak = compute_streak(&f.met, f.today);
    let big_day = f.days.values().map(|(s, _)| s / 60).max().unwrap_or(0);
    // Weekends: both Saturday and Sunday reached the goal.
    let weekends = f
        .met
        .iter()
        .filter(|d| d.weekday() == chrono::Weekday::Sat && f.met.contains(&(**d + Duration::days(1))))
        .count() as i64;
    // Variety: consecutive reading days, each with a different top book.
    let (mut run, mut best) = (0i64, 0i64);
    let mut prev: Option<(NaiveDate, Option<String>)> = None;
    for (d, (secs, top)) in &f.days {
        if *secs < 60 || top.is_none() {
            continue;
        }
        run = match &prev {
            Some((pd, pt)) if *pd + Duration::days(1) == *d && pt != top => run + 1,
            _ => 1,
        };
        best = best.max(run);
        prev = Some((*d, top.clone()));
    }
    let value = |id: &str| -> i64 {
        match id {
            "streak" => streak.longest,
            "hours" => f.total_seconds / 3600,
            "big_day" => big_day,
            "books" => f.books_finished,
            "fast_finish" => f.fast_finishes,
            "comeback" => f.comebacks,
            "highlights" => f.highlights,
            "notes" => f.notes,
            "rainbow" => f.rainbow_books,
            "night_owl" => f.night_days,
            "early_bird" => f.early_days,
            "weekend" => weekends,
            "variety" => best,
            _ => 0,
        }
    };
    BADGES
        .iter()
        .map(|(id, t)| {
            let v = value(id);
            Badge {
                id: id.to_string(),
                tier: tier_for(v, t),
                value: v,
                thresholds: *t,
            }
        })
        .collect()
}

// ---- Summary ------------------------------------------------------------------

#[derive(Debug, Clone, serde::Serialize)]
pub struct DayStat {
    pub day: String,
    pub app_sec: i64,
    pub kindle_sec: i64,
    pub merged: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct BookTime {
    pub asin: String,
    pub title: String,
    pub seconds: i64,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Unlock {
    pub id: String,
    pub tier: u8,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Summary {
    pub today: String,
    pub goal_minutes: i64,
    pub kindle_estimates: bool,
    pub today_app_sec: i64,
    pub today_kindle_sec: i64,
    pub streak: Streak,
    /// Days with any reading in the last year (oldest first).
    pub days: Vec<DayStat>,
    pub total_seconds: i64,
    pub books_finished: i64,
    /// Kindle positions per minute (for "time left").
    pub speed: f64,
    pub top_books: Vec<BookTime>,
    pub badges: Vec<Badge>,
    /// Tiers reached since the last summary (for the unlock toast).
    pub unlocked: Vec<Unlock>,
    /// Tiers granted silently on first run from earlier activity.
    pub backfilled: usize,
}

fn gather(db: &Db) -> Result<(Facts, Summary), String> {
    let today = today();
    let goal = goal_minutes(db);
    let use_kindle = kindle_estimates_on(db);
    let rows = db.list_library().map_err(|e| e.to_string())?;
    let titles: HashMap<String, String> = rows.iter().map(|r| (r.asin.clone(), r.title.clone())).collect();

    let conn = db.0.lock().unwrap();
    // Record when books are seen finished / abandoned (for fast finishes and
    // comebacks). Books already finished before badges existed are marked as
    // backfill so they never count as a fast finish.
    let first_run = conn
        .query_row("SELECT value FROM app_setting WHERE key = 'badges_ready'", [], |r| r.get::<_, String>(0))
        .is_err();
    for r in &rows {
        if r.status == "finished" {
            let kind = if first_run { "finished_backfill" } else { "finished" };
            let has: bool = conn
                .query_row(
                    "SELECT 1 FROM book_event WHERE asin = ?1 AND kind IN ('finished','finished_backfill')",
                    [&r.asin],
                    |_| Ok(true),
                )
                .unwrap_or(false);
            if !has {
                let _ = conn.execute(
                    "INSERT OR IGNORE INTO book_event (asin, kind, day) VALUES (?1, ?2, ?3)",
                    rusqlite::params![r.asin, kind, today.to_string()],
                );
            }
        } else if r.status == "abandoned" {
            let _ = conn.execute(
                "INSERT OR IGNORE INTO book_event (asin, kind, day) VALUES (?1, 'abandoned', ?2)",
                rusqlite::params![r.asin, today.to_string()],
            );
        }
    }

    let mut log: Vec<(String, String, String, String, i64, bool)> = vec![];
    {
        let mut st = conn
            .prepare("SELECT day, asin, source, slot, seconds, merged FROM reading_log")
            .map_err(|e| e.to_string())?;
        let it = st
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)))
            .map_err(|e| e.to_string())?;
        for x in it.flatten() {
            log.push(x);
        }
    }

    let mut f = Facts { today, ..Default::default() };
    let mut per_day: BTreeMap<NaiveDate, (i64, i64, bool, HashMap<String, i64>)> = BTreeMap::new();
    let mut slots: HashMap<(NaiveDate, String), i64> = HashMap::new();
    let mut per_book: HashMap<String, i64> = HashMap::new();
    for (day, asin, source, slot, secs, merged) in &log {
        let Ok(d) = NaiveDate::parse_from_str(day, "%Y-%m-%d") else { continue };
        let kindle = source == "kindle";
        if kindle && !use_kindle {
            continue;
        }
        let e = per_day.entry(d).or_default();
        if kindle {
            e.1 += secs;
        } else {
            e.0 += secs;
        }
        e.2 |= *merged;
        *e.3.entry(asin.clone()).or_default() += secs;
        *slots.entry((d, slot.clone())).or_default() += secs;
        *per_book.entry(asin.clone()).or_default() += secs;
        f.total_seconds += secs;
    }
    for (d, (app, kin, _, books)) in &per_day {
        let total = app + kin;
        let top = books.iter().max_by_key(|(_, s)| **s).map(|(a, _)| a.clone());
        f.days.insert(*d, (total, top));
        if total >= goal * 60 {
            f.met.insert(*d);
        }
    }
    f.night_days = slots.iter().filter(|((_, s), v)| s == "night" && **v >= 600).count() as i64;
    f.early_days = slots.iter().filter(|((_, s), v)| s == "early" && **v >= 600).count() as i64;
    f.books_finished = rows.iter().filter(|r| r.status == "finished").count() as i64;

    let events: Vec<(String, String, String)> = conn
        .prepare("SELECT asin, kind, day FROM book_event")
        .and_then(|mut s| {
            s.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .unwrap_or_default();
    let ev = |asin: &str, kind: &str| {
        events
            .iter()
            .find(|(a, k, _)| a == asin && k == kind)
            .and_then(|(_, _, d)| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok())
    };
    for r in rows.iter().filter(|r| r.status == "finished") {
        if let (Some(start), Some(end)) = (ev(&r.asin, "first_read"), ev(&r.asin, "finished")) {
            if (end - start).num_days() <= 7 {
                f.fast_finishes += 1;
            }
        }
        if ev(&r.asin, "abandoned").is_some() && ev(&r.asin, "finished").is_some() {
            f.comebacks += 1;
        }
    }
    let count = |sql: &str| conn.query_row(sql, [], |r| r.get::<_, i64>(0)).unwrap_or(0);
    f.highlights = count("SELECT COUNT(*) FROM annotation WHERE deleted = 0");
    f.notes = count("SELECT COUNT(*) FROM annotation WHERE deleted = 0 AND IFNULL(note,'') <> ''");
    f.rainbow_books = count(
        "SELECT COUNT(*) FROM (SELECT asin FROM annotation WHERE deleted = 0
         GROUP BY asin HAVING COUNT(DISTINCT color) >= 4)",
    );
    drop(conn);

    let from = today - Duration::days(371);
    let days: Vec<DayStat> = per_day
        .iter()
        .filter(|(d, _)| **d >= from)
        .map(|(d, (a, k, m, _))| DayStat { day: d.to_string(), app_sec: *a, kindle_sec: *k, merged: *m })
        .collect();
    let (t_app, t_kin) = per_day.get(&today).map(|(a, k, _, _)| (*a, *k)).unwrap_or((0, 0));
    let mut top: Vec<BookTime> = per_book
        .into_iter()
        // Only books still in the library (removed ones have no title).
        .filter(|(asin, s)| *s >= 60 && titles.contains_key(asin))
        .map(|(asin, seconds)| BookTime { title: titles.get(&asin).cloned().unwrap_or_default(), asin, seconds })
        .collect();
    top.sort_by(|a, b| b.seconds.cmp(&a.seconds));
    top.truncate(5);

    let summary = Summary {
        today: today.to_string(),
        goal_minutes: goal,
        kindle_estimates: use_kindle,
        today_app_sec: t_app,
        today_kindle_sec: t_kin,
        streak: compute_streak(&f.met, today),
        days,
        total_seconds: f.total_seconds,
        books_finished: f.books_finished,
        speed: reading_speed(db),
        top_books: top,
        badges: compute_badges(&f),
        unlocked: vec![],
        backfilled: 0,
    };
    Ok((f, summary))
}

/// Everything the Stats page and the title-bar flame show. Newly reached
/// badge tiers are recorded and returned once in `unlocked`.
#[tauri::command]
pub fn stats_summary(db: State<Db>) -> Result<Summary, String> {
    let (_, mut s) = gather(&db)?;
    let first_run = setting(&db, "badges_ready").is_none();
    let conn = db.0.lock().unwrap();
    let have: HashSet<(String, u8)> = conn
        .prepare("SELECT badge, tier FROM badge_unlock")
        .and_then(|mut st| {
            st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, u8>(1)?)))?
                .collect::<rusqlite::Result<HashSet<_>>>()
        })
        .unwrap_or_default();
    let mut new = vec![];
    for b in &s.badges {
        for tier in 1..=b.tier {
            if !have.contains(&(b.id.clone(), tier)) {
                let _ = conn.execute(
                    "INSERT OR IGNORE INTO badge_unlock (badge, tier) VALUES (?1, ?2)",
                    rusqlite::params![b.id, tier],
                );
                new.push(Unlock { id: b.id.clone(), tier });
            }
        }
    }
    drop(conn);
    if first_run {
        // Earlier activity unlocks quietly; only the best tier per badge is
        // worth a mention.
        s.backfilled = s.badges.iter().filter(|b| b.tier > 0).count();
        let _ = set_setting(&db, "badges_ready", "1");
    } else {
        // Toast only the highest new tier of each badge.
        let mut best: HashMap<String, u8> = HashMap::new();
        for u in new {
            let e = best.entry(u.id).or_insert(0);
            *e = (*e).max(u.tier);
        }
        s.unlocked = best.into_iter().map(|(id, tier)| Unlock { id, tier }).collect();
    }
    Ok(s)
}

#[tauri::command]
pub fn set_stats_settings(db: State<Db>, goal_minutes: Option<i64>, kindle_estimates: Option<bool>) -> Result<(), String> {
    if let Some(g) = goal_minutes {
        set_setting(&db, "goal_minutes", &g.clamp(5, 120).to_string())?;
    }
    if let Some(k) = kindle_estimates {
        set_setting(&db, "kindle_estimates", if k { "1" } else { "0" })?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    #[test]
    fn day_starts_at_four() {
        use chrono::TimeZone;
        let late = Local.with_ymd_and_hms(2026, 11, 18, 3, 30, 0).unwrap();
        assert_eq!(day_and_slot(late), (d("2026-11-17"), "night"));
        let early = Local.with_ymd_and_hms(2026, 11, 18, 5, 0, 0).unwrap();
        assert_eq!(day_and_slot(early), (d("2026-11-18"), "early"));
    }

    #[test]
    fn streak_with_freeze() {
        // Mon 2026-11-02 .. ; one gap on Wed is forgiven, a second gap the
        // same week breaks the streak.
        let met: HashSet<_> = ["2026-11-02", "2026-11-03", "2026-11-05", "2026-11-06"].iter().map(|s| d(s)).collect();
        let s = compute_streak(&met, d("2026-11-06"));
        assert_eq!((s.current, s.longest, s.today_done, s.freeze_left), (4, 4, true, false));
        let met2: HashSet<_> = ["2026-11-02", "2026-11-04", "2026-11-06"].iter().map(|s| d(s)).collect();
        let s = compute_streak(&met2, d("2026-11-06"));
        assert_eq!(s.current, 1);
        // Today not yet done does not break it.
        let s = compute_streak(&met, d("2026-11-07"));
        assert_eq!((s.current, s.today_done), (4, false));
        // A new week brings a new freeze.
        let met3: HashSet<_> = ["2026-11-06", "2026-11-08", "2026-11-10"].iter().map(|s| d(s)).collect();
        assert_eq!(compute_streak(&met3, d("2026-11-10")).current, 3);
    }

    #[test]
    fn badges_from_facts() {
        let mut f = Facts { today: d("2026-11-16"), ..Default::default() };
        for (day, secs, book) in [
            ("2026-11-14", 3700, "A"), // Sat
            ("2026-11-15", 1200, "B"), // Sun
            ("2026-11-16", 900, "C"),
        ] {
            f.days.insert(d(day), (secs, Some(book.into())));
            f.met.insert(d(day));
        }
        f.total_seconds = 5800;
        f.highlights = 120;
        f.books_finished = 5;
        let b: HashMap<_, _> = compute_badges(&f).into_iter().map(|b| (b.id.clone(), b)).collect();
        assert_eq!(b["hours"].tier, 1);
        assert_eq!((b["big_day"].value, b["big_day"].tier), (61, 1));
        assert_eq!(b["weekend"].value, 1);
        assert_eq!(b["variety"].value, 3);
        assert_eq!(b["variety"].tier, 1);
        assert_eq!(b["highlights"].tier, 2);
        assert_eq!(b["books"].tier, 2);
        assert_eq!(b["streak"].tier, 0);
        assert_eq!(b["streak"].value, 3);
    }
}
