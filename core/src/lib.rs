// Errors carry host-key details for the UI; they are cold-path, so size is fine.
#![allow(clippy::result_large_err)]

//! Siakap core: everything that does not depend on Tauri.
//!
//! * [`vault`] — encrypted store (Argon2id + XChaCha20-Poly1305)
//! * [`model`] — sessions, macros, settings, folder normalisation
//! * [`macros`] — Siakap macro script parser and placeholder validation
//! * [`pty`] — local shells (ConPTY on Windows)
//! * [`ssh`] — russh client with trust-on-first-use host keys
//! * [`sftp`] — SFTP over the same SSH connection
//! * [`security_key`] — usbipd attach/detach toggle for hardware security keys

pub mod error;
pub mod macros;
pub mod model;
pub mod process;
pub mod pty;
pub mod security_key;
pub mod sftp;
pub mod ssh;
pub mod vault;

pub use error::{CoreError, Result};
