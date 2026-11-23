# Siakap Terminal

A secure, privacy-focused terminal and SSH client for Windows 10/11. It aims for Tabby's polish, adds MobaXterm-style
tools (an SFTP browser next to the terminal), and Siakap-style macros. Linux works too; macOS should, but is untested.

- **Tabs with split panes**: local shells (PowerShell 7, Windows PowerShell, cmd, every WSL distro) and SSH, in a
  binary split tree. Panes split side by side or top/bottom, and dividers can be dragged.
- **Encrypted vault**: sessions, folders, macros, known hosts, settings and optional saved passwords live in a single
  file encrypted with Argon2id + XChaCha20-Poly1305. The vault auto-locks after a set idle time, and there is a lock button.
- **SSH**: tries the Windows OpenSSH agent first, then Pageant, then a key file (asks for the passphrase) or a password.
  FIDO/YubiKey keys work through the agent. Host keys are trusted on first use, and a changed key is refused outright.
- **Macros**: lines are sent with Enter and a configurable delay between them. The script syntax supports
  `# @wait <ms>`, `# @type <text>` and `{{placeholders}}`, with input validation, folders up to 16 levels, search,
  JSON import/export with duplicate detection, an optional preview, and per-session post-connect macros.
- **SFTP panel**: follows the focused SSH pane over the same connection. You can browse, mkdir, rename, delete,
  download and upload through native dialogs or by drag-and-drop. Transfers are streamed with progress and can be cancelled.
- **YubiKey toggle**: one button attaches every plugged-in YubiKey to WSL with `usbipd`, or detaches them.
- **Privacy**: no telemetry, no update checks, no analytics, and no remote fonts or CDNs. The only network
  traffic is the SSH connections you start. See [SECURITY.md](SECURITY.md).

## Install

Download `Siakap Terminal_x.y.z_x64-setup.exe` (NSIS, per-user) or the `.msi` from the GitHub Releases page or from the
`build` workflow artifacts. Check the download against `SHA256SUMS.txt`:

```powershell
Get-FileHash -Algorithm SHA256 '.\Siakap Terminal_0.1.0_x64-setup.exe'
```

Requirements:

- Windows 10 or 11, x64. WebView2 ships with Windows 11; the installer adds it on Windows 10 if it is missing.
- Optional: [OpenSSH agent](https://learn.microsoft.com/windows-server/administration/openssh/openssh_keymanagement)
  or Pageant for key and FIDO authentication.
- Optional: [usbipd-win](https://github.com/dorssel/usbipd-win) 4.x for the YubiKey toggle.

The first time you start the app it asks for a **master password**, which creates the vault in
`%APPDATA%\dev.siakap.terminal\vault.json`. The password cannot be recovered.

## Using it

| Action | How |
| --- | --- |
| New local shell | `Ctrl+Shift+T`, the **＋** button, or *Sessions → Local shells* |
| Split focused pane | `Ctrl+Shift+D` (side by side), `Ctrl+Shift+E` (top/bottom) |
| Close pane | `Ctrl+Shift+W`, or Enter after the session has ended |
| Next / previous tab | `Ctrl+Tab` / `Ctrl+Shift+Tab` |
| Copy / paste | `Ctrl+Shift+C` / `Ctrl+Shift+V` (or right-click paste); copy-on-select is optional |
| Stop a running macro | `Esc` or **Stop** in the macro bar |
| Collapse the side panel | Click the active rail button, or double-click the panel edge |

Pasting text that contains line breaks always asks for confirmation first (Settings → *Confirm before pasting multiple lines*).

### Macro syntax

```text
# Lines starting with # are comments
uname -a                  ← sent followed by Enter
# @wait 1500              ← pause 1.5 s (max 3600000 ms); Stop cancels it
# @type y                 ← sends "y" without Enter
ping -c 3 {{host}}        ← {{host}} is asked once per run
```

- A blank line inside a script sends a bare Enter. Blank lines at the end are ignored.
- **Safe** validation mode (the default) accepts only `A–Z a–z 0–9`, space and `_ . / : @ , + -` in placeholder values.
- **Unrestricted** mode accepts anything except control characters.
- A macro only ever types into the pane that had focus when you started it. It stops if that pane closes or you
  focus another one.

### YubiKey and WSL

Share the key with usbipd once. This needs an elevated terminal, and Siakap never elevates on its own:

```powershell
usbipd list
usbipd bind --busid <BUSID>
```

After that, the 🔑 button attaches every connected YubiKey (USB VID 1050) to WSL, or detaches them. If some keys
are attached and others aren't, it refuses and asks you to sort them out manually.

## Build from source

Prerequisites on Windows:

- [Rust](https://rustup.rs) stable (MSVC toolchain)
- The "Desktop development with C++" workload from Visual Studio Build Tools
- [Node.js](https://nodejs.org) 22+

```powershell
npm ci
npm run tauri dev      # run in development
npm run tauri build    # installers in target\release\bundle\{nsis,msi}
```

On Linux, install WebKitGTK first: `libwebkit2gtk-4.1-dev librsvg2-dev libayatana-appindicator3-dev`.

Tests:

```powershell
cargo test -p siakap-core   # vault, macros, folders, usbipd JSON, host-key TOFU, pty
npm test                    # TypeScript macro parser (Node's built-in test runner)
npm run build               # type-check + production frontend bundle
```

The SSH/SFTP live test runs only when you point it at a server whose home directory contains a file named `big.bin`:

```powershell
$env:SIAKAP_TEST_SSH = "user:password@127.0.0.1:22"; cargo test -p siakap-core --test ssh_live
```

On every push, the [`build` workflow](.github/workflows/build.yml) runs the tests on `windows-latest` and builds the
NSIS and MSI installers. It uploads them together with `SHA256SUMS.txt`. A `v*` tag also publishes a GitHub Release.

## Layout

```text
core/            siakap-core — no Tauri dependency, unit-tested
  src/vault.rs     encrypted store (atomic writes, zeroized keys)
  src/model.rs     sessions, macros, settings, folder normalisation
  src/macros.rs    macro parser, placeholder validation, import/export
  src/pty.rs       local shells (portable-pty → ConPTY)
  src/ssh.rs       russh client, TOFU, agent/Pageant/key/password auth
  src/sftp.rs      SFTP over the same SSH connection, chunked transfers
  src/yubikey.rs   usbipd state/attach/detach
src-tauri/       thin #[tauri::command] layer, app state, capabilities
src/             vanilla TypeScript frontend (xterm.js)
  main.ts  api.ts  tabs.ts  sidebar.ts  runner.ts  macros.ts  sftp.ts  settings.ts  ui.ts  styles.css
```

## Known limitations (v0.1)

- Deleting a folder over SFTP works only when the folder is empty.
- Agent identities that are OpenSSH *certificates* are skipped; plain keys work.
- Locking the vault hides open terminals but does not disconnect them (see SECURITY.md).
- Keyboard-interactive (2FA prompt) authentication is not implemented yet.

## License

MIT
