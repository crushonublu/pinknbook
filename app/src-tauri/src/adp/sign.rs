//! ADP request signing — ported byte-for-byte from the proven Python spike.
//! Reproduces Kindle-for-PC's `X-ADP-Request-Digest`
//! exactly:
//!
//! ```text
//! canonical = METHOD "\n" PATH "\n" TIMESTAMP "\n" BODY "\n" adp_token   (no trailing \n)
//! block     = 0x00 0x01  ||  0xFF*(k-3-32)  ||  0x00  ||  SHA256(canonical)   (k = 256)
//!             (PKCS#1 v1.5 over the RAW 32-byte hash — NO DigestInfo wrapper)
//! signature = block^d mod n                                                   (raw RSA private op)
//! digest    = base64(signature) + ":" + TIMESTAMP
//! ```
//!
//! The "no DigestInfo" detail is what `Pkcs1v15Sign::new_unprefixed()` gives us:
//! it pads the supplied digest bytes directly, with no algorithm OID prefix.

use base64::Engine;
use rsa::pkcs1::DecodeRsaPrivateKey;
use rsa::{Pkcs1v15Sign, RsaPrivateKey};
use sha2::{Digest, Sha256};

use super::AdpError;

/// Parse a PKCS#1 ("BEGIN RSA PRIVATE KEY") PEM into an RSA private key.
/// Falls back to PKCS#8 in case a future registration returns that form.
pub fn load_private_key(pem: &str) -> Result<RsaPrivateKey, AdpError> {
    if let Ok(k) = RsaPrivateKey::from_pkcs1_pem(pem) {
        return Ok(k);
    }
    use rsa::pkcs8::DecodePrivateKey;
    RsaPrivateKey::from_pkcs8_pem(pem).map_err(|e| AdpError::Key(e.to_string()))
}

/// Build the canonical signing string (5 fields, 4 newlines, no trailing newline).
pub fn canonical(method: &str, path: &str, timestamp: &str, body: &str, adp_token: &str) -> String {
    format!("{method}\n{path}\n{timestamp}\n{body}\n{adp_token}")
}

/// Produce the `X-ADP-Request-Digest` header value: `base64(sig) + ":" + timestamp`.
pub fn sign_digest(
    key: &RsaPrivateKey,
    method: &str,
    path: &str,
    timestamp: &str,
    body: &str,
    adp_token: &str,
) -> Result<String, AdpError> {
    let canonical = canonical(method, path, timestamp, body, adp_token);
    let hash = Sha256::digest(canonical.as_bytes());
    // new_unprefixed() => PKCS#1 v1.5 padding over the raw digest, no DigestInfo.
    let sig = key
        .sign(Pkcs1v15Sign::new_unprefixed(), &hash)
        .map_err(|e| AdpError::Sign(e.to_string()))?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(sig);
    Ok(format!("{b64}:{timestamp}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_has_four_newlines_no_trailing() {
        let c = canonical("GET", "/p", "2026-01-01T00:00:00", "", "tok");
        assert_eq!(c.matches('\n').count(), 4);
        assert!(!c.ends_with('\n'));
        assert_eq!(c, "GET\n/p\n2026-01-01T00:00:00\n\ntok");
    }
}
