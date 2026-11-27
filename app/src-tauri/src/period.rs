//! Week / month / year / all-time views of the reading log, for the Stats
//! page and the wrap-up cards.
//!
//! Everything is computed from the same log as the summary (see `stats.rs`):
//! the reading day starts at 04:00, Kindle estimates follow the user's
//! setting, paper reading typed in by hand always counts. A week runs Monday
//! to Sunday.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use chrono::{Datelike, Duration, Local, NaiveDate, NaiveDateTime, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::Db;
use crate::genre;
use crate::meta;
use crate::stats::{
    compute_streak, goal_minutes, kindle_estimates_on, met_days, paper_titles, per_day, read_log, reading_day, slot_class,
    slot_hour, sync_book_events, Events, SlotClass,
};

/// Books read for less than this in a period do not count as "read".
const MIN_BOOK_SECONDS: i64 = 60;
/// Most books in `top_books`.
const TOP_BOOKS: usize = 5;
/// A book finished within this many days of its first reading is a fast finish.
const FAST_FINISH_DAYS: i64 = 7;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DayBook {
    pub asin: String,
    pub seconds: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PeriodDay {
    pub day: String,
    /// Measured in the in-app reader.
    pub app_sec: i64,
    /// Estimated from Kindle progress (0 when estimates are off).
    pub kindle_sec: i64,
    /// Typed in by hand.
    pub manual_sec: i64,
    /// The daily goal was reached.
    pub met: bool,
    /// Books read that day, most first. Books no longer in the library are
    /// left out (their time still counts in the seconds above).
    pub books: Vec<DayBook>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FinishedBook {
    pub asin: String,
    pub title: String,
    pub day: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TopBook {
    pub asin: String,
    pub title: String,
    pub author: String,
    pub seconds: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GenreShare {
    pub id: String,
    /// Books read (at least a minute) in the period with this genre.
    pub books: i64,
    pub seconds: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BestDay {
    pub day: String,
    pub seconds: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MonthStat {
    /// `YYYY-MM`.
    pub month: String,
    pub days_read: i64,
    pub seconds: i64,
    pub finished: i64,
}

/// The facts the rule-based reader profile is written from.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Persona {
    /// Share (0..1) of the reading with a time of day that fell at night
    /// (00:00-03:59).
    pub night_share: f64,
    /// Same for the early morning (04:00-05:59).
    pub early_share: f64,
    pub top_genre: Option<String>,
    /// Change of the total against the previous period, percent; `None` when
    /// there is no previous period or nothing was read in it.
    pub trend_pct: Option<f64>,
    pub avg_min_per_reading_day: f64,
    /// Books finished in the period within a week of first being read.
    pub fast_finishes: i64,
}

/// What the UI needs to draw a book (cover file under `<app_data>/covers`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BookRef {
    pub title: String,
    pub author: String,
    pub cover: Option<String>,
    pub spine_color: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PeriodStats {
    /// "week" | "month" | "year" | "all".
    pub kind: String,
    /// First and last reading day (inclusive). "all" starts at the first
    /// reading or finish on record and ends today.
    pub start: String,
    pub end: String,
    /// The period is over (its last day is before today).
    pub is_complete: bool,
    /// The period before (None for "all").
    pub prev_start: Option<String>,
    pub prev_end: Option<String>,
    /// Every day from `start` to `end`, including days still to come.
    pub days: Vec<PeriodDay>,
    pub total_sec: i64,
    pub prev_total_sec: i64,
    /// Days with any reading.
    pub days_read: i64,
    pub days_met: i64,
    /// Longest run of goal days inside the period (a missed day a week is
    /// forgiven, as for the streak).
    pub streak_best_in_period: i64,
    pub current_streak: i64,
    /// Books finished in the period (finishes seen before pntome kept dates
    /// are in no period).
    pub finished: Vec<FinishedBook>,
    /// For "all": how many books were already finished when the app first
    /// looked (they have no date); 0 otherwise.
    pub finished_undated: i64,
    pub top_books: Vec<TopBook>,
    /// Genres of the books read, most books first.
    pub genres: Vec<GenreShare>,
    pub genre_unknown_books: i64,
    /// Seconds per local hour of day; only reading logged with an hour.
    pub hours: [i64; 24],
    /// First day any reading was logged with an hour (the chart is partial
    /// before it); `None` if there is none.
    pub hours_since: Option<String>,
    /// Highlights (all, notes included), notes and saved words created in the
    /// period.
    pub highlights: i64,
    pub notes: i64,
    pub words: i64,
    pub best_day: Option<BestDay>,
    /// Per month, for "year" and "all".
    pub months: Vec<MonthStat>,
    pub persona: Persona,
    /// Every book mentioned above, by asin.
    pub books: BTreeMap<String, BookRef>,
}

fn ymd(y: i32, m: u32, d: u32) -> NaiveDate {
    NaiveDate::from_ymd_opt(y, m, d).expect("valid date")
}

/// First and last day of the week / month / year containing `anchor`.
pub(crate) fn bounds(kind: &str, anchor: NaiveDate) -> Option<(NaiveDate, NaiveDate)> {
    match kind {
        "week" => {
            let start = anchor - Duration::days(anchor.weekday().num_days_from_monday() as i64);
            Some((start, start + Duration::days(6)))
        }
        "month" => {
            let start = ymd(anchor.year(), anchor.month(), 1);
            let next = if anchor.month() == 12 { ymd(anchor.year() + 1, 1, 1) } else { ymd(anchor.year(), anchor.month() + 1, 1) };
            Some((start, next - Duration::days(1)))
        }
        "year" => Some((ymd(anchor.year(), 1, 1), ymd(anchor.year(), 12, 31))),
        _ => None,
    }
}

/// A SQLite UTC timestamp as the local reading day it falls on.
fn utc_reading_day(created_at: &str) -> Option<NaiveDate> {
    let utc = NaiveDateTime::parse_from_str(created_at, "%Y-%m-%d %H:%M:%S").ok()?;
    Some(reading_day(Utc.from_utc_datetime(&utc).with_timezone(&Local).naive_local()))
}

/// The reading day and the second column (a flag) of every row `sql` selects
/// as `created_at, flag`.
fn created_days(conn: &rusqlite::Connection, sql: &str) -> Vec<(NaiveDate, bool)> {
    conn.prepare(sql)
        .and_then(|mut s| {
            s.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, bool>(1)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(at, flag)| utc_reading_day(&at).map(|d| (d, flag)))
        .collect()
}

/// Statistics for the period of `kind` that contains `anchor` (default: the
/// reading day of `now`, the local wall clock).
pub(crate) fn period_stats(db: &Db, kind: &str, anchor: Option<NaiveDate>, now: NaiveDateTime) -> Result<PeriodStats, String> {
    if !matches!(kind, "week" | "month" | "year" | "all") {
        return Err(format!("unknown period kind: {kind}"));
    }
    let today = reading_day(now);
    let goal = goal_minutes(db);
    let use_kindle = kindle_estimates_on(db);
    let rows = db.list_library().map_err(|e| e.to_string())?;
    let lib: HashMap<&str, &crate::db::LibraryRow> = rows.iter().map(|r| (r.asin.as_str(), r)).collect();

    let conn = db.0.lock().unwrap();
    sync_book_events(&conn, &rows, today);
    let log = read_log(&conn, use_kindle)?;
    let by_day = per_day(&log);
    let events = Events::load(&conn);
    let paper = paper_titles(&conn);

    let finished_all: Vec<(&str, NaiveDate)> =
        events.of_kind("finished").filter(|(a, _)| lib.contains_key(a)).collect();

    // The period and the one before it.
    let (start, end, prev) = if kind == "all" {
        let first_log = by_day.keys().next().copied();
        let first_finish = finished_all.iter().map(|(_, d)| *d).min();
        let start = [first_log, first_finish].into_iter().flatten().min().unwrap_or(today).min(today);
        (start, today, None)
    } else {
        let (s, e) = bounds(kind, anchor.unwrap_or(today)).expect("kind checked");
        (s, e, bounds(kind, s - Duration::days(1)))
    };
    // Counts that are not per day ("all" takes everything on record).
    let (lo, hi) = if kind == "all" { (NaiveDate::MIN, NaiveDate::MAX) } else { (start, end) };
    let in_period = |d: NaiveDate| d >= lo && d <= hi;

    // Books reading time can be shown for.
    let book_ref = |asin: &str| -> Option<BookRef> {
        if let Some(r) = lib.get(asin) {
            Some(BookRef { title: r.title.clone(), author: r.author.clone(), cover: r.cover.clone(), spine_color: r.spine_color.clone() })
        } else {
            paper.get(asin).map(|t| BookRef {
                title: t.clone(),
                author: String::new(),
                cover: None,
                spine_color: meta::fallback_spine(asin),
            })
        }
    };

    let mut days = vec![];
    let mut seconds_per_book: HashMap<&str, i64> = HashMap::new();
    let mut d = start;
    while d <= end {
        let agg = by_day.get(&d);
        let mut books: Vec<DayBook> = agg
            .map(|a| {
                a.books
                    .iter()
                    .filter(|(asin, _)| book_ref(asin).is_some())
                    .map(|(asin, s)| DayBook { asin: asin.clone(), seconds: *s })
                    .collect()
            })
            .unwrap_or_default();
        books.sort_by(|a, b| b.seconds.cmp(&a.seconds).then_with(|| a.asin.cmp(&b.asin)));
        let total = agg.map_or(0, |a| a.total());
        days.push(PeriodDay {
            day: d.to_string(),
            app_sec: agg.map_or(0, |a| a.app),
            kindle_sec: agg.map_or(0, |a| a.kindle),
            manual_sec: agg.map_or(0, |a| a.manual),
            met: total >= goal * 60,
            books,
        });
        d += Duration::days(1);
    }
    for r in log.iter().filter(|r| r.day >= start && r.day <= end) {
        *seconds_per_book.entry(r.asin.as_str()).or_default() += r.seconds;
    }

    let total_sec: i64 = by_day.range(start..=end).map(|(_, a)| a.total()).sum();
    let prev_total_sec: i64 = prev.map_or(0, |(s, e)| by_day.range(s..=e).map(|(_, a)| a.total()).sum());
    let days_read = days.iter().filter(|x| x.app_sec + x.kindle_sec + x.manual_sec > 0).count() as i64;
    let days_met = days.iter().filter(|x| x.met).count() as i64;
    let met_in_period: HashSet<NaiveDate> = met_days(&by_day, goal).into_iter().filter(|d| *d >= start && *d <= end).collect();
    let streak_best_in_period = compute_streak(&met_in_period, end.min(today)).longest;
    let current_streak = compute_streak(&met_days(&by_day, goal), today).current;

    // Finished books.
    let mut finished: Vec<FinishedBook> = finished_all
        .iter()
        .filter(|(_, d)| in_period(*d))
        .map(|(a, d)| FinishedBook { asin: a.to_string(), title: lib[a].title.clone(), day: d.to_string() })
        .collect();
    finished.sort_by(|a, b| a.day.cmp(&b.day).then_with(|| a.title.cmp(&b.title)));
    let finished_undated = if kind == "all" {
        events.of_kind("finished_backfill").filter(|(a, _)| lib.contains_key(a)).count() as i64
    } else {
        0
    };
    let fast_finishes = finished
        .iter()
        .filter(|f| {
            let done = NaiveDate::parse_from_str(&f.day, "%Y-%m-%d").ok();
            match (events.day(&f.asin, "first_read"), done) {
                (Some(first), Some(done)) => (done - first).num_days() <= FAST_FINISH_DAYS,
                _ => false,
            }
        })
        .count() as i64;

    // Top books and genres, over books read for at least a minute.
    let mut read: Vec<(&str, i64)> = seconds_per_book
        .iter()
        .filter(|(a, s)| **s >= MIN_BOOK_SECONDS && book_ref(a).is_some())
        .map(|(a, s)| (*a, *s))
        .collect();
    read.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(b.0)));
    let top_books: Vec<TopBook> = read
        .iter()
        .take(TOP_BOOKS)
        .map(|(a, s)| {
            let b = book_ref(a).expect("filtered");
            TopBook { asin: a.to_string(), title: b.title, author: b.author, seconds: *s }
        })
        .collect();
    let no_subjects: Vec<String> = vec![];
    let genre_input: Vec<(&str, &[String])> =
        read.iter().map(|(a, _)| (*a, lib.get(a).map_or(&no_subjects[..], |r| &r.subjects[..]))).collect();
    let genre_of = genre::resolve(&conn, &genre_input);
    let mut by_genre: HashMap<&'static str, (i64, i64)> = HashMap::new();
    let mut genre_unknown_books = 0;
    for (a, s) in &read {
        match genre_of.get(*a).copied().flatten() {
            Some(g) => {
                let e = by_genre.entry(g).or_default();
                e.0 += 1;
                e.1 += s;
            }
            None => genre_unknown_books += 1,
        }
    }
    let mut genres: Vec<GenreShare> =
        by_genre.into_iter().map(|(id, (books, seconds))| GenreShare { id: id.to_string(), books, seconds }).collect();
    genres.sort_by(|a, b| b.books.cmp(&a.books).then_with(|| b.seconds.cmp(&a.seconds)).then_with(|| a.id.cmp(&b.id)));

    // Hours of the day, and how much of the reading has a time of day.
    let mut hours = [0i64; 24];
    let (mut night, mut early, mut timed) = (0i64, 0i64, 0i64);
    for r in log.iter().filter(|r| r.day >= start && r.day <= end) {
        if let Some(h) = slot_hour(&r.slot) {
            hours[h] += r.seconds;
        }
        match slot_class(&r.slot) {
            SlotClass::Manual => {}
            SlotClass::Night => (night, timed) = (night + r.seconds, timed + r.seconds),
            SlotClass::Early => (early, timed) = (early + r.seconds, timed + r.seconds),
            SlotClass::Day => timed += r.seconds,
        }
    }
    let hours_since = log.iter().filter(|r| slot_hour(&r.slot).is_some()).map(|r| r.day).min().map(|d| d.to_string());

    // Highlights, notes and words created in the period.
    let created = |sql: &str| -> Vec<(NaiveDate, bool)> {
        created_days(&conn, sql).into_iter().filter(|(d, _)| in_period(*d)).collect()
    };
    let marks = created("SELECT created_at, IFNULL(note,'') <> '' FROM annotation WHERE deleted = 0");
    let highlights = marks.len() as i64;
    let notes = marks.iter().filter(|(_, has_note)| *has_note).count() as i64;
    let words = created("SELECT created_at, 1 FROM vocab").len() as i64;

    let best_day = days
        .iter()
        .map(|x| (x, x.app_sec + x.kindle_sec + x.manual_sec))
        .filter(|(_, s)| *s > 0)
        .fold(None::<(&PeriodDay, i64)>, |best, (x, s)| match best {
            Some((_, b)) if b >= s => best,
            _ => Some((x, s)),
        })
        .map(|(x, s)| BestDay { day: x.day.clone(), seconds: s });

    let months = if matches!(kind, "year" | "all") {
        let mut per_month: BTreeMap<String, MonthStat> = BTreeMap::new();
        let mut m = ymd(start.year(), start.month(), 1);
        while m <= end {
            let key = format!("{:04}-{:02}", m.year(), m.month());
            per_month.insert(key.clone(), MonthStat { month: key, days_read: 0, seconds: 0, finished: 0 });
            m = if m.month() == 12 { ymd(m.year() + 1, 1, 1) } else { ymd(m.year(), m.month() + 1, 1) };
        }
        for x in &days {
            if let Some(ms) = per_month.get_mut(&x.day[..7]) {
                let s = x.app_sec + x.kindle_sec + x.manual_sec;
                ms.days_read += (s > 0) as i64;
                ms.seconds += s;
            }
        }
        for f in &finished {
            if let Some(ms) = per_month.get_mut(&f.day[..7]) {
                ms.finished += 1;
            }
        }
        per_month.into_values().collect()
    } else {
        vec![]
    };

    let share = |part: i64| if timed > 0 { part as f64 / timed as f64 } else { 0.0 };
    let persona = Persona {
        night_share: share(night),
        early_share: share(early),
        top_genre: genres.first().map(|g| g.id.clone()),
        trend_pct: (prev_total_sec > 0).then(|| (total_sec - prev_total_sec) as f64 * 100.0 / prev_total_sec as f64),
        avg_min_per_reading_day: if days_read > 0 { total_sec as f64 / 60.0 / days_read as f64 } else { 0.0 },
        fast_finishes,
    };

    let mut asins: BTreeSet<&str> = BTreeSet::new();
    asins.extend(days.iter().flat_map(|x| x.books.iter().map(|b| b.asin.as_str())));
    asins.extend(finished.iter().map(|f| f.asin.as_str()));
    asins.extend(top_books.iter().map(|b| b.asin.as_str()));
    let books: BTreeMap<String, BookRef> =
        asins.into_iter().filter_map(|a| book_ref(a).map(|b| (a.to_string(), b))).collect();

    Ok(PeriodStats {
        kind: kind.to_string(),
        start: start.to_string(),
        end: end.to_string(),
        is_complete: end < today,
        prev_start: prev.map(|(s, _)| s.to_string()),
        prev_end: prev.map(|(_, e)| e.to_string()),
        days,
        total_sec,
        prev_total_sec,
        days_read,
        days_met,
        streak_best_in_period,
        current_streak,
        finished,
        finished_undated,
        top_books,
        genres,
        genre_unknown_books,
        hours,
        hours_since,
        highlights,
        notes,
        words,
        best_day,
        months,
        persona,
        books,
    })
}

/// The statistics of the week, month or year containing `anchor` (a reading
/// day, `YYYY-MM-DD`; default today), or of everything (`kind` "all").
#[tauri::command]
pub fn stats_period(db: State<Db>, kind: String, anchor: Option<String>) -> Result<PeriodStats, String> {
    let anchor = anchor.as_deref().filter(|a| !a.is_empty()).map(crate::stats::parse_day).transpose()?;
    period_stats(&db, &kind, anchor, Local::now().naive_local())
}

/// Highlights, notes and saved words created on one reading day (the day sheet).
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct DayMarks {
    /// Notes included.
    pub highlights: i64,
    pub notes: i64,
    pub words: i64,
}

pub(crate) fn day_marks(db: &Db, day: NaiveDate) -> DayMarks {
    // Timestamps are UTC and the reading day is local with a 04:00 start: a
    // window a day either side holds every row that can fall on `day`.
    let window = |sql: &str| {
        let (lo, hi) = (day - Duration::days(1), day + Duration::days(2));
        let sql = format!("{sql} AND created_at >= '{lo} 00:00:00' AND created_at < '{hi} 00:00:00'");
        created_days(&db.0.lock().unwrap(), &sql).into_iter().filter(|(d, _)| *d == day).collect::<Vec<_>>()
    };
    let marks = window("SELECT created_at, IFNULL(note,'') <> '' FROM annotation WHERE deleted = 0");
    DayMarks {
        highlights: marks.len() as i64,
        notes: marks.iter().filter(|(_, has_note)| *has_note).count() as i64,
        words: window("SELECT created_at, 1 FROM vocab WHERE 1 = 1").len() as i64,
    }
}

/// What was marked and saved on a reading day (`YYYY-MM-DD`).
#[tauri::command]
pub fn stats_day(db: State<Db>, day: String) -> Result<DayMarks, String> {
    Ok(day_marks(&db, crate::stats::parse_day(&day)?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stats::testing::{at, d, TempDb};
    use crate::stats::{log_manual, record_reading, set_setting};

    /// 20 minutes: more than the default 10-minute goal.
    const MET: i64 = 1200;

    fn week(t: &TempDb, anchor: &str, now: &str) -> PeriodStats {
        period_stats(t.db(), "week", Some(d(anchor)), at(now)).unwrap()
    }

    #[test]
    fn period_bounds() {
        let b = |k, a: &str| bounds(k, d(a)).map(|(s, e)| (s.to_string(), e.to_string()));
        // Weeks run Monday to Sunday, whichever day is the anchor.
        for a in ["2026-11-16", "2026-11-18", "2026-11-22"] {
            assert_eq!(b("week", a), Some(("2026-11-16".into(), "2026-11-22".into())), "{a}");
        }
        assert_eq!(b("week", "2027-01-01"), Some(("2026-12-28".into(), "2027-01-03".into())));
        assert_eq!(b("month", "2026-11-18"), Some(("2026-11-01".into(), "2026-11-30".into())));
        assert_eq!(b("month", "2028-02-10"), Some(("2028-02-01".into(), "2028-02-29".into())));
        assert_eq!(b("month", "2026-12-31"), Some(("2026-12-01".into(), "2026-12-31".into())));
        assert_eq!(b("year", "2026-06-30"), Some(("2026-01-01".into(), "2026-12-31".into())));
        assert_eq!(b("all", "2026-06-30"), None);
        assert!(period_stats(TempDb::new("bad").db(), "decade", None, at("2026-11-18 12:00")).is_err());
    }

    #[test]
    fn week_edges_follow_the_four_am_day() {
        let t = TempDb::new("p-edges");
        t.add_book("A", "A");
        // Mon 04:00 starts the week; Mon 03:59 still belongs to the Sunday before.
        record_reading(t.db(), at("2026-11-16 03:59"), "A", 100, 0);
        record_reading(t.db(), at("2026-11-16 04:00"), "A", 200, 0);
        // Sun 23:59 is in the week; Mon 03:59 after it is too; Mon 04:00 is the next week.
        record_reading(t.db(), at("2026-11-22 23:59"), "A", 400, 0);
        record_reading(t.db(), at("2026-11-23 03:59"), "A", 800, 0);
        record_reading(t.db(), at("2026-11-23 04:00"), "A", 1600, 0);
        let now = "2026-11-25 12:00";
        let w = week(&t, "2026-11-18", now);
        assert_eq!((w.start.as_str(), w.end.as_str()), ("2026-11-16", "2026-11-22"));
        assert_eq!(w.total_sec, 200 + 400 + 800);
        assert_eq!(w.days.len(), 7);
        assert_eq!(w.days[0].day, "2026-11-16");
        assert_eq!(w.days[6].app_sec, 400 + 800);
        // The previous week got the 03:59 reading; the next one 04:00.
        assert_eq!((w.prev_start.as_deref(), w.prev_end.as_deref()), (Some("2026-11-09"), Some("2026-11-15")));
        assert_eq!(w.prev_total_sec, 100);
        assert_eq!(week(&t, "2026-11-23", now).total_sec, 1600);
        assert!(w.is_complete);
        assert!(!week(&t, "2026-11-23", now).is_complete);
        // The persona trend compares with the previous week (1400 against 100).
        assert_eq!(w.persona.trend_pct, Some(1300.0));
        assert_eq!(week(&t, "2026-11-02", now).persona.trend_pct, None); // nothing before it
    }

    #[test]
    fn month_and_year_boundaries() {
        let t = TempDb::new("p-month");
        t.add_book("A", "A");
        for (day, secs) in [("2026-01-31", 60), ("2026-02-01", 120), ("2026-02-28", 240), ("2026-03-01", 480), ("2025-12-31", 30)] {
            t.log(day, "A", "app", "h10", secs);
        }
        let now = at("2026-06-15 12:00");
        let m = period_stats(t.db(), "month", Some(d("2026-02-14")), now).unwrap();
        assert_eq!((m.start.as_str(), m.end.as_str(), m.days.len()), ("2026-02-01", "2026-02-28", 28));
        assert_eq!(m.total_sec, 360);
        assert_eq!(m.prev_total_sec, 60);
        assert_eq!((m.prev_start.as_deref(), m.prev_end.as_deref()), (Some("2026-01-01"), Some("2026-01-31")));
        assert!(m.is_complete && m.months.is_empty());
        // January's previous month is December of the year before.
        let jan = period_stats(t.db(), "month", Some(d("2026-01-10")), now).unwrap();
        assert_eq!(jan.prev_start.as_deref(), Some("2025-12-01"));
        assert_eq!(jan.prev_total_sec, 30);
        // Year: 12 months, the totals add up, the previous year is the year before.
        let y = period_stats(t.db(), "year", None, now).unwrap();
        assert_eq!((y.start.as_str(), y.end.as_str(), y.days.len(), y.is_complete), ("2026-01-01", "2026-12-31", 365, false));
        assert_eq!(y.total_sec, 60 + 120 + 240 + 480);
        assert_eq!(y.prev_total_sec, 30);
        assert_eq!(y.months.len(), 12);
        assert_eq!(y.months[0].month, "2026-01");
        assert_eq!((y.months[1].seconds, y.months[1].days_read), (360, 2));
        assert_eq!(y.months.iter().map(|m| m.seconds).sum::<i64>(), y.total_sec);
        // The month of a period that is still running is not complete.
        assert!(!period_stats(t.db(), "month", Some(d("2026-06-01")), now).unwrap().is_complete);
    }

    #[test]
    fn best_streak_inside_the_period_uses_the_freeze_rule() {
        let t = TempDb::new("p-streak");
        t.add_book("A", "A");
        // The Sunday before the week is a goal day too but is not in the week.
        for day in ["2026-11-15", "2026-11-16", "2026-11-17", "2026-11-19", "2026-11-20"] {
            t.log(day, "A", "app", "h20", MET);
        }
        t.log("2026-11-21", "A", "app", "h20", 300); // read, but under the goal
        let w = week(&t, "2026-11-18", "2026-11-22 12:00");
        // Mon, Tue, (Wed forgiven), Thu, Fri = 4; Saturday misses the goal.
        assert_eq!(w.streak_best_in_period, 4);
        assert_eq!((w.days_met, w.days_read), (4, 5));
        assert!(w.days[0].met && !w.days[2].met && !w.days[5].met);
        // The Sunday 15th, outside the week, is not part of the best run.
        let earlier = week(&t, "2026-11-10", "2026-11-22 12:00");
        assert_eq!((earlier.streak_best_in_period, earlier.days_met), (1, 1));
    }

    #[test]
    fn current_streak_is_the_live_one() {
        let t = TempDb::new("p-current");
        t.add_book("A", "A");
        for day in ["2026-11-19", "2026-11-20", "2026-11-21"] {
            t.log(day, "A", "app", "h20", MET);
        }
        let w = week(&t, "2026-11-10", "2026-11-22 12:00");
        assert_eq!(w.current_streak, 3);
        assert_eq!(w.streak_best_in_period, 0);
    }

    #[test]
    fn kindle_estimates_follow_the_setting_but_manual_reading_always_counts() {
        let t = TempDb::new("p-kindle");
        t.add_book("A", "A");
        t.log("2026-11-18", "A", "app", "h09", 600);
        t.log("2026-11-18", "A", "kindle", "h10", 300);
        log_manual(t.db(), d("2026-11-18"), d("2026-11-18"), None, Some("Paper"), 7).unwrap();
        let on = week(&t, "2026-11-18", "2026-11-19 12:00");
        let day = &on.days[2];
        assert_eq!((day.app_sec, day.kindle_sec, day.manual_sec), (600, 300, 420));
        assert_eq!(on.total_sec, 1320);
        set_setting(t.db(), "kindle_estimates", "0").unwrap();
        let off = week(&t, "2026-11-18", "2026-11-19 12:00");
        let day = &off.days[2];
        assert_eq!((day.app_sec, day.kindle_sec, day.manual_sec), (600, 0, 420));
        assert_eq!(off.total_sec, 1020);
        assert_eq!(off.hours[10], 0);
        assert_eq!(on.hours[10], 300);
        // The paper book shows up with its own title.
        assert_eq!(off.books["paper:paper"].title, "Paper");
    }

    #[test]
    fn hours_and_persona_shares() {
        let t = TempDb::new("p-hours");
        t.add_book("A", "A");
        t.log("2026-11-17", "A", "app", "h02", 600);
        t.log("2026-11-17", "A", "app", "night", 600); // legacy rows count as night, but have no hour
        t.log("2026-11-17", "A", "app", "h05", 300);
        t.log("2026-11-18", "A", "app", "h14", 900);
        t.log("2026-11-18", "A", "manual", "manual", 600); // no time of day at all
        t.log("2026-11-10", "A", "app", "day", 60); // legacy, no hour; before hour data
        let w = week(&t, "2026-11-18", "2026-11-19 12:00");
        let mut hours = [0i64; 24];
        (hours[2], hours[5], hours[14]) = (600, 300, 900);
        assert_eq!(w.hours, hours);
        // Hour data starts on the 17th (the legacy rows do not count).
        assert_eq!(w.hours_since.as_deref(), Some("2026-11-17"));
        // timed = 600 + 600 + 300 + 900; the manual 600 has no time of day.
        assert_eq!(w.persona.night_share, 1200.0 / 2400.0);
        assert_eq!(w.persona.early_share, 300.0 / 2400.0);
        assert_eq!(w.total_sec, 3000);
        // 2 reading days, 3000 s = 50 min.
        assert_eq!(w.persona.avg_min_per_reading_day, 25.0);
    }

    #[test]
    fn finished_books_genres_and_top_books() {
        let t = TempDb::new("p-books");
        let db = t.db();
        for (a, title) in [("F", "Fantasy"), ("R", "Romance"), ("U", "Unknown"), ("S", "Short"), ("H", "Hist")] {
            t.add_book(a, title);
        }
        db.0.lock()
            .unwrap()
            .execute_batch(
                r#"INSERT INTO goodreads (asin, book, matched_at, details) VALUES
                     ('F', '{}', datetime('now'), '{"genres":["Fantasy"]}'),
                     ('S', '{}', datetime('now'), '{"genres":["Fantasy"]}'),
                     ('R', '{}', datetime('now'), '{"genres":["Romance","Fiction"]}'),
                     ('H', '{}', datetime('now'), '{"genres":["Romance"]}');"#,
            )
            .unwrap();
        t.log("2026-11-16", "F", "app", "h20", 3000);
        t.log("2026-11-17", "F", "app", "h20", 600);
        t.log("2026-11-17", "R", "app", "h21", 1800);
        t.log("2026-11-18", "H", "app", "h21", 1700);
        t.log("2026-11-18", "U", "app", "h21", 120);
        t.log("2026-11-18", "S", "app", "h21", 59); // under a minute: not "read"
        t.log("2026-11-18", "GONE", "app", "h21", 5000); // not in the library
        // Finished: one in the week, one the week before, one backfilled.
        {
            let conn = db.0.lock().unwrap();
            for (asin, kind, day) in [("F", "finished", "2026-11-20"), ("R", "finished", "2026-11-12"), ("H", "finished_backfill", "2026-11-19")] {
                conn.execute("INSERT INTO book_event (asin, kind, day) VALUES (?1, ?2, ?3)", rusqlite::params![asin, kind, day])
                    .unwrap();
            }
        }
        for a in ["F", "R", "H"] {
            db.set_status(a, Some("finished")).unwrap();
        }
        let w = week(&t, "2026-11-18", "2026-11-22 12:00");
        assert_eq!(w.finished.len(), 1);
        let f = &w.finished[0];
        assert_eq!((f.asin.as_str(), f.title.as_str(), f.day.as_str()), ("F", "Fantasy", "2026-11-20"));
        // F was first read on the 16th and finished on the 20th: a fast finish.
        assert_eq!(w.persona.fast_finishes, 1);
        assert_eq!(w.finished_undated, 0);
        // Top books: most time first, only books read for a minute or more, none removed.
        let top: Vec<_> = w.top_books.iter().map(|b| (b.asin.as_str(), b.seconds)).collect();
        assert_eq!(top, [("F", 3600), ("R", 1800), ("H", 1700), ("U", 120)]);
        // Genres: romance has 2 books, fantasy 1 -> romance first; U has none.
        let genres: Vec<_> = w.genres.iter().map(|g| (g.id.as_str(), g.books, g.seconds)).collect();
        assert_eq!(genres, [("romance", 2, 3500), ("fantasy", 1, 3600)]);
        assert_eq!(w.genre_unknown_books, 1);
        assert_eq!(w.persona.top_genre.as_deref(), Some("romance"));
        // The day lists only books still in the library; every listed book has a reference.
        let busy = 1700 + 120 + 59 + 5000;
        assert!(w.days.iter().all(|x| x.books.iter().all(|b| b.asin != "GONE")));
        assert_eq!(w.days[2].app_sec, busy);
        let tue = &w.days[1].books;
        assert_eq!((tue[0].asin.as_str(), tue[1].asin.as_str()), ("R", "F"));
        for b in w.days.iter().flat_map(|x| &x.books) {
            assert!(w.books.contains_key(&b.asin));
        }
        assert_eq!(w.books["F"].title, "Fantasy");
        assert_eq!(w.best_day.as_ref().map(|b| (b.day.as_str(), b.seconds)), Some(("2026-11-18", busy)));
        // The whole history: F's finish is dated, the backfilled one only counts here.
        let all = period_stats(db, "all", None, at("2026-11-22 12:00")).unwrap();
        assert_eq!((all.start.as_str(), all.end.as_str()), ("2026-11-12", "2026-11-22"));
        assert_eq!(all.finished.len(), 2);
        assert_eq!(all.finished_undated, 1);
        assert_eq!(all.days.len(), 11);
        assert_eq!(all.months.len(), 1);
        assert_eq!(all.months[0].finished, 2);
    }

    #[test]
    fn marks_and_words_land_on_the_local_reading_day() {
        use chrono::TimeZone;
        let t = TempDb::new("p-marks");
        let utc = |local: &str| {
            let l = Local.from_local_datetime(&at(local)).earliest().unwrap();
            l.with_timezone(&Utc).format("%Y-%m-%d %H:%M:%S").to_string()
        };
        {
            let conn = t.db().0.lock().unwrap();
            // Local Monday 02:00 is still Sunday's reading day; 04:00 is Monday's.
            for (local, note) in [("2026-11-16 02:00", ""), ("2026-11-16 04:00", "a note"), ("2026-11-18 12:00", ""), ("2026-11-22 23:00", "n")] {
                conn.execute(
                    "INSERT INTO annotation (asin, cfi, fraction, color, note, created_at) VALUES ('A', 'c', 0.1, 'yellow', ?1, ?2)",
                    rusqlite::params![note, utc(local)],
                )
                .unwrap();
            }
            conn.execute(
                "INSERT INTO annotation (asin, cfi, fraction, color, note, created_at, deleted) VALUES ('A', 'c', 0.1, 'yellow', '', ?1, 1)",
                [utc("2026-11-18 12:00")],
            )
            .unwrap();
            for local in ["2026-11-16 03:59", "2026-11-17 10:00"] {
                conn.execute("INSERT INTO vocab (word, key, lang, created_at) VALUES ('w', ?1, 'en', ?1)", [utc(local)]).unwrap();
            }
        }
        let w = week(&t, "2026-11-18", "2026-11-25 12:00");
        assert_eq!((w.highlights, w.notes, w.words), (3, 2, 1));
        let before = week(&t, "2026-11-09", "2026-11-25 12:00");
        assert_eq!((before.highlights, before.notes, before.words), (1, 0, 1));
        // The same rows, asked one day at a time.
        assert_eq!(day_marks(t.db(), d("2026-11-15")), DayMarks { highlights: 1, notes: 0, words: 1 });
        assert_eq!(day_marks(t.db(), d("2026-11-16")), DayMarks { highlights: 1, notes: 1, words: 0 });
        assert_eq!(day_marks(t.db(), d("2026-11-18")), DayMarks { highlights: 1, notes: 0, words: 0 });
        assert_eq!(day_marks(t.db(), d("2026-11-20")), DayMarks { highlights: 0, notes: 0, words: 0 });
    }
}
