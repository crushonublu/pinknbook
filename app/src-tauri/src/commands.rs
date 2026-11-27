//! Tauri commands exposed to the React UI, plus the OAuth login flow.

#[cfg(desktop)]
use std::sync::Arc;
#[cfg(desktop)]
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Emitter, Manager, State};
#[cfg(desktop)]
use tauri::{WebviewUrl, WebviewWindowBuilder};

use crate::adp::client;
use crate::adp::register;
use crate::creds;
use crate::db::{Db, LibraryRow};

#[derive(serde::Serialize, Clone)]
pub struct AccountInfo {
    pub directed_id: String,
    pub device_name: String,
}

/// Is a credential bundle present, and for which account?
#[tauri::command]
pub fn auth_status() -> Result<Option<AccountInfo>, String> {
    Ok(creds::load()?.map(|c| AccountInfo {
        directed_id: c.directed_id,
        device_name: c.device_name,
    }))
}

/// Open the Amazon sign-in window and register a fresh device on success.
/// Emits `login-complete` (AccountInfo) or `login-error` (String) when done.
#[tauri::command]
pub async fn login(app: AppHandle, title: Option<String>, note: Option<String>) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let (url, pending) = register::build_login_url(register::DEVICE_TYPE);
        *app.state::<MobileLogin>().0.lock().map_err(|_| "Sign-in state unavailable")? = Some(pending);
        let result = android_activity(&app, Some((url,
            title.unwrap_or_else(|| "Sign in with Amazon".into()),
            note.unwrap_or_else(|| "pntome cannot read your password. Device keys are stored securely by Android.".into())
        ))).await;
        if result.is_err() { app.state::<MobileLogin>().0.lock().map_err(|_| "Sign-in state unavailable")?.take(); }
        return result;
    }
    #[cfg(not(target_os = "android"))]
    let _ = (title, note);
    #[cfg(all(mobile, not(target_os = "android")))]
    { let _ = app; return Err("Sign-in is not available on this platform".into()); }
    #[cfg(desktop)]
    {
        let (url, pending) = register::build_login_url(register::DEVICE_TYPE);
        let parsed: url::Url = url.parse().map_err(|e: url::ParseError| e.to_string())?;

        let done = Arc::new(AtomicBool::new(false));
        let app_for_nav = app.clone();

        WebviewWindowBuilder::new(&app, "login", WebviewUrl::External(parsed))
            .title("Đăng nhập Amazon — pntome")
            .inner_size(480.0, 760.0)
            .on_navigation(move |nav_url| {
                // Amazon redirects to /ap/maplanding?...authorization_code=... on success.
                if nav_url.path().contains("/ap/maplanding") {
                    if done.swap(true, Ordering::SeqCst) {
                        return false; // already handling
                    }
                    let redirect = nav_url.to_string();
                    let app = app_for_nav.clone();
                    let pending = pending.clone();
                    tauri::async_runtime::spawn(async move {
                        complete_login(app, pending, redirect).await;
                    });
                    return false; // stop loading the landing page
                }
                true
            })
            .build()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

#[cfg_attr(mobile, allow(dead_code))]
async fn complete_login(app: AppHandle, pending: register::PendingRegistration, redirect: String) {
    let result: Result<AccountInfo, String> = async {
        let code = register::extract_code(&redirect)
            .ok_or_else(|| "no authorization_code in redirect".to_string())?;
        let creds_bundle = register::register(&pending, &code)
            .await
            .map_err(|e| {
                #[cfg(target_os = "android")]
                { let _ = e; "Amazon device registration failed".to_string() }
                #[cfg(not(target_os = "android"))]
                { e.to_string() }
            })?;
        creds::save(&creds_bundle)?;
        let db: State<Db> = app.state();
        db.save_account(
            &creds_bundle.directed_id,
            register::MARKETPLACE,
            &creds_bundle.device_serial,
            &creds_bundle.device_type,
            &creds_bundle.device_name,
        )
        .map_err(|e| e.to_string())?;
        Ok(AccountInfo {
            directed_id: creds_bundle.directed_id,
            device_name: creds_bundle.device_name,
        })
    }
    .await;

    // Close the login window regardless of outcome.
    #[cfg(desktop)]
    if let Some(w) = app.get_webview_window("login") {
        let _ = w.close();
    }
    match result {
        Ok(info) => {
            let _ = app.emit("login-complete", info);
        }
        Err(e) => {
            let _ = app.emit("login-error", e);
        }
    }
}

// Pending PKCE state never crosses into JavaScript or persistent storage.
#[cfg(target_os = "android")]
#[derive(Default)]
pub struct MobileLogin(pub std::sync::Mutex<Option<register::PendingRegistration>>);

#[tauri::command]
pub async fn complete_mobile_login(app: AppHandle, redirect: String) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let pending = app.state::<MobileLogin>().0.lock()
            .map_err(|_| "Sign-in state unavailable")?.take().ok_or("No pending sign-in")?;
        let url = url::Url::parse(&redirect).map_err(|_| "Invalid Amazon redirect")?;
        if url.scheme() != "https" || url.host_str() != Some("www.amazon.com")
            || url.port_or_known_default() != Some(443) || !url.username().is_empty()
            || url.password().is_some() || !url.path().starts_with("/ap/maplanding") {
            return Err("Invalid Amazon redirect".into());
        }
        complete_login(app, pending, redirect).await;
        Ok(())
    }
    #[cfg(not(target_os = "android"))]
    { let _ = (app, redirect); Err("Mobile sign-in is only available on Android".into()) }
}

#[tauri::command]
pub fn cancel_mobile_login(app: AppHandle) -> Result<(), String> {
    #[cfg(target_os = "android")]
    { app.state::<MobileLogin>().0.lock().map_err(|_| "Sign-in state unavailable")?.take(); }
    #[cfg(not(target_os = "android"))]
    let _ = app;
    Ok(())
}

#[cfg(target_os = "android")]
async fn android_activity(app: &AppHandle, signin: Option<(String, String, String)>) -> Result<(), String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.get_webview_window("main").ok_or("Main webview unavailable")?
        .with_webview(move |w| {
            w.jni_handle().exec(move |env, activity, _| {
                let result = (|| -> jni::errors::Result<()> {
                    if let Some((url, title, note)) = signin {
                        let url = env.new_string(url)?;
                        let title = env.new_string(title)?;
                        let note = env.new_string(note)?;
                        env.call_method(activity, "openAmazonSignIn",
                            "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V",
                            &[(&url).into(), (&title).into(), (&note).into()])?;
                    } else {
                        env.call_method(activity, "clearAmazonCookies", "()V", &[])?;
                    }
                    Ok(())
                })();
                if env.exception_check().unwrap_or(false) { let _ = env.exception_clear(); }
                let _ = tx.send(result.map_err(|_| "Android sign-in screen unavailable".to_string()));
            });
        }).map_err(|_| "Main webview unavailable")?;
    rx.await.map_err(|_| "Android sign-in screen unavailable".to_string())?
}

/// Sign out of Amazon. The app then carries on as a guest. With
/// `clear_kindle`, the Kindle books and their downloaded files are taken off
/// this computer too; books added from this computer always stay.
#[cfg(not(target_os = "android"))]
#[tauri::command]
pub fn logout(app: AppHandle, clear_kindle: Option<bool>) -> Result<(), String> {
    finish_logout(app, clear_kindle)
}

#[cfg(target_os = "android")]
#[tauri::command]
pub async fn logout(app: AppHandle, clear_kindle: Option<bool>) -> Result<(), String> {
    app.state::<MobileLogin>().0.lock().map_err(|_| "Sign-in state unavailable")?.take();
    android_activity(&app, None).await?;
    finish_logout(app, clear_kindle)
}

fn finish_logout(app: AppHandle, clear_kindle: Option<bool>) -> Result<(), String> {
    creds::clear()?;
    let db: State<Db> = app.state();
    crate::stats::set_setting(&db, GUEST_KEY, "1")?;
    if clear_kindle == Some(true) {
        let books_dir = app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("books");
        for asin in db.prune_books(&[]).map_err(|e| e.to_string())? {
            let _ = std::fs::remove_file(books_dir.join(format!("{asin}.azw3")));
        }
    }
    Ok(())
}

const GUEST_KEY: &str = "guest_mode";

/// Has the user chosen to use the app without signing in?
#[tauri::command]
pub fn guest_status(db: State<Db>) -> bool {
    crate::stats::setting(&db, GUEST_KEY).as_deref() == Some("1")
}

/// Remember (or forget) the choice to use the app without signing in.
#[tauri::command]
pub fn set_guest(db: State<Db>, on: bool) -> Result<(), String> {
    crate::stats::set_setting(&db, GUEST_KEY, if on { "1" } else { "0" })
}

/// Pull the library from Amazon, then fetch reading state per book.
/// Emits `sync-progress` {done,total} as it goes. Returns the book count.
#[tauri::command]
pub async fn sync_library(app: AppHandle) -> Result<usize, String> {
    let creds_bundle = creds::load()?.ok_or_else(|| "not signed in".to_string())?;

    let books = client::sync_library(&creds_bundle)
        .await
        .map_err(|e| e.to_string())?;

    let books_dir = app
        .path()
        .app_data_dir()
        .map(|d| d.join("books"))
        .unwrap_or_default();

    {
        let db: State<Db> = app.state();
        db.upsert_books(&books).map_err(|e| e.to_string())?;
        // The sync is a full snapshot, so a book missing from it was removed
        // on Amazon (from Kindle, the website, …). An empty answer is treated
        // as a glitch rather than "delete everything".
        if !books.is_empty() {
            let keep: Vec<String> = books.iter().map(|b| b.asin.clone()).collect();
            for asin in db.prune_books(&keep).map_err(|e| e.to_string())? {
                let _ = std::fs::remove_file(books_dir.join(format!("{asin}.azw3")));
            }
        }
    }

    // The book list is in: the UI shows it now; reading progress per book
    // (one request each, the slow part) fills in below.
    let _ = app.emit("library-changed", ());
    let total = books.len();
    let _ = app.emit(
        "sync-progress",
        serde_json::json!({"done": 0, "total": total}),
    );

    // Reading state per book — best-effort, sequential (low request frequency).
    // The percentage needs the book's total length: stored once the book was
    // read, else from the downloaded file. A book still being downloaded (the
    // covers and files are fetched meanwhile) keeps the position only, and
    // `Db::fill_percents` turns it into a percentage when its length arrives.
    for (i, book) in books.iter().enumerate() {
        if let Ok(mut state) = client::reading_state(&creds_bundle, book).await {
            let db: State<Db> = app.state();
            if let Some(pos) = state.position {
                let total = db.text_length(&book.asin).or_else(|| {
                    std::fs::read(books_dir.join(format!("{}.azw3", book.asin)))
                        .ok()
                        .and_then(|bytes| client::mobi_total_positions(&bytes))
                        .filter(|t| *t > 0)
                });
                state.percent = total.map(|t| ((pos as f64 / t as f64) * 100.0).clamp(0.0, 100.0));
            }
            let _ = db.upsert_reading_state(&state);
        }
        let _ = app.emit(
            "sync-progress",
            serde_json::json!({"done": i + 1, "total": total}),
        );
    }
    // Books whose length arrived while their position was being fetched.
    let _ = app.state::<Db>().fill_percents();

    Ok(total)
}

/// The library as stored locally (fast; no network).
#[tauri::command]
pub fn get_library(app: AppHandle, db: State<Db>) -> Result<Vec<LibraryRow>, String> {
    let mut rows = db.list_library().map_err(|e| e.to_string())?;
    for r in rows.iter_mut().filter(|r| r.source == "local") {
        r.file_missing = !crate::local::book_path(&app, &r.asin)
            .map(|p| p.exists())
            .unwrap_or(false);
    }
    crate::local::attach_links(&mut rows, &db.book_links().map_err(|e| e.to_string())?);
    Ok(rows)
}

/// Download a book's content file (non-DRM MOBI/KF8) for the in-app reader.
/// Caches to `<app_data>/books/<asin>.azw3`; serves from cache on re-open.
/// Returns the raw bytes to the webview (as an ArrayBuffer).
#[tauri::command]
pub async fn download_book(
    app: AppHandle,
    asin: String,
    cde_type: String,
) -> Result<tauri::ipc::Response, String> {
    // A book added from this computer: the app's own copy, nothing to fetch.
    if crate::local::is_local(&asin) {
        return crate::local::read_book(&app, &asin).map(tauri::ipc::Response::new);
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("books");
    let _ = std::fs::create_dir_all(&dir);
    let cache = dir.join(format!("{asin}.azw3"));

    // Serve from cache if present, otherwise download and cache.
    let cached = std::fs::read(&cache).ok().filter(|b| !b.is_empty());
    let bytes = match cached {
        Some(b) => b,
        None => {
            let creds_bundle = creds::load()?.ok_or_else(|| "not signed in".to_string())?;
            let b = client::download_content(&creds_bundle, &asin, &cde_type)
                .await
                .map_err(|e| e.to_string())?;
            let _ = std::fs::write(&cache, &b);
            b
        }
    };

    // First open of a book downloaded here: read its cover + metadata.
    {
        let db: State<Db> = app.state();
        if !db.has_file_meta(&asin) && crate::library_meta::ingest_file(&app, &asin, &bytes).is_ok()
        {
            let _ = app.emit(
                "meta-progress",
                serde_json::json!({"done": 1, "total": 1, "asin": asin}),
            );
        }
    }

    // Best-effort: refresh the Amazon reading progress (runs for cached opens too,
    // so the library % and reader resume stay in sync with Kindle).
    if let Ok(Some(creds_bundle)) = creds::load() {
        refresh_progress(&app, &creds_bundle, &asin, &cde_type, &bytes).await;
    }

    Ok(tauri::ipc::Response::new(bytes))
}

/// Fetch the sidecar (furthest-page-read) and combine it with the book's total
/// length (from the MOBI header) to store a reading percentage. Best-effort:
/// any failure leaves the stored state untouched.
async fn refresh_progress(
    app: &AppHandle,
    creds_bundle: &register::Credentials,
    asin: &str,
    cde_type: &str,
    bytes: &[u8],
) {
    let book = client::Book {
        asin: asin.to_string(),
        cde_type: cde_type.to_string(),
        ..Default::default()
    };
    let Ok(st) = client::reading_state(creds_bundle, &book).await else {
        return;
    };
    let Some(pos) = st.position else { return };
    let percent = client::mobi_total_positions(bytes)
        .filter(|t| *t > 0)
        .map(|t| ((pos as f64 / t as f64) * 100.0).clamp(0.0, 100.0));
    let db: State<Db> = app.state();
    let _ = db.upsert_reading_state(&client::ReadingState {
        asin: asin.to_string(),
        position: Some(pos),
        percent,
    });
}

/// Push the current reading position UP to Amazon (write direction), so the
/// user's other Kindle apps/devices can sync to it. Converts the reader's
/// fraction to a Kindle location via the book total (fraction × textLength) and
/// POSTs a `<last_read>` annotation to the sidecar. Best-effort.
#[tauri::command]
pub async fn push_reading_position(
    app: AppHandle,
    asin: String,
    cde_type: String,
    fraction: f64,
) -> Result<(), String> {
    if !(fraction > 0.0) || crate::local::is_local(&asin) {
        return Ok(());
    }
    let creds_bundle = creds::load()?.ok_or_else(|| "not signed in".to_string())?;
    let cache = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("books")
        .join(format!("{asin}.azw3"));
    let bytes = std::fs::read(&cache).ok();
    let total = bytes
        .as_deref()
        .and_then(client::mobi_total_positions)
        .filter(|t| *t > 0)
        .ok_or_else(|| "book total length unavailable (open the book first)".to_string())?;
    let acr = bytes.as_deref().and_then(client::local_acr);
    let location = (fraction.clamp(0.0, 1.0) * total as f64).round() as i64;
    client::upload_reading_position(&creds_bundle, &asin, &cde_type, location, acr.as_deref())
        .await
        .map_err(|e| e.to_string())?;
    let db: State<Db> = app.state();
    crate::stats::note_own_position(&db, &asin, location);
    Ok(())
}

/// Make Kindle agree with a status set in the app. Kindle (Kindle for PC
/// 2.9 included) keeps no "read / unread" label of its own: its progress is
/// only the last-read location in the sidecar. So "finished" moves that
/// location to the end of the book and "unread" back to the start; other
/// statuses are not pushed. This OVERWRITES the reading position on every
/// Kindle app, so the UI asks first. Returns the progress Amazon reports
/// afterwards (0..100), read back to confirm the write took.
#[tauri::command]
pub async fn push_status_to_kindle(
    app: AppHandle,
    asin: String,
    cde_type: String,
    status: String,
) -> Result<Option<f64>, String> {
    if crate::local::is_local(&asin) {
        return Err("not a Kindle book".into());
    }
    let creds_bundle = creds::load()?.ok_or_else(|| "not signed in".to_string())?;
    let db: State<Db> = app.state();
    let total = db
        .text_length(&asin)
        .or_else(|| {
            let cache = app
                .path()
                .app_data_dir()
                .ok()?
                .join("books")
                .join(format!("{asin}.azw3"));
            std::fs::read(cache)
                .ok()
                .and_then(|b| client::mobi_total_positions(&b))
        })
        .filter(|t| *t > 0)
        .ok_or_else(|| "book total length unavailable (open the book first)".to_string())?;
    let location = match status.as_str() {
        "finished" => total,
        // 1, not 0: a zero location reads as "no position" to some clients.
        "unread" => 1,
        other => return Err(format!("status {other} is not pushed to Kindle")),
    };
    let acr = crate::annotations::book_acr(&app, &asin);
    client::upload_reading_position(&creds_bundle, &asin, &cde_type, location, acr.as_deref())
        .await
        .map_err(|e| e.to_string())?;
    crate::stats::note_own_position(&db, &asin, location);

    // Read it back: what Amazon now says, stored for the library card.
    let book = client::Book {
        asin: asin.clone(),
        cde_type: cde_type.clone(),
        ..Default::default()
    };
    let st = client::reading_state(&creds_bundle, &book)
        .await
        .map_err(|e| e.to_string())?;
    let percent = st
        .position
        .map(|p| ((p as f64 / total as f64) * 100.0).clamp(0.0, 100.0));
    let _ = db.upsert_reading_state(&client::ReadingState {
        asin,
        position: st.position,
        percent,
    });
    Ok(percent)
}

/// Persist the in-app reader's position for a book.
#[tauri::command]
pub fn set_reading_position(
    db: State<Db>,
    asin: String,
    cfi: String,
    fraction: f64,
) -> Result<(), String> {
    db.set_reader_position(&asin, &cfi, fraction)
        .map_err(|e| e.to_string())
}

/// The current Kindle furthest-page-read, fetched live from the sidecar.
#[derive(serde::Serialize)]
pub struct Furthest {
    pub location: i64,
    pub fraction: Option<f64>,
    pub percent: Option<f64>,
}

/// Fetch the CURRENT furthest-page-read live from Amazon (not the value cached
/// when the book was opened), so the reader's manual "sync" reflects reading
/// done on other devices since. Also persists it so the library card updates.
#[tauri::command]
pub async fn kindle_furthest(
    app: AppHandle,
    asin: String,
    cde_type: String,
) -> Result<Option<Furthest>, String> {
    if crate::local::is_local(&asin) {
        return Ok(None);
    }
    let creds_bundle = creds::load()?.ok_or_else(|| "not signed in".to_string())?;
    let book = client::Book {
        asin: asin.clone(),
        cde_type: cde_type.clone(),
        ..Default::default()
    };
    let st = client::reading_state(&creds_bundle, &book)
        .await
        .map_err(|e| e.to_string())?;
    let Some(pos) = st.position else {
        return Ok(None);
    };

    // Percentage needs the book total (from the cached MOBI header).
    let cache = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("books")
        .join(format!("{asin}.azw3"));
    let percent = std::fs::read(&cache)
        .ok()
        .and_then(|b| client::mobi_total_positions(&b))
        .filter(|t| *t > 0)
        .map(|t| ((pos as f64 / t as f64) * 100.0).clamp(0.0, 100.0));

    let db: State<Db> = app.state();
    let _ = db.upsert_reading_state(&client::ReadingState {
        asin,
        position: Some(pos),
        percent,
    });

    Ok(Some(Furthest {
        location: pos,
        fraction: percent.map(|p| p / 100.0),
        percent,
    }))
}

/// Where the reader should open a book, and where Kindle's furthest point is.
#[derive(serde::Serialize)]
pub struct ReaderStart {
    /// A previously-saved in-app position (foliate CFI), if any.
    pub cfi: Option<String>,
    /// The Amazon furthest-page-read raw location (for an exact jump).
    pub amazon_location: Option<i64>,
    /// The Amazon reading fraction 0..1 (fallback jump + for the Sync button).
    pub amazon_fraction: Option<f64>,
}

/// Report the reader's resume options. Matching Kindle's behaviour: the local
/// in-app position is the default (returned as `cfi`); the Amazon furthest-read
/// point is returned alongside so the reader can (a) use it when there is no
/// local position yet — a book first downloaded after being read on another
/// device — and (b) offer a manual "sync to furthest page" jump.
#[tauri::command]
pub fn reader_start(db: State<Db>, asin: String) -> Result<ReaderStart, String> {
    let cfi = db
        .reader_position(&asin)
        .map_err(|e| e.to_string())?
        .map(|p| p.cfi);
    let (amazon_location, amazon_fraction) = db
        .reading_progress(&asin)
        .map_err(|e| e.to_string())?
        .map(|(pos, pct)| (pos, pct.map(|p| (p / 100.0).clamp(0.0, 1.0))))
        .unwrap_or((None, None));

    Ok(ReaderStart {
        cfi,
        amazon_location,
        amazon_fraction,
    })
}
