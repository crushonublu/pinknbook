//! Wrap-up cards for a finished (or nearly finished) week, month or year.
//!
//! A card is offered on the Home screen from 18:00 on the last day of the
//! period (as a preview while the period is still running) until a few days
//! into the next one. The numbers of a finished period are saved the first
//! time they are asked for, so the card opens the same later; the layout the
//! reader gave it (stickers, background seed) is saved with it. A preview is
//! live and never stored.

use chrono::{Duration, Local, NaiveDate, NaiveDateTime};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::Db;
use crate::period::{bounds, period_stats, PeriodStats};
use crate::stats::{parse_day, reading_day};

pub const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS wrap (
    kind         TEXT NOT NULL,           -- 'week' | 'month' | 'year'
    period_start TEXT NOT NULL,           -- first reading day, YYYY-MM-DD
    data_json    TEXT,                    -- the PeriodStats when it was saved; NULL until the period is over
    layout_json  TEXT,                    -- the reader's arrangement of the card
    seed         INTEGER NOT NULL,        -- background variation (reroll counter)
    created_at   TEXT DEFAULT (datetime('now')),
    seen         INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (kind, period_start)
);
";

/// Wrap kinds, in the order they are offered when several are due at once.
const KINDS: [&str; 3] = ["year", "month", "week"];
/// The offer starts at this wall-clock hour on the period's last day.
const OFFER_FROM_HOUR: u32 = 18;
/// The `seen` value of a wrap the reader deleted: its numbers and layout are
/// gone, and it is neither offered nor saved again (a snapshot is made on
/// demand when the period is over, which would bring it straight back).
/// Opening it again takes the mark off.
const DELETED: i64 = 2;
/// Biggest layout the app saves.
const MAX_LAYOUT_BYTES: usize = 256 * 1024;

/// A wrap that is on offer.
#[derive(Debug, Clone, PartialEq)]
pub struct Offer {
    pub kind: &'static str,
    pub start: NaiveDate,
    pub end: NaiveDate,
    /// The period is not over yet.
    pub preview: bool,
}

/// The local wall-clock window in which the wrap of the period ending on
/// `end` is offered: from 18:00 on `end` until 04:00 (the start of that
/// reading day) of the day it goes away: the following Sunday for a week,
/// the 7th for a month, 31 January for a year.
fn offer_window(kind: &str, end: NaiveDate) -> (NaiveDateTime, NaiveDateTime) {
    let hide_day = match kind {
        "week" => end + Duration::days(7),
        "month" => end + Duration::days(1 + 6),
        _ => end + Duration::days(31),
    };
    (
        end.and_hms_opt(OFFER_FROM_HOUR, 0, 0).expect("valid time"),
        hide_day.and_hms_opt(4, 0, 0).expect("valid time"),
    )
}

/// Which wraps are on offer at the local wall-clock moment `now`. Only the
/// period containing `now`'s reading day and the one before can be on offer.
pub fn wrap_available(now: NaiveDateTime) -> Vec<Offer> {
    let today = reading_day(now);
    let mut offers = vec![];
    for kind in KINDS {
        let (current, _) = bounds(kind, today).expect("known kind");
        let (previous, _) = bounds(kind, current - Duration::days(1)).expect("known kind");
        for anchor in [previous, current] {
            let (start, end) = bounds(kind, anchor).expect("known kind");
            let (from, until) = offer_window(kind, end);
            if now >= from && now < until {
                offers.push(Offer { kind, start, end, preview: end >= today });
            }
        }
    }
    offers
}

/// A wrap in a list.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WrapSummary {
    pub kind: String,
    pub period_start: String,
    pub period_end: String,
    /// Live numbers of a period that is not over (nothing is saved).
    pub preview: bool,
    pub seen: bool,
    pub seed: i64,
    pub has_layout: bool,
}

/// One wrap, for the card.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WrapDoc {
    pub kind: String,
    pub period_start: String,
    pub period_end: String,
    pub preview: bool,
    pub seen: bool,
    pub seed: i64,
    /// The saved arrangement of the card (JSON text), if the reader made one.
    pub layout_json: Option<String>,
    pub stats: PeriodStats,
}

/// The stored side of a wrap. `data` is empty while the period is not over:
/// the row then only holds what the reader did with the preview.
struct Stored {
    data: Option<String>,
    layout: Option<String>,
    seed: i64,
    seen: bool,
    /// The reader deleted the saved wrap (`seen` is `DELETED`).
    deleted: bool,
}

fn load(db: &Db, kind: &str, start: NaiveDate) -> Option<Stored> {
    let conn = db.0.lock().unwrap();
    conn.query_row(
        "SELECT data_json, layout_json, seed, seen FROM wrap WHERE kind = ?1 AND period_start = ?2",
        rusqlite::params![kind, start.to_string()],
        |r| {
            let seen: i64 = r.get(3)?;
            Ok(Stored { data: r.get(0)?, layout: r.get(1)?, seed: r.get(2)?, seen: seen != 0, deleted: seen == DELETED })
        },
    )
    .ok()
}

/// Validate a wrap's `kind` and `period_start` (the first day of that
/// week / month / year) and give the period's last day.
fn parse_period(kind: &str, period_start: &str) -> Result<(NaiveDate, NaiveDate), String> {
    let start = parse_day(period_start)?;
    match bounds(kind, start).filter(|_| KINDS.contains(&kind)) {
        Some((s, e)) if s == start => Ok((s, e)),
        _ => Err(format!("not the first day of a {kind}: {period_start}")),
    }
}

/// Like `parse_period`, and the period must have begun.
fn parse_begun_period(kind: &str, period_start: &str, now: NaiveDateTime) -> Result<NaiveDate, String> {
    let (start, _) = parse_period(kind, period_start)?;
    if start > reading_day(now) {
        return Err(format!("that {kind} has not started: {period_start}"));
    }
    Ok(start)
}

/// The numbers of a period: the saved ones if there are any. A finished
/// period with some reading in it is saved now (on the row the reader's
/// choices may already have created); anything else is computed live. The
/// flag says whether the numbers are saved afterwards.
fn stats_of(db: &Db, kind: &str, start: NaiveDate, now: NaiveDateTime) -> Result<(PeriodStats, bool), String> {
    let stored = load(db, kind, start);
    if let Some(data) = stored.as_ref().and_then(|s| s.data.as_deref()) {
        return Ok((serde_json::from_str(data).map_err(|e| e.to_string())?, true));
    }
    let stats = period_stats(db, kind, Some(start), now)?;
    if !(stats.is_complete && stats.total_sec > 0) || stored.is_some_and(|s| s.deleted) {
        return Ok((stats, false));
    }
    let json = serde_json::to_string(&stats).map_err(|e| e.to_string())?;
    let conn = db.0.lock().unwrap();
    conn.execute(
        "INSERT INTO wrap (kind, period_start, data_json, seed) VALUES (?1, ?2, ?3, 0)
         ON CONFLICT(kind, period_start) DO UPDATE SET data_json = excluded.data_json WHERE wrap.data_json IS NULL",
        rusqlite::params![kind, start.to_string(), json],
    )
    .map_err(|e| e.to_string())?;
    Ok((stats, true))
}

fn summary(kind: &str, start: NaiveDate, end: NaiveDate, preview: bool, stored: Option<&Stored>) -> WrapSummary {
    WrapSummary {
        kind: kind.to_string(),
        period_start: start.to_string(),
        period_end: end.to_string(),
        preview,
        seen: stored.is_some_and(|s| s.seen),
        seed: stored.map_or(0, |s| s.seed),
        has_layout: stored.is_some_and(|s| s.layout.is_some()),
    }
}

/// The wraps to offer at `now`: those the reader has not opened or dismissed
/// (`seen` is false on all of them). A period nothing was read in has none.
fn pending(db: &Db, now: NaiveDateTime) -> Result<Vec<WrapSummary>, String> {
    let mut out = vec![];
    for o in wrap_available(now) {
        let (stats, _) = stats_of(db, o.kind, o.start, now)?;
        let row = load(db, o.kind, o.start);
        if stats.total_sec == 0 || row.as_ref().is_some_and(|r| r.seen) {
            continue;
        }
        out.push(summary(o.kind, o.start, o.end, o.preview, row.as_ref()));
    }
    Ok(out)
}

fn get(db: &Db, kind: &str, period_start: &str, now: NaiveDateTime) -> Result<WrapDoc, String> {
    let (start, end) = parse_period(kind, period_start)?;
    let (stats, _) = stats_of(db, kind, start, now)?;
    let row = load(db, kind, start);
    Ok(WrapDoc {
        kind: kind.to_string(),
        period_start: start.to_string(),
        period_end: end.to_string(),
        preview: !stats.is_complete,
        seen: row.as_ref().is_some_and(|r| r.seen),
        seed: row.as_ref().map_or(0, |r| r.seed),
        layout_json: row.and_then(|r| r.layout),
        stats,
    })
}

fn save_layout(
    db: &Db,
    kind: &str,
    period_start: &str,
    layout_json: &str,
    seed: i64,
    now: NaiveDateTime,
) -> Result<(), String> {
    let start = parse_begun_period(kind, period_start, now)?;
    if layout_json.len() > MAX_LAYOUT_BYTES {
        return Err("layout is too big".into());
    }
    serde_json::from_str::<serde_json::Value>(layout_json).map_err(|e| format!("layout is not JSON: {e}"))?;
    let conn = db.0.lock().unwrap();
    conn.execute(
        "INSERT INTO wrap (kind, period_start, layout_json, seed) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(kind, period_start) DO UPDATE SET layout_json = excluded.layout_json, seed = excluded.seed",
        rusqlite::params![kind, start.to_string(), layout_json, seed],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Every wrap whose numbers are saved, newest first.
fn list(db: &Db) -> Result<Vec<WrapSummary>, String> {
    let conn = db.0.lock().unwrap();
    let mut st = conn
        .prepare("SELECT kind, period_start, layout_json IS NOT NULL, seed, seen FROM wrap WHERE data_json IS NOT NULL")
        .map_err(|e| e.to_string())?;
    let rows = st
        .query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, bool>(2)?, r.get::<_, i64>(3)?, r.get::<_, i64>(4)? != 0))
        })
        .map_err(|e| e.to_string())?;
    let mut out: Vec<WrapSummary> = rows
        .flatten()
        .filter_map(|(kind, start, has_layout, seed, seen)| {
            let (s, e) = parse_period(&kind, &start).ok()?;
            Some(WrapSummary { kind, period_start: s.to_string(), period_end: e.to_string(), preview: false, seen, seed, has_layout })
        })
        .collect();
    // Newest period first; at the same end a year before a month before a week.
    out.sort_by_key(|w| {
        let rank = KINDS.iter().position(|k| *k == w.kind).unwrap_or(KINDS.len());
        (std::cmp::Reverse(w.period_end.clone()), rank)
    });
    Ok(out)
}

/// The wraps to show on Home now.
#[tauri::command]
pub fn wraps_pending(db: State<Db>) -> Result<Vec<WrapSummary>, String> {
    pending(&db, Local::now().naive_local())
}

/// One wrap: the saved one, or live numbers for a period that is not over.
#[tauri::command]
pub fn wrap_get(db: State<Db>, kind: String, period_start: String) -> Result<WrapDoc, String> {
    get(&db, &kind, &period_start, Local::now().naive_local())
}

/// Save how the reader arranged a wrap (`layout_json`) and its background
/// `seed`. Works for a preview too: the choices wait in the row until the
/// period is over and its numbers are saved next to them.
#[tauri::command]
pub fn wrap_save_layout(db: State<Db>, kind: String, period_start: String, layout_json: String, seed: i64) -> Result<(), String> {
    save_layout(&db, &kind, &period_start, &layout_json, seed, Local::now().naive_local())
}

/// The reader has opened or dismissed the wrap: it is not offered again.
/// Works for a preview too.
#[tauri::command]
pub fn wrap_mark_seen(db: State<Db>, kind: String, period_start: String) -> Result<(), String> {
    mark_seen(&db, &kind, &period_start, Local::now().naive_local())
}

fn mark_seen(db: &Db, kind: &str, period_start: &str, now: NaiveDateTime) -> Result<(), String> {
    let start = parse_begun_period(kind, period_start, now)?;
    let conn = db.0.lock().unwrap();
    conn.execute(
        "INSERT INTO wrap (kind, period_start, seed, seen) VALUES (?1, ?2, 0, 1)
         ON CONFLICT(kind, period_start) DO UPDATE SET seen = 1",
        rusqlite::params![kind, start.to_string()],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// Every saved wrap, newest first.
#[tauri::command]
pub fn wraps_list(db: State<Db>) -> Result<Vec<WrapSummary>, String> {
    list(&db)
}

/// Delete a saved wrap: its numbers and the reader's layout. It leaves the
/// history and is not offered again.
#[tauri::command]
pub fn wrap_delete(db: State<Db>, kind: String, period_start: String) -> Result<(), String> {
    delete(&db, &kind, &period_start)
}

fn delete(db: &Db, kind: &str, period_start: &str) -> Result<(), String> {
    let (start, _) = parse_period(kind, period_start)?;
    let conn = db.0.lock().unwrap();
    conn.execute(
        "UPDATE wrap SET data_json = NULL, layout_json = NULL, seed = 0, seen = ?3
         WHERE kind = ?1 AND period_start = ?2 AND data_json IS NOT NULL",
        rusqlite::params![kind, start.to_string(), DELETED],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stats::testing::{at, d, TempDb};

    fn offered(now: &str, kind: &str) -> Option<Offer> {
        wrap_available(at(now)).into_iter().find(|o| o.kind == kind)
    }

    fn span(o: &Option<Offer>) -> Option<(String, String, bool)> {
        o.as_ref().map(|o| (o.start.to_string(), o.end.to_string(), o.preview))
    }

    #[test]
    fn week_window() {
        // Week Mon 2026-11-16 .. Sun 2026-11-22.
        let week = |now: &str| span(&offered(now, "week"));
        let this = |preview| Some(("2026-11-16".to_string(), "2026-11-22".to_string(), preview));
        assert_eq!(week("2026-11-22 17:59"), None);
        assert_eq!(week("2026-11-22 18:00"), this(true));
        assert_eq!(week("2026-11-22 23:59"), this(true));
        // 00:00-03:59 on Monday still belongs to Sunday's reading day.
        assert_eq!(week("2026-11-23 03:59"), this(true));
        // From 04:00 the week is over: the card is final.
        assert_eq!(week("2026-11-23 04:00"), this(false));
        assert_eq!(week("2026-11-28 12:00"), this(false));
        // It goes away on the following Sunday at 04:00 (03:59 is still Saturday).
        assert_eq!(week("2026-11-29 03:59"), this(false));
        assert_eq!(week("2026-11-29 04:00"), None);
        assert_eq!(week("2026-11-29 17:59"), None);
        // ... and the next week's preview takes over at 18:00.
        assert_eq!(week("2026-11-29 18:00"), Some(("2026-11-23".into(), "2026-11-29".into(), true)));
    }

    #[test]
    fn month_window_for_every_month_length() {
        let month = |now: &str| span(&offered(now, "month"));
        // 28 days (2027), 29 (2028), 30 (April), 31 (January).
        for (last, first, ym_next) in [
            ("2027-02-28", "2027-02-01", "2027-03"),
            ("2028-02-29", "2028-02-01", "2028-03"),
            ("2026-04-30", "2026-04-01", "2026-05"),
            ("2026-01-31", "2026-01-01", "2026-02"),
        ] {
            let on = |preview| Some((first.to_string(), last.to_string(), preview));
            assert_eq!(month(&format!("{last} 17:59")), None, "{last}");
            assert_eq!(month(&format!("{last} 18:00")), on(true), "{last}");
            // The 4 a.m. rule: the last reading day lasts until 04:00 next day.
            let next_day = (d(last) + Duration::days(1)).to_string();
            assert_eq!(month(&format!("{next_day} 03:59")), on(true), "{last}");
            assert_eq!(month(&format!("{next_day} 04:00")), on(false), "{last}");
            assert_eq!(month(&format!("{ym_next}-06 23:59")), on(false), "{last}");
            assert_eq!(month(&format!("{ym_next}-07 03:59")), on(false), "{last}");
            assert_eq!(month(&format!("{ym_next}-07 04:00")), None, "{last}");
        }
        // The day before the last day nothing is offered.
        assert_eq!(month("2028-02-28 18:00"), None);
    }

    #[test]
    fn year_window_and_overlaps() {
        let year = |now: &str| span(&offered(now, "year"));
        let y = |preview| Some(("2026-01-01".to_string(), "2026-12-31".to_string(), preview));
        assert_eq!(year("2026-12-31 17:59"), None);
        assert_eq!(year("2026-12-31 18:00"), y(true));
        assert_eq!(year("2027-01-01 03:59"), y(true));
        assert_eq!(year("2027-01-01 04:00"), y(false));
        assert_eq!(year("2027-01-31 03:59"), y(false));
        assert_eq!(year("2027-01-31 04:00"), None);
        // On New Year's Eve evening a year and a month are due, the year first, and
        // so is the week before (Mon 21 - Sun 27 December, offered until 3 January).
        let kinds: Vec<_> = wrap_available(at("2026-12-31 20:00")).iter().map(|o| o.kind).collect();
        assert_eq!(kinds, ["year", "month", "week"]);
        assert_eq!(span(&offered("2026-12-31 20:00", "week")), Some(("2026-12-21".into(), "2026-12-27".into(), false)));
    }

    fn week_db(name: &str) -> TempDb {
        let t = TempDb::new(name);
        t.add_book("B1", "One");
        // 20 minutes on Wed 2026-11-18, a night hour.
        t.log("2026-11-18", "B1", "app", "h22", 1200);
        t
    }

    #[test]
    fn preview_is_live_and_never_stored() {
        let t = week_db("wrap-preview");
        let now = at("2026-11-22 19:00");
        let p = pending(t.db(), now).unwrap();
        assert_eq!(p.len(), 1);
        assert!(p[0].preview && !p[0].seen);
        assert_eq!((p[0].kind.as_str(), p[0].period_start.as_str(), p[0].period_end.as_str()), ("week", "2026-11-16", "2026-11-22"));
        let doc = get(t.db(), "week", "2026-11-16", now).unwrap();
        assert!(doc.preview && !doc.stats.is_complete);
        assert_eq!(doc.stats.total_sec, 1200);
        // More reading shows up at once (not a snapshot).
        t.log("2026-11-22", "B1", "app", "h18", 600);
        assert_eq!(get(t.db(), "week", "2026-11-16", now).unwrap().stats.total_sec, 1800);
        let stored: i64 = t.db().0.lock().unwrap().query_row("SELECT COUNT(*) FROM wrap", [], |r| r.get(0)).unwrap();
        assert_eq!(stored, 0);
    }

    #[test]
    fn finished_period_is_snapshotted_once() {
        let t = week_db("wrap-snapshot");
        let after = at("2026-11-23 09:00");
        let p = pending(t.db(), after).unwrap();
        assert_eq!(p.len(), 1);
        assert!(!p[0].preview);
        // Reading logged afterwards for that week does not change the card.
        t.log("2026-11-19", "B1", "app", "h10", 3000);
        let doc = get(t.db(), "week", "2026-11-16", after).unwrap();
        assert!(!doc.preview && doc.stats.is_complete);
        assert_eq!(doc.stats.total_sec, 1200);
        // Layout and seed are kept with it.
        save_layout(t.db(), "week", "2026-11-16", r#"{"stickers":[]}"#, 4, after).unwrap();
        assert!(save_layout(t.db(), "week", "2026-11-16", "not json", 4, after).is_err());
        let doc = get(t.db(), "week", "2026-11-16", after).unwrap();
        assert_eq!((doc.layout_json.as_deref(), doc.seed, doc.seen), (Some(r#"{"stickers":[]}"#), 4, false));
        // In the history, and seen once opened.
        let l = list(t.db()).unwrap();
        assert_eq!(l.len(), 1);
        assert!(l[0].has_layout && !l[0].seen && !l[0].preview);
        mark_seen(t.db(), "week", "2026-11-16", after).unwrap();
        assert!(pending(t.db(), after).unwrap().is_empty());
        assert!(list(t.db()).unwrap()[0].seen);
    }

    #[test]
    fn preview_choices_survive_until_the_snapshot() {
        let t = week_db("wrap-preview-layout");
        let now = at("2026-11-22 19:00");
        // The reader rearranges the preview and rerolls the background.
        save_layout(t.db(), "week", "2026-11-16", r#"{"stickers":[1]}"#, 2, now).unwrap();
        let doc = get(t.db(), "week", "2026-11-16", now).unwrap();
        assert!(doc.preview);
        assert_eq!((doc.layout_json.as_deref(), doc.seed), (Some(r#"{"stickers":[1]}"#), 2));
        // The row holds the choices only: no numbers, nothing in the history.
        assert!(list(t.db()).unwrap().is_empty());
        let p = pending(t.db(), now).unwrap();
        assert_eq!((p.len(), p[0].has_layout, p[0].seed), (1, true, 2));
        // Live numbers still follow the reading.
        t.log("2026-11-22", "B1", "app", "h18", 600);
        assert_eq!(get(t.db(), "week", "2026-11-16", now).unwrap().stats.total_sec, 1800);
        // Once the week is over the snapshot fills the same row.
        let after = at("2026-11-23 09:00");
        t.log("2026-11-19", "B1", "app", "h10", 3000); // still inside the week
        let doc = get(t.db(), "week", "2026-11-16", after).unwrap();
        assert!(!doc.preview);
        assert_eq!(doc.stats.total_sec, 1200 + 600 + 3000);
        assert_eq!((doc.layout_json.as_deref(), doc.seed), (Some(r#"{"stickers":[1]}"#), 2));
        let rows: i64 = t.db().0.lock().unwrap().query_row("SELECT COUNT(*) FROM wrap", [], |r| r.get(0)).unwrap();
        assert_eq!(rows, 1);
        let l = list(t.db()).unwrap();
        assert_eq!((l.len(), l[0].has_layout, l[0].seed), (1, true, 2));
        // Later reading does not change the snapshot, and the layout stays.
        t.log("2026-11-20", "B1", "app", "h10", 900);
        let doc = get(t.db(), "week", "2026-11-16", after).unwrap();
        assert_eq!(doc.stats.total_sec, 4800);
        assert_eq!(doc.layout_json.as_deref(), Some(r#"{"stickers":[1]}"#));
    }

    #[test]
    fn dismissed_preview_is_not_offered_again() {
        let t = week_db("wrap-dismiss");
        let now = at("2026-11-22 19:00");
        assert_eq!(pending(t.db(), now).unwrap().len(), 1);
        mark_seen(t.db(), "week", "2026-11-16", now).unwrap();
        assert!(pending(t.db(), now).unwrap().is_empty());
        assert!(pending(t.db(), at("2026-11-22 23:00")).unwrap().is_empty());
        // Not in the history either (nothing saved), but the choice is kept
        // through the snapshot and the finished card is not offered again.
        assert!(list(t.db()).unwrap().is_empty());
        let after = at("2026-11-23 09:00");
        assert!(pending(t.db(), after).unwrap().is_empty());
        let l = list(t.db()).unwrap();
        assert_eq!((l.len(), l[0].seen), (1, true));
        assert!(get(t.db(), "week", "2026-11-16", after).unwrap().seen);
        // A period that has not begun cannot be touched.
        assert!(mark_seen(t.db(), "week", "2026-11-30", now).is_err());
        assert!(save_layout(t.db(), "week", "2026-11-30", "{}", 1, now).is_err());
    }

    #[test]
    fn list_has_only_snapshotted_rows() {
        let t = week_db("wrap-list-data");
        let now = at("2026-11-22 19:00");
        save_layout(t.db(), "week", "2026-11-16", "{}", 1, now).unwrap();
        mark_seen(t.db(), "month", "2026-11-01", now).unwrap();
        let rows: i64 = t.db().0.lock().unwrap().query_row("SELECT COUNT(*) FROM wrap", [], |r| r.get(0)).unwrap();
        assert_eq!(rows, 2);
        assert!(list(t.db()).unwrap().is_empty());
    }

    #[test]
    fn empty_periods_are_not_offered_and_bad_periods_fail() {
        let t = TempDb::new("wrap-empty");
        assert!(pending(t.db(), at("2026-11-22 19:00")).unwrap().is_empty());
        assert!(pending(t.db(), at("2026-11-23 09:00")).unwrap().is_empty());
        assert!(get(t.db(), "week", "2026-11-17", at("2026-11-23 09:00")).is_err()); // a Tuesday
        assert!(get(t.db(), "month", "2026-11-02", at("2026-12-23 09:00")).is_err());
        assert!(get(t.db(), "all", "2026-01-01", at("2026-12-23 09:00")).is_err());
        // A finished period with no reading is shown but not saved.
        let doc = get(t.db(), "week", "2026-11-16", at("2026-11-23 09:00")).unwrap();
        assert_eq!(doc.stats.total_sec, 0);
        assert!(list(t.db()).unwrap().is_empty());
    }

    #[test]
    fn deleted_wrap_leaves_the_history_and_stays_away() {
        let t = week_db("wrap-delete");
        let after = at("2026-11-23 09:00");
        assert_eq!(pending(t.db(), after).unwrap().len(), 1);
        assert_eq!(list(t.db()).unwrap().len(), 1);
        delete(t.db(), "week", "2026-11-16").unwrap();
        assert!(list(t.db()).unwrap().is_empty());
        // Not offered, and asking for numbers does not save them again.
        assert!(pending(t.db(), after).unwrap().is_empty());
        assert!(list(t.db()).unwrap().is_empty());
        let doc = get(t.db(), "week", "2026-11-16", after).unwrap();
        assert!(doc.stats.total_sec > 0 && doc.layout_json.is_none() && doc.seen);
        assert!(list(t.db()).unwrap().is_empty());
        // Deleting what is not saved, or twice, is fine; a bad period is not.
        delete(t.db(), "week", "2026-11-16").unwrap();
        delete(t.db(), "month", "2026-10-01").unwrap();
        assert!(delete(t.db(), "week", "2026-11-17").is_err());
        // Opening it (marking it seen) brings it back.
        mark_seen(t.db(), "week", "2026-11-16", after).unwrap();
        get(t.db(), "week", "2026-11-16", after).unwrap();
        assert_eq!(list(t.db()).unwrap().len(), 1);
    }

    #[test]
    fn history_is_newest_first() {
        let t = TempDb::new("wrap-list");
        t.add_book("B1", "One");
        t.log("2026-11-18", "B1", "app", "h20", 1200);
        t.log("2026-10-05", "B1", "app", "h20", 1200);
        let now = at("2026-12-01 12:00");
        for (kind, start) in [("week", "2026-10-05"), ("month", "2026-10-01"), ("month", "2026-11-01"), ("week", "2026-11-16")] {
            get(t.db(), kind, start, now).unwrap();
        }
        let got: Vec<_> = list(t.db()).unwrap().into_iter().map(|w| (w.kind, w.period_start)).collect();
        assert_eq!(
            got,
            [("month", "2026-11-01"), ("week", "2026-11-16"), ("month", "2026-10-01"), ("week", "2026-10-05")]
                .map(|(k, s)| (k.to_string(), s.to_string()))
        );
    }
}
