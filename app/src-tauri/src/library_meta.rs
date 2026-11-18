//! Library metadata pipeline: extract covers + metadata from book files in
//! the background, fetch EBOK covers from Amazon's image CDN, and let the user
//! override title / author / cover. Covers live in `<app_data>/covers` and are
//! served to the webview by the `cover` URI scheme (see lib.rs).

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, State};

use crate::adp::client;
use crate::creds;
use crate::db::{Db, OverridePatch, StoredMeta};
use crate::meta;

static ENRICHING: AtomicBool = AtomicBool::new(false);

fn data_dir(app: &AppHandle, sub: &str) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join(sub);
    let _ = std::fs::create_dir_all(&dir);
    Ok(dir)
}

pub fn covers_dir(app: &AppHandle) -> Result<PathBuf, String> {
    data_dir(app, "covers")
}

/// A cover file name is safe to serve: `[A-Za-z0-9._-]+`, no "..".
pub fn safe_cover_name(name: &str) -> bool {
    !name.is_empty()
        && !name.contains("..")
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

#[derive(Clone, serde::Serialize)]
struct Progress<'a> {
    done: usize,
    total: usize,
    asin: &'a str,
}

/// Read metadata + cover out of a downloaded book file and store them.
pub fn ingest_file(app: &AppHandle, asin: &str, bytes: &[u8]) -> Result<(), String> {
    let fm = meta::parse_mobi(bytes).ok_or("not a MOBI/KF8 file")?;
    let mut cover_file = None;
    let mut spine = None;
    if let Some(img) = &fm.cover {
        let name = format!("{asin}.{}", meta::image_ext(img));
        std::fs::write(covers_dir(app)?.join(&name), img).map_err(|e| e.to_string())?;
        spine = meta::spine_color(img);
        cover_file = Some(name);
    }
    let db: State<Db> = app.state();
    db.upsert_meta(&StoredMeta {
        asin: asin.to_string(),
        title: fm.title,
        author: fm.author,
        publisher: fm.publisher,
        description: fm.description,
        subjects: fm.subjects,
        language: fm.language,
        cover_file,
        spine_color: spine,
        source: "file".into(),
        text_length: Some(client::mobi_total_positions(bytes).unwrap_or(0)),
    })
    .map_err(|e| e.to_string())
}

/// Amazon's public cover image for a store book (EBOK). Amazon answers
/// unknown ASINs with a 1×1 GIF, which we treat as "no cover".
async fn amazon_cover(asin: &str) -> Option<Vec<u8>> {
    let url = format!("https://images-na.ssl-images-amazon.com/images/P/{asin}.01._SCLZZZZZZZ_.jpg");
    let resp = reqwest::get(&url).await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let bytes = resp.bytes().await.ok()?.to_vec();
    (bytes.len() > 1024 && bytes.starts_with(&[0xFF, 0xD8, 0xFF])).then_some(bytes)
}

async fn enrich_one(app: &AppHandle, creds: Option<&crate::adp::register::Credentials>, asin: &str, cde: &str) -> Result<(), String> {
    if cde == "EBOK" {
        // Store books are DRM-protected: only the cover is available.
        let (cover_file, spine) = match amazon_cover(asin).await {
            Some(img) => {
                let name = format!("{asin}.jpg");
                std::fs::write(covers_dir(app)?.join(&name), &img).map_err(|e| e.to_string())?;
                (Some(name), meta::spine_color(&img))
            }
            None => (None, None),
        };
        let db: State<Db> = app.state();
        return db
            .upsert_meta(&StoredMeta {
                asin: asin.to_string(),
                cover_file: cover_file.clone(),
                spine_color: spine,
                source: if cover_file.is_some() { "amazon" } else { "none" }.into(),
                ..Default::default()
            })
            .map_err(|e| e.to_string());
    }

    let path = data_dir(app, "books")?.join(format!("{asin}.azw3"));
    let bytes = match std::fs::read(&path).ok().filter(|b| !b.is_empty()) {
        Some(b) => b,
        None => {
            let creds = creds.ok_or("not signed in")?;
            let b = client::download_content(creds, asin, cde)
                .await
                .map_err(|e| e.to_string())?;
            let _ = std::fs::write(&path, &b);
            // Keep the request rate low.
            tokio::time::sleep(Duration::from_millis(400)).await;
            b
        }
    };
    ingest_file(app, asin, &bytes)
}

/// Fill in covers and metadata for every book that lacks them. Runs in the
/// background; emits `meta-progress` {done,total,asin} after each book and
/// returns immediately if a run is already in progress.
#[tauri::command]
pub async fn enrich_library(app: AppHandle) -> Result<(), String> {
    if ENRICHING.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    let result = async {
        let todo = {
            let db: State<Db> = app.state();
            db.books_missing_meta().map_err(|e| e.to_string())?
        };
        let creds = creds::load().ok().flatten();
        let total = todo.len();
        for (i, (asin, cde)) in todo.iter().enumerate() {
            if let Err(e) = enrich_one(&app, creds.as_ref(), asin, cde).await {
                eprintln!("[meta] {asin}: {e}");
            }
            let _ = app.emit("meta-progress", Progress { done: i + 1, total, asin });
        }
        backfill_lengths(&app);
        Ok(())
    }
    .await;
    ENRICHING.store(false, Ordering::SeqCst);
    result
}

/// Books ingested before text lengths were stored: read the length from the
/// local file (cheap, no network) so spines get their real thickness.
fn backfill_lengths(app: &AppHandle) {
    let db: State<Db> = app.state();
    let Ok(todo) = db.books_missing_length() else { return };
    let Ok(dir) = data_dir(app, "books") else { return };
    for asin in &todo {
        let len = std::fs::read(dir.join(format!("{asin}.azw3")))
            .ok()
            .and_then(|b| client::mobi_total_positions(&b))
            .unwrap_or(0);
        let _ = db.set_text_length(asin, len);
    }
    if !todo.is_empty() {
        let _ = app.emit("meta-progress", Progress { done: 1, total: 1, asin: "" });
    }
}

/// Set the display title / author. `None` (or blank) restores the automatic value.
#[tauri::command]
pub fn set_book_info(
    db: State<Db>,
    asin: String,
    title: Option<String>,
    author: Option<String>,
) -> Result<(), String> {
    let norm = |v: Option<String>| v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    db.set_override(
        &asin,
        &OverridePatch {
            title: Some(norm(title)),
            author: Some(norm(author)),
            ..Default::default()
        },
    )
    .map_err(|e| e.to_string())
}

/// Use an image the user picked as the book's cover.
#[tauri::command]
pub fn set_book_cover(app: AppHandle, asin: String, data: Vec<u8>) -> Result<(), String> {
    if !(data.starts_with(&[0xFF, 0xD8, 0xFF]) || data.starts_with(b"\x89PNG") || data.starts_with(b"GIF8")) {
        return Err("unsupported image (use JPEG, PNG or GIF)".into());
    }
    let dir = covers_dir(&app)?;
    let stamp = chrono::Utc::now().timestamp_millis();
    let name = format!("{asin}-u{stamp}.{}", meta::image_ext(&data));
    std::fs::write(dir.join(&name), &data).map_err(|e| e.to_string())?;
    let db: State<Db> = app.state();
    if let Some(old) = db.override_cover(&asin).filter(|n| safe_cover_name(n) && n != crate::db::TYPOGRAPHIC_COVER) {
        let _ = std::fs::remove_file(dir.join(old));
    }
    db.set_override(
        &asin,
        &OverridePatch {
            cover_file: Some(Some(name)),
            spine_color: Some(meta::spine_color(&data)),
            ..Default::default()
        },
    )
    .map_err(|e| e.to_string())
}

/// Customise a book's spine. Every argument is the full new value: `None`
/// goes back to the automatic one (colour from the cover, plain, serif,
/// thickness from the text length).
#[tauri::command]
pub fn set_book_spine(
    db: State<Db>,
    asin: String,
    color: Option<String>,
    style: Option<String>,
    font: Option<String>,
    width: Option<i64>,
) -> Result<(), String> {
    if let Some(c) = &color {
        let ok = c.len() == 7 && c.starts_with('#') && c[1..].chars().all(|x| x.is_ascii_hexdigit());
        if !ok {
            return Err(format!("bad colour {c}"));
        }
    }
    if style.as_deref().is_some_and(|s| !crate::db::SPINE_STYLES.contains(&s)) {
        return Err("unknown spine style".into());
    }
    if font.as_deref().is_some_and(|s| !crate::db::SPINE_FONTS.contains(&s)) {
        return Err("unknown spine font".into());
    }
    db.set_override(
        &asin,
        &OverridePatch {
            spine_color: Some(color.map(|c| c.to_ascii_lowercase())),
            spine_style: Some(style.filter(|s| s != "plain")),
            spine_font: Some(font.filter(|s| s != "serif")),
            spine_width: Some(width.map(|w| w.clamp(10, 80))),
            ..Default::default()
        },
    )
    .map_err(|e| e.to_string())
}

/// Choose where the cover comes from: "file" (the book / Amazon image) or
/// "type" (a typographic cover drawn from title + author).
#[tauri::command]
pub fn set_cover_source(app: AppHandle, asin: String, source: String) -> Result<(), String> {
    let db: State<Db> = app.state();
    let value = match source.as_str() {
        "file" => None,
        "type" => Some(crate::db::TYPOGRAPHIC_COVER.to_string()),
        _ => return Err("unknown cover source".into()),
    };
    if let Some(old) = db.override_cover(&asin).filter(|n| safe_cover_name(n) && n != crate::db::TYPOGRAPHIC_COVER) {
        let _ = std::fs::remove_file(covers_dir(&app)?.join(old));
    }
    db.set_override(&asin, &OverridePatch { cover_file: Some(value), ..Default::default() })
        .map_err(|e| e.to_string())
}

/// Store the hand-arranged order of one shelf.
#[tauri::command]
pub fn set_shelf_order(db: State<Db>, asins: Vec<String>) -> Result<(), String> {
    db.set_shelf_order(&asins).map_err(|e| e.to_string())
}

/// Drop all user edits of a book (title, author, cover).
#[tauri::command]
pub fn reset_book(app: AppHandle, asin: String) -> Result<(), String> {
    let db: State<Db> = app.state();
    if let Some(old) = db.override_cover(&asin).filter(|n| safe_cover_name(n) && n != crate::db::TYPOGRAPHIC_COVER) {
        let _ = std::fs::remove_file(covers_dir(&app)?.join(old));
    }
    db.clear_override(&asin).map_err(|e| e.to_string())
}

/// Set a book's reading status by hand, or `None` to derive it from progress.
#[tauri::command]
pub fn set_book_status(db: State<Db>, asin: String, status: Option<String>) -> Result<(), String> {
    if let Some(s) = status.as_deref() {
        if !crate::db::is_status(s) {
            return Err(format!("unknown status {s}"));
        }
    }
    db.set_status(&asin, status.as_deref()).map_err(|e| e.to_string())
}
