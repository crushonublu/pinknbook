//! Bookmarks inside the in-app reader: a CFI (exact place in the book), the
//! reading fraction (for sorting and "x%"), the chapter it falls in and a
//! short excerpt of the page so the list is readable.

use tauri::State;

use crate::db::Db;

#[derive(Debug, Clone, serde::Serialize)]
pub struct Bookmark {
    pub id: i64,
    pub cfi: String,
    pub fraction: f64,
    pub chapter: Option<String>,
    pub excerpt: Option<String>,
    /// UTC "YYYY-MM-DD HH:MM:SS".
    pub created_at: String,
}

pub const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS bookmark (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    asin       TEXT NOT NULL,
    cfi        TEXT NOT NULL,
    fraction   REAL NOT NULL,
    chapter    TEXT,
    excerpt    TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS bookmark_asin ON bookmark(asin, fraction);
";

/// A book's bookmarks, in reading order.
#[tauri::command]
pub fn list_bookmarks(db: State<Db>, asin: String) -> Result<Vec<Bookmark>, String> {
    let conn = db.0.lock().unwrap();
    let mut stmt = conn
        .prepare(
            "SELECT id, cfi, fraction, chapter, excerpt, created_at FROM bookmark
             WHERE asin = ?1 ORDER BY fraction, id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([&asin], |r| {
            Ok(Bookmark {
                id: r.get(0)?,
                cfi: r.get(1)?,
                fraction: r.get(2)?,
                chapter: r.get(3)?,
                excerpt: r.get(4)?,
                created_at: r.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// Bookmark a place; returns the new bookmark.
#[tauri::command]
pub fn add_bookmark(
    db: State<Db>,
    asin: String,
    cfi: String,
    fraction: f64,
    chapter: Option<String>,
    excerpt: Option<String>,
) -> Result<Bookmark, String> {
    if cfi.is_empty() || !cfi.starts_with("epubcfi(") {
        return Err("bad position".into());
    }
    let clip = |s: Option<String>, n: usize| {
        s.map(|v| v.split_whitespace().collect::<Vec<_>>().join(" "))
            .filter(|v| !v.is_empty())
            .map(|v| v.chars().take(n).collect::<String>())
    };
    let conn = db.0.lock().unwrap();
    conn.execute(
        "INSERT INTO bookmark (asin, cfi, fraction, chapter, excerpt) VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![asin, cfi, fraction.clamp(0.0, 1.0), clip(chapter, 120), clip(excerpt, 200)],
    )
    .map_err(|e| e.to_string())?;
    let id = conn.last_insert_rowid();
    conn.query_row(
        "SELECT id, cfi, fraction, chapter, excerpt, created_at FROM bookmark WHERE id = ?1",
        [id],
        |r| {
            Ok(Bookmark {
                id: r.get(0)?,
                cfi: r.get(1)?,
                fraction: r.get(2)?,
                chapter: r.get(3)?,
                excerpt: r.get(4)?,
                created_at: r.get(5)?,
            })
        },
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn remove_bookmark(db: State<Db>, id: i64) -> Result<(), String> {
    let conn = db.0.lock().unwrap();
    conn.execute("DELETE FROM bookmark WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}
