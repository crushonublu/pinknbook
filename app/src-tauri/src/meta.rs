//! Book metadata for the library UI: what the MOBI/KF8 file itself says
//! (EXTH records + the embedded cover image), a cleaned-up display title and
//! author, and a spine colour taken from the cover.
//!
//! PDOCs (personal documents) arrive from Amazon with poor metadata: titles
//! carrying " - Author" suffixes, HTML entities, and the account's e-mail as
//! the author. The file usually knows better, and when it does not we apply
//! a few conservative heuristics. Users can still override everything.

use std::collections::HashMap;

use unicode_normalization::UnicodeNormalization;

/// Metadata read from a MOBI/KF8 file.
#[derive(Debug, Default, Clone)]
pub struct FileMeta {
    pub title: Option<String>,
    pub author: Option<String>,
    pub publisher: Option<String>,
    pub description: Option<String>,
    pub subjects: Vec<String>,
    pub language: Option<String>,
    /// Raw bytes of the embedded cover image (usually JPEG).
    pub cover: Option<Vec<u8>>,
    /// ISBN-10/13 (EXTH 104), digits and X only.
    pub isbn: Option<String>,
    /// An Amazon ASIN written into the file (EXTH 113 / 504), if it looks like one.
    pub asin: Option<String>,
}

fn be_u16(d: &[u8], o: usize) -> Option<u16> {
    Some(u16::from_be_bytes(d.get(o..o + 2)?.try_into().ok()?))
}
fn be_u32(d: &[u8], o: usize) -> Option<u32> {
    Some(u32::from_be_bytes(d.get(o..o + 4)?.try_into().ok()?))
}

/// Byte range of PDB record `i`.
fn record<'a>(data: &'a [u8], offsets: &[usize], i: usize) -> Option<&'a [u8]> {
    let start = *offsets.get(i)?;
    let end = offsets.get(i + 1).copied().unwrap_or(data.len());
    data.get(start..end.max(start))
}

fn decode(bytes: &[u8], utf8: bool) -> String {
    if utf8 {
        String::from_utf8_lossy(bytes).into_owned()
    } else {
        // CP1252 ≈ Latin-1 for everything we care about.
        bytes.iter().map(|&b| b as char).collect()
    }
}

/// Parse EXTH metadata and the cover image out of a MOBI/KF8 (.azw3) file.
pub fn parse_mobi(data: &[u8]) -> Option<FileMeta> {
    if data.get(60..68)? != b"BOOKMOBI" {
        return None;
    }
    let n = be_u16(data, 76)? as usize;
    let offsets: Vec<usize> = (0..n)
        .map(|i| be_u32(data, 78 + i * 8).map(|v| v as usize))
        .collect::<Option<_>>()?;
    let r0 = record(data, &offsets, 0)?;
    if r0.get(16..20)? != b"MOBI" {
        return None;
    }
    let header_len = be_u32(r0, 20)? as usize;
    let utf8 = be_u32(r0, 28)? == 65001;
    let first_image = be_u32(r0, 0x6C)? as usize;
    let has_exth = be_u32(r0, 0x80)? & 0x40 != 0;

    let mut meta = FileMeta::default();
    let mut exth: HashMap<u32, Vec<&[u8]>> = HashMap::new();
    if has_exth {
        let e = 16 + header_len;
        if r0.get(e..e + 4)? == b"EXTH" {
            let count = be_u32(r0, e + 8)?;
            let mut p = e + 12;
            for _ in 0..count {
                let t = be_u32(r0, p)?;
                let len = be_u32(r0, p + 4)? as usize;
                if len < 8 {
                    break;
                }
                exth.entry(t).or_default().push(r0.get(p + 8..p + len)?);
                p += len;
            }
        }
    }
    let text = |t: u32| -> Option<String> {
        let s = decode(exth.get(&t)?.first()?, utf8);
        let s = s.trim().to_string();
        (!s.is_empty()).then_some(s)
    };
    meta.title = text(503);
    meta.author = exth.get(&100).map(|v| {
        v.iter()
            .map(|b| decode(b, utf8).trim().to_string())
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(" & ")
    }).filter(|s| !s.is_empty());
    meta.publisher = text(101);
    meta.description = text(103).map(|d| strip_html(&d));
    meta.language = text(524);
    meta.isbn = text(104)
        .map(|s| s.chars().filter(|c| c.is_ascii_digit() || *c == 'X' || *c == 'x').collect::<String>().to_ascii_uppercase())
        .filter(|s| s.len() == 10 || s.len() == 13);
    meta.asin = text(113)
        .or_else(|| text(504))
        .filter(|s| s.len() == 10 && s.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit()));
    meta.subjects = exth
        .get(&105)
        .map(|v| {
            v.iter()
                .flat_map(|b| decode(b, utf8).split(';').map(|s| s.trim().to_string()).collect::<Vec<_>>())
                .map(|s| s.trim_start_matches(|c: char| !c.is_alphanumeric()).nfc().collect::<String>())
                // Drop tool-generated tags such as "Lang:vi".
                .filter(|s| !s.is_empty() && !s.to_ascii_lowercase().starts_with("lang:"))
                .collect()
        })
        .unwrap_or_default();

    // Cover: EXTH 201 is an index relative to the first image record; fall back
    // to the thumbnail (202) and then to the first image.
    let image_at = |rel: Option<u32>| -> Option<Vec<u8>> {
        let idx = first_image.checked_add(rel? as usize)?;
        let rec = record(data, &offsets, idx)?;
        is_image(rec).then(|| rec.to_vec())
    };
    let rel = |t: u32| exth.get(&t).and_then(|v| v.first()).and_then(|b| be_u32(b, 0));
    meta.cover = image_at(rel(201))
        .or_else(|| image_at(rel(202)))
        .or_else(|| (first_image > 0 && first_image < n).then(|| image_at(Some(0))).flatten());
    Some(meta)
}

fn is_image(b: &[u8]) -> bool {
    b.starts_with(&[0xFF, 0xD8, 0xFF]) || b.starts_with(b"\x89PNG") || b.starts_with(b"GIF8")
}

pub fn image_ext(b: &[u8]) -> &'static str {
    if b.starts_with(b"\x89PNG") {
        "png"
    } else if b.starts_with(b"GIF8") {
        "gif"
    } else {
        "jpg"
    }
}

/// Very small HTML → text for EXTH descriptions.
pub fn strip_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    let mut tag = String::new();
    for c in s.chars() {
        match c {
            '<' => {
                in_tag = true;
                tag.clear();
            }
            '>' if in_tag => {
                in_tag = false;
                let t = tag.trim_start_matches('/').to_ascii_lowercase();
                if t.starts_with('p') || t.starts_with("br") || t.starts_with("div") {
                    out.push('\n');
                }
            }
            _ if in_tag => tag.push(c),
            _ => out.push(c),
        }
    }
    let text = unescape_html(&out);
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// Decode the HTML entities that show up in Amazon titles.
pub fn unescape_html(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        let end = rest.find(';').filter(|&e| e <= 10);
        let decoded = end.and_then(|e| {
            let ent = &rest[1..e];
            let ch = match ent {
                "amp" => Some('&'),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" | "#39" => Some('\''),
                "nbsp" => Some(' '),
                _ if ent.starts_with("#x") || ent.starts_with("#X") => {
                    u32::from_str_radix(&ent[2..], 16).ok().and_then(char::from_u32)
                }
                _ if ent.starts_with('#') => ent[1..].parse().ok().and_then(char::from_u32),
                _ => None,
            };
            ch.map(|c| (c, e))
        });
        match decoded {
            Some((c, e)) => {
                out.push(c);
                rest = &rest[e + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

// ───────────────────────── title / author cleanup ─────────────────────────

/// Lower-case, strip Vietnamese/Latin diacritics and punctuation, for fuzzy
/// comparisons only.
fn fold(s: &str) -> String {
    s.chars()
        .filter_map(|c| {
            let c = match c {
                'à'..='å' | 'ā' | 'ă' | 'ą' | 'ạ' | 'ả' | 'ấ' | 'ầ' | 'ẩ' | 'ẫ' | 'ậ' | 'ắ' | 'ằ' | 'ẳ' | 'ẵ' | 'ặ' => 'a',
                'À'..='Å' | 'Ā' | 'Ă' | 'Ą' | 'Ạ' | 'Ả' | 'Ấ' | 'Ầ' | 'Ẩ' | 'Ẫ' | 'Ậ' | 'Ắ' | 'Ằ' | 'Ẳ' | 'Ẵ' | 'Ặ' => 'a',
                'è'..='ë' | 'ẹ' | 'ẻ' | 'ẽ' | 'ế' | 'ề' | 'ể' | 'ễ' | 'ệ' | 'È'..='Ë' | 'Ẹ' | 'Ẻ' | 'Ẽ' | 'Ế' | 'Ề' | 'Ể' | 'Ễ' | 'Ệ' => 'e',
                'ì'..='ï' | 'ĩ' | 'ỉ' | 'ị' | 'Ì'..='Ï' | 'Ĩ' | 'Ỉ' | 'Ị' => 'i',
                'ò'..='ö' | 'ø' | 'ơ' | 'ọ' | 'ỏ' | 'ố' | 'ồ' | 'ổ' | 'ỗ' | 'ộ' | 'ớ' | 'ờ' | 'ở' | 'ỡ' | 'ợ' => 'o',
                'Ò'..='Ö' | 'Ø' | 'Ơ' | 'Ọ' | 'Ỏ' | 'Ố' | 'Ồ' | 'Ổ' | 'Ỗ' | 'Ộ' | 'Ớ' | 'Ờ' | 'Ở' | 'Ỡ' | 'Ợ' => 'o',
                'ù'..='ü' | 'ũ' | 'ư' | 'ụ' | 'ủ' | 'ứ' | 'ừ' | 'ử' | 'ữ' | 'ự' | 'Ù'..='Ü' | 'Ũ' | 'Ư' | 'Ụ' | 'Ủ' | 'Ứ' | 'Ừ' | 'Ử' | 'Ữ' | 'Ự' => 'u',
                'ý' | 'ỳ' | 'ỷ' | 'ỹ' | 'ỵ' | 'Ý' | 'Ỳ' | 'Ỷ' | 'Ỹ' | 'Ỵ' => 'y',
                'đ' | 'Đ' => 'd',
                c => c,
            };
            if c.is_alphanumeric() {
                Some(c.to_ascii_lowercase())
            } else if c.is_whitespace() {
                Some(' ')
            } else {
                None
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Authors that are really "unknown": empty, "Unknown", or an e-mail /
/// account handle (PDOCs sent by e-mail get the sender's address).
pub fn is_bogus_author(a: &str) -> bool {
    let a = a.trim();
    if a.is_empty() {
        return true;
    }
    let l = a.to_lowercase();
    if matches!(l.as_str(), "unknown" | "unknown author" | "không rõ" | "n/a") {
        return true;
    }
    if a.contains('@') {
        return true;
    }
    // "doanduchieu.pw": one token, lower-case, with a dot, no letters beyond ASCII.
    !a.contains(char::is_whitespace) && a.contains('.') && a == l && a.is_ascii()
}

/// Split "Title - Author" at the last dash separator.
fn split_suffix(title: &str) -> Option<(String, String)> {
    let seps = [" - ", " – ", " — ", "- ", " -"];
    let (i, sep) = seps
        .iter()
        .filter_map(|s| title.rfind(s).map(|i| (i, *s)))
        .max_by_key(|(i, _)| *i)?;
    let left = title[..i].trim().trim_end_matches(['-', '–', '—']).trim();
    let right = title[i + sep.len()..].trim();
    (!left.is_empty() && !right.is_empty()).then(|| (left.to_string(), right.to_string()))
}

/// ALL-CAPS titles (often from file names) become Title Case.
fn tame_caps(s: &str) -> String {
    let letters: Vec<char> = s.chars().filter(|c| c.is_alphabetic()).collect();
    if letters.len() < 4 || letters.iter().any(|c| c.is_lowercase()) {
        return s.to_string();
    }
    s.split(' ')
        .map(|w| {
            let mut cs = w.chars();
            match cs.next() {
                Some(f) => f.to_uppercase().collect::<String>() + &cs.as_str().to_lowercase(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn diacritics(s: &str) -> usize {
    s.chars().filter(|c| !c.is_ascii() && c.is_alphabetic()).count()
}

/// Best display title and author from Amazon's library data and the file's
/// own metadata. Returns (title, author); author may be empty if unknown.
pub fn clean_title_author(
    lib_title: &str,
    lib_author: &str,
    file_title: Option<&str>,
    file_author: Option<&str>,
) -> (String, String) {
    // Amazon sometimes sends decomposed Vietnamese (base letter + combining
    // marks); compose to NFC so fonts and search behave.
    let nfc = |s: &str| unescape_html(s.trim()).nfc().collect::<String>();
    let lib_title = nfc(lib_title);
    // Prefer the file's title when it carries more diacritics (the library
    // title is sometimes an ASCII-folded file name).
    let mut title = match file_title.map(nfc) {
        Some(ft) if !ft.is_empty() && diacritics(&ft) > diacritics(&lib_title) => ft,
        _ => lib_title,
    };

    let mut author = [Some(lib_author), file_author]
        .into_iter()
        .flatten()
        .map(nfc)
        .find(|a| !is_bogus_author(a))
        .unwrap_or_default();

    if let Some((left, right)) = split_suffix(&title) {
        let (fr, fa) = (fold(&right), fold(&author));
        if author.is_empty() {
            // "Title - Author" with no usable author: take it from the title,
            // unless the suffix looks like a subtitle (lots of words).
            if right.split_whitespace().count() <= 8 {
                author = right;
                title = left;
            }
        } else if !fr.is_empty() && (fa.contains(&fr) || fr.contains(&fa)) {
            // The suffix repeats the author → drop it from the title.
            title = left;
        }
    }
    (tame_caps(&title), author)
}

// ───────────────────────── spine colour ─────────────────────────

/// A book-spine colour from the cover: the most common saturated tone,
/// darkened enough to carry light text. `None` if the image can't be decoded.
pub fn spine_color(cover: &[u8]) -> Option<String> {
    let img = image::load_from_memory(cover).ok()?;
    let small = img.thumbnail(48, 72).to_rgb8();
    // 4-bit-per-channel histogram, weighted toward saturated, mid-tone pixels.
    let mut buckets: HashMap<u16, (f64, [f64; 3])> = HashMap::new();
    for p in small.pixels() {
        let [r, g, b] = p.0;
        let (rf, gf, bf) = (r as f64 / 255.0, g as f64 / 255.0, b as f64 / 255.0);
        let max = rf.max(gf).max(bf);
        let min = rf.min(gf).min(bf);
        let sat = if max > 0.0 { (max - min) / max } else { 0.0 };
        // Saturated mid-tones dominate; near-greys count a little so a truly
        // monochrome cover still gets its own tone.
        let weight = 0.04 + 4.0 * sat * sat * (1.0 - (max - 0.55).abs());
        let key = ((r as u16 >> 4) << 8) | ((g as u16 >> 4) << 4) | (b as u16 >> 4);
        let e = buckets.entry(key).or_insert((0.0, [0.0; 3]));
        e.0 += weight;
        e.1[0] += rf * weight;
        e.1[1] += gf * weight;
        e.1[2] += bf * weight;
    }
    let (w, sum) = buckets.values().max_by(|a, b| a.0.total_cmp(&b.0))?;
    let mut c = [sum[0] / w, sum[1] / w, sum[2] / w];
    // Keep it dark enough for white spine text (relative luminance ≤ ~0.28).
    let lum = |c: &[f64; 3]| 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    while lum(&c) > 0.28 {
        c = c.map(|v| v * 0.88);
    }
    // …but not pitch black: very dark covers get a deep, slightly lifted tone.
    while lum(&c) < 0.025 {
        c = c.map(|v| (v * 1.25 + 0.012).min(1.0));
    }
    Some(format!(
        "#{:02x}{:02x}{:02x}",
        (c[0] * 255.0).round() as u8,
        (c[1] * 255.0).round() as u8,
        (c[2] * 255.0).round() as u8
    ))
}

/// Deterministic fallback spine colour (a muted, bookish palette).
pub fn fallback_spine(asin: &str) -> String {
    const PALETTE: [&str; 10] = [
        "#7a2e2e", "#2f4f6f", "#3d5a40", "#6b4f2a", "#4a3a64", "#7a5230", "#2e5e5e", "#5c2f4a", "#44505c", "#6a6a2e",
    ];
    let h = asin.bytes().fold(7u32, |h, b| h.wrapping_mul(31).wrapping_add(b as u32));
    PALETTE[(h as usize) % PALETTE.len()].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c(t: &str, a: &str) -> (String, String) {
        clean_title_author(t, a, None, None)
    }

    #[test]
    fn cleans_titles() {
        assert_eq!(c("Máu Bẩn - John Carreyrou", "doanduchieu.pw"), ("Máu Bẩn".into(), "John Carreyrou".into()));
        assert_eq!(c("Suoi Nguon - Ayn Rand", "Ayn Rand"), ("Suoi Nguon".into(), "Ayn Rand".into()));
        assert_eq!(
            c("Đinh Trang Mộng - Diêm Liên Khoa &amp; Minh Thương", "doanduchieu.pw"),
            ("Đinh Trang Mộng".into(), "Diêm Liên Khoa & Minh Thương".into())
        );
        assert_eq!(
            c("Anh em Nha Karamazov - Fyodor Mikhailovich Dostoevsky", "Unknown"),
            ("Anh em Nha Karamazov".into(), "Fyodor Mikhailovich Dostoevsky".into())
        );
        assert_eq!(c("CHUM NHO PHAN NO - John Steinbeck", "John Steinbeck"), ("Chum Nho Phan No".into(), "John Steinbeck".into()));
        assert_eq!(
            c("Đội Lốt Da Vàng - R.F. Kuang", "R.F. Kuang & Lam Vũ (dịch)"),
            ("Đội Lốt Da Vàng".into(), "R.F. Kuang & Lam Vũ (dịch)".into())
        );
        assert_eq!(
            c("Vật Lý Thiên Văn Cho Người Vội Vã- Neil DeGrasse Tyson", "Unknown"),
            ("Vật Lý Thiên Văn Cho Người Vội Vã".into(), "Neil DeGrasse Tyson".into())
        );
        // A subtitle that is not the author stays.
        assert_eq!(
            c("Suối Nguồn - The Fountainhead", "Ayn Rand"),
            ("Suối Nguồn - The Fountainhead".into(), "Ayn Rand".into())
        );
        assert_eq!(c("Mật mã Da Vinci", "someone@gmail.com"), ("Mật mã Da Vinci".into(), "".into()));
    }

    #[test]
    fn prefers_file_title_with_diacritics() {
        let (t, _) = clean_title_author("Bup Sen Xanh - Son Tung", "Sơn Tùng", Some("Búp Sen Xanh"), None);
        assert_eq!(t, "Búp Sen Xanh");
    }

    /// Reads real downloaded books: `PINKNBOOK_BOOKS=<dir> cargo test -- --ignored meta`
    #[test]
    #[ignore]
    fn parses_real_books() {
        let dir = std::env::var("PINKNBOOK_BOOKS").expect("set PINKNBOOK_BOOKS");
        for e in std::fs::read_dir(dir).unwrap().flatten() {
            let data = std::fs::read(e.path()).unwrap();
            let m = parse_mobi(&data).expect("MOBI");
            let cover = m.cover.as_deref().expect("cover");
            println!(
                "{:?} | {:?} | {:?} | {:?} | cover {} B | spine {:?}",
                m.title,
                m.author,
                m.subjects,
                m.language,
                cover.len(),
                spine_color(cover)
            );
        }
    }

    #[test]
    fn unescapes() {
        assert_eq!(unescape_html("A &amp; B &#39;x&#39; &#x41;"), "A & B 'x' A");
        assert_eq!(unescape_html("Tom & Jerry"), "Tom & Jerry");
    }
}
