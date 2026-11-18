//! Secret storage via the OS keyring (Windows Credential Manager).
//!
//! Windows caps one credential secret at 2560 *bytes* — i.e. ~1280 UTF-16 chars.
//! The device_private_key PEM (~1700 chars) and adp_token (~1521 chars) each
//! exceed that on their own, so every secret is stored in ≤1000-char chunks
//! across entries (`<name>.0`, `<name>.1`, …). Chunk counts + the small ids live
//! in a tiny "meta" entry. Each entry is still DPAPI-protected per user; nothing
//! secret is written to SQLite or disk.

use crate::adp::register::Credentials;

const SERVICE: &str = "pinknbook";
const META_ENTRY: &str = "adp-meta";
const KEY_NAME: &str = "adp-device-key";
const TOKEN_NAME: &str = "adp-token";
const CHUNK: usize = 1000; // UTF-16 = 2000 bytes < 2560-byte limit

#[derive(serde::Serialize, serde::Deserialize)]
struct Meta {
    directed_id: String,
    device_serial: String,
    device_type: String,
    device_name: String,
    key_chunks: usize,
    token_chunks: usize,
}

fn entry(account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, account).map_err(|e| e.to_string())
}

fn set_chunked(name: &str, value: &str) -> Result<usize, String> {
    let chars: Vec<char> = value.chars().collect();
    let n = chars.len().div_ceil(CHUNK).max(1);
    for i in 0..n {
        let start = i * CHUNK;
        let end = ((i + 1) * CHUNK).min(chars.len());
        let part: String = chars.get(start..end).unwrap_or(&[]).iter().collect();
        entry(&format!("{name}.{i}"))?
            .set_password(&part)
            .map_err(|e| e.to_string())?;
    }
    Ok(n)
}

fn get_chunked(name: &str, n: usize) -> Result<String, String> {
    let mut s = String::new();
    for i in 0..n {
        s.push_str(&entry(&format!("{name}.{i}"))?.get_password().map_err(|e| e.to_string())?);
    }
    Ok(s)
}

fn delete_chunks(name: &str, n: usize) -> Result<(), String> {
    for i in 0..n {
        match entry(&format!("{name}.{i}"))?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(())
}

pub fn save(creds: &Credentials) -> Result<(), String> {
    let key_chunks = set_chunked(KEY_NAME, &creds.device_private_key)?;
    let token_chunks = set_chunked(TOKEN_NAME, &creds.adp_token)?;
    let meta = Meta {
        directed_id: creds.directed_id.clone(),
        device_serial: creds.device_serial.clone(),
        device_type: creds.device_type.clone(),
        device_name: creds.device_name.clone(),
        key_chunks,
        token_chunks,
    };
    let meta_json = serde_json::to_string(&meta).map_err(|e| e.to_string())?;
    entry(META_ENTRY)?
        .set_password(&meta_json)
        .map_err(|e| e.to_string())
}

pub fn load() -> Result<Option<Credentials>, String> {
    let meta_json = match entry(META_ENTRY)?.get_password() {
        Ok(m) => m,
        Err(keyring::Error::NoEntry) => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    let meta: Meta = serde_json::from_str(&meta_json).map_err(|e| e.to_string())?;
    Ok(Some(Credentials {
        device_private_key: get_chunked(KEY_NAME, meta.key_chunks)?,
        adp_token: get_chunked(TOKEN_NAME, meta.token_chunks)?,
        directed_id: meta.directed_id,
        device_serial: meta.device_serial,
        device_type: meta.device_type,
        device_name: meta.device_name,
    }))
}

pub fn clear() -> Result<(), String> {
    // Use recorded chunk counts when available; otherwise clear a safe range.
    let (kc, tc) = match entry(META_ENTRY)?.get_password() {
        Ok(m) => serde_json::from_str::<Meta>(&m)
            .map(|meta| (meta.key_chunks, meta.token_chunks))
            .unwrap_or((8, 8)),
        Err(_) => (8, 8),
    };
    delete_chunks(KEY_NAME, kc)?;
    delete_chunks(TOKEN_NAME, tc)?;
    match entry(META_ENTRY)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
