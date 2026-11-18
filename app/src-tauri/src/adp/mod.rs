//! ADP (Amazon Device Portal) core — the independent sign / register / request
//! stack, ported from the byte-proven Python spike.

pub mod client;
pub mod register;
pub mod sign;

#[derive(Debug, thiserror::Error)]
pub enum AdpError {
    #[error("key error: {0}")]
    Key(String),
    #[error("signing error: {0}")]
    Sign(String),
    #[error("http error: {0}")]
    Http(String),
    #[error("registration error: {0}")]
    Register(String),
    #[error("parse error: {0}")]
    Parse(String),
}

// Let AdpError cross the Tauri IPC boundary as a plain string.
impl serde::Serialize for AdpError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}
