//! Highlights and notes in the in-app reader, kept in step with Kindle.
//!
//! One row is a highlighted passage (with an optional note). It is stored by
//! CFI (where it is in the rendered book) and, when the book allows it, by
//! Kindle position (`kstart..=kend`, byte offsets into the raw text, as the
//! sidecar uses), which is what syncs.
//!
//! Sync state per row: `dirty` = has local changes Kindle has not seen,
//! `on_kindle` = Kindle has it, `deleted` = removed here but the delete has
//! not reached Kindle yet (a tombstone, so a pull does not bring it back).

use tauri::{AppHandle, Manager, State};

use crate::adp::client;
use crate::creds;
use crate::db::Db;

pub const COLORS: [&str; 4] = ["yellow", "blue", "pink", "orange"];

pub const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS annotation (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    asin        TEXT NOT NULL,
    cfi         TEXT NOT NULL,
    kstart      INTEGER,
    kend        INTEGER,
    fraction    REAL NOT NULL,
    color       TEXT NOT NULL,
    note        TEXT,
    excerpt     TEXT,
    chapter     TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    dirty       INTEGER NOT NULL DEFAULT 1,
    on_kindle   INTEGER NOT NULL DEFAULT 0,
    kindle_note TEXT,
    deleted     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS annotation_asin ON annotation(asin, fraction);
";

#[derive(Debug, Clone, serde::Serialize)]
pub struct Annotation {
    pub id: i64,
    pub cfi: String,
    pub kstart: Option<i64>,
    pub kend: Option<i64>,
    pub fraction: f64,
    pub color: String,
    pub note: Option<String>,
    pub excerpt: Option<String>,
    pub chapter: Option<String>,
    pub created_at: String,
    /// Kindle has this exactly as shown (nothing waiting to sync).
    pub synced: bool,
    /// Kindle has some version of it (its position can no longer change).
    pub on_kindle: bool,
}

const COLS: &str = "id, cfi, kstart, kend, fraction, color, note, excerpt, chapter, created_at, dirty, on_kindle";

fn row(r: &rusqlite::Row) -> rusqlite::Result<Annotation> {
    let dirty: bool = r.get(10)?;
    let on_kindle: bool = r.get(11)?;
    Ok(Annotation {
        id: r.get(0)?,
        cfi: r.get(1)?,
        kstart: r.get(2)?,
        kend: r.get(3)?,
        fraction: r.get(4)?,
        color: r.get(5)?,
        note: r.get(6)?,
        excerpt: r.get(7)?,
        chapter: r.get(8)?,
        created_at: r.get(9)?,
        synced: on_kindle && !dirty,
        on_kindle,
    })
}

fn clip(s: Option<String>, n: usize) -> Option<String> {
    s.map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .map(|v| v.chars().take(n).collect())
}

fn check_color(c: &str) -> Result<(), String> {
    if COLORS.contains(&c) {
        Ok(())
    } else {
        Err(format!("unknown colour {c}"))
    }
}

fn list(db: &Db, asin: &str) -> Result<Vec<Annotation>, String> {
    let conn = db.0.lock().unwrap();
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {COLS} FROM annotation WHERE asin = ?1 AND deleted = 0 ORDER BY fraction, id"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([asin], row)
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// A book's highlights and notes, in reading order.
#[tauri::command]
pub fn list_annotations(db: State<Db>, asin: String) -> Result<Vec<Annotation>, String> {
    list(&db, &asin)
}

/// Highlight a passage. `from_kindle` marks one imported from Kindle (already
/// there, so nothing to push).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn add_annotation(
    db: State<Db>,
    asin: String,
    cfi: String,
    kstart: Option<i64>,
    kend: Option<i64>,
    fraction: f64,
    color: String,
    note: Option<String>,
    excerpt: Option<String>,
    chapter: Option<String>,
    from_kindle: Option<bool>,
) -> Result<Annotation, String> {
    if !cfi.starts_with("epubcfi(") {
        return Err("bad position".into());
    }
    check_color(&color)?;
    let note = clip(note, 4000);
    let kindle = from_kindle.unwrap_or(false);
    let conn = db.0.lock().unwrap();
    conn.execute(
        "INSERT INTO annotation (asin, cfi, kstart, kend, fraction, color, note, excerpt, chapter,
                                 dirty, on_kindle, kindle_note)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        rusqlite::params![
            asin,
            cfi,
            kstart,
            kend,
            fraction.clamp(0.0, 1.0),
            color,
            note,
            clip(excerpt, 1000),
            clip(chapter, 120),
            !kindle,
            kindle,
            if kindle { note.clone() } else { None },
        ],
    )
    .map_err(|e| e.to_string())?;
    let id = conn.last_insert_rowid();
    conn.query_row(&format!("SELECT {COLS} FROM annotation WHERE id = ?1"), [id], row)
        .map_err(|e| e.to_string())
}

/// Change a highlight's colour and/or note (`note: ""` removes the note).
#[tauri::command]
pub fn update_annotation(
    db: State<Db>,
    id: i64,
    color: Option<String>,
    note: Option<String>,
) -> Result<Annotation, String> {
    let conn = db.0.lock().unwrap();
    if let Some(c) = color.as_deref() {
        check_color(c)?;
        conn.execute(
            "UPDATE annotation SET color = ?2, dirty = 1, updated_at = datetime('now') WHERE id = ?1",
            rusqlite::params![id, c],
        )
        .map_err(|e| e.to_string())?;
    }
    if let Some(n) = note {
        conn.execute(
            "UPDATE annotation SET note = ?2, dirty = 1, updated_at = datetime('now') WHERE id = ?1",
            rusqlite::params![id, clip(Some(n), 4000)],
        )
        .map_err(|e| e.to_string())?;
    }
    conn.query_row(&format!("SELECT {COLS} FROM annotation WHERE id = ?1"), [id], row)
        .map_err(|e| e.to_string())
}

/// Correct the Kindle position of a highlight Kindle does not have yet
/// (positions are recomputed from its CFI when the book opens).
#[tauri::command]
pub fn set_annotation_kpos(db: State<Db>, id: i64, kstart: i64, kend: i64) -> Result<(), String> {
    let conn = db.0.lock().unwrap();
    conn.execute(
        "UPDATE annotation SET kstart = ?2, kend = ?3 WHERE id = ?1 AND on_kindle = 0",
        rusqlite::params![id, kstart, kend],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Remove a highlight. One Kindle already has stays as a tombstone until the
/// delete is pushed.
#[tauri::command]
pub fn remove_annotation(db: State<Db>, id: i64) -> Result<(), String> {
    let conn = db.0.lock().unwrap();
    conn.execute("DELETE FROM annotation WHERE id = ?1 AND on_kindle = 0", [id])
        .map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE annotation SET deleted = 1, dirty = 1, updated_at = datetime('now') WHERE id = ?1",
        [id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ---- Kindle sync ------------------------------------------------------------

/// A highlight or note as the Kindle sidecar reports it.
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct KindleRecord {
    pub kind: String,
    pub start: i64,
    pub end: i64,
    pub color: Option<String>,
    pub text: Option<String>,
}

fn num(v: Option<&serde_json::Value>) -> Option<i64> {
    match v? {
        serde_json::Value::Number(n) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)),
        serde_json::Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

/// Highlights and notes in a sidecar response. Field names vary between
/// record kinds, so several spellings are accepted.
pub fn parse_kindle_records(json: &str) -> Vec<KindleRecord> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(json) else {
        return vec![];
    };
    let Some(records) = v["payload"]["records"].as_array() else {
        return vec![];
    };
    let mut out = vec![];
    for r in records {
        let kind = match r["type"].as_str() {
            Some("kindle.highlight") => "highlight",
            Some("kindle.note") => "note",
            _ => continue,
        };
        let start = num(r.get("startPosition"))
            .or_else(|| num(r.get("begin")))
            .or_else(|| num(r.get("start")))
            .or_else(|| num(r.get("location")));
        let Some(start) = start else { continue };
        let end = num(r.get("endPosition"))
            .or_else(|| num(r.get("end")))
            .unwrap_or(start);
        let meta = r.get("metadata").and_then(|m| match m {
            serde_json::Value::String(s) => serde_json::from_str::<serde_json::Value>(s).ok(),
            other => Some(other.clone()),
        });
        let color = r["color"]
            .as_str()
            .or_else(|| r["mchl_color"].as_str())
            .or_else(|| meta.as_ref().and_then(|m| m["mchl_color"].as_str()))
            .map(|c| c.to_ascii_lowercase())
            .filter(|c| COLORS.contains(&c.as_str()));
        let text = ["text", "userText", "note", "content", "value"]
            .iter()
            .find_map(|k| r[*k].as_str())
            .map(str::to_string);
        out.push(KindleRecord {
            kind: kind.into(),
            start,
            end,
            color,
            text,
        });
    }
    out
}

/// What a pull found that the reader still has to place (it needs the book
/// open to turn Kindle positions into CFIs).
#[derive(Debug, Clone, serde::Serialize)]
pub struct PullResult {
    /// Highlights (with their note, if any) the app does not have yet.
    pub new: Vec<KindleRecord>,
    /// Rows updated or removed because Kindle changed them.
    pub changed: usize,
}

/// Bring Kindle's highlights and notes for a book into the app. Rows the app
/// already has are updated (colour, note) unless they have local edits; rows
/// Kindle no longer has are removed (deleted on another device); new ones are
/// returned for the reader to place.
#[tauri::command]
pub async fn kindle_pull_annotations(
    app: AppHandle,
    db: State<'_, Db>,
    asin: String,
    cde_type: String,
) -> Result<PullResult, String> {
    let creds_bundle = creds::load()?.ok_or_else(|| "not signed in".to_string())?;
    let acr = book_acr(&app, &asin).ok_or("book file not cached")?;
    // First ask which guid the server files the book under, then ask again
    // for the positions in our build's coordinates.
    let first = client::sidecar_json(&creds_bundle, &asin, &cde_type, None)
        .await
        .map_err(|e| e.to_string())?;
    let server_guid = serde_json::from_str::<serde_json::Value>(&first)
        .ok()
        .and_then(|v| v["payload"]["guid"].as_str().map(str::to_string))
        .unwrap_or_default();
    let ours = client::guid_for(&acr, &server_guid);
    let json = if server_guid.is_empty() || server_guid == ours {
        first
    } else {
        client::sidecar_json(&creds_bundle, &asin, &cde_type, Some(&ours))
            .await
            .map_err(|e| e.to_string())?
    };
    let records = parse_kindle_records(&json);
    Ok(merge_pull(&db, &asin, records))
}

/// The build id (`CR!…`) of the book file the app has for `asin`.
pub fn book_acr(app: &AppHandle, asin: &str) -> Option<String> {
    let path = app.path().app_data_dir().ok()?.join("books").join(format!("{asin}.azw3"));
    client::local_acr(&std::fs::read(path).ok()?)
}

fn merge_pull(db: &Db, asin: &str, records: Vec<KindleRecord>) -> PullResult {
    // Highlights keyed by range; a note joins the highlight over the same
    // range (or containing its point), else stands alone.
    let mut highlights: Vec<KindleRecord> = records.iter().filter(|r| r.kind == "highlight").cloned().collect();
    for n in records.iter().filter(|r| r.kind == "note") {
        if let Some(h) = highlights
            .iter_mut()
            .find(|h| (h.start == n.start && h.end == n.end) || (n.start >= h.start && n.start <= h.end))
        {
            h.text = n.text.clone();
        } else {
            highlights.push(KindleRecord {
                kind: "highlight".into(),
                color: Some("yellow".into()),
                ..n.clone()
            });
        }
    }

    let conn = db.0.lock().unwrap();
    let mut changed = 0;
    let mut new = vec![];
    for h in &highlights {
        let found: Option<(i64, bool, bool)> = conn
            .query_row(
                "SELECT id, dirty, deleted FROM annotation WHERE asin = ?1 AND kstart = ?2 AND kend = ?3",
                rusqlite::params![asin, h.start, h.end],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .ok();
        match found {
            Some((_, _, true)) => {} // deleted here, delete not pushed yet
            Some((id, dirty, false)) => {
                let color = h.color.clone().unwrap_or_else(|| "yellow".into());
                let n = if dirty {
                    // Local edits win; just record that Kindle has it.
                    conn.execute(
                        "UPDATE annotation SET on_kindle = 1 WHERE id = ?1 AND on_kindle = 0",
                        [id],
                    )
                } else {
                    conn.execute(
                        "UPDATE annotation SET color = ?2, note = ?3, kindle_note = ?3, on_kindle = 1
                         WHERE id = ?1 AND (color <> ?2 OR IFNULL(note, '') <> IFNULL(?3, '') OR on_kindle = 0)",
                        rusqlite::params![id, color, h.text],
                    )
                };
                changed += n.unwrap_or(0);
            }
            None => new.push(h.clone()),
        }
    }
    // Synced rows Kindle no longer has were deleted elsewhere.
    let keep: Vec<(i64, i64)> = highlights.iter().map(|h| (h.start, h.end)).collect();
    let gone: Vec<i64> = conn
        .prepare(
            "SELECT id, kstart, kend FROM annotation
             WHERE asin = ?1 AND on_kindle = 1 AND dirty = 0 AND kstart IS NOT NULL",
        )
        .and_then(|mut s| {
            s.query_map([asin], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .unwrap_or_default()
        .into_iter()
        .filter(|(_, s, e)| !keep.contains(&(*s, *e)))
        .map(|(id, _, _)| id)
        .collect();
    for id in gone {
        changed += conn.execute("DELETE FROM annotation WHERE id = ?1", [id]).unwrap_or(0);
    }
    PullResult { new, changed }
}

struct Pending {
    id: i64,
    kstart: i64,
    kend: i64,
    color: String,
    note: Option<String>,
    kindle_note: Option<String>,
    on_kindle: bool,
    deleted: bool,
}

/// The sidecar items that bring Kindle in line with one row.
fn items_for(p: &Pending, ts: &str) -> String {
    let (b, e) = (p.kstart, p.kend);
    let hl = |action: &str| {
        format!(
            "<highlight action=\"{action}\" begin=\"{b}\" end=\"{e}\" timestamp=\"{ts}\">\
<metadata><![CDATA[{{\"mchl_color\":\"{}\"}}]]></metadata></highlight>",
            p.color
        )
    };
    let note = |action: &str, text: &str| {
        format!(
            "<note action=\"{action}\" begin=\"{b}\" end=\"{e}\" pos=\"{b}\" timestamp=\"{ts}\">{}</note>",
            client::xml_escape(text)
        )
    };
    let mut out = String::new();
    if p.deleted {
        if p.on_kindle {
            if let Some(k) = &p.kindle_note {
                out += &note("delete", k);
            }
            out += &hl("delete");
        }
        return out;
    }
    out += &hl(if p.on_kindle { "modify" } else { "create" });
    match (&p.kindle_note, &p.note) {
        (None, Some(n)) => out += &note("create", n),
        (Some(old), Some(n)) if old != n => out += &note("modify", n),
        (Some(old), None) => out += &note("delete", old),
        _ => {}
    }
    out
}

/// Push every local change of a book's highlights to Kindle. Rows without a
/// Kindle position (older MOBI books) stay app-only. Returns how many rows
/// were pushed.
#[tauri::command]
pub async fn kindle_push_annotations(
    app: AppHandle,
    db: State<'_, Db>,
    asin: String,
    cde_type: String,
) -> Result<usize, String> {
    let pending: Vec<Pending> = {
        let conn = db.0.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, kstart, kend, color, note, kindle_note, on_kindle, deleted FROM annotation
                 WHERE asin = ?1 AND dirty = 1 AND kstart IS NOT NULL AND kend IS NOT NULL",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([&asin], |r| {
                Ok(Pending {
                    id: r.get(0)?,
                    kstart: r.get(1)?,
                    kend: r.get(2)?,
                    color: r.get(3)?,
                    note: r.get(4)?,
                    kindle_note: r.get(5)?,
                    on_kindle: r.get(6)?,
                    deleted: r.get(7)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?;
        rows
    };
    if pending.is_empty() {
        return Ok(0);
    }
    let creds_bundle = creds::load()?.ok_or_else(|| "not signed in".to_string())?;
    // Without our build's id Amazon would read the positions as its own
    // build's and misplace them, so never push blind.
    let acr = book_acr(&app, &asin).ok_or("book file not cached")?;
    let ts = client::annotation_timestamp();
    let items: String = pending.iter().map(|p| items_for(p, &ts)).collect();
    if !items.is_empty() {
        client::upload_annotations(&creds_bundle, &asin, &cde_type, &items, Some(&acr))
            .await
            .map_err(|e| e.to_string())?;
    }
    let conn = db.0.lock().unwrap();
    for p in &pending {
        if p.deleted {
            let _ = conn.execute("DELETE FROM annotation WHERE id = ?1", [p.id]);
        } else {
            let _ = conn.execute(
                "UPDATE annotation SET dirty = 0, on_kindle = 1, kindle_note = note WHERE id = ?1",
                [p.id],
            );
        }
    }
    Ok(pending.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_highlight_and_note() {
        let json = r#"{"payload":{"records":[
            {"type":"kindle.highlight","startPosition":"100","endPosition":"140","metadata":{"mchl_color":"Blue"}},
            {"type":"kindle.note","startPosition":120,"endPosition":120,"text":"hi"},
            {"type":"kindle.lpr","location":"5"}]}}"#;
        let r = parse_kindle_records(json);
        assert_eq!(r.len(), 2);
        assert_eq!((r[0].start, r[0].end, r[0].color.as_deref()), (100, 140, Some("blue")));
        assert_eq!(r[1].text.as_deref(), Some("hi"));
    }

    #[test]
    fn guid_uses_our_build() {
        let bytes = b"xx CR!T6QES2N65H3BHFQDZ4XQTG6ZV3AJ yy";
        let acr = client::local_acr(bytes).unwrap();
        assert_eq!(acr, "CR!T6QES2N65H3BHFQDZ4XQTG6ZV3AJ");
        assert_eq!(
            client::guid_for(&acr, "CR!EMB09DVCRS2RBAB8M8S4EDTS58RA:F5EC1DB2"),
            "CR!T6QES2N65H3BHFQDZ4XQTG6ZV3AJ:F5EC1DB2"
        );
    }

    #[test]
    fn items_cover_create_modify_delete() {
        let mut p = Pending {
            id: 1,
            kstart: 10,
            kend: 20,
            color: "pink".into(),
            note: Some("a<b".into()),
            kindle_note: None,
            on_kindle: false,
            deleted: false,
        };
        let s = items_for(&p, "T");
        assert!(s.contains("<highlight action=\"create\" begin=\"10\" end=\"20\""));
        assert!(s.contains("\"mchl_color\":\"pink\""));
        assert!(s.contains("<note action=\"create\"") && s.contains("a&lt;b"));
        p.on_kindle = true;
        p.kindle_note = Some("a<b".into());
        p.deleted = true;
        let s = items_for(&p, "T");
        assert!(s.contains("<note action=\"delete\"") && s.contains("<highlight action=\"delete\""));
    }
}


