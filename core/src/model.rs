//! Plain data kept inside the vault, plus folder normalisation.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use zeroize::{Zeroize, ZeroizeOnDrop};

use crate::error::{CoreError, Result};

/// Maximum folder depth for sessions and macros.
pub const MAX_FOLDER_DEPTH: usize = 16;
const MAX_SEGMENT_LEN: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum SessionKind {
    #[default]
    Ssh,
    Local,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum AuthMethod {
    /// Agent (OpenSSH agent, then Pageant), then key file, then password.
    #[default]
    Auto,
    Agent,
    Key,
    Password,
}

/// A saved session. Contains no secrets; those live in [`VaultData::secrets`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Session {
    pub id: String,
    pub name: String,
    pub folder: String,
    pub kind: SessionKind,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth: AuthMethod,
    pub key_path: String,
    /// Local sessions: shell id from `pty::detect_shells`.
    pub shell: String,
    /// Id of a macro to run after connecting, if any.
    pub post_connect_macro: Option<String>,
}

/// What the frontend sees: a session plus `hasPassword`, never the password.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedactedSession {
    #[serde(flatten)]
    pub session: Session,
    pub has_password: bool,
}

/// Secrets for a session. Wiped from memory when dropped.
#[derive(Clone, Default, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
#[serde(rename_all = "camelCase")]
pub struct SessionSecret {
    #[serde(default)]
    pub password: Option<String>,
}

impl std::fmt::Debug for SessionSecret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SessionSecret(<redacted>)")
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Macro {
    pub id: String,
    pub name: String,
    pub folder: String,
    pub script: String,
    /// Show the expanded script and ask before running.
    pub preview: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownHost {
    pub host: String,
    pub port: u16,
    pub key_type: String,
    /// `SHA256:...`
    pub fingerprint: String,
    /// OpenSSH single-line public key.
    pub public_key: String,
    pub added: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum ValidationMode {
    #[default]
    Safe,
    Unrestricted,
}

/// What to open when the app starts (after the vault is unlocked).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum StartupAction {
    Nothing,
    /// Open `startup_shell` (or the default shell if empty).
    #[default]
    Shell,
    /// Connect to the saved session `startup_session`.
    Session,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub font_family: String,
    pub font_size: u16,
    pub background: String,
    pub foreground: String,
    pub cursor: String,
    pub selection: String,
    pub scrollback: u32,
    pub copy_on_select: bool,
    pub line_delay_ms: u32,
    pub validation_mode: ValidationMode,
    /// 0 disables auto-lock.
    pub auto_lock_minutes: u32,
    pub confirm_multiline_paste: bool,
    pub startup_action: StartupAction,
    /// Shell id from `pty::detect_shells`, e.g. `wsl:Ubuntu`. Empty = default shell.
    pub startup_shell: String,
    /// Session id for `StartupAction::Session`.
    pub startup_session: String,
    /// Shell used for new local tabs. Empty = first detected shell.
    pub default_shell: String,
    /// Panes to open at startup: 1, 2 (side by side) or 4 (2×2 grid).
    pub startup_panes: u8,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            font_family: "Cascadia Mono, Consolas, monospace".into(),
            font_size: 14,
            background: "#11151c".into(),
            foreground: "#d8dee9".into(),
            cursor: "#88c0d0".into(),
            selection: "#3b4252".into(),
            scrollback: 10_000,
            copy_on_select: false,
            line_delay_ms: 100,
            validation_mode: ValidationMode::Safe,
            auto_lock_minutes: 15,
            confirm_multiline_paste: true,
            startup_action: StartupAction::Shell,
            startup_shell: String::new(),
            startup_session: String::new(),
            default_shell: String::new(),
            startup_panes: 1,
        }
    }
}

impl Settings {
    /// Clamp values to sane ranges so a bad import can't wedge the UI.
    pub fn sanitized(mut self) -> Self {
        if !matches!(self.startup_panes, 1 | 2 | 4) {
            self.startup_panes = 1;
        }
        for id in [&mut self.startup_shell, &mut self.startup_session, &mut self.default_shell] {
            if id.len() > 200 || id.chars().any(char::is_control) {
                id.clear();
            }
        }
        self.font_size = self.font_size.clamp(6, 48);
        self.scrollback = self.scrollback.min(200_000);
        self.line_delay_ms = self.line_delay_ms.min(60_000);
        self.auto_lock_minutes = self.auto_lock_minutes.min(24 * 60);
        for c in [&mut self.background, &mut self.foreground, &mut self.cursor, &mut self.selection] {
            if !is_hex_colour(c) {
                *c = String::new();
            }
        }
        let d = Settings::default();
        if self.background.is_empty() {
            self.background = d.background.clone();
        }
        if self.foreground.is_empty() {
            self.foreground = d.foreground.clone();
        }
        if self.cursor.is_empty() {
            self.cursor = d.cursor.clone();
        }
        if self.selection.is_empty() {
            self.selection = d.selection;
        }
        self.font_family.retain(|c| !c.is_control() && !matches!(c, ';' | '{' | '}' | '<' | '>'));
        self.font_family.truncate(200);
        if self.font_family.trim().is_empty() {
            self.font_family = d.font_family;
        }
        self
    }
}

fn is_hex_colour(s: &str) -> bool {
    let b = s.as_bytes();
    (b.len() == 7 || b.len() == 4) && b[0] == b'#' && b[1..].iter().all(u8::is_ascii_hexdigit)
}

/// Everything stored (encrypted) in the vault.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct VaultData {
    pub sessions: Vec<Session>,
    pub folders: Vec<String>,
    pub macro_folders: Vec<String>,
    pub macros: Vec<Macro>,
    pub known_hosts: Vec<KnownHost>,
    pub settings: Settings,
    /// Session id → secret.
    pub secrets: BTreeMap<String, SessionSecret>,
}

impl VaultData {
    pub fn redacted_sessions(&self) -> Vec<RedactedSession> {
        self.sessions
            .iter()
            .map(|s| RedactedSession {
                session: s.clone(),
                has_password: self
                    .secrets
                    .get(&s.id)
                    .is_some_and(|x| x.password.as_deref().is_some_and(|p| !p.is_empty())),
            })
            .collect()
    }
}

/// Normalise a folder path: accepts `/` or `\` separators, trims segments,
/// drops empty ones, rejects `.`/`..`, control characters, over-long names and
/// more than [`MAX_FOLDER_DEPTH`] levels. The root folder is `""`.
pub fn normalize_folder(input: &str) -> Result<String> {
    if input.chars().any(char::is_control) {
        return Err(CoreError::invalid("Folder names cannot contain control characters."));
    }
    let mut parts: Vec<&str> = Vec::new();
    for seg in input.split(['/', '\\']) {
        let seg = seg.trim();
        if seg.is_empty() {
            continue;
        }
        if seg == "." || seg == ".." {
            return Err(CoreError::invalid("Folder names cannot be '.' or '..'."));
        }
        if seg.chars().any(char::is_control) {
            return Err(CoreError::invalid("Folder names cannot contain control characters."));
        }
        if seg.chars().count() > MAX_SEGMENT_LEN {
            return Err(CoreError::invalid(format!("Folder names are limited to {MAX_SEGMENT_LEN} characters.")));
        }
        parts.push(seg);
    }
    if parts.len() > MAX_FOLDER_DEPTH {
        return Err(CoreError::invalid(format!("Folders can be nested at most {MAX_FOLDER_DEPTH} levels deep.")));
    }
    Ok(parts.join("/"))
}

/// Validate a free-text name (session or macro).
pub fn validate_name(name: &str) -> Result<String> {
    let n = name.trim();
    if n.is_empty() {
        return Err(CoreError::invalid("A name is required."));
    }
    if n.chars().any(char::is_control) {
        return Err(CoreError::invalid("Names cannot contain control characters."));
    }
    if n.chars().count() > 128 {
        return Err(CoreError::invalid("Names are limited to 128 characters."));
    }
    Ok(n.to_string())
}

/// Validate a hostname / IP literal for SSH.
pub fn validate_host(host: &str) -> Result<String> {
    let h = host.trim();
    if h.is_empty() || h.len() > 253 {
        return Err(CoreError::invalid("A host name is required (at most 253 characters)."));
    }
    let ok = h.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ':' | '[' | ']' | '%'));
    if !ok || h.starts_with('-') {
        return Err(CoreError::invalid("The host name contains invalid characters."));
    }
    Ok(h.trim_start_matches('[').trim_end_matches(']').to_string())
}

/// Validate an SSH user name.
pub fn validate_user(user: &str) -> Result<String> {
    let u = user.trim();
    if u.is_empty() || u.len() > 64 {
        return Err(CoreError::invalid("A user name is required (at most 64 characters)."));
    }
    if u.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(CoreError::invalid("The user name contains invalid characters."));
    }
    Ok(u.to_string())
}

pub fn new_id() -> String {
    use rand::RngCore;
    let mut b = [0u8; 12];
    rand::rngs::OsRng.fill_bytes(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

pub fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folder_normalisation() {
        assert_eq!(normalize_folder("").unwrap(), "");
        assert_eq!(normalize_folder("  /  ").unwrap(), "");
        assert_eq!(normalize_folder("Prod").unwrap(), "Prod");
        assert_eq!(normalize_folder("/Prod//Web/ ").unwrap(), "Prod/Web");
        assert_eq!(normalize_folder("Prod\\Web\\db 1").unwrap(), "Prod/Web/db 1");
        assert_eq!(normalize_folder(" a / b ").unwrap(), "a/b");
    }

    #[test]
    fn folder_rejects_dots_and_controls() {
        assert!(normalize_folder("a/../b").is_err());
        assert!(normalize_folder("./a").is_err());
        assert!(normalize_folder("..").is_err());
        assert!(normalize_folder("a/b\u{0}c").is_err());
        assert!(normalize_folder("a/\nb").is_err());
        // "..." is a legitimate name
        assert_eq!(normalize_folder("a/...").unwrap(), "a/...");
    }

    #[test]
    fn folder_depth_limit() {
        let ok = (0..16).map(|i| format!("f{i}")).collect::<Vec<_>>().join("/");
        assert_eq!(normalize_folder(&ok).unwrap(), ok);
        let too_deep = (0..17).map(|i| format!("f{i}")).collect::<Vec<_>>().join("/");
        assert!(normalize_folder(&too_deep).is_err());
        assert!(normalize_folder(&"x".repeat(65)).is_err());
    }

    #[test]
    fn redaction_never_exposes_password() {
        let mut d = VaultData::default();
        d.sessions.push(Session { id: "s1".into(), name: "a".into(), ..Default::default() });
        d.sessions.push(Session { id: "s2".into(), name: "b".into(), ..Default::default() });
        d.secrets.insert("s1".into(), SessionSecret { password: Some("hunter2".into()) });
        let r = d.redacted_sessions();
        assert!(r[0].has_password);
        assert!(!r[1].has_password);
        let json = serde_json::to_string(&r).unwrap();
        assert!(!json.contains("hunter2"));
        assert!(json.contains("\"hasPassword\":true"));
    }

    #[test]
    fn host_and_user_validation() {
        assert_eq!(validate_host(" example.com ").unwrap(), "example.com");
        assert_eq!(validate_host("[::1]").unwrap(), "::1");
        assert!(validate_host("-oProxyCommand=x").is_err());
        assert!(validate_host("a b").is_err());
        assert!(validate_user("root").is_ok());
        assert!(validate_user("ro ot").is_err());
    }

    #[test]
    fn settings_sanitized() {
        let s = Settings { font_size: 200, background: "red;x".into(), ..Default::default() }.sanitized();
        assert_eq!(s.font_size, 48);
        assert_eq!(s.background, Settings::default().background);
        let s =
            Settings { default_shell: "wsl:Ubuntu\n".into(), startup_shell: "wsl:Debian".into(), ..Default::default() }
                .sanitized();
        assert_eq!(s.default_shell, "");
        assert_eq!(s.startup_shell, "wsl:Debian");
        assert_eq!(Settings { startup_panes: 3, ..Default::default() }.sanitized().startup_panes, 1);
        assert_eq!(Settings { startup_panes: 4, ..Default::default() }.sanitized().startup_panes, 4);
    }

    #[test]
    fn old_settings_without_startup_fields_still_load() {
        let s: Settings = serde_json::from_str(r#"{"fontSize": 13}"#).unwrap();
        assert_eq!(s.font_size, 13);
        assert_eq!(s.startup_action, StartupAction::Shell);
        let s: Settings = serde_json::from_str(r#"{"startupAction": "session", "startupSession": "abc"}"#).unwrap();
        assert_eq!(s.startup_action, StartupAction::Session);
    }
}
