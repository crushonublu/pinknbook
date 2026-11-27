//! Local SQLite store (non-secret data only). Secrets live in the OS keyring.

use std::sync::Mutex;

use rusqlite::Connection;

use crate::adp::client::{Book, ReadingState};
use crate::meta;

pub struct Db(pub Mutex<Connection>);

impl Db {
    pub fn open(path: &std::path::Path) -> rusqlite::Result<Self> {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.execute_batch(SCHEMA)?;
        migrate(&conn)?;
        conn.execute_batch(crate::bookmarks::SCHEMA)?;
        conn.execute_batch(crate::annotations::SCHEMA)?;
        conn.execute_batch(crate::stats::SCHEMA)?;
        crate::stats::migrate(&conn)?;
        conn.execute_batch(crate::vocab::SCHEMA)?;
        conn.execute_batch(crate::ai::SCHEMA)?;
        conn.execute_batch(crate::goodreads::SCHEMA)?;
        conn.execute_batch(crate::genre::SCHEMA)?;
        conn.execute_batch(crate::wrap::SCHEMA)?;
        conn.execute_batch(crate::local_io::SCHEMA)?;
        Ok(Db(Mutex::new(conn)))
    }

    /// Save (or update) the signed-in account's non-secret details.
    pub fn save_account(
        &self,
        directed_id: &str,
        marketplace: &str,
        device_serial: &str,
        device_type: &str,
        device_name: &str,
    ) -> rusqlite::Result<()> {
        let conn = self.0.lock().unwrap();
        conn.execute(
            "INSERT INTO account (directed_id, marketplace, device_serial, device_type, device_name, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'))
             ON CONFLICT(directed_id) DO UPDATE SET
               marketplace=excluded.marketplace,
               device_serial=excluded.device_serial,
               device_type=excluded.device_type,
               device_name=excluded.device_name",
            rusqlite::params![directed_id, marketplace, device_serial, device_type, device_name],
        )?;
        Ok(())
    }

    /// The directedId of the signed-in account, if any. (Reserved for v1.1 sync.)
    #[allow(dead_code)]
    pub fn current_account(&self) -> rusqlite::Result<Option<String>> {
        let conn = self.0.lock().unwrap();
        conn.query_row(
            "SELECT directed_id FROM account ORDER BY created_at DESC LIMIT 1",
            [],
            |r| r.get::<_, String>(0),
        )
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        })
    }

    /// Upsert a batch of books from a library sync.
    pub fn upsert_books(&self, books: &[Book]) -> rusqlite::Result<()> {
        let mut conn = self.0.lock().unwrap();
        let tx = conn.transaction()?;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO book (asin, type, title, author, content_type, purchase_date, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now'))
                 ON CONFLICT(asin) DO UPDATE SET
                   type=excluded.type, title=excluded.title, author=excluded.author,
                   content_type=excluded.content_type, purchase_date=excluded.purchase_date,
                   updated_at=datetime('now')",
            )?;
            for b in books {
                stmt.execute(rusqlite::params![
                    b.asin,
                    b.cde_type,
                    b.title,
                    b.author,
                    b.content_type,
                    b.purchase_date
                ])?;
            }
        }
        tx.commit()
    }

    /// Drop books that are no longer in the Amazon library, given the full
    /// list it holds now. Their derived data (metadata, reading state, shelf
    /// place, edits) goes too; highlights, bookmarks and reading stats stay so
    /// they come back if the book is added again. Returns the removed ASINs.
    pub fn prune_books(&self, keep: &[String]) -> rusqlite::Result<Vec<String>> {
        let mut conn = self.0.lock().unwrap();
        let tx = conn.transaction()?;
        let keep: std::collections::HashSet<&str> = keep.iter().map(String::as_str).collect();
        let gone: Vec<String> = {
            // Only Amazon books: books added from this computer are never in the sync.
            let mut stmt = tx.prepare("SELECT asin FROM book WHERE COALESCE(source, 'amazon') = 'amazon'")?;
            let all = stmt
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            all.into_iter().filter(|a| !keep.contains(a.as_str())).collect()
        };
        for asin in &gone {
            delete_book_rows(&tx, asin)?;
        }
        tx.commit()?;
        Ok(gone)
    }

    /// Add a book from this computer (see local.rs). `id` is its `L_…` key.
    pub fn insert_local_book(&self, b: &NewLocalBook) -> rusqlite::Result<()> {
        let mut conn = self.0.lock().unwrap();
        let tx = conn.transaction()?;
        tx.execute(
            "INSERT INTO book (asin, type, title, author, content_type, purchase_date, source, updated_at)
             VALUES (?1, 'LOCAL', ?2, ?3, ?4, ?5, 'local', datetime('now'))",
            rusqlite::params![b.id, b.title, b.author, b.content_type, b.added_at],
        )?;
        tx.execute(
            "INSERT OR REPLACE INTO local_file
               (asin, format, size, sha256, original_path, original_name, isbn, added_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![b.id, b.format, b.size, b.sha256, b.original_path, b.original_name, b.isbn, b.added_at],
        )?;
        tx.commit()
    }

    /// Title of a book already in the library under this key, if any.
    pub fn book_title(&self, asin: &str) -> Option<String> {
        let conn = self.0.lock().unwrap();
        conn.query_row("SELECT COALESCE(title, '') FROM book WHERE asin = ?1", [asin], |r| r.get(0))
            .ok()
    }

    /// Where a book added from this computer came from.
    pub fn local_file(&self, asin: &str) -> Option<LocalFile> {
        let conn = self.0.lock().unwrap();
        conn.query_row(
            "SELECT format, original_path, original_name, isbn FROM local_file WHERE asin = ?1",
            [asin],
            |r| {
                Ok(LocalFile {
                    format: r.get(0)?,
                    original_path: r.get(1)?,
                    original_name: r.get(2)?,
                    isbn: r.get(3)?,
                })
            },
        )
        .ok()
    }

    /// Every local ↔ Kindle pairing the user decided: (local_id, asin, state),
    /// state "linked" or "dismissed".
    pub fn book_links(&self) -> rusqlite::Result<Vec<(String, String, String)>> {
        let conn = self.0.lock().unwrap();
        let mut stmt = conn.prepare("SELECT local_id, asin, state FROM book_link")?;
        let rows = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// Link a local book to a Kindle book (one Kindle book per local book).
    pub fn link_book(&self, local_id: &str, asin: &str) -> rusqlite::Result<()> {
        let mut conn = self.0.lock().unwrap();
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM book_link WHERE (local_id = ?1 OR asin = ?2) AND state = 'linked'", [local_id, asin])?;
        tx.execute(
            "INSERT INTO book_link (local_id, asin, state, at) VALUES (?1, ?2, 'linked', datetime('now'))
             ON CONFLICT(local_id, asin) DO UPDATE SET state = 'linked', at = datetime('now')",
            [local_id, asin],
        )?;
        tx.commit()
    }

    /// "Not this book": never suggest this pair again.
    pub fn dismiss_link(&self, local_id: &str, asin: &str) -> rusqlite::Result<()> {
        let conn = self.0.lock().unwrap();
        conn.execute(
            "INSERT INTO book_link (local_id, asin, state, at) VALUES (?1, ?2, 'dismissed', datetime('now'))
             ON CONFLICT(local_id, asin) DO UPDATE SET state = 'dismissed', at = datetime('now')",
            [local_id, asin],
        )?;
        Ok(())
    }

    /// Undo a link (the pair is then not suggested again).
    pub fn unlink_book(&self, local_id: &str) -> rusqlite::Result<()> {
        let conn = self.0.lock().unwrap();
        conn.execute("UPDATE book_link SET state = 'dismissed', at = datetime('now') WHERE local_id = ?1 AND state = 'linked'", [local_id])?;
        Ok(())
    }

    /// Books added from this computer: (count, total bytes of the copies).
    pub fn local_usage(&self) -> rusqlite::Result<(i64, i64)> {
        let conn = self.0.lock().unwrap();
        conn.query_row("SELECT COUNT(*), COALESCE(SUM(size), 0) FROM local_file", [], |r| Ok((r.get(0)?, r.get(1)?)))
    }

    /// Take a book off the library: the book and what derives from it go;
    /// highlights, bookmarks, words and reading stats stay, so they come back
    /// if the same file is added again.
    pub fn remove_book(&self, asin: &str) -> rusqlite::Result<()> {
        let mut conn = self.0.lock().unwrap();
        let tx = conn.transaction()?;
        delete_book_rows(&tx, asin)?;
        tx.execute("DELETE FROM local_file WHERE asin = ?1", [asin])?;
        tx.commit()
    }

    /// Store reading state for one book (percent derived, position raw).
    pub fn upsert_reading_state(&self, st: &ReadingState) -> rusqlite::Result<()> {
        let conn = self.0.lock().unwrap();
        conn.execute(
            "INSERT INTO reading_state (asin, percent, furthest_pos, updated_at)
             VALUES (?1, ?2, ?3, datetime('now'))
             ON CONFLICT(asin) DO UPDATE SET
               percent=excluded.percent, furthest_pos=excluded.furthest_pos,
               updated_at=datetime('now')",
            rusqlite::params![st.asin, st.percent, st.position],
        )?;
        Ok(())
    }

    /// Save the in-app reader's position for a book (foliate CFI + 0..1 fraction).
    pub fn set_reader_position(
        &self,
        asin: &str,
        cfi: &str,
        fraction: f64,
    ) -> rusqlite::Result<()> {
        let conn = self.0.lock().unwrap();
        conn.execute(
            "INSERT INTO reader_position (asin, cfi, fraction, updated_at)
             VALUES (?1, ?2, ?3, datetime('now'))
             ON CONFLICT(asin) DO UPDATE SET
               cfi=excluded.cfi, fraction=excluded.fraction, updated_at=datetime('now')",
            rusqlite::params![asin, cfi, fraction],
        )?;
        Ok(())
    }

    /// The Amazon reading progress stored for a book: (furthest_pos, percent).
    /// `furthest_pos` is the raw Kindle location (byte offset) for exact resume;
    /// `percent` is the 0..100 display value (and a fraction fallback).
    pub fn reading_progress(&self, asin: &str) -> rusqlite::Result<Option<(Option<i64>, Option<f64>)>> {
        let conn = self.0.lock().unwrap();
        conn.query_row(
            "SELECT furthest_pos, percent FROM reading_state WHERE asin = ?1",
            [asin],
            |r| Ok((r.get::<_, Option<i64>>(0)?, r.get::<_, Option<f64>>(1)?)),
        )
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        })
    }

    /// The saved in-app reader position for a book, if any.
    pub fn reader_position(&self, asin: &str) -> rusqlite::Result<Option<ReaderPosition>> {
        let conn = self.0.lock().unwrap();
        conn.query_row(
            "SELECT cfi, fraction FROM reader_position WHERE asin = ?1",
            [asin],
            |r| {
                Ok(ReaderPosition {
                    cfi: r.get(0)?,
                    fraction: r.get(1)?,
                })
            },
        )
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        })
    }

    /// The full library joined with reading state and metadata, for the UI.
    /// Title/author are the display values: user override, else cleaned-up
    /// Amazon/file metadata (see meta.rs).
    pub fn list_library(&self) -> rusqlite::Result<Vec<LibraryRow>> {
        let conn = self.0.lock().unwrap();
        let mut stmt = conn.prepare(
            // Prefer the local in-app reading position (foliate fraction, which
            // matches the reader and Kindle's own location-based %) over the
            // Amazon furthest-read percentage (byte-based, only shown for books
            // not yet opened here) — so the card matches what the reader shows.
            "SELECT b.asin, b.type, b.title, b.author, b.content_type, b.purchase_date,
                    COALESCE(rp.fraction * 100.0, r.percent) AS percent,
                    r.furthest_pos,
                    m.title, m.author, m.description, m.subjects, m.language, m.publisher,
                    m.cover_file, m.spine_color, m.asin IS NOT NULL,
                    o.title, o.author, o.cover_file, o.spine_color,
                    r.status, COALESCE(r.status_manual, 0), rp.updated_at,
                    m.text_length, o.spine_style, o.spine_font, o.spine_width, so.pos,
                    COALESCE(b.source, 'amazon')
             FROM book b
             LEFT JOIN reading_state r ON r.asin = b.asin
             LEFT JOIN reader_position rp ON rp.asin = b.asin
             LEFT JOIN book_meta m ON m.asin = b.asin
             LEFT JOIN book_override o ON o.asin = b.asin
             LEFT JOIN shelf_order so ON so.asin = b.asin
             ORDER BY b.updated_at DESC, b.title",
        )?;
        let rows = stmt
            .query_map([], |r| {
                let asin: String = r.get(0)?;
                let lib_title: String = r.get::<_, Option<String>>(2)?.unwrap_or_default();
                let lib_author: String = r.get::<_, Option<String>>(3)?.unwrap_or_default();
                let file_title: Option<String> = r.get(8)?;
                let file_author: Option<String> = r.get(9)?;
                let (clean_title, clean_author) = meta::clean_title_author(
                    &lib_title,
                    &lib_author,
                    file_title.as_deref(),
                    file_author.as_deref(),
                );
                let o_title: Option<String> = r.get(17)?;
                let o_author: Option<String> = r.get(18)?;
                let o_cover: Option<String> = r.get(19)?;
                let o_spine: Option<String> = r.get(20)?;
                let subjects: Option<String> = r.get(11)?;
                let meta_spine: Option<String> = r.get(15)?;
                let meta_cover: Option<String> = r.get(14)?;
                let spine_style: Option<String> = r.get(25)?;
                let spine_font: Option<String> = r.get(26)?;
                let spine_width: Option<i64> = r.get(27)?;
                let spine_edited = spine_style.is_some() || spine_font.is_some() || spine_width.is_some();
                Ok(LibraryRow {
                    cde_type: r.get::<_, Option<String>>(1)?.unwrap_or_default(),
                    title: o_title.clone().unwrap_or_else(|| clean_title.clone()),
                    author: o_author.clone().unwrap_or_else(|| clean_author.clone()),
                    auto_title: clean_title,
                    auto_author: clean_author,
                    original_title: lib_title,
                    original_author: lib_author,
                    edited: o_title.is_some()
                        || o_author.is_some()
                        || o_cover.is_some()
                        || o_spine.is_some()
                        || spine_edited,
                    typographic_cover: o_cover.as_deref() == Some(TYPOGRAPHIC_COVER),
                    content_type: r.get::<_, Option<String>>(4)?.unwrap_or_default(),
                    purchase_date: r.get::<_, Option<String>>(5)?.unwrap_or_default(),
                    percent: r.get(6)?,
                    furthest_pos: r.get(7)?,
                    description: r.get(10)?,
                    subjects: subjects
                        .map(|s| {
                            s.split('\n')
                                // Drop tool-generated tags such as "Lang:vi".
                                .filter(|x| !x.is_empty() && !x.to_ascii_lowercase().starts_with("lang:"))
                                .map(String::from)
                                .collect()
                        })
                        .unwrap_or_default(),
                    language: r.get(12)?,
                    publisher: r.get(13)?,
                    auto_cover: meta_cover.clone(),
                    cover: match o_cover {
                        // The user chose the drawn (typographic) cover.
                        Some(c) if c == TYPOGRAPHIC_COVER => None,
                        Some(c) => Some(c),
                        None => meta_cover,
                    },
                    auto_spine_color: meta_spine
                        .clone()
                        .unwrap_or_else(|| meta::fallback_spine(&asin)),
                    spine_color: o_spine
                        .or(meta_spine)
                        .unwrap_or_else(|| meta::fallback_spine(&asin)),
                    text_length: r.get(24)?,
                    spine_style,
                    spine_font,
                    spine_width,
                    shelf_pos: r.get(28)?,
                    meta_ready: r.get(16)?,
                    status: {
                        let manual: i64 = r.get(22)?;
                        let stored: Option<String> = r.get(21)?;
                        match stored.filter(|_| manual != 0) {
                            Some(s) if is_status(&s) => s,
                            _ => auto_status(r.get(6)?).to_string(),
                        }
                    },
                    status_manual: {
                        let manual: i64 = r.get(22)?;
                        manual != 0 && r.get::<_, Option<String>>(21)?.is_some_and(|s| is_status(&s))
                    },
                    last_read: r.get(23)?,
                    source: r.get(29)?,
                    file_missing: false,
                    linked_asin: None,
                    kindle_match: None,
                    asin,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// Books that still need metadata extraction: (asin, cde_type).
    pub fn books_missing_meta(&self) -> rusqlite::Result<Vec<(String, String)>> {
        let conn = self.0.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT b.asin, COALESCE(b.type, '') FROM book b
             LEFT JOIN book_meta m ON m.asin = b.asin
             WHERE m.asin IS NULL AND COALESCE(b.source, 'amazon') = 'amazon'
             ORDER BY b.updated_at DESC",
        )?;
        let rows = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// Has metadata extraction from the book file itself already run?
    pub fn has_file_meta(&self, asin: &str) -> bool {
        let conn = self.0.lock().unwrap();
        conn.query_row(
            "SELECT 1 FROM book_meta WHERE asin = ?1 AND source = 'file'",
            [asin],
            |_| Ok(()),
        )
        .is_ok()
    }

    /// Store metadata extracted from the book file (or the Amazon cover).
    pub fn upsert_meta(&self, m: &StoredMeta) -> rusqlite::Result<()> {
        let conn = self.0.lock().unwrap();
        conn.execute(
            "INSERT INTO book_meta (asin, title, author, publisher, description, subjects, language,
                                    cover_file, spine_color, source, text_length, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, datetime('now'))
             ON CONFLICT(asin) DO UPDATE SET
               title=excluded.title, author=excluded.author, publisher=excluded.publisher,
               description=excluded.description, subjects=excluded.subjects,
               language=excluded.language, cover_file=excluded.cover_file,
               spine_color=excluded.spine_color, source=excluded.source,
               text_length=excluded.text_length, updated_at=datetime('now')",
            rusqlite::params![
                m.asin,
                m.title,
                m.author,
                m.publisher,
                m.description,
                m.subjects.join("\n"),
                m.language,
                m.cover_file,
                m.spine_color,
                m.source,
                m.text_length
            ],
        )?;
        Ok(())
    }

    /// File-backed books whose text length (spine thickness) is unknown.
    pub fn books_missing_length(&self) -> rusqlite::Result<Vec<String>> {
        let conn = self.0.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT asin FROM book_meta WHERE source = 'file' AND text_length IS NULL",
        )?;
        let rows = stmt
            .query_map([], |r| r.get(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// A book's text length in Kindle positions, if known (> 0).
    pub fn text_length(&self, asin: &str) -> Option<i64> {
        let conn = self.0.lock().unwrap();
        conn.query_row("SELECT text_length FROM book_meta WHERE asin = ?1", [asin], |r| {
            r.get::<_, Option<i64>>(0)
        })
        .ok()
        .flatten()
        .filter(|n| *n > 0)
    }

    /// Record a book's text length (0 = unknown, so it is not retried).
    pub fn set_text_length(&self, asin: &str, len: i64) -> rusqlite::Result<()> {
        let conn = self.0.lock().unwrap();
        conn.execute(
            "UPDATE book_meta SET text_length = ?2 WHERE asin = ?1",
            rusqlite::params![asin, len],
        )?;
        Ok(())
    }

    /// Store the hand-arranged order of one shelf: `asins[i]` gets position i.
    pub fn set_shelf_order(&self, asins: &[String]) -> rusqlite::Result<()> {
        let mut conn = self.0.lock().unwrap();
        let tx = conn.transaction()?;
        for (i, asin) in asins.iter().enumerate() {
            tx.execute(
                "INSERT INTO shelf_order (asin, pos) VALUES (?1, ?2)
                 ON CONFLICT(asin) DO UPDATE SET pos = excluded.pos",
                rusqlite::params![asin, i as f64],
            )?;
        }
        tx.commit()
    }

    /// Apply a partial update to a book's display overrides.
    pub fn set_override(&self, asin: &str, patch: &OverridePatch) -> rusqlite::Result<()> {
        let conn = self.0.lock().unwrap();
        conn.execute(
            "INSERT INTO book_override (asin, updated_at) VALUES (?1, datetime('now'))
             ON CONFLICT(asin) DO NOTHING",
            [asin],
        )?;
        use rusqlite::types::Value;
        let text = |v: &Option<Option<String>>| v.as_ref().map(|o| o.clone().map_or(Value::Null, Value::Text));
        let int = |v: &Option<Option<i64>>| v.as_ref().map(|o| o.map_or(Value::Null, Value::Integer));
        for (col, v) in [
            ("title", text(&patch.title)),
            ("author", text(&patch.author)),
            ("cover_file", text(&patch.cover_file)),
            ("spine_color", text(&patch.spine_color)),
            ("spine_style", text(&patch.spine_style)),
            ("spine_font", text(&patch.spine_font)),
            ("spine_width", int(&patch.spine_width)),
        ] {
            if let Some(v) = v {
                conn.execute(
                    &format!("UPDATE book_override SET {col} = ?2, updated_at = datetime('now') WHERE asin = ?1"),
                    rusqlite::params![asin, v],
                )?;
            }
        }
        // Drop the row once nothing is overridden any more.
        conn.execute(
            "DELETE FROM book_override WHERE asin = ?1 AND title IS NULL AND author IS NULL
               AND cover_file IS NULL AND spine_color IS NULL AND spine_style IS NULL
               AND spine_font IS NULL AND spine_width IS NULL",
            [asin],
        )?;
        Ok(())
    }

    /// The custom cover file of a book's override, if any.
    pub fn override_cover(&self, asin: &str) -> Option<String> {
        let conn = self.0.lock().unwrap();
        conn.query_row(
            "SELECT cover_file FROM book_override WHERE asin = ?1",
            [asin],
            |r| r.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten()
    }

    /// Set the reading status by hand (`Some`), or go back to the automatic,
    /// progress-derived status (`None`).
    pub fn set_status(&self, asin: &str, status: Option<&str>) -> rusqlite::Result<()> {
        let conn = self.0.lock().unwrap();
        conn.execute(
            "INSERT INTO reading_state (asin, status, status_manual, updated_at)
             VALUES (?1, ?2, ?3, datetime('now'))
             ON CONFLICT(asin) DO UPDATE SET
               status=excluded.status, status_manual=excluded.status_manual",
            rusqlite::params![asin, status, status.is_some() as i64],
        )?;
        Ok(())
    }

    /// Drop every user override for a book.
    pub fn clear_override(&self, asin: &str) -> rusqlite::Result<()> {
        let conn = self.0.lock().unwrap();
        conn.execute("DELETE FROM book_override WHERE asin = ?1", [asin])?;
        Ok(())
    }
}

/// Metadata row as stored in `book_meta`.
#[derive(Debug, Default, Clone)]
pub struct StoredMeta {
    pub asin: String,
    pub title: Option<String>,
    pub author: Option<String>,
    pub publisher: Option<String>,
    pub description: Option<String>,
    pub subjects: Vec<String>,
    pub language: Option<String>,
    pub cover_file: Option<String>,
    pub spine_color: Option<String>,
    /// "file" (read from the book), "amazon" (cover CDN), or "none".
    pub source: String,
    /// PalmDOC text length of the book file (drives spine thickness).
    pub text_length: Option<i64>,
}

/// Partial update of a book's overrides: `Some(None)` clears a field,
/// `Some(Some(v))` sets it, `None` leaves it untouched.
#[derive(Debug, Default)]
pub struct OverridePatch {
    pub title: Option<Option<String>>,
    pub author: Option<Option<String>>,
    pub cover_file: Option<Option<String>>,
    pub spine_color: Option<Option<String>>,
    pub spine_style: Option<Option<String>>,
    pub spine_font: Option<Option<String>>,
    pub spine_width: Option<Option<i64>>,
}

/// `book_override.cover_file` value meaning "draw a typographic cover".
pub const TYPOGRAPHIC_COVER: &str = "-";
pub const SPINE_STYLES: [&str; 4] = ["plain", "cloth", "leather", "foil"];
pub const SPINE_FONTS: [&str; 3] = ["serif", "sans", "caps"];

/// Add columns introduced after a database was first created.
fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    let has = |table: &str, col: &str| -> rusqlite::Result<bool> {
        let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
        let cols = stmt
            .query_map([], |r| r.get::<_, String>(1))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(cols.iter().any(|c| c == col))
    };
    for (table, col, ty) in [
        ("reading_state", "status", "TEXT"),
        ("reading_state", "status_manual", "INTEGER"),
        ("book_meta", "text_length", "INTEGER"),
        ("book_override", "spine_style", "TEXT"),
        ("book_override", "spine_font", "TEXT"),
        ("book_override", "spine_width", "INTEGER"),
        ("book", "source", "TEXT"),
    ] {
        if !has(table, col)? {
            conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {col} {ty}"))?;
        }
    }
    Ok(())
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ReaderPosition {
    pub cfi: String,
    pub fraction: f64,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct LibraryRow {
    pub asin: String,
    pub cde_type: String,
    /// Display title/author: user override, else the cleaned-up value.
    pub title: String,
    pub author: String,
    /// What the app would show without user edits (for "reset").
    pub auto_title: String,
    pub auto_author: String,
    /// Raw values from the Amazon library.
    pub original_title: String,
    pub original_author: String,
    /// The user has edited title, author, cover or spine.
    pub edited: bool,
    /// The user chose the drawn (typographic) cover over the image.
    pub typographic_cover: bool,
    /// Cover from the book file / Amazon, ignoring the user's choice.
    pub auto_cover: Option<String>,
    pub content_type: String,
    pub purchase_date: String,
    pub percent: Option<f64>,
    pub furthest_pos: Option<i64>,
    pub description: Option<String>,
    pub subjects: Vec<String>,
    pub language: Option<String>,
    pub publisher: Option<String>,
    /// Cover file name under `<app_data>/covers`, served by the `cover` protocol.
    pub cover: Option<String>,
    /// Spine colour (#rrggbb) for the shelf view.
    pub spine_color: String,
    /// Spine colour without the user's choice (taken from the cover).
    pub auto_spine_color: String,
    /// Text length of the book file, if known (spine thickness).
    pub text_length: Option<i64>,
    /// User spine customisation: style, font, thickness (px).
    pub spine_style: Option<String>,
    pub spine_font: Option<String>,
    pub spine_width: Option<i64>,
    /// Hand-arranged position on its shelf.
    pub shelf_pos: Option<f64>,
    /// Metadata extraction has run for this book.
    pub meta_ready: bool,
    /// Reading status: "unread" | "reading" | "finished" | "abandoned".
    pub status: String,
    /// The status was set by the user (else derived from progress).
    pub status_manual: bool,
    /// When the book was last read in the app (UTC, SQLite datetime).
    pub last_read: Option<String>,
    /// "amazon" (synced from the Kindle library) or "local" (added from
    /// this computer).
    pub source: String,
    /// A local book whose copy in the app's data folder is gone.
    pub file_missing: bool,
    /// Local books: the Kindle book the user linked it to.
    pub linked_asin: Option<String>,
    /// Local books: a Kindle book that looks like the same title (suggested,
    /// not linked yet).
    pub kindle_match: Option<String>,
}

/// A book added from this computer, as it is first stored.
pub struct NewLocalBook {
    pub id: String,
    pub title: String,
    pub author: String,
    pub content_type: String,
    pub format: String,
    pub size: i64,
    pub sha256: String,
    pub original_path: String,
    pub original_name: String,
    pub isbn: Option<String>,
    /// UTC, RFC 3339.
    pub added_at: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct LocalFile {
    pub format: String,
    pub original_path: Option<String>,
    pub original_name: Option<String>,
    pub isbn: Option<String>,
}

/// Delete a book's own rows (not its highlights, bookmarks or stats).
fn delete_book_rows(tx: &rusqlite::Transaction, asin: &str) -> rusqlite::Result<()> {
    for table in ["book", "book_meta", "reading_state", "reader_position", "book_override", "shelf_order"] {
        tx.execute(&format!("DELETE FROM {table} WHERE asin = ?1"), [asin])?;
    }
    tx.execute("DELETE FROM book_link WHERE local_id = ?1 OR asin = ?1", [asin])?;
    Ok(())
}

pub const STATUSES: [&str; 4] = ["unread", "reading", "finished", "abandoned"];

pub fn is_status(s: &str) -> bool {
    STATUSES.contains(&s)
}

/// Status implied by reading progress (percent 0..100).
pub fn auto_status(percent: Option<f64>) -> &'static str {
    match percent {
        Some(p) if p >= 97.5 => "finished",
        Some(p) if p > 0.5 => "reading",
        _ => "unread",
    }
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS account (
    directed_id   TEXT PRIMARY KEY,
    name          TEXT,
    marketplace   TEXT,
    device_serial TEXT,
    device_type   TEXT,
    device_name   TEXT,
    created_at    TEXT
);
CREATE TABLE IF NOT EXISTS book (
    asin         TEXT PRIMARY KEY,
    type         TEXT,
    title        TEXT,
    author       TEXT,
    content_type TEXT,
    purchase_date TEXT,
    cover_path   TEXT,
    length       INTEGER,
    updated_at   TEXT
);
CREATE TABLE IF NOT EXISTS reading_state (
    asin         TEXT PRIMARY KEY,
    percent      REAL,
    furthest_pos INTEGER,
    status       TEXT,
    status_manual INTEGER,
    updated_at   TEXT
);
CREATE TABLE IF NOT EXISTS book_meta (
    asin         TEXT PRIMARY KEY,
    title        TEXT,
    author       TEXT,
    publisher    TEXT,
    description  TEXT,
    subjects     TEXT,
    language     TEXT,
    cover_file   TEXT,
    spine_color  TEXT,
    source       TEXT,
    text_length  INTEGER,
    updated_at   TEXT
);
CREATE TABLE IF NOT EXISTS book_override (
    asin         TEXT PRIMARY KEY,
    title        TEXT,
    author       TEXT,
    cover_file   TEXT,
    spine_color  TEXT,
    spine_style  TEXT,
    spine_font   TEXT,
    spine_width  INTEGER,
    updated_at   TEXT
);
CREATE TABLE IF NOT EXISTS shelf_order (
    asin TEXT PRIMARY KEY,
    pos  REAL
);
CREATE TABLE IF NOT EXISTS local_file (
    asin          TEXT PRIMARY KEY,
    format        TEXT,
    size          INTEGER,
    sha256        TEXT,
    original_path TEXT,
    original_name TEXT,
    isbn          TEXT,
    added_at      TEXT
);
CREATE TABLE IF NOT EXISTS book_link (
    local_id TEXT NOT NULL,
    asin     TEXT NOT NULL,
    state    TEXT NOT NULL,
    at       TEXT,
    PRIMARY KEY (local_id, asin)
);
CREATE TABLE IF NOT EXISTS reader_position (
    asin       TEXT PRIMARY KEY,
    cfi        TEXT,
    fraction   REAL,
    updated_at TEXT
);
"#;

#[cfg(test)]
mod tests {
    /// Dump the real library as the UI sees it:
    /// `PINKNBOOK_DB=<sqlite> PINKNBOOK_OUT=<json> cargo test -- --ignored dump_library`
    #[test]
    #[ignore]
    fn dump_library() {
        let db = super::Db::open(std::path::Path::new(&std::env::var("PINKNBOOK_DB").unwrap())).unwrap();
        let rows = db.list_library().unwrap();
        std::fs::write(std::env::var("PINKNBOOK_OUT").unwrap(), serde_json::to_string_pretty(&rows).unwrap()).unwrap();
    }

    #[test]
    fn prune_drops_books_gone_from_amazon() {
        let path = std::env::temp_dir().join(format!("pnb-prune-{}.sqlite", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let db = super::Db::open(&path).unwrap();
        let book = |asin: &str| crate::adp::client::Book {
            asin: asin.into(),
            title: asin.into(),
            author: String::new(),
            cde_type: "PDOC".into(),
            content_type: String::new(),
            purchase_date: String::new(),
        };
        db.upsert_books(&[book("A"), book("B"), book("C")]).unwrap();
        db.0.lock().unwrap().execute("INSERT INTO shelf_order (asin, pos) VALUES ('B', 1)", []).unwrap();
        let gone = db.prune_books(&["A".into(), "C".into()]).unwrap();
        assert_eq!(gone, vec!["B".to_string()]);
        let left: Vec<String> = db.list_library().unwrap().into_iter().map(|r| r.asin).collect();
        assert_eq!(left.len(), 2);
        assert!(!left.contains(&"B".to_string()));
        let shelf: i64 = db.0.lock().unwrap().query_row("SELECT COUNT(*) FROM shelf_order", [], |r| r.get(0)).unwrap();
        assert_eq!(shelf, 0);
        drop(db);
        let _ = std::fs::remove_file(&path);
    }

    /// A Kindle sync (even an empty "sign out and forget Kindle") never
    /// takes away books added from this computer.
    #[test]
    fn prune_keeps_local_books() {
        let path = std::env::temp_dir().join(format!("pnb-local-{}.sqlite", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let db = super::Db::open(&path).unwrap();
        db.upsert_books(&[crate::adp::client::Book { asin: "B0KINDLE01".into(), title: "K".into(), ..Default::default() }])
            .unwrap();
        db.insert_local_book(&super::NewLocalBook {
            id: "L_0123456789abcdef01234567".into(),
            title: "Local".into(),
            author: "Me".into(),
            content_type: "application/epub+zip".into(),
            format: "epub".into(),
            size: 1,
            sha256: "x".into(),
            original_path: "C:/b.epub".into(),
            original_name: "b.epub".into(),
            isbn: Some("9780306406157".into()),
            added_at: "2026-11-20T00:00:00Z".into(),
        })
        .unwrap();
        assert_eq!(db.prune_books(&[]).unwrap(), vec!["B0KINDLE01".to_string()]);
        let rows = db.list_library().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].source, "local");
        assert_eq!(db.local_file(&rows[0].asin).and_then(|f| f.isbn).as_deref(), Some("9780306406157"));
        db.remove_book(&rows[0].asin).unwrap();
        assert!(db.list_library().unwrap().is_empty());
        assert!(db.local_file("L_0123456789abcdef01234567").is_none());
        drop(db);
        let _ = std::fs::remove_file(&path);
    }
}
