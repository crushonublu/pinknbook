//! Time a book was open in the Kindle app on this phone (Android).
//!
//! Android records which app screen is shown. Once the user grants "Usage
//! access" in the system settings, `MainActivity.kindleForegroundSessions`
//! lists when a reading screen of `com.amazon.kindle` was shown (not its
//! library or store), and that time is logged as measured reading
//! (`reading_log.source = 'kindle_app'`, one row per hour of the day).
//!
//! Each pass reads from a checkpoint (`kindle_usage_until_ms`) to now and
//! advances it, so a span is never stored twice. A session still open at the
//! end of a pass is not stored: the checkpoint stays at its start and the next
//! pass reads it whole. Android does not say which book was open: the books
//! whose Kindle position moved while it was (`stats::PHONE_SLOT` rows, written
//! by the Kindle pass just before) share the time by how far each moved.

use chrono::{Duration, Local, NaiveDate, TimeZone, Timelike};
use serde::Serialize;
use std::collections::BTreeMap;
use tauri::{AppHandle, Manager, State};

use crate::db::Db;
use crate::stats::{day_and_slot_naive, kindle_app_usage_on, set_setting, setting};

/// `reading_log.source` of this reading.
pub(crate) const SOURCE: &str = "kindle_app";
/// Where the time goes when no book can be named: counted in the totals,
/// never listed as a book.
pub(crate) const PSEUDO_ASIN: &str = "kindle:app";
const CHECKPOINT: &str = "kindle_usage_until_ms";
/// Android keeps about a week of usage events.
const LOOKBACK_MS: i64 = 7 * 24 * 3600 * 1000;
/// Shorter sessions (a glance at the app) are not reading.
const MIN_SESSION_MS: i64 = 60_000;
/// One session counts for at most this long (the app left open on a table).
const MAX_SESSION_MS: i64 = 4 * 3600 * 1000;
/// Sessions this close are one: moving between two screens of the app pauses
/// one and resumes the other a moment later.
const MERGE_GAP_MS: i64 = 10_000;

/// Sorted, overlapping or nearly touching sessions joined, empty ones dropped.
pub(crate) fn merge_sessions(mut sessions: Vec<(i64, i64)>) -> Vec<(i64, i64)> {
    sessions.retain(|(s, e)| e > s);
    sessions.sort();
    let mut out: Vec<(i64, i64)> = vec![];
    for (s, e) in sessions {
        match out.last_mut() {
            Some(last) if s - last.1 <= MERGE_GAP_MS => last.1 = last.1.max(e),
            _ => out.push((s, e)),
        }
    }
    out
}

/// The answer of `kindleForegroundSessions`: `[[startMs,endMs],...]`, or
/// `!reason`.
pub(crate) fn parse_sessions(reply: &str) -> Result<Vec<(i64, i64)>, String> {
    if let Some(reason) = reply.strip_prefix('!') {
        return Err(reason.to_string());
    }
    let list: Vec<(i64, i64)> = serde_json::from_str(reply).map_err(|e| format!("bad sessions: {e}"))?;
    Ok(merge_sessions(list))
}

/// Split the sessions of one pass into those to store and the checkpoint of
/// the next pass: a session that reaches `to_ms` is still open, so the next
/// pass starts where it began; otherwise at `to_ms`.
pub(crate) fn settle(sessions: &[(i64, i64)], to_ms: i64) -> (Vec<(i64, i64)>, i64) {
    match sessions.last() {
        Some(&(start, end)) if end >= to_ms => (sessions[..sessions.len() - 1].to_vec(), start),
        _ => (sessions.to_vec(), to_ms),
    }
}

/// The end a session counts up to: `None` under 60 s, at most 4 h after it began.
fn counted_end(start: i64, end: i64) -> Option<i64> {
    let end = end.min(start + MAX_SESSION_MS);
    (end - start >= MIN_SESSION_MS).then_some(end)
}

/// Milliseconds of reading in the sessions, counted like `sessions_to_slots`.
pub(crate) fn counted_ms(sessions: &[(i64, i64)]) -> i64 {
    sessions.iter().filter_map(|&(s, e)| counted_end(s, e).map(|e| e - s)).sum()
}

/// Seconds per (reading day, hour slot `hNN`): sessions under 60 s dropped,
/// one session capped at 4 h, split where the local hour changes. The reading
/// day starts at 04:00 like everywhere else.
pub(crate) fn sessions_to_slots<Tz: TimeZone>(sessions: &[(i64, i64)], tz: &Tz) -> Vec<(NaiveDate, String, i64)> {
    let mut millis: BTreeMap<(NaiveDate, String), i64> = BTreeMap::new();
    for &(start, end) in sessions {
        let Some(end) = counted_end(start, end) else { continue };
        let mut cur = start;
        while cur < end {
            let Some(local) = tz.timestamp_millis_opt(cur).single().map(|t| t.naive_local()) else { break };
            let hour_start = local.with_minute(0).and_then(|t| t.with_second(0)).and_then(|t| t.with_nanosecond(0)).unwrap_or(local);
            // Around a clock change this can be an hour off, never zero or negative.
            let to_boundary = ((hour_start + Duration::hours(1)) - local).num_milliseconds().max(1);
            let step = to_boundary.min(end - cur);
            *millis.entry(day_and_slot_naive(local)).or_default() += step;
            cur += step;
        }
    }
    millis
        .into_iter()
        .filter_map(|((day, slot), ms)| {
            let secs = (ms + 500) / 1000;
            (secs > 0).then_some((day, slot, secs))
        })
        .collect()
}

/// The books a day's Kindle-app time goes to, each with how far it moved: those
/// whose move was read in the Kindle app here (`PHONE_SLOT`); else the one
/// with the most Kindle estimate that day; else the Amazon book read most
/// recently; else the pseudo book.
fn books_for_day(conn: &rusqlite::Connection, day: NaiveDate, recent: Option<&str>) -> Vec<(String, i64)> {
    let moved: Vec<(String, i64)> = conn
        .prepare(
            "SELECT asin, SUM(positions) FROM reading_log
             WHERE day = ?1 AND source = 'kindle' AND slot = ?2 AND positions > 0
             GROUP BY asin ORDER BY asin",
        )
        .and_then(|mut st| {
            st.query_map(rusqlite::params![day.to_string(), crate::stats::PHONE_SLOT], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect()
        })
        .unwrap_or_default();
    if !moved.is_empty() {
        return moved;
    }
    let book = conn
        .query_row(
            "SELECT asin FROM reading_log WHERE day = ?1 AND source = 'kindle' AND seconds > 0
             GROUP BY asin ORDER BY SUM(seconds) DESC, asin LIMIT 1",
            [day.to_string()],
            |r| r.get::<_, String>(0),
        )
        .ok()
        .or_else(|| recent.map(str::to_string))
        .unwrap_or_else(|| PSEUDO_ASIN.to_string());
    vec![(book, 1)]
}

/// `seconds` shared by weight; the shares add up to it exactly (the seconds
/// rounded away go to the heaviest). Empty shares are left out.
pub(crate) fn share_by_weight(seconds: i64, weights: &[(String, i64)]) -> Vec<(String, i64)> {
    let total: i64 = weights.iter().map(|w| w.1.max(0)).sum();
    if total <= 0 {
        return vec![];
    }
    let mut out: Vec<(String, i64)> = weights.iter().map(|(a, w)| (a.clone(), seconds * (*w).max(0) / total)).collect();
    let rest = seconds - out.iter().map(|s| s.1).sum::<i64>();
    if let Some(heaviest) = (0..weights.len()).max_by_key(|&i| (weights[i].1, std::cmp::Reverse(i))) {
        out[heaviest].1 += rest;
    }
    out.retain(|s| s.1 > 0);
    out
}

/// The Amazon book read most recently in the app.
fn recent_amazon_book(db: &Db) -> Option<String> {
    let rows = db.list_library().ok()?;
    rows.into_iter().filter(|r| r.source == "amazon" && r.last_read.is_some()).max_by(|a, b| a.last_read.cmp(&b.last_read)).map(|r| r.asin)
}

/// Store the closed sessions and move the checkpoint, together.
pub(crate) fn store<Tz: TimeZone>(db: &Db, closed: &[(i64, i64)], next_from: i64, tz: &Tz) -> Result<(), String> {
    let slots = sessions_to_slots(closed, tz);
    let recent = if slots.is_empty() { None } else { recent_amazon_book(db) };
    let mut conn = db.0.lock().unwrap();
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut books: BTreeMap<NaiveDate, Vec<(String, i64)>> = BTreeMap::new();
    for (day, slot, seconds) in &slots {
        let weights = books.entry(*day).or_insert_with(|| books_for_day(&tx, *day, recent.as_deref()));
        for (asin, share) in share_by_weight(*seconds, weights) {
            tx.execute(
                "INSERT INTO reading_log (day, asin, source, slot, seconds) VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(day, asin, source, slot) DO UPDATE SET seconds = seconds + excluded.seconds",
                rusqlite::params![day.to_string(), asin, SOURCE, slot, share],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    tx.execute(
        "INSERT INTO app_setting (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![CHECKPOINT, next_from.to_string()],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

// ---- Android --------------------------------------------------------------------------

#[cfg(target_os = "android")]
async fn has_access(app: &AppHandle) -> Result<bool, String> {
    crate::android::on_activity(app, |env, activity| env.call_method(activity, "hasUsageAccess", "()Z", &[])?.z()).await
}

#[cfg(target_os = "android")]
async fn foreground_sessions(app: &AppHandle, from_ms: i64, to_ms: i64) -> Result<String, String> {
    use jni::objects::JValue;
    crate::android::on_activity(app, move |env, activity| {
        crate::android::call_string(
            env,
            activity,
            "kindleForegroundSessions",
            "(JJ)Ljava/lang/String;",
            &[JValue::Long(from_ms), JValue::Long(to_ms)],
        )
    })
    .await
}

#[cfg(target_os = "android")]
async fn open_settings(app: &AppHandle) -> Result<(), String> {
    crate::android::on_activity(app, |env, activity| env.call_method(activity, "openUsageAccessSettings", "()V", &[]).map(|_| ())).await
}

#[cfg(not(target_os = "android"))]
async fn has_access(_app: &AppHandle) -> Result<bool, String> {
    Ok(false)
}

#[cfg(not(target_os = "android"))]
async fn foreground_sessions(_app: &AppHandle, _from_ms: i64, _to_ms: i64) -> Result<String, String> {
    Err("not_supported".into())
}

#[cfg(not(target_os = "android"))]
async fn open_settings(_app: &AppHandle) -> Result<(), String> {
    Err("Usage access is only available on Android".into())
}

/// One pass: log the time the Kindle app was on screen since the last pass.
/// Does nothing until the user has granted usage access.
pub(crate) async fn tick(app: &AppHandle) -> Result<(), String> {
    if !has_access(app).await? {
        return Ok(());
    }
    let db: State<Db> = app.state();
    let now = Local::now().timestamp_millis();
    if !kindle_app_usage_on(&db) {
        // Switched off: what happens meanwhile is not measured later either.
        return set_setting(&db, CHECKPOINT, &now.to_string());
    }
    let saved = setting(&db, CHECKPOINT).and_then(|v| v.parse::<i64>().ok());
    let from = saved.unwrap_or(now - LOOKBACK_MS).clamp(now - LOOKBACK_MS, now);
    let sessions = parse_sessions(&foreground_sessions(app, from, now).await?)?;
    let (closed, next) = settle(&sessions, now);
    store(&db, &closed, next, &Local)
}

/// Seconds a book was open in the Kindle app here between two instants
/// (epoch ms), or `None` when that is not measured (not Android, no usage
/// access, switched off, or Android did not answer).
pub(crate) async fn measured_secs(app: &AppHandle, from_ms: i64, to_ms: i64) -> Option<i64> {
    if to_ms <= from_ms || !has_access(app).await.ok()? {
        return None;
    }
    if !kindle_app_usage_on(&app.state::<Db>()) {
        return None;
    }
    let sessions = parse_sessions(&foreground_sessions(app, from_ms, to_ms).await.ok()?).ok()?;
    Some(counted_ms(&sessions) / 1000)
}

/// Can this app see what is on screen, and is it measuring?
#[derive(Debug, Serialize)]
pub struct UsageStatus {
    /// Android only.
    pub supported: bool,
    /// "Usage access" was granted in the system settings.
    pub granted: bool,
    /// The setting (on unless switched off).
    pub enabled: bool,
}

#[tauri::command]
pub async fn kindle_usage_status(app: AppHandle) -> Result<UsageStatus, String> {
    let db: State<Db> = app.state();
    Ok(UsageStatus {
        supported: cfg!(target_os = "android"),
        granted: has_access(&app).await.unwrap_or(false),
        enabled: kindle_app_usage_on(&db),
    })
}

/// Open the system's "Usage access" screen.
#[tauri::command]
pub async fn kindle_usage_open_settings(app: AppHandle) -> Result<(), String> {
    open_settings(&app).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stats::testing::{d, TempDb};
    use chrono::{FixedOffset, Utc};

    const H: i64 = 3600 * 1000;
    const MIN: i64 = 60 * 1000;

    /// 2026-11-18 00:00 UTC.
    fn t0() -> i64 {
        Utc.with_ymd_and_hms(2026, 11, 18, 0, 0, 0).unwrap().timestamp_millis()
    }

    #[test]
    fn short_sessions_drop_long_ones_are_capped() {
        let base = t0() + 10 * H; // 10:00
        let slots = sessions_to_slots(&[(base, base + 59_999), (base + H, base + H + MIN)], &Utc);
        assert_eq!(slots, [(d("2026-11-18"), "h11".to_string(), 60)]);
        // Six hours open count for four.
        let slots = sessions_to_slots(&[(base, base + 6 * H)], &Utc);
        assert_eq!(slots.iter().map(|s| s.2).sum::<i64>(), 4 * 3600);
        assert_eq!(slots.len(), 4);
    }

    #[test]
    fn sessions_split_at_the_hour_and_the_day_starts_at_four() {
        // 09:50 - 10:20 -> 10 minutes in h09, 20 in h10.
        let a = t0() + 9 * H + 50 * MIN;
        let slots = sessions_to_slots(&[(a, a + 30 * MIN)], &Utc);
        assert_eq!(slots, [(d("2026-11-18"), "h09".to_string(), 600), (d("2026-11-18"), "h10".to_string(), 1200)]);
        // 03:30 - 04:30 crosses the start of the reading day.
        let b = t0() + 3 * H + 30 * MIN;
        let slots = sessions_to_slots(&[(b, b + H)], &Utc);
        assert_eq!(slots, [(d("2026-11-17"), "h03".to_string(), 1800), (d("2026-11-18"), "h04".to_string(), 1800)]);
        // Two sessions in one hour add up.
        let c = t0() + 20 * H;
        let slots = sessions_to_slots(&[(c, c + 5 * MIN), (c + 30 * MIN, c + 40 * MIN)], &Utc);
        assert_eq!(slots, [(d("2026-11-18"), "h20".to_string(), 900)]);
    }

    #[test]
    fn hours_are_local_hours() {
        // 17:00 UTC is 00:00 the next day at +07:00: still the reading day before.
        let tz = FixedOffset::east_opt(7 * 3600).unwrap();
        let a = t0() + 17 * H + 10 * MIN;
        assert_eq!(sessions_to_slots(&[(a, a + 5 * MIN)], &tz), [(d("2026-11-18"), "h00".to_string(), 300)]);
        // A half-hour zone still splits on its own local hour.
        let tz = FixedOffset::east_opt(5 * 3600 + 1800).unwrap();
        let a = t0() + 4 * H + 40 * MIN; // 10:10 local
        assert_eq!(
            sessions_to_slots(&[(a, a + 60 * MIN)], &tz),
            [(d("2026-11-18"), "h10".to_string(), 3000), (d("2026-11-18"), "h11".to_string(), 600)]
        );
    }

    #[test]
    fn replies_are_parsed_and_screens_of_the_app_are_one_session() {
        assert_eq!(parse_sessions("[[1000,5000],[9000,20000],[100000,120000]]"), Ok(vec![(1000, 20000), (100000, 120000)]));
        assert_eq!(parse_sessions("[]"), Ok(vec![]));
        assert_eq!(parse_sessions("!no_access"), Err("no_access".to_string()));
        assert!(parse_sessions("oops").is_err());
        assert_eq!(merge_sessions(vec![(50, 40), (5, 10)]), [(5, 10)]);
    }

    #[test]
    fn an_open_session_waits_for_the_next_pass() {
        let now = 1_000_000;
        assert_eq!(settle(&[(10, 20), (500_000, now)], now), (vec![(10, 20)], 500_000));
        assert_eq!(settle(&[(10, 20)], now), (vec![(10, 20)], now));
        assert_eq!(settle(&[], now), (vec![], now));
    }

    #[test]
    fn passes_never_store_a_span_twice() {
        let t = TempDb::new("kindle-app");
        let db = t.db();
        let ck = |db: &Db| setting(db, CHECKPOINT).unwrap();
        let rows = |db: &Db| -> Vec<(String, String, i64)> {
            db.0.lock()
                .unwrap()
                .prepare("SELECT asin, slot, seconds FROM reading_log WHERE source = 'kindle_app' ORDER BY slot")
                .unwrap()
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap()
        };
        let start = t0() + 10 * H;
        // Pass 1 sees a closed session and one still open at "now".
        let now1 = start + 3 * H;
        let sessions = [(start, start + 10 * MIN), (start + 2 * H, now1)];
        let (closed, next) = settle(&sessions, now1);
        store(db, &closed, next, &Utc).unwrap();
        assert_eq!((ck(db), rows(db)), ((start + 2 * H).to_string(), vec![(PSEUDO_ASIN.to_string(), "h10".to_string(), 600)]));
        // Pass 2 starts at the checkpoint and sees that session whole, now closed.
        let now2 = start + 5 * H;
        let sessions = [(start + 2 * H, start + 2 * H + 30 * MIN)];
        let (closed, next) = settle(&sessions, now2);
        store(db, &closed, next, &Utc).unwrap();
        assert_eq!(ck(db), now2.to_string());
        assert_eq!(
            rows(db),
            [(PSEUDO_ASIN, "h10", 600), (PSEUDO_ASIN, "h12", 1800)].map(|(a, s, n)| (a.to_string(), s.to_string(), n))
        );
    }

    #[test]
    fn the_time_goes_to_the_book_with_the_most_kindle_estimate() {
        let t = TempDb::new("kindle-app-book");
        let db = t.db();
        t.add_book("A", "A");
        t.add_book("B", "B");
        t.log("2026-11-18", "A", "kindle", "h09", 300);
        t.log("2026-11-18", "B", "kindle", "h09", 900);
        let at = t0() + 20 * H;
        store(db, &[(at, at + 10 * MIN), (at + 24 * H, at + 24 * H + 10 * MIN)], at, &Utc).unwrap();
        let conn = db.0.lock().unwrap();
        let book = |day: &str| -> String {
            conn.query_row("SELECT asin FROM reading_log WHERE source = 'kindle_app' AND day = ?1", [day], |r| r.get(0)).unwrap()
        };
        assert_eq!(book("2026-11-18"), "B");
        // No estimate that day: no library book has been read in the app either, so the pseudo book.
        assert_eq!(book("2026-11-19"), PSEUDO_ASIN);
    }

    #[test]
    fn the_books_that_moved_while_the_phone_read_share_its_time() {
        let t = TempDb::new("kindle-app-phone");
        let db = t.db();
        for b in ["A", "B", "C"] {
            t.add_book(b, b);
        }
        // C was read on another device (an estimate with seconds); A and B moved while the phone read, A three times as far.
        t.log("2026-11-18", "C", "kindle", "h08", 1200);
        db.0.lock()
            .unwrap()
            .execute_batch(
                "INSERT INTO reading_log (day, asin, source, slot, seconds, positions) VALUES
                 ('2026-11-18', 'A', 'kindle', 'kindle_phone', 0, 3000),
                 ('2026-11-18', 'B', 'kindle', 'kindle_phone', 0, 1000);",
            )
            .unwrap();
        let at = t0() + 20 * H;
        store(db, &[(at, at + 10 * MIN + 1000)], at, &Utc).unwrap(); // 601 s
        let conn = db.0.lock().unwrap();
        let rows: Vec<(String, i64)> = conn
            .prepare("SELECT asin, seconds FROM reading_log WHERE source = 'kindle_app' ORDER BY asin")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(rows, [("A".to_string(), 451), ("B".to_string(), 150)]);
    }

    #[test]
    fn shares_add_up_exactly() {
        let w = |v: &[(&str, i64)]| v.iter().map(|(a, n)| (a.to_string(), *n)).collect::<Vec<_>>();
        assert_eq!(share_by_weight(100, &w(&[("A", 1), ("B", 1), ("C", 1)])), w(&[("A", 34), ("B", 33), ("C", 33)]));
        assert_eq!(share_by_weight(10, &w(&[("A", 1), ("B", 9)])), w(&[("A", 1), ("B", 9)]));
        // A share rounded to nothing is left out; its second goes to the heaviest.
        assert_eq!(share_by_weight(3, &w(&[("A", 1), ("B", 100)])), w(&[("B", 3)]));
        assert_eq!(share_by_weight(50, &w(&[("A", 0)])), vec![]);
        assert_eq!(share_by_weight(50, &[]), vec![]);
    }

    #[test]
    fn measured_time_counts_like_the_stored_time() {
        assert_eq!(counted_ms(&[(0, 59_999), (100_000, 200_000), (1_000_000, 1_000_000 + 5 * H)]), 100_000 + 4 * H);
    }
}
