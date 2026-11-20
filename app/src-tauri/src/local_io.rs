//! Local books beyond one-off adds: folders the app watches for new EPUBs,
//! and a single `.zip` that carries the local library (books, reading
//! positions, highlights, bookmarks, words, stats, X-Ray) to another computer.

use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};

use rusqlite::types::{Value as SqlValue, ValueRef};
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager, State};

use crate::db::Db;
use crate::local::{self, ImportResult};

// ---- Watched folders ---------------------------------------------------------

const WATCH_KEY: &str = "watch_folders";

pub const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS watch_seen (
    path  TEXT PRIMARY KEY,
    size  INTEGER NOT NULL,
    mtime INTEGER NOT NULL
);
";

fn folders(db: &Db) -> Vec<String> {
    crate::stats::setting(db, WATCH_KEY)
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Folders whose new EPUBs are added automatically.
#[tauri::command]
pub fn watch_folders(db: State<Db>) -> Vec<String> {
    folders(&db)
}

/// Replace the list of watched folders (folders that do not exist are refused).
#[tauri::command]
pub fn set_watch_folders(db: State<Db>, folders: Vec<String>) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = Vec::new();
    for f in folders {
        if !Path::new(&f).is_dir() {
            return Err(format!("not a folder: {f}"));
        }
        if !out.contains(&f) {
            out.push(f);
        }
    }
    let json = serde_json::to_string(&out).map_err(|e| e.to_string())?;
    crate::stats::set_setting(&db, WATCH_KEY, &json)?;
    Ok(out)
}

fn stamp(p: &Path) -> Option<(i64, i64)> {
    let m = std::fs::metadata(p).ok()?;
    let mtime = m
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs() as i64;
    Some((m.len() as i64, mtime))
}

/// Add the EPUBs that appeared (or changed) in the watched folders since the
/// last scan. Files are looked at once per size + modification time, so a
/// damaged or DRM file is reported once, not on every scan. Returns what was
/// tried, without files that turned out to be in the library already.
#[tauri::command]
pub async fn scan_watch_folders(app: AppHandle) -> Result<Vec<ImportResult>, String> {
    let Ok(guard) = local::IMPORTING.try_lock() else {
        return Ok(vec![]); // another import is running; the next scan catches up
    };
    let db: State<Db> = app.state();
    let roots = folders(&db);
    if roots.is_empty() {
        return Ok(vec![]);
    }
    let todo: Vec<(PathBuf, (i64, i64))> = {
        let conn = db.0.lock().unwrap();
        local::expand(&roots)
            .into_iter()
            .filter_map(|p| {
                let st = stamp(&p)?;
                let key = p.to_string_lossy().into_owned();
                let seen: Option<(i64, i64)> = conn
                    .query_row("SELECT size, mtime FROM watch_seen WHERE path = ?1", [&key], |r| {
                        Ok((r.get(0)?, r.get(1)?))
                    })
                    .ok();
                (seen != Some(st)).then_some((p, st))
            })
            .collect()
    };
    let mut out = Vec::new();
    for (p, (size, mtime)) in todo {
        let a = app.clone();
        let path = p.clone();
        let r = tauri::async_runtime::spawn_blocking(move || local::import_one(&a, &path))
            .await
            .map_err(|e| e.to_string())?;
        {
            let conn = db.0.lock().unwrap();
            let _ = conn.execute(
                "INSERT INTO watch_seen (path, size, mtime) VALUES (?1, ?2, ?3)
                 ON CONFLICT(path) DO UPDATE SET size = excluded.size, mtime = excluded.mtime",
                rusqlite::params![p.to_string_lossy(), size, mtime],
            );
        }
        if r.status != "duplicate" {
            out.push(r);
        }
    }
    drop(guard);
    Ok(out)
}

// ---- Export / restore ------------------------------------------------------------

const FORMAT: &str = "pntome-local";
/// Per-book tables carried in an export, all keyed by `asin`. Rows of the
/// tables with an `id` column get a new id when restored.
const TABLES: [&str; 10] = [
    "book_override",
    "reading_state",
    "reader_position",
    "shelf_order",
    "annotation",
    "bookmark",
    "vocab",
    "reading_log",
    "book_event",
    "xray",
];
const ID_TABLES: [&str; 3] = ["annotation", "bookmark", "vocab"];

fn to_json(v: ValueRef) -> Value {
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => json!(i),
        ValueRef::Real(f) => json!(f),
        ValueRef::Text(t) => json!(String::from_utf8_lossy(t)),
        ValueRef::Blob(_) => Value::Null,
    }
}

fn to_sql(v: &Value) -> SqlValue {
    match v {
        Value::Null => SqlValue::Null,
        Value::Bool(b) => SqlValue::Integer(*b as i64),
        Value::Number(n) => n
            .as_i64()
            .map(SqlValue::Integer)
            .unwrap_or_else(|| SqlValue::Real(n.as_f64().unwrap_or(0.0))),
        Value::String(s) => SqlValue::Text(s.clone()),
        other => SqlValue::Text(other.to_string()),
    }
}

fn columns(conn: &rusqlite::Connection, table: &str) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let cols = stmt.query_map([], |r| r.get::<_, String>(1))?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(cols)
}

/// Rows of `table` for these books, as JSON objects.
fn dump(conn: &rusqlite::Connection, table: &str, ids: &[String]) -> rusqlite::Result<Vec<Value>> {
    let cols = columns(conn, table)?;
    if !cols.iter().any(|c| c == "asin") {
        return Ok(vec![]);
    }
    let mut out = Vec::new();
    let mut stmt = conn.prepare(&format!("SELECT * FROM {table} WHERE asin = ?1"))?;
    for id in ids {
        let mut rows = stmt.query([id])?;
        while let Some(r) = rows.next()? {
            let mut o = Map::new();
            for (i, c) in cols.iter().enumerate() {
                if ID_TABLES.contains(&table) && c == "id" {
                    continue;
                }
                o.insert(c.clone(), to_json(r.get_ref(i)?));
            }
            out.push(Value::Object(o));
        }
    }
    Ok(out)
}

#[derive(serde::Serialize)]
pub struct ExportSummary {
    pub books: usize,
    pub bytes: u64,
}

/// Write every local book and its reading data into one `.zip` at `dest`.
#[tauri::command]
pub async fn export_local_library(app: AppHandle, dest: String) -> Result<ExportSummary, String> {
    tauri::async_runtime::spawn_blocking(move || export_blocking(&app, Path::new(&dest)))
        .await
        .map_err(|e| e.to_string())?
}

fn export_blocking(app: &AppHandle, dest: &Path) -> Result<ExportSummary, String> {
    let db: State<Db> = app.state();
    let books: Vec<(String, Option<String>, Option<String>)> = db
        .list_library()
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|r| r.source == "local")
        .map(|r| {
            let f = db.local_file(&r.asin);
            (
                r.asin,
                f.as_ref().and_then(|f| f.original_name.clone()),
                f.and_then(|f| f.original_path),
            )
        })
        .collect();
    let ids: Vec<String> = books.iter().map(|b| b.0.clone()).collect();
    let mut tables = Map::new();
    let mut covers: Vec<String> = Vec::new();
    {
        let conn = db.0.lock().unwrap();
        for t in TABLES {
            let rows = dump(&conn, t, &ids).map_err(|e| format!("{t}: {e}"))?;
            if t == "book_override" {
                covers.extend(rows.iter().filter_map(|r| r.get("cover_file")?.as_str().map(String::from)));
            }
            tables.insert(t.into(), Value::Array(rows));
        }
    }
    covers.retain(|c| c != crate::db::TYPOGRAPHIC_COVER && crate::library_meta::safe_cover_name(c));

    let tmp = dest.with_extension("zip.part");
    let file = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(file);
    let stored = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    let deflate = zip::write::SimpleFileOptions::default();
    let mut manifest_books = Vec::new();
    let mut written = 0usize;
    for (id, name, path) in &books {
        let Ok(bytes) = std::fs::read(local::book_path(app, id)?) else { continue };
        let entry = format!("books/{id}.epub");
        // EPUBs are already compressed.
        zip.start_file(&entry, stored).map_err(|e| e.to_string())?;
        zip.write_all(&bytes).map_err(|e| e.to_string())?;
        manifest_books.push(json!({"id": id, "file": entry, "original_name": name, "original_path": path}));
        written += 1;
    }
    let covers_dir = crate::library_meta::covers_dir(app)?;
    let mut manifest_covers = Vec::new();
    for c in &covers {
        if let Ok(bytes) = std::fs::read(covers_dir.join(c)) {
            zip.start_file(format!("covers/{c}"), stored).map_err(|e| e.to_string())?;
            zip.write_all(&bytes).map_err(|e| e.to_string())?;
            manifest_covers.push(c.clone());
        }
    }
    let manifest = json!({
        "format": FORMAT,
        "version": 1,
        "exported_at": chrono::Utc::now().to_rfc3339(),
        "books": manifest_books,
        "covers": manifest_covers,
        "tables": tables,
    });
    zip.start_file("manifest.json", deflate).map_err(|e| e.to_string())?;
    zip.write_all(serde_json::to_string(&manifest).map_err(|e| e.to_string())?.as_bytes())
        .map_err(|e| e.to_string())?;
    zip.finish().map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, dest).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })?;
    Ok(ExportSummary { books: written, bytes: std::fs::metadata(dest).map(|m| m.len()).unwrap_or(0) })
}

#[derive(serde::Serialize)]
pub struct RestoreSummary {
    /// Books new to this computer.
    pub added: usize,
    /// Books that were already here.
    pub existing: usize,
    /// Books in the file that could not be added.
    pub failed: usize,
    /// Highlights, bookmarks, positions… brought back.
    pub rows: usize,
}

/// Bring back an export made with `export_local_library`. Books already here
/// keep their own position and edits; highlights and the rest are merged.
#[tauri::command]
pub async fn import_local_library(app: AppHandle, src: String) -> Result<RestoreSummary, String> {
    let guard = local::IMPORTING.lock().await;
    let r = tauri::async_runtime::spawn_blocking(move || restore_blocking(&app, Path::new(&src)))
        .await
        .map_err(|e| e.to_string())?;
    drop(guard);
    r
}

fn restore_blocking(app: &AppHandle, src: &Path) -> Result<RestoreSummary, String> {
    let file = std::fs::read(src).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(Cursor::new(file)).map_err(|_| "not_backup".to_string())?;
    let manifest: Value = {
        let mut f = zip.by_name("manifest.json").map_err(|_| "not_backup".to_string())?;
        let mut s = String::new();
        f.read_to_string(&mut s).map_err(|e| e.to_string())?;
        serde_json::from_str(&s).map_err(|_| "not_backup".to_string())?
    };
    if manifest.get("format").and_then(Value::as_str) != Some(FORMAT) {
        return Err("not_backup".into());
    }
    let mut sum = RestoreSummary { added: 0, existing: 0, failed: 0, rows: 0 };
    let mut present: Vec<String> = Vec::new();
    for b in manifest.get("books").and_then(Value::as_array).cloned().unwrap_or_default() {
        let (Some(id), Some(entry)) = (b.get("id").and_then(Value::as_str), b.get("file").and_then(Value::as_str)) else {
            continue;
        };
        let mut bytes = Vec::new();
        if zip.by_name(entry).and_then(|mut f| f.read_to_end(&mut bytes).map_err(Into::into)).is_err() {
            sum.failed += 1;
            continue;
        }
        let name = b.get("original_name").and_then(Value::as_str).unwrap_or(entry).to_string();
        let path = b.get("original_path").and_then(Value::as_str).unwrap_or(&name).to_string();
        let r = local::import_bytes(app, &bytes, path, name);
        match r.status.as_str() {
            "added" => sum.added += 1,
            "duplicate" => sum.existing += 1,
            _ => {
                sum.failed += 1;
                continue;
            }
        }
        // The id is the file's hash, so it is the same on both computers.
        present.push(r.id.unwrap_or_else(|| id.to_string()));
    }

    let covers_dir = crate::library_meta::covers_dir(app)?;
    for c in manifest.get("covers").and_then(Value::as_array).cloned().unwrap_or_default() {
        let Some(c) = c.as_str().filter(|c| crate::library_meta::safe_cover_name(c)) else { continue };
        let target = covers_dir.join(c);
        if target.exists() {
            continue;
        }
        let mut bytes = Vec::new();
        if zip.by_name(&format!("covers/{c}")).and_then(|mut f| f.read_to_end(&mut bytes).map_err(Into::into)).is_ok() {
            let _ = std::fs::write(target, bytes);
        }
    }

    let db: State<Db> = app.state();
    let conn = db.0.lock().unwrap();
    let tables = manifest.get("tables").and_then(Value::as_object).cloned().unwrap_or_default();
    sum.rows = restore_rows(&conn, &tables, &present).map_err(|e| e.to_string())?;
    Ok(sum)
}

/// Insert the exported rows that belong to `present` books. Returns how many went in.
fn restore_rows(conn: &rusqlite::Connection, tables: &Map<String, Value>, present: &[String]) -> rusqlite::Result<usize> {
    let mut added = 0;
    for t in TABLES {
        let Some(rows) = tables.get(t).and_then(Value::as_array) else { continue };
        let cols = columns(conn, t)?;
        for row in rows {
            let Some(o) = row.as_object() else { continue };
            let Some(asin) = o.get("asin").and_then(Value::as_str) else { continue };
            if !present.iter().any(|p| p == asin) {
                continue;
            }
            // A highlight / bookmark / word already here (same place, same time) is not doubled.
            if ID_TABLES.contains(&t) {
                let dup: bool = conn
                    .query_row(
                        &format!("SELECT 1 FROM {t} WHERE asin = ?1 AND cfi IS ?2 AND created_at IS ?3"),
                        rusqlite::params![asin, to_sql(o.get("cfi").unwrap_or(&Value::Null)), to_sql(o.get("created_at").unwrap_or(&Value::Null))],
                        |_| Ok(()),
                    )
                    .is_ok();
                if dup {
                    continue;
                }
            }
            let keep: Vec<(&String, &Value)> = o.iter().filter(|(k, _)| cols.contains(k) && !(ID_TABLES.contains(&t) && k.as_str() == "id")).collect();
            if keep.is_empty() {
                continue;
            }
            let names: Vec<&str> = keep.iter().map(|(k, _)| k.as_str()).collect();
            let marks: Vec<String> = (1..=keep.len()).map(|i| format!("?{i}")).collect();
            let sql = format!("INSERT OR IGNORE INTO {t} ({}) VALUES ({})", names.join(", "), marks.join(", "));
            let vals: Vec<SqlValue> = keep.iter().map(|(_, v)| to_sql(v)).collect();
            if let Ok(n) = conn.execute(&sql, rusqlite::params_from_iter(vals)) {
                added += n;
            }
        }
    }
    Ok(added)
}

/// Default file name for an export: `pntome-sach-tren-may-2026-11-20.zip`.
#[tauri::command]
pub fn export_file_name() -> String {
    format!("pntome-sach-tren-may-{}.zip", chrono::Local::now().format("%Y-%m-%d"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rows_round_trip_without_doubling() {
        let path = std::env::temp_dir().join(format!("pnb-io-{}.sqlite", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let db = Db::open(&path).unwrap();
        let id = "L_0123456789abcdef01234567".to_string();
        {
            let conn = db.0.lock().unwrap();
            conn.execute(
                "INSERT INTO annotation (asin, cfi, fraction, color, note, created_at) VALUES (?1, 'epubcfi(/6/2)', 0.1, 'yellow', 'hi', '2026-11-20 10:00:00')",
                [&id],
            )
            .unwrap();
            conn.execute("INSERT INTO reader_position (asin, cfi, fraction) VALUES (?1, 'epubcfi(/6/4)', 0.3)", [&id]).unwrap();
        }
        let tables: Map<String, Value> = {
            let conn = db.0.lock().unwrap();
            TABLES.iter().map(|t| (t.to_string(), Value::Array(dump(&conn, t, &[id.clone()]).unwrap()))).collect()
        };
        assert!(tables["annotation"][0].get("id").is_none());
        {
            let conn = db.0.lock().unwrap();
            conn.execute("DELETE FROM reader_position", []).unwrap();
            // Restoring brings the position back and does not double the highlight.
            assert_eq!(restore_rows(&conn, &tables, &[id.clone()]).unwrap(), 1);
            let n: i64 = conn.query_row("SELECT COUNT(*) FROM annotation", [], |r| r.get(0)).unwrap();
            assert_eq!(n, 1);
            let f: f64 = conn.query_row("SELECT fraction FROM reader_position", [], |r| r.get(0)).unwrap();
            assert_eq!(f, 0.3);
            // Rows of books that were not restored are left out.
            assert_eq!(restore_rows(&conn, &tables, &[]).unwrap(), 0);
        }
        drop(db);
        let _ = std::fs::remove_file(&path);
    }
}
