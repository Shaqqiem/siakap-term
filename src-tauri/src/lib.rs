// Errors carry host-key details for the UI; they are cold-path, so size is fine.
#![allow(clippy::result_large_err)]

//! Thin Tauri layer: state + `#[tauri::command]`s over `siakap-core`.

mod commands;
mod state;

use std::time::Duration;

use tauri::{Emitter, Manager};

/// URLs the web view may load: the bundled app (and the Vite dev server in debug builds).
fn allowed_url(url: &tauri::Url) -> bool {
    match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "http" | "https" => match url.host_str() {
            Some("tauri.localhost") | Some("ipc.localhost") => true,
            Some("localhost") => cfg!(debug_assertions) && url.port() == Some(1420),
            _ => false,
        },
        "about" => url.as_str() == "about:blank",
        _ => false,
    }
}

/// The last few internal crash messages (for "Report a problem"; memory only).
pub static PANICS: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

pub fn run() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let at = info.location().map(|l| format!(" at {}:{}", l.file(), l.line())).unwrap_or_default();
        let msg = info.payload().downcast_ref::<&str>().map(|s| s.to_string()).or_else(|| info.payload().downcast_ref::<String>().cloned()).unwrap_or_default();
        if let Ok(mut p) = PANICS.lock() {
            p.push(format!("{msg}{at}").chars().take(500).collect());
            let n = p.len();
            if n > 20 {
                p.drain(..n - 20);
            }
        }
        default_hook(info);
    }));
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // The web view may only show the app's own bundled pages: no
        // navigating to remote sites, ever (links in terminal output included).
        .plugin(
            tauri::plugin::Builder::<tauri::Wry>::new("siakap-nav-guard")
                .on_navigation(|_, url| allowed_url(url))
                .build(),
        )
        .on_window_event(|window, event| {
            // Files dropped onto the window are chosen by the user in the OS, so
            // they may be uploaded: grant them here, outside the web view's reach.
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                window.state::<state::AppState>().grant(paths.iter().cloned());
            }
        })
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            app.manage(state::AppState::new(dir.join("vault.json")));

            // Auto-lock watchdog. Activity is reported by the UI (keyboard and
            // mouse input), never by terminal output.
            let handle = app.handle().clone();
            std::thread::Builder::new().name("auto-lock".into()).spawn(move || loop {
                std::thread::sleep(Duration::from_secs(10));
                let st = handle.state::<state::AppState>();
                if st.auto_lock_due() {
                    st.lock_vault();
                    let _ = handle.emit("vault-locked", "idle");
                }
            })?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::vault_status,
            commands::vault_create,
            commands::vault_unlock,
            commands::vault_lock,
            commands::vault_unlock_remembered,
            commands::vault_set_remember,
            commands::vault_create_passwordless,
            commands::vault_set_master_password,
            commands::vault_change_password,
            commands::touch,
            commands::sessions_list,
            commands::session_save,
            commands::session_delete,
            commands::sessions_enable_startup,
            commands::folders_save,
            commands::macros_list,
            commands::macro_save,
            commands::macro_delete,
            commands::macro_render,
            commands::macro_duplicate,
            commands::macro_move,
            commands::macro_folder_save,
            commands::backup_export_file,
            commands::backup_import_file,
            commands::settings_get,
            commands::settings_save,
            commands::known_hosts_list,
            commands::known_host_remove,
            commands::trust_host_key,
            commands::shells_list,
            commands::term_open_local,
            commands::term_open_ssh,
            commands::term_write,
            commands::term_resize,
            commands::term_close,
            commands::serial_ports_list,
            commands::pick_files,
            commands::pick_save,
            #[cfg(debug_assertions)]
            commands::debug_grant_path,
            commands::term_open_serial,
            commands::term_serial_break,
            commands::sftp_home,
            commands::sftp_list,
            commands::sftp_mkdir,
            commands::sftp_rename,
            commands::sftp_remove,
            commands::sftp_download,
            commands::sftp_upload,
            commands::sftp_cancel,
            commands::fonts_list,
            commands::update_check,
            commands::diag_info,
            commands::update_download,
            commands::update_install,
            commands::open_release_page,
            commands::term_log_start,
            commands::term_log_auto,
            commands::term_log_stop,
            commands::log_folder_pick,
            commands::save_text_file,
            commands::theme_read_file,
            commands::clipboard_read,
            commands::clipboard_write,
            commands::security_key_state,
            commands::security_key_action,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Siakap Terminal");
}

#[cfg(test)]
mod tests {
    use super::allowed_url;

    #[test]
    fn navigation_is_limited_to_the_app() {
        let ok = |u: &str| allowed_url(&tauri::Url::parse(u).unwrap());
        assert!(ok("tauri://localhost/index.html"));
        assert!(ok("http://tauri.localhost/"));
        assert!(!ok("https://example.com/"));
        assert!(!ok("http://evil.localhost.example/"));
        assert!(!ok("file:///C:/Windows/win.ini"));
        assert!(!ok("javascript:alert(1)"));
        assert_eq!(ok("http://localhost:1420/"), cfg!(debug_assertions));
    }
}
