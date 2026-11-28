//! Secret storage via the OS keyring (Windows Credential Manager).
//!
//! Windows caps one credential secret at 2560 *bytes* — i.e. ~1280 UTF-16 chars.
//! The device_private_key PEM (~1700 chars) and adp_token (~1521 chars) each
//! exceed that on their own, so every secret is stored in ≤1000-char chunks
//! across entries (`<name>.0`, `<name>.1`, …). Chunk counts + the small ids live
//! in a tiny "meta" entry. Each entry is still DPAPI-protected per user; nothing
//! secret is written to SQLite or disk.

#[cfg(not(target_os = "android"))]
mod desktop {
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

/// One small secret in a single entry (e.g. an AI API key).
pub fn secret_get(name: &str) -> Result<Option<String>, String> {
    match entry(name)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

pub fn secret_put(name: &str, value: &str) -> Result<(), String> {
    entry(name)?.set_password(value).map_err(|e| e.to_string())
}

pub fn secret_remove(name: &str) -> Result<(), String> {
    match entry(name)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

}
#[cfg(not(target_os = "android"))]
pub use desktop::{secret_get, secret_put, secret_remove};
#[cfg(not(target_os = "android"))]
use desktop as store;

#[cfg(target_os = "android")]
mod android {
    use crate::adp::register::Credentials;
    use jni::{objects::{JClass, JObject, JString, JValue}, JavaVM};

    fn store(method: &str, key: &str, value: Option<&str>) -> Result<Option<String>, String> {
        let result = (|| -> jni::errors::Result<Option<String>> {
            let ctx = ndk_context::android_context();
            // The context is owned by Android and remains valid for the app lifetime.
            let vm = unsafe { JavaVM::from_raw(ctx.vm().cast()) }?;
            let mut env = vm.attach_current_thread()?;
            let context = unsafe { JObject::from_raw(ctx.context().cast()) };
            let result = env.with_local_frame(16, |env| -> jni::errors::Result<Option<String>> {
                let loader = env.call_method(&context, "getClassLoader", "()Ljava/lang/ClassLoader;", &[])?.l()?;
                let name = env.new_string("com.pinknbook.app.SecureStore")?;
                let class = env.call_method(loader, "loadClass", "(Ljava/lang/String;)Ljava/lang/Class;", &[JValue::Object(&name)])?.l()?;
                let class = JClass::from(class);
                let name = env.new_string(key)?;
                let mut args = vec![JValue::Object(&context), JValue::Object(&name)];
                let data;
                let signature = if let Some(value) = value {
                    data = env.new_string(value)?;
                    args.push(JValue::Object(&data));
                    "(Landroid/content/Context;Ljava/lang/String;Ljava/lang/String;)V"
                } else if method == "get" {
                    "(Landroid/content/Context;Ljava/lang/String;)Ljava/lang/String;"
                } else {
                    "(Landroid/content/Context;Ljava/lang/String;)V"
                };
                let result = env.call_static_method(class, method, signature, &args)?;
                if method == "get" {
                    let object = result.l()?;
                    if object.is_null() { Ok(None) }
                    else { Ok(Some(env.get_string(&JString::from(object))?.into())) }
                } else { Ok(None) }
            });
            // Never describe Java exceptions: they may contain secret values.
            if env.exception_check().unwrap_or(false) { let _ = env.exception_clear(); }
            result
        })();
        result.map_err(|_| "Android secure storage failed".to_string())
    }
    pub fn save(creds: &Credentials) -> Result<(), String> {
        let json = serde_json::to_string(creds).map_err(|_| "Could not encode credentials")?;
        secret_put("amazon-credentials", &json)
    }
    pub fn load() -> Result<Option<Credentials>, String> {
        secret_get("amazon-credentials")?.map(|json| serde_json::from_str(&json)
            .map_err(|_| "Could not decode stored credentials".to_string())).transpose()
    }
    pub fn clear() -> Result<(), String> { secret_remove("amazon-credentials") }

    pub fn secret_get(name: &str) -> Result<Option<String>, String> { store("get", name, None) }
    pub fn secret_put(name: &str, value: &str) -> Result<(), String> { store("put", name, Some(value)).map(|_| ()) }
    pub fn secret_remove(name: &str) -> Result<(), String> { store("remove", name, None).map(|_| ()) }
}
#[cfg(target_os = "android")]
pub use android::{secret_get, secret_put, secret_remove};
#[cfg(target_os = "android")]
use android as store;

// ---- Signed out, device kept ---------------------------------------------------
//
// Signing out used to drop the device's keys, so every later sign-in registered
// one more device on the Amazon account. Now signing out can keep them, marked
// "parked": the app is signed out (`load` sees nothing), and signing in again
// on this computer or phone brings the same device back without a new
// registration. `clear` forgets them for good.

use crate::adp::register::Credentials;

const PARKED: &str = "adp-parked";

fn is_parked() -> Result<bool, String> {
    Ok(secret_get(PARKED)?.as_deref() == Some("1"))
}

/// Store a fresh registration (it replaces any kept device).
pub fn save(creds: &Credentials) -> Result<(), String> {
    store::save(creds)?;
    secret_remove(PARKED)
}

/// The signed-in device, if any (a kept, signed-out one does not count).
pub fn load() -> Result<Option<Credentials>, String> {
    if is_parked()? {
        return Ok(None);
    }
    store::load()
}

/// Sign out but keep this device's keys, to sign in again without registering anew.
pub fn park() -> Result<(), String> {
    if store::load()?.is_some() {
        secret_put(PARKED, "1")?;
    }
    Ok(())
}

/// The device kept at sign-out, if any.
pub fn parked() -> Result<Option<Credentials>, String> {
    if !is_parked()? {
        return Ok(None);
    }
    store::load()
}

/// Sign in again with the kept device.
pub fn unpark() -> Result<Option<Credentials>, String> {
    let c = parked()?;
    if c.is_some() {
        secret_remove(PARKED)?;
    }
    Ok(c)
}

/// Forget this device's keys entirely.
pub fn clear() -> Result<(), String> {
    store::clear()?;
    secret_remove(PARKED)
}
