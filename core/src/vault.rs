//! Encrypted vault: a single JSON file
//! `{version, kdf:{alg:"argon2id", m, t, p, salt}, nonce, ciphertext}`.
//!
//! * Key: Argon2id(master password, salt) → 32 bytes, held in `Zeroizing`.
//! * Cipher: XChaCha20-Poly1305 with a fresh random 24-byte nonce per write.
//!   The header (version + KDF parameters + salt) is authenticated as AAD, so
//!   tampering with any field — or the ciphertext — makes decryption fail.
//! * Writes are atomic: temp file in the same directory, fsync, rename.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use argon2::{Algorithm, Argon2, Params, Version};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::error::{CoreError, Result};
use crate::model::VaultData;

pub const VAULT_VERSION: u32 = 1;
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 24;
/// Minimum length for a *new* master password (vault creation or change).
/// Existing vaults keep unlocking with whatever password they were made with.
pub const MIN_PASSWORD_CHARS: usize = 12;
const MIN_DISTINCT_CHARS: usize = 5;

/// Argon2id cost parameters. `m` is in KiB.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct KdfParams {
    pub m: u32,
    pub t: u32,
    pub p: u32,
}

impl Default for KdfParams {
    fn default() -> Self {
        Self { m: 65536, t: 3, p: 1 }
    }
}

impl KdfParams {
    fn check(&self) -> Result<()> {
        // Refuse absurd values so a modified file can neither downgrade the KDF
        // to nothing nor make us allocate gigabytes.
        if !(8192..=1_048_576).contains(&self.m) || !(1..=10).contains(&self.t) || !(1..=8).contains(&self.p) {
            return Err(CoreError::format("The vault's KDF parameters are out of range."));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct KdfHeader {
    alg: String,
    m: u32,
    t: u32,
    p: u32,
    salt: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct VaultFile {
    version: u32,
    kdf: KdfHeader,
    nonce: String,
    ciphertext: String,
}

fn aad(version: u32, kdf: &KdfHeader) -> Vec<u8> {
    format!("siakap-vault|v{version}|{}|m={}|t={}|p={}|{}", kdf.alg, kdf.m, kdf.t, kdf.p, kdf.salt).into_bytes()
}

fn derive_key(password: &str, salt: &[u8], p: KdfParams) -> Result<Zeroizing<[u8; 32]>> {
    p.check()?;
    let params =
        Params::new(p.m, p.t, p.p, Some(32)).map_err(|e| CoreError::format(format!("bad KDF parameters: {e}")))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = Zeroizing::new([0u8; 32]);
    argon
        .hash_password_into(password.as_bytes(), salt, key.as_mut())
        .map_err(|e| CoreError::format(format!("key derivation failed: {e}")))?;
    Ok(key)
}

/// An open (or locked) vault bound to a file.
pub struct Vault {
    path: PathBuf,
    unlocked: Option<Unlocked>,
}

struct ParsedFile {
    aad: Vec<u8>,
    salt: [u8; SALT_LEN],
    params: KdfParams,
    nonce: Vec<u8>,
    ct: Vec<u8>,
}

struct Unlocked {
    key: Zeroizing<[u8; 32]>,
    salt: [u8; SALT_LEN],
    params: KdfParams,
    data: VaultData,
}

impl Vault {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into(), unlocked: None }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn exists(&self) -> bool {
        self.path.is_file()
    }

    pub fn is_unlocked(&self) -> bool {
        self.unlocked.is_some()
    }

    /// Create a new vault (first launch) with default KDF parameters.
    pub fn create(&mut self, password: &str) -> Result<()> {
        self.create_with_params(password, KdfParams::default())
    }

    pub fn create_with_params(&mut self, password: &str, params: KdfParams) -> Result<()> {
        if self.exists() {
            return Err(CoreError::VaultExists { message: "A vault already exists.".into() });
        }
        check_new_password(password)?;
        let mut salt = [0u8; SALT_LEN];
        rand::rngs::OsRng.fill_bytes(&mut salt);
        let key = derive_key(password, &salt, params)?;
        self.unlocked = Some(Unlocked { key, salt, params, data: VaultData::default() });
        self.save()
    }

    /// Decrypt the vault. Fails with `WrongPassword` on a wrong password *or*
    /// any tampering (AEAD cannot tell the two apart, by design).
    pub fn unlock(&mut self, password: &str) -> Result<()> {
        let f = self.read_file()?;
        let key = derive_key(password, &f.salt, f.params)?;
        self.open(f, key)
    }

    /// Unlock with a key saved by [`Vault::device_key`]. Fails if the master
    /// password changed since (different salt) or the key is wrong.
    pub fn unlock_with_device_key(&mut self, blob: &[u8]) -> Result<()> {
        if blob.len() != SALT_LEN + 32 {
            return Err(CoreError::wrong_password());
        }
        let f = self.read_file()?;
        if !ct_eq(&blob[..SALT_LEN], &f.salt) {
            return Err(CoreError::wrong_password());
        }
        let mut key = Zeroizing::new([0u8; 32]);
        key.copy_from_slice(&blob[SALT_LEN..]);
        self.open(f, key)
    }

    /// The unlocked vault's salt and key, for saving under the Windows
    /// account's protection (opening without the master password).
    pub fn device_key(&self) -> Result<Zeroizing<Vec<u8>>> {
        let u = self.unlocked.as_ref().ok_or_else(CoreError::locked)?;
        let mut v = Zeroizing::new(Vec::with_capacity(SALT_LEN + 32));
        v.extend_from_slice(&u.salt);
        v.extend_from_slice(u.key.as_ref());
        Ok(v)
    }

    /// Check the master password of the unlocked vault.
    pub fn verify_password(&self, password: &str) -> Result<()> {
        let u = self.unlocked.as_ref().ok_or_else(CoreError::locked)?;
        let check = derive_key(password, &u.salt, u.params)?;
        if !ct_eq(check.as_ref(), u.key.as_ref()) {
            return Err(CoreError::wrong_password());
        }
        Ok(())
    }

    fn read_file(&self) -> Result<ParsedFile> {
        if !self.exists() {
            return Err(CoreError::NoVault { message: "No vault exists yet.".into() });
        }
        let raw = Zeroizing::new(fs::read(&self.path)?);
        let file: VaultFile = serde_json::from_slice(&raw)?;
        if file.version != VAULT_VERSION {
            return Err(CoreError::format(format!("Unsupported vault version {}.", file.version)));
        }
        if file.kdf.alg != "argon2id" {
            return Err(CoreError::format("Unsupported KDF."));
        }
        let params = KdfParams { m: file.kdf.m, t: file.kdf.t, p: file.kdf.p };
        let salt_v = B64.decode(&file.kdf.salt).map_err(|_| CoreError::format("bad salt"))?;
        let salt: [u8; SALT_LEN] = salt_v.try_into().map_err(|_| CoreError::format("bad salt"))?;
        let nonce = B64.decode(&file.nonce).map_err(|_| CoreError::format("bad nonce"))?;
        if nonce.len() != NONCE_LEN {
            return Err(CoreError::format("bad nonce"));
        }
        let ct = B64.decode(&file.ciphertext).map_err(|_| CoreError::format("bad ciphertext"))?;
        params.check()?;
        Ok(ParsedFile { aad: aad(file.version, &file.kdf), salt, params, nonce, ct })
    }

    fn open(&mut self, f: ParsedFile, key: Zeroizing<[u8; 32]>) -> Result<()> {
        let cipher = XChaCha20Poly1305::new(key.as_ref().into());
        let plain = Zeroizing::new(
            cipher
                .decrypt(XNonce::from_slice(&f.nonce), Payload { msg: &f.ct, aad: &f.aad })
                .map_err(|_| CoreError::wrong_password())?,
        );
        let data: VaultData = serde_json::from_slice(&plain)?;
        self.unlocked = Some(Unlocked { key, salt: f.salt, params: f.params, data });
        Ok(())
    }

    /// Wipe key material and decrypted data from memory.
    pub fn lock(&mut self) {
        // Dropping `Unlocked` zeroizes the key (Zeroizing) and every
        // SessionSecret (ZeroizeOnDrop).
        self.unlocked = None;
    }

    pub fn data(&self) -> Result<&VaultData> {
        self.unlocked.as_ref().map(|u| &u.data).ok_or_else(CoreError::locked)
    }

    /// Mutate the data and persist it atomically. If saving fails the in-memory
    /// change is rolled back.
    pub fn update<T>(&mut self, f: impl FnOnce(&mut VaultData) -> Result<T>) -> Result<T> {
        let u = self.unlocked.as_mut().ok_or_else(CoreError::locked)?;
        let backup = u.data.clone();
        let out = match f(&mut u.data) {
            Ok(v) => v,
            Err(e) => {
                u.data = backup;
                return Err(e);
            }
        };
        if let Err(e) = self.save() {
            if let Some(u) = self.unlocked.as_mut() {
                u.data = backup;
            }
            return Err(e);
        }
        Ok(out)
    }

    /// Re-encrypt under a new master password (new salt).
    pub fn change_password(&mut self, old: &str, new: &str) -> Result<()> {
        let u = self.unlocked.as_ref().ok_or_else(CoreError::locked)?;
        let check = derive_key(old, &u.salt, u.params)?;
        if !ct_eq(check.as_ref(), u.key.as_ref()) {
            return Err(CoreError::wrong_password());
        }
        check_new_password(new)?;
        let mut salt = [0u8; SALT_LEN];
        rand::rngs::OsRng.fill_bytes(&mut salt);
        let params = KdfParams::default().max_with(u.params);
        let key = derive_key(new, &salt, params)?;
        let u = self.unlocked.as_mut().ok_or_else(CoreError::locked)?;
        let (old_key, old_salt, old_params) = (u.key.clone(), u.salt, u.params);
        u.key = key;
        u.salt = salt;
        u.params = params;
        if let Err(e) = self.save() {
            let u = self.unlocked.as_mut().ok_or_else(CoreError::locked)?;
            u.key = old_key;
            u.salt = old_salt;
            u.params = old_params;
            return Err(e);
        }
        Ok(())
    }

    fn save(&self) -> Result<()> {
        let u = self.unlocked.as_ref().ok_or_else(CoreError::locked)?;
        let kdf =
            KdfHeader { alg: "argon2id".into(), m: u.params.m, t: u.params.t, p: u.params.p, salt: B64.encode(u.salt) };
        let mut nonce = [0u8; NONCE_LEN];
        rand::rngs::OsRng.fill_bytes(&mut nonce);
        let plain = Zeroizing::new(serde_json::to_vec(&u.data)?);
        let cipher = XChaCha20Poly1305::new(u.key.as_ref().into());
        let aad = aad(VAULT_VERSION, &kdf);
        let ct = cipher
            .encrypt(XNonce::from_slice(&nonce), Payload { msg: &plain, aad: &aad })
            .map_err(|_| CoreError::format("encryption failed"))?;
        let file = VaultFile { version: VAULT_VERSION, kdf, nonce: B64.encode(nonce), ciphertext: B64.encode(ct) };
        atomic_write(&self.path, &serde_json::to_vec_pretty(&file)?)
    }
}

impl KdfParams {
    fn max_with(self, o: KdfParams) -> KdfParams {
        KdfParams { m: self.m.max(o.m), t: self.t.max(o.t), p: self.p.max(o.p) }
    }
}

/// Rules for a new master password: at least 12 characters, not made of a
/// handful of repeated characters, and not a well-known weak password.
pub fn check_new_password(p: &str) -> Result<()> {
    if p.chars().count() < MIN_PASSWORD_CHARS {
        return Err(CoreError::invalid(format!(
            "The master password must be at least {MIN_PASSWORD_CHARS} characters. A short sentence works well."
        )));
    }
    let distinct: std::collections::HashSet<char> = p.chars().flat_map(char::to_lowercase).collect();
    if distinct.len() < MIN_DISTINCT_CHARS {
        return Err(CoreError::invalid("That password repeats too few characters. Try a short sentence instead."));
    }
    let lower = p.to_lowercase();
    const WEAK: &[&str] =
        &["password", "123456", "qwerty", "letmein", "welcome", "siakap", "admin", "abc123", "iloveyou"];
    let stripped: String = lower.chars().filter(|c| c.is_alphanumeric()).collect();
    if WEAK.iter().any(|w| {
        stripped == *w
            || stripped.trim_end_matches(|c: char| c.is_ascii_digit()) == *w
            || (stripped.starts_with(w) && stripped.len() <= w.len() + 4)
    }) {
        return Err(CoreError::invalid("That password is too easy to guess. Try a short sentence instead."));
    }
    Ok(())
}

/// Constant-time comparison of two key buffers.
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Write `bytes` to `path` atomically: temp file → fsync → rename.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let dir = path.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
    fs::create_dir_all(dir)?;
    let mut rnd = [0u8; 6];
    rand::rngs::OsRng.fill_bytes(&mut rnd);
    let tmp_name = format!(
        ".{}.{}.tmp",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("vault"),
        rnd.iter().map(|b| format!("{b:02x}")).collect::<String>()
    );
    let tmp = dir.join(tmp_name);
    let res = (|| -> Result<()> {
        let mut opts = OpenOptions::new();
        opts.write(true).create_new(true);
        // Owner-only on Unix. (On Windows the per-user AppData folder's ACL applies.)
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut opts, 0o600);
        let mut f: File = opts.open(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        // std::fs::rename replaces the destination on Windows too
        // (MoveFileExW with MOVEFILE_REPLACE_EXISTING).
        fs::rename(&tmp, path)?;
        #[cfg(unix)]
        if let Ok(d) = File::open(dir) {
            let _ = d.sync_all();
        }
        Ok(())
    })();
    if res.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    res
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Session, SessionSecret};

    // Cheaper parameters for tests; the format and code path are identical.
    const TEST_KDF: KdfParams = KdfParams { m: 8192, t: 1, p: 1 };

    fn new_vault(dir: &tempfile::TempDir) -> Vault {
        let mut v = Vault::new(dir.path().join("vault.json"));
        v.create_with_params("correct horse battery", TEST_KDF).unwrap();
        v
    }

    #[test]
    fn round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let mut v = new_vault(&dir);
        v.update(|d| {
            d.sessions.push(Session { id: "a".into(), name: "web".into(), host: "h".into(), ..Default::default() });
            d.secrets.insert("a".into(), SessionSecret { password: Some("pw-123".into()) });
            d.settings.font_size = 17;
            Ok(())
        })
        .unwrap();
        v.lock();
        assert!(v.data().is_err());

        let raw = fs::read_to_string(v.path()).unwrap();
        assert!(!raw.contains("pw-123"), "plaintext secret on disk");
        assert!(!raw.contains("web"), "plaintext session on disk");
        let header: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(header["version"], 1);
        assert_eq!(header["kdf"]["alg"], "argon2id");

        let mut v2 = Vault::new(dir.path().join("vault.json"));
        v2.unlock("correct horse battery").unwrap();
        let d = v2.data().unwrap();
        assert_eq!(d.sessions[0].name, "web");
        assert_eq!(d.secrets["a"].password.as_deref(), Some("pw-123"));
        assert_eq!(d.settings.font_size, 17);
    }

    #[test]
    fn default_params_in_header() {
        assert_eq!(KdfParams::default(), KdfParams { m: 65536, t: 3, p: 1 });
    }

    #[test]
    fn wrong_password_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let mut v = new_vault(&dir);
        v.lock();
        let e = v.unlock("not the password").unwrap_err();
        assert!(matches!(e, CoreError::WrongPassword { .. }));
        assert!(!v.is_unlocked());
    }

    #[test]
    fn tampered_ciphertext_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let v = new_vault(&dir);
        let path = v.path().to_path_buf();
        let mut f: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        let mut ct = B64.decode(f["ciphertext"].as_str().unwrap()).unwrap();
        ct[3] ^= 0x01;
        f["ciphertext"] = B64.encode(&ct).into();
        fs::write(&path, serde_json::to_vec(&f).unwrap()).unwrap();
        let mut v2 = Vault::new(&path);
        assert!(matches!(v2.unlock("correct horse battery").unwrap_err(), CoreError::WrongPassword { .. }));
    }

    #[test]
    fn tampered_header_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let v = new_vault(&dir);
        let path = v.path().to_path_buf();
        let mut f: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        // Change the nonce: decryption must fail.
        let mut n = B64.decode(f["nonce"].as_str().unwrap()).unwrap();
        n[0] ^= 0xff;
        f["nonce"] = B64.encode(&n).into();
        fs::write(&path, serde_json::to_vec(&f).unwrap()).unwrap();
        assert!(Vault::new(&path).unlock("correct horse battery").is_err());
    }

    #[test]
    fn kdf_downgrade_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let v = new_vault(&dir);
        let path = v.path().to_path_buf();
        let mut f: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        f["kdf"]["m"] = 8.into();
        fs::write(&path, serde_json::to_vec(&f).unwrap()).unwrap();
        assert!(Vault::new(&path).unlock("correct horse battery").is_err());
    }

    #[test]
    fn change_password_and_create_twice() {
        let dir = tempfile::tempdir().unwrap();
        let mut v = new_vault(&dir);
        assert!(v.create_with_params("another password here", TEST_KDF).is_err());
        assert!(v.change_password("wrong one!!", "new password one").is_err());
        // The new password must meet the current rules.
        assert!(v.change_password("correct horse battery", "short pw").is_err());
        v.change_password("correct horse battery", "new password one").unwrap();
        v.lock();
        assert!(v.unlock("correct horse battery").is_err());
        v.unlock("new password one").unwrap();
    }

    #[test]
    fn short_password_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let mut v = Vault::new(dir.path().join("v.json"));
        assert!(v.create_with_params("short", TEST_KDF).is_err());
        assert!(!v.exists());
    }

    #[test]
    fn new_password_rules() {
        for bad in [
            "elevenchars",
            "aaaaaaaaaaaaaaa",
            "abababababab",
            "Password1234",
            "password!!!!",
            "qwerty123456",
            "Siakap2026!!",
        ] {
            assert!(check_new_password(bad).is_err(), "{bad} should be rejected");
        }
        for good in ["correct horse battery", "my dog eats 3 socks", "Tr0ub4dor&3xyz"] {
            assert!(check_new_password(good).is_ok(), "{good} should be accepted");
        }
    }

    #[test]
    fn existing_short_password_still_unlocks() {
        // A vault made before the 12-character rule keeps working.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("old.json");
        let mut v = Vault::new(&path);
        let salt = [7u8; SALT_LEN];
        let key = derive_key("old8char", &salt, TEST_KDF).unwrap();
        v.unlocked = Some(Unlocked { key, salt, params: TEST_KDF, data: VaultData::default() });
        v.save().unwrap();
        v.lock();
        Vault::new(&path).unlock("old8char").unwrap();
    }

    #[test]
    fn failed_update_rolls_back() {
        let dir = tempfile::tempdir().unwrap();
        let mut v = new_vault(&dir);
        let r: Result<()> = v.update(|d| {
            d.folders.push("x".into());
            Err(CoreError::invalid("nope"))
        });
        assert!(r.is_err());
        assert!(v.data().unwrap().folders.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn vault_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let v = new_vault(&dir);
        assert_eq!(fs::metadata(v.path()).unwrap().permissions().mode() & 0o777, 0o600);
    }

    #[test]
    fn constant_time_compare() {
        assert!(ct_eq(b"abc", b"abc"));
        assert!(!ct_eq(b"abc", b"abd"));
        assert!(!ct_eq(b"abc", b"ab"));
    }

    #[test]
    fn atomic_write_leaves_no_temp_files() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("f.json");
        atomic_write(&p, b"one").unwrap();
        atomic_write(&p, b"two").unwrap();
        assert_eq!(fs::read(&p).unwrap(), b"two");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }
}
