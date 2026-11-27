//! Books the user adds from their own computer: EPUB files without DRM.
//!
//! A file is copied into `<app_data>/books/<id>.epub`, so the book keeps
//! opening when the original is moved or deleted. Its id is `L_` + the first
//! 24 hex digits of the file's SHA-256: it can never clash with an ASIN (ten
//! upper-case letters/digits), the same file added twice is caught for free,
//! and a book removed then added again gets its highlights and stats back.
//! Everything else in the app (reader position, highlights, stats, X-Ray,
//! Goodreads) is keyed by that id exactly as it is by an ASIN.

use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::db::{Db, LibraryRow, NewLocalBook, StoredMeta};
use crate::{library_meta, meta, stk};

pub const PREFIX: &str = "L_";
/// Files above this size are still added, but flagged (usually image books).
pub const LARGE_BYTES: u64 = 100 * 1024 * 1024;

/// Set by `cancel_import`; the running import stops before its next file.
static CANCEL: AtomicBool = AtomicBool::new(false);
/// One import at a time (picker, drop, watched folders, restore).
pub(crate) static IMPORTING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Is this library key a book added from this computer?
pub fn is_local(id: &str) -> bool {
    id.starts_with(PREFIX)
}

/// The app's own copy of a local book.
pub fn book_path(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("books");
    let _ = std::fs::create_dir_all(&dir);
    Ok(dir.join(format!("{id}.epub")))
}

/// What an EPUB says about itself.
#[derive(Debug, Default)]
pub struct EpubMeta {
    pub title: Option<String>,
    pub author: Option<String>,
    pub publisher: Option<String>,
    pub description: Option<String>,
    pub subjects: Vec<String>,
    pub language: Option<String>,
    pub isbn: Option<String>,
    pub cover: Option<Vec<u8>>,
    /// Uncompressed size of the reading-order documents: the EPUB
    /// counterpart of the MOBI text length (spine thickness, "time left").
    pub text_length: i64,
}

/// Read an EPUB's metadata. Errors are problem codes the UI words:
/// `not_epub`, `drm`, `corrupt`.
pub fn read_epub(bytes: &[u8]) -> Result<EpubMeta, &'static str> {
    if !bytes.starts_with(b"PK\x03\x04") {
        return Err("not_epub");
    }
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes.to_vec())).map_err(|_| "corrupt")?;
    if let Some(m) = stk::read_entry(&mut zip, "mimetype") {
        let m = String::from_utf8_lossy(&m);
        if !m.trim().is_empty() && m.trim() != "application/epub+zip" {
            return Err("not_epub");
        }
    }
    if stk::has_drm(&mut zip) {
        return Err("drm");
    }
    let opf = stk::find_opf(&mut zip).map_err(|_| "corrupt")?;
    let doc = roxmltree::Document::parse(&opf.text).map_err(|_| "corrupt")?;

    let in_meta = |n: &roxmltree::Node| n.ancestors().any(|a| a.tag_name().name() == "metadata");
    let texts = |name: &str| -> Vec<String> {
        doc.descendants()
            .filter(|n| n.tag_name().name() == name && in_meta(n))
            .filter_map(|n| n.text().map(|t| t.trim().to_string()))
            .filter(|t| !t.is_empty())
            .collect()
    };
    let first = |name: &str| texts(name).into_iter().next();

    let basic = stk::read_meta(&opf);
    let creators = texts("creator");
    let author = (!creators.is_empty()).then(|| creators.join(", "));
    let cover = basic
        .cover
        .as_ref()
        .and_then(|(entry, _)| stk::read_entry(&mut zip, entry))
        .filter(|b| image::load_from_memory(b).is_ok());

    // Reading order: spine itemrefs → manifest hrefs → their sizes.
    let manifest: std::collections::HashMap<&str, &str> = doc
        .descendants()
        .filter(|n| n.tag_name().name() == "item")
        .filter_map(|n| Some((n.attribute("id")?, n.attribute("href")?)))
        .collect();
    let mut text_length = 0i64;
    for idref in doc
        .descendants()
        .filter(|n| n.tag_name().name() == "itemref")
        .filter_map(|n| n.attribute("idref"))
    {
        if let Some(href) = manifest.get(idref) {
            let name = stk::resolve(&opf.path, href);
            if let Ok(f) = zip.by_name(&name) {
                text_length += f.size() as i64;
            }
        }
    }

    Ok(EpubMeta {
        title: basic.title.or_else(|| first("title")),
        author,
        publisher: first("publisher"),
        description: first("description").map(|d| meta::strip_html(&d)).filter(|d| !d.is_empty()),
        subjects: texts("subject"),
        language: first("language"),
        isbn: texts("identifier").iter().find_map(|s| isbn_of(s)),
        cover,
        text_length,
    })
}

/// An ISBN-10/13 in an identifier ("urn:isbn:978-…", "978…"), digits and X only.
fn isbn_of(s: &str) -> Option<String> {
    let s = s.trim();
    let lower = s.to_ascii_lowercase();
    let body = lower.strip_prefix("urn:isbn:").or_else(|| lower.strip_prefix("isbn:")).unwrap_or(&lower);
    if body.chars().any(|c| !(c.is_ascii_digit() || c == '-' || c == ' ' || c == 'x')) {
        return None;
    }
    let d: String = body.chars().filter(|c| c.is_ascii_digit() || *c == 'x').collect::<String>().to_uppercase();
    let ok = (d.len() == 13 && (d.starts_with("978") || d.starts_with("979")) && !d.contains('X'))
        || (d.len() == 10 && !d[..9].contains('X'));
    ok.then_some(d)
}

/// One file's outcome, for the summary the UI shows.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ImportResult {
    pub path: String,
    pub name: String,
    /// added | duplicate | not_epub | drm | corrupt | error
    pub status: String,
    /// The book's id (added, or the one it duplicates).
    pub id: Option<String>,
    pub title: Option<String>,
    /// Another book in the library that looks like the same title.
    pub similar: Option<String>,
    /// Larger than `LARGE_BYTES`.
    pub large: bool,
    pub error: Option<String>,
}

/// Files to try for the given paths: files as they are, folders searched
/// (with sub-folders) for `.epub` files.
pub(crate) fn expand(paths: &[String]) -> Vec<PathBuf> {
    fn walk(dir: &Path, out: &mut Vec<PathBuf>, depth: usize) {
        if depth > 12 {
            return;
        }
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        let mut entries: Vec<PathBuf> = rd.filter_map(|e| e.ok().map(|e| e.path())).collect();
        entries.sort();
        for p in entries {
            if p.is_dir() {
                walk(&p, out, depth + 1);
            } else if p.extension().is_some_and(|e| e.eq_ignore_ascii_case("epub")) {
                out.push(p);
            }
        }
    }
    let mut out = Vec::new();
    for p in paths.iter().map(PathBuf::from) {
        if p.is_dir() {
            walk(&p, &mut out, 0);
        } else {
            out.push(p);
        }
    }
    out
}

/// Loose comparison key for "is this the same book?".
fn same_key(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

pub(crate) fn import_one(app: &AppHandle, path: &Path) -> ImportResult {
    let label = path.to_string_lossy().into_owned();
    // Android's file picker hands out content:// URIs, not paths.
    if label.starts_with("content://") {
        return import_uri(app, &label);
    }
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    match std::fs::read(path) {
        Ok(bytes) => import_bytes(app, &bytes, label, name),
        Err(e) => ImportResult {
            path: label,
            name,
            status: "error".into(),
            id: None,
            title: None,
            similar: None,
            large: false,
            error: Some(e.to_string()),
        },
    }
}

/// The last segment of a content:// URI, decoded: the closest thing to a file
/// name it has without asking its provider.
pub(crate) fn uri_name(uri: &str) -> String {
    let tail = uri.rsplit('/').next().unwrap_or(uri);
    let decoded = url::form_urlencoded::parse(format!("x={tail}").as_bytes())
        .next()
        .map(|(_, v)| v.into_owned())
        .unwrap_or_else(|| tail.to_string());
    decoded.rsplit(['/', ':']).next().unwrap_or(&decoded).to_string()
}

/// The bytes behind a content:// URI (Android), read through the fs plugin.
pub(crate) fn read_uri(app: &AppHandle, uri: &str) -> Result<Vec<u8>, String> {
    use tauri_plugin_fs::FsExt;
    uri.parse::<tauri_plugin_fs::FilePath>()
        .map_err(|e| e.to_string())
        .and_then(|fp| app.fs().read(fp).map_err(|e| e.to_string()))
}

/// A content:// URI (Android): read it through the fs plugin.
fn import_uri(app: &AppHandle, uri: &str) -> ImportResult {
    let name = uri_name(uri);
    match read_uri(app, uri) {
        Ok(bytes) => import_bytes(app, &bytes, uri.to_string(), name),
        Err(e) => ImportResult {
            path: uri.to_string(),
            name,
            status: "error".into(),
            id: None,
            title: None,
            similar: None,
            large: false,
            error: Some(e),
        },
    }
}

/// Add one book from its bytes. `path` / `name` are where it came from (shown
/// to the user and kept as the book's origin).
pub(crate) fn import_bytes(app: &AppHandle, bytes: &[u8], path: String, name: String) -> ImportResult {
    let mut res = ImportResult {
        path,
        name,
        status: "error".into(),
        id: None,
        title: None,
        similar: None,
        large: false,
        error: None,
    };
    res.large = bytes.len() as u64 > LARGE_BYTES;
    let em = match read_epub(bytes) {
        Ok(m) => m,
        Err(code) => {
            res.status = code.into();
            return res;
        }
    };
    let id = format!("{PREFIX}{}", &hex::encode(Sha256::digest(bytes))[..24]);
    res.id = Some(id.clone());

    let db: State<Db> = app.state();
    if let Some(t) = db.book_title(&id) {
        res.status = "duplicate".into();
        res.title = Some(t);
        return res;
    }

    // Display title / author, cleaned the same way as Kindle books.
    let stem = Path::new(&res.name).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let raw_title = em.title.clone().unwrap_or_else(|| stem.replace('_', " "));
    let (title, author) = meta::clean_title_author(&raw_title, em.author.as_deref().unwrap_or(""), None, None);
    res.title = Some(title.clone());

    // Same title + author (or ISBN) already among the local books? (A Kindle
    // book with the same title is offered as a link instead.)
    if let Ok(rows) = db.list_library() {
        let (kt, ka) = (same_key(&title), same_key(&author));
        res.similar = rows
            .iter()
            .filter(|r| r.source == "local")
            .find(|r| {
                let isbn_hit = em.isbn.is_some()
                    && crate::local::is_local(&r.asin)
                    && db.local_file(&r.asin).and_then(|f| f.isbn) == em.isbn;
                isbn_hit || (!kt.is_empty() && same_key(&r.title) == kt && (ka.is_empty() || same_key(&r.author) == ka))
            })
            .map(|r| r.title.clone());
    }

    // Copy: write next to the target, then rename, so an interrupted copy
    // never leaves a broken book behind.
    let target = match book_path(app, &id) {
        Ok(p) => p,
        Err(e) => {
            res.error = Some(e);
            return res;
        }
    };
    let part = target.with_extension("epub.part");
    if let Err(e) = std::fs::write(&part, bytes).and_then(|_| std::fs::rename(&part, &target)) {
        let _ = std::fs::remove_file(&part);
        res.error = Some(e.to_string());
        return res;
    }

    let mut cover_file = None;
    let mut spine = None;
    if let (Some(img), Ok(dir)) = (&em.cover, library_meta::covers_dir(app)) {
        let name = format!("{id}.{}", meta::image_ext(img));
        if std::fs::write(dir.join(&name), img).is_ok() {
            spine = meta::spine_color(img);
            cover_file = Some(name);
        }
    }

    let stored = db
        .insert_local_book(&NewLocalBook {
            id: id.clone(),
            title,
            author,
            content_type: "application/epub+zip".into(),
            format: "epub".into(),
            size: bytes.len() as i64,
            sha256: hex::encode(Sha256::digest(bytes)),
            original_path: res.path.clone(),
            original_name: res.name.clone(),
            isbn: em.isbn.clone(),
            added_at: chrono::Utc::now().to_rfc3339(),
        })
        .and_then(|_| {
            db.upsert_meta(&StoredMeta {
                asin: id.clone(),
                title: em.title,
                author: em.author,
                publisher: em.publisher,
                description: em.description,
                subjects: em.subjects,
                language: em.language,
                cover_file,
                spine_color: spine,
                source: "file".into(),
                text_length: Some(em.text_length),
            })
        });
    match stored {
        Ok(()) => res.status = "added".into(),
        Err(e) => {
            let _ = db.remove_book(&id);
            let _ = std::fs::remove_file(&target);
            res.error = Some(e.to_string());
        }
    }
    res
}

/// Add books from this computer: files and/or folders (searched for EPUBs).
/// Emits `import-progress` {done,total} after each file.
#[tauri::command]
pub async fn import_books(app: AppHandle, paths: Vec<String>) -> Result<Vec<ImportResult>, String> {
    let files = expand(&paths);
    let guard = IMPORTING.lock().await;
    CANCEL.store(false, Ordering::SeqCst);
    let total = files.len();
    let _ = app.emit("import-progress", serde_json::json!({"done": 0, "total": total}));
    let mut out = Vec::with_capacity(total);
    for (i, f) in files.into_iter().enumerate() {
        if CANCEL.swap(false, Ordering::SeqCst) {
            break;
        }
        let a = app.clone();
        let r = tauri::async_runtime::spawn_blocking(move || import_one(&a, &f))
            .await
            .map_err(|e| e.to_string())?;
        out.push(r);
        let _ = app.emit("import-progress", serde_json::json!({"done": i + 1, "total": total}));
    }
    drop(guard);
    Ok(out)
}

/// Stop the running import before its next file (files already added stay).
#[tauri::command]
pub fn cancel_import() {
    CANCEL.store(true, Ordering::SeqCst);
}

// ---- Local ↔ Kindle links ---------------------------------------------------

/// Title for matching: lower-case letters and digits, without a subtitle.
fn title_key(t: &str) -> String {
    let cut = [":", " - ", " – ", " (", "("]
        .iter()
        .filter_map(|s| t.find(s))
        .filter(|&i| i > 2)
        .min()
        .unwrap_or(t.len());
    same_key(&t[..cut])
}

/// The words of an author field ("Hoài, Tô" and "Tô Hoài" share both).
fn author_words(a: &str) -> std::collections::HashSet<String> {
    a.split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(|w| w.to_lowercase())
        .collect()
}

/// Do a local book and a Kindle book look like the same title?
pub fn looks_same(local: &LibraryRow, kindle: &LibraryRow) -> bool {
    let (a, b) = (title_key(&local.title), title_key(&kindle.title));
    if a.chars().count() < 3 || a != b {
        return false;
    }
    let (wa, wb) = (author_words(&local.author), author_words(&kindle.author));
    if wa.is_empty() || wb.is_empty() {
        return true;
    }
    let common = wa.intersection(&wb).count();
    common >= wa.len().min(wb.len()).min(2)
}

/// Fill `linked_asin` and `kindle_match` on the local rows.
pub fn attach_links(rows: &mut [LibraryRow], links: &[(String, String, String)]) {
    let kindle: std::collections::HashSet<String> =
        rows.iter().filter(|r| r.source != "local").map(|r| r.asin.clone()).collect();
    let linked: std::collections::HashMap<&str, &str> = links
        .iter()
        .filter(|(_, a, s)| s == "linked" && kindle.contains(a))
        .map(|(l, a, _)| (l.as_str(), a.as_str()))
        .collect();
    let taken: std::collections::HashSet<&str> = linked.values().copied().collect();
    let dismissed: std::collections::HashSet<(&str, &str)> =
        links.iter().filter(|(_, _, s)| s == "dismissed").map(|(l, a, _)| (l.as_str(), a.as_str())).collect();
    let matches: Vec<(usize, Option<String>, Option<String>)> = rows
        .iter()
        .enumerate()
        .filter(|(_, r)| r.source == "local")
        .map(|(i, r)| {
            if let Some(a) = linked.get(r.asin.as_str()) {
                return (i, Some(a.to_string()), None);
            }
            let m = rows
                .iter()
                .filter(|k| k.source != "local" && !taken.contains(k.asin.as_str()))
                .filter(|k| !dismissed.contains(&(r.asin.as_str(), k.asin.as_str())))
                .find(|k| looks_same(r, k))
                .map(|k| k.asin.clone());
            (i, None, m)
        })
        .collect();
    for (i, linked, m) in matches {
        rows[i].linked_asin = linked;
        rows[i].kindle_match = m;
    }
}

fn check_pair(db: &Db, local_id: &str, asin: &str) -> Result<(), String> {
    if !is_local(local_id) || is_local(asin) {
        return Err("a link joins a local book and a Kindle book".into());
    }
    if db.book_title(local_id).is_none() || db.book_title(asin).is_none() {
        return Err("book not in the library".into());
    }
    Ok(())
}

/// Join a local book and a Kindle book into one card.
#[tauri::command]
pub fn link_book(db: State<Db>, local_id: String, asin: String) -> Result<(), String> {
    check_pair(&db, &local_id, &asin)?;
    db.link_book(&local_id, &asin).map_err(|e| e.to_string())
}

/// "Not this book": stop suggesting this Kindle book for this local book.
#[tauri::command]
pub fn dismiss_link(db: State<Db>, local_id: String, asin: String) -> Result<(), String> {
    check_pair(&db, &local_id, &asin)?;
    db.dismiss_link(&local_id, &asin).map_err(|e| e.to_string())
}

/// Split a linked pair back into two cards.
#[tauri::command]
pub fn unlink_book(db: State<Db>, local_id: String) -> Result<(), String> {
    db.unlink_book(&local_id).map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
pub struct LocalUsage {
    pub count: i64,
    pub bytes: i64,
}

/// How many books were added from this computer and the space their copies take.
#[tauri::command]
pub fn local_usage(db: State<Db>) -> Result<LocalUsage, String> {
    let (count, bytes) = db.local_usage().map_err(|e| e.to_string())?;
    Ok(LocalUsage { count, bytes })
}

/// Take a local book off the library and delete the app's copy of it. The
/// user's original file is never touched.
#[tauri::command]
pub fn remove_local_book(app: AppHandle, asin: String) -> Result<(), String> {
    if !is_local(&asin) {
        return Err("not a local book".into());
    }
    let db: State<Db> = app.state();
    let covers = library_meta::covers_dir(&app)?;
    if let Some(old) = db.override_cover(&asin).filter(|n| library_meta::safe_cover_name(n)) {
        let _ = std::fs::remove_file(covers.join(old));
    }
    for ext in ["jpg", "png", "gif"] {
        let _ = std::fs::remove_file(covers.join(format!("{asin}.{ext}")));
    }
    db.remove_book(&asin).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(book_path(&app, &asin)?);
    Ok(())
}

#[derive(serde::Serialize)]
pub struct LocalInfo {
    #[serde(flatten)]
    pub file: crate::db::LocalFile,
    /// The app's own copy (what "Send to Kindle" sends).
    pub path: String,
}

/// Where a local book was added from, and where the app keeps it.
#[tauri::command]
pub fn local_book_info(app: AppHandle, asin: String) -> Option<LocalInfo> {
    let db: State<Db> = app.state();
    let file = db.local_file(&asin)?;
    let path = book_path(&app, &asin).ok()?.to_string_lossy().into_owned();
    Some(LocalInfo { file, path })
}

/// Show the app's copy of a local book in Explorer.
#[tauri::command]
pub fn reveal_local_book(app: AppHandle, asin: String) -> Result<(), String> {
    if !is_local(&asin) {
        return Err("not a local book".into());
    }
    let p = book_path(&app, &asin)?;
    if !p.exists() {
        return Err("missing_file".into());
    }
    tauri_plugin_opener::reveal_item_in_dir(p).map_err(|e| e.to_string())
}

/// Bytes of a local book for the reader.
pub fn read_book(app: &AppHandle, id: &str) -> Result<Vec<u8>, String> {
    let p = book_path(app, id)?;
    let mut f = std::fs::File::open(&p).map_err(|_| "missing_file".to_string())?;
    let mut b = Vec::new();
    f.read_to_end(&mut b).map_err(|e| e.to_string())?;
    Ok(b)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn epub(opf_meta: &str, encryption: Option<&str>) -> Vec<u8> {
        let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let o = zip::write::SimpleFileOptions::default();
        w.start_file("mimetype", o).unwrap();
        w.write_all(b"application/epub+zip").unwrap();
        w.start_file("META-INF/container.xml", o).unwrap();
        w.write_all(br#"<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>"#).unwrap();
        if let Some(e) = encryption {
            w.start_file("META-INF/encryption.xml", o).unwrap();
            w.write_all(e.as_bytes()).unwrap();
        }
        w.start_file("OEBPS/content.opf", o).unwrap();
        write!(
            w,
            r#"<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata>{opf_meta}</metadata><manifest><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>"#
        )
        .unwrap();
        w.start_file("OEBPS/ch1.xhtml", o).unwrap();
        w.write_all(b"<html><body><p>Hello world</p></body></html>").unwrap();
        w.finish().unwrap().into_inner()
    }

    #[test]
    fn reads_metadata() {
        let b = epub(
            "<dc:title>Dế Mèn phiêu lưu ký</dc:title><dc:creator>Tô Hoài</dc:creator><dc:identifier>urn:isbn:978-604-2-12345-6</dc:identifier><dc:language>vi</dc:language>",
            None,
        );
        let m = read_epub(&b).unwrap();
        assert_eq!(m.title.as_deref(), Some("Dế Mèn phiêu lưu ký"));
        assert_eq!(m.author.as_deref(), Some("Tô Hoài"));
        assert_eq!(m.isbn.as_deref(), Some("9786042123456"));
        assert_eq!(m.language.as_deref(), Some("vi"));
        assert_eq!(m.text_length, 44);
    }

    #[test]
    fn rejects_drm_and_junk() {
        let drm = r#"<encryption><EncryptedData><EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/></EncryptedData></encryption>"#;
        assert_eq!(read_epub(&epub("<dc:title>X</dc:title>", Some(drm))).unwrap_err(), "drm");
        let fonts = r#"<encryption><EncryptedData><EncryptionMethod Algorithm="http://www.idpf.org/2008/embedding"/></EncryptedData></encryption>"#;
        assert!(read_epub(&epub("<dc:title>X</dc:title>", Some(fonts))).is_ok());
        assert_eq!(read_epub(b"%PDF-1.7 ...").unwrap_err(), "not_epub");
        assert_eq!(read_epub(b"PK\x03\x04garbage").unwrap_err(), "corrupt");
    }

    /// Inspect a real file: `PNB_EPUB=<path> cargo test --lib local::tests::real_file -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn real_file() {
        let b = std::fs::read(std::env::var("PNB_EPUB").unwrap()).unwrap();
        let m = read_epub(&b).unwrap();
        println!("{:?} / {:?} / isbn {:?} / lang {:?} / cover {} bytes / text {}",
            m.title, m.author, m.isbn, m.language, m.cover.as_ref().map_or(0, |c| c.len()), m.text_length);
        assert!(m.title.is_some());
    }

    #[test]
    fn isbns() {
        assert_eq!(isbn_of("urn:isbn:0-306-40615-2").as_deref(), Some("0306406152"));
        assert_eq!(isbn_of("9780306406157").as_deref(), Some("9780306406157"));
        assert_eq!(isbn_of("urn:uuid:1234-5678"), None);
        assert_eq!(isbn_of("calibre:123"), None);
    }

    fn lib_row(asin: &str, title: &str, author: &str, source: &str) -> LibraryRow {
        let json = serde_json::json!({});
        let _ = json;
        LibraryRow {
            asin: asin.into(),
            cde_type: if source == "local" { "LOCAL".into() } else { "EBOK".into() },
            title: title.into(),
            author: author.into(),
            auto_title: title.into(),
            auto_author: author.into(),
            original_title: title.into(),
            original_author: author.into(),
            edited: false,
            typographic_cover: false,
            auto_cover: None,
            content_type: String::new(),
            purchase_date: String::new(),
            percent: None,
            furthest_pos: None,
            description: None,
            subjects: vec![],
            language: None,
            publisher: None,
            cover: None,
            spine_color: String::new(),
            auto_spine_color: String::new(),
            text_length: None,
            spine_style: None,
            spine_font: None,
            spine_width: None,
            shelf_pos: None,
            meta_ready: true,
            status: "unread".into(),
            status_manual: false,
            last_read: None,
            source: source.into(),
            file_missing: false,
            linked_asin: None,
            kindle_match: None,
        }
    }

    #[test]
    fn suggests_and_links_kindle_twins() {
        let mut rows = vec![
            lib_row("L_a", "Dế Mèn phiêu lưu ký", "Tô Hoài", "local"),
            lib_row("L_b", "Sapiens: A Brief History of Humankind", "Yuval Noah Harari", "local"),
            lib_row("L_c", "Something Else", "Nobody", "local"),
            lib_row("B000000001", "Dế mèn phiêu lưu ký (Tái bản 2020)", "Hoài, Tô", "amazon"),
            lib_row("B000000002", "Sapiens", "Harari, Yuval Noah", "amazon"),
        ];
        attach_links(&mut rows, &[]);
        assert_eq!(rows[0].kindle_match.as_deref(), Some("B000000001"));
        assert_eq!(rows[1].kindle_match.as_deref(), Some("B000000002"));
        assert_eq!(rows[2].kindle_match, None);

        let links = vec![
            ("L_a".to_string(), "B000000001".to_string(), "linked".to_string()),
            ("L_b".to_string(), "B000000002".to_string(), "dismissed".to_string()),
        ];
        attach_links(&mut rows, &links);
        assert_eq!(rows[0].linked_asin.as_deref(), Some("B000000001"));
        assert_eq!(rows[0].kindle_match, None);
        assert_eq!(rows[1].kindle_match, None);
    }

    #[test]
    fn different_authors_do_not_match() {
        let a = lib_row("L_a", "Emma", "Jane Austen", "local");
        let b = lib_row("B000000003", "Emma", "Some Other Writer", "amazon");
        assert!(!looks_same(&a, &b));
    }

    #[test]
    fn ids_never_look_like_asins() {
        assert!(is_local("L_3fa91c0e7b2d4a6f81c95e02"));
        assert!(!is_local("B00ABCDEFG"));
        assert!(library_meta::safe_cover_name("L_3fa91c0e7b2d4a6f81c95e02.jpg"));
    }
}
