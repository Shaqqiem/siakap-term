//! SSH client (russh): host-key trust-on-first-use against the vault's
//! known-hosts list, agent / Pageant / key file / password authentication,
//! and interactive shells.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::client::{self, AuthResult, Handle};
use russh::keys::{HashAlg, PrivateKeyWithHashAlg, PublicKey, PublicKeyOrCertificate};
use russh::{ChannelMsg, Disconnect};
use tokio::sync::mpsc;
use zeroize::Zeroizing;

use crate::error::{CoreError, Result};
use crate::model::{now_secs, AuthMethod, KnownHost};
use crate::pty::{EventSink, TermEvent};

/// Windows OpenSSH agent pipe.
pub const OPENSSH_AGENT_PIPE: &str = r"\\.\pipe\openssh-ssh-agent";

pub struct ConnectParams {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth: AuthMethod,
    pub key_path: String,
    pub password: Option<Zeroizing<String>>,
    pub passphrase: Option<Zeroizing<String>>,
    pub known_hosts: Vec<KnownHost>,
    /// Seconds between keep-alive messages (0 = off).
    pub keepalive_secs: u32,
    /// Give up connecting after this many seconds.
    pub connect_timeout_secs: u32,
}

/// The host key the server presented, ready to be stored on approval.
#[derive(Debug, Clone)]
pub struct PresentedKey {
    pub key_type: String,
    pub fingerprint: String,
    pub public_key: String,
}

pub fn describe_key(key: &PublicKey) -> PresentedKey {
    PresentedKey {
        key_type: key.algorithm().to_string(),
        fingerprint: key.fingerprint(HashAlg::Sha256).to_string(),
        public_key: key.to_openssh().unwrap_or_default(),
    }
}

/// Result of comparing a presented key with the known-hosts list.
#[derive(Debug, PartialEq, Eq)]
pub enum HostKeyVerdict {
    Trusted,
    Unknown,
    /// The host is known but presented a different key. Carries the stored
    /// fingerprint.
    Changed(String),
}

/// Pure check, unit-tested. Any mismatch for a known host is treated as a
/// change (including a different key *type*), so an attacker cannot downgrade
/// a hard refusal to a "trust this new key?" prompt by offering another
/// algorithm.
pub fn check_host_key(known: &[KnownHost], host: &str, port: u16, presented: &PresentedKey) -> HostKeyVerdict {
    let entries: Vec<&KnownHost> =
        known.iter().filter(|k| k.host.eq_ignore_ascii_case(host) && k.port == port).collect();
    if entries.is_empty() {
        return HostKeyVerdict::Unknown;
    }
    if entries.iter().any(|k| k.public_key == presented.public_key || k.fingerprint == presented.fingerprint) {
        return HostKeyVerdict::Trusted;
    }
    HostKeyVerdict::Changed(entries[0].fingerprint.clone())
}

pub fn known_host_entry(host: &str, port: u16, key: &PresentedKey) -> KnownHost {
    KnownHost {
        host: host.to_ascii_lowercase(),
        port,
        key_type: key.key_type.clone(),
        fingerprint: key.fingerprint.clone(),
        public_key: key.public_key.clone(),
        added: now_secs(),
    }
}

pub struct Client {
    host: String,
    port: u16,
    known: Vec<KnownHost>,
    rejection: Arc<Mutex<Option<CoreError>>>,
}

impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let pk = match key {
            PublicKeyOrCertificate::PublicKey { key, .. } => key.clone(),
            PublicKeyOrCertificate::Certificate(c) => PublicKey::new(c.public_key().clone(), ""),
        };
        let p = describe_key(&pk);
        let verdict = check_host_key(&self.known, &self.host, self.port, &p);
        let err = match verdict {
            HostKeyVerdict::Trusted => return Ok(true),
            HostKeyVerdict::Unknown => CoreError::HostKeyUnknown {
                message: format!(
                    "The authenticity of host {}:{} can't be established. {} key fingerprint is {}.",
                    self.host, self.port, p.key_type, p.fingerprint
                ),
                host: self.host.clone(),
                port: self.port,
                fingerprint: p.fingerprint,
                key_type: p.key_type,
                public_key: p.public_key,
            },
            HostKeyVerdict::Changed(known_fingerprint) => CoreError::HostKeyChanged {
                message: format!(
                    "WARNING: THE HOST KEY FOR {}:{} HAS CHANGED. Someone could be eavesdropping on you right now \
                     (man-in-the-middle attack), or the host key was legitimately replaced. The connection was refused. \
                     Expected {}, got {} ({}). Verify the new key with the server's administrator before removing the \
                     old entry in Settings → Known hosts.",
                    self.host, self.port, known_fingerprint, p.fingerprint, p.key_type
                ),
                host: self.host.clone(),
                port: self.port,
                fingerprint: p.fingerprint,
                key_type: p.key_type,
                known_fingerprint,
            },
        };
        if let Ok(mut r) = self.rejection.lock() {
            *r = Some(err);
        }
        Ok(false)
    }
}

/// An authenticated SSH connection. Shells and SFTP open channels on it.
pub struct SshConnection {
    handle: Handle<Client>,
}

impl SshConnection {
    pub async fn connect(p: ConnectParams) -> Result<Arc<Self>> {
        let config = Arc::new(client::Config {
            inactivity_timeout: None,
            keepalive_interval: (p.keepalive_secs > 0).then(|| Duration::from_secs(u64::from(p.keepalive_secs))),
            keepalive_max: 4,
            nodelay: true,
            ..Default::default()
        });
        let rejection = Arc::new(Mutex::new(None));
        let handler =
            Client { host: p.host.clone(), port: p.port, known: p.known_hosts.clone(), rejection: rejection.clone() };
        let connect = client::connect(config, (p.host.as_str(), p.port), handler);
        let res = tokio::time::timeout(Duration::from_secs(u64::from(p.connect_timeout_secs.clamp(3, 120))), connect)
            .await
            .map_err(|_| CoreError::ssh(format!("Timed out connecting to {}:{}.", p.host, p.port)))?;
        let mut handle = match res {
            Ok(h) => h,
            Err(e) => {
                if let Some(r) = rejection.lock().ok().and_then(|mut r| r.take()) {
                    return Err(r);
                }
                return Err(CoreError::ssh(format!("Could not connect to {}:{}: {e}", p.host, p.port)));
            }
        };
        authenticate(&mut handle, &p).await?;
        Ok(Arc::new(Self { handle }))
    }

    pub fn is_closed(&self) -> bool {
        self.handle.is_closed()
    }

    pub async fn open_shell(self: &Arc<Self>, cols: u16, rows: u16, sink: EventSink) -> Result<SshShell> {
        let mut channel = self.handle.channel_open_session().await?;
        channel
            .request_pty(false, "xterm-256color", cols.clamp(2, 1000) as u32, rows.clamp(2, 1000) as u32, 0, 0, &[])
            .await?;
        channel.request_shell(false).await?;
        let (tx, mut rx) = mpsc::unbounded_channel::<ShellCmd>();
        let conn = self.clone();
        tokio::spawn(async move {
            let mut code: Option<i32> = None;
            loop {
                tokio::select! {
                    msg = channel.wait() => match msg {
                        Some(ChannelMsg::Data { data }) => sink(TermEvent::Data(data.to_vec())),
                        Some(ChannelMsg::ExtendedData { data, .. }) => sink(TermEvent::Data(data.to_vec())),
                        Some(ChannelMsg::ExitStatus { exit_status }) => code = Some(exit_status as i32),
                        Some(ChannelMsg::Eof) => {}
                        Some(ChannelMsg::Close) | None => break,
                        Some(_) => {}
                    },
                    cmd = rx.recv() => match cmd {
                        Some(ShellCmd::Write(d)) => {
                            if channel.data_bytes(d).await.is_err() { break; }
                        }
                        Some(ShellCmd::Resize(c, r)) => {
                            let _ = channel.window_change(c.clamp(2, 1000) as u32, r.clamp(2, 1000) as u32, 0, 0).await;
                        }
                        Some(ShellCmd::Close) | None => {
                            let _ = channel.eof().await;
                            let _ = channel.close().await;
                            break;
                        }
                    },
                }
            }
            sink(TermEvent::Exit(code));
            drop(conn);
        });
        Ok(SshShell { tx })
    }

    /// Open an SFTP subsystem channel on this connection.
    pub async fn open_sftp(&self) -> Result<russh_sftp::client::SftpSession> {
        let channel = self.handle.channel_open_session().await?;
        channel.request_subsystem(true, "sftp").await?;
        let s = russh_sftp::client::SftpSession::new(channel.into_stream()).await?;
        Ok(s)
    }

    pub async fn disconnect(&self) {
        let _ = self.handle.disconnect(Disconnect::ByApplication, "", "en").await;
    }
}

enum ShellCmd {
    Write(Vec<u8>),
    Resize(u16, u16),
    Close,
}

pub struct SshShell {
    tx: mpsc::UnboundedSender<ShellCmd>,
}

impl SshShell {
    pub fn write(&self, data: Vec<u8>) -> Result<()> {
        self.tx.send(ShellCmd::Write(data)).map_err(|_| CoreError::ssh("The session is closed."))
    }
    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        self.tx.send(ShellCmd::Resize(cols, rows)).map_err(|_| CoreError::ssh("The session is closed."))
    }
    pub fn close(&self) {
        let _ = self.tx.send(ShellCmd::Close);
    }
}

fn auth_ok(r: &AuthResult) -> bool {
    matches!(r, AuthResult::Success)
}

async fn authenticate(h: &mut Handle<Client>, p: &ConnectParams) -> Result<()> {
    let mut tried: Vec<&str> = Vec::new();
    let use_agent = matches!(p.auth, AuthMethod::Auto | AuthMethod::Agent);
    let use_key = matches!(p.auth, AuthMethod::Auto | AuthMethod::Key) && !p.key_path.trim().is_empty();
    let use_password = matches!(p.auth, AuthMethod::Auto | AuthMethod::Password);

    if use_agent {
        tried.push("agent");
        if try_agents(h, &p.user).await? {
            return Ok(());
        }
    }
    if use_key {
        tried.push("key file");
        let key = match russh::keys::load_secret_key(p.key_path.trim(), p.passphrase.as_ref().map(|s| s.as_str())) {
            Ok(k) => k,
            Err(russh::keys::Error::KeyIsEncrypted) => {
                return Err(CoreError::PassphraseRequired {
                    message: "The key file is encrypted. Enter its passphrase.".into(),
                })
            }
            Err(e) if p.passphrase.is_some() => {
                return Err(CoreError::auth(format!("Could not decrypt the key file (wrong passphrase?): {e}")))
            }
            Err(e) => return Err(CoreError::auth(format!("Could not read the key file: {e}"))),
        };
        let hash = if key.algorithm().is_rsa() { h.best_supported_rsa_hash().await?.flatten() } else { None };
        let r = h.authenticate_publickey(&p.user, PrivateKeyWithHashAlg::new(Arc::new(key), hash)).await?;
        if auth_ok(&r) {
            return Ok(());
        }
    }
    if use_password {
        match &p.password {
            Some(pw) => {
                tried.push("password");
                let r = h.authenticate_password(&p.user, pw.as_str()).await?;
                if auth_ok(&r) {
                    return Ok(());
                }
                return Err(CoreError::auth("Authentication failed: the password was rejected."));
            }
            None => {
                return Err(CoreError::PasswordRequired { message: format!("Password for {}@{}", p.user, p.host) });
            }
        }
    }
    Err(CoreError::auth(format!(
        "Authentication failed (tried: {}).",
        if tried.is_empty() { "nothing".into() } else { tried.join(", ") }
    )))
}

/// Try every identity in the available agents. Returns Ok(true) on success.
async fn try_agents(h: &mut Handle<Client>, user: &str) -> Result<bool> {
    #[cfg(windows)]
    {
        use russh::keys::agent::client::AgentClient;
        if let Ok(a) = AgentClient::connect_named_pipe(OPENSSH_AGENT_PIPE).await {
            if try_agent(h, user, a.dynamic()).await? {
                return Ok(true);
            }
        }
        if let Ok(a) = AgentClient::connect_pageant().await {
            if try_agent(h, user, a.dynamic()).await? {
                return Ok(true);
            }
        }
    }
    #[cfg(unix)]
    {
        use russh::keys::agent::client::AgentClient;
        if let Ok(a) = AgentClient::connect_env().await {
            if try_agent(h, user, a.dynamic()).await? {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

type DynAgent =
    russh::keys::agent::client::AgentClient<Box<dyn russh::keys::agent::client::AgentStream + Send + Unpin + 'static>>;

async fn try_agent(h: &mut Handle<Client>, user: &str, mut agent: DynAgent) -> Result<bool> {
    let ids = match tokio::time::timeout(Duration::from_secs(5), agent.request_identities()).await {
        Ok(Ok(ids)) => ids,
        _ => return Ok(false),
    };
    for id in ids {
        let russh::keys::agent::AgentIdentity::PublicKey { key, .. } = id else { continue };
        let hash = if key.algorithm().is_rsa() { h.best_supported_rsa_hash().await?.flatten() } else { None };
        // A FIDO key waits for a touch here; give the user time.
        match tokio::time::timeout(Duration::from_secs(60), h.authenticate_publickey_with(user, key, hash, &mut agent))
            .await
        {
            Ok(Ok(r)) if auth_ok(&r) => return Ok(true),
            Ok(Ok(_)) => continue,
            Ok(Err(_)) => continue,
            Err(_) => return Err(CoreError::auth("Timed out waiting for the SSH agent (touch your security key?).")),
        }
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pk(fp: &str, t: &str) -> PresentedKey {
        PresentedKey { key_type: t.into(), fingerprint: fp.into(), public_key: format!("{t} {fp}") }
    }

    #[test]
    fn tofu_verdicts() {
        let known = vec![known_host_entry("Example.com", 22, &pk("SHA256:aaa", "ssh-ed25519"))];
        assert_eq!(
            check_host_key(&known, "example.com", 22, &pk("SHA256:aaa", "ssh-ed25519")),
            HostKeyVerdict::Trusted
        );
        assert_eq!(
            check_host_key(&known, "example.com", 2222, &pk("SHA256:aaa", "ssh-ed25519")),
            HostKeyVerdict::Unknown
        );
        assert_eq!(check_host_key(&known, "other", 22, &pk("SHA256:aaa", "ssh-ed25519")), HostKeyVerdict::Unknown);
        assert_eq!(
            check_host_key(&known, "example.com", 22, &pk("SHA256:bbb", "ssh-ed25519")),
            HostKeyVerdict::Changed("SHA256:aaa".into())
        );
        // A different algorithm for a known host is also a hard refusal.
        assert!(matches!(
            check_host_key(&known, "example.com", 22, &pk("SHA256:ccc", "rsa-sha2-512")),
            HostKeyVerdict::Changed(_)
        ));
    }

    #[test]
    fn describes_real_key() {
        let k = PublicKey::from_openssh(
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl test",
        )
        .unwrap();
        let d = describe_key(&k);
        assert_eq!(d.key_type, "ssh-ed25519");
        assert!(d.fingerprint.starts_with("SHA256:"));
        assert!(d.public_key.starts_with("ssh-ed25519 AAAA"));
    }
}
