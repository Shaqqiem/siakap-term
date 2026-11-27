//! A hidden preview panel for the developer. It only shows things the app can
//! already do (dialogs, animations, sample messages); it grants no access to
//! anything, so the password only keeps it out of the way. The check uses the
//! same slow Argon2id as the vault, so the stored value is costly to guess from.
use argon2::{Algorithm, Argon2, Params, Version};

const SALT: &[u8] = b"siakap-preview-panel-v1";
const HASH: &str = "0c03d4c9be39814e4b67a9c00b3a39cef636b77b98614367e447e17de40694d4";

fn derive(password: &str) -> String {
    let params = Params::new(65536, 3, 1, Some(32)).expect("valid parameters");
    let mut out = [0u8; 32];
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(password.as_bytes(), SALT, &mut out)
        .expect("argon2 runs");
    out.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn check(password: &str) -> bool {
    let hex = derive(password);
    // Compare every byte so the time doesn't depend on where they differ.
    hex.bytes().zip(HASH.bytes()).fold(hex.len() == HASH.len(), |ok, (a, b)| ok & (a == b))
}

#[cfg(test)]
mod tests {
    #[test]
    fn refuses_wrong_passwords() {
        assert_eq!(super::HASH.len(), 64);
        assert!(!super::check(""));
        assert!(!super::check("password"));
        assert_eq!(super::derive("x"), super::derive("x"));
    }
}
