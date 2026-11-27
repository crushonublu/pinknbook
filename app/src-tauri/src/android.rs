//! Calling into `MainActivity` (Kotlin) from Rust.

use jni::JNIEnv;
use jni::objects::{JObject, JString};
use tauri::{AppHandle, Manager};

/// Run `f` on the Android UI thread with the main activity and wait for its
/// answer. A pending Java exception is cleared, so it cannot reach the next
/// JNI call.
pub(crate) async fn on_activity<T: Send + 'static>(
    app: &AppHandle,
    f: impl FnOnce(&mut JNIEnv<'_>, &JObject<'_>) -> jni::errors::Result<T> + Send + 'static,
) -> Result<T, String> {
    const UNAVAILABLE: &str = "Android activity unavailable";
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.get_webview_window("main")
        .ok_or(UNAVAILABLE)?
        .with_webview(move |w| {
            w.jni_handle().exec(move |env, activity, _| {
                let result = f(env, activity);
                if env.exception_check().unwrap_or(false) {
                    let _ = env.exception_clear();
                }
                let _ = tx.send(result.map_err(|_| UNAVAILABLE.to_string()));
            });
        })
        .map_err(|_| UNAVAILABLE)?;
    rx.await.map_err(|_| UNAVAILABLE.to_string())?
}

/// Call a `String`-returning method of the activity that takes no arguments
/// or the given ones (`signature` is the JNI signature).
pub(crate) fn call_string(
    env: &mut JNIEnv<'_>,
    activity: &JObject<'_>,
    method: &str,
    signature: &str,
    args: &[jni::objects::JValue<'_, '_>],
) -> jni::errors::Result<String> {
    let reply = JString::from(env.call_method(activity, method, signature, args)?.l()?);
    let text = env.get_string(&reply)?;
    Ok(text.into())
}
