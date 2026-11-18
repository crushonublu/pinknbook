//! The word list ("Sổ từ"): words looked up in the dictionary and saved,
//! each with the sentence it came from and where in which book.

use tauri::State;

use crate::db::Db;

#[derive(Debug, Clone, serde::Serialize)]
pub struct VocabItem {
    pub id: i64,
    pub word: String,
    /// "vi" or "en".
    pub lang: String,
    /// A short meaning, as shown when it was saved.
    pub gloss: Option<String>,
    pub asin: Option<String>,
    pub cfi: Option<String>,
    pub fraction: Option<f64>,
    /// The sentence around the word in the book.
    pub context: Option<String>,
    pub learned: bool,
    /// UTC "YYYY-MM-DD HH:MM:SS".
    pub created_at: String,
}

pub const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS vocab (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    word       TEXT NOT NULL,
    key        TEXT NOT NULL,
    lang       TEXT NOT NULL,
    gloss      TEXT,
    asin       TEXT,
    cfi        TEXT,
    fraction   REAL,
    context    TEXT,
    learned    INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS vocab_key ON vocab(key, IFNULL(asin, ''));
";

const COLS: &str = "id, word, lang, gloss, asin, cfi, fraction, context, learned, created_at";

fn row(r: &rusqlite::Row) -> rusqlite::Result<VocabItem> {
    Ok(VocabItem {
        id: r.get(0)?,
        word: r.get(1)?,
        lang: r.get(2)?,
        gloss: r.get(3)?,
        asin: r.get(4)?,
        cfi: r.get(5)?,
        fraction: r.get(6)?,
        context: r.get(7)?,
        learned: r.get::<_, i64>(8)? != 0,
        created_at: r.get(9)?,
    })
}

/// Saved words, newest first; only one book's when `asin` is given.
#[tauri::command]
pub fn vocab_list(db: State<Db>, asin: Option<String>) -> Result<Vec<VocabItem>, String> {
    let conn = db.0.lock().unwrap();
    let sql = format!(
        "SELECT {COLS} FROM vocab WHERE (?1 IS NULL OR asin = ?1) ORDER BY created_at DESC, id DESC"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([&asin], row)
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// Save a word (saving it again from the same book updates it).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn vocab_add(
    db: State<Db>,
    word: String,
    lang: String,
    gloss: Option<String>,
    asin: Option<String>,
    cfi: Option<String>,
    fraction: Option<f64>,
    context: Option<String>,
) -> Result<VocabItem, String> {
    let word = word.split_whitespace().collect::<Vec<_>>().join(" ");
    if word.is_empty() || word.chars().count() > 80 {
        return Err("bad word".into());
    }
    let clip = |s: Option<String>, n: usize| {
        s.map(|v| v.split_whitespace().collect::<Vec<_>>().join(" "))
            .filter(|v| !v.is_empty())
            .map(|v| if v.chars().count() > n { v.chars().take(n).collect::<String>() + "…" } else { v })
    };
    let key = crate::dict::key_of(&word);
    let conn = db.0.lock().unwrap();
    conn.execute(
        "INSERT INTO vocab (word, key, lang, gloss, asin, cfi, fraction, context)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(key, IFNULL(asin, '')) DO UPDATE SET
           word = excluded.word, lang = excluded.lang, gloss = excluded.gloss, cfi = excluded.cfi,
           fraction = excluded.fraction, context = excluded.context",
        rusqlite::params![word, key, lang, clip(gloss, 300), asin, cfi, fraction, clip(context, 400)],
    )
    .map_err(|e| e.to_string())?;
    conn.query_row(
        &format!("SELECT {COLS} FROM vocab WHERE key = ?1 AND IFNULL(asin, '') = IFNULL(?2, '')"),
        rusqlite::params![key, asin],
        row,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn vocab_set_learned(db: State<Db>, id: i64, learned: bool) -> Result<(), String> {
    let conn = db.0.lock().unwrap();
    conn.execute("UPDATE vocab SET learned = ?2 WHERE id = ?1", rusqlite::params![id, learned as i64])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn vocab_remove(db: State<Db>, id: i64) -> Result<(), String> {
    let conn = db.0.lock().unwrap();
    conn.execute("DELETE FROM vocab WHERE id = ?1", [id]).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn saving_twice_updates() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(super::SCHEMA).unwrap();
        let ins = "INSERT INTO vocab (word, key, lang, gloss, asin) VALUES (?1, ?2, 'vi', ?3, 'A')
                   ON CONFLICT(key, IFNULL(asin, '')) DO UPDATE SET gloss = excluded.gloss";
        conn.execute(ins, rusqlite::params!["Đốc lý", "đốc lý", "one"]).unwrap();
        conn.execute(ins, rusqlite::params!["đốc lý", "đốc lý", "two"]).unwrap();
        let (n, g): (i64, String) =
            conn.query_row("SELECT COUNT(*), MAX(gloss) FROM vocab", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!((n, g.as_str()), (1, "two"));
    }
}
