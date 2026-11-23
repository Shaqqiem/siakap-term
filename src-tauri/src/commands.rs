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
use siakap_core::security_key;
use siakap_core::serial::{self, SerialConfig, SerialTerm};
use siakap_core::sftp::{Entry, Sftp};
use siakap_core::ssh::{self, ConnectParams, SshConnection};
use siakap_core::vault::atomic_write;
use siakap_core::CoreError;

use crate::state::{AppState, Term};

type Res<T> = std::result::Result<T, CoreError>;

// ---------------------------------------------------------------- vault

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatus {
    exists: bool,
    unlocked: bool,
}

#[tauri::command]
pub fn vault_status(st: State<'_, AppState>) -> VaultStatus {
    let v = st.vault();
    VaultStatus { exists: v.exists(), unlocked: v.is_unlocked() }
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
    st.vault().change_password(&old, &new)
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
        }
        SessionKind::Local => {
            session.host.clear();
            session.user.clear();
            session.key_path.clear();
        }
        SessionKind::Serial => {
            session.serial = session.serial.validated()?;
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
pub fn backup_export_file(st: State<'_, AppState>, path: String, scope: String) -> Res<usize> {
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
pub fn backup_import_file(st: State<'_, AppState>, path: String) -> Res<ImportReport> {
    let path = granted_path(&st, &path)?;
    let meta = std::fs::metadata(&path)?;
    if meta.len() as usize > backup::MAX_BACKUP_BYTES {
        return Err(CoreError::invalid("Choose a backup smaller than 20 MB."));
    }
    let text = siakap_core::mobaxterm::decode(&std::fs::read(&path)?);
    if siakap_core::mobaxterm::looks_like_mobaxterm(&text) {
        let shells: Vec<String> = pty::detect_shells().into_iter().map(|s| s.id).collect();
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
    let s = settings.sanitized();
    st.vault().update(|d| {
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

fn sink_for(channel: Channel<TermOut>) -> EventSink {
    Arc::new(move |e| {
        let msg = match e {
            TermEvent::Data(d) => TermOut::Data { b64: B64.encode(d) },
            TermEvent::Exit(code) => TermOut::Exit { code },
        };
        let _ = channel.send(msg);
    })
}

#[tauri::command]
pub fn shells_list(st: State<'_, AppState>) -> Res<Vec<ShellInfo>> {
    st.ensure_unlocked()?;
    Ok(pty::detect_shells())
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
    let p = LocalPty::spawn(&info, cols, rows, sink_for(channel))?;
    Ok(st.add_term(Term::Local(p)))
}

/// Connect a saved SSH session. `password`/`passphrase` are only for one-off
/// prompts; saved passwords are looked up here and never leave the backend.
#[tauri::command]
pub async fn term_open_ssh(
    st: State<'_, AppState>,
    session_id: String,
    cols: u16,
    rows: u16,
    channel: Channel<TermOut>,
    password: Option<String>,
    passphrase: Option<String>,
) -> Res<u32> {
    st.ensure_unlocked()?;
    let params = {
        let v = st.vault();
        let d = v.data()?;
        let s = d.sessions.iter().find(|s| s.id == session_id).ok_or_else(|| CoreError::not_found("session"))?;
        if s.kind != SessionKind::Ssh {
            return Err(CoreError::invalid("Not an SSH session."));
        }
        let saved = d.secrets.get(&s.id).and_then(|x| x.password.clone()).filter(|p| !p.is_empty());
        ConnectParams {
            host: s.host.clone(),
            port: if s.port == 0 { 22 } else { s.port },
            user: s.user.clone(),
            auth: s.auth,
            key_path: s.key_path.clone(),
            password: password.filter(|p| !p.is_empty()).or(saved).map(Zeroizing::new),
            passphrase: passphrase.filter(|p| !p.is_empty()).map(Zeroizing::new),
            known_hosts: d.known_hosts.clone(),
        }
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
    let shell = conn.open_shell(cols, rows, sink_for(channel)).await?;
    Ok(st.add_term(Term::Ssh { shell, conn, sftp: tokio::sync::Mutex::new(None) }))
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
            Term::Ssh { shell, conn, sftp } => {
                shell.close();
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
    let sink = sink_for(channel);
    let t = tauri::async_runtime::spawn_blocking(move || SerialTerm::open(&config, sink))
        .await
        .map_err(|e| CoreError::Io { message: e.to_string() })??;
    Ok(st.add_term(Term::Serial(t)))
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

#[derive(Clone, Serialize)]
pub struct Progress {
    done: u64,
    total: u64,
}

fn progress_cb(ch: Channel<Progress>) -> impl Fn(u64, u64) {
    let last = std::sync::atomic::AtomicU64::new(0);
    move |done, total| {
        // Throttle to ~every 1 MiB, plus the final update.
        if done == total || done - last.load(Ordering::Relaxed) >= 1024 * 1024 {
            last.store(done, Ordering::Relaxed);
            let _ = ch.send(Progress { done, total });
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
) -> Res<String> {
    let local = granted_path(&st, &local)?;
    let s = sftp_for(&st, id).await?;
    let flag = register_transfer(&st, transfer_id);
    let r = s.upload(&local, &remote_dir, overwrite, flag, progress_cb(progress)).await;
    finish_transfer(&st, transfer_id);
    r
}

#[tauri::command]
pub fn sftp_cancel(st: State<'_, AppState>, transfer_id: u32) {
    if let Some(f) = st.transfers.lock().unwrap_or_else(|e| e.into_inner()).get(&transfer_id) {
        f.store(true, Ordering::Relaxed);
    }
}

// ---------------------------------------------------------------- security key

#[tauri::command]
pub async fn security_key_state(st: State<'_, AppState>) -> Res<Vec<security_key::Device>> {
    st.ensure_unlocked()?;
    tauri::async_runtime::spawn_blocking(security_key::state).await.map_err(|e| CoreError::usbipd(e.to_string()))?
}

#[tauri::command]
pub async fn security_key_toggle(st: State<'_, AppState>) -> Res<security_key::Plan> {
    st.ensure_unlocked()?;
    tauri::async_runtime::spawn_blocking(security_key::toggle).await.map_err(|e| CoreError::usbipd(e.to_string()))?
}
