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

use siakap_core::macros::{self, ImportReport, Step};
use siakap_core::model::{
    new_id, normalize_folder, validate_host, validate_name, validate_user, KnownHost, Macro, RedactedSession, Session,
    SessionKind, SessionSecret, Settings,
};
use siakap_core::pty::{self, EventSink, LocalPty, ShellInfo, TermEvent};
use siakap_core::sftp::{Entry, Sftp};
use siakap_core::ssh::{self, ConnectParams, SshConnection};
use siakap_core::vault::atomic_write;
use siakap_core::yubikey;
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
    st.vault().unlock(&password)?;
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
        if clear_password || session.kind == SessionKind::Local {
            d.secrets.remove(&session.id);
        } else if let Some(pw) = &password {
            if !pw.is_empty() {
                d.secrets.insert(session.id.clone(), SessionSecret { password: Some(pw.to_string()) });
            }
        }
        Ok(session.id.clone())
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
    if m.script.len() > 256 * 1024 {
        return Err(CoreError::invalid("Macros are limited to 256 KiB."));
    }
    macros::parse(&m.script)?;
    st.vault().update(|d| {
        let sig = macros::signature(&m.script);
        if let Some(dup) = d.macros.iter().find(|x| x.id != m.id && macros::signature(&x.script) == sig) {
            return Err(CoreError::invalid(format!("This script is identical to the macro \"{}\".", dup.name)));
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

/// Parse + substitute + validate in the backend with the vault's validation
/// mode, so the mode can't be bypassed from the webview.
#[tauri::command]
pub fn macro_render(st: State<'_, AppState>, script: String, values: HashMap<String, String>) -> Res<Vec<Step>> {
    let mode = st.vault().data()?.settings.validation_mode;
    let steps = macros::parse(&script)?;
    macros::render(&steps, &values, mode)
}

fn user_file_path(p: &str) -> Res<PathBuf> {
    let path = PathBuf::from(p);
    if !path.is_absolute() || p.chars().any(char::is_control) {
        return Err(CoreError::invalid("Expected an absolute file path from the file dialog."));
    }
    Ok(path)
}

#[tauri::command]
pub fn macros_export_file(st: State<'_, AppState>, path: String, ids: Option<Vec<String>>) -> Res<usize> {
    let path = user_file_path(&path)?;
    let list: Vec<Macro> = {
        let v = st.vault();
        let d = v.data()?;
        d.macros.iter().filter(|m| ids.as_ref().is_none_or(|ids| ids.contains(&m.id))).cloned().collect()
    };
    atomic_write(&path, macros::export(&list)?.as_bytes())?;
    Ok(list.len())
}

#[tauri::command]
pub fn macros_import_file(st: State<'_, AppState>, path: String) -> Res<ImportReport> {
    let path = user_file_path(&path)?;
    let meta = std::fs::metadata(&path)?;
    if meta.len() as usize > macros::MAX_IMPORT_BYTES {
        return Err(CoreError::invalid("The import file is too large."));
    }
    let json = std::fs::read_to_string(&path)?;
    st.vault().update(|d| {
        let rep = macros::import(&json, &mut d.macros)?;
        for m in &d.macros {
            if !m.folder.is_empty() && !d.macro_folders.contains(&m.folder) {
                d.macro_folders.push(m.folder.clone());
            }
        }
        Ok(rep)
    })
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
pub fn shells_list() -> Vec<ShellInfo> {
    pty::detect_shells()
}

#[tauri::command]
pub async fn term_open_local(
    st: State<'_, AppState>,
    shell: String,
    cols: u16,
    rows: u16,
    channel: Channel<TermOut>,
) -> Res<u32> {
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
    let conn = SshConnection::connect(params).await?;
    let shell = conn.open_shell(cols, rows, sink_for(channel)).await?;
    Ok(st.add_term(Term::Ssh { shell, conn, sftp: tokio::sync::Mutex::new(None) }))
}

#[tauri::command]
pub fn term_write(st: State<'_, AppState>, id: u32, data: String) -> Res<()> {
    match &*st.term(id)? {
        Term::Local(p) => p.write(data.as_bytes()),
        Term::Ssh { shell, .. } => shell.write(data.into_bytes()),
    }
}

#[tauri::command]
pub fn term_resize(st: State<'_, AppState>, id: u32, cols: u16, rows: u16) -> Res<()> {
    match &*st.term(id)? {
        Term::Local(p) => p.resize(cols, rows),
        Term::Ssh { shell, .. } => shell.resize(cols, rows),
    }
}

#[tauri::command]
pub async fn term_close(st: State<'_, AppState>, id: u32) -> Res<()> {
    if let Some(t) = st.remove_term(id) {
        match &*t {
            Term::Local(p) => p.close(),
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

// ---------------------------------------------------------------- sftp

async fn sftp_for(st: &AppState, id: u32) -> Res<Arc<Sftp>> {
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
    let local = user_file_path(&local)?;
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
    progress: Channel<Progress>,
) -> Res<String> {
    let local = user_file_path(&local)?;
    let s = sftp_for(&st, id).await?;
    let flag = register_transfer(&st, transfer_id);
    let r = s.upload(&local, &remote_dir, flag, progress_cb(progress)).await;
    finish_transfer(&st, transfer_id);
    r
}

#[tauri::command]
pub fn sftp_cancel(st: State<'_, AppState>, transfer_id: u32) {
    if let Some(f) = st.transfers.lock().unwrap_or_else(|e| e.into_inner()).get(&transfer_id) {
        f.store(true, Ordering::Relaxed);
    }
}

// ---------------------------------------------------------------- yubikey

#[tauri::command]
pub async fn yubikey_state() -> Res<Vec<yubikey::Device>> {
    tauri::async_runtime::spawn_blocking(yubikey::state).await.map_err(|e| CoreError::usbipd(e.to_string()))?
}

#[tauri::command]
pub async fn yubikey_toggle() -> Res<yubikey::Plan> {
    tauri::async_runtime::spawn_blocking(yubikey::toggle).await.map_err(|e| CoreError::usbipd(e.to_string()))?
}
