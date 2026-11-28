//! `#[tauri::command]`s. Every input from the webview is validated here or in
//! the core before it touches the disk, a process or the network.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::State;
use zeroize::Zeroizing;

use siakap_core::backup::{self, ImportReport};
use siakap_core::macros::{self, Step};
use siakap_core::model::{
    new_id, normalize_folder, validate_host, validate_name, validate_user, KnownHost, Macro, RedactedSession, Session,
    SessionKind, SessionSecret, Settings,
};
use siakap_core::pty::{self, EventSink, LocalPty, ShellInfo, TermEvent};
use siakap_core::remember;
use siakap_core::security_key;
use siakap_core::serial::{self, SerialConfig, SerialTerm};
use siakap_core::sftp::{self, Entry, Sftp};
use siakap_core::ssh::{self, ConnectParams, SshConnection};
use siakap_core::termlog;
use siakap_core::vault::atomic_write;
use siakap_core::CoreError;

use crate::state::{AppState, LogSlot, Term};

type Res<T> = std::result::Result<T, CoreError>;

// ---------------------------------------------------------------- vault

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatus {
    exists: bool,
    unlocked: bool,
    /// This build can open the vault without the master password (Windows).
    remember_available: bool,
    /// The user turned that on: the key is saved for this Windows account.
    remembered: bool,
    /// The vault has no master password; it opens with the Windows account only.
    passwordless: bool,
}

#[tauri::command]
pub fn vault_status(st: State<'_, AppState>) -> VaultStatus {
    let path = st.remember_path();
    let remembered = remember::available() && remember::exists(&path);
    let passwordless = remembered && remember::is_passwordless(&path);
    let v = st.vault();
    VaultStatus {
        exists: v.exists(),
        unlocked: v.is_unlocked(),
        remember_available: remember::available(),
        remembered,
        passwordless,
    }
}

/// First launch without a master password: the vault gets a random password
/// nobody knows, and its key is saved only for this Windows account.
#[tauri::command]
pub async fn vault_create_passwordless(st: State<'_, AppState>) -> Res<()> {
    if !remember::available() {
        return Err(CoreError::invalid("A vault without a master password is only available on Windows."));
    }
    let path = st.remember_path();
    let pw = remember::random_password();
    let mut v = st.vault();
    v.create(&pw)?;
    let r = v
        .update(|d| {
            d.passwordless = true;
            Ok(())
        })
        .and_then(|_| v.device_key())
        .and_then(|k| remember::save(&path, &k, true));
    if let Err(e) = r {
        // Without the saved key nobody could ever open this vault.
        v.lock();
        let _ = std::fs::remove_file(v.path());
        let _ = remember::clear(&path);
        return Err(e);
    }
    drop(v);
    st.touch();
    Ok(())
}

/// Give a vault created without a master password a real one. Afterwards
/// Siakap asks for it when it opens, like any other vault.
#[tauri::command]
pub async fn vault_set_master_password(st: State<'_, AppState>, password: String) -> Res<()> {
    let password = Zeroizing::new(password);
    let mut v = st.vault();
    if !v.data()?.passwordless {
        return Err(CoreError::invalid(
            "This vault already has a master password. Use Change master password instead.",
        ));
    }
    v.rekey(&password)?;
    v.update(|d| {
        d.passwordless = false;
        Ok(())
    })?;
    drop(v);
    remember::clear(&st.remember_path())
}

/// Open the vault with the key saved for this Windows account. If that fails
/// (password changed, profile moved, file damaged) the saved key is removed
/// and the user types the master password as usual.
#[tauri::command]
pub async fn vault_unlock_remembered(st: State<'_, AppState>) -> Res<()> {
    let path = st.remember_path();
    let r = remember::load(&path).and_then(|k| st.vault().unlock_with_device_key(&k));
    if r.is_err() && remember::is_passwordless(&path) {
        // This file is the only way in: never delete it.
        return Err(CoreError::invalid(
            "Siakap couldn't open the vault with your Windows account. Nothing was deleted. Try again, or check that you're signed in to the same Windows account as before.",
        ));
    }
    if r.is_err() {
        let _ = remember::clear(&path);
        return Err(CoreError::invalid(
            "Siakap couldn't open without the master password this time (it may have been changed). Enter it below. You can turn the option on again in Settings.",
        ));
    }
    st.touch();
    Ok(())
}

/// Turn "ask for the master password when Siakap opens" off (`remember`
/// true, needs the master password) or back on (deletes the saved key).
#[tauri::command]
pub async fn vault_set_remember(st: State<'_, AppState>, remember: bool, password: Option<String>) -> Res<()> {
    st.ensure_unlocked()?;
    let path = st.remember_path();
    if st.vault().data()?.passwordless {
        return Err(CoreError::invalid("This vault has no master password yet. Set one first."));
    }
    if !remember {
        return remember::clear(&path);
    }
    let password = Zeroizing::new(password.unwrap_or_default());
    let _one_at_a_time = st.unlock_gate.lock().await;
    let delay = st.unlock_delay();
    if !delay.is_zero() {
        tokio::time::sleep(delay).await;
    }
    let ok = st.vault().verify_password(&password);
    st.unlock_result(ok.is_ok());
    ok?;
    let key = st.vault().device_key()?;
    remember::save(&path, &key, false)
}

#[tauri::command]
pub async fn vault_create(st: State<'_, AppState>, password: String) -> Res<()> {
    let password = Zeroizing::new(password);
    st.vault().create(&password)?;
    st.touch();
    Ok(())
}

#[tauri::command]
pub async fn vault_unlock(st: State<'_, AppState>, password: String) -> Res<()> {
    let password = Zeroizing::new(password);
    let _one_at_a_time = st.unlock_gate.lock().await;
    // Slow down repeated guesses: 1 s, 2 s, 4 s, ... (max 30 s) after three failures.
    let delay = st.unlock_delay();
    if !delay.is_zero() {
        tokio::time::sleep(delay).await;
    }
    let r = st.vault().unlock(&password);
    st.unlock_result(r.is_ok());
    r?;
    st.touch();
    Ok(())
}

#[tauri::command]
pub fn vault_lock(st: State<'_, AppState>) {
    st.lock_vault();
}

#[tauri::command]
pub async fn vault_change_password(st: State<'_, AppState>, old: String, new: String) -> Res<()> {
    let (old, new) = (Zeroizing::new(old), Zeroizing::new(new));
    let _one_at_a_time = st.unlock_gate.lock().await;
    let delay = st.unlock_delay();
    if !delay.is_zero() {
        tokio::time::sleep(delay).await;
    }
    let r = st.vault().change_password(&old, &new);
    if matches!(r, Err(CoreError::WrongPassword { .. })) {
        st.unlock_result(false);
    }
    r?;
    // Keep "open without the master password" working with the new key.
    let path = st.remember_path();
    if remember::exists(&path) {
        let key = st.vault().device_key()?;
        if remember::save(&path, &key, false).is_err() {
            let _ = remember::clear(&path);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn touch(st: State<'_, AppState>) {
    st.touch();
}

// ---------------------------------------------------------------- sessions

#[tauri::command]
pub fn sessions_list(st: State<'_, AppState>) -> Res<SessionsView> {
    let v = st.vault();
    let d = v.data()?;
    Ok(SessionsView {
        sessions: d.redacted_sessions(),
        folders: d.folders.clone(),
        macro_folders: d.macro_folders.clone(),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionsView {
    sessions: Vec<RedactedSession>,
    folders: Vec<String>,
    macro_folders: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInput {
    session: Session,
    /// `Some` sets a new saved password.
    password: Option<String>,
    #[serde(default)]
    clear_password: bool,
}

#[tauri::command]
pub fn session_save(st: State<'_, AppState>, input: SessionInput) -> Res<String> {
    let SessionInput { mut session, password, clear_password } = input;
    let password = password.map(Zeroizing::new);
    session.name = validate_name(&session.name)?;
    session.folder = normalize_folder(&session.folder)?;
    match session.kind {
        SessionKind::Ssh => {
            session.host = validate_host(&session.host)?;
            session.user = validate_user(&session.user)?;
            if session.port == 0 {
                session.port = 22;
            }
            session.key_path = session.key_path.trim().to_string();
            if session.key_path.chars().any(char::is_control) {
                return Err(CoreError::invalid("Invalid key path."));
            }
            session.shell.clear();
            if session.forwards.len() > siakap_core::model::MAX_FORWARDS {
                return Err(CoreError::invalid(format!(
                    "At most {} port forwards per session.",
                    siakap_core::model::MAX_FORWARDS
                )));
            }
            session.forwards =
                std::mem::take(&mut session.forwards).into_iter().map(|f| f.validated()).collect::<Res<Vec<_>>>()?;
            session.jump_session = session.jump_session.take().filter(|j| !j.is_empty());
        }
        SessionKind::Local => {
            session.forwards.clear();
            session.jump_session = None;
            session.host.clear();
            session.user.clear();
            session.key_path.clear();
        }
        SessionKind::Serial => {
            session.serial = session.serial.validated()?;
            session.forwards.clear();
            session.jump_session = None;
            session.host.clear();
            session.user.clear();
            session.key_path.clear();
            session.shell.clear();
        }
    }
    if session.startup_script.len() > 256 * 1024 {
        return Err(CoreError::invalid("Startup commands are limited to 256 KiB."));
    }
    if !session.startup_script.trim().is_empty() {
        macros::check(&session.startup_script)?;
    }
    session.startup_dir = session.startup_dir.trim().to_string();
    if session.startup_dir.chars().any(char::is_control) {
        return Err(CoreError::invalid("The startup folder must be a single path."));
    }
    st.vault().update(|d| {
        if let Some(m) = &session.post_connect_macro {
            if m.is_empty() {
                session.post_connect_macro = None;
            } else if !d.macros.iter().any(|x| &x.id == m) {
                return Err(CoreError::invalid("The post-connect macro does not exist."));
            }
        }
        // The jump host must be another SSH session, and following the chain
        // from it must never come back to this one.
        let mut next = session.jump_session.clone();
        let mut hops = 0;
        while let Some(j) = next {
            if !session.id.is_empty() && j == session.id {
                return Err(CoreError::invalid("A session can't be its own jump host (directly or through others)."));
            }
            let js = d
                .sessions
                .iter()
                .find(|x| x.id == j && x.kind == SessionKind::Ssh)
                .ok_or_else(|| CoreError::invalid("The jump host must be another saved SSH session."))?;
            hops += 1;
            if hops > ssh::MAX_JUMPS {
                return Err(CoreError::invalid(format!("Too many jump hosts in a row (at most {}).", ssh::MAX_JUMPS)));
            }
            next = js.jump_session.clone();
        }
        if session.id.is_empty() {
            session.id = new_id();
            d.sessions.push(session.clone());
        } else if let Some(s) = d.sessions.iter_mut().find(|s| s.id == session.id) {
            *s = session.clone();
        } else {
            return Err(CoreError::not_found("session"));
        }
        if !session.folder.is_empty() && !d.folders.contains(&session.folder) {
            d.folders.push(session.folder.clone());
        }
        if clear_password || session.kind != SessionKind::Ssh {
            d.secrets.remove(&session.id);
        } else if let Some(pw) = &password {
            if !pw.is_empty() {
                d.secrets.insert(session.id.clone(), SessionSecret { password: Some(pw.to_string()) });
            }
        }
        Ok(session.id.clone())
    })
}

/// Turn on the startup commands of the given sessions (after an import).
#[tauri::command]
pub fn sessions_enable_startup(st: State<'_, AppState>, ids: Vec<String>) -> Res<usize> {
    st.vault().update(|d| {
        let mut n = 0;
        for s in d.sessions.iter_mut().filter(|s| ids.contains(&s.id) && !s.startup_script.trim().is_empty()) {
            s.startup_enabled = true;
            n += 1;
        }
        Ok(n)
    })
}

#[tauri::command]
pub fn session_delete(st: State<'_, AppState>, id: String) -> Res<()> {
    st.vault().update(|d| {
        d.sessions.retain(|s| s.id != id);
        d.secrets.remove(&id);
        Ok(())
    })
}

#[tauri::command]
pub fn folders_save(st: State<'_, AppState>, kind: String, folders: Vec<String>) -> Res<()> {
    let mut norm: Vec<String> = Vec::new();
    for f in folders {
        let n = normalize_folder(&f)?;
        if !n.is_empty() && !norm.contains(&n) {
            norm.push(n);
        }
    }
    st.vault().update(|d| {
        match kind.as_str() {
            "sessions" => d.folders = norm,
            "macros" => d.macro_folders = norm,
            _ => return Err(CoreError::invalid("unknown folder kind")),
        }
        Ok(())
    })
}

// ---------------------------------------------------------------- macros

#[tauri::command]
pub fn macros_list(st: State<'_, AppState>) -> Res<Vec<Macro>> {
    Ok(st.vault().data()?.macros.clone())
}

#[tauri::command]
pub fn macro_save(st: State<'_, AppState>, mut m: Macro) -> Res<String> {
    m.name = validate_name(&m.name)?;
    m.folder = normalize_folder(&m.folder)?;
    if m.script.trim().is_empty() {
        return Err(CoreError::invalid("Enter a name and at least one command."));
    }
    if m.script.len() > 256 * 1024 {
        return Err(CoreError::invalid("Macros are limited to 256 KiB."));
    }
    macros::check(&m.script)?;
    // Keep only defaults for inputs the script still uses.
    let names = macros::input_names(&m.script);
    m.parameter_defaults.retain(|k, v| names.contains(k) && v.len() <= 1024 && !v.chars().any(char::is_control));
    st.vault().update(|d| {
        let sig = macros::signature(&m.folder, &m.script);
        if let Some(dup) = d.macros.iter().find(|x| x.id != m.id && macros::signature(&x.folder, &x.script) == sig) {
            return Err(CoreError::invalid(format!(
                "The macro \"{}\" in this folder already does the same thing.",
                dup.name
            )));
        }
        if m.id.is_empty() {
            m.id = new_id();
            d.macros.push(m.clone());
        } else if let Some(x) = d.macros.iter_mut().find(|x| x.id == m.id) {
            *x = m.clone();
        } else {
            return Err(CoreError::not_found("macro"));
        }
        if !m.folder.is_empty() && !d.macro_folders.contains(&m.folder) {
            d.macro_folders.push(m.folder.clone());
        }
        Ok(m.id.clone())
    })
}

#[tauri::command]
pub fn macro_delete(st: State<'_, AppState>, id: String) -> Res<()> {
    st.vault().update(|d| {
        d.macros.retain(|m| m.id != id);
        for s in d.sessions.iter_mut() {
            if s.post_connect_macro.as_deref() == Some(id.as_str()) {
                s.post_connect_macro = None;
            }
        }
        Ok(())
    })
}

/// Copy a macro as "<name> copy", "<name> copy 2", ... (placed right after it).
#[tauri::command]
pub fn macro_duplicate(st: State<'_, AppState>, id: String) -> Res<String> {
    st.vault().update(|d| {
        let i = d.macros.iter().position(|m| m.id == id).ok_or_else(|| CoreError::not_found("macro"))?;
        let mut copy = d.macros[i].clone();
        let used: std::collections::HashSet<&str> = d.macros.iter().map(|m| m.name.as_str()).collect();
        let base = format!("{} copy", copy.name);
        let mut name = base.clone();
        let mut n = 2;
        while used.contains(name.as_str()) {
            name = format!("{base} {n}");
            n += 1;
        }
        copy.name = name;
        copy.id = new_id();
        let new = copy.id.clone();
        d.macros.insert(i + 1, copy);
        Ok(new)
    })
}

/// Move a macro to another folder ("" = top level), e.g. after drag and drop.
#[tauri::command]
pub fn macro_move(st: State<'_, AppState>, id: String, folder: String) -> Res<()> {
    let folder = normalize_folder(&folder)?;
    st.vault().update(|d| {
        let m = d
            .macros
            .iter_mut()
            .find(|m| m.id == id)
            .ok_or_else(|| CoreError::invalid("That macro is no longer available."))?;
        m.folder = folder.clone();
        if !folder.is_empty() && !d.macro_folders.contains(&folder) {
            d.macro_folders.push(folder.clone());
        }
        Ok(())
    })
}

/// Create a folder, or rename/move one (with everything inside it).
#[tauri::command]
pub fn macro_folder_save(
    st: State<'_, AppState>,
    name: String,
    parent: String,
    old_path: Option<String>,
) -> Res<String> {
    let name = name.trim().to_string();
    if name.is_empty() || name.contains(['/', '\\']) || name == "." || name == ".." {
        return Err(CoreError::invalid("Enter a folder name without slashes."));
    }
    let path = normalize_folder(
        &[parent.as_str(), name.as_str()].iter().filter(|x| !x.is_empty()).cloned().collect::<Vec<_>>().join("/"),
    )?;
    let old = old_path.filter(|p| !p.is_empty());
    if let Some(o) = &old {
        if path.starts_with(&format!("{o}/")) {
            return Err(CoreError::invalid("A folder cannot be moved inside itself."));
        }
    }
    st.vault().update(|d| {
        let mut existing: Vec<String> = d.macro_folders.clone();
        for m in &d.macros {
            let parts: Vec<&str> = m.folder.split('/').filter(|x| !x.is_empty()).collect();
            for i in 1..=parts.len() {
                let p = parts[..i].join("/");
                if !existing.contains(&p) {
                    existing.push(p);
                }
            }
        }
        if old.as_deref() != Some(path.as_str()) && existing.contains(&path) {
            return Err(CoreError::invalid("That folder already exists."));
        }
        let replace = |v: &str| -> String {
            match &old {
                Some(o) if v == o => path.clone(),
                Some(o) if v.starts_with(&format!("{o}/")) => format!("{path}{}", &v[o.len()..]),
                _ => v.to_string(),
            }
        };
        let mut folders: Vec<String> = Vec::new();
        for f in existing.iter().map(|f| replace(f)).chain(std::iter::once(path.clone())) {
            if !folders.contains(&f) {
                folders.push(f);
            }
        }
        d.macro_folders = folders;
        if old.is_some() {
            for m in d.macros.iter_mut() {
                m.folder = replace(&m.folder);
            }
        }
        Ok(path.clone())
    })
}

/// Fill inputs and parse in the backend with the vault's validation mode, so
/// the mode can't be bypassed from the webview.
#[tauri::command]
pub fn macro_render(st: State<'_, AppState>, script: String, values: HashMap<String, String>) -> Res<Vec<Step>> {
    let mode = st.vault().data()?.settings.validation_mode;
    macros::render(&script, &values, mode)
}

/// A local path the user picked in a dialog (or dropped onto the window).
/// The grant is consumed, so the web view can't reuse or invent paths.
fn granted_path(st: &AppState, p: &str) -> Res<PathBuf> {
    let path = PathBuf::from(p);
    if !path.is_absolute() || p.chars().any(char::is_control) {
        return Err(CoreError::invalid("Expected an absolute file path from the file dialog."));
    }
    st.take_grant(&path)?;
    Ok(path)
}

// ---------------------------------------------------------------- file dialogs
//
// Dialogs are opened by the backend, not the web view: the web view has no
// dialog permission at all. Every path the user picks becomes a one-time grant.

fn dialog_for(app: &tauri::AppHandle, purpose: &str) -> Res<tauri_plugin_dialog::FileDialogBuilder<tauri::Wry>> {
    use tauri_plugin_dialog::DialogExt;
    let d = app.dialog().file();
    Ok(match purpose {
        "upload" => d.set_title("Upload files"),
        "download" => d.set_title("Save file"),
        "key" => d.set_title("Choose private key"),
        "import" => d
            .set_title("Import sessions and macros")
            .add_filter("Siakap or MobaXterm export", &["json", "mxtsessions", "ini"])
            .add_filter("All files", &["*"]),
        "export" => d.set_title("Export Siakap backup").add_filter("Siakap backup", &["json"]),
        "log" => d.set_title("Log this session to a file").add_filter("Log file", &["log", "txt"]),
        "text" => d.set_title("Save terminal output").add_filter("Text file", &["txt", "log"]),
        "report" => d.set_title("Save problem report").add_filter("Text file", &["txt"]),
        "image" => d
            .set_title("Choose a wallpaper picture")
            .add_filter("Pictures", &["png", "jpg", "jpeg", "gif", "webp", "bmp"]),
        "theme" => d.set_title("Colour theme").add_filter("Theme (JSON)", &["json"]).add_filter("All files", &["*"]),
        _ => return Err(CoreError::invalid("unknown dialog")),
    })
}

/// Open-file dialog. Returns the chosen paths (granted for one use each).
#[tauri::command]
pub async fn pick_files(
    app: tauri::AppHandle,
    st: State<'_, AppState>,
    purpose: String,
    multiple: bool,
) -> Res<Vec<String>> {
    st.ensure_unlocked()?;
    // Debug builds only: automated tests can't click a native dialog.
    #[cfg(debug_assertions)]
    if let Some(f) = std::env::var_os("SIAKAP_TEST_OPEN_FILE") {
        let p = PathBuf::from(f);
        st.grant([p.clone()]);
        return Ok(vec![p.to_string_lossy().to_string()]);
    }
    let dlg = dialog_for(&app, &purpose)?;
    let picked = tauri::async_runtime::spawn_blocking(move || {
        if multiple {
            dlg.blocking_pick_files().unwrap_or_default()
        } else {
            dlg.blocking_pick_file().into_iter().collect()
        }
    })
    .await
    .map_err(|e| CoreError::Io { message: e.to_string() })?;
    let paths: Vec<PathBuf> = picked.into_iter().filter_map(|f| f.into_path().ok()).collect();
    st.grant(paths.clone());
    Ok(paths.into_iter().map(|p| p.to_string_lossy().to_string()).collect())
}

/// Folder dialog. Returns the chosen folder (granted for one use), or null.
#[tauri::command]
pub async fn pick_folder(app: tauri::AppHandle, st: State<'_, AppState>, purpose: String) -> Res<Option<String>> {
    use tauri_plugin_dialog::DialogExt;
    st.ensure_unlocked()?;
    let title = match purpose.as_str() {
        "upload-folder" => "Upload a folder",
        "download-folder" => "Download into this folder",
        _ => return Err(CoreError::invalid("unknown dialog")),
    };
    // Debug builds only: automated tests can't click a native dialog.
    #[cfg(debug_assertions)]
    if let Some(dir) =
        std::env::var_os(if purpose == "upload-folder" { "SIAKAP_TEST_OPEN_FOLDER" } else { "SIAKAP_TEST_SAVE_DIR" })
    {
        let p = PathBuf::from(dir);
        st.grant([p.clone()]);
        return Ok(Some(p.to_string_lossy().to_string()));
    }
    let dlg = app.dialog().file().set_title(title);
    let picked = tauri::async_runtime::spawn_blocking(move || dlg.blocking_pick_folder())
        .await
        .map_err(|e| CoreError::Io { message: e.to_string() })?;
    let Some(path) = picked.and_then(|f| f.into_path().ok()) else { return Ok(None) };
    st.grant([path.clone()]);
    Ok(Some(path.to_string_lossy().to_string()))
}

/// Save-file dialog. Returns the chosen path (granted for one use), or null.
#[tauri::command]
pub async fn pick_save(
    app: tauri::AppHandle,
    st: State<'_, AppState>,
    purpose: String,
    default_name: String,
) -> Res<Option<String>> {
    st.ensure_unlocked()?;
    let name: String = default_name.chars().filter(|c| !c.is_control() && !matches!(c, '/' | '\\')).take(200).collect();
    // Debug builds only: automated tests can't click a native dialog.
    #[cfg(debug_assertions)]
    if let Some(dir) = std::env::var_os("SIAKAP_TEST_SAVE_DIR") {
        let p = PathBuf::from(dir).join(&name);
        st.grant([p.clone()]);
        return Ok(Some(p.to_string_lossy().to_string()));
    }
    let dlg = dialog_for(&app, &purpose)?.set_file_name(name);
    let picked = tauri::async_runtime::spawn_blocking(move || dlg.blocking_save_file())
        .await
        .map_err(|e| CoreError::Io { message: e.to_string() })?;
    let Some(path) = picked.and_then(|f| f.into_path().ok()) else { return Ok(None) };
    st.grant([path.clone()]);
    Ok(Some(path.to_string_lossy().to_string()))
}

/// Test builds only: let the end-to-end tests stand in for a file dialog.
#[cfg(debug_assertions)]
#[tauri::command]
pub fn debug_grant_path(st: State<'_, AppState>, path: String) {
    st.grant([PathBuf::from(path)]);
}

/// Export a Siakap backup: `scope` is "macros" or "all" (sessions without passwords too).
#[tauri::command]
pub async fn backup_export_file(st: State<'_, AppState>, path: String, scope: String) -> Res<usize> {
    let path = granted_path(&st, &path)?;
    let (value, n) = {
        let v = st.vault();
        let d = v.data()?;
        let sc = if scope == "all" { backup::Scope::All } else { backup::Scope::Macros };
        (backup::export(d, sc), d.macros.len())
    };
    atomic_write(&path, serde_json::to_string_pretty(&value)?.as_bytes())?;
    Ok(n)
}

/// Import a Siakap backup (from Siakap Terminal or the Siakap Tabby plugin).
#[tauri::command]
pub async fn backup_import_file(st: State<'_, AppState>, path: String) -> Res<ImportReport> {
    let path = granted_path(&st, &path)?;
    let meta = std::fs::metadata(&path)?;
    if meta.len() as usize > backup::MAX_BACKUP_BYTES {
        return Err(CoreError::invalid("Choose a backup smaller than 20 MB."));
    }
    let text = siakap_core::mobaxterm::decode(&std::fs::read(&path)?);
    if siakap_core::mobaxterm::looks_like_mobaxterm(&text) {
        let shells: Vec<String> = pty::known_shells().into_iter().map(|s| s.id).collect();
        let r = st.vault().update(|d| siakap_core::mobaxterm::import(&text, d, &shells))?;
        return Ok(ImportReport {
            macros: r.macros,
            duplicates: r.duplicate_macros,
            startup_session_ids: r.startup_session_ids,
            sessions: r.sessions,
            skipped_sessions: r.duplicates + r.skipped.values().sum::<usize>(),
            invalid: r.invalid,
            startup_disabled: r.startup_disabled,
            needs_review: r.needs_review,
            skipped_types: r.skipped,
            source: "mobaxterm".into(),
        });
    }
    st.vault().update(|d| backup::import(&text, d))
}

// ---------------------------------------------------------------- settings & known hosts

#[tauri::command]
pub fn settings_get(st: State<'_, AppState>) -> Res<Settings> {
    Ok(st.vault().data()?.settings.clone())
}

#[tauri::command]
pub fn settings_save(st: State<'_, AppState>, settings: Settings) -> Res<Settings> {
    let mut s = settings.sanitized();
    st.vault().update(|d| {
        // The log folder is only set by log_folder_pick (a backend dialog).
        s.log_dir = d.settings.log_dir.clone();
        d.settings = s.clone();
        Ok(())
    })?;
    Ok(s)
}

#[tauri::command]
pub fn known_hosts_list(st: State<'_, AppState>) -> Res<Vec<KnownHost>> {
    Ok(st.vault().data()?.known_hosts.clone())
}

#[tauri::command]
pub fn known_host_remove(st: State<'_, AppState>, host: String, port: u16) -> Res<()> {
    st.vault().update(|d| {
        d.known_hosts.retain(|k| !(k.host.eq_ignore_ascii_case(&host) && k.port == port));
        Ok(())
    })
}

/// Store a host key after the user approved its fingerprint. Only for hosts
/// with no stored key: a *changed* key is never accepted from here.
#[tauri::command]
pub fn trust_host_key(
    st: State<'_, AppState>,
    host: String,
    port: u16,
    fingerprint: String,
    public_key: String,
) -> Res<()> {
    let key =
        russh::keys::PublicKey::from_openssh(public_key.trim()).map_err(|_| CoreError::invalid("Invalid host key."))?;
    let presented = ssh::describe_key(&key);
    if presented.fingerprint != fingerprint {
        return Err(CoreError::invalid("The fingerprint does not match the key."));
    }
    let host = validate_host(&host)?.to_ascii_lowercase();
    // Only a key that a server actually presented in a refused connection can
    // be trusted, so the web view can't plant an arbitrary key.
    match st.take_pending_host_key(&host, port) {
        Some(k) if k.trim() == public_key.trim() => {}
        _ => return Err(CoreError::invalid("Connect to the server again, then confirm its fingerprint.")),
    }
    st.vault().update(|d| match ssh::check_host_key(&d.known_hosts, &host, port, &presented) {
        ssh::HostKeyVerdict::Trusted => Ok(()),
        ssh::HostKeyVerdict::Changed(_) => Err(CoreError::invalid(
            "A different key is already stored for this host. Remove it in Settings → Known hosts first.",
        )),
        ssh::HostKeyVerdict::Unknown => {
            d.known_hosts.push(ssh::known_host_entry(&host, port, &presented));
            Ok(())
        }
    })
}

// ---------------------------------------------------------------- terminals

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TermOut {
    Data { b64: String },
    Exit { code: Option<i32> },
}

fn sink_for(channel: Channel<TermOut>, log: LogSlot) -> EventSink {
    Arc::new(move |e| {
        let msg = match e {
            TermEvent::Data(d) => {
                let mut g = log.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(l) = g.as_mut() {
                    if l.write(&d).is_err() {
                        *g = None; // disk full or file gone: stop logging, keep the terminal
                    }
                }
                drop(g);
                TermOut::Data { b64: B64.encode(d) }
            }
            TermEvent::Exit(code) => TermOut::Exit { code },
        };
        let _ = channel.send(msg);
    })
}

#[tauri::command]
pub async fn shells_list(st: State<'_, AppState>) -> Res<Vec<ShellInfo>> {
    st.ensure_unlocked()?;
    tauri::async_runtime::spawn_blocking(pty::detect_shells).await.map_err(|e| CoreError::invalid(e.to_string()))
}

#[tauri::command]
pub async fn term_open_local(
    st: State<'_, AppState>,
    shell: String,
    cols: u16,
    rows: u16,
    channel: Channel<TermOut>,
) -> Res<u32> {
    st.ensure_unlocked()?;
    let info = pty::find_shell(&shell)?;
    let log = LogSlot::default();
    let p = LocalPty::spawn(&info, cols, rows, sink_for(channel, log.clone()))?;
    Ok(st.add_term(Term::Local(p), log))
}

/// Connect a saved SSH session. `password`/`passphrase` are only for one-off
/// prompts; saved passwords are looked up here and never leave the backend.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // each is a separate value from the web view
pub async fn term_open_ssh(
    app: tauri::AppHandle,
    st: State<'_, AppState>,
    session_id: String,
    cols: u16,
    rows: u16,
    channel: Channel<TermOut>,
    password: Option<String>,
    passphrase: Option<String>,
    prompts: Channel<serde_json::Value>,
) -> Res<u32> {
    st.ensure_unlocked()?;
    let prompter = kbd_prompter(app.clone(), prompts.clone());
    let (params, forwards) = {
        let v = st.vault();
        let d = v.data()?;
        let s = d.sessions.iter().find(|s| s.id == session_id).ok_or_else(|| CoreError::not_found("session"))?;
        if s.kind != SessionKind::Ssh {
            return Err(CoreError::invalid("Not an SSH session."));
        }
        let saved = d.secrets.get(&s.id).and_then(|x| x.password.clone()).filter(|p| !p.is_empty());
        let mut params = connect_params(d, s, password.filter(|p| !p.is_empty()).or(saved), passphrase, &prompter);
        // Jump hosts, nearest to the target first. Each uses its own saved
        // password (or agent / key); a loop or a missing session is an error.
        let mut chain = vec![s.id.clone()];
        let mut tail = &mut params;
        let mut next = s.jump_session.clone();
        while let Some(jid) = next {
            if chain.contains(&jid) {
                return Err(CoreError::invalid("The jump hosts of this session go round in a circle."));
            }
            if chain.len() > ssh::MAX_JUMPS {
                return Err(CoreError::invalid(format!("Too many jump hosts in a row (at most {}).", ssh::MAX_JUMPS)));
            }
            let j = d.sessions.iter().find(|x| x.id == jid && x.kind == SessionKind::Ssh).ok_or_else(|| {
                CoreError::invalid("This session's jump host no longer exists. Edit the session to pick another.")
            })?;
            let jpw = d.secrets.get(&j.id).and_then(|x| x.password.clone()).filter(|p| !p.is_empty());
            tail.jump = Some(Box::new(connect_params(d, j, jpw, None, &prompter)));
            tail = tail.jump.as_deref_mut().expect("just set");
            chain.push(jid);
            next = j.jump_session.clone();
        }
        (params, s.forwards.clone())
    };
    let conn = match SshConnection::connect(params).await {
        Ok(c) => c,
        Err(e) => {
            if let CoreError::HostKeyUnknown { host, port, public_key, .. } = &e {
                st.set_pending_host_key(host, *port, public_key.clone());
            }
            return Err(e);
        }
    };
    let log = LogSlot::default();
    let shell = conn.open_shell(cols, rows, sink_for(channel, log.clone())).await?;
    let fw = if forwards.iter().any(|f| f.enabled) {
        let (fw, status) = siakap_core::forward::start(&conn, &forwards).await;
        let _ = prompts.send(serde_json::json!({ "forwards": status }));
        Some(fw)
    } else {
        None
    };
    Ok(st.add_term(
        Term::Ssh { shell, conn, sftp: tokio::sync::Mutex::new(None), forwards: std::sync::Mutex::new(fw) },
        log,
    ))
}

fn connect_params(
    d: &siakap_core::model::VaultData,
    s: &siakap_core::model::Session,
    password: Option<String>,
    passphrase: Option<String>,
    prompter: &ssh::Prompter,
) -> ConnectParams {
    ConnectParams {
        host: s.host.clone(),
        port: if s.port == 0 { 22 } else { s.port },
        user: s.user.clone(),
        auth: s.auth,
        key_path: s.key_path.clone(),
        password: password.map(Zeroizing::new),
        passphrase: passphrase.filter(|p| !p.is_empty()).map(Zeroizing::new),
        known_hosts: d.known_hosts.clone(),
        keepalive_secs: d.settings.ssh_keepalive_secs,
        connect_timeout_secs: d.settings.ssh_connect_timeout_secs,
        prompter: Some(prompter.clone()),
        jump: None,
    }
}

/// Ask the user the server's keyboard-interactive questions through the web
/// view: `{id, name, instructions, prompts:[{prompt, echo}]}`; the answer comes
/// back with `ssh_prompt_answer`. Unanswered questions give up after 5 minutes.
fn kbd_prompter(app: tauri::AppHandle, ch: Channel<serde_json::Value>) -> ssh::Prompter {
    use tauri::Manager;
    Arc::new(move |req: ssh::KbdRequest| {
        let ch = ch.clone();
        let app = app.clone();
        Box::pin(async move {
            let st = app.state::<AppState>();
            let id = st.next_kbd_id();
            let (tx, rx) = tokio::sync::oneshot::channel();
            st.kbd_waiters.lock().unwrap_or_else(|e| e.into_inner()).insert(id, tx);
            let msg = serde_json::json!({ "id": id, "server": req.server, "name": req.name, "instructions": req.instructions, "prompts": req.prompts });
            let answer = if ch.send(msg).is_ok() {
                tokio::time::timeout(std::time::Duration::from_secs(300), rx).await.ok().and_then(Result::ok).flatten()
            } else {
                None
            };
            st.kbd_waiters.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
            answer
        })
    })
}

/// The user's answers to keyboard-interactive questions (null = cancelled).
#[tauri::command]
pub fn ssh_prompt_answer(st: State<'_, AppState>, id: u32, answers: Option<Vec<String>>) -> Res<()> {
    let tx = st.kbd_waiters.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
    if let Some(tx) = tx {
        let answers =
            answers.map(|v| v.into_iter().take(16).map(|a| Zeroizing::new(a.chars().take(4096).collect())).collect());
        let _ = tx.send(answers);
    }
    Ok(())
}

#[tauri::command]
pub fn term_write(st: State<'_, AppState>, id: u32, data: String) -> Res<()> {
    st.ensure_unlocked()?;
    match &*st.term(id)? {
        Term::Local(p) => p.write(data.as_bytes()),
        Term::Serial(p) => p.write(data.as_bytes()),
        Term::Ssh { shell, .. } => shell.write(data.into_bytes()),
    }
}

#[tauri::command]
pub fn term_resize(st: State<'_, AppState>, id: u32, cols: u16, rows: u16) -> Res<()> {
    st.ensure_unlocked()?;
    match &*st.term(id)? {
        Term::Local(p) => p.resize(cols, rows),
        Term::Serial(_) => Ok(()), // a serial line has no window size
        Term::Ssh { shell, .. } => shell.resize(cols, rows),
    }
}

#[tauri::command]
pub async fn term_close(st: State<'_, AppState>, id: u32) -> Res<()> {
    if let Some(t) = st.remove_term(id) {
        match &*t {
            Term::Local(p) => p.close(),
            Term::Serial(p) => p.close(),
            Term::Ssh { shell, conn, sftp, forwards } => {
                shell.close();
                drop(forwards.lock().unwrap_or_else(|e| e.into_inner()).take());
                if let Some(s) = sftp.lock().await.take() {
                    s.close().await;
                }
                conn.disconnect().await;
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------- serial

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialPortsView {
    ports: Vec<serial::PortInfo>,
    baud_rates: Vec<u32>,
}

#[tauri::command]
pub async fn serial_ports_list(st: State<'_, AppState>) -> Res<SerialPortsView> {
    st.ensure_unlocked()?;
    let ports = tauri::async_runtime::spawn_blocking(serial::list_ports)
        .await
        .map_err(|e| CoreError::Io { message: e.to_string() })??;
    Ok(SerialPortsView { ports, baud_rates: serial::COMMON_BAUD_RATES.to_vec() })
}

#[tauri::command]
pub async fn term_open_serial(st: State<'_, AppState>, config: SerialConfig, channel: Channel<TermOut>) -> Res<u32> {
    st.ensure_unlocked()?;
    let log = LogSlot::default();
    let sink = sink_for(channel, log.clone());
    let t = tauri::async_runtime::spawn_blocking(move || SerialTerm::open(&config, sink))
        .await
        .map_err(|e| CoreError::Io { message: e.to_string() })??;
    Ok(st.add_term(Term::Serial(t), log))
}

#[tauri::command]
pub async fn term_serial_break(st: State<'_, AppState>, id: u32) -> Res<()> {
    st.ensure_unlocked()?;
    let t = st.term(id)?;
    tauri::async_runtime::spawn_blocking(move || match &*t {
        Term::Serial(p) => p.send_break(),
        _ => Err(CoreError::invalid("Break only applies to serial consoles.")),
    })
    .await
    .map_err(|e| CoreError::Io { message: e.to_string() })?
}

// ---------------------------------------------------------------- sftp

async fn sftp_for(st: &AppState, id: u32) -> Res<Arc<Sftp>> {
    st.ensure_unlocked()?;
    let t = st.term(id)?;
    let Term::Ssh { conn, sftp, .. } = &*t else {
        return Err(CoreError::invalid("SFTP needs an SSH tab."));
    };
    let mut g = sftp.lock().await;
    if let Some(s) = g.as_ref() {
        return Ok(s.clone());
    }
    let s = Arc::new(Sftp::new(conn.open_sftp().await?));
    *g = Some(s.clone());
    Ok(s)
}

#[tauri::command]
pub async fn sftp_home(st: State<'_, AppState>, id: u32) -> Res<String> {
    sftp_for(&st, id).await?.home().await
}

#[tauri::command]
pub async fn sftp_list(st: State<'_, AppState>, id: u32, path: String) -> Res<ListView> {
    let s = sftp_for(&st, id).await?;
    let path = s.canonicalize(&path).await?;
    let entries = s.list(&path).await?;
    Ok(ListView { path, entries })
}

#[derive(Serialize)]
pub struct ListView {
    path: String,
    entries: Vec<Entry>,
}

#[tauri::command]
pub async fn sftp_mkdir(st: State<'_, AppState>, id: u32, dir: String, name: String) -> Res<()> {
    sftp_for(&st, id).await?.mkdir(&dir, &name).await
}

#[tauri::command]
pub async fn sftp_rename(st: State<'_, AppState>, id: u32, path: String, new_name: String) -> Res<()> {
    sftp_for(&st, id).await?.rename(&path, &new_name).await
}

#[tauri::command]
pub async fn sftp_remove(st: State<'_, AppState>, id: u32, path: String, is_dir: bool) -> Res<()> {
    sftp_for(&st, id).await?.remove(&path, is_dir).await
}

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    done: u64,
    total: u64,
    /// Folder transfers only: files finished, files in all, current file.
    #[serde(skip_serializing_if = "Option::is_none")]
    files: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    total_files: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
}

fn progress_cb(ch: Channel<Progress>) -> impl Fn(u64, u64) {
    let last = std::sync::atomic::AtomicU64::new(0);
    move |done, total| {
        // Throttle to ~every 1 MiB, plus the final update.
        if done == total || done - last.load(Ordering::Relaxed) >= 1024 * 1024 {
            last.store(done, Ordering::Relaxed);
            let _ = ch.send(Progress { done, total, ..Default::default() });
        }
    }
}

/// Folder progress: every 1 MiB, whenever a file finishes, and at the end.
fn tree_progress_cb(ch: Channel<Progress>) -> impl Fn(sftp::TreeProgress) {
    let last = std::sync::Mutex::new((0u64, u64::MAX));
    move |p| {
        let mut g = last.lock().unwrap_or_else(|e| e.into_inner());
        if p.done == p.total || p.files != g.1 || p.done.saturating_sub(g.0) >= 1024 * 1024 {
            *g = (p.done, p.files);
            let _ = ch.send(Progress {
                done: p.done,
                total: p.total,
                files: Some(p.files),
                total_files: Some(p.total_files),
                name: Some(p.name),
            });
        }
    }
}

fn register_transfer(st: &AppState, transfer_id: u32) -> Arc<AtomicBool> {
    let flag = Arc::new(AtomicBool::new(false));
    st.transfers.lock().unwrap_or_else(|e| e.into_inner()).insert(transfer_id, flag.clone());
    flag
}

fn finish_transfer(st: &AppState, transfer_id: u32) {
    st.transfers.lock().unwrap_or_else(|e| e.into_inner()).remove(&transfer_id);
}

#[tauri::command]
pub async fn sftp_download(
    st: State<'_, AppState>,
    id: u32,
    transfer_id: u32,
    remote: String,
    local: String,
    progress: Channel<Progress>,
) -> Res<u64> {
    let local = granted_path(&st, &local)?;
    let s = sftp_for(&st, id).await?;
    let flag = register_transfer(&st, transfer_id);
    let r = s.download(&remote, &local, flag, progress_cb(progress)).await;
    finish_transfer(&st, transfer_id);
    r
}

#[tauri::command]
pub async fn sftp_upload(
    st: State<'_, AppState>,
    id: u32,
    transfer_id: u32,
    local: String,
    remote_dir: String,
    overwrite: bool,
    progress: Channel<Progress>,
) -> Res<UploadDone> {
    let local = granted_path(&st, &local)?;
    let s = sftp_for(&st, id).await?;
    let flag = register_transfer(&st, transfer_id);
    // A folder (picked, or dropped onto the panel) goes up with everything in it.
    let is_dir = tokio::fs::symlink_metadata(&local).await.map(|m| m.is_dir()).unwrap_or(false);
    let r = if is_dir {
        s.upload_tree(&local, &remote_dir, overwrite, flag, tree_progress_cb(progress)).await.map(|t| UploadDone {
            path: t.path,
            files: t.files,
            skipped: t.skipped,
        })
    } else {
        s.upload(&local, &remote_dir, overwrite, flag, progress_cb(progress)).await.map(|path| UploadDone {
            path,
            files: 1,
            skipped: vec![],
        })
    };
    finish_transfer(&st, transfer_id);
    // Nothing was sent: the UI asks "replace / merge?" and retries with the
    // same path the user picked, so that one choice stays valid.
    if matches!(r, Err(CoreError::RemoteExists { .. })) {
        st.grant([local]);
    }
    r
}

#[derive(Serialize)]
pub struct UploadDone {
    path: String,
    files: u64,
    skipped: Vec<String>,
}

/// Download a remote folder into a new folder inside `local_dir` (picked in a folder dialog).
#[tauri::command]
pub async fn sftp_download_tree(
    st: State<'_, AppState>,
    id: u32,
    transfer_id: u32,
    remote: String,
    local_dir: String,
    progress: Channel<Progress>,
) -> Res<sftp::TreeSummary> {
    let local = granted_path(&st, &local_dir)?;
    let s = sftp_for(&st, id).await?;
    let flag = register_transfer(&st, transfer_id);
    let r = s.download_tree(&remote, &local, flag, tree_progress_cb(progress)).await;
    finish_transfer(&st, transfer_id);
    r
}

/// Delete a folder and everything in it (the UI confirms first). Cancellable.
#[tauri::command]
pub async fn sftp_remove_tree(
    st: State<'_, AppState>,
    id: u32,
    transfer_id: u32,
    path: String,
    progress: Channel<Progress>,
) -> Res<u64> {
    let s = sftp_for(&st, id).await?;
    let flag = register_transfer(&st, transfer_id);
    let r = s
        .remove_tree(&path, flag, |done, total| {
            if done == total || done % 50 == 0 {
                let _ = progress.send(Progress { done, total, ..Default::default() });
            }
        })
        .await;
    finish_transfer(&st, transfer_id);
    r
}

#[tauri::command]
pub fn sftp_cancel(st: State<'_, AppState>, transfer_id: u32) {
    if let Some(f) = st.transfers.lock().unwrap_or_else(|e| e.into_inner()).get(&transfer_id) {
        f.store(true, Ordering::Relaxed);
    }
}

// ---------------------------------------------------------------- clipboard
// Read and written here rather than with navigator.clipboard, which the web
// view may refuse (it asks for a user gesture or a permission).

const CLIPBOARD_MAX: usize = 8 * 1024 * 1024;

/// One clipboard handle for the app's lifetime (on Linux, copied text is
/// only available while its owner is alive).
fn with_clipboard<T>(
    f: impl FnOnce(&mut arboard::Clipboard) -> Result<T, arboard::Error>,
) -> Result<T, arboard::Error> {
    static CB: std::sync::Mutex<Option<arboard::Clipboard>> = std::sync::Mutex::new(None);
    let mut g = CB.lock().unwrap_or_else(|e| e.into_inner());
    if g.is_none() {
        *g = Some(arboard::Clipboard::new()?);
    }
    let r = f(g.as_mut().expect("clipboard set above"));
    if r.is_err() {
        *g = None; // reopen next time
    }
    r
}

#[tauri::command]
pub async fn clipboard_read(st: State<'_, AppState>) -> Res<String> {
    st.ensure_unlocked()?;
    tauri::async_runtime::spawn_blocking(|| {
        let text = with_clipboard(|c| c.get_text()).unwrap_or_default();
        if text.len() > CLIPBOARD_MAX {
            return Err(CoreError::invalid("The clipboard holds more than 8 MB of text, which is too much to paste."));
        }
        Ok(text)
    })
    .await
    .map_err(|e| CoreError::invalid(e.to_string()))?
}

#[tauri::command]
pub async fn clipboard_write(st: State<'_, AppState>, text: String) -> Res<()> {
    st.ensure_unlocked()?;
    if text.len() > CLIPBOARD_MAX {
        return Err(CoreError::invalid("That selection is too large to copy."));
    }
    tauri::async_runtime::spawn_blocking(move || {
        with_clipboard(|c| c.set_text(text)).map_err(|_| CoreError::invalid("Couldn't copy to the clipboard."))
    })
    .await
    .map_err(|e| CoreError::invalid(e.to_string()))?
}

// ---------------------------------------------------------------- session logs

/// Start logging a terminal to a file the user picked in a save dialog.
#[tauri::command]
pub async fn term_log_start(
    st: State<'_, AppState>,
    id: u32,
    path: String,
    title: String,
    tz_offset: i32,
) -> Res<String> {
    st.ensure_unlocked()?;
    let path = granted_path(&st, &path)?;
    let slot = st.log_slot(id)?;
    let stamps = st.vault().data()?.settings.log_timestamps.then_some(tz_offset);
    let log = termlog::SessionLog::create(&path, &title, stamps)?;
    let shown = log.path.to_string_lossy().to_string();
    *slot.lock().unwrap_or_else(|e| e.into_inner()) = Some(log);
    Ok(shown)
}

/// Start logging into the log folder chosen in Settings (automatic logging).
#[tauri::command]
pub async fn term_log_auto(
    st: State<'_, AppState>,
    id: u32,
    title: String,
    stamp: String,
    tz_offset: i32,
) -> Res<String> {
    st.ensure_unlocked()?;
    let (dir, stamps) = {
        let v = st.vault();
        let s = &v.data()?.settings;
        if !s.log_auto || s.log_dir.is_empty() {
            return Err(CoreError::invalid("Automatic session logs are turned off."));
        }
        (PathBuf::from(&s.log_dir), s.log_timestamps.then_some(tz_offset))
    };
    let slot = st.log_slot(id)?;
    let log = termlog::SessionLog::in_folder(&dir, &stamp, &title, stamps)?;
    let shown = log.path.to_string_lossy().to_string();
    *slot.lock().unwrap_or_else(|e| e.into_inner()) = Some(log);
    Ok(shown)
}

#[tauri::command]
pub fn term_log_stop(st: State<'_, AppState>, id: u32) -> Res<()> {
    st.ensure_unlocked()?;
    st.log_slot(id)?.lock().unwrap_or_else(|e| e.into_inner()).take();
    Ok(())
}

/// Choose the folder for automatic session logs. Only this backend dialog can
/// set it (settings_save keeps the stored value), so the web view can't point
/// logs somewhere you didn't pick.
#[tauri::command]
pub async fn log_folder_pick(app: tauri::AppHandle, st: State<'_, AppState>) -> Res<Option<String>> {
    use tauri_plugin_dialog::DialogExt;
    st.ensure_unlocked()?;
    // Debug builds only: automated tests can't click a native dialog.
    #[cfg(debug_assertions)]
    let test_dir = std::env::var_os("SIAKAP_TEST_LOG_DIR").map(PathBuf::from);
    #[cfg(not(debug_assertions))]
    let test_dir: Option<PathBuf> = None;
    let dir = match test_dir {
        Some(d) => d,
        None => {
            let dlg = app.dialog().file().set_title("Folder for session logs");
            let picked = tauri::async_runtime::spawn_blocking(move || dlg.blocking_pick_folder())
                .await
                .map_err(|e| CoreError::Io { message: e.to_string() })?;
            let Some(dir) = picked.and_then(|f| f.into_path().ok()) else { return Ok(None) };
            dir
        }
    };
    let shown = dir.to_string_lossy().to_string();
    st.vault().update(|d| {
        d.settings.log_dir = shown.clone();
        Ok(())
    })?;
    Ok(Some(shown))
}

/// Read a colour theme file picked in an open dialog (parsed in the web view;
/// only colours that pass validation are ever stored).
#[tauri::command]
pub async fn theme_read_file(st: State<'_, AppState>, path: String) -> Res<String> {
    st.ensure_unlocked()?;
    let path = granted_path(&st, &path)?;
    if std::fs::metadata(&path)?.len() > 256 * 1024 {
        return Err(CoreError::invalid("That file is too large to be a colour theme."));
    }
    let text =
        std::fs::read_to_string(&path).map_err(|_| CoreError::invalid("That file isn't a text colour theme."))?;
    Ok(text)
}

/// Save a snapshot of a terminal's text to a file picked in a save dialog.
#[tauri::command]
pub async fn save_text_file(st: State<'_, AppState>, path: String, text: String) -> Res<()> {
    st.ensure_unlocked()?;
    if text.len() > 64 * 1024 * 1024 {
        return Err(CoreError::invalid("That is too much text to save at once."));
    }
    let path = granted_path(&st, &path)?;
    termlog::save_text(&path, &text)
}

// ---------------------------------------------------------------- updates

/// Ask GitHub for the latest release. Only ever runs when the user clicks
/// "Check for updates"; Siakap never checks on its own.
#[tauri::command]
pub async fn update_check(st: State<'_, AppState>) -> Res<siakap_core::update::UpdateInfo> {
    st.ensure_unlocked()?;
    // Debug builds only: tests can pretend to be an older version.
    #[cfg(debug_assertions)]
    let current = std::env::var("SIAKAP_TEST_VERSION").unwrap_or_else(|_| env!("CARGO_PKG_VERSION").to_string());
    #[cfg(not(debug_assertions))]
    let current = env!("CARGO_PKG_VERSION").to_string();
    // Debug builds pretending to be older (tests) still get the installer
    // everywhere, so the download and checksum steps can be tested off Windows.
    #[cfg(debug_assertions)]
    let check = if std::env::var_os("SIAKAP_TEST_VERSION").is_some_and(|v| !v.is_empty()) {
        siakap_core::update::check_any
    } else {
        siakap_core::update::check
    };
    #[cfg(not(debug_assertions))]
    let check = siakap_core::update::check;
    let info = tauri::async_runtime::spawn_blocking(move || check(&current))
        .await
        .map_err(|e| CoreError::invalid(e.to_string()))??;
    *st.update.lock().unwrap_or_else(|e| e.into_inner()) = (Some(info.clone()), None);
    Ok(info)
}

/// Download the installer of the release found by the last check, and verify
/// it against the release's SHA256SUMS.txt. Progress is `{done, total}` bytes.
#[tauri::command]
pub async fn update_download(st: State<'_, AppState>, progress: Channel<serde_json::Value>) -> Res<String> {
    st.ensure_unlocked()?;
    let info = st
        .update
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .0
        .clone()
        .ok_or_else(|| CoreError::invalid("Check for updates first."))?;
    if !info.newer {
        return Err(CoreError::invalid("You already have the latest version."));
    }
    let dir = std::env::temp_dir().join("siakap-update");
    let path = tauri::async_runtime::spawn_blocking(move || {
        let mut last = 0u64;
        siakap_core::update::download_installer(&info, &dir, &mut |done, total| {
            // About one message per percent.
            if total == 0 || done == total || done - last >= (total / 100).max(65_536) {
                last = done;
                let _ = progress.send(serde_json::json!({ "done": done, "total": total }));
            }
        })
    })
    .await
    .map_err(|e| CoreError::invalid(e.to_string()))??;
    let shown = path.to_string_lossy().to_string();
    st.update.lock().unwrap_or_else(|e| e.into_inner()).1 = Some(path);
    Ok(shown)
}

/// Run the downloaded, verified installer (passive, then it starts Siakap
/// again) and close Siakap so it can be replaced.
#[tauri::command]
pub fn update_install(app: tauri::AppHandle, st: State<'_, AppState>) -> Res<()> {
    st.ensure_unlocked()?;
    let path = st
        .update
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .1
        .clone()
        .ok_or_else(|| CoreError::invalid("Download the update first."))?;
    siakap_core::update::run_installer(&path)?;
    st.lock_vault();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(300));
        app.exit(0);
    });
    Ok(())
}

/// Open Siakap's release page in the browser (no other address is accepted).
#[tauri::command]
pub fn open_release_page(st: State<'_, AppState>, url: String) -> Res<()> {
    st.ensure_unlocked()?;
    siakap_core::update::open_page(&url)
}

// ---------------------------------------------------------------- bug reports

/// Facts about this installation for "Report a problem": versions, counts and
/// settings. No passwords, keys, terminal contents or session details.
#[tauri::command]
pub async fn diag_info(app: tauri::AppHandle, st: State<'_, AppState>) -> Res<serde_json::Value> {
    st.ensure_unlocked()?;
    let os = tauri::async_runtime::spawn_blocking(|| {
        #[cfg(windows)]
        {
            let cmd = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".into());
            siakap_core::process::run_capture_timeout(&cmd, &["/c", "ver"], std::time::Duration::from_secs(3))
                .map(|o| o.stdout.trim().to_string())
                .unwrap_or_default()
        }
        #[cfg(not(windows))]
        {
            std::fs::read_to_string("/proc/sys/kernel/osrelease")
                .map(|s| format!("Linux {}", s.trim()))
                .unwrap_or_default()
        }
    })
    .await
    .unwrap_or_default();
    let data_dir =
        tauri::Manager::path(&app).app_data_dir().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
    let (vault, settings) = {
        let v = st.vault();
        let d = v.data()?;
        let kinds = |k: SessionKind| d.sessions.iter().filter(|s| s.kind == k).count();
        let counts = serde_json::json!({
            "sessions": { "ssh": kinds(SessionKind::Ssh), "local": kinds(SessionKind::Local), "serial": kinds(SessionKind::Serial) },
            "sessionFolders": d.folders.len(),
            "macros": d.macros.len(),
            "macroFolders": d.macro_folders.len(),
            "trustedServers": d.known_hosts.len(),
            "savedPasswords": d.secrets.values().filter(|s| s.password.as_deref().is_some_and(|p| !p.is_empty())).count(),
            "passwordless": d.passwordless,
        });
        (counts, serde_json::to_value(&d.settings).unwrap_or_default())
    };
    let shells: Vec<String> = pty::known_shells().into_iter().map(|s| s.label).collect();
    Ok(serde_json::json!({
        "app": env!("CARGO_PKG_VERSION"),
        "os": os,
        "platform": format!("{} {}", std::env::consts::OS, std::env::consts::ARCH),
        "webview": tauri::webview_version().unwrap_or_default(),
        "tauri": tauri::VERSION,
        "dataDir": data_dir,
        "openTerminals": st.term_count(),
        "shells": shells,
        "usbipd": siakap_core::process::which("usbipd").is_some() || cfg!(windows) && std::path::Path::new("C:\\Program Files\\usbipd-win\\usbipd.exe").exists(),
        "vault": vault,
        "settings": settings,
        "crashes": crate::earlier_crashes(),
    }))
}

// ---------------------------------------------------------------- wallpapers

fn wallpaper_dir(app: &tauri::AppHandle) -> Res<PathBuf> {
    tauri::Manager::path(app).app_data_dir().map_err(|e| CoreError::Io { message: e.to_string() })
}

fn wallpaper_files(dir: &std::path::Path, stem: &str) -> Vec<PathBuf> {
    siakap_core::wallpaper::EXTENSIONS.iter().map(|e| dir.join(format!("{stem}.{e}"))).filter(|p| p.exists()).collect()
}

/// Pick a picture for the app ("app") or terminal ("term") wallpaper. It must
/// really be an image; it is copied into the app's data folder. Returns false
/// when the dialog was cancelled.
#[tauri::command]
pub async fn wallpaper_pick(app: tauri::AppHandle, st: State<'_, AppState>, target: String) -> Res<bool> {
    st.ensure_unlocked()?;
    let stem = siakap_core::wallpaper::stem(&target).ok_or_else(|| CoreError::invalid("unknown wallpaper"))?;
    #[cfg(debug_assertions)]
    let test_file = std::env::var_os("SIAKAP_TEST_IMAGE").map(PathBuf::from);
    #[cfg(not(debug_assertions))]
    let test_file: Option<PathBuf> = None;
    let path = match test_file {
        Some(p) => p,
        None => {
            let dlg = dialog_for(&app, "image")?;
            let picked = tauri::async_runtime::spawn_blocking(move || dlg.blocking_pick_file())
                .await
                .map_err(|e| CoreError::Io { message: e.to_string() })?;
            match picked.and_then(|f| f.into_path().ok()) {
                Some(p) => p,
                None => return Ok(false),
            }
        }
    };
    let dir = wallpaper_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || -> Res<()> {
        let meta = std::fs::metadata(&path)?;
        if meta.len() as usize > siakap_core::wallpaper::MAX_BYTES {
            return Err(CoreError::invalid("That picture is too large (the limit is 25 MB)."));
        }
        let bytes = std::fs::read(&path)?;
        let (_, ext) = siakap_core::wallpaper::image_kind(&bytes)
            .ok_or_else(|| CoreError::invalid("That file isn't a PNG, JPEG, GIF, WebP or BMP picture."))?;
        std::fs::create_dir_all(&dir)?;
        for old in wallpaper_files(&dir, stem) {
            let _ = std::fs::remove_file(old);
        }
        atomic_write(&dir.join(format!("{stem}.{ext}")), &bytes)?;
        Ok(())
    })
    .await
    .map_err(|e| CoreError::Io { message: e.to_string() })??;
    Ok(true)
}

/// The wallpaper picture as a data: URL (shown by the web view), if one is set.
#[tauri::command]
pub async fn wallpaper_get(app: tauri::AppHandle, st: State<'_, AppState>, target: String) -> Res<Option<String>> {
    st.ensure_unlocked()?;
    let stem = siakap_core::wallpaper::stem(&target).ok_or_else(|| CoreError::invalid("unknown wallpaper"))?;
    let dir = wallpaper_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || -> Res<Option<String>> {
        let Some(p) = wallpaper_files(&dir, stem).into_iter().next() else { return Ok(None) };
        let bytes = std::fs::read(p)?;
        if bytes.len() > siakap_core::wallpaper::MAX_BYTES {
            return Ok(None);
        }
        Ok(siakap_core::wallpaper::image_kind(&bytes)
            .map(|(mime, _)| format!("data:{mime};base64,{}", B64.encode(&bytes))))
    })
    .await
    .map_err(|e| CoreError::Io { message: e.to_string() })?
}

/// Remove a wallpaper picture.
#[tauri::command]
pub fn wallpaper_clear(app: tauri::AppHandle, st: State<'_, AppState>, target: String) -> Res<()> {
    st.ensure_unlocked()?;
    let stem = siakap_core::wallpaper::stem(&target).ok_or_else(|| CoreError::invalid("unknown wallpaper"))?;
    for p in wallpaper_files(&wallpaper_dir(&app)?, stem) {
        let _ = std::fs::remove_file(p);
    }
    Ok(())
}

/// See-through window: "acrylic" (Windows blurs what's behind the window),
/// "clear", or "none". The page decides what is see-through.
#[tauri::command]
pub fn window_backdrop(app: tauri::AppHandle, kind: String) -> Res<()> {
    use tauri::window::{Color, Effect, EffectsBuilder};
    if !matches!(kind.as_str(), "acrylic" | "clear" | "none") {
        return Err(CoreError::invalid("unknown backdrop"));
    }
    let Some(w) = tauri::Manager::get_webview_window(&app, "main") else { return Ok(()) };
    let io = |e: tauri::Error| CoreError::Io { message: e.to_string() };
    // The window keeps a solid background unless the page wants to be see-through.
    let see_through = kind != "none";
    w.set_background_color(Some(if see_through { Color(0, 0, 0, 0) } else { Color(13, 17, 23, 255) })).map_err(io)?;
    match kind.as_str() {
        // macOS has no Acrylic; its own frosted "under window" material is the match.
        #[cfg(target_os = "macos")]
        "acrylic" => w
            .set_effects(
                EffectsBuilder::new()
                    .effect(Effect::UnderWindowBackground)
                    .state(tauri::window::EffectState::FollowsWindowActiveState)
                    .build(),
            )
            .map_err(io),
        #[cfg(not(target_os = "macos"))]
        "acrylic" => w.set_effects(EffectsBuilder::new().effect(Effect::Acrylic).build()).map_err(io),
        "clear" | "none" => w.set_effects(None).map_err(io),
        _ => Err(CoreError::invalid("unknown backdrop")),
    }
}

// ---------------------------------------------------------------- preview panel

/// Argon2 takes about half a second: never on the UI's thread.
#[tauri::command]
pub async fn admin_check(password: String) -> bool {
    tauri::async_runtime::spawn_blocking(move || siakap_core::admin::check(&password)).await.unwrap_or(false)
}

// ---------------------------------------------------------------- fonts

/// Font families installed on this PC (for the font picker).
#[tauri::command]
pub async fn fonts_list(st: State<'_, AppState>) -> Res<Vec<siakap_core::fonts::FontFamily>> {
    st.ensure_unlocked()?;
    tauri::async_runtime::spawn_blocking(siakap_core::fonts::installed)
        .await
        .map_err(|e| CoreError::invalid(e.to_string()))
}

// ---------------------------------------------------------------- security key

#[tauri::command]
pub async fn security_key_state(st: State<'_, AppState>) -> Res<Vec<security_key::Device>> {
    st.ensure_unlocked()?;
    tauri::async_runtime::spawn_blocking(security_key::state).await.map_err(|e| CoreError::usbipd(e.to_string()))?
}

#[tauri::command]
pub async fn security_key_action(
    st: State<'_, AppState>,
    action: String,
    device: security_key::Selection,
) -> Res<security_key::Outcome> {
    st.ensure_unlocked()?;
    let attach = match action.as_str() {
        "attach" => true,
        "detach" => false,
        _ => return Err(CoreError::usbipd("Unknown action.")),
    };
    tauri::async_runtime::spawn_blocking(move || security_key::act(attach, &device))
        .await
        .map_err(|e| CoreError::usbipd(e.to_string()))?
}
