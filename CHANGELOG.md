# Changelog

All notable changes to Siakap Terminal. Versions follow [Semantic Versioning](https://semver.org/); dates are
release dates. Each release on the [Releases page](https://github.com/Shaqqiem/siakap-term/releases) shows its section
from this file.

## [0.7.3] - 2026-11-26

**A pink and gold theme, problem reports, and a sturdier update check.**

### New
- **Orchid** and **Orchid Light** themes: pink, purple, green and gold.
- **Report a problem** in Settings → About. It makes a plain-text report of the app and Windows versions, your
  settings, counts of sessions and macros, and the errors the app ran into since it started. Read it, then save it to
  a file or copy it and send it to the developer. Server names, user names and IP addresses are hidden by default.
  Nothing is sent by the app, and terminal output, passwords and keys are never included.
- If something unexpected goes wrong inside Siakap, a message points you to *Report a problem*.

### Fixed
- **Check for updates** could fail with *GitHub answered with an error (403)* on networks where many people share one
  address, because GitHub limits how often its update service can be asked. Siakap now falls back to reading the
  Releases page, so the check and *Download and install* still work.

## [0.7.2] - 2026-11-26

**Touchscreen support.** Use Siakap with your fingers on a touch laptop or tablet.

### New
- **Swipe to scroll** a terminal with one finger. The text follows your finger, and a quick flick keeps scrolling and
  slows down naturally.
- Swiping also works inside full-screen programs such as `less`, `vim` and `htop`.
- **Tap** a terminal to focus it, so the on-screen keyboard types into it.
- **Pinch** with two fingers to make a pane's text bigger or smaller.

### Improved
- In the Sessions and Macros lists, a swipe now scrolls the list. To drag a session or macro into a folder, press and
  hold it for about half a second first.

## [0.7.1] - 2026-11-26

**Update with one click.**

### New
- **Download and install** in Settings → About. After *Check for updates* finds a newer version, Siakap downloads it
  with a progress bar, checks it against the release's SHA-256 checksum, and after a short countdown closes, updates
  itself and opens again. It asks first if sessions are open, and *Not now* lets you install later.

### Security
- Downloads only come from this repository's release files, the file must match `SHA256SUMS.txt` before anything
  runs, and only that exact file is run. See [SECURITY.md](SECURITY.md) for what this does and doesn't protect against.

## [0.7.0] - 2026-11-26

**Themes that reskin everything, sounds, a screensaver and a welcome splash.**

### New
- **App skin:** a theme now colours the whole app (panels, tabs, menus, dialogs and the lock screen), not just the
  terminals. Light themes give a light app.
- **Themed app icon:** the window and taskbar icon is redrawn in the theme's colours.
- **Chime** when a tab finishes a command that took a while (a different sound if it failed), with a threshold so
  quick commands stay quiet.
- **Interface sounds** for clicks, Enter, opening and closing tabs and errors, with a volume control. All sounds are
  generated in the app; there are no sound files.
- **Screensaver:** pixel-art siakap swim across the screen after a few idle minutes. The key that wakes the app is never
  typed into a terminal.
- **Welcome splash** with the logo, a greeting and the version when Siakap starts.
- **Undo** (`Ctrl+Z`) and **Revert all** for settings.

### Fixed
- The guided tour now brings up the screen each step talks about (it used to point at things hidden behind Settings),
  and the highlighted part can be clicked. Some steps carry on by themselves when you try them, and the tour never
  takes keystrokes meant for a terminal.

## [0.6.3] - 2026-11-25

**A Siakap-branded installer that updates in place.**

### Improved
- The installer has Siakap artwork, its own welcome and finish pages and the app icon; the MSI matches.
- Installing a newer version no longer asks to uninstall the old one first. It installs over it and keeps your
  sessions, macros and settings.

### Fixed
- Avoids the uninstaller's *Delete the application data* box during updates, which could delete your vault if ticked.

## [0.6.2] - 2026-11-25

### New
- **Check for updates** in Settings → About. Only when you click it, Siakap asks GitHub for the newest release and shows
  its notes and a download link.

## [0.6.1] - 2026-11-25

**Many more settings.**

### New
- Interface size, rail labels, tab width and close-on-hover.
- Text weight, letter spacing, padding, inactive cursor, mouse-wheel speed and tab stops.
- Open new tabs next to the current one, program titles on tabs, a notice when a command finishes in another tab,
  start maximised, and confirm before closing the window.
- **Connections:** SSH keep-alive, connection timeout, automatic reconnect, and a default user and port for new
  sessions.
- Don't run a single pasted line by itself; trim spaces from copied lines.
- Show hidden SFTP files; timestamps in session logs; lock when minimised.
- The version is shown at the top of Settings and on the welcome screen.

## [0.6.0] - 2026-11-25

**Settings, rebuilt.**

### New
- Settings opens as its own tab, with sections, a search box and changes that save as you make them.
- A gallery of colour themes (Campbell, One Half Dark, Dracula, Nord, Gruvbox, Tokyo Night, Solarized and more), a
  full colour editor with all 16 terminal colours and the app accent, and your own saved themes.
- Import and export themes as JSON, including Windows Terminal colour schemes.
- Line spacing, cursor shape and blinking, better contrast for hard-to-read colours, the terminal bell and word
  boundaries.

## [0.5.4] - 2026-11-23

### New
- **Save output to file:** everything in a terminal, scrollback included, as plain text.
- **Session logs:** log a terminal to a file while it runs, or log every terminal automatically into a folder you choose.
  A red REC badge shows while recording.

### Changed
- The + button always opens a new tab.

## [0.5.3] - 2026-11-23

### Improved
- **Split** now adds an empty pane that asks what to show: move one of your open sessions into it, open a terminal, or
  pick a saved session. Opening a session from the Sessions panel fills the empty pane.

### Fixed
- The SFTP panel now refreshes when the SSH session it follows finishes connecting.

## [0.5.2] - 2026-11-23

### Fixed
- Terminals now start at the pane's real size. They used to start at 80×24, which squeezed and overlapped the output of
  full-screen tools (seen with WSL).

## [0.5.1] - 2026-11-23

### New
- **Right-click pastes** in a terminal; with text selected, right-click copies. Shift+right-click opens the menu.

### Fixed
- Copy and paste now work reliably on Windows: they go through the app instead of the web view, which could refuse
  clipboard access.

## [0.5.0] - 2026-11-23

### New
- **Folders** for sessions, with right-click menus for sessions, folders, tabs and terminals.
- Drag tabs to reorder them; drag sessions and macros onto folders.
- A close button on every pane, and the split buttons only split a tab once (up to four panes).
- A font picker that lists the fonts installed on your PC.

### Changed
- The automatic Local shells and Serial ports lists were removed from the Sessions panel; right-click + to open any
  terminal or saved session.

## [0.4.4] - 2026-11-23

### New
- On first launch you can choose **not to use a master password** on this PC. The vault is still encrypted and opens
  with your Windows account only.

## [0.4.3] - 2026-11-23

### New
- **Open without the master password** (Settings → Security). The vault key is kept for your Windows account only;
  Lock and auto-lock still ask for the password.

## [0.4.2] - 2026-11-23

### Improved
- Moving a security key confirms the result faster, with a progress message while it works.

## [0.4.1] - 2026-11-23

### Improved
- The security key button lists your keys so you can choose which one to attach to WSL or detach, and checks that the
  key really moved.

## [0.4.0] - 2026-11-23

### New
- **Import from MobaXterm:** sessions (`.mxtsessions`) and macros (`.mxtmacros`), including folders, serial ports,
  WSL and login macros.
- `@key` in macros to press keys such as Enter, Tab, arrows or Ctrl+C.
- The tabs now sit in the window's title bar, with your own minimise, maximise and close buttons.

### Fixed
- The security key button failed with a TypeError on Windows.

## [0.3.3] - 2026-11-23

### Security
- Second security review: the web view is treated as untrusted. File commands only accept paths you picked, host keys
  can only be trusted after a server presented them, everything is refused while locked, and the app can't navigate
  away or open windows.

## [0.3.2] - 2026-11-23

### Security
- Safer file transfers (uploads never overwrite a file until they're complete), stronger master password rules, and a
  pinned, audited build pipeline.

## [0.3.1] - 2026-11-23

### Improved
- Macros accept `@wait` and `@type` without the `#`, and the editor explains what each line will do.

## [0.3.0] - 2026-11-23

### New
- **Serial consoles** with COM port detection and a speed list, like MobaXterm.
- The macro features of Siakap 2.1.15: inputs, review before running, folders, search and import of Siakap backups.
- A guided tour for new installs, and a "What's new" tour after updates.

### Improved
- A friendlier interface for new users, with advanced options tucked away.

## [0.2.0] - 2026-11-23

### New
- Choose what opens at startup (for example your WSL distro), a 2×2 grid split, and a default shell.

## [0.1.0] - 2026-11-23

First release.

- SSH and local terminals (PowerShell, cmd, WSL) in tabs with split panes.
- An encrypted vault for sessions, macros, known hosts and saved passwords.
- Siakap-style macros, an SFTP panel and a security key button for WSL.

[0.7.3]: https://github.com/Shaqqiem/siakap-term/compare/v0.7.2...v0.7.3
[0.7.2]: https://github.com/Shaqqiem/siakap-term/compare/v0.7.1...v0.7.2
[0.7.1]: https://github.com/Shaqqiem/siakap-term/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/Shaqqiem/siakap-term/compare/v0.6.3...v0.7.0
[0.6.3]: https://github.com/Shaqqiem/siakap-term/compare/v0.6.2...v0.6.3
[0.6.2]: https://github.com/Shaqqiem/siakap-term/compare/v0.6.1...v0.6.2
[0.6.1]: https://github.com/Shaqqiem/siakap-term/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/Shaqqiem/siakap-term/compare/v0.5.4...v0.6.0
[0.5.4]: https://github.com/Shaqqiem/siakap-term/compare/v0.5.3...v0.5.4
[0.5.3]: https://github.com/Shaqqiem/siakap-term/compare/v0.5.2...v0.5.3
[0.5.2]: https://github.com/Shaqqiem/siakap-term/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/Shaqqiem/siakap-term/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/Shaqqiem/siakap-term/compare/v0.4.4...v0.5.0
[0.4.4]: https://github.com/Shaqqiem/siakap-term/compare/v0.4.3...v0.4.4
[0.4.3]: https://github.com/Shaqqiem/siakap-term/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/Shaqqiem/siakap-term/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/Shaqqiem/siakap-term/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/Shaqqiem/siakap-term/compare/v0.3.3...v0.4.0
[0.3.3]: https://github.com/Shaqqiem/siakap-term/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/Shaqqiem/siakap-term/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/Shaqqiem/siakap-term/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/Shaqqiem/siakap-term/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Shaqqiem/siakap-term/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Shaqqiem/siakap-term/releases/tag/v0.1.0
