//! Local shells via portable-pty (ConPTY on Windows).

use std::io::{Read, Write};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;

use crate::error::{CoreError, Result};
use crate::process::{run_capture_timeout, which};

/// Output event for a terminal (shared by local and SSH terminals).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TermEvent {
    Data(Vec<u8>),
    Exit(Option<i32>),
}

pub type EventSink = Arc<dyn Fn(TermEvent) + Send + Sync>;

/// Writes on a background thread, in order. A terminal whose program isn't
/// reading its input (or a slow serial line) fills the pipe and `write`
/// would block; callers on the UI's thread must never wait for that.
pub struct QueuedWriter {
    tx: Mutex<Option<mpsc::Sender<Vec<u8>>>>,
}

impl QueuedWriter {
    pub fn new(mut w: Box<dyn Write + Send>, name: &str) -> Result<Self> {
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        std::thread::Builder::new()
            .name(name.into())
            .spawn(move || {
                for data in rx {
                    if w.write_all(&data).and_then(|()| w.flush()).is_err() {
                        break; // the program or device is gone
                    }
                }
            })
            .map_err(CoreError::from)?;
        Ok(Self { tx: Mutex::new(Some(tx)) })
    }

    /// Queue `data`; returns at once.
    pub fn write(&self, data: &[u8]) -> Result<()> {
        if data.is_empty() {
            return Ok(());
        }
        let g = self.tx.lock().map_err(|_| CoreError::invalid("poisoned"))?;
        let tx = g.as_ref().ok_or_else(|| CoreError::invalid("The terminal is closed."))?;
        tx.send(data.to_vec()).map_err(|_| CoreError::invalid("The terminal is closed."))
    }

    /// Stop accepting writes; queued data is still written, then the thread ends.
    pub fn close(&self) {
        if let Ok(mut g) = self.tx.lock() {
            g.take();
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellInfo {
    pub id: String,
    pub label: String,
    #[serde(skip)]
    pub program: String,
    #[serde(skip)]
    pub args: Vec<String>,
}

fn shell(id: &str, label: &str, program: impl Into<String>, args: &[&str]) -> ShellInfo {
    ShellInfo {
        id: id.into(),
        label: label.into(),
        program: program.into(),
        args: args.iter().map(|s| s.to_string()).collect(),
    }
}

/// Parse `wsl -l -q` output into distro names.
pub fn parse_wsl_list(out: &str) -> Vec<String> {
    out.lines()
        .map(|l| l.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}' || c == '\0'))
        .filter(|l| !l.is_empty())
        .filter(|l| l.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')))
        .map(String::from)
        .collect()
}

/// Shells found by the last detection. Detecting runs `wsl -l` on Windows,
/// which is slow, so opening a terminal uses this list and only refreshes it
/// when the shell asked for isn't in it.
static SHELLS: Mutex<Option<Vec<ShellInfo>>> = Mutex::new(None);

/// Detect available shells again (and remember them). The frontend only ever
/// passes back an `id`; the program and arguments come from this list.
pub fn detect_shells() -> Vec<ShellInfo> {
    let v = detect_now();
    if let Ok(mut g) = SHELLS.lock() {
        *g = Some(v.clone());
    }
    v
}

/// The remembered list, detecting it the first time.
pub fn known_shells() -> Vec<ShellInfo> {
    if let Some(v) = SHELLS.lock().ok().and_then(|g| g.clone()) {
        return v;
    }
    detect_shells()
}

fn detect_now() -> Vec<ShellInfo> {
    let mut v = Vec::new();
    if cfg!(windows) {
        if let Some(p) = which("pwsh") {
            v.push(shell("pwsh", "PowerShell 7", p.to_string_lossy(), &["-NoLogo"]));
        }
        if let Some(p) = which("powershell") {
            v.push(shell("powershell", "Windows PowerShell", p.to_string_lossy(), &["-NoLogo"]));
        }
        if let Some(p) = which("cmd") {
            v.push(shell("cmd", "Command Prompt", p.to_string_lossy(), &[]));
        }
        if let Some(wsl) = which("wsl") {
            let wsl = wsl.to_string_lossy().to_string();
            // A stuck WSL service can hang `wsl -l` for ever; never wait long.
            if let Ok(out) = run_capture_timeout(&wsl, &["-l", "-q"], Duration::from_secs(4)) {
                if out.success {
                    for d in parse_wsl_list(&out.stdout) {
                        v.push(shell(&format!("wsl:{d}"), &format!("WSL: {d}"), wsl.clone(), &["-d", &d]));
                    }
                }
            }
        }
    } else {
        if let Ok(sh) = std::env::var("SHELL") {
            if std::path::Path::new(&sh).is_file() {
                let name =
                    std::path::Path::new(&sh).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                v.push(shell("login", &format!("{name} (login shell)"), sh, &["-l"]));
            }
        }
        let mut seen = std::collections::HashSet::new();
        for (id, path) in [
            ("zsh", "/bin/zsh"),
            ("bash", "/opt/homebrew/bin/bash"), // newer bash from Homebrew (macOS)
            ("bash", "/usr/local/bin/bash"),
            ("bash", "/bin/bash"),
            ("fish", "/opt/homebrew/bin/fish"),
            ("fish", "/usr/local/bin/fish"),
            ("fish", "/usr/bin/fish"),
            ("sh", "/bin/sh"),
        ] {
            if std::path::Path::new(path).is_file() && seen.insert(id) {
                v.push(shell(id, id, path, &[]));
            }
        }
    }
    v
}

pub fn find_shell(id: &str) -> Result<ShellInfo> {
    let mut all = known_shells();
    if !id.is_empty() && !all.iter().any(|s| s.id == id) {
        all = detect_shells(); // a WSL distro may have been installed since
    }
    if id.is_empty() {
        return all.into_iter().next().ok_or_else(|| CoreError::not_found("no shell available"));
    }
    all.into_iter().find(|s| s.id == id).ok_or_else(|| CoreError::not_found(format!("shell {id:?}")))
}

pub struct LocalPty {
    writer: QueuedWriter,
    master: Arc<Mutex<Option<Box<dyn MasterPty + Send>>>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize { rows: rows.clamp(2, 1000), cols: cols.clamp(2, 1000), pixel_width: 0, pixel_height: 0 }
}

impl LocalPty {
    pub fn spawn(shell: &ShellInfo, cols: u16, rows: u16, sink: EventSink) -> Result<Self> {
        let pair = native_pty_system()
            .openpty(size(cols, rows))
            .map_err(|e| CoreError::Io { message: format!("could not open a pty: {e}") })?;
        let mut cmd = CommandBuilder::new(&shell.program);
        cmd.args(&shell.args);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        // Apps opened from the Finder get no locale, so zsh and friends would
        // fall back to ASCII and mangle accented text and box drawing.
        #[cfg(target_os = "macos")]
        if std::env::var_os("LANG").is_none() && std::env::var_os("LC_ALL").is_none() {
            cmd.env("LANG", "en_US.UTF-8");
        }
        if let Some(home) = home_dir() {
            cmd.cwd(home);
        }
        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| CoreError::Io { message: format!("could not start {}: {e}", shell.label) })?;
        drop(pair.slave);
        let killer = child.clone_killer();
        let mut reader = pair.master.try_clone_reader().map_err(|e| CoreError::Io { message: e.to_string() })?;
        let writer = pair.master.take_writer().map_err(|e| CoreError::Io { message: e.to_string() })?;
        let master = Arc::new(Mutex::new(Some(pair.master)));

        let (done_tx, done_rx) = mpsc::channel::<()>();
        let rsink = sink.clone();
        std::thread::Builder::new()
            .name("pty-reader".into())
            .spawn(move || {
                let mut buf = vec![0u8; 16 * 1024];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => rsink(TermEvent::Data(buf[..n].to_vec())),
                    }
                }
                let _ = done_tx.send(());
            })
            .map_err(CoreError::from)?;

        let wmaster = master.clone();
        std::thread::Builder::new()
            .name("pty-waiter".into())
            .spawn(move || {
                let code = child.wait().ok().map(|s| s.exit_code() as i32);
                // With ConPTY the reader only sees EOF once the pseudoconsole
                // is closed, so drop the master once the child is gone.
                let _ = done_rx.recv_timeout(Duration::from_millis(300));
                if let Ok(mut m) = wmaster.lock() {
                    m.take();
                }
                let _ = done_rx.recv_timeout(Duration::from_secs(2));
                sink(TermEvent::Exit(code));
            })
            .map_err(CoreError::from)?;

        Ok(Self { writer: QueuedWriter::new(writer, "pty-writer")?, master, killer: Mutex::new(killer) })
    }

    /// Queue input for the program; never blocks.
    pub fn write(&self, data: &[u8]) -> Result<()> {
        self.writer.write(data)
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        if let Some(m) = self.master.lock().map_err(|_| CoreError::invalid("poisoned"))?.as_ref() {
            m.resize(size(cols, rows)).map_err(|e| CoreError::Io { message: e.to_string() })?;
        }
        Ok(())
    }

    pub fn close(&self) {
        self.writer.close();
        if let Ok(mut k) = self.killer.lock() {
            let _ = k.kill();
        }
    }
}

impl Drop for LocalPty {
    fn drop(&mut self) {
        self.close();
    }
}

fn home_dir() -> Option<std::path::PathBuf> {
    let v = if cfg!(windows) { std::env::var_os("USERPROFILE") } else { std::env::var_os("HOME") };
    v.map(std::path::PathBuf::from).filter(|p| p.is_dir())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wsl_list_parsing() {
        assert_eq!(
            parse_wsl_list("Ubuntu-22.04\r\n\u{feff}Debian\r\n\r\nbad name;x\n"),
            vec!["Ubuntu-22.04", "Debian"]
        );
    }

    #[cfg(unix)]
    #[test]
    fn writes_never_block_when_the_program_is_not_reading() {
        let sh = shell("sh", "sh", "/bin/sh", &[]);
        let sink: EventSink = Arc::new(|_| {});
        let p = LocalPty::spawn(&sh, 80, 24, sink).unwrap();
        p.write(b"sleep 5\n").unwrap();
        std::thread::sleep(Duration::from_millis(300));
        let t = std::time::Instant::now();
        p.write(&vec![b'x'; 2 * 1024 * 1024]).unwrap();
        assert!(t.elapsed() < Duration::from_millis(500), "write blocked for {:?}", t.elapsed());
        p.close();
    }

    #[cfg(unix)]
    #[test]
    fn local_shell_echo() {
        let sh = shell("sh", "sh", "/bin/sh", &[]);
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        let sink: EventSink = Arc::new(move |e| {
            let _ = tx.lock().unwrap().send(e);
        });
        let p = LocalPty::spawn(&sh, 80, 24, sink).unwrap();
        p.write(b"echo siakap-$((40+2))\nexit 3\n").unwrap();
        let mut out = Vec::new();
        let mut code = None;
        while let Ok(e) = rx.recv_timeout(Duration::from_secs(10)) {
            match e {
                TermEvent::Data(d) => out.extend(d),
                TermEvent::Exit(c) => {
                    code = c;
                    break;
                }
            }
        }
        assert!(String::from_utf8_lossy(&out).contains("siakap-42"));
        assert_eq!(code, Some(3));
    }
}
