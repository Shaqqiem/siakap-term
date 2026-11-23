//! "Open without the master password": the vault key saved on this PC,
//! encrypted by Windows for the current Windows account (DPAPI,
//! `CryptProtectData`). Only that Windows user, on this PC, can decrypt it.
//!
//! The file holds `{version, scheme:"dpapi", data}`. It is deleted when the
//! option is turned off, and replaced when the master password changes.
//! Other platforms have no equivalent here, so the option is Windows-only.

use std::path::Path;

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::error::{CoreError, Result};
use crate::vault::atomic_write;

const VERSION: u32 = 1;

#[derive(Serialize, Deserialize)]
struct RememberFile {
    version: u32,
    scheme: String,
    data: String,
}

/// Whether this build can save the key (Windows; also debug test builds).
pub fn available() -> bool {
    scheme().is_some()
}

fn scheme() -> Option<&'static str> {
    if cfg!(windows) {
        return Some("dpapi");
    }
    // Debug builds only, for automated tests on Linux: NOT protected.
    if cfg!(debug_assertions) && std::env::var_os("SIAKAP_TEST_REMEMBER").is_some() {
        return Some("test");
    }
    None
}

fn unavailable() -> CoreError {
    CoreError::invalid("Opening without the master password is only available on Windows.")
}

/// Save `secret` protected for the current user.
pub fn save(path: &Path, secret: &[u8]) -> Result<()> {
    let scheme = scheme().ok_or_else(unavailable)?;
    let data = protect(scheme, secret)?;
    let f = RememberFile { version: VERSION, scheme: scheme.into(), data: B64.encode(data) };
    atomic_write(path, &serde_json::to_vec(&f)?)
}

/// Read and decrypt the saved secret.
pub fn load(path: &Path) -> Result<Zeroizing<Vec<u8>>> {
    let scheme = scheme().ok_or_else(unavailable)?;
    let f: RememberFile = serde_json::from_slice(&std::fs::read(path)?)?;
    if f.version != VERSION || f.scheme != scheme {
        return Err(CoreError::format("The saved key is in an unsupported format."));
    }
    let data = B64.decode(&f.data).map_err(|_| CoreError::format("The saved key is damaged."))?;
    unprotect(scheme, &data)
}

pub fn exists(path: &Path) -> bool {
    path.is_file()
}

/// Delete the saved key (missing is fine).
pub fn clear(path: &Path) -> Result<()> {
    match std::fs::remove_file(path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
        _ => Ok(()),
    }
}

const TEST_MASK: u8 = 0x5a;

fn protect(scheme: &str, secret: &[u8]) -> Result<Vec<u8>> {
    match scheme {
        #[cfg(windows)]
        "dpapi" => dpapi::protect(secret),
        "test" if cfg!(debug_assertions) => Ok(secret.iter().map(|b| b ^ TEST_MASK).collect()),
        _ => Err(unavailable()),
    }
}

fn unprotect(scheme: &str, data: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    match scheme {
        #[cfg(windows)]
        "dpapi" => dpapi::unprotect(data),
        "test" if cfg!(debug_assertions) => Ok(Zeroizing::new(data.iter().map(|b| b ^ TEST_MASK).collect())),
        _ => Err(unavailable()),
    }
}

#[cfg(windows)]
mod dpapi {
    use std::ptr::{null, null_mut};

    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };
    use zeroize::{Zeroize, Zeroizing};

    use crate::error::{CoreError, Result};

    // Ties the blob to this app: another program using DPAPI for the same
    // user must also know this value to decrypt it.
    const ENTROPY: &[u8] = b"siakap-terminal/vault-key/v1";

    fn blob(b: &[u8]) -> CRYPT_INTEGER_BLOB {
        CRYPT_INTEGER_BLOB { cbData: b.len() as u32, pbData: b.as_ptr() as *mut u8 }
    }

    fn take(out: &mut CRYPT_INTEGER_BLOB) -> Vec<u8> {
        // SAFETY: on success DPAPI returns a LocalAlloc'd buffer of cbData bytes.
        unsafe {
            let s = std::slice::from_raw_parts_mut(out.pbData, out.cbData as usize);
            let v = s.to_vec();
            s.zeroize();
            LocalFree(out.pbData as _);
            v
        }
    }

    pub fn protect(secret: &[u8]) -> Result<Vec<u8>> {
        let (input, entropy) = (blob(secret), blob(ENTROPY));
        let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: null_mut() };
        // SAFETY: all pointers are valid for the duration of the call.
        let ok =
            unsafe { CryptProtectData(&input, null(), &entropy, null(), null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out) };
        if ok == 0 {
            return Err(CoreError::invalid(format!(
                "Windows could not protect the key: {}",
                std::io::Error::last_os_error()
            )));
        }
        Ok(take(&mut out))
    }

    pub fn unprotect(data: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
        let (input, entropy) = (blob(data), blob(ENTROPY));
        let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: null_mut() };
        // SAFETY: as above.
        let ok = unsafe {
            CryptUnprotectData(&input, null_mut(), &entropy, null(), null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out)
        };
        if ok == 0 {
            return Err(CoreError::wrong_password());
        }
        Ok(Zeroizing::new(take(&mut out)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_scheme_round_trip_and_clear() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("remember.json");
        let data = protect("test", b"secret").unwrap();
        assert_ne!(data, b"secret");
        assert_eq!(&*unprotect("test", &data).unwrap(), b"secret");
        std::fs::write(&p, "x").unwrap();
        clear(&p).unwrap();
        assert!(!exists(&p));
        clear(&p).unwrap();
    }

    #[test]
    fn unknown_schemes_are_refused() {
        assert!(protect("plain", b"x").is_err());
        assert!(unprotect("plain", b"x").is_err());
    }

    #[test]
    fn vault_opens_with_device_key_until_the_password_changes() {
        use crate::vault::{KdfParams, Vault};
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vault.json");
        let fast = KdfParams { m: 8192, t: 1, p: 1 };
        let mut v = Vault::new(&path);
        v.create_with_params("correct horse battery", fast).unwrap();
        let k = v.device_key().unwrap();
        assert!(v.verify_password("wrong password here").is_err());
        v.verify_password("correct horse battery").unwrap();
        v.lock();
        v.unlock_with_device_key(&k).unwrap();
        // A tampered key fails.
        let mut bad = k.to_vec();
        bad[40] ^= 1;
        v.lock();
        assert!(v.unlock_with_device_key(&bad).is_err());
        assert!(v.unlock_with_device_key(&k[..10]).is_err());
        // After a password change the old saved key no longer opens it.
        v.unlock_with_device_key(&k).unwrap();
        v.change_password("correct horse battery", "another long passphrase").unwrap();
        v.lock();
        assert!(v.unlock_with_device_key(&k).is_err());
        v.unlock("another long passphrase").unwrap();
    }
}
