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

/// One round of keyboard-interactive questions from the server (one-time
/// codes, 2FA, PAM passwords).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KbdRequest {
    /// Who is asking, "user@host" (with jump hosts this may not be the target).
    pub server: String,
    pub name: String,
    pub instructions: String,
    pub prompts: Vec<KbdPrompt>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct KbdPrompt {
    pub prompt: String,
    /// Show what is typed (false for passwords and codes).
    pub echo: bool,
}

/// Asks the user; resolves to the answers, or None if they cancelled.
pub type Prompter = Arc<
    dyn Fn(KbdRequest) -> std::pin::Pin<Box<dyn std::future::Future<Output = Option<Vec<Zeroizing<String>>>> + Send>>
        + Send
        + Sync,
>;

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
    /// Asks the user keyboard-interactive questions (None: don't offer it).
    pub prompter: Option<Prompter>,
    /// Reach this host through another SSH server first (ProxyJump).
    pub jump: Option<Box<ConnectParams>>,
}

/// Most jump hosts in a chain (a → b → c → target).
pub const MAX_JUMPS: usize = 4;

/// Remote (-R) forwards: server port → where to connect on this side.
pub(crate) type RemoteMap = Arc<Mutex<std::collections::HashMap<u32, (String, u16)>>>;

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
    remote: RemoteMap,
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

    /// The server hands us a connection for a -R forward. Only ports we asked
    /// for are accepted, and they only ever reach the destination the user set.
    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: russh::Channel<client::Msg>,
        _connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        let dest = self.remote.lock().ok().and_then(|m| m.get(&connected_port).cloned());
        tokio::spawn(async move {
            let Some((host, port)) = dest else {
                reply.reject(russh::ChannelOpenFailure::AdministrativelyProhibited).await;
                return;
            };
            match tokio::net::TcpStream::connect((host.as_str(), port)).await {
                Ok(mut tcp) => {
                    reply.accept().await;
                    let mut stream = channel.into_stream();
                    let _ = tokio::io::copy_bidirectional(&mut tcp, &mut stream).await;
                }
                Err(_) => reply.reject(russh::ChannelOpenFailure::ConnectFailed).await,
            }
        });
        Ok(())
    }
}

/// Say which hop failed when a jump host can't be reached or signed in to.
fn via_jump(e: CoreError, host: &str) -> CoreError {
    match e {
        CoreError::PasswordRequired { .. } => CoreError::auth(format!(
            "The jump host {host} needs a password. Save it in that session, or sign in there with a key or the agent."
        )),
        CoreError::PassphraseRequired { .. } => CoreError::auth(format!(
            "The key for the jump host {host} needs a passphrase. Load it into the agent, or use another sign-in method."
        )),
        CoreError::Auth { message } => CoreError::auth(format!("Jump host {host}: {message}")),
        CoreError::Ssh { message } => CoreError::ssh(format!("Jump host {host}: {message}")),
        other => other,
    }
}

/// An authenticated SSH connection. Shells and SFTP open channels on it.
pub struct SshConnection {
    pub(crate) handle: Handle<Client>,
    pub(crate) remote: RemoteMap,
    /// The connection this one runs through, kept open while it is in use.
    _jump: Option<Arc<SshConnection>>,
}

impl SshConnection {
    pub async fn connect(mut p: ConnectParams) -> Result<Arc<Self>> {
        // Count the chain so a loop of jump hosts can't recurse forever.
        let mut depth = 0;
        let mut j = p.jump.as_deref();
        while let Some(x) = j {
            depth += 1;
            if depth > MAX_JUMPS {
                return Err(CoreError::invalid(format!("Too many jump hosts in a row (at most {MAX_JUMPS}).")));
            }
            j = x.jump.as_deref();
        }
        let jump = match p.jump.take() {
            Some(jp) => {
                let jhost = format!("{}:{}", jp.host, jp.port);
                Some(Box::pin(Self::connect(*jp)).await.map_err(|e| via_jump(e, &jhost))?)
            }
            None => None,
        };
        let config = Arc::new(client::Config {
            inactivity_timeout: None,
            keepalive_interval: (p.keepalive_secs > 0).then(|| Duration::from_secs(u64::from(p.keepalive_secs))),
            keepalive_max: 4,
            nodelay: true,
            ..Default::default()
        });
        let rejection = Arc::new(Mutex::new(None));
        let remote: RemoteMap = Arc::default();
        let handler = Client {
            host: p.host.clone(),
            port: p.port,
            known: p.known_hosts.clone(),
            rejection: rejection.clone(),
            remote: remote.clone(),
        };
        let timeout = Duration::from_secs(u64::from(p.connect_timeout_secs.clamp(3, 120)));
        let res = match &jump {
            Some(j) => {
                let ch = tokio::time::timeout(
                    timeout,
                    j.handle.channel_open_direct_tcpip(p.host.clone(), u32::from(p.port), "127.0.0.1", 0),
                )
                .await
                .map_err(|_| {
                    CoreError::ssh(format!("Timed out reaching {}:{} through the jump host.", p.host, p.port))
                })?
                .map_err(|e| CoreError::ssh(format!("The jump host could not reach {}:{}: {e}", p.host, p.port)))?;
                tokio::time::timeout(timeout, client::connect_stream(config, ch.into_stream(), handler)).await
            }
            None => tokio::time::timeout(timeout, client::connect(config, (p.host.as_str(), p.port), handler)).await,
        }
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
        Ok(Arc::new(Self { handle, remote, _jump: jump }))
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

    /// Hang up, then hang up the jump hosts this connection ran through.
    pub async fn disconnect(&self) {
        let _ = self.handle.disconnect(Disconnect::ByApplication, "", "en").await;
        if let Some(j) = &self._jump {
            Box::pin(j.disconnect()).await;
        }
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

fn partial(r: &AuthResult) -> bool {
    matches!(r, AuthResult::Failure { partial_success: true, .. })
}

const MAX_KBD_ROUNDS: usize = 8;

/// Keyboard-interactive login. `password` answers the first password-looking
/// question if the session has one. Ok(None): the server doesn't offer it.
async fn keyboard_interactive(
    h: &mut Handle<Client>,
    user: &str,
    password: Option<&Zeroizing<String>>,
    prompter: &Prompter,
    server: &str,
) -> Result<Option<bool>> {
    use russh::client::KeyboardInteractiveAuthResponse as K;
    let mut resp = match h.authenticate_keyboard_interactive_start(user, None::<String>).await {
        Ok(r) => r,
        Err(_) => return Ok(None),
    };
    let mut used_password = false;
    for round in 0..MAX_KBD_ROUNDS {
        match resp {
            K::Success => return Ok(Some(true)),
            K::Failure { .. } => return Ok(if round == 0 { None } else { Some(false) }),
            K::InfoRequest { name, instructions, prompts } => {
                let answers: Vec<String> = if prompts.is_empty() {
                    Vec::new() // some servers send an empty round first
                } else if let (false, Some(pw), [p]) = (used_password, password, prompts.as_slice()) {
                    if !p.echo && p.prompt.to_lowercase().contains("password") {
                        used_password = true;
                        vec![pw.to_string()]
                    } else {
                        ask(prompter, server, name, instructions, &prompts).await?
                    }
                } else {
                    ask(prompter, server, name, instructions, &prompts).await?
                };
                resp = h.authenticate_keyboard_interactive_respond(answers).await?;
            }
        }
    }
    Err(CoreError::auth("The server kept asking questions; sign-in was stopped."))
}

async fn ask(
    prompter: &Prompter,
    server: &str,
    name: String,
    instructions: String,
    prompts: &[russh::client::Prompt],
) -> Result<Vec<String>> {
    let req = KbdRequest {
        server: server.chars().filter(|c| !c.is_control()).take(300).collect(),
        name: name.chars().filter(|c| !c.is_control()).take(200).collect(),
        instructions: instructions.chars().filter(|c| *c == '\n' || !c.is_control()).take(2000).collect(),
        prompts: prompts
            .iter()
            .take(16)
            .map(|p| KbdPrompt {
                prompt: p.prompt.chars().filter(|c| !c.is_control()).take(500).collect(),
                echo: p.echo,
            })
            .collect(),
    };
    let n = prompts.len();
    match prompter(req).await {
        Some(a) if a.len() == n => Ok(a.iter().map(|x| x.to_string()).collect()),
        Some(_) => Err(CoreError::auth("The answers didn't match the server's questions.")),
        None => Err(CoreError::cancelled()),
    }
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
        if let Some(pw) = &p.password {
            tried.push("password");
            let r = h.authenticate_password(&p.user, pw.as_str()).await?;
            if auth_ok(&r) {
                return Ok(());
            }
            // Wrong password: say so, unless the server wants a second step
            // or only takes passwords through keyboard-interactive.
            let allows_kbd = matches!(&r, AuthResult::Failure { remaining_methods, .. } if remaining_methods.contains(&russh::MethodKind::KeyboardInteractive));
            let allows_pw = matches!(&r, AuthResult::Failure { remaining_methods, .. } if remaining_methods.contains(&russh::MethodKind::Password));
            if !partial(&r) && (allows_pw || !allows_kbd || p.prompter.is_none()) {
                return Err(CoreError::auth("Authentication failed: the password was rejected."));
            }
        }
    }
    // Keyboard-interactive: one-time codes, 2FA, or passwords asked by PAM.
    if let (true, Some(prompter)) = (matches!(p.auth, AuthMethod::Auto | AuthMethod::Password), &p.prompter) {
        tried.push("keyboard-interactive");
        match keyboard_interactive(h, &p.user, p.password.as_ref(), prompter, &format!("{}@{}", p.user, p.host)).await?
        {
            Some(true) => return Ok(()),
            Some(false) => return Err(CoreError::auth("Authentication failed: the answers were not accepted.")),
            None => {}
        }
    }
    if use_password && p.password.is_none() {
        return Err(CoreError::PasswordRequired { message: format!("Password for {}@{}", p.user, p.host) });
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
