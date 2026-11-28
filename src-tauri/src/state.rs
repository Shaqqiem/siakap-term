use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use siakap_core::pty::LocalPty;
use siakap_core::serial::SerialTerm;
use siakap_core::sftp::Sftp;
use siakap_core::ssh::{SshConnection, SshShell};
use siakap_core::termlog::SessionLog;
use siakap_core::vault::Vault;
use siakap_core::{CoreError, Result};

pub enum Term {
    Local(LocalPty),
    Serial(SerialTerm),
    Ssh { shell: SshShell, conn: Arc<SshConnection>, sftp: tokio::sync::Mutex<Option<Arc<Sftp>>> },
}

/** Where a terminal's output is logged, if logging is on. */
pub type LogSlot = Arc<Mutex<Option<SessionLog>>>;

pub struct AppState {
    vault: Mutex<Vault>,
    terms: Mutex<HashMap<u32, Arc<Term>>>,
    /// Session-log slot per terminal (filled while logging).
    logs: Mutex<HashMap<u32, LogSlot>>,
    /// The last update check, and the installer downloaded for it (never from the web view).
    pub update: Mutex<(Option<siakap_core::update::UpdateInfo>, Option<PathBuf>)>,
    next_id: AtomicU32,
    last_activity: Mutex<Instant>,
    pub transfers: Mutex<HashMap<u32, Arc<AtomicBool>>>,
    /// Local paths the user chose in a file dialog or dropped onto the window.
    /// File commands only accept these, so a compromised web view can't read
    /// or write arbitrary files. Each grant is used once.
    grants: Mutex<HashSet<PathBuf>>,
    /// Host keys actually presented by a server during a refused connection,
    /// keyed by host:port. `trust_host_key` only accepts one of these.
    pending_host_keys: Mutex<HashMap<(String, u16), String>>,
    /// Failed unlock attempts since the last success.
    unlock_failures: AtomicU32,
    /// Password attempts run one at a time, so firing many at once can't
    /// skip the growing delay between them.
    pub unlock_gate: tokio::sync::Mutex<()>,
}

impl AppState {
    pub fn new(vault_path: PathBuf) -> Self {
        Self {
            vault: Mutex::new(Vault::new(vault_path)),
            terms: Mutex::new(HashMap::new()),
            logs: Mutex::new(HashMap::new()),
            update: Mutex::new((None, None)),
            next_id: AtomicU32::new(1),
            last_activity: Mutex::new(Instant::now()),
            transfers: Mutex::new(HashMap::new()),
            grants: Mutex::new(HashSet::new()),
            pending_host_keys: Mutex::new(HashMap::new()),
            unlock_failures: AtomicU32::new(0),
            unlock_gate: tokio::sync::Mutex::new(()),
        }
    }

    /// Where the Windows-protected vault key is kept when the user chose to
    /// open Siakap without the master password.
    pub fn remember_path(&self) -> PathBuf {
        self.vault().path().with_file_name("remember.json")
    }

    /// Fail unless the vault is unlocked. Used by every command that touches
    /// sessions, terminals, files or devices: "locked" means locked.
    pub fn ensure_unlocked(&self) -> Result<()> {
        if self.vault().is_unlocked() {
            Ok(())
        } else {
            Err(CoreError::locked())
        }
    }

    pub fn grant(&self, paths: impl IntoIterator<Item = PathBuf>) {
        let mut g = self.grants.lock().unwrap_or_else(|e| e.into_inner());
        for p in paths {
            if g.len() >= 1024 {
                g.clear(); // never grows without bound
            }
            g.insert(p);
        }
    }

    /// Consume the grant for `path`. Errors if the user never picked it.
    pub fn take_grant(&self, path: &std::path::Path) -> Result<()> {
        if self.grants.lock().unwrap_or_else(|e| e.into_inner()).remove(path) {
            Ok(())
        } else {
            Err(CoreError::invalid("Choose the file with the file dialog (or drag it onto the window) first."))
        }
    }

    pub fn set_pending_host_key(&self, host: &str, port: u16, public_key: String) {
        let mut m = self.pending_host_keys.lock().unwrap_or_else(|e| e.into_inner());
        if m.len() >= 64 {
            m.clear();
        }
        m.insert((host.to_ascii_lowercase(), port), public_key);
    }

    pub fn take_pending_host_key(&self, host: &str, port: u16) -> Option<String> {
        self.pending_host_keys.lock().unwrap_or_else(|e| e.into_inner()).remove(&(host.to_ascii_lowercase(), port))
    }

    /// Delay before the next unlock attempt: none for the first three
    /// failures, then 1, 2, 4, ... seconds (max 30).
    pub fn unlock_delay(&self) -> Duration {
        let f = self.unlock_failures.load(Ordering::Relaxed);
        if f < 3 {
            Duration::ZERO
        } else {
            Duration::from_secs((1u64 << (f - 3).min(5)).min(30))
        }
    }

    pub fn unlock_result(&self, ok: bool) {
        if ok {
            self.unlock_failures.store(0, Ordering::Relaxed);
        } else {
            self.unlock_failures.fetch_add(1, Ordering::Relaxed);
        }
    }

    pub fn vault(&self) -> MutexGuard<'_, Vault> {
        // A poisoned lock means a panic mid-update; the data is still
        // consistent because updates roll back on error.
        self.vault.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn touch(&self) {
        *self.last_activity.lock().unwrap_or_else(|e| e.into_inner()) = Instant::now();
    }

    pub fn auto_lock_due(&self) -> bool {
        let v = self.vault();
        let Ok(d) = v.data() else { return false };
        let mins = d.settings.auto_lock_minutes;
        if mins == 0 {
            return false;
        }
        let last = *self.last_activity.lock().unwrap_or_else(|e| e.into_inner());
        last.elapsed() >= Duration::from_secs(mins as u64 * 60)
    }

    pub fn lock_vault(&self) {
        self.vault().lock();
        self.grants.lock().unwrap_or_else(|e| e.into_inner()).clear();
        self.pending_host_keys.lock().unwrap_or_else(|e| e.into_inner()).clear();
    }

    pub fn add_term(&self, t: Term, log: LogSlot) -> u32 {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        self.terms.lock().unwrap_or_else(|e| e.into_inner()).insert(id, Arc::new(t));
        self.logs.lock().unwrap_or_else(|e| e.into_inner()).insert(id, log);
        id
    }

    pub fn term_count(&self) -> usize {
        self.terms.lock().unwrap_or_else(|e| e.into_inner()).len()
    }

    pub fn log_slot(&self, id: u32) -> Result<LogSlot> {
        self.logs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&id)
            .cloned()
            .ok_or_else(|| CoreError::not_found("terminal"))
    }

    pub fn term(&self, id: u32) -> Result<Arc<Term>> {
        self.terms
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&id)
            .cloned()
            .ok_or_else(|| CoreError::not_found("terminal"))
    }

    pub fn remove_term(&self, id: u32) -> Option<Arc<Term>> {
        // Dropping the slot closes (and flushes) the log once output stops.
        if let Some(slot) = self.logs.lock().unwrap_or_else(|e| e.into_inner()).remove(&id) {
            slot.lock().unwrap_or_else(|e| e.into_inner()).take();
        }
        self.terms.lock().unwrap_or_else(|e| e.into_inner()).remove(&id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> (tempfile::TempDir, AppState) {
        let dir = tempfile::tempdir().unwrap();
        let st = AppState::new(dir.path().join("vault.json"));
        (dir, st)
    }

    #[test]
    fn grants_are_single_use_and_cleared_on_lock() {
        let (_d, st) = state();
        let p = PathBuf::from("/tmp/picked.json");
        assert!(st.take_grant(&p).is_err(), "never picked");
        st.grant([p.clone()]);
        assert!(st.take_grant(&p).is_ok());
        assert!(st.take_grant(&p).is_err(), "used once");
        st.grant([p.clone()]);
        st.lock_vault();
        assert!(st.take_grant(&p).is_err(), "locking forgets grants");
    }

    #[test]
    fn only_presented_host_keys_can_be_trusted() {
        let (_d, st) = state();
        assert!(st.take_pending_host_key("Example.com", 22).is_none());
        st.set_pending_host_key("Example.com", 22, "ssh-ed25519 AAAA".into());
        assert_eq!(st.take_pending_host_key("example.com", 22).as_deref(), Some("ssh-ed25519 AAAA"));
        assert!(st.take_pending_host_key("example.com", 22).is_none(), "one use");
    }

    #[test]
    fn unlock_backoff() {
        let (_d, st) = state();
        for _ in 0..3 {
            assert!(st.unlock_delay().is_zero());
            st.unlock_result(false);
        }
        assert_eq!(st.unlock_delay(), Duration::from_secs(1));
        st.unlock_result(false);
        assert_eq!(st.unlock_delay(), Duration::from_secs(2));
        for _ in 0..10 {
            st.unlock_result(false);
        }
        assert_eq!(st.unlock_delay(), Duration::from_secs(30));
        st.unlock_result(true);
        assert!(st.unlock_delay().is_zero());
    }

    #[test]
    fn locked_means_locked() {
        let (_d, st) = state();
        assert!(st.ensure_unlocked().is_err());
    }
}
