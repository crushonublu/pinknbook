//! The days the account read on any Kindle, as Amazon's own reading-streak
//! page lists them.
//!
//! A physical Kindle (or any other app) leaves no reading time we can see,
//! but Amazon knows which days it was read. `GET /reading/challenges/streaks/data`
//! answers with the web session's cookies, `{"streaks_data":{"daysRead":["2019-07-24",...]}}`.
//! The days are kept in `amazon_day_read` (the whole set is replaced on every
//! success) and used in two places: the Kindle estimate is spread over them
//! (`stats.rs`) and the streak calendar marks them.
//!
//! The cookies are read from the web view that signed in (the desktop window's
//! profile, Android's `CookieManager`), held in memory for the one request and
//! never logged, stored or sent anywhere but www.amazon.com.

use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, Ordering};

use chrono::{Local, NaiveDate};
use rusqlite::Connection;
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::db::Db;
use crate::stats::{set_setting, setting};

#[cfg(desktop)]
const ORIGIN: &str = "https://www.amazon.com";
const DAYS_URL: &str = "https://www.amazon.com/reading/challenges/streaks/data";
/// An ordinary browser's name: the page is meant for one.
const USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
/// The days are asked for at most this often (a failed try counts too).
const REFRESH_EVERY_SECS: i64 = 6 * 3600;

const FETCHED_AT: &str = "amazon_days_fetched_at";
const TRIED_AT: &str = "amazon_days_tried_at";
const STATUS: &str = "amazon_days_status";

/// What the settings and the Stats page know about the days.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AmazonDays {
    /// "none" (never asked), "ok", "needs_signin" or "error".
    pub status: String,
    /// When the days were last fetched (unix seconds); `None` if never.
    pub fetched_at: Option<i64>,
    pub count: usize,
}

/// What an answer from Amazon means.
#[derive(Debug, PartialEq)]
pub(crate) enum Outcome {
    Days(BTreeSet<NaiveDate>),
    /// The session is gone: a redirect to the sign-in page, 401/403 or a web page instead of data.
    NeedsSignIn,
    Failed(String),
}

/// The `Cookie` header for the cookies of the web view, or `None` when there
/// are none (nobody is signed in on the web). Android's `CookieManager` hands
/// over the header ready made.
#[cfg(desktop)]
pub(crate) fn cookie_header<'a>(cookies: impl IntoIterator<Item = (&'a str, &'a str)>) -> Option<String> {
    let header = cookies.into_iter().map(|(n, v)| format!("{n}={v}")).collect::<Vec<_>>().join("; ");
    (!header.is_empty()).then_some(header)
}

/// Make sense of the HTTP answer (redirects are not followed, so a 3xx is the
/// bounce to the sign-in page).
pub(crate) fn classify(status: u16, body: &str) -> Outcome {
    match status {
        300..=399 | 401 | 403 => return Outcome::NeedsSignIn,
        200..=299 => {}
        other => return Outcome::Failed(format!("http {other}")),
    }
    let Ok(json) = serde_json::from_str::<serde_json::Value>(body) else {
        // A page of HTML where the data should be is the sign-in page again.
        return if body.trim_start().starts_with('<') { Outcome::NeedsSignIn } else { Outcome::Failed("not json".into()) };
    };
    let Some(list) = json.pointer("/streaks_data/daysRead").and_then(|v| v.as_array()) else {
        return Outcome::Failed("unexpected answer".into());
    };
    Outcome::Days(list.iter().filter_map(|d| NaiveDate::parse_from_str(d.as_str()?, "%Y-%m-%d").ok()).collect())
}

/// Is it time to ask again?
pub(crate) fn due(tried_at: Option<i64>, now: i64, force: bool) -> bool {
    force || tried_at.is_none_or(|t| now - t >= REFRESH_EVERY_SECS || now < t)
}

/// Every day Amazon said was read.
pub(crate) fn days_read(conn: &Connection) -> BTreeSet<NaiveDate> {
    conn.prepare("SELECT day FROM amazon_day_read")
        .and_then(|mut s| s.query_map([], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>())
        .unwrap_or_default()
        .iter()
        .filter_map(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok())
        .collect()
}

pub(crate) fn status(db: &Db) -> AmazonDays {
    let count = days_read(&db.0.lock().unwrap()).len();
    AmazonDays {
        status: setting(db, STATUS).unwrap_or_else(|| "none".into()),
        fetched_at: setting(db, FETCHED_AT).and_then(|v| v.parse().ok()),
        count,
    }
}

fn store(db: &Db, days: &BTreeSet<NaiveDate>) -> Result<(), String> {
    let mut conn = db.0.lock().unwrap();
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM amazon_day_read", []).map_err(|e| e.to_string())?;
    for d in days {
        tx.execute("INSERT INTO amazon_day_read (day) VALUES (?1)", [d.to_string()]).map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
}

/// The cookies for www.amazon.com as a header value (desktop: the profile of
/// the main window, which the sign-in window shares).
#[cfg(desktop)]
async fn cookies(app: &AppHandle) -> Result<Option<String>, String> {
    let app = app.clone();
    // Reading the cookies waits for the web view: never on the thread that runs it.
    tauri::async_runtime::spawn_blocking(move || {
        let window = app.get_webview_window("main").ok_or("Main webview unavailable")?;
        let url: url::Url = ORIGIN.parse().map_err(|e: url::ParseError| e.to_string())?;
        let list = window.cookies_for_url(url).map_err(|e| e.to_string())?;
        Ok(cookie_header(list.iter().map(|c| (c.name(), c.value()))))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Android: the app web view's `CookieManager`, through `MainActivity`.
#[cfg(target_os = "android")]
async fn cookies(app: &AppHandle) -> Result<Option<String>, String> {
    let header = crate::android::on_activity(app, |env, activity| {
        crate::android::call_string(env, activity, "amazonCookieHeader", "()Ljava/lang/String;", &[])
    })
    .await?;
    Ok((!header.trim().is_empty()).then_some(header))
}

#[cfg(all(mobile, not(target_os = "android")))]
async fn cookies(_app: &AppHandle) -> Result<Option<String>, String> {
    Err("Amazon days are not available on this platform".into())
}

/// The one request. Errors never carry the cookies.
async fn fetch(cookie: &str) -> Result<(u16, String), String> {
    let mut header = reqwest::header::HeaderValue::from_str(cookie).map_err(|_| "cookies not usable".to_string())?;
    header.set_sensitive(true);
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(20))
        .user_agent(USER_AGENT)
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(DAYS_URL)
        .header(reqwest::header::COOKIE, header)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|e| e.without_url().to_string())?;
    let code = resp.status().as_u16();
    let body = resp.text().await.map_err(|e| e.without_url().to_string())?;
    Ok((code, body))
}

static BUSY: AtomicBool = AtomicBool::new(false);

/// Ask Amazon for the days read unless that was done in the last 6 hours
/// (`force` asks now). Failures keep the days already stored and only change
/// the status.
pub(crate) async fn refresh(app: &AppHandle, force: bool) -> AmazonDays {
    let db: State<Db> = app.state();
    let now = Local::now().timestamp();
    let tried = setting(&db, TRIED_AT).and_then(|v| v.parse().ok());
    if !due(tried, now, force) || BUSY.swap(true, Ordering::SeqCst) {
        return status(&db);
    }
    let outcome = match cookies(app).await {
        Ok(None) => Outcome::NeedsSignIn,
        Ok(Some(cookie)) => match fetch(&cookie).await {
            Ok((code, body)) => classify(code, &body),
            Err(e) => Outcome::Failed(e),
        },
        Err(e) => Outcome::Failed(e),
    };
    BUSY.store(false, Ordering::SeqCst);
    let _ = set_setting(&db, TRIED_AT, &now.to_string());
    match outcome {
        Outcome::Days(days) => {
            if store(&db, &days).is_ok() {
                let _ = set_setting(&db, FETCHED_AT, &now.to_string());
                let _ = set_setting(&db, STATUS, "ok");
            }
        }
        Outcome::NeedsSignIn => {
            let _ = set_setting(&db, STATUS, "needs_signin");
        }
        Outcome::Failed(_) => {
            let _ = set_setting(&db, STATUS, "error");
        }
    }
    status(&db)
}

/// Fetch the days read now (`force`) or when they are due.
#[tauri::command]
pub async fn amazon_days_refresh(app: AppHandle, force: Option<bool>) -> Result<AmazonDays, String> {
    Ok(refresh(&app, force.unwrap_or(false)).await)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stats::testing::{d, TempDb};

    const BODY: &str = r#"{"streaks_data":{"daysRead":["2019-07-24","2026-11-20","bad","2026-11-21"],"currentDailyStreak":1,"longestDailyStreak":null}}"#;

    #[test]
    fn days_are_read_from_the_answer() {
        let Outcome::Days(days) = classify(200, BODY) else { panic!("days expected") };
        assert_eq!(days.into_iter().collect::<Vec<_>>(), [d("2019-07-24"), d("2026-11-20"), d("2026-11-21")]);
    }

    #[test]
    fn signed_out_answers_need_a_new_sign_in() {
        assert_eq!(classify(302, ""), Outcome::NeedsSignIn); // redirect to the sign-in page
        assert_eq!(classify(401, "{}"), Outcome::NeedsSignIn);
        assert_eq!(classify(403, ""), Outcome::NeedsSignIn);
        assert_eq!(classify(200, "  <!doctype html><html>Sign in</html>"), Outcome::NeedsSignIn);
        // Other trouble is not a sign-in matter.
        assert_eq!(classify(503, ""), Outcome::Failed("http 503".into()));
        assert_eq!(classify(200, "oops"), Outcome::Failed("not json".into()));
        assert_eq!(classify(200, r#"{"streaks_data":{}}"#), Outcome::Failed("unexpected answer".into()));
        assert_eq!(classify(200, r#"{"streaks_data":{"daysRead":[]}}"#), Outcome::Days(BTreeSet::new()));
    }

    #[test]
    fn no_cookies_means_no_header() {
        assert_eq!(cookie_header([]), None);
        assert_eq!(cookie_header([("at-main", "a"), ("ubid-main", "b")]).as_deref(), Some("at-main=a; ubid-main=b"));
    }

    #[test]
    fn refresh_is_due_every_six_hours() {
        assert!(due(None, 1000, false));
        assert!(!due(Some(1000), 1000 + 6 * 3600 - 1, false));
        assert!(due(Some(1000), 1000 + 6 * 3600, false));
        assert!(due(Some(1000), 1001, true));
        assert!(due(Some(5000), 1000, false)); // the clock went back
    }

    #[test]
    fn the_stored_set_is_replaced() {
        let t = TempDb::new("amazon-days");
        assert_eq!(status(t.db()), AmazonDays { status: "none".into(), fetched_at: None, count: 0 });
        store(t.db(), &[d("2026-11-01"), d("2026-11-02")].into()).unwrap();
        store(t.db(), &[d("2026-11-02"), d("2026-11-03")].into()).unwrap();
        let days = days_read(&t.db().0.lock().unwrap());
        assert_eq!(days.into_iter().collect::<Vec<_>>(), [d("2026-11-02"), d("2026-11-03")]);
        set_setting(t.db(), STATUS, "ok").unwrap();
        set_setting(t.db(), FETCHED_AT, "1700000000").unwrap();
        assert_eq!(status(t.db()), AmazonDays { status: "ok".into(), fetched_at: Some(1_700_000_000), count: 2 });
    }
}
