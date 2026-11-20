//! Send to Kindle: check and edit an EPUB, then hand it to Amazon through the
//! upload API the Send to Kindle desktop app uses (`kd.amazon.com/import/…`,
//! signed with this app's ADP registration):
//!   1. get-device-list  — where it can go
//!   2. upload-url       — a one-off URL and token for `fileSize` bytes
//!   3. PUT the file to that URL (unsigned)
//!   4. send-to-kindle   — title/author, target devices, keep in library
//! Amazon then converts the EPUB to KF8 and it shows up in the library as a
//! personal document a few minutes later.

use std::collections::HashMap;
use std::io::{Cursor, Read, Write};

use base64::Engine;
use futures_util::StreamExt;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::adp::{client, sign};
use crate::creds;

const KD_HOST: &str = "kd.amazon.com";
/// Send to Kindle's own size limit for documents.
pub const MAX_BYTES: u64 = 200 * 1024 * 1024;
/// Device names this app gives its own registrations ("pinknbook ABC123").
const APP_DEVICE_PREFIX: &str = "pinknbook ";

// ---- EPUB -------------------------------------------------------------------

/// What the send dialog shows about a file before sending.
#[derive(Debug, Clone, serde::Serialize)]
pub struct EpubInfo {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub title: Option<String>,
    pub author: Option<String>,
    /// Small JPEG of the cover as a data URL.
    pub cover: Option<String>,
    /// Problem codes (the UI words them): not_epub, no_mimetype, no_container,
    /// no_opf, no_title, drm, too_big.
    pub problems: Vec<String>,
}

pub(crate) struct Opf {
    /// Path of the package document inside the zip.
    pub path: String,
    pub text: String,
}

pub(crate) fn read_entry(zip: &mut zip::ZipArchive<Cursor<Vec<u8>>>, name: &str) -> Option<Vec<u8>> {
    let mut f = zip.by_name(name).ok()?;
    let mut out = Vec::with_capacity(f.size() as usize);
    f.read_to_end(&mut out).ok()?;
    Some(out)
}

pub(crate) fn find_opf(zip: &mut zip::ZipArchive<Cursor<Vec<u8>>>) -> Result<Opf, &'static str> {
    let container = read_entry(zip, "META-INF/container.xml").ok_or("no_container")?;
    let text = String::from_utf8_lossy(&container).into_owned();
    let doc = roxmltree::Document::parse(&text).map_err(|_| "no_container")?;
    let path = doc
        .descendants()
        .find(|n| n.tag_name().name() == "rootfile")
        .and_then(|n| n.attribute("full-path"))
        .ok_or("no_opf")?
        .to_string();
    let bytes = read_entry(zip, &path).ok_or("no_opf")?;
    Ok(Opf {
        path,
        text: String::from_utf8_lossy(&bytes).into_owned(),
    })
}

/// Resolve an OPF-relative href to a zip entry name.
pub(crate) fn resolve(opf_path: &str, href: &str) -> String {
    let base = opf_path.rsplit_once('/').map(|(d, _)| d).unwrap_or("");
    let href = href.split('#').next().unwrap_or(href).replace("%20", " ");
    let mut parts: Vec<&str> = if base.is_empty() { vec![] } else { base.split('/').collect() };
    for seg in href.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            s => parts.push(s),
        }
    }
    parts.join("/")
}

pub(crate) struct Meta {
    pub title: Option<String>,
    pub author: Option<String>,
    /// Zip entry of the cover image and its media type.
    pub cover: Option<(String, String)>,
}

pub(crate) fn read_meta(opf: &Opf) -> Meta {
    let Ok(doc) = roxmltree::Document::parse(&opf.text) else {
        return Meta { title: None, author: None, cover: None };
    };
    let text_of = |name: &str| {
        doc.descendants()
            .filter(|n| n.tag_name().name() == name && n.ancestors().any(|a| a.tag_name().name() == "metadata"))
            .filter_map(|n| n.text().map(|t| t.trim().to_string()))
            .find(|t| !t.is_empty())
    };
    let items: Vec<roxmltree::Node> = doc.descendants().filter(|n| n.tag_name().name() == "item").collect();
    let cover_id = doc
        .descendants()
        .find(|n| n.tag_name().name() == "meta" && n.attribute("name") == Some("cover"))
        .and_then(|n| n.attribute("content"));
    let is_image = |n: &roxmltree::Node| n.attribute("media-type").is_some_and(|m| m.starts_with("image/"));
    let cover = items
        .iter()
        .find(|n| n.attribute("properties").is_some_and(|p| p.split_whitespace().any(|x| x == "cover-image")))
        .or_else(|| cover_id.and_then(|id| items.iter().find(|n| n.attribute("id") == Some(id))))
        .or_else(|| {
            items.iter().find(|n| {
                is_image(n)
                    && (n.attribute("id").is_some_and(|i| i.to_ascii_lowercase().contains("cover"))
                        || n.attribute("href").is_some_and(|h| h.to_ascii_lowercase().contains("cover")))
            })
        })
        .filter(|n| is_image(n))
        .and_then(|n| {
            Some((
                resolve(&opf.path, n.attribute("href")?),
                n.attribute("media-type").unwrap_or("image/jpeg").to_string(),
            ))
        });
    Meta {
        title: text_of("title"),
        author: text_of("creator"),
        cover,
    }
}

/// A small JPEG data URL of an image, for previews.
fn thumb_data_url(bytes: &[u8]) -> Option<String> {
    let img = image::load_from_memory(bytes).ok()?;
    let t = img.thumbnail(240, 360).to_rgb8();
    let mut out = Cursor::new(Vec::new());
    image::DynamicImage::ImageRgb8(t)
        .write_to(&mut out, image::ImageFormat::Jpeg)
        .ok()?;
    Some(format!(
        "data:image/jpeg;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(out.into_inner())
    ))
}

fn inspect(path: &str) -> EpubInfo {
    let p = std::path::Path::new(path);
    let mut info = EpubInfo {
        path: path.to_string(),
        name: p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        size: std::fs::metadata(p).map(|m| m.len()).unwrap_or(0),
        title: None,
        author: None,
        cover: None,
        problems: vec![],
    };
    if info.size > MAX_BYTES {
        info.problems.push("too_big".into());
    }
    let Ok(bytes) = std::fs::read(p) else {
        info.problems.push("not_epub".into());
        return info;
    };
    let Ok(mut zip) = zip::ZipArchive::new(Cursor::new(bytes)) else {
        info.problems.push("not_epub".into());
        return info;
    };
    match read_entry(&mut zip, "mimetype") {
        Some(m) if String::from_utf8_lossy(&m).trim() == "application/epub+zip" => {}
        _ => info.problems.push("no_mimetype".into()),
    }
    if has_drm(&mut zip) {
        info.problems.push("drm".into());
    }
    match find_opf(&mut zip) {
        Err(code) => info.problems.push(code.into()),
        Ok(opf) => {
            let meta = read_meta(&opf);
            info.title = meta.title;
            info.author = meta.author;
            if info.title.is_none() {
                info.problems.push("no_title".into());
            }
            if let Some((entry, _)) = meta.cover {
                info.cover = read_entry(&mut zip, &entry).and_then(|b| thumb_data_url(&b));
            }
        }
    }
    info
}

/// Is the EPUB encrypted with DRM? Font obfuscation (IDPF, Adobe) is fine;
/// any other algorithm in `META-INF/encryption.xml` means DRM.
pub(crate) fn has_drm(zip: &mut zip::ZipArchive<Cursor<Vec<u8>>>) -> bool {
    let Some(enc) = read_entry(zip, "META-INF/encryption.xml") else { return false };
    let s = String::from_utf8_lossy(&enc);
    s.match_indices("Algorithm=\"").any(|(i, _)| {
        let rest = &s[i + 11..];
        let alg = rest.split('"').next().unwrap_or("");
        alg != "http://www.idpf.org/2008/embedding" && alg != "http://ns.adobe.com/pdf/enc#RC"
    })
}

fn xml_text(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// Set the text of the first `<dc:{name}>` in the OPF, adding one if missing.
fn set_dc(opf: &str, name: &str, value: &str) -> String {
    let Ok(doc) = roxmltree::Document::parse(opf) else {
        return opf.to_string();
    };
    let found = doc
        .descendants()
        .find(|n| n.tag_name().name() == name && n.ancestors().any(|a| a.tag_name().name() == "metadata"));
    if let Some(n) = found {
        let r = n.range();
        let el = &opf[r.clone()];
        let open_end = el.find('>').unwrap_or(0) + 1;
        let qname = el[1..].split(|c: char| c.is_whitespace() || c == '>' || c == '/').next().unwrap_or("dc:title");
        let new_el = if el.trim_end().ends_with("/>") {
            let open = el[..el.len() - 2].trim_end();
            format!("{open}>{}</{qname}>", xml_text(value))
        } else {
            let close = el.rfind("</").unwrap_or(el.len());
            format!("{}{}{}", &el[..open_end], xml_text(value), &el[close..])
        };
        return format!("{}{}{}", &opf[..r.start], new_el, &opf[r.end..]);
    }
    let Some(meta) = doc.descendants().find(|n| n.tag_name().name() == "metadata") else {
        return opf.to_string();
    };
    let r = meta.range();
    let close = opf[..r.end].rfind("</").unwrap_or(r.end);
    format!(
        "{}<dc:{name} xmlns:dc=\"http://purl.org/dc/elements/1.1/\">{}</dc:{name}>{}",
        &opf[..close],
        xml_text(value),
        &opf[close..]
    )
}

/// Add a new cover image item (when the book has none).
fn add_cover_item(opf: &str, href: &str) -> String {
    let epub3 = opf.contains("version=\"3");
    let props = if epub3 { " properties=\"cover-image\"" } else { "" };
    let item = format!("<item id=\"pnb-cover\" href=\"{href}\" media-type=\"image/jpeg\"{props}/>");
    let meta = "<meta name=\"cover\" content=\"pnb-cover\"/>";
    let mut out = opf.to_string();
    if let Some(i) = out.rfind("</manifest>").or_else(|| out.rfind("</opf:manifest>")) {
        out.insert_str(i, &item);
    }
    if let Some(i) = out.rfind("</metadata>").or_else(|| out.rfind("</opf:metadata>")) {
        out.insert_str(i, meta);
    }
    out
}

/// Re-encode `img` in the format a cover entry already uses (so the OPF's
/// media type stays true).
fn encode_like(img: &image::DynamicImage, media_type: &str) -> Option<Vec<u8>> {
    let fmt = if media_type.contains("png") {
        image::ImageFormat::Png
    } else {
        image::ImageFormat::Jpeg
    };
    let mut out = Cursor::new(Vec::new());
    let img = if fmt == image::ImageFormat::Jpeg {
        image::DynamicImage::ImageRgb8(img.to_rgb8())
    } else {
        img.clone()
    };
    img.write_to(&mut out, fmt).ok()?;
    Some(out.into_inner())
}

/// The bytes to upload: the file as-is, or a copy with a new title, author
/// and/or cover. The original file is never touched.
fn prepare(path: &str, title: &str, author: &str, cover_path: Option<&str>) -> Result<Vec<u8>, String> {
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes.clone())).map_err(|_| "not an EPUB".to_string())?;
    let opf = find_opf(&mut zip).map_err(|e| e.to_string())?;
    let meta = read_meta(&opf);
    let title_changed = meta.title.as_deref().unwrap_or("") != title.trim();
    let author_changed = meta.author.as_deref().unwrap_or("") != author.trim();
    if !title_changed && !author_changed && cover_path.is_none() {
        return Ok(bytes);
    }

    let mut new_opf = opf.text.clone();
    if title_changed && !title.trim().is_empty() {
        new_opf = set_dc(&new_opf, "title", title.trim());
    }
    if author_changed && !author.trim().is_empty() {
        new_opf = set_dc(&new_opf, "creator", author.trim());
    }
    // New cover: replace the existing image in its own format, or add one.
    let mut replace: HashMap<String, Vec<u8>> = HashMap::new();
    let mut add: Option<(String, Vec<u8>)> = None;
    if let Some(cp) = cover_path {
        let img = image::open(cp).map_err(|e| format!("cover: {e}"))?;
        match &meta.cover {
            Some((entry, media)) => {
                replace.insert(entry.clone(), encode_like(&img, media).ok_or("cover encode failed")?);
            }
            None => {
                let base = opf.path.rsplit_once('/').map(|(d, _)| format!("{d}/")).unwrap_or_default();
                add = Some((format!("{base}pnb-cover.jpg"), encode_like(&img, "image/jpeg").ok_or("cover encode failed")?));
                new_opf = add_cover_item(&new_opf, "pnb-cover.jpg");
            }
        }
    }
    replace.insert(opf.path.clone(), new_opf.into_bytes());

    let mut out = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let stored = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    let deflated = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    // The mimetype entry must come first, uncompressed.
    out.start_file("mimetype", stored).map_err(|e| e.to_string())?;
    out.write_all(b"application/epub+zip").map_err(|e| e.to_string())?;
    for i in 0..zip.len() {
        let name = zip.by_index(i).map_err(|e| e.to_string())?.name().to_string();
        if name == "mimetype" {
            continue;
        }
        if let Some(data) = replace.remove(&name) {
            out.start_file(name.as_str(), deflated).map_err(|e| e.to_string())?;
            out.write_all(&data).map_err(|e| e.to_string())?;
        } else {
            let f = zip.by_index_raw(i).map_err(|e| e.to_string())?;
            out.raw_copy_file(f).map_err(|e| e.to_string())?;
        }
    }
    if let Some((name, data)) = add {
        out.start_file(name.as_str(), deflated).map_err(|e| e.to_string())?;
        out.write_all(&data).map_err(|e| e.to_string())?;
    }
    Ok(out.finish().map_err(|e| e.to_string())?.into_inner())
}

#[tauri::command]
pub async fn epub_inspect(paths: Vec<String>) -> Result<Vec<EpubInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || paths.iter().map(|p| inspect(p)).collect())
        .await
        .map_err(|e| e.to_string())
}

/// Preview of a cover picture the user picked.
#[tauri::command]
pub async fn image_preview(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let b = std::fs::read(&path).map_err(|e| e.to_string())?;
        thumb_data_url(&b).ok_or_else(|| "not an image".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---- Send to Kindle API -------------------------------------------------------

fn client_info() -> Value {
    json!({
        "appName": "ShellExtension",
        "appVersion": "1.1.1.253",
        "os": "Windows",
        "osArchitecture": "x64",
    })
}

async fn kd_post(path: &str, mut body: Value) -> Result<Value, String> {
    let creds = creds::load()?.ok_or_else(|| "not signed in".to_string())?;
    let key = sign::load_private_key(&creds.device_private_key).map_err(|e| e.to_string())?;
    body["clientInfo"] = client_info();
    let text = serde_json::to_string(&body).map_err(|e| e.to_string())?;
    let resp = client::signed_post(&key, &creds, KD_HOST, path, &text, "application/json")
        .await
        .map_err(|e| e.to_string())?;
    let v: Value = serde_json::from_str(&resp).map_err(|e| format!("bad response: {e}"))?;
    match v.get("statusCode").and_then(|s| s.as_i64()) {
        Some(0) | None => Ok(v),
        Some(code) => Err(format!("Send to Kindle error {code}")),
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct StkDevice {
    pub name: String,
    pub serial: String,
    /// One of this app's own registrations (hidden by default).
    pub app_made: bool,
}

#[tauri::command]
pub async fn stk_devices() -> Result<Vec<StkDevice>, String> {
    let v = kd_post("/import/kindle-doc/get-device-list", json!({})).await?;
    Ok(v["ownedDevices"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|d| {
                    let name = d["deviceName"].as_str()?.to_string();
                    Some(StkDevice {
                        app_made: name.starts_with(APP_DEVICE_PREFIX),
                        serial: d["deviceSerialNumber"].as_str()?.to_string(),
                        name,
                    })
                })
                .collect()
        })
        .unwrap_or_default())
}

#[derive(Clone, serde::Serialize)]
struct Progress<'a> {
    job: &'a str,
    phase: &'a str,
    done: u64,
    total: u64,
}

/// Send one EPUB. Emits `stk-progress` events ({job, phase: prepare | upload
/// | send, done, total}); returns Amazon's id for the queued document.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn stk_send(
    app: AppHandle,
    job: String,
    path: String,
    title: String,
    author: String,
    cover_path: Option<String>,
    devices: Vec<String>,
) -> Result<String, String> {
    let emit = |phase: &str, done: u64, total: u64| {
        let _ = app.emit("stk-progress", Progress { job: &job, phase, done, total });
    };
    emit("prepare", 0, 0);
    let (p, t, a, c) = (path.clone(), title.clone(), author.clone(), cover_path.clone());
    let data = tauri::async_runtime::spawn_blocking(move || prepare(&p, &t, &a, c.as_deref()))
        .await
        .map_err(|e| e.to_string())??;
    let size = data.len() as u64;
    if size > MAX_BYTES {
        return Err("too_big".into());
    }

    let up = kd_post("/import/upload-url", json!({ "fileSize": size })).await?;
    let url = up["uploadUrl"].as_str().ok_or("no upload URL")?.to_string();
    let token = up["stkToken"].as_str().ok_or("no upload token")?.to_string();

    // Stream the file in chunks so progress can be reported.
    emit("upload", 0, size);
    let chunks: Vec<Vec<u8>> = data.chunks(256 * 1024).map(|c| c.to_vec()).collect();
    let app2 = app.clone();
    let job2 = job.clone();
    let mut sent = 0u64;
    let stream = futures_util::stream::iter(chunks).map(move |c| {
        sent += c.len() as u64;
        let _ = app2.emit("stk-progress", Progress { job: &job2, phase: "upload", done: sent, total: size });
        Ok::<_, std::io::Error>(c)
    });
    let resp = reqwest::Client::new()
        .put(&url)
        .header("Content-Length", size)
        .header("User-Agent", "Mozilla/5.0")
        .body(reqwest::Body::wrap_stream(stream))
        .send()
        .await
        .map_err(|e| format!("upload: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("upload: HTTP {}", resp.status()));
    }

    emit("send", 0, 0);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let r = kd_post(
        "/import/kindle-doc/send-to-kindle",
        json!({
            "archive": true,
            "documentMetadata": {
                "author": author.trim(),
                "crc32": 0,
                "inputFormat": "epub",
                "title": title.trim(),
            },
            "fileSize": size,
            "forceConvert": false,
            "sendTimeMillis": now,
            "shouldExtractWebContent": false,
            "stkToken": token,
            "targetDevices": devices,
        }),
    )
    .await?;
    Ok(r["sku"].as_str().unwrap_or("").to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_epub(opf: &str, with_cover: bool) -> Vec<u8> {
        let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let o = zip::write::SimpleFileOptions::default();
        w.start_file("mimetype", o).unwrap();
        w.write_all(b"application/epub+zip").unwrap();
        w.start_file("META-INF/container.xml", o).unwrap();
        w.write_all(br#"<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>"#).unwrap();
        w.start_file("OEBPS/content.opf", o).unwrap();
        w.write_all(opf.as_bytes()).unwrap();
        if with_cover {
            let img = image::DynamicImage::new_rgb8(4, 6);
            w.start_file("OEBPS/images/cover.jpg", o).unwrap();
            w.write_all(&encode_like(&img, "image/jpeg").unwrap()).unwrap();
        }
        w.finish().unwrap().into_inner()
    }

    const OPF: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Old &amp; Title</dc:title><dc:creator>A. Writer</dc:creator><meta name="cover" content="c"/></metadata>
<manifest><item id="c" href="images/cover.jpg" media-type="image/jpeg"/></manifest><spine/></package>"#;

    #[test]
    fn inspects_and_rewrites() {
        let dir = std::env::temp_dir().join(format!("pnb-stk-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("a.epub");
        std::fs::write(&p, make_epub(OPF, true)).unwrap();
        let info = inspect(p.to_str().unwrap());
        assert!(info.problems.is_empty(), "{:?}", info.problems);
        assert_eq!(info.title.as_deref(), Some("Old & Title"));
        assert_eq!(info.author.as_deref(), Some("A. Writer"));
        assert!(info.cover.as_deref().unwrap().starts_with("data:image/jpeg"));

        // Unchanged: the very same bytes go up.
        let same = prepare(p.to_str().unwrap(), "Old & Title", "A. Writer", None).unwrap();
        assert_eq!(same, std::fs::read(&p).unwrap());

        // New title and author, with a new cover.
        let cov = dir.join("c.png");
        image::DynamicImage::new_rgb8(8, 12).save(&cov).unwrap();
        let out = prepare(p.to_str().unwrap(), "Tên mới <1>", "Tác giả", Some(cov.to_str().unwrap())).unwrap();
        let q = dir.join("b.epub");
        std::fs::write(&q, &out).unwrap();
        let info = inspect(q.to_str().unwrap());
        assert!(info.problems.is_empty(), "{:?}", info.problems);
        assert_eq!(info.title.as_deref(), Some("Tên mới <1>"));
        assert_eq!(info.author.as_deref(), Some("Tác giả"));
        assert!(info.cover.is_some());
        // mimetype first and stored.
        let mut z = zip::ZipArchive::new(Cursor::new(out)).unwrap();
        let first = z.by_index(0).unwrap();
        assert_eq!(first.name(), "mimetype");
        assert_eq!(first.compression(), zip::CompressionMethod::Stored);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn adds_missing_cover_and_title() {
        let opf = r#"<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"></metadata><manifest></manifest><spine/></package>"#;
        let dir = std::env::temp_dir().join(format!("pnb-stk2-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("a.epub");
        std::fs::write(&p, make_epub(opf, false)).unwrap();
        let info = inspect(p.to_str().unwrap());
        assert_eq!(info.problems, vec!["no_title".to_string()]);
        let cov = dir.join("c.png");
        image::DynamicImage::new_rgb8(8, 12).save(&cov).unwrap();
        let out = prepare(p.to_str().unwrap(), "T", "A", Some(cov.to_str().unwrap())).unwrap();
        let q = dir.join("b.epub");
        std::fs::write(&q, &out).unwrap();
        let info = inspect(q.to_str().unwrap());
        assert!(info.problems.is_empty(), "{:?}", info.problems);
        assert_eq!(info.title.as_deref(), Some("T"));
        assert!(info.cover.is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_non_epub_and_drm() {
        let dir = std::env::temp_dir().join(format!("pnb-stk3-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("x.epub");
        std::fs::write(&p, b"not a zip").unwrap();
        assert_eq!(inspect(p.to_str().unwrap()).problems, vec!["not_epub".to_string()]);
        let mut z = zip::ZipWriter::new_append(Cursor::new(make_epub(OPF, true))).unwrap();
        z.start_file("META-INF/encryption.xml", zip::write::SimpleFileOptions::default()).unwrap();
        z.write_all(br#"<encryption><EncryptedData><EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/></EncryptedData></encryption>"#).unwrap();
        std::fs::write(&p, z.finish().unwrap().into_inner()).unwrap();
        assert!(inspect(p.to_str().unwrap()).problems.contains(&"drm".to_string()));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
