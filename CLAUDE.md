# Siakap Terminal — build brief for Claude Code

A secure, privacy-focused terminal and SSH client for Windows, combining Tabby's polish with MobaXterm's tools and adding Siakap-style macros. Build it in this folder.

## Decisions already made (don't re-ask)
- **Stack:** Tauri **2.x stable** (not 3.0 alpha) with a Rust backend and a **vanilla TypeScript + Vite** frontend (no UI framework, to keep dependencies few), using `@xterm/xterm` + `@xterm/addon-fit`.
- **Target:** Windows 10/11 x64 first (ConPTY + WebView2). Linux and macOS are nice-to-have.
- **v1 scope:** all four of the following:
  1. SSH + local shell tabs (split panes)
  2. Encrypted session vault
  3. Macros sidebar (Siakap-style)
  4. SFTP browser + YubiKey usbipd toggle
- **Delivery:** builds locally with `npm run tauri build`, plus a GitHub Actions workflow that produces a Windows NSIS/MSI installer and SHA-256 checksums.

## Layout
```
Cargo.toml            workspace: core, src-tauri (release: lto, opt-level "s", strip, panic=abort)
core/                 siakap-core: no Tauri dependency, unit-testable
  vault.rs            encrypted store
  pty.rs              local shells (portable-pty 0.9 → ConPTY)
  ssh.rs              russh client, host-key TOFU, agent/key/password auth
  sftp.rs             russh-sftp over the same SSH connection
  yubikey.rs          usbipd state/attach/detach
src-tauri/            thin #[tauri::command] layer + state; capabilities/default.json
src/                  frontend: main.ts, api.ts, tabs.ts (split tree), sidebar.ts,
                      macros.ts (pure parser, unit-tested), sftp.ts, settings.ts, styles.css
.github/workflows/build.yml
README.md, SECURITY.md
```
The `core/Cargo.toml` already present lists the intended crates; check the versions against crates.io. russh is at 0.65 and its API has changed across versions, so let the compiler guide you.

## Security & privacy requirements (non-negotiable)
- **No telemetry, no update checks, no analytics, no remote fonts/CDNs.** The only network traffic is SSH connections the user starts.
- **Strict CSP:** `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src ipc: http://ipc.localhost`. Load no remote content.
- **Minimal Tauri capabilities:** core defaults plus `dialog:allow-open` and `dialog:allow-save` only. **No shell plugin and no fs plugin**; all file and process access goes through the app's own validated commands.
- **Vault:** a single file in the app data directory, holding `{version, kdf:{alg:"argon2id", m:65536, t:3, p:1, salt}, nonce, ciphertext}`.
  - Encryption: XChaCha20-Poly1305 with a key derived by Argon2id from the master password.
  - Writes are atomic (temp file, fsync, rename). Key material is wrapped in `Zeroizing` and wiped on lock.
  - The vault holds sessions, folders, macros, known hosts, settings and optional saved passwords.
  - A master password is set on first launch.
  - **Secrets never go to the frontend.** The frontend gets redacted sessions (`hasPassword: bool`), and the backend looks up the secret by session id when connecting.
  - Auto-lock after N idle minutes (configurable), plus a manual lock button.
- **Host keys:** trust on first use, with the known-hosts list kept *inside* the vault.
  - Unknown key: connecting fails with `HostKeyUnknown {fingerprint SHA256, keyType}`. The UI shows the fingerprint, and on approval calls `trust_host_key` and retries.
  - Changed key: refuse hard with a clear MITM warning. Never auto-accept.
- **SSH auth:** Windows OpenSSH agent (named pipe `\\.\pipe\openssh-ssh-agent`), then Pageant, then a key file (passphrase prompt) or a password. Prefer agent/FIDO keys so the YubiKey works.
- **Processes:** run `usbipd`, shells and other tools with `std::process::Command` and argument arrays only. Never use a shell string. Use `CREATE_NO_WINDOW` on Windows.
- **Paste protection:** confirm before pasting text that contains newlines into a terminal.
- Never log terminal data, passwords or keys.

## Terminal I/O
- Commands: `term_open_local(shell, cols, rows, channel)`, `term_open_ssh(sessionId, cols, rows, channel)`, `term_write(id, data)`, `term_resize(id, cols, rows)`, `term_close(id)`.
- Output is streamed over a Tauri v2 `ipc::Channel` as `{kind:"data", b64}` / `{kind:"exit", code}`. The frontend decodes the base64 into a `Uint8Array` and passes it to `term.write`.
- Local shells: detect `pwsh`, `powershell`, `cmd`, and `wsl` distros (`wsl -l -q`).
- SSH: `request_pty("xterm-256color")`, then a shell, then a `tokio::select!` loop over `channel.wait()` and an mpsc of Write/Resize/Close. Keep the client `Handle` per terminal so SFTP reuses the same connection.

## Macros (port of Siakap 2.1.15 behaviour)
- Script lines are sent with `\r`, with a configurable delay between lines (default 100 ms).
- `# @wait <ms>`: pause, up to 1 hour, and cancellable.
- `# @type <text>`: send without Enter.
- Other `#` lines are comments.
- `{{name}}` placeholders: prompt the user once per unique name. Validate input in "safe" mode (`^[A-Za-z0-9 _./:@,+-]+$`, no control characters) or "unrestricted" mode (control characters still blocked).
- Organise macros in folders up to 16 levels deep (reject `.` and `..`), with search, import/export as JSON, and duplicate detection by signature.
- Optionally show a preview before running.
- Macros only ever target the focused pane. Abort if that session closes or focus changes.
- A session can have a **post-connect macro**.

## SFTP panel (MobaXterm-style)
- Follows the active SSH tab: browse, go up, refresh, mkdir, rename, delete (with confirmation), download/upload through native dialogs, and drag-and-drop upload.
- Show progress, and stream transfers in chunks (no whole-file buffering).

## YubiKey toggle
- Run `usbipd state`, which outputs JSON. Find devices whose `InstanceId` matches `VID_1050` (Yubico).
- If the device is attached, run `usbipd detach --busid X`; otherwise run `usbipd attach --wsl --busid X`.
- If the device isn't shared yet, explain that `usbipd bind` needs admin rights, and don't try to elevate silently.
- If states are inconsistent across multiple keys, refuse with a clear message (same as Siakap).

## UI
- Left rail with these buttons: Sessions, Macros, SFTP, Settings, YubiKey, Lock. The panel beside it is resizable and collapsible, with a dark theme by default.
- Tabs with split panes (binary split tree; horizontal and vertical splits), and a status dot for connected/closed sessions.
- Session editor fields: name, folder, type (SSH/local), host, port, user, auth method, key path, saved password (optional), post-connect macro.
- Settings: font and size, colours, scrollback, copy-on-select, line delay, input-validation mode, auto-lock minutes.

## Definition of done
1. `cargo test -p siakap-core` passes. Tests must cover:
   - vault round-trip, wrong password rejected, tampered ciphertext rejected
   - macro parser and placeholder validation
   - folder normalisation
   - usbipd JSON parsing
2. `npm run build` passes, and `npm run tauri dev` opens a working app on Windows.
3. Manual check: a local PowerShell tab works; SSH to a test host shows the host-key prompt; SFTP lists files; a macro with `{{input}}` and `@wait` runs.
4. `npm run tauri build` produces an installer; the workflow uploads it with `SHA256SUMS.txt`.
5. README covers install, build and features; SECURITY.md covers the threat model and what is and isn't protected.
