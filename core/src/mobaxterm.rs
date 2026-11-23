//! Import MobaXterm sessions: a `.mxtsessions` export ("Export all sessions
//! to file") or the `[Bookmarks*]` sections of `MobaXterm.ini`.
//!
//! The format is undocumented. This follows the community reverse-engineering
//! notes (gist "mxtsessions_format" by Ruzgfpegk, Sessionator, mobaConverterGo):
//!
//! * INI, Windows-1252, CRLF. Each `[Bookmarks]`/`[Bookmarks_N]` section has
//!   `SubRep=<folder\sub>` and `ImgNum=..`; every other line is
//!   `Name=<reconnect>#<icon>#<group1>#<group2>#<start mode>#<comment>#<colour>`.
//! * group1 is `%`-separated and starts with the session type:
//!   SSH = 0 (host, port, user at 1..3, login command at 7, private key at 14),
//!   SFTP = 7 (host, port, user at 1..3, private key at 9).
//! * Escapes: `__PTVIRG__` ; `__DBLQUO__` " `__PIPE__` | `__DIEZE__` # `__PERCENT__` %,
//!   and `_CurrentDrive_` for the C: drive.
//!
//! Checked against real MobaXterm exports:
//! * Serial (type 8): `8%<n>%<speed>%<data bits idx>%<parity>%<stop>%<flow>%<?>%<port text>`,
//!   speed written with a leading `1` (`1115200` = 115200), data bits 0..3 = 5..8.
//! * WSL (type 14): field 1 is the distribution (`Default` = the default one).
//! * Terminal group index 22 is the login macro: `<none>`, `<custom macro>` (steps
//!   in index 23) or the name of a saved macro.
//! * Macros (`.mxtmacros` or the `[Macros*]` sections of MobaXterm.ini) are
//!   `Name=step|step|...` with steps `12:x:x:text` (type), `258:13:x:RETURN`
//!   (Enter), `258:9:x:TAB`, `256:38:x:UP` (key down; 257 is key up) and
//!   `0:0:0:SLEEPEQUAL<ms>` (wait). Macro folders use `SubRep` like sessions.
//!
//! Other protocols (RDP, VNC, Telnet, FTP, ...) are skipped.

use std::collections::BTreeMap;

use serde::Serialize;

use crate::error::{CoreError, Result};
use crate::model::{
    new_id, normalize_folder, validate_host, validate_name, validate_user, AuthMethod, Session, SessionKind, VaultData,
};
use crate::serial::{SerialConfig, COMMON_BAUD_RATES};

pub const MAX_BYTES: usize = 20 * 1024 * 1024;

#[derive(Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MobaReport {
    pub sessions: usize,
    pub macros: usize,
    pub duplicate_macros: usize,
    /// Ids of imported sessions whose MobaXterm login macro became (switched-off) startup commands.
    pub startup_session_ids: Vec<String>,
    /// Serial/shell/WSL sessions imported from the undocumented parts of the format.
    pub needs_review: Vec<String>,
    /// Protocol name -> number of sessions skipped (RDP, VNC, ...).
    pub skipped: BTreeMap<String, usize>,
    pub duplicates: usize,
    pub invalid: usize,
    /// Sessions whose MobaXterm "execute command" became switched-off startup commands.
    pub startup_disabled: usize,
}

fn section_kind(header: &str) -> Option<&'static str> {
    let n = header.trim().strip_prefix('[')?.strip_suffix(']')?.to_ascii_lowercase();
    if n == "bookmarks" || n.starts_with("bookmarks_") {
        Some("bookmarks")
    } else if n == "macros" || (n.starts_with("macros_") && n[7..].chars().all(|c| c.is_ascii_digit())) {
        Some("macros")
    } else {
        None
    }
}

/// True if the text looks like a MobaXterm sessions/macros export or MobaXterm.ini.
pub fn looks_like_mobaxterm(text: &str) -> bool {
    text.lines().take(2000).any(|l| section_kind(l).is_some())
}

/// Convert a MobaXterm recorded macro into a Siakap script. Returns the
/// script and the step kinds that had no equivalent (skipped).
pub fn convert_macro(steps: &str) -> (String, Vec<String>) {
    let mut out: Vec<String> = Vec::new();
    let mut pending = String::new();
    let mut unknown: Vec<String> = Vec::new();
    // Text typed so far without Enter goes out as "@type".
    fn flush(out: &mut Vec<String>, pending: &mut String) {
        if !pending.is_empty() {
            out.push(format!("@type {pending}"));
            pending.clear();
        }
    }
    for step in steps.split('|').filter(|x| !x.is_empty()) {
        let mut it = step.splitn(4, ':');
        let (code, _a, _b, rest) = (it.next().unwrap_or(""), it.next(), it.next(), it.next().unwrap_or(""));
        match code {
            "12" => pending.push_str(&rest.chars().filter(|c| !c.is_control()).collect::<String>()),
            "0" if rest.starts_with("SLEEPEQUAL") => {
                flush(&mut out, &mut pending);
                let ms: u64 = rest["SLEEPEQUAL".len()..].trim().parse().unwrap_or(1000);
                out.push(format!("@wait {}", ms.min(crate::macros::MAX_WAIT_MS)));
            }
            // 258 = character key, 256 = key down (257 = key up, ignored).
            "258" | "256" => {
                let key = rest.trim().to_ascii_lowercase();
                if key == "return" || key == "enter" {
                    // A whole line: send it as a normal line unless it could be
                    // mistaken for a directive or a note.
                    let t = pending.trim_start();
                    if pending.is_empty() || t.starts_with('#') || t.starts_with('@') {
                        flush(&mut out, &mut pending);
                        out.push("@key enter".into());
                    } else {
                        out.push(std::mem::take(&mut pending));
                    }
                } else if crate::macros::key_sequence(&key).is_some() {
                    flush(&mut out, &mut pending);
                    out.push(format!("@key {key}"));
                } else {
                    flush(&mut out, &mut pending);
                    unknown.push(format!("key {key}"));
                }
            }
            "257" => {}
            other => unknown.push(format!("step {other}")),
        }
    }
    flush(&mut out, &mut pending);
    (out.join("\n"), unknown)
}

/// Decode a MobaXterm file: UTF-8 if valid (with or without BOM), else Windows-1252.
pub fn decode(bytes: &[u8]) -> String {
    let b = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    match std::str::from_utf8(b) {
        Ok(s) => s.to_string(),
        Err(_) => b.iter().map(|&c| cp1252(c)).collect(),
    }
}

fn cp1252(c: u8) -> char {
    const HIGH: [char; 32] = [
        '€', '\u{81}', '‚', 'ƒ', '„', '…', '†', '‡', 'ˆ', '‰', 'Š', '‹', 'Œ', '\u{8d}', 'Ž', '\u{8f}', '\u{90}', '‘',
        '’', '“', '”', '•', '–', '—', '˜', '™', 'š', '›', 'œ', '\u{9d}', 'ž', 'Ÿ',
    ];
    match c {
        0x80..=0x9F => HIGH[(c - 0x80) as usize],
        _ => c as char,
    }
}

fn unescape(s: &str) -> String {
    s.replace("__PTVIRG__", ";")
        .replace("__DBLQUO__", "\"")
        .replace("__PIPE__", "|")
        .replace("__DIEZE__", "#")
        .replace("__PERCENT__", "%")
        .replace("_CurrentDrive_", "C")
}

fn type_name(code: &str) -> String {
    match code {
        "0" => "SSH",
        "1" => "Telnet",
        "4" => "RDP",
        "5" => "VNC",
        "6" => "FTP",
        "7" => "SFTP",
        "8" => "Serial",
        "10" => "Shell",
        "11" => "Browser",
        "12" => "Mosh",
        "14" => "WSL",
        other => return format!("type {other}"),
    }
    .to_string()
}

/// Merge the sessions and macros from a MobaXterm file into `d`.
/// Macros are imported first so sessions can refer to them by name.
pub fn import(text: &str, d: &mut VaultData, shells: &[String]) -> Result<MobaReport> {
    if text.len() > MAX_BYTES {
        return Err(CoreError::invalid("Choose a file smaller than 20 MB."));
    }
    if !looks_like_mobaxterm(text) {
        return Err(CoreError::format(
            "This doesn't look like a MobaXterm export (.mxtsessions, .mxtmacros or MobaXterm.ini).",
        ));
    }
    let mut rep = MobaReport::default();
    let mut seen: std::collections::HashSet<String> =
        d.macros.iter().map(|m| crate::macros::signature(&m.folder, &m.script)).collect();
    for pass in ["macros", "bookmarks"] {
        let mut kind: Option<&str> = None;
        let mut folder = String::new();
        for raw in text.lines() {
            let line = raw.trim_end_matches('\r');
            let t = line.trim();
            if t.starts_with('[') && t.ends_with(']') {
                kind = section_kind(t);
                folder.clear();
                continue;
            }
            if kind != Some(pass) || t.is_empty() || t.starts_with(';') {
                continue;
            }
            let Some((key, value)) = line.split_once('=') else { continue };
            if key.eq_ignore_ascii_case("SubRep") {
                folder = normalize_folder(&value.replace('\\', "/")).unwrap_or_default();
                let list = if pass == "macros" { &mut d.macro_folders } else { &mut d.folders };
                if !folder.is_empty() && !list.contains(&folder) {
                    list.push(folder.clone());
                }
                continue;
            }
            if key.eq_ignore_ascii_case("ImgNum") {
                continue;
            }
            if d.sessions.len() + d.macros.len() >= 20_000 {
                return Err(CoreError::invalid("Too many entries."));
            }
            if pass == "macros" {
                import_macro(key.trim(), value, &folder, d, &mut seen, &mut rep);
                continue;
            }
            if let Some(s) = session_from_line(key.trim(), value, &folder, shells, d, &mut rep) {
                let dup = d.sessions.iter().any(|x| {
                    x.kind == s.kind
                        && x.name == s.name
                        && x.host == s.host
                        && x.port == s.port
                        && x.user == s.user
                        && x.serial.port == s.serial.port
                });
                if dup {
                    rep.duplicates += 1;
                } else {
                    if !s.startup_script.is_empty() {
                        rep.startup_session_ids.push(s.id.clone());
                    }
                    d.sessions.push(s);
                    rep.sessions += 1;
                }
            }
        }
    }
    rep.startup_disabled = rep.startup_session_ids.len();
    Ok(rep)
}

fn import_macro(
    name: &str,
    steps: &str,
    folder: &str,
    d: &mut VaultData,
    seen: &mut std::collections::HashSet<String>,
    rep: &mut MobaReport,
) {
    let Ok(name) = validate_name(&unescape(name)) else {
        rep.invalid += 1;
        return;
    };
    let (script, unknown) = convert_macro(steps);
    if script.trim().is_empty() || crate::macros::check(&script).is_err() {
        rep.invalid += 1;
        return;
    }
    if !unknown.is_empty() {
        rep.needs_review.push(format!("macro {name} (skipped MobaXterm steps: {})", unknown.join(", ")));
    }
    if !seen.insert(crate::macros::signature(folder, &script)) {
        rep.duplicate_macros += 1;
        return;
    }
    d.macros.push(crate::model::Macro {
        id: new_id(),
        name,
        folder: folder.to_string(),
        script,
        // Imported macros are reviewed before their first run.
        edit_before_run: true,
        parameter_defaults: Default::default(),
    });
    rep.macros += 1;
}

fn session_from_line(
    name: &str,
    value: &str,
    folder: &str,
    shells: &[String],
    d: &VaultData,
    rep: &mut MobaReport,
) -> Option<Session> {
    let sections: Vec<&str> = value.split('#').collect();
    let group1 = *sections.get(2)?;
    let f: Vec<String> = group1.split('%').map(unescape).collect();
    let code = f.first()?.trim().to_string();
    let Ok(name) = validate_name(&unescape(name)) else {
        rep.invalid += 1;
        return None;
    };
    let get = |i: usize| f.get(i).map(|s| s.trim().to_string()).unwrap_or_default();
    let mut s = Session { id: new_id(), name: name.clone(), folder: folder.to_string(), ..Default::default() };
    let session = match code.as_str() {
        "0" | "7" => {
            s.kind = SessionKind::Ssh;
            let Ok(host) = validate_host(&get(1)) else {
                rep.invalid += 1;
                return None;
            };
            s.host = host;
            s.port = get(2).parse::<u16>().ok().filter(|p| *p > 0).unwrap_or(22);
            // "[user]" in MobaXterm means a pre-filled user name.
            s.user = validate_user(get(3).trim_start_matches('[').trim_end_matches(']')).unwrap_or_default();
            let key = if code == "0" { get(14) } else { get(9) };
            if !key.is_empty() && !key.contains("_ProfileDir_") && !key.chars().any(char::is_control) {
                s.key_path = key;
                s.auth = AuthMethod::Auto;
            }
            if code == "0" {
                let cmd = get(7);
                if !cmd.is_empty() && !cmd.chars().any(|c| c.is_control()) {
                    // MobaXterm's "execute command" becomes a startup command, off until reviewed.
                    s.startup_script = cmd;
                    s.startup_enabled = false;
                }
            }
            Some(s)
        }
        "8" => {
            let port = f.iter().rev().find_map(|x| com_port(x))?;
            s.kind = SessionKind::Serial;
            let (baud, sure) = serial_speed(&get(2));
            let data_bits = match get(3).parse::<u8>() {
                Ok(i @ 0..=3) => 5 + i,
                _ => 8,
            };
            let parity = match get(4).as_str() {
                "1" => crate::serial::ParityOpt::Odd,
                "2" => crate::serial::ParityOpt::Even,
                _ => crate::serial::ParityOpt::None,
            };
            let stop_bits = if get(5) == "2" { 2 } else { 1 };
            s.serial = SerialConfig { port, baud, data_bits, parity, stop_bits, ..Default::default() };
            if !sure {
                rep.needs_review.push(format!("{name} (serial: check the speed)"));
            }
            Some(s)
        }
        "14" => {
            s.kind = SessionKind::Local;
            let distro = get(1);
            s.shell = if distro.is_empty() || distro.eq_ignore_ascii_case("default") {
                shells.iter().find(|id| id.starts_with("wsl:")).cloned().unwrap_or_default()
            } else {
                shells.iter().find(|id| id.eq_ignore_ascii_case(&format!("wsl:{distro}"))).cloned().unwrap_or_default()
            };
            if s.shell.is_empty() {
                rep.needs_review
                    .push(format!("{name} (WSL {distro}: no such distribution found on this PC; pick the terminal)"));
            }
            Some(s)
        }
        "10" => {
            s.kind = SessionKind::Local;
            let joined = f.iter().skip(1).cloned().collect::<Vec<_>>().join(" ").to_lowercase();
            s.shell = pick_shell(&joined, false, shells);
            rep.needs_review.push(format!("{name} (local shell: check which terminal it opens)"));
            Some(s)
        }
        other => {
            *rep.skipped.entry(type_name(other)).or_insert(0) += 1;
            None
        }
    };
    let mut s = session?;
    // Login macro (terminal settings, index 22/23): becomes startup commands.
    let g2: Vec<&str> = sections.get(3).map(|x| x.split('%').collect()).unwrap_or_default();
    let which = g2.get(22).map(|x| x.trim()).unwrap_or("");
    let login = if which.eq_ignore_ascii_case("<custom macro>") {
        let (script, unknown) = convert_macro(g2.get(23).copied().unwrap_or(""));
        if !unknown.is_empty() {
            rep.needs_review.push(format!("{} (login macro: skipped {})", s.name, unknown.join(", ")));
        }
        script
    } else if !which.is_empty() && !which.eq_ignore_ascii_case("<none>") {
        match d.macros.iter().find(|m| m.name.eq_ignore_ascii_case(&unescape(which))) {
            Some(m) => m.script.clone(),
            None => {
                rep.needs_review.push(format!(
                    "{} (uses MobaXterm macro \"{which}\": import your .mxtmacros file together with this one)",
                    s.name
                ));
                String::new()
            }
        }
    } else {
        String::new()
    };
    if !login.trim().is_empty() && crate::macros::check(&login).is_ok() && s.kind != SessionKind::Serial {
        s.startup_script = if s.startup_script.is_empty() { login } else { format!("{}\n{login}", s.startup_script) };
        s.startup_enabled = false;
    }
    Some(s)
}

/// MobaXterm writes the speed with a leading "1" (1115200 = 115200).
/// Returns the speed and whether it was recognised for sure.
fn serial_speed(v: &str) -> (u32, bool) {
    let v = v.trim();
    if let Ok(n) = v.parse::<u32>() {
        if COMMON_BAUD_RATES.contains(&n) {
            return (n, true);
        }
    }
    if let Some(rest) = v.strip_prefix('1') {
        if let Ok(n) = rest.parse::<u32>() {
            if COMMON_BAUD_RATES.contains(&n) {
                return (n, true);
            }
        }
    }
    (9600, false)
}

/// "COM3  (USB Serial Port (COM3))" -> "COM3".
fn com_port(s: &str) -> Option<String> {
    let up = s.to_ascii_uppercase();
    let i = up.find("COM")?;
    let digits: String = up[i + 3..].chars().take_while(|c| c.is_ascii_digit()).collect();
    let n: u32 = digits.parse().ok()?;
    (1..=256).contains(&n).then(|| format!("COM{n}"))
}

/// Match a shell id from `pty::detect_shells` ids ("pwsh", "powershell", "cmd", "wsl:Ubuntu", ...).
fn pick_shell(text: &str, wsl: bool, shells: &[String]) -> String {
    if wsl || text.contains("wsl") {
        if let Some(id) = shells.iter().find(|id| id.starts_with("wsl:") && text.contains(&id[4..].to_lowercase())) {
            return id.clone();
        }
        if let Some(id) = shells.iter().find(|id| id.starts_with("wsl:")) {
            return id.clone();
        }
    }
    for (needle, id) in [("pwsh", "pwsh"), ("powershell", "powershell"), ("ps1", "powershell"), ("cmd", "cmd")] {
        if text.contains(needle) && shells.iter().any(|s| s == id) {
            return id.to_string();
        }
    }
    String::new() // default shell
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "[Bookmarks]\r\nSubRep=\r\nImgNum=42\r\ncore-sw01= #109#0%10.0.0.2%22%admin%%-1%-1%terminal length 0__PTVIRG__show clock%%22%%0%0%0%_CurrentDrive_:\\Keys\\id_ed25519%%-1%0%0%0%%1080%%0%0%1#MobaFont%10%0%0%-1%15%236,236,236%30,30,30%180,180,192%0%-1%0%%xterm%-1%0%_Std_Colors_0_%80%24%0%1%-1%<none>%%0%0%-1#0# #-1\r\n\r\n[Bookmarks_1]\r\nSubRep=Production\\Web\r\nImgNum=41\r\nweb-01= #109#0%web01.example.com%2222%deploy%%-1%-1%%%%%0%0%0%%%-1%0%0%0%%1080%%0%0%1#MobaFont%10#0# #-1\r\nfiles=#140#7%sftp.example.com%22%ftpuser%%%%%%_CurrentDrive_:\\k\\sftp.ppk%%#MobaFont#0# #-1\r\ndesktop=#91#4%10.0.0.9%3389%admin%0%0#MobaFont#0# #-1\r\nconsole=#131#8%COM3  (USB Serial Port (COM3))%115200%3%0%0%1%2#MobaFont#0# #-1\r\nubuntu=#151#14%Ubuntu-22.04%%0#MobaFont#0# #-1\r\n\r\n[Misc]\r\nfoo=bar\r\n";

    #[test]
    fn imports_ssh_sftp_and_flags_the_rest() {
        let mut d = VaultData::default();
        let shells = vec!["pwsh".to_string(), "wsl:Ubuntu-22.04".to_string()];
        let r = import(SAMPLE, &mut d, &shells).unwrap();
        assert_eq!(r.sessions, 5, "{r:?}");
        assert_eq!(r.skipped.get("RDP"), Some(&1));
        assert_eq!(r.startup_disabled, 1);
        assert!(r.needs_review.is_empty(), "{:?}", r.needs_review);

        let sw = &d.sessions[0];
        assert_eq!((sw.host.as_str(), sw.port, sw.user.as_str(), sw.folder.as_str()), ("10.0.0.2", 22, "admin", ""));
        assert_eq!(sw.key_path, "C:\\Keys\\id_ed25519");
        assert_eq!(sw.startup_script, "terminal length 0;show clock");
        assert!(!sw.startup_enabled);

        let web = &d.sessions[1];
        assert_eq!((web.host.as_str(), web.port, web.folder.as_str()), ("web01.example.com", 2222, "Production/Web"));
        let sftp = &d.sessions[2];
        assert_eq!((sftp.kind, sftp.user.as_str()), (SessionKind::Ssh, "ftpuser"));
        assert_eq!(sftp.key_path, "C:\\k\\sftp.ppk");

        let ser = &d.sessions[3];
        assert_eq!((ser.kind, ser.serial.port.as_str(), ser.serial.baud), (SessionKind::Serial, "COM3", 115200));
        assert_eq!(d.sessions[4].shell, "wsl:Ubuntu-22.04");
        assert!(d.folders.contains(&"Production/Web".to_string()));

        // Importing twice adds nothing.
        let again = import(SAMPLE, &mut d, &shells).unwrap();
        assert_eq!((again.sessions, again.duplicates), (0, 5));
    }

    // Same structure as a real export (names and values changed).
    const REAL_SESSIONS: &str = "[Bookmarks]\r\nSubRep=\r\nImgNum=42\r\nCOM5  (USB Serial Port (COM5))=#131#8%0%1115200%3%0%0%1%2%COM5  (USB Serial Port (COM5))#MobaFont%10%0%0%-1%15%236,236,236%30,30,30%180,180,192%0%-1%0%%xterm%-1%0%_Std_Colors_0_%80%24%0%1%-1%<none>%%0%0%-1%0%#0# #-1\r\n\r\n[Bookmarks_2]\r\nSubRep=VM\r\nImgNum=41\r\nTool=#109#0%127.0.0.1%2322%[alice]%%-1%0%tool-cli%%%%0%-1%0%%%-1%-1%0%0%%1080%%0%0%1%%0%%%%0%-1%-1%0%%%0%#MobaFont%10%0%0%-1%15%236,236,236%30,30,30%180,180,192%0%-1%0%%xterm%-1%0%_Std_Colors_0_%80%24%0%1%-1%Start%%0%0%-1%0%#0# \r\n\r\n[Bookmarks_3]\r\nSubRep=WSL\r\nImgNum=57\r\nwsl-proxy=#151#14%Default%%Interactive shell%%%0#MobaFont%10%0%0%-1%15%236,236,236%30,30,30%180,180,192%0%-1%0%%xterm%-1%0%_Std_Colors_0_%80%24%0%1%-1%<custom macro>%12:2:0:login|258:13:1835009:RETURN|0:0:0:SLEEPEQUAL1000|12:2:0:proxy|258:13:1835009:RETURN|%0%0%-1%0%#0# #-1\r\n";
    const REAL_MACROS: &str = "[Macros]\r\nStart=0:0:0:SLEEPEQUAL3000|12:0:0:pin|258:13:1835009:RETURN|\r\nRecall=256:38:21495809:UP|257:38:-1052246015:UP|258:13:1835009:RETURN|0:0:0:SLEEPEQUAL1200|12:0:0:hop|258:9:983041:TAB|258:13:1835009:RETURN|12:4:0:cd 'My Dir'|258:13:1835009:RETURN|\r\n\r\n[Macros_1]\r\nSubRep=ncpc\r\nImgNum=41\r\n";

    #[test]
    fn converts_recorded_macros() {
        let (s, unknown) = convert_macro("256:38:1:UP|257:38:1:UP|258:13:1:RETURN|0:0:0:SLEEPEQUAL1200|12:0:0:hop|258:9:1:TAB|258:13:1:RETURN|12:4:0:# not a note|258:13:1:RETURN|12:2:0:host |");
        assert!(unknown.is_empty());
        assert_eq!(s, "@key up\n@key enter\n@wait 1200\n@type hop\n@key tab\n@key enter\n@type # not a note\n@key enter\n@type host ");
        let steps = crate::macros::parse(&s).unwrap();
        assert_eq!(steps.len(), 9);
    }

    #[test]
    fn imports_real_macro_and_session_files() {
        let mut d = VaultData::default();
        let shells = vec!["pwsh".to_string(), "wsl:Ubuntu".to_string()];
        let m = import(REAL_MACROS, &mut d, &shells).unwrap();
        assert_eq!(m.macros, 2);
        assert!(d.macro_folders.contains(&"ncpc".to_string()));
        assert_eq!(d.macros[1].script, "@key up\n@key enter\n@wait 1200\n@type hop\n@key tab\n@key enter\ncd 'My Dir'");
        assert!(d.macros.iter().all(|m| m.edit_before_run));

        let r = import(REAL_SESSIONS, &mut d, &shells).unwrap();
        assert_eq!(r.sessions, 3, "{r:?}");
        assert!(r.needs_review.is_empty(), "{:?}", r.needs_review);
        assert_eq!(r.startup_session_ids.len(), 2);
        let com = &d.sessions[0];
        assert_eq!((com.serial.port.as_str(), com.serial.baud, com.serial.data_bits), ("COM5", 115200, 8));
        let tool = &d.sessions[1];
        assert_eq!((tool.user.as_str(), tool.port, tool.folder.as_str()), ("alice", 2322, "VM"));
        // Its own execute command, then the named macro "Start".
        assert_eq!(tool.startup_script, "tool-cli\n@wait 3000\npin");
        assert!(!tool.startup_enabled);
        let wsl = &d.sessions[2];
        assert_eq!((wsl.shell.as_str(), wsl.folder.as_str()), ("wsl:Ubuntu", "WSL"));
        assert_eq!(wsl.startup_script, "login\n@wait 1000\nproxy");
        // A named macro that wasn't imported is reported.
        let mut fresh = VaultData::default();
        let r2 = import(REAL_SESSIONS, &mut fresh, &shells).unwrap();
        assert!(r2.needs_review.iter().any(|x| x.contains("Start")));
    }

    #[test]
    fn cp1252_and_detection() {
        assert_eq!(decode(&[b'a', 0x80, b'b']), "a€b");
        assert_eq!(decode("ü".as_bytes()), "ü");
        assert!(looks_like_mobaxterm("[Bookmarks]\nSubRep=\n"));
        assert!(!looks_like_mobaxterm("{\"format\":\"x\"}"));
        let mut d = VaultData::default();
        assert!(import("not moba", &mut d, &[]).is_err());
    }

    #[test]
    fn rejects_bad_hosts() {
        let mut d = VaultData::default();
        let r = import("[Bookmarks]\nevil=#109#0%-oProxyCommand=calc%22%u#x#0# #-1\n", &mut d, &[]).unwrap();
        assert_eq!((r.sessions, r.invalid), (0, 1));
    }
}
