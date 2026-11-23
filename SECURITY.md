# Security

Siakap Terminal stores SSH sessions, saved passwords and macros on your machine. This page explains what it protects,
what it doesn't, and how to report a problem.

## Reporting a vulnerability

Contact the maintainer directly rather than opening an issue. Include the version, steps to reproduce, and what an
attacker could do with it.

## What is protected

**The vault file.** Everything is kept in a single file, `vault.json`. The master password goes through Argon2id
(64 MiB of memory, 3 passes, 1 lane, with a random 16-byte salt) to produce a 256-bit key. The data is encrypted with
XChaCha20-Poly1305, using a fresh random 24-byte nonce on every save. Someone who copies the file, from a stolen
laptop, a backup or a synced folder, has to guess your password, and every guess costs them a full Argon2id run.

**Tampering.** The ciphertext is authenticated, and so is the file header (version, KDF settings and salt). Changing
any of it makes unlocking fail. The app also refuses KDF settings outside sane limits, so a modified file can't quietly
weaken the key derivation.

**Partial writes.** Saves go to a temporary file first, which is flushed to disk and then renamed over the old one. A
crash or power cut leaves you with either the old vault or the new one, never half of each.

**Secrets in the UI.** Saved passwords never reach the web view. The interface only learns *whether* a session has a
saved password; the Rust side looks it up when connecting. The master password and any one-off password you type do
pass through the web view once, on their way in.

**Secrets in memory.** On the Rust side, the vault key and saved passwords are zeroed when they're dropped. Locking the
vault, by hand or after the idle timeout, drops the key and all decrypted data.

**SSH host keys.** The first time you connect to a host, you see its SHA-256 fingerprint and decide whether to trust
it. Trusted keys are stored inside the vault, not in a plain `known_hosts` file. If a host later presents a different
key, the connection is refused with a warning, and nothing in the UI lets you click past it. This includes a key of a
different type, so an attacker can't turn the hard stop into a "trust this new key?" prompt by offering another
algorithm. To accept a legitimately changed key, remove the old entry under Settings > Known hosts and connect again.

**The web view.** The content security policy only allows the app's own bundled files:

```text
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;
connect-src ipc: http://ipc.localhost
```

Text from the vault is always inserted with `textContent`, never as HTML.

**Access to your system.** The web view gets Tauri's core defaults plus the open and save file dialogs, and nothing
else. There is no shell plugin and no filesystem plugin. Every file or process operation goes through one of the app's
own commands, and each command checks its input:

- shells are picked from a detected list by id
- host names and user names are validated
- local file paths must be absolute paths returned by a dialog
- SFTP names can't contain `/` or be `..`
- usbipd bus ids may only contain digits and dashes

**Running other programs.** `usbipd`, `wsl` and the shells are started with fixed argument lists, never through a
shell command line. On Windows they run without a console window.

**Pasting.** Pasting text that contains line breaks shows you the text and asks before sending it.

**Macro input.** In the default safe mode, placeholder values must match `^[A-Za-z0-9 _./:@,+-]+$`. Unrestricted mode
still rejects control characters, so a value can't add an Enter. The check runs in the Rust backend using the setting
stored in the vault, so it can't be bypassed from the web view. A macro only types into the pane it started in, and
stops if that pane closes or loses focus.

**Privacy.** The app has no telemetry, analytics, crash reporting or update check, and loads no remote fonts or
scripts. It doesn't log terminal output, passwords or keys. The only network traffic is the SSH sessions you start.

## What is not protected

- **Malware running as you while the vault is unlocked.** It can read memory, log keystrokes, watch the clipboard or
  drive the app. No desktop app can defend against that.
- **A weak master password.** Argon2id makes guessing slow, not impossible. Eight characters is the minimum, but a
  long passphrase is much better.
- **Terminals left open after locking.** Locking wipes the vault from memory and hides the window contents, but open
  SSH and local sessions keep running, and their scrollback stays in memory. I chose this so a short idle timeout
  doesn't kill long-running jobs. Close the sessions you don't want left open.
- **JavaScript memory.** Passwords typed into the web view are JavaScript strings, which can't be wiped. They're
  dropped right after use, but may sit in freed memory until it is reused.
- **Swap, hibernation files and crash dumps.** These can contain decrypted data. Use full-disk encryption such as
  BitLocker.
- **File metadata.** The vault's size and modification time show roughly how much is stored and when it last changed.
- **Your SSH agent.** Any program running as you can ask the agent to sign. A FIDO key that requires a touch is the
  best protection here.
- **WebView2.** It's a Microsoft component that Windows updates on its own schedule. Siakap only loads its own files
  into it, and Tauri disables SmartScreen lookups, but the runtime itself is outside this app's control.
- **The servers you connect to**, and whatever they do with what you type.
- **Exported macros.** These are plain JSON files, so don't put secrets in macros.

## Implementation details

- Cryptography uses the RustCrypto crates: `argon2` 0.5 and `chacha20poly1305` 0.10, with randomness from the
  operating system (`OsRng`). The SSH library is russh, built with the `ring` crypto backend.
- The vault file format is `{version: 1, kdf: {alg: "argon2id", m, t, p, salt}, nonce, ciphertext}`, with binary
  fields in base64. The authenticated header string is `siakap-vault|v<version>|<alg>|m=<m>|t=<t>|p=<p>|<salt>`.
- Changing the master password re-encrypts the vault with a new salt. It never lowers the KDF settings.
- Tauri's `freezePrototype` option is off, because xterm.js modifies built-in prototypes when it loads and breaks with
  it enabled.
