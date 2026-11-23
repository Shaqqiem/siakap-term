//! Local shells via portable-pty (ConPTY on Windows).

use std::io::{Read, Write};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;

use crate::error::{CoreError, Result};
use crate::process::{run_capture, which};

/// Output event for a terminal (shared by local and SSH terminals).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TermEvent {
    Data(Vec<u8>),
    Exit(Option<i32>),
}

pub type EventSink = Arc<dyn Fn(TermEvent) + Send + Sync>;

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

/// Detect available shells. The frontend only ever passes back an `id`;
/// the program and arguments come from this list, never from the UI.
pub fn detect_shells() -> Vec<ShellInfo> {
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
            if let Ok(out) = run_capture(&wsl, &["-l", "-q"]) {
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
        for (id, path) in [("bash", "/bin/bash"), ("zsh", "/bin/zsh"), ("fish", "/usr/bin/fish"), ("sh", "/bin/sh")] {
            if std::path::Path::new(path).is_file() {
                v.push(shell(id, id, path, &[]));
            }
        }
    }
    v
}

pub fn find_shell(id: &str) -> Result<ShellInfo> {
    let all = detect_shells();
    if id.is_empty() {
        return all.into_iter().next().ok_or_else(|| CoreError::not_found("no shell available"));
    }
    all.into_iter().find(|s| s.id == id).ok_or_else(|| CoreError::not_found(format!("shell {id:?}")))
}

pub struct LocalPty {
    writer: Mutex<Box<dyn Write + Send>>,
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

        Ok(Self { writer: Mutex::new(writer), master, killer: Mutex::new(killer) })
    }

    pub fn write(&self, data: &[u8]) -> Result<()> {
        let mut w = self.writer.lock().map_err(|_| CoreError::invalid("poisoned"))?;
        w.write_all(data)?;
        w.flush()?;
        Ok(())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        if let Some(m) = self.master.lock().map_err(|_| CoreError::invalid("poisoned"))?.as_ref() {
            m.resize(size(cols, rows)).map_err(|e| CoreError::Io { message: e.to_string() })?;
        }
        Ok(())
    }

    pub fn close(&self) {
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
