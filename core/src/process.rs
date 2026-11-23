//! Running helper programs: argument arrays only, never a shell string, and no
//! console window flashing on Windows.

use std::process::{Command, Stdio};

#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub struct Output {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
}

/// Build a `Command` with a fixed program and argument array.
pub fn command(program: &str, args: &[&str]) -> Command {
    let mut c = Command::new(program);
    c.args(args).stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c
}

/// Run and capture output (decoding UTF-16LE output, as `wsl.exe` produces).
pub fn run_capture(program: &str, args: &[&str]) -> std::io::Result<Output> {
    let out = command(program, args).output()?;
    Ok(Output { success: out.status.success(), stdout: decode(&out.stdout), stderr: decode(&out.stderr) })
}

/// Decode bytes that may be UTF-16LE (with or without BOM) or UTF-8.
pub fn decode(b: &[u8]) -> String {
    let looks_utf16 = b.starts_with(&[0xFF, 0xFE])
        || (b.len() >= 2
            && b.len().is_multiple_of(2)
            && b.iter().skip(1).step_by(2).filter(|x| **x == 0).count() * 2 >= b.len() / 2);
    if looks_utf16 {
        let body = b.strip_prefix(&[0xFF, 0xFE]).unwrap_or(b);
        let units: Vec<u16> = body.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(b).into_owned()
    }
}

/// Find an executable on PATH (adds `.exe` on Windows).
pub fn which(name: &str) -> Option<std::path::PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        // A relative PATH entry (like ".") would resolve against the current directory.
        if !dir.is_absolute() {
            continue;
        }
        let mut cands = vec![dir.join(name)];
        if cfg!(windows) && !name.to_ascii_lowercase().ends_with(".exe") {
            cands.push(dir.join(format!("{name}.exe")));
        }
        for c in cands {
            if c.is_file() {
                return Some(c);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::decode;

    #[test]
    fn decodes_utf16_and_utf8() {
        let s: Vec<u8> = "Ubuntu\r\nDebian\r\n".encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
        assert_eq!(decode(&s), "Ubuntu\r\nDebian\r\n");
        assert_eq!(decode(b"hello"), "hello");
        assert_eq!(decode(&[0xFF, 0xFE, b'a', 0]), "a");
    }
}
