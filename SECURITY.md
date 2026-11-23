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

**File transfers can't destroy files.** SFTP uploads never open the existing remote file. Data goes to a new,
randomly named temporary file next to it, created exclusively, and is only moved into place once the transfer has
finished. That uses OpenSSH's atomic `posix-rename` where the server supports it. Otherwise the old file is moved aside,
the new one moved in, and the old one restored if that fails. If a file already exists, Siakap asks before replacing it
and keeps its permissions. A failed or cancelled upload removes only its own temporary file. Downloads work the same
way on your PC: an unpredictable temporary name, created exclusively, renamed over the target only when complete.

**Partial writes.** Saves go to a temporary file first, which is flushed to disk and then renamed over the old one. A
crash or power cut leaves you with either the old vault or the new one, never half of each.

**Secrets in the UI.** Saved passwords never reach the web view. The interface only learns *whether* a session has a
saved password; the Rust side looks it up when connecting. The master password and any one-off password you type do
pass through the web view once, on their way in.

**Secrets in memory.** On the Rust side, the vault key and saved passwords are zeroed when they're dropped. Locking the
vault, by hand or after the idle timeout, drops the key and all decrypted data. When the vault locks, the interface also forgets what it showed from the vault: session and macro lists,
settings, SFTP listings, open dialogs and messages. You can choose to have every terminal disconnected on lock as
well (Settings > Security).

**Guessing the master password.** After three wrong attempts, each further attempt waits 1, 2, 4 and so on, up to 30
seconds, before it is checked. On Linux and macOS the vault file is readable by your user only (0600); on Windows it
sits in your per-user AppData folder.

**Opening without the master password (optional, off by default).** If you untick *Ask for the master password when
Siakap opens*, Siakap saves the vault key in `remember.json` next to the vault, encrypted by Windows (DPAPI,
`CryptProtectData`) for your Windows account, with an app-specific extra value. Only your Windows account on this PC
can decrypt it; copying the files to another PC or account doesn't open the vault. Turning the option off needs the
master password. Ticking the box again deletes the file, and changing the master password replaces it. If the saved key
can't be used, Siakap deletes it and asks for the password. The Lock button and auto-lock still need the password.
The option isn't offered on Linux or macOS.

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

Text from the vault is always inserted with `textContent`, never as HTML. The web view can't navigate away from the
app's own pages (enforced by the backend), and it can't open new windows. Links that a program or server prints into
the terminal (OSC 8 hyperlinks) are never opened. Clicking one shows the address as text, with a button to copy it.

**Access to your system.** The web view gets Tauri's core defaults and nothing else: no dialog, shell or filesystem
permission. The backend treats the web view as untrusted, as if it could be running injected script, and limits what
it can ask for:

- **Files:** file dialogs are opened by the backend. Each path you pick, or drop onto the window, becomes a one-time
  grant, and file commands (import, export, upload, download) refuse any other path. Injected script can't read or
  write files you didn't choose.
- **Host keys:** `trust_host_key` only accepts the exact key a server presented in a connection that was just refused.
  A key can't be planted for a host you never connected to.
- **Locked means locked:** while the vault is locked, every command that opens, types into or lists terminals, files,
  serial ports or the security key is refused.
- **Programs:** shells are picked from a detected list by id. Host names, user names and serial port names are
  validated, SFTP names can't contain `/` or be `..`, and usbipd bus ids may only contain digits and dashes.

**Running other programs.** `usbipd`, `wsl` and the shells are started with fixed argument lists, never through a
shell command line. On Windows they run without a console window. Program locations are resolved to absolute paths:
`usbipd` from its standard install folder first, then `PATH`, ignoring any relative `PATH` entries. The current folder
is never searched. Every usbipd call has a time limit, and its output is validated strictly (bus id format, sharing
identity, client address, consistent states, no repeated bus ids). The security key action re-checks that the chosen
device is still the same one before it runs, and never asks for administrator rights.

**Pasting.** Pasting text that contains line breaks shows you the text and asks before sending it.

**Macro input.** In the default safe mode, placeholder values must match `^[A-Za-z0-9 _./:@,+-]+$`. Unrestricted mode
still rejects control characters, so a value can't add an Enter. The check runs in the Rust backend using the setting
stored in the vault, so it can't be bypassed from the web view. A macro only types into the pane it started in, and
stops if that pane closes or loses focus.

**Backups.** Imports are parsed and validated in the Rust backend (20 MB and 20,000-entry limits; every macro,
folder, host, user and serial setting is checked). Duplicate macros are skipped, and nothing existing is overwritten.
Imported macros must be reviewed before their first run, and imported startup commands stay switched off until you
enable them. Exports never contain passwords.

**Privacy.** The app has no telemetry, analytics, crash reporting or update check, and loads no remote fonts or
scripts. It doesn't log terminal output, passwords or keys. The only network traffic is the SSH sessions you start.

## What is not protected

- **Malware running as you while the vault is unlocked.** It can read memory, log keystrokes, watch the clipboard or
  drive the app. No desktop app can defend against that.
- **Your Windows account, if you open without the master password.** With that option on, anyone or any program that
  can use your signed-in Windows account can open the vault: someone at your unlocked PC, malware running as you, or
  an attacker who learns your Windows password. Keep the option off on shared PCs, and lock Windows when you walk away.
- **A weak master password.** Argon2id makes guessing slow, not impossible. New master passwords must be at least 12
  characters, use more than a handful of different characters and not be a well-known weak password, but these checks
  can't measure real strength. A short sentence of unrelated words is a good choice. Vaults created before this rule
  keep unlocking with their existing password; the rule applies when you set a new one.
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

## Supply chain

- Dependencies are locked (`Cargo.lock`, `package-lock.json`), and CI builds with `--locked` / `npm ci`.
- Every GitHub Action in the workflow is pinned to a full commit hash, not a movable tag.
- CI runs `cargo audit` (RustSec) and `npm audit` on every push. When this was written, neither reported a known
  vulnerability. `cargo audit` lists three advisories that are not vulnerabilities: `chrono` and `proc-macro-error`
  are unmaintained, and `glib` has an unsoundness advisory, but `glib` is only used by the Linux build (GTK), not on
  Windows.

## Implementation details

- Cryptography uses the RustCrypto crates: `argon2` 0.5 and `chacha20poly1305` 0.10, with randomness from the
  operating system (`OsRng`). The SSH library is russh, built with the `ring` crypto backend.
- The vault file format is `{version: 1, kdf: {alg: "argon2id", m, t, p, salt}, nonce, ciphertext}`, with binary
  fields in base64. The authenticated header string is `siakap-vault|v<version>|<alg>|m=<m>|t=<t>|p=<p>|<salt>`.
- Changing the master password re-encrypts the vault with a new salt. It never lowers the KDF settings.
- Tauri's `freezePrototype` option is off, because xterm.js modifies built-in prototypes when it loads and breaks with
  it enabled.
