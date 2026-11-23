use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use siakap_core::pty::LocalPty;
use siakap_core::serial::SerialTerm;
use siakap_core::sftp::Sftp;
use siakap_core::ssh::{SshConnection, SshShell};
use siakap_core::vault::Vault;
use siakap_core::{CoreError, Result};

pub enum Term {
    Local(LocalPty),
    Serial(SerialTerm),
    Ssh { shell: SshShell, conn: Arc<SshConnection>, sftp: tokio::sync::Mutex<Option<Arc<Sftp>>> },
}

pub struct AppState {
    vault: Mutex<Vault>,
    terms: Mutex<HashMap<u32, Arc<Term>>>,
    next_id: AtomicU32,
    last_activity: Mutex<Instant>,
    pub transfers: Mutex<HashMap<u32, Arc<AtomicBool>>>,
}

impl AppState {
    pub fn new(vault_path: PathBuf) -> Self {
        Self {
            vault: Mutex::new(Vault::new(vault_path)),
            terms: Mutex::new(HashMap::new()),
            next_id: AtomicU32::new(1),
            last_activity: Mutex::new(Instant::now()),
            transfers: Mutex::new(HashMap::new()),
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
    }

    pub fn add_term(&self, t: Term) -> u32 {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        self.terms.lock().unwrap_or_else(|e| e.into_inner()).insert(id, Arc::new(t));
        id
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
        self.terms.lock().unwrap_or_else(|e| e.into_inner()).remove(&id)
    }
}
