# Security

Siakap Terminal keeps SSH sessions, saved passwords and macros on your machine, encrypted. This document covers
what it protects against, what it doesn't, and how it is built.

## Threat model

### Protected

| Threat | Mitigation |
| --- | --- |
| Someone copies the vault file (stolen laptop, backup, cloud-sync leak) | XChaCha20-Poly1305 with a 256-bit key derived by **Argon2id** (m = 64 MiB, t = 3, p = 1, random 16-byte salt) from the master password. Each write uses a fresh 24-byte nonce. |
| Someone tampers with the vault file | The ciphertext is authenticated, and so is the header (version, KDF parameters, salt) as associated data. Any change makes unlocking fail. KDF parameters outside sane bounds are refused, so the file cannot be downgraded to a weak KDF. |
| A crash or power loss during a save | Atomic writes: temp file in the same folder, `fsync`, then rename. |
| Secrets leak into the UI layer | The webview never receives saved passwords: it sees `hasPassword: bool`. The backend looks a password up by session id at connect time. The master password and one-off prompts pass through the webview once, on their way in. |
| Secrets linger in backend memory | Key material is wrapped in `Zeroizing`, and saved secrets are `ZeroizeOnDrop`. Locking (manual or after N idle minutes) drops both, along with all decrypted data. Plaintext buffers are zeroized after use. |
| Man-in-the-middle on SSH | Trust on first use, with known hosts kept **inside** the vault. An unknown key is shown with its SHA-256 fingerprint and is trusted only on explicit approval (`trust_host_key` re-derives the fingerprint and checks it). A *changed* key, including a different key type for a known host, is a hard refusal with a MITM warning, and the UI offers no way to accept it. |
| Script injection into the UI | Strict CSP: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src ipc: http://ipc.localhost`. No remote content of any kind. All dynamic text is written with `textContent`, never `innerHTML`. |
| A compromised renderer gaining broad OS access | Tauri capabilities are `core:default`, `dialog:allow-open` and `dialog:allow-save` only. There is **no shell plugin and no fs plugin**. Every file and process operation is an app command that validates its input: shell ids come from a detected list, hosts and users are validated, file paths must be absolute dialog results, SFTP names can't contain `/` or `..`, and usbipd bus ids are digits and dashes. |
| Command injection through helper programs | `usbipd`, `wsl` and the shells are started with `std::process::Command` and fixed argument arrays, never a shell string. On Windows they get `CREATE_NO_WINDOW`. |
| Accidental command execution from the clipboard | Pasting text with line breaks always asks for confirmation and shows a preview. |
| Macro placeholder injection | In Safe mode (the default), values must match `^[A-Za-z0-9 _./:@,+-]+$`. Unrestricted mode still blocks control characters, so a value can never add an Enter. Validation runs in the backend (`macro_render`) using the vault's setting, so the webview can't bypass it. A macro only types into the pane it started on, and stops if that pane closes or loses focus. |
| Privacy leaks | No telemetry, analytics, crash reporting, update checks, remote fonts or CDNs. The only outbound connections are the SSH sessions you start. Siakap never logs terminal data, passwords or keys. |

### Not protected (by design or for now)

- **Malware running as your user while the vault is unlocked.** It can read process memory, log keystrokes, read
  the clipboard or drive the UI. Siakap is not a sandbox.
- **A weak master password.** Argon2id slows down guessing but cannot save a short or reused password. The minimum
  is 8 characters; use a long passphrase.
- **Open sessions after locking.** Locking wipes the vault from memory and hides the UI, but open SSH and local
  terminals keep running, and their scrollback stays in memory. Close sessions you don't want left running.
- **The JavaScript heap.** Strings typed into the webview (the master password, one-off passwords) can't be zeroized
  in JS. They are dropped right after use, but may stay in freed memory until the garbage collector reuses it.
- **Swap, hibernation files and crash dumps** may contain decrypted data. Use full-disk encryption (BitLocker).
- **Vault metadata.** File size and modification time reveal roughly how much data is stored and when it changed.
- **The SSH agent and Pageant.** Any local process that can reach the agent can ask it to sign. A FIDO/YubiKey key
  with touch required is the strongest option.
- **The WebView2 runtime.** It is a Microsoft component and is updated by Windows, not by Siakap. Tauri starts it with
  `msSmartScreenProtection` disabled, and Siakap loads only bundled local assets. The runtime's own servicing is
  outside this app's control.
- **Server-side compromise**, and anything the remote host does with what you type.
- **Exported macro files** are plain JSON. Don't put secrets in macros.

## Implementation notes

- The crypto crates are `argon2` 0.5 and `chacha20poly1305` 0.10 (RustCrypto), with `rand` 0.8 `OsRng`.
- russh uses the `ring` crypto backend.
- Tauri's `freezePrototype` hardening is **off**, because xterm.js assigns to built-in prototypes when it loads.
- The vault format is `{version: 1, kdf: {alg: "argon2id", m, t, p, salt}, nonce, ciphertext}`, all base64.
  The associated data is `siakap-vault|v<version>|<alg>|m=<m>|t=<t>|p=<p>|<salt>`.
- Changing the master password re-encrypts with a new salt, and never with weaker KDF parameters than before.

## Reporting a vulnerability

Please open a private security advisory on the GitHub repository rather than a public issue. Include the steps to
reproduce, the affected version, and the impact.
