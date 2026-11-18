//! Offline dictionary: Vietnamese Wiktionary (Vietnamese and English words
//! explained in Vietnamese, extracted by kaikki.org / wiktextract, CC BY-SA)
//! and Open English WordNet (English definitions, CC BY 4.0).
//!
//! Nothing is bundled: the first time, `dict_install` downloads both sources,
//! keeps only what a lookup needs in `dict/dict.sqlite`, and deletes the
//! downloads. Lookups then work offline.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use futures_util::StreamExt;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

const WIKT_URL: &str = "https://kaikki.org/viwiktionary/raw-wiktextract-data.jsonl.gz";
const WORDNET_URL: &str = "https://en-word.net/downloads/english-wordnet-2025-json.zip";
const VERSION: &str = "1";
/// Senses and examples kept per entry (the popup is small).
const MAX_SENSES: usize = 12;
const MAX_EXAMPLES: usize = 2;

static INSTALLING: AtomicBool = AtomicBool::new(false);
static CONN: Mutex<Option<Connection>> = Mutex::new(None);

fn dict_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("dict"))
}

fn is_ready(path: &Path) -> bool {
    let Ok(conn) = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY) else {
        return false;
    };
    conn.query_row("SELECT v FROM meta WHERE k = 'version'", [], |r| r.get::<_, String>(0))
        .map(|v| v == VERSION)
        .unwrap_or(false)
}

#[derive(Serialize)]
pub struct DictStatus {
    pub ready: bool,
    pub installing: bool,
}

#[tauri::command]
pub fn dict_status(app: AppHandle) -> Result<DictStatus, String> {
    let path = dict_dir(&app)?.join("dict.sqlite");
    Ok(DictStatus { ready: is_ready(&path), installing: INSTALLING.load(Ordering::SeqCst) })
}

fn progress(app: &AppHandle, phase: &str, file: &str, done: u64, total: u64) {
    let _ = app.emit("dict-progress", json!({ "phase": phase, "file": file, "done": done, "total": total }));
}

async fn download(app: &AppHandle, url: &str, to: &Path, label: &str) -> Result<(), String> {
    let resp = reqwest::Client::new()
        .get(url)
        .header("User-Agent", "pntome-reader")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("{label}: HTTP {}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(0);
    let mut file = std::fs::File::create(to).map_err(|e| e.to_string())?;
    let mut stream = resp.bytes_stream();
    let mut done = 0u64;
    let mut last = 0u64;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        done += chunk.len() as u64;
        if done - last > 256 * 1024 || done == total {
            last = done;
            progress(app, "download", label, done, total);
        }
    }
    file.flush().map_err(|e| e.to_string())?;
    Ok(())
}

/// Download both sources and build the dictionary. Emits `dict-progress`
/// {phase: download|build|done|error, file, done, total, message?}.
#[tauri::command]
pub async fn dict_install(app: AppHandle) -> Result<(), String> {
    if INSTALLING.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    let result = install(&app).await;
    INSTALLING.store(false, Ordering::SeqCst);
    match &result {
        Ok(()) => {
            let _ = app.emit("dict-progress", json!({ "phase": "done" }));
        }
        Err(e) => {
            let _ = app.emit("dict-progress", json!({ "phase": "error", "message": e }));
        }
    }
    result
}

async fn install(app: &AppHandle) -> Result<(), String> {
    let dir = dict_dir(app)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let wikt = dir.join("wiktionary.jsonl.gz.part");
    let wn = dir.join("wordnet.zip.part");
    download(app, WIKT_URL, &wikt, "Wiktionary").await?;
    download(app, WORDNET_URL, &wn, "WordNet").await?;

    let out = dir.join("dict.sqlite");
    let tmp = dir.join("dict.sqlite.part");
    let app2 = app.clone();
    let (w, n, t) = (wikt.clone(), wn.clone(), tmp.clone());
    tauri::async_runtime::spawn_blocking(move || build(&w, &n, &t, |done, total| progress(&app2, "build", "", done, total)))
        .await
        .map_err(|e| e.to_string())??;

    // Swap in the new file (drop any open handle to the old one first).
    *CONN.lock().unwrap() = None;
    let _ = std::fs::remove_file(&out);
    std::fs::rename(&tmp, &out).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&wikt);
    let _ = std::fs::remove_file(&wn);
    Ok(())
}

/// Counts bytes read, for build progress over the compressed file.
struct Counting<R> {
    inner: R,
    count: std::sync::Arc<std::sync::atomic::AtomicU64>,
}
impl<R: Read> Read for Counting<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.count.fetch_add(n as u64, Ordering::Relaxed);
        Ok(n)
    }
}

const SCHEMA: &str = "
CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE entry (dict TEXT NOT NULL, key TEXT NOT NULL, word TEXT NOT NULL, body TEXT NOT NULL);
";

/// Lookup key: lower case, composed (NFC) form.
pub fn key_of(s: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    s.trim().nfc().collect::<String>().to_lowercase()
}

pub fn build(wikt: &Path, wordnet: &Path, out: &Path, report: impl Fn(u64, u64)) -> Result<(), String> {
    let _ = std::fs::remove_file(out);
    let mut conn = Connection::open(out).map_err(|e| e.to_string())?;
    conn.execute_batch("PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;").map_err(|e| e.to_string())?;
    conn.execute_batch(SCHEMA).map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    {
        let mut ins = tx
            .prepare("INSERT INTO entry (dict, key, word, body) VALUES (?1, ?2, ?3, ?4)")
            .map_err(|e| e.to_string())?;

        // Wiktionary: one JSON object per line; keep Vietnamese and English words.
        let size = std::fs::metadata(wikt).map(|m| m.len()).unwrap_or(1).max(1);
        let count = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
        let file = std::fs::File::open(wikt).map_err(|e| e.to_string())?;
        let gz = flate2::read::MultiGzDecoder::new(Counting { inner: file, count: count.clone() });
        let mut reader = BufReader::with_capacity(1 << 20, gz);
        let mut line = String::new();
        let mut n = 0u64;
        loop {
            line.clear();
            if reader.read_line(&mut line).map_err(|e| e.to_string())? == 0 {
                break;
            }
            n += 1;
            if n % 5000 == 0 {
                // Wiktionary is most of the work: count it as 85 %.
                report(count.load(Ordering::Relaxed) * 85 / size, 100);
            }
            // Cheap filter first; the field itself decides (translations
            // inside an entry carry language codes too).
            if !line.contains("\"lang_code\": \"vi\"") && !line.contains("\"lang_code\": \"en\"") {
                continue;
            }
            let Ok(o) = serde_json::from_str::<Value>(&line) else { continue };
            let dict = match o.get("lang_code").and_then(Value::as_str) {
                Some("vi") => "vi",
                Some("en") => "envi",
                _ => continue,
            };
            let Some(word) = o.get("word").and_then(Value::as_str) else { continue };
            let Some(body) = wikt_body(&o) else { continue };
            ins.execute(params![dict, key_of(word), word, body.to_string()]).map_err(|e| e.to_string())?;
        }

        // WordNet: synsets (definitions) by id, then each word's senses.
        let file = std::fs::File::open(wordnet).map_err(|e| e.to_string())?;
        let mut zip = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
        let names: Vec<String> = zip.file_names().map(String::from).collect();
        let mut synsets: HashMap<String, Value> = HashMap::new();
        for name in names.iter().filter(|n| n.ends_with(".json") && !n.starts_with("entries-")) {
            let mut s = String::new();
            zip.by_name(name).map_err(|e| e.to_string())?.read_to_string(&mut s).map_err(|e| e.to_string())?;
            if let Ok(Value::Object(m)) = serde_json::from_str::<Value>(&s) {
                synsets.extend(m);
            }
        }
        report(90, 100);
        for name in names.iter().filter(|n| n.starts_with("entries-")) {
            let mut s = String::new();
            zip.by_name(name).map_err(|e| e.to_string())?.read_to_string(&mut s).map_err(|e| e.to_string())?;
            let Ok(Value::Object(m)) = serde_json::from_str::<Value>(&s) else { continue };
            for (lemma, by_pos) in m {
                let Value::Object(by_pos) = by_pos else { continue };
                for (pos, e) in by_pos {
                    let body = wordnet_body(&lemma, &pos, &e, &synsets);
                    if let Some(b) = body {
                        ins.execute(params!["enen", key_of(&lemma), lemma, b.to_string()]).map_err(|e| e.to_string())?;
                    }
                    // Irregular forms ("ran") point at their word.
                    for f in e.get("form").and_then(Value::as_array).into_iter().flatten() {
                        if let Some(f) = f.as_str() {
                            let see = json!({ "see": lemma });
                            ins.execute(params!["enen", key_of(f), f, see.to_string()]).map_err(|e| e.to_string())?;
                        }
                    }
                }
            }
        }
        report(97, 100);
    }
    tx.execute("INSERT INTO meta (k, v) VALUES ('version', ?1)", [VERSION]).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    conn.execute_batch("CREATE INDEX entry_key ON entry (key, dict); VACUUM;").map_err(|e| e.to_string())?;
    report(100, 100);
    Ok(())
}

/// What a popup needs from a Wiktionary entry.
fn wikt_body(o: &Value) -> Option<Value> {
    let senses: Vec<Value> = o
        .get("senses")?
        .as_array()?
        .iter()
        .filter_map(|s| {
            let g: Vec<&str> = s.get("glosses")?.as_array()?.iter().filter_map(Value::as_str).collect();
            if g.is_empty() {
                return None;
            }
            let ex: Vec<Value> = s
                .get("examples")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(|x| {
                            let t = x.get("text")?.as_str()?;
                            Some(match x.get("translation").and_then(Value::as_str) {
                                Some(tr) => json!([t, tr]),
                                None => json!([t]),
                            })
                        })
                        .take(MAX_EXAMPLES)
                        .collect()
                })
                .unwrap_or_default();
            let mut v = json!({ "g": g });
            if !ex.is_empty() {
                v["ex"] = Value::Array(ex);
            }
            Some(v)
        })
        .take(MAX_SENSES)
        .collect();
    if senses.is_empty() {
        return None;
    }
    let mut body = json!({ "senses": senses });
    if let Some(p) = o.get("pos_title").and_then(Value::as_str) {
        body["pos"] = json!(p);
    }
    // Northern pronunciation first when there are several.
    if let Some(sounds) = o.get("sounds").and_then(Value::as_array) {
        let ipa = sounds
            .iter()
            .find(|s| s.get("tags").and_then(Value::as_array).is_some_and(|t| t.iter().any(|x| x == "Hà-Nội")))
            .or_else(|| sounds.iter().find(|s| s.get("ipa").is_some()))
            .and_then(|s| s.get("ipa"))
            .and_then(Value::as_str);
        if let Some(ipa) = ipa {
            body["ipa"] = json!(ipa);
        }
    }
    Some(body)
}

fn wordnet_body(lemma: &str, pos: &str, e: &Value, synsets: &HashMap<String, Value>) -> Option<Value> {
    let senses: Vec<Value> = e
        .get("sense")?
        .as_array()?
        .iter()
        .filter_map(|s| {
            let syn = synsets.get(s.get("synset")?.as_str()?)?;
            let g: Vec<&str> = syn.get("definition")?.as_array()?.iter().filter_map(Value::as_str).collect();
            if g.is_empty() {
                return None;
            }
            let mut v = json!({ "g": g });
            let ex: Vec<Value> = syn
                .get("example")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_str().or_else(|| x.get("text").and_then(Value::as_str)))
                        .take(MAX_EXAMPLES)
                        .map(|t| json!([t]))
                        .collect()
                })
                .unwrap_or_default();
            if !ex.is_empty() {
                v["ex"] = Value::Array(ex);
            }
            let syn_words: Vec<&str> = syn
                .get("members")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Value::as_str).filter(|m| !m.eq_ignore_ascii_case(lemma)).take(5).collect())
                .unwrap_or_default();
            if !syn_words.is_empty() {
                v["syn"] = json!(syn_words);
            }
            Some(v)
        })
        .take(MAX_SENSES)
        .collect();
    if senses.is_empty() {
        return None;
    }
    let pos_name = match pos {
        "n" => "noun",
        "v" => "verb",
        "a" | "s" => "adjective",
        "r" => "adverb",
        other => other,
    };
    let mut body = json!({ "pos": pos_name, "senses": senses });
    if let Some(p) = e
        .get("pronunciation")
        .and_then(Value::as_array)
        .and_then(|a| a.first())
        .and_then(|p| p.get("value"))
        .and_then(Value::as_str)
    {
        body["ipa"] = json!(p);
    }
    Some(body)
}

// ---- Lookup -----------------------------------------------------------------

#[derive(Serialize, Clone)]
pub struct Entry {
    /// The headword as written in the dictionary (may be the base form).
    pub word: String,
    pub body: Value,
}

#[derive(Serialize, Default)]
pub struct Lookup {
    /// The word or phrase that was found (or the first candidate).
    pub word: String,
    pub vi: Vec<Entry>,
    pub envi: Vec<Entry>,
    pub enen: Vec<Entry>,
    /// The dictionary is not installed yet.
    pub missing: bool,
}

fn with_conn<T>(app: &AppHandle, f: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> Result<Option<T>, String> {
    let mut guard = CONN.lock().unwrap();
    if guard.is_none() {
        let path = dict_dir(app)?.join("dict.sqlite");
        if !is_ready(&path) {
            return Ok(None);
        }
        let conn = Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|e| e.to_string())?;
        *guard = Some(conn);
    }
    f(guard.as_ref().unwrap()).map(Some).map_err(|e| e.to_string())
}

fn entries(conn: &Connection, dict: &str, key: &str) -> rusqlite::Result<Vec<Entry>> {
    let mut stmt = conn.prepare_cached("SELECT word, body FROM entry WHERE key = ?1 AND dict = ?2 ORDER BY rowid")?;
    let rows = stmt
        .query_map(params![key, dict], |r| {
            let body: String = r.get(1)?;
            Ok(Entry { word: r.get(0)?, body: serde_json::from_str(&body).unwrap_or(Value::Null) })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    // Follow "see" (an irregular form) once.
    let mut out = Vec::new();
    for e in rows {
        if let Some(see) = e.body.get("see").and_then(Value::as_str) {
            let mut stmt = conn.prepare_cached("SELECT word, body FROM entry WHERE key = ?1 AND dict = ?2 ORDER BY rowid")?;
            let more = stmt
                .query_map(params![key_of(see), dict], |r| {
                    let body: String = r.get(1)?;
                    Ok(Entry { word: r.get(0)?, body: serde_json::from_str(&body).unwrap_or(Value::Null) })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            out.extend(more.into_iter().filter(|m| m.body.get("see").is_none()));
        } else {
            out.push(e);
        }
    }
    Ok(out)
}

fn exists(conn: &Connection, key: &str) -> rusqlite::Result<bool> {
    conn.prepare_cached("SELECT 1 FROM entry WHERE key = ?1 LIMIT 1")?
        .query_row([key], |_| Ok(()))
        .optional()
        .map(|o| o.is_some())
}

/// Base forms an English word may come from ("running" → "run").
pub fn english_bases(w: &str) -> Vec<String> {
    let w = w.trim_end_matches("'s").trim_end_matches("’s");
    let mut out = Vec::new();
    let mut push = |s: String| {
        if s.len() >= 2 && !out.contains(&s) {
            out.push(s);
        }
    };
    let strip = |suf: &str| w.strip_suffix(suf).map(str::to_string);
    if let Some(b) = strip("ies") {
        push(b + "y");
    }
    if let Some(b) = strip("ied") {
        push(b + "y");
    }
    if let Some(b) = strip("es") {
        push(b);
    }
    if let Some(b) = strip("s") {
        push(b);
    }
    for suf in ["ing", "ed", "er", "est"] {
        if let Some(b) = strip(suf) {
            push(b.clone());
            push(b.clone() + "e");
            // Doubled final consonant: "running" → "run".
            let c: Vec<char> = b.chars().collect();
            if c.len() >= 3 && c[c.len() - 1] == c[c.len() - 2] {
                push(c[..c.len() - 1].iter().collect());
            }
        }
    }
    if let Some(b) = strip("ly") {
        push(b);
    }
    out
}

/// Look a word up. `candidates` are phrases around the chosen word (longest
/// first, e.g. "tiểu thuyết" before "thuyết"); the first one any dictionary
/// has is used, else the last one.
#[tauri::command]
pub fn dict_lookup(app: AppHandle, candidates: Vec<String>) -> Result<Lookup, String> {
    let Some(last) = candidates.last().cloned() else {
        return Ok(Lookup::default());
    };
    let result = with_conn(&app, |conn| {
        let mut word = last.clone();
        for c in &candidates {
            if exists(conn, &key_of(c))? {
                word = c.clone();
                break;
            }
        }
        let key = key_of(&word);
        let mut out = Lookup { word: word.clone(), ..Default::default() };
        out.vi = entries(conn, "vi", &key)?;
        out.envi = entries(conn, "envi", &key)?;
        out.enen = entries(conn, "enen", &key)?;
        if !key.contains(' ') && key.is_ascii() {
            for b in english_bases(&key) {
                if out.envi.is_empty() {
                    out.envi = entries(conn, "envi", &b)?;
                }
                if out.enen.is_empty() {
                    out.enen = entries(conn, "enen", &b)?;
                }
            }
        }
        Ok(out)
    })?;
    Ok(result.unwrap_or(Lookup { word: last, missing: true, ..Default::default() }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn english_base_forms() {
        assert!(english_bases("running").contains(&"run".to_string()));
        assert!(english_bases("studies").contains(&"study".to_string()));
        assert!(english_bases("hoped").contains(&"hope".to_string()));
        assert!(english_bases("cats").contains(&"cat".to_string()));
    }

    #[test]
    fn keys_are_lower_nfc() {
        // "Ế" written as E + circumflex + acute.
        assert_eq!(key_of("TIE\u{0302}\u{0301}U"), "tiếu");
    }

    /// Build from real downloads:
    /// `PNB_WIKT=<gz> PNB_WN=<zip> PNB_OUT=<sqlite> cargo test -- --ignored build_real`
    #[test]
    #[ignore]
    fn build_real() {
        let out = PathBuf::from(std::env::var("PNB_OUT").unwrap());
        let t = std::time::Instant::now();
        build(
            Path::new(&std::env::var("PNB_WIKT").unwrap()),
            Path::new(&std::env::var("PNB_WN").unwrap()),
            &out,
            |_, _| {},
        )
        .unwrap();
        eprintln!("built in {:?}, {} bytes", t.elapsed(), std::fs::metadata(&out).unwrap().len());
        let conn = Connection::open(&out).unwrap();
        for (d, w) in [("vi", "tiểu thuyết"), ("vi", "đốc lý"), ("envi", "run"), ("enen", "run"), ("enen", "ran")] {
            let e = entries(&conn, d, &key_of(w)).unwrap();
            eprintln!("{d} {w}: {} entries; {}", e.len(), e.first().map(|x| x.body.to_string()).unwrap_or_default().chars().take(160).collect::<String>());
            assert!(!e.is_empty(), "{d} {w}");
        }
    }
}
