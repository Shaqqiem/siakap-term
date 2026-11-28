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
//! * [`serial`] — serial consoles (COM ports)
//! * [`security_key`] — usbipd attach/detach toggle for hardware security keys

pub mod admin;
pub mod backup;
pub mod error;
pub mod fonts;
pub mod forward;
pub mod macros;
pub mod mobaxterm;
pub mod model;
pub mod process;
pub mod pty;
pub mod remember;
pub mod security_key;
pub mod serial;
pub mod sftp;
pub mod ssh;
pub mod termlog;
pub mod update;
pub mod vault;
pub mod wallpaper;

pub use error::{CoreError, Result};
