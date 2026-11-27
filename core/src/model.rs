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
    /// Serial console (COM port).
    Serial,
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
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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
    /// Serial sessions: port, speed and line settings.
    pub serial: crate::serial::SerialConfig,
    /// Commands typed once the prompt is ready after connecting (local and SSH).
    pub startup_script: String,
    pub startup_enabled: bool,
    /// Optional folder to `cd` into before the startup commands.
    pub startup_dir: String,
}

impl Default for Session {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            folder: String::new(),
            kind: SessionKind::Ssh,
            host: String::new(),
            port: 22,
            user: String::new(),
            auth: AuthMethod::Auto,
            key_path: String::new(),
            shell: String::new(),
            post_connect_macro: None,
            serial: Default::default(),
            startup_script: String::new(),
            startup_enabled: true,
            startup_dir: String::new(),
        }
    }
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
    /// Let the user edit the whole command before every run.
    #[serde(alias = "preview")]
    pub edit_before_run: bool,
    /// Example values remembered by "Make input" (shown as hints).
    pub parameter_defaults: BTreeMap<String, String>,
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
pub enum MacroSort {
    /// The order macros were added in.
    #[default]
    Manual,
    /// Folder, then name.
    Name,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum Activation {
    #[default]
    Single,
    Double,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum CursorStyle {
    #[default]
    Block,
    Underline,
    Bar,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum Bell {
    /// Ignore the terminal bell.
    Off,
    /// Flash the pane and mark its tab.
    #[default]
    Flash,
}

/// A colour theme for terminals (and the app's accent colour).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct TerminalTheme {
    pub name: String,
    pub background: String,
    pub foreground: String,
    pub cursor: String,
    pub selection: String,
    /// 16 ANSI colours: black, red, green, yellow, blue, magenta, cyan, white,
    /// then the bright versions. Empty = the terminal's built-in colours.
    pub palette: Vec<String>,
    /// Accent colour for the app (buttons, highlights). Empty = default.
    pub accent: String,
}

impl TerminalTheme {
    /// Drop invalid colours and limit sizes; `None` if unusable.
    pub fn sanitized(mut self) -> Option<Self> {
        self.name = self.name.chars().filter(|c| !c.is_control()).take(60).collect::<String>().trim().to_string();
        if self.name.is_empty() || !is_hex_colour(&self.background) || !is_hex_colour(&self.foreground) {
            return None;
        }
        for c in [&mut self.cursor, &mut self.selection, &mut self.accent] {
            if !is_hex_colour(c) {
                c.clear();
            }
        }
        if self.palette.len() != 16 || !self.palette.iter().all(|c| is_hex_colour(c)) {
            self.palette.clear();
        }
        Some(self)
    }
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
    /// Ask to review/edit every macro before it runs.
    pub review_all: bool,
    /// New macros start with "Edit the whole command before run" ticked.
    pub new_macro_review: bool,
    /// Run sessions' startup commands after connecting.
    pub startup_macros_enabled: bool,
    /// How long to wait for a ready prompt before skipping startup commands.
    pub startup_timeout_ms: u32,
    pub macro_sort: MacroSort,
    /// Click once or twice on a macro/session name to run it.
    pub activation: Activation,
    /// Macro search also looks inside the commands (names and folders always).
    pub search_in_commands: bool,
    /// Blue/green/red command status dots on tabs.
    pub tab_status: bool,
    /// Guess status from prompts and error text when the shell sends no markers.
    pub tab_status_fallback: bool,
    /// Disconnect every terminal when the vault locks (manual or auto-lock).
    pub lock_disconnects: bool,
    /// Right-click in a terminal copies the selection, or pastes when nothing
    /// is selected (Shift+right-click shows the menu). Off: right-click shows
    /// the menu.
    pub right_click_paste: bool,
    /// Start a session log for every terminal, in `log_dir`.
    pub log_auto: bool,
    /// Folder for automatic session logs. Set only through the backend's folder
    /// dialog (settings_save keeps the stored value).
    pub log_dir: String,
    // ---- appearance and terminal (0.6)
    /// Name of the chosen theme (a built-in or one of `custom_themes`).
    pub theme_name: String,
    /// 16 ANSI colours (see TerminalTheme::palette). Empty = built-in.
    pub palette: Vec<String>,
    /// App accent colour. Empty = default blue.
    pub accent: String,
    /// Themes the user saved or imported.
    pub custom_themes: Vec<TerminalTheme>,
    pub cursor_style: CursorStyle,
    pub cursor_blink: bool,
    /// Line height in percent (100 = normal).
    pub line_height: u16,
    /// Raise the contrast of text that is hard to read on the background.
    pub min_contrast: bool,
    pub bell: Bell,
    /// Characters that end a word when double-clicking to select.
    pub word_separators: String,
    /// Ask before closing a tab that has more than one open session.
    pub confirm_close_tab: bool,
    // ---- interface (0.6.1)
    /// Interface zoom in percent (90..=150).
    pub ui_scale: u16,
    pub rail_labels: bool,
    /// "compact", "normal" or "wide".
    pub tab_width: String,
    /// Show a tab's close button only when hovering it.
    pub tab_close_on_hover: bool,
    // ---- look and motion (0.7.5)
    /// Interface style: "standard", "glass", "material", "fluent", "dot", "retro" or "minimal".
    pub ui_style: String,
    /// Animation style: "fluid", "bouncy", "slide", "subtle" or "off".
    pub animations: String,
    /// Glass style: how see-through the glass is, in percent (0..=90).
    pub glass_transparency: u8,
    /// Glass style: blur behind the glass, in pixels (0..=60).
    pub glass_blur: u8,
    /// Glass style: how see-through the terminals are, in percent (0..=90).
    pub glass_terminal: u8,
    /// Space around the text inside a terminal, in pixels.
    pub term_padding: u16,
    // ---- terminal text
    /// "300" light, "normal", "500" medium, "bold".
    pub font_weight: String,
    /// Extra pixels between characters.
    pub letter_spacing: u16,
    pub bold_is_bright: bool,
    /// Cursor when the terminal isn't focused: outline, block, bar, underline, none.
    pub cursor_inactive: String,
    /// Mouse-wheel speed multiplier (1..=10).
    pub scroll_speed: u16,
    pub scroll_on_input: bool,
    pub tab_stop_width: u16,
    // ---- tabs and window
    /// "end" or "next" (right after the current tab).
    pub new_tab_position: String,
    /// Show the title a program sets (e.g. the current folder) on its tab.
    pub program_titles: bool,
    pub middle_click_close: bool,
    /// Ask before closing the window while sessions are open.
    pub confirm_quit: bool,
    /// Show a message when a command finishes in a tab you're not looking at.
    pub notify_background: bool,
    pub start_maximized: bool,
    // ---- connections
    /// SSH keep-alive interval in seconds (0 = off).
    pub ssh_keepalive_secs: u32,
    pub ssh_connect_timeout_secs: u32,
    /// Reconnect a dropped SSH session automatically (up to 3 tries).
    pub auto_reconnect: bool,
    /// Pre-filled in the editor for new SSH sessions.
    pub default_ssh_user: String,
    pub default_ssh_port: u16,
    // ---- clipboard
    /// Drop the trailing line break when pasting a single line, so it isn't run.
    pub trim_paste_newline: bool,
    /// Remove spaces at the ends of copied lines.
    pub trim_copy_whitespace: bool,
    // ---- files and logs
    pub sftp_show_hidden: bool,
    pub log_timestamps: bool,
    // ---- security
    /// Lock when the window is minimised.
    pub lock_on_minimize: bool,
    // ---- sound, skin, screensaver, splash (0.7)
    /// Chime when a command finishes.
    pub sound_chime: bool,
    /// Only chime for commands that ran at least this long (seconds; 0 = every command).
    pub chime_min_secs: u32,
    /// Soft sounds for clicks, Enter, tabs opening and closing, errors.
    pub sound_ui: bool,
    /// 0..=100.
    pub sound_volume: u16,
    /// Colour the whole app (panels, tabs, menus) from the theme, not just terminals.
    pub app_skin: bool,
    /// Colour the window's icon to match the theme.
    pub theme_icon: bool,
    /// Minutes without input before the screensaver (0 = off).
    pub screensaver_minutes: u32,
    /// Welcome splash when Siakap starts.
    pub splash: bool,
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
            review_all: false,
            new_macro_review: false,
            startup_macros_enabled: true,
            startup_timeout_ms: 10_000,
            macro_sort: MacroSort::Manual,
            activation: Activation::Single,
            search_in_commands: true,
            tab_status: true,
            tab_status_fallback: true,
            lock_disconnects: false,
            right_click_paste: true,
            log_auto: false,
            log_dir: String::new(),
            theme_name: "Siakap Dark".into(),
            palette: Vec::new(),
            accent: String::new(),
            custom_themes: Vec::new(),
            cursor_style: CursorStyle::Block,
            cursor_blink: true,
            line_height: 100,
            min_contrast: false,
            bell: Bell::Flash,
            word_separators: " ()[]{}',\"`".into(),
            confirm_close_tab: true,
            ui_scale: 100,
            rail_labels: true,
            tab_width: "normal".into(),
            tab_close_on_hover: false,
            ui_style: "standard".into(),
            animations: "fluid".into(),
            glass_transparency: 42,
            glass_blur: 30,
            glass_terminal: 30,
            term_padding: 6,
            font_weight: "normal".into(),
            letter_spacing: 0,
            bold_is_bright: true,
            cursor_inactive: "outline".into(),
            scroll_speed: 1,
            scroll_on_input: true,
            tab_stop_width: 8,
            new_tab_position: "end".into(),
            program_titles: false,
            middle_click_close: true,
            confirm_quit: true,
            notify_background: true,
            start_maximized: false,
            ssh_keepalive_secs: 30,
            ssh_connect_timeout_secs: 20,
            auto_reconnect: false,
            default_ssh_user: String::new(),
            default_ssh_port: 22,
            trim_paste_newline: true,
            trim_copy_whitespace: true,
            sftp_show_hidden: true,
            log_timestamps: false,
            lock_on_minimize: false,
            sound_chime: true,
            chime_min_secs: 5,
            sound_ui: true,
            sound_volume: 40,
            app_skin: true,
            theme_icon: true,
            screensaver_minutes: 10,
            splash: true,
        }
    }
}

impl Settings {
    /// Clamp values to sane ranges so a bad import can't wedge the UI.
    pub fn sanitized(mut self) -> Self {
        self.startup_timeout_ms = self.startup_timeout_ms.clamp(1000, 60_000);
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
        self.theme_name = self.theme_name.chars().filter(|c| !c.is_control()).take(60).collect();
        if self.palette.len() != 16 || !self.palette.iter().all(|c| is_hex_colour(c)) {
            self.palette.clear();
        }
        if !is_hex_colour(&self.accent) {
            self.accent.clear();
        }
        let mut seen = std::collections::HashSet::new();
        self.custom_themes = std::mem::take(&mut self.custom_themes)
            .into_iter()
            .filter_map(TerminalTheme::sanitized)
            .filter(|t| seen.insert(t.name.to_lowercase()))
            .take(100)
            .collect();
        self.line_height = self.line_height.clamp(100, 200);
        self.ui_scale = self.ui_scale.clamp(80, 150);
        self.sound_volume = self.sound_volume.min(100);
        self.glass_transparency = self.glass_transparency.min(90);
        self.glass_blur = self.glass_blur.min(60);
        self.glass_terminal = self.glass_terminal.min(90);
        self.chime_min_secs = self.chime_min_secs.min(3600);
        self.screensaver_minutes = self.screensaver_minutes.min(240);
        self.term_padding = self.term_padding.min(32);
        self.letter_spacing = self.letter_spacing.min(8);
        self.scroll_speed = self.scroll_speed.clamp(1, 10);
        self.tab_stop_width = self.tab_stop_width.clamp(1, 16);
        self.ssh_keepalive_secs = self.ssh_keepalive_secs.min(3600);
        self.ssh_connect_timeout_secs = self.ssh_connect_timeout_secs.clamp(3, 120);
        if self.default_ssh_port == 0 {
            self.default_ssh_port = 22;
        }
        self.default_ssh_user = self.default_ssh_user.chars().filter(|c| !c.is_control()).take(64).collect();
        let pick = |v: &mut String, allowed: &[&str], default: &str| {
            if !allowed.contains(&v.as_str()) {
                *v = default.into();
            }
        };
        pick(&mut self.tab_width, &["compact", "normal", "wide"], "normal");
        pick(&mut self.ui_style, &["standard", "glass", "material", "fluent", "dot", "retro", "minimal"], "standard");
        pick(&mut self.animations, &["fluid", "bouncy", "slide", "subtle", "off"], "fluid");
        pick(&mut self.font_weight, &["300", "normal", "500", "bold"], "normal");
        pick(&mut self.cursor_inactive, &["outline", "block", "bar", "underline", "none"], "outline");
        pick(&mut self.new_tab_position, &["end", "next"], "end");
        self.word_separators = self.word_separators.chars().filter(|c| !c.is_control()).take(64).collect();
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
    /// Created without a master password: the key exists only in the
    /// Windows-protected `remember.json`. Lets the user set a password
    /// later without knowing the random one.
    pub passwordless: bool,
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
    fn themes_and_terminal_options_are_sanitized() {
        let good = TerminalTheme {
            name: "  Mine  ".into(),
            background: "#000000".into(),
            foreground: "#ffffff".into(),
            cursor: "red".into(),
            selection: "#333".into(),
            palette: vec!["#111111".into(); 16],
            accent: "#12345g".into(),
        };
        let t = good.clone().sanitized().unwrap();
        assert_eq!(t.name, "Mine");
        assert_eq!(t.cursor, "", "invalid colours are dropped");
        assert_eq!(t.accent, "");
        assert_eq!(t.palette.len(), 16);
        let short = TerminalTheme { palette: vec!["#111111".into(); 15], ..good.clone() }.sanitized().unwrap();
        assert!(short.palette.is_empty(), "a palette must have exactly 16 colours");
        assert!(TerminalTheme { background: "javascript:".into(), ..good.clone() }.sanitized().is_none());
        assert!(TerminalTheme { name: " ".into(), ..good.clone() }.sanitized().is_none());

        let s = Settings {
            palette: vec!["#fff".into(); 3],
            accent: "url(x)".into(),
            custom_themes: vec![good.clone(), TerminalTheme { name: "mine".into(), ..good.clone() }],
            line_height: 900,
            word_separators: "ab\ncd".into(),
            ..Default::default()
        }
        .sanitized();
        assert!(s.palette.is_empty() && s.accent.is_empty());
        assert_eq!(s.custom_themes.len(), 1, "duplicate names (any case) are dropped");
        assert_eq!(s.line_height, 200);
        assert_eq!(s.word_separators, "abcd");
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
