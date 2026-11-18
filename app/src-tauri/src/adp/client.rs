//! Signed ADP client: builds `X-ADP-*` headers and talks to the regional
//! Fiona hosts. Ported from the original Python spike, extended with the
//! library (syncMetaData) and reading-state (sidecar) calls for Milestone 1.
//!
//! Hosts are the ones confirmed from real Kindle-for-PC traffic
//! (P6 — regional-host blocker, closed):
//!   todo-ta-g7g.amazon.com  — FionaTodoListProxy (library)
//!   cde-ta-g7g.amazon.com   — FionaCDEServiceEngine (reading state / download)

use chrono::Utc;
use rsa::RsaPrivateKey;

use super::register::{Credentials, APP_VERSION};
use super::{sign, AdpError};

pub const TODO_HOST: &str = "todo-ta-g7g.amazon.com";
pub const CDE_HOST: &str = "cde-ta-g7g.amazon.com";

/// A book as parsed from the syncMetaData response.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Default)]
pub struct Book {
    pub asin: String,
    pub title: String,
    pub author: String,
    /// "EBOK" (purchased, DRM) or "PDOC" (personal doc, readable in-app).
    pub cde_type: String,
    pub content_type: String,
    pub purchase_date: String,
}

/// Reading state derived from the sidecar record.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Default)]
pub struct ReadingState {
    pub asin: String,
    /// Furthest / most-recent read position (KRF/MOBI offset), if known.
    pub position: Option<i64>,
    /// 0..=100 when a total length is available, else None.
    pub percent: Option<f64>,
}

/// UTC timestamp with trailing `Z`. This is the format proven accepted by Amazon
/// in the spike (200 OK against api.amazon.com). The server rebuilds the
/// canonical string from this exact header value, so signing stays consistent.
/// NOTE: real Kindle also used local-time-without-zone for the Fiona hosts; if
/// those ever reject the `Z` form over clock-skew, switch this per-host.
fn utc_stamp() -> String {
    Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

/// Issue a signed ADP request and return the raw body text.
async fn signed_get(
    key: &RsaPrivateKey,
    creds: &Credentials,
    host: &str,
    path: &str,
) -> Result<String, AdpError> {
    let ts = utc_stamp();
    let digest = sign::sign_digest(key, "GET", path, &ts, "", &creds.adp_token)?;

    let client = reqwest::Client::new();
    let resp = client
        .get(format!("https://{host}{path}"))
        .header("X-ADP-Request-Digest", digest)
        .header("X-ADP-Authentication-Token", &creds.adp_token)
        .header("X-ADP-SW", APP_VERSION)
        .header("Accept-Language", "en-US")
        .header("User-Agent", "Mozilla/5.0")
        .send()
        .await
        .map_err(|e| AdpError::Http(e.to_string()))?;

    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| AdpError::Http(e.to_string()))?;
    if !status.is_success() {
        return Err(AdpError::Http(format!(
            "HTTP {status} from {host}{path}: {}",
            &text.chars().take(300).collect::<String>()
        )));
    }
    Ok(text)
}

/// Issue a signed ADP request and return the raw body bytes (for binary content).
async fn signed_get_bytes(
    key: &RsaPrivateKey,
    creds: &Credentials,
    host: &str,
    path: &str,
) -> Result<Vec<u8>, AdpError> {
    let ts = utc_stamp();
    let digest = sign::sign_digest(key, "GET", path, &ts, "", &creds.adp_token)?;

    let client = reqwest::Client::new();
    let resp = client
        .get(format!("https://{host}{path}"))
        .header("X-ADP-Request-Digest", digest)
        .header("X-ADP-Authentication-Token", &creds.adp_token)
        .header("X-ADP-SW", APP_VERSION)
        .header("Accept-Language", "en-US")
        .header("User-Agent", "Mozilla/5.0")
        .send()
        .await
        .map_err(|e| AdpError::Http(e.to_string()))?;

    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(AdpError::Http(format!(
            "HTTP {status} from {host}{path}: {}",
            &text.chars().take(300).collect::<String>()
        )));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| AdpError::Http(e.to_string()))?;
    Ok(bytes.to_vec())
}

/// Issue a signed ADP POST with a text body and return the response text.
pub(crate) async fn signed_post(
    key: &RsaPrivateKey,
    creds: &Credentials,
    host: &str,
    path: &str,
    body: &str,
    content_type: &str,
) -> Result<String, AdpError> {
    let ts = utc_stamp();
    let digest = sign::sign_digest(key, "POST", path, &ts, body, &creds.adp_token)?;

    let client = reqwest::Client::new();
    let resp = client
        .post(format!("https://{host}{path}"))
        .header("X-ADP-Request-Digest", digest)
        .header("X-ADP-Authentication-Token", &creds.adp_token)
        .header("X-ADP-SW", APP_VERSION)
        .header("Accept-Language", "en-US")
        .header("Content-Type", content_type)
        .header("User-Agent", "Mozilla/5.0")
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| AdpError::Http(e.to_string()))?;

    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(AdpError::Http(format!(
            "HTTP {status} from {host}{path}: {}",
            &text.chars().take(300).collect::<String>()
        )));
    }
    Ok(text)
}

/// Upload the current reading position (last-read) to the sidecar so Amazon can
/// sync the furthest-page-read to the user's other devices. This is the write
/// direction, matching Kindle for PC's `POST /FionaCDEServiceEngine/sidecar`
/// with a `<last_read location=…>` annotation. The book's `guid` is read from a
/// fresh GET of the sidecar first (the server keys the record by it).
pub async fn upload_reading_position(
    creds: &Credentials,
    asin: &str,
    cde_type: &str,
    location: i64,
    acr: Option<&str>,
) -> Result<(), AdpError> {
    let ts = annotation_timestamp();
    let item = format!(
        "<last_read begin=\"{location}\" location=\"{location}\" timestamp=\"{ts}\"></last_read>"
    );
    upload_annotations(creds, asin, cde_type, &item, acr).await
}

/// The content id (`CR!…`) of a book file: which build of the book it is.
/// Amazon keeps positions per build and translates between them, so every
/// position we send or read must be tagged with the build we actually hold.
pub fn local_acr(bytes: &[u8]) -> Option<String> {
    let mut i = 0;
    while i + 3 < bytes.len() {
        if &bytes[i..i + 3] == b"CR!" {
            let mut j = i + 3;
            while j < bytes.len() && j - i < 48 && (bytes[j].is_ascii_uppercase() || bytes[j].is_ascii_digit()) {
                j += 1;
            }
            if j - i - 3 >= 20 {
                return Some(String::from_utf8_lossy(&bytes[i..j]).into_owned());
            }
        }
        i += 1;
    }
    None
}

/// `CR!<our build>:<book checksum>`: the server's guid with our build's id,
/// the form Kindle for PC sends for its own copy.
pub fn guid_for(acr: &str, server_guid: &str) -> String {
    match server_guid.split_once(':') {
        Some((_, sum)) => format!("{acr}:{sum}"),
        None => acr.to_string(),
    }
}

/// XML annotation timestamp: local-style format (no trailing Z), as Kindle does.
pub fn annotation_timestamp() -> String {
    Utc::now().format("%Y-%m-%dT%H:%M:%S").to_string()
}

/// Escape text for an XML element body or attribute.
pub fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// POST annotation items (`<last_read>`, `<highlight>`, `<note>`… as Kindle
/// for PC writes them) for one book to the sidecar.
pub async fn upload_annotations(
    creds: &Credentials,
    asin: &str,
    cde_type: &str,
    items: &str,
    acr: Option<&str>,
) -> Result<(), AdpError> {
    let key = sign::load_private_key(&creds.device_private_key)?;
    let ctype = if cde_type.is_empty() { "PDOC" } else { cde_type };

    // Fetch the current sidecar to obtain the book guid.
    let get_path = format!("/FionaCDEServiceEngine/sidecar?type={ctype}&key={asin}");
    let json = signed_get(&key, creds, CDE_HOST, &get_path).await?;
    let guid = serde_json::from_str::<serde_json::Value>(&json)
        .ok()
        .and_then(|v| v["payload"]["guid"].as_str().map(str::to_string))
        .ok_or_else(|| AdpError::Parse("no guid in sidecar response".into()))?;
    // Positions are in our copy's coordinates: say which build that is.
    let guid = acr.map(|a| guid_for(a, &guid)).unwrap_or(guid);

    let ts = annotation_timestamp();
    let body = format!(
        "<annotations timestamp=\"{ts}\" version=\"1.0\">\
<book guid=\"{guid}\" key=\"{asin}\" type=\"{ctype}\" version=\"0\" format=\"mobi8\">\
{items}</book></annotations>"
    );
    signed_post(
        &key,
        creds,
        CDE_HOST,
        "/FionaCDEServiceEngine/sidecar",
        &body,
        "application/x-octet-stream",
    )
    .await?;
    Ok(())
}

/// Download the raw content file for a book (e.g. a non-DRM MOBI/KF8 personal
/// document) via FSDownloadContent. Returns the raw bytes exactly as served.
pub async fn download_content(
    creds: &Credentials,
    asin: &str,
    cde_type: &str,
) -> Result<Vec<u8>, AdpError> {
    let key = sign::load_private_key(&creds.device_private_key)?;
    let ctype = if cde_type.is_empty() { "PDOC" } else { cde_type };
    let path = format!(
        "/FionaCDEServiceEngine/FSDownloadContent?type={ctype}&key={asin}&software_rev={APP_VERSION}"
    );
    signed_get_bytes(&key, creds, CDE_HOST, &path).await
}

/// Pull the whole library via syncMetaData (full sync — epoch last_sync_time).
pub async fn sync_library(creds: &Credentials) -> Result<Vec<Book>, AdpError> {
    let key = sign::load_private_key(&creds.device_private_key)?;
    // last_sync_time at epoch forces a full snapshot.
    let path = "/FionaTodoListProxy/syncMetaData?last_sync_time=1970-01-01T00:00:00%2B0000";
    let xml = signed_get(&key, creds, TODO_HOST, path).await?;
    parse_library(&xml)
}

/// Raw sidecar JSON for one book (highlights, notes, bookmarks, last read).
/// With `guid` (the version of the book file we hold, `CR!…:XXXXXXXX`),
/// Amazon reports positions translated to that version, as it does for
/// Kindle for PC; without it they are in the server's own version, which can
/// be a few bytes to whole paragraphs off for our copy.
pub async fn sidecar_json(
    creds: &Credentials,
    asin: &str,
    cde_type: &str,
    guid: Option<&str>,
) -> Result<String, AdpError> {
    let key = sign::load_private_key(&creds.device_private_key)?;
    let ctype = if cde_type.is_empty() { "PDOC" } else { cde_type };
    let mut path = format!("/FionaCDEServiceEngine/sidecar?type={ctype}&key={asin}");
    if let Some(g) = guid {
        path += &format!("&guid={}", g.replace('!', "%21").replace(':', "%3A"));
    }
    signed_get(&key, creds, CDE_HOST, &path).await
}

/// Fetch the reading state for one book from the sidecar.
pub async fn reading_state(creds: &Credentials, book: &Book) -> Result<ReadingState, AdpError> {
    let key = sign::load_private_key(&creds.device_private_key)?;
    let path = format!(
        "/FionaCDEServiceEngine/sidecar?type={}&key={}",
        book.cde_type, book.asin
    );
    let json = signed_get(&key, creds, CDE_HOST, &path).await?;
    Ok(parse_reading_state(&book.asin, &json))
}

/// Parse a syncMetaData XML response into books. Lenient: walks every
/// `meta_data` node and reads the fields it finds.
pub fn parse_library(xml: &str) -> Result<Vec<Book>, AdpError> {
    let doc = roxmltree::Document::parse(xml).map_err(|e| AdpError::Parse(e.to_string()))?;
    let mut books = Vec::new();
    for md in doc
        .descendants()
        .filter(|n| n.has_tag_name("meta_data"))
    {
        let child_text = |tag: &str| {
            md.children()
                .find(|c| c.has_tag_name(tag))
                .and_then(|c| c.text())
                .unwrap_or("")
                .trim()
                .to_string()
        };
        let asin = child_text("ASIN");
        if asin.is_empty() {
            continue;
        }
        // authors/author may be multiple
        let author = md
            .children()
            .find(|c| c.has_tag_name("authors"))
            .map(|authors| {
                authors
                    .children()
                    .filter(|c| c.has_tag_name("author"))
                    .filter_map(|c| c.text())
                    .map(|s| s.trim())
                    .filter(|s| !s.is_empty())
                    .collect::<Vec<_>>()
                    .join(", ")
            })
            .unwrap_or_default();

        books.push(Book {
            asin,
            title: child_text("title"),
            author,
            cde_type: child_text("cde_contenttype"),
            content_type: child_text("content_type"),
            purchase_date: child_text("purchase_date"),
        });
    }
    Ok(books)
}

/// Parse a sidecar JSON response into a reading state.
///
/// Confirmed shape (real response, 17/11/2026):
/// ```json
/// {"payload":{"records":[
///    {"type":"kindle.lpr","location":"263113",...},            // furthest page read
///    {"type":"kindle.most_recent_read","location":"253247",...},
///    {"type":"kindle.highlight","startPosition":...,"endPosition":...},
///    {"type":"kindle.note","text":"...",...}
/// ]}}
/// ```
/// `position` is the furthest-page-read location (what Kindle's % reflects),
/// falling back to the most-recent-read location. The percentage needs the
/// book's total length (from the MOBI header), so it is computed by the caller
/// via [`mobi_total_positions`]; here `percent` stays `None`.
pub fn parse_reading_state(asin: &str, json: &str) -> ReadingState {
    let mut state = ReadingState {
        asin: asin.to_string(),
        ..Default::default()
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(json) else {
        return state;
    };
    let Some(records) = v
        .get("payload")
        .and_then(|p| p.get("records"))
        .and_then(|r| r.as_array())
    else {
        return state;
    };

    let location_of = |ty: &str| -> Option<i64> {
        records
            .iter()
            .find(|r| r.get("type").and_then(|t| t.as_str()) == Some(ty))
            .and_then(|r| r.get("location"))
            .and_then(parse_num)
    };

    state.position =
        location_of("kindle.lpr").or_else(|| location_of("kindle.most_recent_read"));
    state
}

/// Parse a JSON value that may be a number or a numeric string into an i64.
fn parse_num(v: &serde_json::Value) -> Option<i64> {
    match v {
        serde_json::Value::Number(n) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)),
        serde_json::Value::String(s) => s
            .trim()
            .parse::<i64>()
            .ok()
            .or_else(|| s.trim().parse::<f64>().ok().map(|f| f as i64)),
        _ => None,
    }
}

/// Read the total content length (PalmDOC `textLength`) from a MOBI/KF8 file.
/// This is the denominator Kindle uses for reading-progress percentages:
/// `percent = lpr_location / mobi_total_positions`.
pub fn mobi_total_positions(data: &[u8]) -> Option<i64> {
    // PDB type/creator "BOOKMOBI" lives at offset 60.
    if data.len() < 82 || &data[60..68] != b"BOOKMOBI" {
        return None;
    }
    let n_records = u16::from_be_bytes([data[76], data[77]]);
    if n_records < 1 {
        return None;
    }
    // First record-info entry (offset 78) holds record 0's file offset.
    let rec0 = u32::from_be_bytes([data[78], data[79], data[80], data[81]]) as usize;
    // PalmDOC header: textLength is a big-endian u32 at offset 4 of record 0.
    let field = rec0.checked_add(8)?;
    if data.len() < field {
        return None;
    }
    let textlen = u32::from_be_bytes([
        data[rec0 + 4],
        data[rec0 + 5],
        data[rec0 + 6],
        data[rec0 + 7],
    ]) as i64;
    (textlen > 0).then_some(textlen)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_library_xml() {
        let xml = r#"
        <response>
          <sync_time>2026-11-16T00:00:00+0000</sync_time>
          <add_update_list>
            <meta_data>
              <ASIN>B00TEST001</ASIN>
              <title pronunciation="">The English Patient</title>
              <authors><author>Michael Ondaatje</author></authors>
              <cde_contenttype>EBOK</cde_contenttype>
              <content_type>application/x-mobipocket-ebook</content_type>
              <purchase_date>2020-05-01T00:00:00+0000</purchase_date>
            </meta_data>
            <meta_data>
              <ASIN>PDOC123</ASIN>
              <title>My Document</title>
              <authors><author>A</author><author>B</author></authors>
              <cde_contenttype>PDOC</cde_contenttype>
            </meta_data>
          </add_update_list>
        </response>"#;
        let books = parse_library(xml).unwrap();
        assert_eq!(books.len(), 2);
        assert_eq!(books[0].asin, "B00TEST001");
        assert_eq!(books[0].title, "The English Patient");
        assert_eq!(books[0].author, "Michael Ondaatje");
        assert_eq!(books[0].cde_type, "EBOK");
        assert_eq!(books[1].cde_type, "PDOC");
        assert_eq!(books[1].author, "A, B");
    }

    #[test]
    fn reading_state_reads_lpr_location() {
        // Real shape: payload.records with a kindle.lpr furthest-page-read.
        let json = r#"{"payload":{"records":[
            {"type":"kindle.most_recent_read","location":"253247"},
            {"type":"kindle.highlight","startPosition":"100","endPosition":"120"},
            {"type":"kindle.lpr","location":"263113"}
        ]}}"#;
        let st = parse_reading_state("X", json);
        assert_eq!(st.position, Some(263113)); // furthest, not most-recent
        assert_eq!(st.percent, None); // computed by caller with the book total
    }

    #[test]
    fn reading_state_falls_back_to_most_recent() {
        let json = r#"{"payload":{"records":[
            {"type":"kindle.most_recent_read","location":"4096"}
        ]}}"#;
        let st = parse_reading_state("X", json);
        assert_eq!(st.position, Some(4096));
    }

    #[test]
    fn reading_state_survives_garbage() {
        assert_eq!(parse_reading_state("X", "not json").position, None);
        assert_eq!(parse_reading_state("X", r#"{"payload":{}}"#).position, None);
    }

    #[test]
    fn mobi_total_from_header() {
        // Minimal PDB: 32-byte name, header to offset 78, one record-info entry,
        // then record 0 with a PalmDOC header whose textLength = 1261053.
        let mut d = vec![0u8; 78 + 8];
        d[60..68].copy_from_slice(b"BOOKMOBI");
        d[76..78].copy_from_slice(&1u16.to_be_bytes()); // record count
        let rec0_off: u32 = 86;
        d[78..82].copy_from_slice(&rec0_off.to_be_bytes());
        d.resize(rec0_off as usize + 16, 0);
        d[rec0_off as usize + 4..rec0_off as usize + 8]
            .copy_from_slice(&1_261_053u32.to_be_bytes());
        assert_eq!(mobi_total_positions(&d), Some(1_261_053));
        assert_eq!(mobi_total_positions(b"not a mobi file at all......"), None);
    }
}

