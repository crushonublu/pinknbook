//! Handing a wrap-up picture (a PNG the UI has drawn) to the system.
//!
//! `wrap_export` is called with the PNG as the raw body of the request (a JSON
//! list of two million numbers would be slow on a phone) and two headers:
//! `x-file-name` and `x-action`, `save` or `share`. Android's IPC carries JSON
//! only (a raw body arrives there as something else), so the app uses
//! `wrap_export_base64` there: the same, with the PNG as base64 text.
//!
//! - Desktop `save`: a save dialog that starts in the Pictures folder.
//! - Android `save`: the Photos gallery (`MediaStore`, folder Pictures/pntome).
//! - Android `share`: the system share sheet (a file in the cache, offered
//!   through `FileProvider`).
//!
//! Copying to the clipboard is done in the page (`navigator.clipboard`), which
//! needs nothing native.

use tauri::AppHandle;
use tauri::ipc::{InvokeBody, Request};

#[derive(Clone, Copy, PartialEq, Debug)]
enum Action {
    Save,
    Share,
}

impl Action {
    fn parse(s: &str) -> Result<Self, String> {
        match s {
            "save" => Ok(Self::Save),
            "share" => Ok(Self::Share),
            other => Err(format!("Unknown action: {other}")),
        }
    }
}

/// A file name that is safe to use as it is: letters, digits, `-`, `_` and
/// `.`, ending in `.png`, never empty and not long.
fn safe_file_name(raw: &str) -> String {
    let stem = raw.strip_suffix(".png").unwrap_or(raw);
    let mut name: String = stem
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .take(80)
        .collect();
    if name.is_empty() {
        name.push_str("pntome");
    }
    name.push_str(".png");
    name
}

fn header(req: &Request<'_>, name: &str) -> Result<String, String> {
    req.headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
        .ok_or_else(|| format!("Missing header {name}"))
}

/// Saves or shares a picture. Returns where it was saved (a path, or the
/// gallery folder on Android); `None` when the save dialog was closed without
/// saving, and an empty string once the share sheet is open.
#[tauri::command]
pub async fn wrap_export(app: AppHandle, request: Request<'_>) -> Result<Option<String>, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("The picture must be sent as raw bytes".into());
    };
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err("The picture is not a PNG".into());
    }
    let action = Action::parse(&header(&request, "x-action")?)?;
    let name = safe_file_name(&header(&request, "x-file-name")?);
    export(app, bytes.clone(), name, action).await
}

/// `wrap_export` for Android, whose IPC carries JSON only: the PNG as base64.
#[tauri::command]
pub async fn wrap_export_base64(app: AppHandle, data: String, file_name: String, action: String) -> Result<Option<String>, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.decode(data.as_bytes()).map_err(|e| format!("The picture is not base64: {e}"))?;
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err("The picture is not a PNG".into());
    }
    export(app, bytes, safe_file_name(&file_name), Action::parse(&action)?).await
}

#[cfg(desktop)]
async fn export(app: AppHandle, bytes: Vec<u8>, name: String, action: Action) -> Result<Option<String>, String> {
    use tauri::Manager;
    use tauri_plugin_dialog::DialogExt;

    if action == Action::Share {
        return Err("Sharing is only available on the phone".into());
    }
    let pictures = app.path().picture_dir().ok();
    let window = app.get_webview_window("main");
    // The dialog blocks until it is closed: not on the thread that runs the window.
    tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = app.dialog().file().add_filter("PNG", &["png"]).set_file_name(name);
        if let Some(dir) = pictures {
            dialog = dialog.set_directory(dir);
        }
        if let Some(w) = &window {
            dialog = dialog.set_parent(w);
        }
        let Some(chosen) = dialog.blocking_save_file() else {
            return Ok(None);
        };
        let path = chosen.into_path().map_err(|e| e.to_string())?;
        std::fs::write(&path, &bytes).map_err(|e| format!("Could not write {}: {e}", path.display()))?;
        Ok(Some(path.display().to_string()))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(target_os = "android")]
async fn export(app: AppHandle, bytes: Vec<u8>, name: String, action: Action) -> Result<Option<String>, String> {
    use jni::objects::JString;
    use tauri::Manager;

    let (tx, rx) = tokio::sync::oneshot::channel();
    app.get_webview_window("main")
        .ok_or("Main webview unavailable")?
        .with_webview(move |w| {
            w.jni_handle().exec(move |env, activity, _| {
                // MainActivity.saveImage / shareImage(bytes, name): "" or the place on success, "!reason" on failure.
                let result = (|| -> jni::errors::Result<String> {
                    let data = env.byte_array_from_slice(&bytes)?;
                    let name = env.new_string(name)?;
                    let method = if action == Action::Share { "shareImage" } else { "saveImage" };
                    let out = env
                        .call_method(
                            activity,
                            method,
                            "([BLjava/lang/String;)Ljava/lang/String;",
                            &[(&data).into(), (&name).into()],
                        )?
                        .l()?;
                    let reply = JString::from(out);
                    let text = env.get_string(&reply)?;
                    Ok(text.into())
                })();
                if env.exception_check().unwrap_or(false) {
                    let _ = env.exception_clear();
                }
                let _ = tx.send(result.map_err(|_| "Android could not take the picture".to_string()));
            });
        })
        .map_err(|_| "Main webview unavailable")?;
    let reply = rx.await.map_err(|_| "Android could not take the picture".to_string())??;
    match reply.strip_prefix('!') {
        Some(reason) => Err(reason.to_string()),
        None => Ok(Some(reply)),
    }
}

#[cfg(all(mobile, not(target_os = "android")))]
async fn export(_app: AppHandle, _bytes: Vec<u8>, _name: String, _action: Action) -> Result<Option<String>, String> {
    Err("Saving pictures is not available on this platform".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_names_are_made_safe() {
        assert_eq!(safe_file_name("pntome-month-2026-10-01-story.png"), "pntome-month-2026-10-01-story.png");
        assert_eq!(safe_file_name("../../etc/passwd"), "______etc_passwd.png");
        assert_eq!(safe_file_name("a b\\c:d.png"), "a_b_c_d.png");
        assert_eq!(safe_file_name(""), "pntome.png");
        assert_eq!(safe_file_name(".png"), "pntome.png");
        assert_eq!(safe_file_name(&"x".repeat(200)).len(), 84);
        // Letters outside ASCII are replaced, so the name is valid in every file system.
        assert_eq!(safe_file_name("tổng-kết"), "t_ng-k_t.png");
    }

    #[test]
    fn actions_are_parsed() {
        assert_eq!(Action::parse("save"), Ok(Action::Save));
        assert_eq!(Action::parse("share"), Ok(Action::Share));
        assert!(Action::parse("copy").is_err());
        assert!(Action::parse("").is_err());
    }
}
