use serde::Serialize;

/// Every error the core can return. It serialises as `{ kind, message, ... }`
/// so the frontend can branch on `kind` (e.g. show the host-key prompt).
///
/// Messages never contain secrets or terminal data.
#[derive(Debug, thiserror::Error, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CoreError {
    #[error("the vault is locked")]
    Locked { message: String },
    #[error("no vault exists yet")]
    NoVault { message: String },
    #[error("a vault already exists")]
    VaultExists { message: String },
    #[error("wrong master password, or the vault file is corrupted or has been tampered with")]
    WrongPassword { message: String },
    #[error("{message}")]
    Format { message: String },
    #[error("{message}")]
    Io { message: String },
    #[error("{message}")]
    Invalid { message: String },
    #[error("not found: {message}")]
    NotFound { message: String },
    #[error("unknown host key {fingerprint} ({key_type}) for {host}")]
    #[serde(rename_all = "camelCase")]
    HostKeyUnknown {
        message: String,
        host: String,
        port: u16,
        fingerprint: String,
        key_type: String,
        public_key: String,
    },
    #[error("HOST KEY CHANGED for {host}")]
    #[serde(rename_all = "camelCase")]
    HostKeyChanged {
        message: String,
        host: String,
        port: u16,
        fingerprint: String,
        key_type: String,
        known_fingerprint: String,
    },
    #[error("a password is required")]
    PasswordRequired { message: String },
    #[error("the key file is encrypted; a passphrase is required")]
    PassphraseRequired { message: String },
    #[error("{message}")]
    Auth { message: String },
    #[error("{message}")]
    Ssh { message: String },
    #[error("{message}")]
    Sftp { message: String },
    #[error("{message}")]
    Usbipd { message: String },
    #[error("cancelled")]
    Cancelled { message: String },
}

impl CoreError {
    fn msg(s: impl Into<String>) -> String {
        s.into()
    }
    pub fn locked() -> Self {
        Self::Locked { message: Self::msg("The vault is locked.") }
    }
    pub fn invalid(m: impl Into<String>) -> Self {
        Self::Invalid { message: m.into() }
    }
    pub fn format(m: impl Into<String>) -> Self {
        Self::Format { message: m.into() }
    }
    pub fn not_found(m: impl Into<String>) -> Self {
        Self::NotFound { message: m.into() }
    }
    pub fn ssh(m: impl Into<String>) -> Self {
        Self::Ssh { message: m.into() }
    }
    pub fn auth(m: impl Into<String>) -> Self {
        Self::Auth { message: m.into() }
    }
    pub fn sftp(m: impl Into<String>) -> Self {
        Self::Sftp { message: m.into() }
    }
    pub fn usbipd(m: impl Into<String>) -> Self {
        Self::Usbipd { message: m.into() }
    }
    pub fn wrong_password() -> Self {
        Self::WrongPassword {
            message: Self::msg("Wrong master password, or the vault file is corrupted or has been tampered with."),
        }
    }
    pub fn cancelled() -> Self {
        Self::Cancelled { message: Self::msg("Cancelled.") }
    }
}

impl From<std::io::Error> for CoreError {
    fn from(e: std::io::Error) -> Self {
        Self::Io { message: e.to_string() }
    }
}

impl From<serde_json::Error> for CoreError {
    fn from(e: serde_json::Error) -> Self {
        Self::Format { message: format!("invalid data: {e}") }
    }
}

impl From<russh::Error> for CoreError {
    fn from(e: russh::Error) -> Self {
        Self::Ssh { message: e.to_string() }
    }
}

impl From<russh_sftp::client::error::Error> for CoreError {
    fn from(e: russh_sftp::client::error::Error) -> Self {
        Self::Sftp { message: e.to_string() }
    }
}

pub type Result<T, E = CoreError> = std::result::Result<T, E>;
