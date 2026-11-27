//! Reading time, streaks and badges.
//!
//! Minutes come from two places:
//! - the in-app reader, measured: it logs active seconds (idle over 3 minutes
//!   is dropped on the reader side) plus how far it got (Kindle positions);
//! - Kindle apps and devices, estimated: Amazon only tells us the last-read
//!   position, so every so often we look at how far each book has moved and
//!   turn that into minutes at the reader's own speed. When the reading
//!   happened over several days, the minutes are spread over the days Amazon
//!   says were read (`amazon_days.rs`);
//! - the Kindle app on this phone, measured: the time a book was open in it
//!   (`kindle_app.rs`). A book's move that this measured time explains is
//!   not estimated again (`estimate_left`); it only names the book the
//!   measured time goes to (a `PHONE_SLOT` row without seconds);
//! - paper books, typed in by hand (`manual`).
//!
//! A day starts at 04:00 local time, so late-night reading counts for the
//! evening it began. A day "counts" when its minutes reach the daily goal;
//! one missed day a week is forgiven (a freeze) so a streak survives it.
//! The week / month / year views built on this log live in `period.rs`.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use chrono::{Datelike, Duration, Local, NaiveDate, NaiveDateTime, TimeZone, Timelike};
use rusqlite::Connection;
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
-- The last Kindle position seen for a book: when it was last looked at, and
-- since when it has stood there (`since`, NULL in rows from before it existed).
CREATE TABLE IF NOT EXISTS kindle_obs (
    asin        TEXT PRIMARY KEY,
    location    INTEGER NOT NULL,
    observed_at INTEGER NOT NULL,
    rebase      INTEGER NOT NULL DEFAULT 0,
    since       INTEGER
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
-- Titles of paper books logged by hand (asin = 'paper:<slug>').
CREATE TABLE IF NOT EXISTS paper_book (
    asin  TEXT PRIMARY KEY,
    title TEXT NOT NULL
);
-- Days Amazon says the account read on any Kindle (see amazon_days.rs).
CREATE TABLE IF NOT EXISTS amazon_day_read (
    day TEXT PRIMARY KEY
);
";

/// Columns added to the tables of `SCHEMA` after they were first created.
pub(crate) fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    if conn.prepare("SELECT since FROM kindle_obs LIMIT 0").is_err() {
        conn.execute_batch("ALTER TABLE kindle_obs ADD COLUMN since INTEGER")?;
    }
    Ok(())
}

/// Kindle positions per minute until the reader has measured its own speed
/// (Vietnamese text with its markup; timed on a Kindle at about 2300 a minute).
const DEFAULT_POS_PER_MIN: f64 = 2000.0;
/// In-app reading needed before trusting the measured speed.
const MIN_SPEED_SECONDS: i64 = 600;
/// A jump bigger than this share of the book is navigation, not reading.
const MAX_JUMP: f64 = 0.15;
/// Books checked per Kindle activity pass: every book being read, up to this.
const KINDLE_BOOKS: usize = 25;
/// Default daily goal, minutes.
pub const DEFAULT_GOAL: i64 = 10;
/// Default yearly book goal.
const DEFAULT_GOAL_BOOKS: i64 = 12;
/// Manual (paper) reading: how many reading days back it may be logged, and
/// the most minutes per call and per day.
const MANUAL_DAYS_BACK: i64 = 7;
const MANUAL_MAX_MINUTES: i64 = 600;
/// Slot of Kindle minutes put on a day Amazon says was read: the hour is not
/// known.
const KINDLE_EST_SLOT: &str = "kindle_est";

/// Hours after midnight at which a new reading day begins.
const DAY_START_HOUR: i64 = 4;

/// Reading day (starts 04:00) and time-of-day slot (`h00`..`h23`, the local
/// hour) for a local wall-clock moment.
pub(crate) fn day_and_slot_naive(now: NaiveDateTime) -> (NaiveDate, String) {
    let day = (now - Duration::hours(DAY_START_HOUR)).date();
    (day, format!("h{:02}", now.hour()))
}

fn day_and_slot(now: chrono::DateTime<Local>) -> (NaiveDate, String) {
    day_and_slot_naive(now.naive_local())
}

pub fn today() -> NaiveDate {
    day_and_slot(Local::now()).0
}

/// The reading day a local wall-clock moment belongs to.
pub(crate) fn reading_day(now: NaiveDateTime) -> NaiveDate {
    day_and_slot_naive(now).0
}

/// What a slot says about the time of day. Rows written before hour slots
/// existed use the coarse names `night` / `early` / `day`; both spellings
/// count the same everywhere.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum SlotClass {
    /// 00:00-03:59 (`h00`..`h03`, legacy `night`).
    Night,
    /// 04:00-05:59 (`h04`, `h05`, legacy `early`).
    Early,
    /// Any other time of day (`h06`..`h23`, legacy `day`).
    Day,
    /// No time of day: typed in by hand, or Kindle minutes put on a day
    /// Amazon says was read.
    Manual,
}

/// The local hour of an `hNN` slot.
pub(crate) fn slot_hour(slot: &str) -> Option<usize> {
    let h: usize = slot.strip_prefix('h')?.parse().ok()?;
    (h < 24).then_some(h)
}

pub(crate) fn slot_class(slot: &str) -> SlotClass {
    match (slot, slot_hour(slot)) {
        ("night", _) | (_, Some(0..=3)) => SlotClass::Night,
        ("early", _) | (_, Some(4..=5)) => SlotClass::Early,
        ("manual" | KINDLE_EST_SLOT, _) => SlotClass::Manual,
        _ => SlotClass::Day,
    }
}

pub(crate) fn setting(db: &Db, key: &str) -> Option<String> {
    let conn = db.0.lock().unwrap();
    conn.query_row("SELECT value FROM app_setting WHERE key = ?1", [key], |r| r.get(0))
        .ok()
}

pub(crate) fn set_setting(db: &Db, key: &str, value: &str) -> Result<(), String> {
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

/// Books to finish in a calendar year (default 12).
pub fn goal_books_year(db: &Db) -> i64 {
    setting(db, "goal_books_year")
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_GOAL_BOOKS)
        .clamp(1, 365)
}

pub fn kindle_estimates_on(db: &Db) -> bool {
    setting(db, "kindle_estimates").map(|v| v != "0").unwrap_or(true)
}

/// Time in the Kindle app on this phone counts (on unless switched off; there
/// is nothing to count before usage access is granted).
pub fn kindle_app_usage_on(db: &Db) -> bool {
    setting(db, "kindle_app_usage").map(|v| v != "0").unwrap_or(true)
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
    record_reading(&db, Local::now().naive_local(), &asin, seconds, positions);
    Ok(())
}

/// Credit a stretch of reading to the reading day and hour of `now`.
pub(crate) fn record_reading(db: &Db, now: NaiveDateTime, asin: &str, seconds: i64, positions: i64) {
    if seconds <= 0 {
        return;
    }
    let (day, slot) = day_and_slot_naive(now);
    add_log(db, day, asin, "app", &slot, seconds.min(3600), positions.clamp(0, 2_000_000), false);
}

/// Record a look at a book's Kindle position (`?1` asin, `?2` location, `?3`
/// now): `since` moves only when the position does. A position the app pushed
/// meanwhile (`note_own_position`, newer) is not overwritten by this older look.
const OBSERVE_SQL: &str = "
    INSERT INTO kindle_obs (asin, location, observed_at, rebase, since) VALUES (?1, ?2, ?3, 0, ?3)
    ON CONFLICT(asin) DO UPDATE SET
      since = CASE WHEN kindle_obs.location = excluded.location AND kindle_obs.rebase = 0
                   THEN IFNULL(kindle_obs.since, kindle_obs.observed_at) ELSE excluded.since END,
      location = excluded.location, observed_at = excluded.observed_at, rebase = 0
    WHERE kindle_obs.observed_at <= excluded.observed_at";

/// The app itself moved the Kindle position to `location` (pushing where the
/// reader got to): that is the new starting point, so the next Kindle check
/// counts only what was read elsewhere after it.
pub fn note_own_position(db: &Db, asin: &str, location: i64) {
    let conn = db.0.lock().unwrap();
    let now = Local::now().timestamp();
    let _ = conn.execute(
        "INSERT INTO kindle_obs (asin, location, observed_at, rebase, since) VALUES (?1, ?2, ?3, 0, ?3)
         ON CONFLICT(asin) DO UPDATE SET location = excluded.location, observed_at = excluded.observed_at,
           rebase = 0, since = excluded.since",
        rusqlite::params![asin, location, now],
    );
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

/// What a Kindle pass found.
#[derive(Debug, Default, serde::Serialize)]
pub struct KindleTick {
    /// Minutes of reading estimated and credited.
    pub minutes: i64,
    /// Some book's position moved since the last look (the page then checks
    /// again sooner: the reading may still be going on).
    pub moved: bool,
}

/// Spread `seconds` of reading found at `today` over the days Amazon says
/// were read after the reader's previous look on `prev_day`: equal shares
/// over the read days in `(prev_day, today]`, the odd seconds to the earliest
/// days, so the total is exact. When none of those days is known to be read
/// (or there was no gap) everything stays on `today`.
pub(crate) fn split_over_days(
    seconds: i64,
    prev_day: NaiveDate,
    today: NaiveDate,
    days_read: &BTreeSet<NaiveDate>,
) -> Vec<(NaiveDate, i64)> {
    let days: Vec<NaiveDate> = if prev_day < today {
        days_read.range(prev_day + Duration::days(1)..=today).copied().collect()
    } else {
        vec![]
    };
    if days.is_empty() {
        return vec![(today, seconds)];
    }
    let n = days.len() as i64;
    days.iter()
        .enumerate()
        .map(|(i, d)| (*d, seconds / n + ((i as i64) < seconds % n) as i64))
        .filter(|(_, s)| *s > 0)
        .collect()
}

/// When a Kindle estimate was found, for `credit_estimate`.
struct Found {
    /// The reading day of the reader's previous look.
    prev_day: NaiveDate,
    today: NaiveDate,
    /// Hour slot of this look.
    slot: String,
    /// More than 36 hours since the previous look.
    long_gap: bool,
}

/// `reading_log.slot` of a book's move read in this phone's Kindle app: no
/// seconds (the measured `kindle_app` time is that reading), only the
/// positions, which `kindle_app::store` uses to name the book. `read_log`
/// leaves these rows out.
pub(crate) const PHONE_SLOT: &str = "kindle_phone";

/// What is left of an estimate of `estimate` seconds when this phone's Kindle
/// app had a book open for `measured` seconds over the same span: the
/// estimate is only a guess at the reader's speed, so up to twice the measured
/// time it is that reading; beyond, the rest was read on another device.
pub(crate) fn estimate_left(estimate: i64, measured: i64) -> i64 {
    if measured <= 0 {
        estimate
    } else if estimate <= 2 * measured {
        0
    } else {
        estimate - measured
    }
}

/// Credit an estimate of `secs` (for `positions` Kindle positions) to a book.
/// After a gap it goes to the days Amazon says were read, without an hour; else
/// to today, in the hour of this look (Amazon only tells us where the book got to).
fn credit_estimate(db: &Db, asin: &str, secs: i64, positions: i64, found: &Found, days_read: &BTreeSet<NaiveDate>) {
    let shares = split_over_days(secs, found.prev_day, found.today, days_read);
    let spread = found.prev_day < found.today && shares.iter().all(|(d, _)| days_read.contains(d));
    if spread {
        let merged = found.long_gap || shares.len() > 1;
        for (day, share) in shares {
            add_log(db, day, asin, "kindle", KINDLE_EST_SLOT, share, positions * share / secs, merged);
        }
    } else {
        add_log(db, found.today, asin, "kindle", &found.slot, secs, positions, found.long_gap);
    }
}

/// Look at how far the books being read have moved on Kindle and credit the
/// estimated minutes (see `credit_estimate`); also the time the Kindle app was
/// on screen on this phone (`kindle_app.rs`) and, when due, the days Amazon
/// says were read (`amazon_days.rs`).
#[tauri::command]
pub async fn kindle_activity_tick(app: AppHandle) -> Result<KindleTick, String> {
    let db: State<Db> = app.state();
    if kindle_estimates_on(&db) && creds::load().ok().flatten().is_some() {
        crate::amazon_days::refresh(&app, false).await;
    }
    let positions = estimate_from_positions(&app).await;
    // Measured time is independent of the estimate and of being signed in.
    let _ = crate::kindle_app::tick(&app).await;
    positions
}

async fn estimate_from_positions(app: &AppHandle) -> Result<KindleTick, String> {
    let db: State<Db> = app.state();
    if !kindle_estimates_on(&db) {
        return Ok(KindleTick::default());
    }
    let Some(creds) = creds::load()? else { return Ok(KindleTick::default()) };
    let days_read = crate::amazon_days::days_read(&db.0.lock().unwrap());
    let rows = db.list_library().map_err(|e| e.to_string())?;
    let mut books: Vec<_> = rows
        .into_iter()
        .filter(|r| r.source == "amazon")
        .filter(|r| r.status == "reading" || r.percent.is_some_and(|p| p > 0.5 && p < 97.5))
        .collect();
    books.sort_by(|a, b| b.last_read.cmp(&a.last_read));
    books.truncate(KINDLE_BOOKS);
    let speed = reading_speed(&db);
    let now = Local::now();
    let (mut added, mut moved) = (0i64, false);
    for b in books {
        let book = client::Book {
            asin: b.asin.clone(),
            cde_type: b.cde_type.clone(),
            ..Default::default()
        };
        let Ok(st) = client::reading_state(&creds, &book).await else { continue };
        let Some(pos) = st.position else { continue };
        let prev: Option<(i64, i64, bool, Option<i64>)> = {
            let conn = db.0.lock().unwrap();
            conn.query_row(
                "SELECT location, observed_at, rebase, since FROM kindle_obs WHERE asin = ?1",
                [&b.asin],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .ok()
        };
        if let Some((loc, at, rebase, since)) = prev {
            let delta = pos - loc;
            moved |= !rebase && delta != 0;
            let total = b.text_length.unwrap_or(0).max(1);
            if !rebase && delta > 0 && (delta as f64) <= MAX_JUMP * total as f64 {
                // The reading took at most the time the old position stood still: a
                // Kindle often syncs well after the reading, so not since the last look.
                let elapsed_min = ((now.timestamp() - since.unwrap_or(at).min(at)).max(0) as f64) / 60.0;
                let minutes = (delta as f64 / speed).min(elapsed_min).min(240.0);
                let secs = (minutes * 60.0).round() as i64;
                if secs >= 30 {
                    let (today, slot) = day_and_slot(now);
                    let prev_day = Local
                        .timestamp_opt(at, 0)
                        .single()
                        .map_or(today, |t| reading_day(t.naive_local()));
                    let found = Found { prev_day, today, slot, long_gap: now.timestamp() - at > 36 * 3600 };
                    // Since the previous look, was a book open in this phone's Kindle app?
                    let measured = crate::kindle_app::measured_secs(app, at * 1000, now.timestamp_millis()).await.unwrap_or(0);
                    let left = estimate_left(secs, measured);
                    if left < secs {
                        // The phone read (this much of) it: no seconds here, the measured
                        // time is the reading; this row names the book it goes to.
                        add_log(&db, found.today, &b.asin, "kindle", PHONE_SLOT, 0, delta * (secs - left) / secs, false);
                    }
                    if left >= 30 {
                        credit_estimate(&db, &b.asin, left, delta * left / secs, &found, &days_read);
                        added += left / 60;
                    }
                }
            }
        }
        let conn = db.0.lock().unwrap();
        let _ = conn.execute(OBSERVE_SQL, rusqlite::params![b.asin, pos, now.timestamp()]);
    }
    Ok(KindleTick { minutes: added, moved })
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
    /// First goal day of the running streak (`None` when there is none).
    pub current_start: Option<String>,
    /// First and last goal day of the longest streak.
    pub longest_range: Option<DayRange>,
}

/// A run of days, both ends included (`YYYY-MM-DD`).
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct DayRange {
    pub start: String,
    pub end: String,
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
    // Where the running streak began, and the span of the longest one (the
    // latest wins a tie, so a streak that is still running shows).
    let (mut run_start, mut best) = (first, (first, first));
    let mut d = first;
    while d <= today {
        if met.contains(&d) {
            if cur == 0 {
                run_start = d;
            }
            cur += 1;
            if cur >= longest {
                best = (run_start, d);
            }
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
        current_start: (cur > 0).then(|| run_start.to_string()),
        longest_range: (longest > 0).then(|| DayRange { start: best.0.to_string(), end: best.1.to_string() }),
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

// ---- Shared aggregation -------------------------------------------------------

/// One `reading_log` row.
pub(crate) struct LogRow {
    pub day: NaiveDate,
    pub asin: String,
    pub source: String,
    pub slot: String,
    pub seconds: i64,
    pub merged: bool,
}

/// Which of the optional sources count (the user's settings).
#[derive(Debug, Clone, Copy)]
pub(crate) struct Sources {
    /// The Kindle estimate.
    pub kindle: bool,
    /// Time in the Kindle app on this phone.
    pub kindle_app: bool,
}

impl Sources {
    pub fn load(db: &Db) -> Self {
        Sources { kindle: kindle_estimates_on(db), kindle_app: kindle_app_usage_on(db) }
    }
}

/// The whole reading log. A source the user turned off is left out (the
/// Kindle estimate, time in the Kindle app); manual (paper) reading always
/// counts. The two Kindle sources do not overlap: a move read in this phone's
/// Kindle app is not estimated (`estimate_left`), and its `PHONE_SLOT` row,
/// which only names the book, is left out here, for every consumer
/// (summary, periods, wraps, badges).
pub(crate) fn read_log(conn: &Connection, on: Sources) -> Result<Vec<LogRow>, String> {
    let mut st = conn
        .prepare("SELECT day, asin, source, slot, seconds, merged FROM reading_log")
        .map_err(|e| e.to_string())?;
    let it = st
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, bool>(5)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut log = vec![];
    for (day, asin, source, slot, seconds, merged) in it.flatten() {
        let Ok(day) = NaiveDate::parse_from_str(&day, "%Y-%m-%d") else { continue };
        if (source == "kindle" && (!on.kindle || slot == PHONE_SLOT)) || (source == crate::kindle_app::SOURCE && !on.kindle_app) {
            continue;
        }
        log.push(LogRow { day, asin, source, slot, seconds, merged });
    }
    Ok(log)
}

/// Everything read on one reading day.
#[derive(Debug, Default)]
pub(crate) struct DayAgg {
    /// Measured in the in-app reader.
    pub app: i64,
    /// Estimated from Kindle progress (reading on other devices: what this
    /// phone's Kindle app measured is not estimated, see `estimate_left`).
    pub kindle: i64,
    /// Measured: the Kindle app on this phone was on screen.
    pub kindle_app: i64,
    /// Typed in by hand.
    pub manual: i64,
    /// Part of the Kindle estimate was spread over a long gap.
    pub merged: bool,
    /// Seconds per book.
    pub books: HashMap<String, i64>,
}

impl DayAgg {
    pub fn total(&self) -> i64 {
        self.app + self.kindle + self.kindle_app + self.manual
    }
}

pub(crate) fn per_day(log: &[LogRow]) -> BTreeMap<NaiveDate, DayAgg> {
    let mut days: BTreeMap<NaiveDate, DayAgg> = BTreeMap::new();
    for r in log {
        let e = days.entry(r.day).or_default();
        match r.source.as_str() {
            "kindle" => e.kindle += r.seconds,
            crate::kindle_app::SOURCE => e.kindle_app += r.seconds,
            "manual" => e.manual += r.seconds,
            _ => e.app += r.seconds,
        }
        e.merged |= r.merged;
        *e.books.entry(r.asin.clone()).or_default() += r.seconds;
    }
    days
}

/// Days whose reading reached the daily goal.
pub(crate) fn met_days(days: &BTreeMap<NaiveDate, DayAgg>, goal_minutes: i64) -> HashSet<NaiveDate> {
    days.iter().filter(|(_, d)| d.total() >= goal_minutes * 60).map(|(d, _)| *d).collect()
}

/// `book_event` rows: (asin, kind, day).
pub(crate) struct Events(Vec<(String, String, String)>);

impl Events {
    pub fn load(conn: &Connection) -> Self {
        Events(
            conn.prepare("SELECT asin, kind, day FROM book_event")
                .and_then(|mut s| {
                    s.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                        .collect::<rusqlite::Result<Vec<_>>>()
                })
                .unwrap_or_default(),
        )
    }

    /// The day `asin` had event `kind`.
    pub fn day(&self, asin: &str, kind: &str) -> Option<NaiveDate> {
        self.0
            .iter()
            .find(|(a, k, _)| a == asin && k == kind)
            .and_then(|(_, _, d)| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok())
    }

    /// Every (asin, day) with event `kind`.
    pub fn of_kind<'a>(&'a self, kind: &'a str) -> impl Iterator<Item = (&'a str, NaiveDate)> + 'a {
        self.0.iter().filter(move |(_, k, _)| k == kind).filter_map(|(a, _, d)| {
            NaiveDate::parse_from_str(d, "%Y-%m-%d").ok().map(|d| (a.as_str(), d))
        })
    }
}

/// Record when books are seen finished / abandoned (for fast finishes,
/// comebacks and the per-period lists). Books already finished before badges
/// existed are marked as backfill so they never count as a fast finish nor
/// land in any week, month or year.
pub(crate) fn sync_book_events(conn: &Connection, rows: &[crate::db::LibraryRow], today: NaiveDate) {
    let first_run = conn
        .query_row("SELECT value FROM app_setting WHERE key = 'badges_ready'", [], |r| r.get::<_, String>(0))
        .is_err();
    for r in rows {
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
}

/// Titles of the paper books logged by hand.
pub(crate) fn paper_titles(conn: &Connection) -> HashMap<String, String> {
    conn.prepare("SELECT asin, title FROM paper_book")
        .and_then(|mut s| {
            s.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<rusqlite::Result<HashMap<_, _>>>()
        })
        .unwrap_or_default()
}

// ---- Summary ------------------------------------------------------------------

#[derive(Debug, Clone, serde::Serialize)]
pub struct DayStat {
    pub day: String,
    /// Measured reading: in-app, paper books typed in by hand and time in the
    /// Kindle app on this phone.
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
    /// Measured today (see `DayStat::app_sec`).
    pub today_app_sec: i64,
    pub today_kindle_sec: i64,
    pub streak: Streak,
    /// The days Amazon says were read, and how fresh that is.
    pub amazon_days: crate::amazon_days::AmazonDays,
    /// Days with any reading in the last year (oldest first).
    pub days: Vec<DayStat>,
    pub total_seconds: i64,
    pub books_finished: i64,
    /// Yearly book goal.
    pub goal_books_year: i64,
    /// Books finished in the current calendar year (dated finishes only).
    pub books_finished_year: i64,
    /// Those books, in the order they were finished (for the yearly shelf).
    pub finished_year_asins: Vec<String>,
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
    let sources = Sources::load(db);
    let use_kindle = sources.kindle;
    let rows = db.list_library().map_err(|e| e.to_string())?;
    let titles: HashMap<String, String> = rows.iter().map(|r| (r.asin.clone(), r.title.clone())).collect();

    // The settings are read before the connection is taken (it is not re-entrant).
    let conn = db.0.lock().unwrap();
    sync_book_events(&conn, &rows, today);
    let log = read_log(&conn, sources)?;

    let mut f = Facts { today, ..Default::default() };
    let per_day = per_day(&log);
    let mut slots: HashMap<(NaiveDate, SlotClass), i64> = HashMap::new();
    let mut per_book: HashMap<String, i64> = HashMap::new();
    for r in &log {
        *slots.entry((r.day, slot_class(&r.slot))).or_default() += r.seconds;
        *per_book.entry(r.asin.clone()).or_default() += r.seconds;
        f.total_seconds += r.seconds;
    }
    for (d, agg) in &per_day {
        // The pseudo book of Kindle-app time is no book to be "the book of the day".
        let top = agg
            .books
            .iter()
            .filter(|(a, _)| a.as_str() != crate::kindle_app::PSEUDO_ASIN)
            .max_by_key(|(_, s)| **s)
            .map(|(a, _)| a.clone());
        f.days.insert(*d, (agg.total(), top));
    }
    f.met = met_days(&per_day, goal);
    f.night_days = slots.iter().filter(|((_, c), v)| *c == SlotClass::Night && **v >= 600).count() as i64;
    f.early_days = slots.iter().filter(|((_, c), v)| *c == SlotClass::Early && **v >= 600).count() as i64;
    f.books_finished = rows.iter().filter(|r| r.status == "finished").count() as i64;

    let events = Events::load(&conn);
    for r in rows.iter().filter(|r| r.status == "finished") {
        if let (Some(start), Some(end)) = (events.day(&r.asin, "first_read"), events.day(&r.asin, "finished")) {
            if (end - start).num_days() <= 7 {
                f.fast_finishes += 1;
            }
        }
        if events.day(&r.asin, "abandoned").is_some() && events.day(&r.asin, "finished").is_some() {
            f.comebacks += 1;
        }
    }
    let mut finished_year: Vec<(NaiveDate, String)> = events
        .of_kind("finished")
        .filter(|(asin, day)| titles.contains_key(*asin) && day.year() == today.year())
        .map(|(asin, day)| (day, asin.to_string()))
        .collect();
    finished_year.sort();
    let books_finished_year = finished_year.len() as i64;
    let finished_year_asins: Vec<String> = finished_year.into_iter().map(|(_, a)| a).collect();
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
        .map(|(d, a)| DayStat { day: d.to_string(), app_sec: a.app + a.manual + a.kindle_app, kindle_sec: a.kindle, merged: a.merged })
        .collect();
    let (t_app, t_kin) = per_day.get(&today).map(|a| (a.app + a.manual + a.kindle_app, a.kindle)).unwrap_or((0, 0));
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
        amazon_days: crate::amazon_days::status(db),
        streak: compute_streak(&f.met, today),
        days,
        total_seconds: f.total_seconds,
        books_finished: f.books_finished,
        goal_books_year: goal_books_year(db),
        books_finished_year,
        finished_year_asins,
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
pub fn set_stats_settings(
    db: State<Db>,
    goal_minutes: Option<i64>,
    kindle_estimates: Option<bool>,
    goal_books_year: Option<i64>,
    kindle_app_usage: Option<bool>,
) -> Result<(), String> {
    if let Some(k) = kindle_app_usage {
        set_setting(&db, "kindle_app_usage", if k { "1" } else { "0" })?;
    }
    if let Some(g) = goal_minutes {
        set_setting(&db, "goal_minutes", &g.clamp(5, 120).to_string())?;
    }
    if let Some(k) = kindle_estimates {
        set_setting(&db, "kindle_estimates", if k { "1" } else { "0" })?;
    }
    if let Some(g) = goal_books_year {
        set_setting(&db, "goal_books_year", &g.clamp(1, 365).to_string())?;
    }
    Ok(())
}

// ---- Paper books, typed in by hand ----------------------------------------------

/// Lower-case title with every run of other characters turned into one `-`
/// (letters keep their accents), for a paper book's synthetic ASIN.
fn paper_slug(title: &str) -> String {
    let mut slug = String::new();
    for c in title.chars().flat_map(char::to_lowercase) {
        if c.is_alphanumeric() {
            slug.push(c);
        } else if !slug.is_empty() && !slug.ends_with('-') {
            slug.push('-');
        }
    }
    slug.trim_end_matches('-').chars().take(64).collect()
}

pub(crate) fn parse_day(day: &str) -> Result<NaiveDate, String> {
    NaiveDate::parse_from_str(day, "%Y-%m-%d").map_err(|_| format!("bad day: {day}"))
}

/// Credit `minutes` of paper reading to `day`. `today` is the current
/// reading day. Without an `asin` the book is a paper book known only by its
/// `title`.
pub(crate) fn log_manual(
    db: &Db,
    today: NaiveDate,
    day: NaiveDate,
    asin: Option<&str>,
    title: Option<&str>,
    minutes: i64,
) -> Result<(), String> {
    if !(1..=MANUAL_MAX_MINUTES).contains(&minutes) {
        return Err(format!("minutes must be 1..={MANUAL_MAX_MINUTES}"));
    }
    if day > today || day < today - Duration::days(MANUAL_DAYS_BACK) {
        return Err(format!("reading can only be added for today and the {MANUAL_DAYS_BACK} days before"));
    }
    let (asin, new_title) = match (asin.map(str::trim).filter(|a| !a.is_empty()), title.map(str::trim)) {
        (Some(a), _) => (a.to_string(), None),
        (None, Some(t)) if !t.is_empty() => {
            let slug = paper_slug(t);
            if slug.is_empty() {
                return Err("the title needs letters or digits".into());
            }
            (format!("paper:{slug}"), Some(t.chars().take(200).collect::<String>()))
        }
        (None, _) => return Err("a book or a title is needed".into()),
    };
    {
        let conn = db.0.lock().unwrap();
        if new_title.is_none() {
            let known = conn
                .query_row(
                    "SELECT 1 FROM book WHERE asin = ?1 UNION SELECT 1 FROM paper_book WHERE asin = ?1",
                    [&asin],
                    |_| Ok(()),
                )
                .is_ok();
            if !known {
                return Err(format!("unknown book: {asin}"));
            }
        }
        let have: i64 = conn
            .query_row(
                "SELECT IFNULL(SUM(seconds), 0) FROM reading_log WHERE day = ?1 AND source = 'manual'",
                [day.to_string()],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if have + minutes * 60 > MANUAL_MAX_MINUTES * 60 {
            return Err(format!("at most {MANUAL_MAX_MINUTES} minutes can be added by hand for one day"));
        }
        if let Some(t) = &new_title {
            conn.execute(
                "INSERT INTO paper_book (asin, title) VALUES (?1, ?2)
                 ON CONFLICT(asin) DO UPDATE SET title = excluded.title",
                rusqlite::params![asin, t],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    add_log(db, day, &asin, "manual", "manual", minutes * 60, 0, false);
    // Adding an earlier day than the book's first reading moves its start.
    let conn = db.0.lock().unwrap();
    let _ = conn.execute(
        "UPDATE book_event SET day = ?2 WHERE asin = ?1 AND kind = 'first_read' AND day > ?2",
        rusqlite::params![asin, day.to_string()],
    );
    Ok(())
}

/// Add reading time for a paper (or any) book by hand: today and the 7
/// reading days before, 1..=600 minutes per call and per day. It counts
/// toward the goal and the streak whatever the Kindle-estimate setting is.
#[tauri::command]
pub fn log_manual_reading(
    db: State<Db>,
    day: String,
    asin: Option<String>,
    title: Option<String>,
    minutes: i64,
) -> Result<(), String> {
    log_manual(&db, today(), parse_day(&day)?, asin.as_deref(), title.as_deref(), minutes)
}

/// Take back everything added by hand for a book on a day. A paper book
/// that has no reading left is forgotten.
#[tauri::command]
pub fn delete_manual_reading(db: State<Db>, day: String, asin: String) -> Result<(), String> {
    delete_manual(&db, parse_day(&day)?, &asin)
}

/// What was added by hand for a book on a day.
#[derive(Debug, PartialEq, serde::Serialize)]
pub struct ManualEntry {
    pub asin: String,
    pub title: String,
    pub seconds: i64,
}

/// The paper reading added by hand on `day`, one entry per book, most first.
#[tauri::command]
pub fn manual_readings(db: State<Db>, day: String) -> Result<Vec<ManualEntry>, String> {
    manual_on(&db, parse_day(&day)?)
}

fn manual_on(db: &Db, day: NaiveDate) -> Result<Vec<ManualEntry>, String> {
    let titles: HashMap<String, String> = db.list_library().map_err(|e| e.to_string())?.into_iter().map(|r| (r.asin, r.title)).collect();
    let conn = db.0.lock().unwrap();
    let paper = paper_titles(&conn);
    let mut st = conn
        .prepare(
            "SELECT asin, SUM(seconds) FROM reading_log WHERE day = ?1 AND source = 'manual'
             GROUP BY asin ORDER BY SUM(seconds) DESC, asin",
        )
        .map_err(|e| e.to_string())?;
    let rows = st
        .query_map([day.to_string()], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
        .map_err(|e| e.to_string())?;
    Ok(rows
        .flatten()
        .map(|(asin, seconds)| {
            let title = titles.get(&asin).or_else(|| paper.get(&asin)).cloned().unwrap_or_else(|| asin.clone());
            ManualEntry { asin, title, seconds }
        })
        .collect())
}

fn delete_manual(db: &Db, day: NaiveDate, asin: &str) -> Result<(), String> {
    let conn = db.0.lock().unwrap();
    conn.execute(
        "DELETE FROM reading_log WHERE day = ?1 AND asin = ?2 AND source = 'manual'",
        rusqlite::params![day.to_string(), asin],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM paper_book WHERE asin = ?1 AND NOT EXISTS (SELECT 1 FROM reading_log WHERE asin = ?1)",
        [asin],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Helpers shared by the tests of the stats, period and wrap modules.
#[cfg(test)]
pub(crate) mod testing {
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use chrono::{NaiveDate, NaiveDateTime};

    use super::add_log;
    use crate::db::Db;

    pub fn d(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    /// A local wall-clock moment, `YYYY-MM-DD HH:MM`.
    pub fn at(s: &str) -> NaiveDateTime {
        NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M").unwrap()
    }

    /// A database in a temporary file, removed when dropped.
    pub struct TempDb {
        db: Option<Db>,
        path: PathBuf,
    }

    impl TempDb {
        pub fn new(name: &str) -> Self {
            static N: AtomicUsize = AtomicUsize::new(0);
            let path = std::env::temp_dir().join(format!("pnb-{name}-{}-{}.sqlite", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
            let _ = std::fs::remove_file(&path);
            TempDb { db: Some(Db::open(&path).unwrap()), path }
        }

        pub fn db(&self) -> &Db {
            self.db.as_ref().unwrap()
        }

        pub fn add_book(&self, asin: &str, title: &str) {
            let book = crate::adp::client::Book { asin: asin.into(), title: title.into(), ..Default::default() };
            self.db().upsert_books(&[book]).unwrap();
        }

        /// Add a reading_log row (the book's first_read event comes with it).
        pub fn log(&self, day: &str, asin: &str, source: &str, slot: &str, seconds: i64) {
            add_log(self.db(), d(day), asin, source, slot, seconds, 0, false);
        }
    }

    impl Drop for TempDb {
        fn drop(&mut self) {
            self.db.take();
            for ext in ["", "-wal", "-shm"] {
                let _ = std::fs::remove_file(format!("{}{ext}", self.path.display()));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::testing::{at, d, TempDb};
    use super::*;

    #[test]
    fn day_starts_at_four() {
        use chrono::TimeZone;
        let late = Local.with_ymd_and_hms(2026, 11, 18, 3, 30, 0).unwrap();
        assert_eq!(day_and_slot(late), (d("2026-11-17"), "h03".to_string()));
        let early = Local.with_ymd_and_hms(2026, 11, 18, 5, 0, 0).unwrap();
        assert_eq!(day_and_slot(early), (d("2026-11-18"), "h05".to_string()));
    }

    #[test]
    fn day_boundary_with_hour_slots() {
        let slot = |s: &str| day_and_slot_naive(at(s));
        // 03:59 still belongs to the day before, in the night slot h03.
        assert_eq!(slot("2026-11-18 03:59"), (d("2026-11-17"), "h03".to_string()));
        assert_eq!(slot("2026-11-18 04:00"), (d("2026-11-18"), "h04".to_string()));
        assert_eq!(slot("2026-11-18 00:00"), (d("2026-11-17"), "h00".to_string()));
        assert_eq!(slot("2026-11-18 23:59"), (d("2026-11-18"), "h23".to_string()));
        assert_eq!(reading_day(at("2026-01-01 02:00")), d("2025-12-31"));
    }

    #[test]
    fn readings_are_logged_with_the_hour() {
        let t = TempDb::new("hour");
        record_reading(t.db(), at("2026-11-18 03:59"), "A", 120, 0);
        record_reading(t.db(), at("2026-11-18 04:00"), "A", 60, 0);
        record_reading(t.db(), at("2026-11-18 04:20"), "A", 30, 0);
        record_reading(t.db(), at("2026-11-18 04:20"), "A", 0, 0); // nothing to log
        let conn = t.db().0.lock().unwrap();
        let rows: Vec<(String, String, i64)> = conn
            .prepare("SELECT day, slot, seconds FROM reading_log ORDER BY day, slot")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(
            rows,
            [("2026-11-17", "h03", 120), ("2026-11-18", "h04", 90)].map(|(a, b, c)| (a.to_string(), b.to_string(), c))
        );
    }

    #[test]
    fn slot_classes_accept_hours_and_legacy_names() {
        for slot in ["night", "h00", "h01", "h02", "h03"] {
            assert_eq!(slot_class(slot), SlotClass::Night, "{slot}");
        }
        for slot in ["early", "h04", "h05"] {
            assert_eq!(slot_class(slot), SlotClass::Early, "{slot}");
        }
        for slot in ["day", "h06", "h12", "h23"] {
            assert_eq!(slot_class(slot), SlotClass::Day, "{slot}");
        }
        assert_eq!(slot_class("manual"), SlotClass::Manual);
        assert_eq!((slot_hour("h07"), slot_hour("h24"), slot_hour("night"), slot_hour("h")), (Some(7), None, None, None));
    }

    #[test]
    fn night_owl_and_early_bird_count_old_and_new_slots() {
        let t = TempDb::new("badges-slots");
        // Night days (10 minutes in the night slots of a day are needed).
        t.log("2026-11-01", "A", "app", "night", 600); // legacy
        t.log("2026-11-02", "A", "app", "h01", 400); // hours add up within a day
        t.log("2026-11-02", "A", "app", "h03", 200);
        t.log("2026-11-03", "A", "app", "h02", 599); // not enough
        t.log("2026-11-03", "A", "app", "h04", 100); // early does not help
        // Early days.
        t.log("2026-11-04", "A", "app", "h04", 600);
        t.log("2026-11-05", "A", "app", "early", 300); // legacy + new add up
        t.log("2026-11-05", "A", "app", "h05", 300);
        t.log("2026-11-06", "A", "app", "h06", 6000); // plain day
        t.log("2026-11-07", "A", "manual", "manual", 6000); // no time of day
        let (f, _) = gather(t.db()).unwrap();
        assert_eq!((f.night_days, f.early_days), (2, 2));
    }

    #[test]
    fn yearly_goal_and_finished_this_year() {
        let t = TempDb::new("goal-year");
        let db = t.db();
        assert_eq!(goal_books_year(db), 12);
        set_setting(db, "goal_books_year", "999").unwrap();
        assert_eq!(goal_books_year(db), 365);
        set_setting(db, "goal_books_year", "0").unwrap();
        assert_eq!(goal_books_year(db), 1);
        set_setting(db, "goal_books_year", "20").unwrap();

        let year = today().year();
        for a in ["A", "B", "C", "D"] {
            t.add_book(a, a);
            db.set_status(a, Some("finished")).unwrap();
        }
        {
            let conn = db.0.lock().unwrap();
            for (asin, kind, day) in [
                ("A", "finished", format!("{year}-01-02")),
                ("B", "finished", format!("{}-12-30", year - 1)),
                ("C", "finished_backfill", format!("{year}-01-03")),
                ("GONE", "finished", format!("{year}-01-04")), // no longer in the library
            ] {
                conn.execute("INSERT INTO book_event (asin, kind, day) VALUES (?1, ?2, ?3)", rusqlite::params![asin, kind, day])
                    .unwrap();
            }
        }
        let (_, s) = gather(db).unwrap();
        assert_eq!((s.goal_books_year, s.books_finished_year, s.books_finished), (20, 1, 4));
        assert_eq!(s.finished_year_asins, vec!["A".to_string()]);
    }

    #[test]
    fn manual_reading_limits() {
        let t = TempDb::new("manual");
        let db = t.db();
        t.add_book("B1", "Kindle book");
        let today = d("2026-11-18");
        let log = |day: &str, asin: Option<&str>, title: Option<&str>, min| log_manual(db, today, d(day), asin, title, min);

        // Today and the 7 days before are allowed, nothing else.
        assert!(log("2026-11-18", None, Some("Sách giấy"), 30).is_ok());
        assert!(log("2026-11-11", None, Some("Sách giấy"), 30).is_ok());
        assert!(log("2026-11-10", None, Some("Sách giấy"), 30).is_err());
        assert!(log("2026-11-19", None, Some("Sách giấy"), 30).is_err());
        // 1..=600 minutes per call.
        assert!(log("2026-11-17", None, Some("Sách giấy"), 0).is_err());
        assert!(log("2026-11-17", None, Some("Sách giấy"), -5).is_err());
        assert!(log("2026-11-17", None, Some("Sách giấy"), 601).is_err());
        // At most 600 minutes of manual reading in a day, over all books.
        assert!(log("2026-11-16", None, Some("Sách giấy"), 500).is_ok());
        assert!(log("2026-11-16", Some("B1"), None, 100).is_ok());
        assert!(log("2026-11-16", Some("B1"), None, 1).is_err());
        assert!(log("2026-11-15", Some("B1"), None, 600).is_ok());
        // A book or a title is needed; the title needs a letter or digit.
        assert!(log("2026-11-17", None, None, 5).is_err());
        assert!(log("2026-11-17", None, Some("   "), 5).is_err());
        assert!(log("2026-11-17", None, Some("?!"), 5).is_err());
        assert!(log("2026-11-17", Some("NOPE"), None, 5).is_err());
        // Failed calls leave nothing behind (no phantom paper book).
        let conn = db.0.lock().unwrap();
        let titles = paper_titles(&conn);
        assert_eq!(titles.len(), 1);
        assert_eq!(titles["paper:sách-giấy"], "Sách giấy");
        let secs: i64 = conn.query_row("SELECT SUM(seconds) FROM reading_log WHERE source = 'manual'", [], |r| r.get(0)).unwrap();
        assert_eq!(secs, (30 + 30 + 500 + 100 + 600) * 60);
    }

    #[test]
    fn manual_reading_counts_toward_the_goal_and_ignores_the_kindle_switch() {
        let t = TempDb::new("manual-goal");
        let db = t.db();
        let today = d("2026-11-18");
        log_manual(db, today, today, None, Some("Paper"), 12).unwrap();
        t.log("2026-11-18", "K", "kindle", "h10", 900);
        let conn = db.0.lock().unwrap();
        for (kindle, expected_total) in [(true, 12 * 60 + 900), (false, 12 * 60)] {
            let day = per_day(&read_log(&conn, Sources { kindle, kindle_app: true }).unwrap());
            let agg = &day[&today];
            assert_eq!((agg.total(), agg.manual), (expected_total, 12 * 60), "kindle {kindle}");
            assert!(met_days(&day, 10).contains(&today));
        }
        drop(conn);
        // The summary reports it with the measured (app) reading.
        let (_, s) = gather(db).unwrap();
        assert_eq!(s.total_seconds, 12 * 60 + 900);
    }

    #[test]
    fn manual_reading_can_be_taken_back() {
        let t = TempDb::new("manual-del");
        let db = t.db();
        let today = d("2026-11-18");
        log_manual(db, today, d("2026-11-17"), None, Some("Paper"), 20).unwrap();
        log_manual(db, today, d("2026-11-18"), None, Some("Paper"), 10).unwrap();
        // Logging an earlier day than the first moves the book's start back.
        let first: String = t
            .db()
            .0
            .lock()
            .unwrap()
            .query_row("SELECT day FROM book_event WHERE asin = 'paper:paper' AND kind = 'first_read'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(first, "2026-11-17");
        let on = |day: &str| manual_on(db, d(day)).unwrap();
        assert_eq!(on("2026-11-17"), [ManualEntry { asin: "paper:paper".into(), title: "Paper".into(), seconds: 1200 }]);
        assert!(on("2026-11-16").is_empty());
        delete_manual(db, d("2026-11-17"), "paper:paper").unwrap();
        assert!(on("2026-11-17").is_empty());
        assert_eq!(paper_titles(&db.0.lock().unwrap()).len(), 1); // still has the 18th
        delete_manual(db, d("2026-11-18"), "paper:paper").unwrap();
        assert!(paper_titles(&db.0.lock().unwrap()).is_empty());
        delete_manual(db, d("2026-11-18"), "paper:paper").unwrap(); // nothing left is fine
    }

    #[test]
    fn a_position_remembers_since_when_it_stood_still() {
        let t = TempDb::new("kindle-obs");
        let db = t.db();
        let look = |loc: i64, at: i64| {
            db.0.lock().unwrap().execute(OBSERVE_SQL, rusqlite::params!["A", loc, at]).unwrap();
        };
        let row = || -> (i64, i64, Option<i64>) {
            db.0.lock()
                .unwrap()
                .query_row("SELECT location, observed_at, since FROM kindle_obs WHERE asin = 'A'", [], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?))
                })
                .unwrap()
        };
        look(100, 1000);
        look(100, 2000); // unchanged: still there since the first look
        assert_eq!(row(), (100, 2000, Some(1000)));
        look(500, 3000); // moved
        assert_eq!(row(), (500, 3000, Some(3000)));
        // A row from before `since` existed counts from its last look.
        db.0.lock().unwrap().execute_batch("UPDATE kindle_obs SET since = NULL, observed_at = 3500").unwrap();
        look(500, 4000);
        assert_eq!(row(), (500, 4000, Some(3500)));
        // The app pushed its own position: that is where Kindle reading elsewhere starts from...
        note_own_position(db, "A", 900);
        let (loc, pushed_at, since) = row();
        assert_eq!((loc, Some(pushed_at)), (900, since));
        // ...and a look that began before the push does not undo it.
        look(500, pushed_at - 1);
        assert_eq!(row().0, 900);
    }

    #[test]
    fn the_phone_explains_a_move_up_to_twice_its_time() {
        // Nothing measured: the whole estimate.
        assert_eq!(estimate_left(600, 0), 600);
        // 159 s estimated, 89 s measured (the speed is only a guess): all read on the phone.
        assert_eq!(estimate_left(159, 89), 0);
        assert_eq!(estimate_left(180, 90), 0);
        // Far more moved than the phone read: the rest was read elsewhere.
        assert_eq!(estimate_left(1800, 300), 1500);
    }

    #[test]
    fn kindle_app_time_and_estimates_add_up_and_phone_rows_only_name_books() {
        let t = TempDb::new("kindle-sources");
        let db = t.db();
        t.add_book("A", "A");
        t.add_book("B", "B");
        // 18th: A read on the phone (measured, plus the row naming it), B on another Kindle (estimated).
        t.log("2026-11-18", "A", "kindle_app", "h09", 1800);
        t.log("2026-11-18", "A", "kindle", PHONE_SLOT, 0);
        t.log("2026-11-18", "B", "kindle", "h10", 600);
        // 21st: measured only, and in-app reading.
        t.log("2026-11-21", "A", "kindle_app", "h22", 500);
        t.log("2026-11-21", "A", "app", "h22", 100);

        let conn = db.0.lock().unwrap();
        let log = read_log(&conn, Sources { kindle: true, kindle_app: true }).unwrap();
        assert!(log.iter().all(|r| r.slot != PHONE_SLOT));
        let day = |on: Sources| per_day(&read_log(&conn, on).unwrap());
        let both = day(Sources { kindle: true, kindle_app: true });
        let (a18, a21) = (&both[&d("2026-11-18")], &both[&d("2026-11-21")]);
        assert_eq!((a18.kindle, a18.kindle_app, a18.total()), (600, 1800, 2400));
        assert_eq!((a18.books["A"], a18.books["B"]), (1800, 600));
        assert_eq!((a21.kindle, a21.kindle_app, a21.app), (0, 500, 100));
        // Each toggle leaves out only its own source.
        let est = day(Sources { kindle: true, kindle_app: false });
        assert_eq!((est[&d("2026-11-18")].kindle, est[&d("2026-11-18")].kindle_app), (600, 0));
        let app_only = day(Sources { kindle: false, kindle_app: true });
        assert_eq!((app_only[&d("2026-11-18")].kindle, app_only[&d("2026-11-18")].kindle_app), (0, 1800));
        drop(conn);

        let (f, s) = gather(db).unwrap();
        assert_eq!(s.total_seconds, 2400 + 600);
        assert_eq!(f.total_seconds, s.total_seconds);
    }

    #[test]
    fn kindle_app_hours_count_as_night_and_early_reading() {
        let t = TempDb::new("kindle-app-hours");
        t.log("2026-11-01", "kindle:app", "kindle_app", "h01", 600);
        t.log("2026-11-02", "kindle:app", "kindle_app", "h05", 700);
        let (f, s) = gather(t.db()).unwrap();
        assert_eq!((f.night_days, f.early_days), (1, 1));
        // The pseudo book is counted in the totals but is never listed.
        assert_eq!(s.total_seconds, 1300);
        assert!(s.top_books.is_empty());
    }

    #[test]
    fn estimates_are_split_over_the_days_amazon_says_were_read() {
        let read: BTreeSet<NaiveDate> = ["2026-11-10", "2026-11-12", "2026-11-14", "2026-11-16"].iter().map(|s| d(s)).collect();
        let split = |secs, prev: &str, today: &str| split_over_days(secs, d(prev), d(today), &read);
        // Same day, or no gap: everything stays on today.
        assert_eq!(split(600, "2026-11-16", "2026-11-16"), [(d("2026-11-16"), 600)]);
        // A gap of one day: only today is in (prev, today]; it is read, so it gets all.
        assert_eq!(split(600, "2026-11-15", "2026-11-16"), [(d("2026-11-16"), 600)]);
        // Several days, some read: equal shares over the read ones (the 11th and 13th were not read).
        assert_eq!(split(900, "2026-11-10", "2026-11-16"), [(d("2026-11-12"), 300), (d("2026-11-14"), 300), (d("2026-11-16"), 300)]);
        // The previous look's own day is not part of the gap.
        assert_eq!(split(100, "2026-11-12", "2026-11-14"), [(d("2026-11-14"), 100)]);
        // None of the days is known to be read: today, as before.
        assert_eq!(split(600, "2026-11-16", "2026-11-19"), [(d("2026-11-19"), 600)]);
        assert_eq!(split(600, "2026-11-01", "2026-11-09"), [(d("2026-11-09"), 600)]);
        // The total is exact: the odd seconds go to the earliest days.
        let shares = split(1000, "2026-11-09", "2026-11-16");
        assert_eq!(shares.iter().map(|s| s.1).collect::<Vec<_>>(), [250, 250, 250, 250]);
        let shares = split(1001, "2026-11-09", "2026-11-16");
        assert_eq!(shares.iter().map(|s| s.1).collect::<Vec<_>>(), [251, 250, 250, 250]);
        let shares = split(2, "2026-11-09", "2026-11-16");
        assert_eq!(shares, [(d("2026-11-10"), 1), (d("2026-11-12"), 1)]);
    }

    #[test]
    fn a_long_gap_credits_the_read_days_without_an_hour() {
        let t = TempDb::new("credit-gap");
        let db = t.db();
        let read: BTreeSet<NaiveDate> = ["2026-11-11", "2026-11-13"].iter().map(|s| d(s)).collect();
        let found = |prev: &str, today: &str, long_gap| Found { prev_day: d(prev), today: d(today), slot: "h21".into(), long_gap };
        // Spread over two read days: rows without an hour, flagged as merged.
        credit_estimate(db, "A", 1001, 2002, &found("2026-11-10", "2026-11-14", true), &read);
        // No read day in the gap: all on today, in the hour of the look, merged only for a gap over 36 h.
        credit_estimate(db, "B", 600, 10, &found("2026-11-17", "2026-11-20", true), &read);
        credit_estimate(db, "C", 300, 5, &found("2026-11-20", "2026-11-20", false), &read);
        let conn = db.0.lock().unwrap();
        let rows: Vec<(String, String, String, i64, i64, bool)> = conn
            .prepare("SELECT day, asin, slot, seconds, positions, merged FROM reading_log ORDER BY day, asin")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        let row = |a: &str, b: &str, c: &str, s, p, m| (a.to_string(), b.to_string(), c.to_string(), s, p, m);
        assert_eq!(
            rows,
            [
                row("2026-11-11", "A", "kindle_est", 501, 1002, true),
                row("2026-11-13", "A", "kindle_est", 500, 1000, true),
                row("2026-11-20", "B", "h21", 600, 10, true),
                row("2026-11-20", "C", "h21", 300, 5, false),
            ]
        );
        assert_eq!(slot_class("kindle_est"), SlotClass::Manual);
        assert_eq!(slot_hour("kindle_est"), None);
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
        // The running streak began on the 6th; the longest was the 2nd to the 4th.
        assert_eq!(s.current_start.as_deref(), Some("2026-11-06"));
        assert_eq!(s.longest_range, Some(DayRange { start: "2026-11-02".into(), end: "2026-11-04".into() }));
        let s = compute_streak(&met, d("2026-11-06"));
        assert_eq!(s.current_start.as_deref(), Some("2026-11-02"));
        assert_eq!(s.longest_range, Some(DayRange { start: "2026-11-02".into(), end: "2026-11-06".into() }));
        assert_eq!(compute_streak(&HashSet::new(), d("2026-11-06")).longest_range, None);
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
