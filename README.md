# Siakap Terminal

Siakap Terminal is an internal terminal and SSH client for Windows 10 and 11. I wanted something that looks as clean as Tabby,
has MobaXterm's habit of putting an SFTP browser next to the terminal, and keeps the macros I've been using in
Siakap. It also had to keep everything encrypted on disk and stay quiet on the network.

It runs on Linux too. macOS will probably work, but I haven't tried it.

## Features

- **Tabs and split panes.** Local shells (PowerShell 7, Windows PowerShell, cmd, and any WSL distro) and SSH
  sessions, in tabs that split side by side or top and bottom. You can drag the dividers.
- **Encrypted vault.** Sessions, folders, macros, known hosts, settings and saved passwords all live in one file,
  encrypted with Argon2id and XChaCha20-Poly1305. It locks itself after a configurable idle time, or when you click
  Lock.
- **SSH.** Authentication tries the Windows OpenSSH agent first, then Pageant, then a key file (with a passphrase
  prompt) or a password. FIDO keys such as a YubiKey work through the agent. Host keys are trusted on first use, and a
  changed key is refused, full stop.
- **Macros.** Scripts send one line at a time with a short delay between lines. They support `# @wait`, `# @type`
  and `{{placeholders}}`. You can sort them into folders, search them, import and export them as JSON, preview them
  before they run, and attach one to a session so it runs right after connecting.
- **SFTP.** The side panel follows whichever SSH tab is focused and reuses its connection. Browse, create folders,
  rename, delete, download and upload with the native file dialogs, or drag files onto the panel. Transfers stream in
  chunks, show progress and can be cancelled.
- **YubiKey toggle.** One button moves your YubiKey between Windows and WSL using `usbipd`.
- **No phoning home.** There is no telemetry, no update check and no analytics, and the app loads no remote fonts or
  scripts. The only network connections it makes are the SSH sessions you open.

## Installing

Grab the installer from the [Releases](https://github.com/Shaqqiem/siakap-term/releases) page (you need access to
this repository): either the `setup.exe` (installs per user, no admin needed) or the `.msi`. Each release comes with
a `SHA256SUMS.txt`. Check the file you downloaded before running it:

```powershell
Get-FileHash -Algorithm SHA256 '.\Siakap Terminal_0.1.0_x64-setup.exe'
```

You need Windows 10 or 11 (x64). The app uses WebView2, which Windows 11 already has; on Windows 10 the installer
adds it if it's missing. If you want agent authentication, turn on the OpenSSH agent service or run Pageant. The
YubiKey button needs [usbipd-win](https://github.com/dorssel/usbipd-win) 4.x.

The first time it starts, Siakap asks you to choose a master password and creates the vault at
`%APPDATA%\dev.siakap.terminal\vault.json`. There's no recovery if you forget the password.

## Using it

| What | How |
| --- | --- |
| New local shell | `Ctrl+Shift+T`, the + button, or pick one under *Local shells* |
| Split the focused pane | `Ctrl+Shift+D` side by side, `Ctrl+Shift+E` top and bottom |
| Close a pane | `Ctrl+Shift+W`, or press Enter once the session has ended |
| Switch tabs | `Ctrl+Tab` and `Ctrl+Shift+Tab` |
| Copy and paste | `Ctrl+Shift+C` and `Ctrl+Shift+V`; copy on select is in Settings |
| Stop a running macro | `Esc`, or the Stop button in the macro bar |
| Hide the side panel | Click the active icon in the left rail, or double-click the panel edge |

When the clipboard contains more than one line, the app shows what's about to be pasted and asks first. You can turn
this off in Settings, but I'd leave it on.

### Writing macros

```text
# Lines starting with # are comments.
uname -a
# @wait 1500
# @type y
ping -c 3 {{host}}
```

Each ordinary line is typed and followed by Enter. `# @wait 1500` pauses for 1.5 seconds (the limit is one hour, and
Stop cancels the wait). `# @type y` types `y` without pressing Enter. `{{host}}` asks you for a value once per run,
however many times it appears. A blank line in the middle of a script sends a bare Enter; blank lines at the end are
ignored.

By default, placeholder values may only contain letters, digits, spaces and `_ . / : @ , + -`, which keeps a stray
`;` or `$(...)` out of your commands. You can switch to unrestricted mode in Settings; control characters are still
rejected there, so a value can never sneak in an extra Enter.

A macro only types into the pane that had focus when you started it. If that pane closes or you click into another
one, the macro stops.

### YubiKey and WSL

usbipd has to share the key once, and that needs an elevated terminal. Siakap won't try to elevate for you:

```powershell
usbipd list
usbipd bind --busid <BUSID>
```

After that, the key button in the left rail attaches every plugged-in YubiKey to WSL, or detaches them all. If some
are attached and some aren't, it refuses and asks you to fix that by hand.

## Building from source

On Windows you need [Rust](https://rustup.rs) (stable, MSVC toolchain), the "Desktop development with C++" workload
from the Visual Studio Build Tools, and [Node.js](https://nodejs.org) 22 or newer.

```powershell
npm ci
npm run tauri dev
```

`npm run tauri build` produces the installers in `target\release\bundle\nsis` and `target\release\bundle\msi`.

On Linux you'll also need the WebKitGTK development packages:
`libwebkit2gtk-4.1-dev librsvg2-dev libayatana-appindicator3-dev`.

### Tests

```powershell
cargo test -p siakap-core
npm test
npm run build
```

The Rust tests cover the vault, the macro parser, folder handling, usbipd output parsing and host-key checks. `npm test`
runs the TypeScript macro parser tests with Node's built-in runner. `npm run build` type-checks the frontend and
builds it.

There's also a live SSH and SFTP test. It only runs when you point it at a real server whose home directory contains a
file called `big.bin`:

```powershell
$env:SIAKAP_TEST_SSH = "user:password@127.0.0.1:22"
cargo test -p siakap-core --test ssh_live
```

CI runs the tests on `windows-latest` and builds both installers on every push (see
[`.github/workflows/build.yml`](.github/workflows/build.yml)). The first time a new version number reaches `main`,
CI also publishes a release for it with the installers and `SHA256SUMS.txt`. To ship an update, bump `version` in
`src-tauri/tauri.conf.json` and `package.json`, then push to `main`.

## Project layout

```text
core/          Rust library with no Tauri dependency
  vault.rs       encrypted storage
  model.rs       sessions, macros, settings, folder rules
  macros.rs      macro parser and input validation
  pty.rs         local shells (ConPTY on Windows)
  ssh.rs         SSH client and host-key checks
  sftp.rs        SFTP over an existing SSH connection
  yubikey.rs     usbipd integration
src-tauri/     Tauri commands, app state and capabilities
src/           TypeScript frontend built on xterm.js
```

## Known limitations

- SFTP can only delete empty folders.
- If an agent offers OpenSSH certificates, those are skipped; plain keys work.
- Locking the vault hides your terminals but doesn't disconnect them. SECURITY.md explains why.
- Keyboard-interactive login (servers that prompt for a one-time code) isn't supported yet.

## Security

See [SECURITY.md](SECURITY.md) for what the app protects against, what it doesn't, and how to report a problem.

## License

Proprietary. For internal use only; not for redistribution.
