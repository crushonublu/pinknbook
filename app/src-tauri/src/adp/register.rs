//! Device registration — OAuth2 PKCE → `POST /auth/register`.
//! Ported from the Python spike (live-tested, returns a fresh
//! `device_private_key` + `adp_token` bundle).
//!
//! Critical `client_id` detail (the original blocker):
//!   authorize `openid.oa2.client_id` = "device:" + hex(serial "#" device_type)
//!   register  `auth_data.client_id`  =            hex(serial "#" device_type)   (no "device:")

// The sign-in flow only runs on desktop for now (see commands::login).
#![cfg_attr(mobile, allow(dead_code))]

use base64::Engine;
use rand::Rng;
use sha2::{Digest, Sha256};

use super::AdpError;

pub const MARKETPLACE: &str = "ATVPDKIKX0DER"; // US
pub const ASSOC: &str = "amzn_mazama_desktop_us"; // Kindle for PC (Mazama)
pub const APP_VERSION: &str = "71006";
pub const DEVICE_TYPE: &str = "A2XIMM7ACS4GUS"; // Kindle for PC (captured)
const AMAZON: &str = "https://www.amazon.com";
const API: &str = "https://api.amazon.com";

fn b64url_nopad(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// Transient per-registration state created when the login URL is minted and
/// needed again to exchange the authorization code.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PendingRegistration {
    pub serial: String,
    pub device_type: String,
    pub verifier: String,
    /// hex(serial "#" device_type) — the register-side client_id.
    pub client_id: String,
    /// What the device is called on the Amazon account (see `device_name`).
    #[serde(default)]
    pub device_name: String,
}

/// The name this app registers under when the reader gives none.
pub fn default_device_name() -> &'static str {
    if cfg!(target_os = "android") {
        "pntome Android"
    } else {
        "pntome PC"
    }
}

/// The name for a new registration: the reader's (or the platform default),
/// tidied and cut to 40 characters, then a short piece of the serial, since
/// Amazon refuses a name already on the account ("pntome Android (7Kq2)").
pub fn device_name(wanted: Option<&str>, serial: &str) -> String {
    let base: String = wanted
        .map(|s| s.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| default_device_name().to_string())
        .chars()
        .filter(|c| !c.is_control())
        .take(40)
        .collect();
    format!("{} ({})", base.trim(), &serial[..4])
}

/// The credential bundle minted by a successful registration.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Credentials {
    pub device_private_key: String, // PKCS#1 PEM
    pub adp_token: String,          // {enc:...} blob
    /// directedId = customer_info.user_id — the account id used in whispersync
    /// paths. DIFFERENT from the OpenID claimed_id.
    pub directed_id: String,
    pub device_serial: String,
    pub device_type: String,
    pub device_name: String,
}

fn random_serial() -> String {
    const ALPHA: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let mut rng = rand::thread_rng();
    (0..40)
        .map(|_| ALPHA[rng.gen_range(0..ALPHA.len())] as char)
        .collect()
}

/// Build the Amazon sign-in URL and the pending state to carry into `register`.
/// `name`: what to call the device on the account (None: the platform default).
pub fn build_login_url(device_type: &str, name: Option<&str>) -> (String, PendingRegistration) {
    let serial = random_serial();
    let device_name = device_name(name, &serial);
    let verifier = b64url_nopad(&rand::random::<[u8; 32]>());
    let challenge = b64url_nopad(&Sha256::digest(verifier.as_bytes()));
    let client_id_hex = hex::encode(format!("{serial}#{device_type}"));
    let client_id_field = format!("device:{client_id_hex}");
    let return_to = format!("{AMAZON}/ap/maplanding");

    let params = [
        ("openid.oa2.response_type", "code"),
        ("openid.oa2.code_challenge_method", "S256"),
        ("openid.oa2.code_challenge", challenge.as_str()),
        ("openid.oa2.client_id", client_id_field.as_str()),
        ("openid.return_to", return_to.as_str()),
        ("openid.assoc_handle", ASSOC),
        (
            "openid.identity",
            "http://specs.openid.net/auth/2.0/identifier_select",
        ),
        ("openid.mode", "checkid_setup"),
        (
            "openid.claimed_id",
            "http://specs.openid.net/auth/2.0/identifier_select",
        ),
        ("openid.ns", "http://specs.openid.net/auth/2.0"),
        ("pageId", ASSOC),
        ("accountStatusPolicy", "P1"),
        (
            "openid.ns.pape",
            "http://specs.openid.net/extensions/pape/1.0",
        ),
        ("openid.pape.max_auth_age", "0"),
        ("openid.oa2.scope", "device_auth_access"),
        ("openid.ns.oa2", "http://www.amazon.com/ap/ext/oauth/2"),
        ("language", "en_US"),
        ("marketPlaceId", MARKETPLACE),
    ];
    let mut signin = url::Url::parse(&format!("{AMAZON}/ap/signin")).unwrap();
    signin.query_pairs_mut().extend_pairs(params.iter().copied());
    let url = signin.to_string();

    (
        url,
        PendingRegistration {
            serial,
            device_type: device_type.to_string(),
            verifier,
            client_id: client_id_hex,
            device_name,
        },
    )
}

/// Extract the OAuth2 authorization code from a `/ap/maplanding?...` redirect URL.
pub fn extract_code(redirect_url: &str) -> Option<String> {
    let parsed = url::Url::parse(redirect_url).ok()?;
    parsed
        .query_pairs()
        .find(|(k, _)| k == "openid.oa2.authorization_code" || k == "authorization_code")
        .map(|(_, v)| v.into_owned())
}

/// Exchange the authorization code for a fresh credential bundle.
/// OUTWARD-FACING: this registers a new device on the user's Amazon account.
pub async fn register(
    pending: &PendingRegistration,
    code: &str,
) -> Result<Credentials, AdpError> {
    let device_name = if pending.device_name.is_empty() { device_name(None, &pending.serial) } else { pending.device_name.clone() };
    let body = serde_json::json!({
        "requested_token_type": ["bearer", "mac_dms", "website_cookies", "store_authentication_cookie"],
        "cookies": {"website_cookies": [], "domain": ".amazon.com"},
        "registration_data": {
            "domain": "Device",
            "app_version": APP_VERSION,
            "device_serial": pending.serial,
            "device_type": pending.device_type,
            "device_name": device_name,
            "os_version": "Windows 10",
            "software_version": APP_VERSION,
            "device_model": "Windows",
            "app_name": "pinknbook",
        },
        "auth_data": {
            "client_id": pending.client_id,
            "authorization_code": code,
            "code_verifier": pending.verifier,
            "code_algorithm": "SHA-256",
            "client_domain": "DeviceLegacy",
        },
        "requested_extensions": ["device_info", "customer_info"],
    });

    let client = reqwest::Client::new();
    let resp = client
        .post(format!("{API}/auth/register"))
        .header("Content-Type", "application/json; charset=utf-8")
        .header("Accept-Language", "en-US")
        .header("x-amzn-identity-auth-domain", "api.amazon.com")
        .header("User-Agent", "Mozilla/5.0")
        .body(serde_json::to_vec(&body).unwrap())
        .send()
        .await
        .map_err(|e| AdpError::Http(e.to_string()))?;

    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| AdpError::Http(e.to_string()))?;
    if !status.is_success() {
        return Err(AdpError::Register(format!("HTTP {status}: {}", truncate(&text, 400))));
    }

    let data: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| AdpError::Register(e.to_string()))?;
    let success = &data["response"]["success"];
    let mac = &success["tokens"]["mac_dms"];
    let pem = mac["device_private_key"]
        .as_str()
        .ok_or_else(|| AdpError::Register("response missing mac_dms.device_private_key".into()))?;
    let adp = mac["adp_token"]
        .as_str()
        .ok_or_else(|| AdpError::Register("response missing mac_dms.adp_token".into()))?;

    // directedId lives in customer_info.user_id; fall back to any amzn1.account.* in the body.
    let ext = &success["extensions"];
    let directed_id = ext["customer_info"]["user_id"]
        .as_str()
        .or_else(|| ext["store_authentication_cookie"]["user_id"].as_str())
        .map(|s| s.to_string())
        .or_else(|| find_account_id(&data))
        .ok_or_else(|| AdpError::Register("could not locate directedId in response".into()))?;

    Ok(Credentials {
        device_private_key: pem.to_string(),
        adp_token: adp.to_string(),
        directed_id,
        device_serial: pending.serial.clone(),
        device_type: pending.device_type.clone(),
        device_name,
    })
}

fn find_account_id(v: &serde_json::Value) -> Option<String> {
    let s = v.to_string();
    let idx = s.find("amzn1.account.")?;
    let rest = &s[idx..];
    let end = rest
        .char_indices()
        .find(|(_, c)| !(c.is_ascii_alphanumeric() || *c == '.'))
        .map(|(i, _)| i)
        .unwrap_or(rest.len());
    Some(rest[..end].to_string())
}

fn truncate(s: &str, n: usize) -> String {
    if s.len() <= n {
        s.to_string()
    } else {
        format!("{}…", &s[..n])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn login_url_uses_device_prefix_and_hex_client_id() {
        let (url, pending) = build_login_url(DEVICE_TYPE, None);
        assert!(url.contains("openid.oa2.client_id=device%3A"));
        assert_eq!(pending.serial.len(), 40);
        // register client_id = hex(serial#device_type), no "device:" prefix
        let expect = hex::encode(format!("{}#{}", pending.serial, DEVICE_TYPE));
        assert_eq!(pending.client_id, expect);
        assert!(url.contains("code_challenge_method=S256"));
    }

    #[test]
    fn extracts_authorization_code() {
        let u = "https://www.amazon.com/ap/maplanding?openid.oa2.authorization_code=ABC123&foo=bar";
        assert_eq!(extract_code(u).as_deref(), Some("ABC123"));
    }

    #[test]
    fn finds_directed_id_fallback() {
        let v = serde_json::json!({"a": {"b": "amzn1.account.AFQDXYZ123"}});
        assert_eq!(find_account_id(&v).as_deref(), Some("amzn1.account.AFQDXYZ123"));
    }

    #[test]
    fn device_names_say_app_and_platform() {
        let serial = "Ab12xyzxyzxyzxyzxyzxyzxyzxyzxyzxyzxyzxyz";
        assert_eq!(device_name(None, serial), format!("{} (Ab12)", default_device_name()));
        assert_eq!(device_name(Some("  Máy   đọc  của Hiếu "), serial), "Máy đọc của Hiếu (Ab12)");
        assert_eq!(device_name(Some("   "), serial), format!("{} (Ab12)", default_device_name()));
        assert_eq!(device_name(Some(&"x".repeat(80)), serial).chars().count(), 40 + " (Ab12)".len());
        let (_, pending) = build_login_url(DEVICE_TYPE, Some("Kệ sách"));
        assert!(pending.device_name.starts_with("Kệ sách ("));
    }
}
