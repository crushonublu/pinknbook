mod adp;
mod ai;
mod annotations;
mod bookmarks;
mod commands;
mod creds;
mod db;
mod dict;
mod goodreads;
mod library_meta;
mod meta;
mod stats;
mod stk;
mod vocab;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // Book covers: cover://<file> → <app_data>/covers/<file>
        .register_uri_scheme_protocol("cover", |ctx, req| {
            use tauri::http::{header, Response, StatusCode};
            let name = req.uri().path().trim_start_matches('/').to_string();
            let file = library_meta::safe_cover_name(&name)
                .then(|| ctx.app_handle().path().app_data_dir().ok())
                .flatten()
                .and_then(|d| std::fs::read(d.join("covers").join(&name)).ok());
            match file {
                Some(bytes) => {
                    let mime = match meta::image_ext(&bytes) {
                        "png" => "image/png",
                        "gif" => "image/gif",
                        _ => "image/jpeg",
                    };
                    Response::builder()
                        .header(header::CONTENT_TYPE, mime)
                        .header(header::CACHE_CONTROL, "max-age=31536000, immutable")
                        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                        .body(bytes)
                        .unwrap()
                }
                None => Response::builder()
                    .status(StatusCode::NOT_FOUND)
                    .body(Vec::new())
                    .unwrap(),
            }
        })
        .setup(|app| {
            // Self-update from GitHub Releases (signed with the updater key),
            // and `relaunch()` once the new installer has run.
            #[cfg(desktop)]
            {
                app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
                app.handle().plugin(tauri_plugin_process::init())?;
            }
            // Local SQLite under the app's data dir.
            let data_dir = app.path().app_data_dir()?;
            let db_path = data_dir.join("pinknbook.sqlite");
            let database = db::Db::open(&db_path)?;
            app.manage(database);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::auth_status,
            commands::login,
            commands::logout,
            commands::sync_library,
            commands::get_library,
            commands::download_book,
            commands::set_reading_position,
            commands::push_reading_position,
            commands::push_status_to_kindle,
            annotations::list_annotations,
            annotations::add_annotation,
            annotations::update_annotation,
            annotations::remove_annotation,
            annotations::set_annotation_kpos,
            stk::epub_inspect,
            stk::image_preview,
            stk::stk_devices,
            stk::stk_send,
            stats::log_reading,
            stats::kindle_activity_tick,
            stats::stats_summary,
            stats::set_stats_settings,
            dict::dict_status,
            dict::dict_install,
            dict::dict_lookup,
            vocab::vocab_list,
            vocab::vocab_add,
            vocab::vocab_set_learned,
            vocab::vocab_remove,
            ai::ai_key_status,
            ai::ai_key_set,
            ai::ai_key_clear,
            ai::xray_ai_estimate,
            ai::xray_ai_run,
            ai::xray_load,
            ai::xray_save,
            annotations::kindle_pull_annotations,
            annotations::kindle_push_annotations,
            commands::reader_start,
            commands::kindle_furthest,
            library_meta::enrich_library,
            library_meta::set_book_info,
            library_meta::set_book_cover,
            library_meta::reset_book,
            library_meta::set_book_status,
            library_meta::set_book_spine,
            library_meta::set_cover_source,
            library_meta::set_shelf_order,
            bookmarks::list_bookmarks,
            bookmarks::add_bookmark,
            bookmarks::remove_bookmark,
            goodreads::goodreads_info,
            goodreads::goodreads_details,
            goodreads::goodreads_candidates,
            goodreads::goodreads_choose,
            goodreads::goodreads_reset,
            goodreads::goodreads_translate,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
