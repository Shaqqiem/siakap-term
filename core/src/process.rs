//! Running helper programs: argument arrays only, never a shell string, and no
//! console window flashing on Windows.

use std::process::{Command, Stdio};

#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug)]
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

/// Run with a time limit. Output is drained on background threads so a chatty
/// program can't block; on timeout our own child is stopped and `TimedOut`
/// is returned (the caller must then re-check the real state).
pub fn run_capture_timeout(program: &str, args: &[&str], timeout: std::time::Duration) -> std::io::Result<Output> {
    use std::io::Read;
    let mut child = command(program, args).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()?;
    let mut out = child.stdout.take();
    let mut err = child.stderr.take();
    let t_out = std::thread::spawn(move || {
        let mut b = Vec::new();
        if let Some(o) = out.as_mut() {
            let _ = o.read_to_end(&mut b);
        }
        b
    });
    let t_err = std::thread::spawn(move || {
        let mut b = Vec::new();
        if let Some(e) = err.as_mut() {
            let _ = e.read_to_end(&mut b);
        }
        b
    });
    let start = std::time::Instant::now();
    let status = loop {
        if let Some(st) = child.try_wait()? {
            break st;
        }
        if start.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                format!("{program} did not finish within {} s", timeout.as_secs()),
            ));
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    };
    let stdout = t_out.join().unwrap_or_default();
    let stderr = t_err.join().unwrap_or_default();
    Ok(Output { success: status.success(), stdout: decode(&stdout), stderr: decode(&stderr) })
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

    #[cfg(unix)]
    #[test]
    fn timeouts_stop_the_program() {
        use std::time::Duration;
        let ok = super::run_capture_timeout("/bin/sh", &["-c", "echo hi"], Duration::from_secs(5)).unwrap();
        assert!(ok.success && ok.stdout.contains("hi"));
        let t = std::time::Instant::now();
        let e = super::run_capture_timeout("/bin/sh", &["-c", "sleep 30"], Duration::from_millis(300)).unwrap_err();
        assert_eq!(e.kind(), std::io::ErrorKind::TimedOut);
        assert!(t.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn decodes_utf16_and_utf8() {
        let s: Vec<u8> = "Ubuntu\r\nDebian\r\n".encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
        assert_eq!(decode(&s), "Ubuntu\r\nDebian\r\n");
        assert_eq!(decode(b"hello"), "hello");
        assert_eq!(decode(&[0xFF, 0xFE, b'a', 0]), "a");
    }
}
