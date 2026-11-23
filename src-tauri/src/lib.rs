// Errors carry host-key details for the UI; they are cold-path, so size is fine.
#![allow(clippy::result_large_err)]

//! Thin Tauri layer: state + `#[tauri::command]`s over `siakap-core`.

mod commands;
mod state;

use std::time::Duration;

use tauri::{Emitter, Manager};

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
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
            commands::vault_change_password,
            commands::touch,
            commands::sessions_list,
            commands::session_save,
            commands::session_delete,
            commands::folders_save,
            commands::macros_list,
            commands::macro_save,
            commands::macro_delete,
            commands::macro_render,
            commands::macros_export_file,
            commands::macros_import_file,
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
            commands::security_key_state,
            commands::security_key_toggle,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Siakap Terminal");
}
