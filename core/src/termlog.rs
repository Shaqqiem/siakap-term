//! Session logs: everything a terminal prints, as plain text, written to a
//! file the user chose (or a log folder they chose). Colour and cursor escape
//! codes are removed so the log reads like the screen did.
//!
//! Logs are plain text on disk. They are only written when the user turns
//! logging on, and contain whatever the terminal showed, so they can hold
//! sensitive output.

use std::fs::{File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

use crate::error::{CoreError, Result};

#[derive(Default, Clone, Copy, PartialEq, Eq)]
enum St {
    #[default]
    Text,
    Esc,
    Csi,
    /// OSC / DCS / APC / PM / SOS: until BEL or ESC \.
    Str,
    StrEsc,
}

/// Removes ANSI escape sequences and control characters from a byte stream
/// (state is kept between chunks). Keeps newlines and tabs; `\r\n` and lone
/// `\r` both end a line, so progress bars don't glue lines together.
#[derive(Default)]
pub struct Stripper {
    st: St,
    last_cr: bool,
}

impl Stripper {
    pub fn feed(&mut self, input: &[u8], out: &mut Vec<u8>) {
        for &b in input {
            match self.st {
                St::Text => match b {
                    0x1b => self.st = St::Esc,
                    b'\r' => {
                        out.extend_from_slice(NL);
                        self.last_cr = true;
                        continue;
                    }
                    b'\n' => {
                        if !self.last_cr {
                            out.extend_from_slice(NL);
                        }
                    }
                    b'\t' => out.push(b),
                    0x00..=0x1f | 0x7f => {}
                    _ => out.push(b),
                },
                St::Esc => {
                    self.st = match b {
                        b'[' => St::Csi,
                        b']' | b'P' | b'_' | b'^' | b'X' => St::Str,
                        // Charset designations etc. take one more byte; treat as done.
                        _ => St::Text,
                    }
                }
                St::Csi => {
                    if (0x40..=0x7e).contains(&b) {
                        self.st = St::Text;
                    }
                }
                St::Str => match b {
                    0x07 => self.st = St::Text,
                    0x1b => self.st = St::StrEsc,
                    _ => {}
                },
                St::StrEsc => self.st = if b == b'\\' { St::Text } else { St::Str },
            }
            self.last_cr = false;
        }
    }
}

#[cfg(windows)]
const NL: &[u8] = b"\r\n";
#[cfg(not(windows))]
const NL: &[u8] = b"\n";

pub struct SessionLog {
    file: BufWriter<File>,
    strip: Stripper,
    buf: Vec<u8>,
    pub path: PathBuf,
    /// Prefix each line with `[HH:MM:SS]`, local time at this UTC offset (minutes).
    stamp_offset: Option<i32>,
    at_line_start: bool,
}

fn create_new(path: &Path) -> std::io::Result<File> {
    let mut o = OpenOptions::new();
    o.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o600);
    }
    o.open(path)
}

impl SessionLog {
    /// Start a log at exactly `path` (chosen in a save dialog; replaced if it exists).
    pub fn create(path: &Path, title: &str, stamp_offset: Option<i32>) -> Result<Self> {
        let _ = std::fs::remove_file(path);
        let f = create_new(path)?;
        Self::with_file(f, path.to_path_buf(), title, stamp_offset)
    }

    /// Start a log in `dir` named `<stamp>_<title>.log`, never overwriting.
    pub fn in_folder(dir: &Path, stamp: &str, title: &str, stamp_offset: Option<i32>) -> Result<Self> {
        if !dir.is_dir() {
            return Err(CoreError::invalid("The log folder no longer exists. Choose it again in Settings."));
        }
        let base = format!("{}_{}", safe_part(stamp, 32), safe_part(title, 60));
        for n in 0..1000 {
            let name = if n == 0 { format!("{base}.log") } else { format!("{base} ({n}).log") };
            let p = dir.join(name);
            match create_new(&p) {
                Ok(f) => return Self::with_file(f, p, title, stamp_offset),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(e.into()),
            }
        }
        Err(CoreError::invalid("Couldn't find a free log file name."))
    }

    fn with_file(f: File, path: PathBuf, title: &str, stamp_offset: Option<i32>) -> Result<Self> {
        let stamp_offset = stamp_offset.map(|m| m.clamp(-14 * 60, 14 * 60));
        let mut log = Self {
            file: BufWriter::new(f),
            strip: Stripper::default(),
            buf: Vec::new(),
            path,
            stamp_offset,
            at_line_start: true,
        };
        let title: String = title.chars().filter(|c| !c.is_control()).take(120).collect();
        log.file.write_all(format!("# Siakap Terminal session log: {title}").as_bytes())?;
        log.file.write_all(NL)?;
        log.file.flush()?;
        Ok(log)
    }

    pub fn write(&mut self, data: &[u8]) -> std::io::Result<()> {
        self.buf.clear();
        self.strip.feed(data, &mut self.buf);
        if self.buf.is_empty() {
            return Ok(());
        }
        match self.stamp_offset {
            None => self.file.write_all(&self.buf)?,
            Some(off) => {
                let prefix = format!("[{}] ", clock(off));
                let mut out = Vec::with_capacity(self.buf.len() + 16);
                for &b in &self.buf {
                    if self.at_line_start && b != b'\r' && b != b'\n' {
                        out.extend_from_slice(prefix.as_bytes());
                        self.at_line_start = false;
                    }
                    out.push(b);
                    if b == b'\n' {
                        self.at_line_start = true;
                    }
                }
                self.file.write_all(&out)?;
            }
        }
        self.file.flush()
    }
}

/// Local wall-clock time `HH:MM:SS` at `offset_min` minutes from UTC.
fn clock(offset_min: i32) -> String {
    let now =
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    let secs = (now + i64::from(offset_min) * 60).rem_euclid(86_400);
    format!("{:02}:{:02}:{:02}", secs / 3600, secs % 3600 / 60, secs % 60)
}

/// File-name part: letters, digits, `_`, `.`, `@` and `-`; anything else
/// (spaces, slashes, colons, brackets) becomes a single `-`.
pub fn safe_part(s: &str, max: usize) -> String {
    let mut out = String::new();
    for c in s.chars() {
        if c.is_alphanumeric() || matches!(c, '_' | '.' | '@') {
            out.push(c);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let out: String = out.trim_matches(|c| c == '-' || c == '.').chars().take(max).collect();
    if out.is_empty() {
        "session".into()
    } else {
        out
    }
}

/// Write a text snapshot (e.g. a terminal's scrollback) to a chosen file.
pub fn save_text(path: &Path, text: &str) -> Result<()> {
    let body = if cfg!(windows) { text.replace("\r\n", "\n").replace('\n', "\r\n") } else { text.to_string() };
    crate::vault::atomic_write(path, body.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strip(chunks: &[&[u8]]) -> String {
        let mut s = Stripper::default();
        let mut out = Vec::new();
        for c in chunks {
            s.feed(c, &mut out);
        }
        String::from_utf8(out).unwrap().replace("\r\n", "\n")
    }

    #[test]
    fn strips_colours_cursor_moves_and_titles() {
        assert_eq!(strip(&[b"\x1b[1;31mred\x1b[0m text\r\n"]), "red text\n");
        assert_eq!(strip(&[b"\x1b]0;window title\x07prompt$ "]), "prompt$ ");
        assert_eq!(strip(&[b"\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\"]), "link");
        assert_eq!(strip(&[b"a\x1b[2K\x1b[1Gb\tc\x08\x07"]), "ab\tc");
        // Sequences split across chunks.
        assert_eq!(strip(&[b"x\x1b[3", b"8;5;20", b"8my\r", b"\nz"]), "xy\nz");
        // Lone \r (progress bars) ends a line too.
        assert_eq!(strip(&[b"10%\r50%\r100%\r\n"]), "10%\n50%\n100%\n");
        // UTF-8 passes through.
        assert_eq!(strip(&["café ✓\n".as_bytes()]), "café ✓\n");
    }

    #[test]
    fn logs_into_a_folder_without_overwriting() {
        let dir = tempfile::tempdir().unwrap();
        let mut a = SessionLog::in_folder(dir.path(), "2026-11-24_10-00-00", "web/01:prod", None).unwrap();
        a.write(b"\x1b[32mhello\x1b[0m\r\n").unwrap();
        let b = SessionLog::in_folder(dir.path(), "2026-11-24_10-00-00", "web/01:prod", None).unwrap();
        assert_ne!(a.path, b.path);
        assert!(a.path.file_name().unwrap().to_str().unwrap().starts_with("2026-11-24_10-00-00_web-01-prod"));
        let text = std::fs::read_to_string(&a.path).unwrap();
        assert!(text.starts_with("# Siakap Terminal session log: web/01:prod"));
        assert!(text.contains("hello") && !text.contains('\x1b'));
        assert!(SessionLog::in_folder(&dir.path().join("missing"), "s", "t", None).is_err());
        assert_eq!(safe_part("../..", 10), "session");
        assert_eq!(safe_part("bash (login shell)", 40), "bash-login-shell");
        assert!(!safe_part("a/b\\c:d", 10).contains(['/', '\\', ':']));
        assert_eq!(safe_part("", 10), "session");
    }

    #[test]
    fn timestamps_each_line() {
        let dir = tempfile::tempdir().unwrap();
        let mut l = SessionLog::in_folder(dir.path(), "s", "t", Some(0)).unwrap();
        l.write(b"one\r\ntw").unwrap();
        l.write(b"o\r\n").unwrap();
        let text = std::fs::read_to_string(&l.path).unwrap().replace("\r\n", "\n");
        let lines: Vec<&str> = text.lines().skip(1).collect();
        assert_eq!(lines.len(), 2, "{text:?}");
        for (line, want) in lines.iter().zip(["one", "two"]) {
            assert!(
                line.len() == 11 + want.len() && line.starts_with('[') && &line[9..11] == "] " && line.ends_with(want),
                "{line:?}"
            );
        }
        assert_eq!(clock(0).len(), 8);
    }

    #[test]
    fn save_text_writes_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("out.txt");
        save_text(&p, "line 1\nline 2\n").unwrap();
        assert!(std::fs::read_to_string(&p).unwrap().contains("line 2"));
    }
}
