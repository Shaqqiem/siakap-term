//! Backups in the Siakap plugin's format, so macros and sessions move freely
//! between the Siakap Tabby plugin and Siakap Terminal:
//!
//! ```json
//! { "format": "tabby-personal-sidebar", "version": 1,
//!   "macros":  [{ "id", "name", "script", "folder", "editBeforeRun", "parameterDefaults" }],
//!   "folders": ["ncp/nv"],
//!   "sessions": [ <Tabby profiles: ssh / local / serial> ],
//!   "groups":   [{ "id", "name" }],
//!   "startupMacros": { "<session id>": { "postConnectScript", "workingDirectory", "enabled" } } }
//! ```
//!
//! Passwords are never exported. Imported startup commands are disabled until
//! the user turns them on (same as the plugin). The older `siakap-macros`
//! export of Siakap Terminal 0.1 is still accepted.

use std::collections::{BTreeMap, HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::{CoreError, Result};
use crate::macros::{check, signature};
use crate::model::{
    new_id, normalize_folder, validate_name, AuthMethod, Forward, ForwardKind, Macro, Session, SessionKind, VaultData,
    MAX_FORWARDS,
};
use crate::serial::{FlowOpt, ParityOpt, SerialConfig};

pub const FORMAT: &str = "tabby-personal-sidebar";
pub const MAX_BACKUP_BYTES: usize = 20 * 1024 * 1024;
const MAX_ENTRIES: usize = 20_000;
const MAX_SCRIPT: usize = 256 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    Macros,
    All,
}

/// Build a backup. With `Scope::Macros` only macros and folders are included.
pub fn export(d: &VaultData, scope: Scope) -> Value {
    let macros: Vec<Value> = d
        .macros
        .iter()
        .map(|m| {
            json!({ "id": m.id, "name": m.name, "script": m.script, "folder": m.folder,
                    "editBeforeRun": m.edit_before_run, "parameterDefaults": m.parameter_defaults })
        })
        .collect();
    let mut folders: Vec<String> = d.macro_folders.clone();
    for m in &d.macros {
        if !m.folder.is_empty() && !folders.contains(&m.folder) {
            folders.push(m.folder.clone());
        }
    }
    if scope == Scope::Macros {
        return json!({ "format": FORMAT, "version": 1, "scope": "macros", "macros": macros, "folders": folders });
    }
    let mut groups: Vec<Value> = Vec::new();
    let mut group_ids: HashMap<String, String> = HashMap::new();
    for s in &d.sessions {
        if !s.folder.is_empty() && !group_ids.contains_key(&s.folder) {
            let id = format!("siakap-group-{}", group_ids.len() + 1);
            groups.push(json!({ "id": id, "name": s.folder }));
            group_ids.insert(s.folder.clone(), id);
        }
    }
    let mut startup = serde_json::Map::new();
    let sessions: Vec<Value> = d
        .sessions
        .iter()
        .map(|s| {
            let id = format!("siakap:{}", s.id);
            if !s.startup_script.trim().is_empty() || !s.startup_dir.trim().is_empty() {
                startup.insert(
                    id.clone(),
                    json!({ "postConnectScript": s.startup_script, "workingDirectory": s.startup_dir, "enabled": s.startup_enabled }),
                );
            }
            let mut p = json!({ "id": id, "name": s.name, "type": kind_name(s.kind), "options": tabby_options(s) });
            if let Some(g) = group_ids.get(&s.folder) {
                p["group"] = json!(g);
            }
            p
        })
        .collect();
    json!({ "format": FORMAT, "version": 1, "macros": macros, "folders": folders,
            "sessions": sessions, "groups": groups, "startupMacros": startup })
}

fn kind_name(k: SessionKind) -> &'static str {
    match k {
        SessionKind::Ssh => "ssh",
        SessionKind::Local => "local",
        SessionKind::Serial => "serial",
    }
}

fn tabby_options(s: &Session) -> Value {
    match s.kind {
        SessionKind::Ssh => {
            let auth = match s.auth {
                AuthMethod::Auto => Value::Null,
                AuthMethod::Agent => json!("agent"),
                AuthMethod::Key => json!("publicKey"),
                AuthMethod::Password => json!("password"),
            };
            let keys: Vec<String> = if s.key_path.is_empty() { vec![] } else { vec![s.key_path.clone()] };
            let mut o = json!({ "host": s.host, "port": s.port, "user": s.user, "auth": auth, "privateKeys": keys });
            if !s.forwards.is_empty() {
                o["forwardedPorts"] = s
                    .forwards
                    .iter()
                    .map(|f| {
                        json!({ "type": match f.kind { ForwardKind::Local => "Local", ForwardKind::Remote => "Remote", ForwardKind::Dynamic => "Dynamic" },
                                "host": f.bind_host, "port": f.bind_port, "targetAddress": f.dest_host, "targetPort": f.dest_port,
                                "description": "", "enabled": f.enabled })
                    })
                    .collect();
            }
            if let Some(j) = &s.jump_session {
                o["jumpHost"] = json!(format!("siakap:{j}"));
            }
            o
        }
        SessionKind::Local => {
            let (command, args): (&str, Vec<String>) = match s.shell.as_str() {
                "pwsh" => ("pwsh.exe", vec![]),
                "powershell" => ("powershell.exe", vec![]),
                "cmd" => ("cmd.exe", vec![]),
                id if id.starts_with("wsl:") => ("wsl.exe", vec!["-d".into(), id[4..].to_string()]),
                other => (other, vec![]),
            };
            json!({ "command": command, "args": args })
        }
        SessionKind::Serial => {
            let c = &s.serial;
            json!({ "port": c.port, "baudrate": c.baud, "databits": c.data_bits, "stopbits": c.stop_bits,
                    "parity": match c.parity { ParityOpt::None => "none", ParityOpt::Odd => "odd", ParityOpt::Even => "even" },
                    "rtscts": c.flow == FlowOpt::Hardware, "xon": c.flow == FlowOpt::Software, "xoff": c.flow == FlowOpt::Software })
        }
    }
}

#[derive(Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub macros: usize,
    pub duplicates: usize,
    pub sessions: usize,
    pub skipped_sessions: usize,
    pub invalid: usize,
    /// Sessions whose startup commands were imported but switched off.
    pub startup_disabled: usize,
    /// Imported from undocumented parts of a foreign format: please check.
    pub needs_review: Vec<String>,
    /// Session types that were skipped (e.g. RDP from MobaXterm), with counts.
    pub skipped_types: std::collections::BTreeMap<String, usize>,
    /// "siakap" or "mobaxterm".
    pub source: String,
    /// Sessions that received (switched-off) startup commands.
    pub startup_session_ids: Vec<String>,
}

#[derive(Deserialize)]
struct RawMacro {
    name: String,
    script: String,
    #[serde(default)]
    folder: Option<String>,
    #[serde(default, rename = "parameterDefaults")]
    parameter_defaults: Option<BTreeMap<String, String>>,
}

/// Merge a backup into `d`. Macros that duplicate an existing one (same
/// signature) are skipped; nothing is overwritten.
pub fn import(json_text: &str, d: &mut VaultData) -> Result<ImportReport> {
    if json_text.len() > MAX_BACKUP_BYTES {
        return Err(CoreError::invalid("Choose a backup smaller than 20 MB."));
    }
    let v: Value = serde_json::from_str(json_text)
        .map_err(|_| CoreError::format("Choose a sessions/macros JSON backup exported by Siakap."))?;
    let bad = || CoreError::format("Choose a sessions/macros JSON backup exported by Siakap.");

    let (raw_macros, folders, sessions, groups, startup): (Vec<Value>, Vec<Value>, Vec<Value>, Vec<Value>, Value) =
        match v.get("format").and_then(Value::as_str) {
            Some(FORMAT) => {
                if v.get("version").and_then(Value::as_u64) != Some(1) {
                    return Err(CoreError::format("This backup was made by a newer Siakap version."));
                }
                let arr = |k: &str| -> Result<Vec<Value>> {
                    match v.get(k) {
                        None | Some(Value::Null) => Ok(vec![]),
                        Some(Value::Array(a)) => Ok(a.clone()),
                        _ => Err(bad()),
                    }
                };
                (
                    arr("macros")?,
                    arr("folders")?,
                    arr("sessions")?,
                    arr("groups")?,
                    v.get("startupMacros").cloned().unwrap_or(Value::Null),
                )
            }
            Some("siakap-macros") => (
                v.get("macros").and_then(Value::as_array).cloned().ok_or_else(bad)?,
                vec![],
                vec![],
                vec![],
                Value::Null,
            ),
            _ => match &v {
                // A bare array of macros.
                Value::Array(a) => (a.clone(), vec![], vec![], vec![], Value::Null),
                _ => return Err(bad()),
            },
        };
    if raw_macros.len() + folders.len() + sessions.len() + groups.len() > MAX_ENTRIES {
        return Err(CoreError::invalid("This backup has too many entries."));
    }
    if !(startup.is_null() || startup.is_object()) {
        return Err(CoreError::format("Invalid startup macros in backup."));
    }

    let mut rep = ImportReport { source: "siakap".into(), ..Default::default() };

    // Folders.
    for f in &folders {
        let Some(f) = f.as_str() else { return Err(CoreError::format("Invalid folder in backup.")) };
        if let Ok(f) = normalize_folder(f) {
            if !f.is_empty() && !d.macro_folders.contains(&f) {
                d.macro_folders.push(f);
            }
        }
    }

    // Macros.
    let mut seen: HashSet<String> = d.macros.iter().map(|m| signature(&m.folder, &m.script)).collect();
    for raw in raw_macros {
        let Ok(m) = serde_json::from_value::<RawMacro>(raw) else {
            rep.invalid += 1;
            continue;
        };
        let (Ok(name), Ok(folder)) = (validate_name(&m.name), normalize_folder(m.folder.as_deref().unwrap_or("")))
        else {
            rep.invalid += 1;
            continue;
        };
        if m.script.trim().is_empty() || m.script.len() > MAX_SCRIPT || check(&m.script).is_err() {
            rep.invalid += 1;
            continue;
        }
        if !seen.insert(signature(&folder, &m.script)) {
            rep.duplicates += 1;
            continue;
        }
        if !folder.is_empty() && !d.macro_folders.contains(&folder) {
            d.macro_folders.push(folder.clone());
        }
        d.macros.push(Macro {
            id: new_id(),
            name,
            folder,
            script: m.script,
            // Imported macros are reviewed before their first run, like the plugin does.
            edit_before_run: true,
            parameter_defaults: m.parameter_defaults.unwrap_or_default(),
        });
        rep.macros += 1;
    }

    // Sessions (Tabby profiles).
    let group_names: HashMap<String, String> = groups
        .iter()
        .filter_map(|g| Some((g.get("id")?.as_str()?.to_string(), g.get("name")?.as_str()?.to_string())))
        .collect();
    // Profile id in the file → id of the session it became (or already was).
    let mut new_ids: HashMap<String, String> = HashMap::new();
    let first_new = d.sessions.len();
    for p in &sessions {
        let pid = p.get("id").and_then(Value::as_str).unwrap_or("").to_string();
        match session_from_profile(p, &group_names) {
            Some(mut s) => {
                let existing = d.sessions.iter().find(|x| {
                    x.kind == s.kind
                        && x.name == s.name
                        && x.host == s.host
                        && x.port == s.port
                        && x.user == s.user
                        && x.serial.port == s.serial.port
                        && x.shell == s.shell
                });
                if let Some(x) = existing {
                    new_ids.insert(pid.clone(), x.id.clone());
                    rep.skipped_sessions += 1;
                    continue;
                }
                new_ids.insert(pid.clone(), s.id.clone());
                if let Some(pid) = p.get("id").and_then(Value::as_str) {
                    if let Some(st) = startup.get(pid) {
                        let script = st.get("postConnectScript").and_then(Value::as_str).unwrap_or("");
                        let dir = st.get("workingDirectory").and_then(Value::as_str).unwrap_or("");
                        if (!script.trim().is_empty() || !dir.trim().is_empty())
                            && script.len() <= MAX_SCRIPT
                            && !dir.contains(['\r', '\n', '\0'])
                        {
                            s.startup_script = script.to_string();
                            s.startup_dir = dir.trim().to_string();
                            s.startup_enabled = false;
                            rep.startup_disabled += 1;
                        }
                    }
                }
                if !s.folder.is_empty() && !d.folders.contains(&s.folder) {
                    d.folders.push(s.folder.clone());
                }
                d.sessions.push(s);
                rep.sessions += 1;
            }
            None => rep.skipped_sessions += 1,
        }
    }
    // Point jump hosts at the imported (or matching existing) sessions.
    for i in first_new..d.sessions.len() {
        let target = d.sessions[i].jump_session.take().and_then(|j| new_ids.get(&j).cloned());
        d.sessions[i].jump_session = target.filter(|t| *t != d.sessions[i].id);
    }
    Ok(rep)
}

/// Map a Tabby profile to a session. Returns None for unsupported types
/// (telnet, raw sockets, ...) or invalid data.
fn session_from_profile(p: &Value, groups: &HashMap<String, String>) -> Option<Session> {
    let typ = p.get("type")?.as_str()?;
    let name = validate_name(p.get("name")?.as_str()?).ok()?;
    let o = p.get("options").cloned().unwrap_or(json!({}));
    let folder = p
        .get("group")
        .and_then(Value::as_str)
        .map(|g| groups.get(g).cloned().unwrap_or_else(|| g.to_string()))
        .and_then(|g| normalize_folder(&g).ok())
        .unwrap_or_default();
    let mut s = Session { id: new_id(), name, folder, ..Default::default() };
    let str_of = |k: &str| o.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    match typ {
        "ssh" => {
            s.kind = SessionKind::Ssh;
            s.host = crate::model::validate_host(&str_of("host")).ok()?;
            s.port = o.get("port").and_then(Value::as_u64).filter(|p| (1..=65535).contains(p)).unwrap_or(22) as u16;
            s.user = crate::model::validate_user(&str_of("user")).unwrap_or_default();
            s.auth = match o.get("auth").and_then(Value::as_str) {
                Some("password") => AuthMethod::Password,
                Some("publicKey") => AuthMethod::Key,
                Some("agent") => AuthMethod::Agent,
                _ => AuthMethod::Auto,
            };
            if let Some(k) =
                o.get("privateKeys").and_then(Value::as_array).and_then(|a| a.first()).and_then(Value::as_str)
            {
                s.key_path = file_uri_to_path(k);
            }
            for f in o.get("forwardedPorts").and_then(Value::as_array).into_iter().flatten().take(MAX_FORWARDS) {
                let kind = match f.get("type").and_then(Value::as_str) {
                    Some("Local") => ForwardKind::Local,
                    Some("Remote") => ForwardKind::Remote,
                    Some("Dynamic") => ForwardKind::Dynamic,
                    _ => continue,
                };
                let port =
                    |k: &str| f.get(k).and_then(Value::as_u64).filter(|p| (1..=65535).contains(p)).unwrap_or(0) as u16;
                let txt = |k: &str| f.get(k).and_then(Value::as_str).unwrap_or("").to_string();
                let fwd = Forward {
                    kind,
                    bind_host: txt("host"),
                    bind_port: port("port"),
                    dest_host: txt("targetAddress"),
                    dest_port: port("targetPort"),
                    enabled: f.get("enabled").and_then(Value::as_bool).unwrap_or(true),
                };
                if let Ok(mut fwd) = fwd.validated() {
                    // A file shouldn't open ports to the network on its own.
                    if fwd.is_public() {
                        fwd.enabled = false;
                    }
                    s.forwards.push(fwd);
                }
            }
            s.jump_session = o.get("jumpHost").and_then(Value::as_str).filter(|j| j.len() <= 200).map(String::from);
        }
        "local" => {
            s.kind = SessionKind::Local;
            let cmd = str_of("command").to_lowercase();
            let base = cmd.rsplit(['\\', '/']).next().unwrap_or("").trim_end_matches(".exe").to_string();
            let args: Vec<String> = o
                .get("args")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
                .unwrap_or_default();
            s.shell = match base.as_str() {
                "pwsh" => "pwsh".into(),
                "powershell" => "powershell".into(),
                "cmd" => "cmd".into(),
                "wsl" => args
                    .iter()
                    .position(|a| a == "-d" || a == "--distribution")
                    .and_then(|i| args.get(i + 1))
                    .map(|d| format!("wsl:{d}"))
                    .unwrap_or_default(),
                _ => String::new(),
            };
        }
        "serial" => {
            s.kind = SessionKind::Serial;
            let flow = if o.get("rtscts").and_then(Value::as_bool).unwrap_or(false) {
                FlowOpt::Hardware
            } else if o.get("xon").and_then(Value::as_bool).unwrap_or(false) {
                FlowOpt::Software
            } else {
                FlowOpt::None
            };
            let cfg = SerialConfig {
                port: str_of("port"),
                baud: o.get("baudrate").and_then(Value::as_u64).unwrap_or(9600) as u32,
                data_bits: o.get("databits").and_then(Value::as_u64).unwrap_or(8) as u8,
                stop_bits: o.get("stopbits").and_then(Value::as_f64).map(|x| if x >= 2.0 { 2 } else { 1 }).unwrap_or(1),
                parity: match o.get("parity").and_then(Value::as_str) {
                    Some("odd") => ParityOpt::Odd,
                    Some("even") => ParityOpt::Even,
                    _ => ParityOpt::None,
                },
                flow,
            };
            // Keep the session even if the port name is unusual here; it can be edited.
            s.serial = cfg.validated().unwrap_or(SerialConfig { port: String::new(), ..cfg });
        }
        _ => return None,
    }
    Some(s)
}

fn file_uri_to_path(k: &str) -> String {
    let Some(rest) = k.strip_prefix("file://") else { return k.to_string() };
    let rest = rest.strip_prefix('/').filter(|r| r.len() > 1 && r.as_bytes()[1] == b':').unwrap_or(rest);
    // Percent-decode bytes, then read them as UTF-8 ("%C3%A9" is "é").
    let b = rest.as_bytes();
    let hex = |c: u8| (c as char).to_digit(16).map(|d| d as u8);
    let mut bytes = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2])) {
                bytes.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        bytes.push(b[i]);
        i += 1;
    }
    let out = String::from_utf8_lossy(&bytes).into_owned();
    if cfg!(windows) {
        out.replace('/', "\\")
    } else {
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PLUGIN_BACKUP: &str = r#"{
      "format": "tabby-personal-sidebar", "version": 1,
      "macros": [
        {"id":"siakap-1","name":"Port status","script":"show interface {{Switch port}} status","folder":"ncp/nv","editBeforeRun":false,
         "parameterDefaults":{"Switch port":"Gi1/0/1"}},
        {"id":"siakap-2","name":"Dupe","script":"show   interface {{p}} status","folder":"NCP/NV"},
        {"id":"siakap-3","name":"","script":"x"}
      ],
      "folders": ["ncp/nv", "ncp/core"],
      "sessions": [
        {"id":"ssh:custom:1","type":"ssh","name":"core-sw01","group":"g1","options":{"host":"10.0.0.2","port":22,"user":"admin","auth":"password","privateKeys":["file:///C:/Users/me/.ssh/id_ed25519"]}},
        {"id":"local:custom:2","type":"local","name":"Ubuntu","options":{"command":"C:\\Windows\\System32\\wsl.exe","args":["-d","Ubuntu-22.04"]}},
        {"id":"serial:custom:3","type":"serial","name":"Console","options":{"port":"COM3","baudrate":115200,"databits":8,"stopbits":1,"parity":"none","rtscts":true}},
        {"id":"telnet:4","type":"telnet","name":"old","options":{"host":"1.2.3.4"}}
      ],
      "groups": [{"id":"g1","name":"Network/Core"}],
      "startupMacros": {"ssh:custom:1": {"postConnectScript":"terminal length 0","workingDirectory":"","enabled":true}}
    }"#;

    #[test]
    fn imports_plugin_backup() {
        let mut d = VaultData::default();
        let r = import(PLUGIN_BACKUP, &mut d).unwrap();
        assert_eq!(
            r,
            ImportReport {
                macros: 1,
                duplicates: 1,
                sessions: 3,
                skipped_sessions: 1,
                invalid: 1,
                startup_disabled: 1,
                source: "siakap".into(),
                ..Default::default()
            }
        );
        let m = &d.macros[0];
        assert_eq!(m.folder, "ncp/nv");
        assert!(m.edit_before_run, "imported macros are reviewed before their first run");
        assert_eq!(m.parameter_defaults["Switch port"], "Gi1/0/1");
        assert!(d.macro_folders.contains(&"ncp/core".to_string()));

        let ssh = &d.sessions[0];
        assert_eq!(
            (ssh.kind, ssh.host.as_str(), ssh.user.as_str(), ssh.folder.as_str()),
            (SessionKind::Ssh, "10.0.0.2", "admin", "Network/Core")
        );
        assert_eq!(ssh.auth, AuthMethod::Password);
        assert!(ssh.key_path.ends_with("id_ed25519"));
        assert_eq!(ssh.startup_script, "terminal length 0");
        assert!(!ssh.startup_enabled, "startup commands stay off until enabled");
        assert_eq!(d.sessions[1].shell, "wsl:Ubuntu-22.04");
        let ser = &d.sessions[2].serial;
        assert_eq!((ser.baud, ser.flow), (115200, FlowOpt::Hardware));

        // Importing again adds nothing.
        let again = import(PLUGIN_BACKUP, &mut d).unwrap();
        assert_eq!((again.macros, again.sessions), (0, 0));
    }

    #[test]
    fn round_trip_through_export() {
        let mut d = VaultData::default();
        import(PLUGIN_BACKUP, &mut d).unwrap();
        d.sessions[0].startup_enabled = true;
        let out = export(&d, Scope::All).to_string();
        assert!(out.contains(FORMAT));
        let mut fresh = VaultData::default();
        let r = import(&out, &mut fresh).unwrap();
        assert_eq!((r.macros, r.sessions), (1, 3));
        assert_eq!(fresh.sessions[0].startup_script, "terminal length 0");
        let macros_only = export(&d, Scope::Macros);
        assert_eq!(macros_only["scope"], "macros");
        assert!(macros_only.get("sessions").is_none());
    }

    #[test]
    fn accepts_old_format_and_rejects_junk() {
        let mut d = VaultData::default();
        let old = r#"{"format":"siakap-macros","version":1,"macros":[{"name":"a","folder":"x","script":"ls","preview":true}]}"#;
        assert_eq!(import(old, &mut d).unwrap().macros, 1);
        assert!(import("not json", &mut d).is_err());
        assert!(import(r#"{"format":"other"}"#, &mut d).is_err());
        assert!(import(r#"{"format":"tabby-personal-sidebar","version":2,"macros":[]}"#, &mut d).is_err());
    }

    #[test]
    fn key_paths_with_non_ascii_never_crash_and_decode_utf8() {
        // A "%" followed by a multi-byte character used to panic (and abort the app).
        let _ = file_uri_to_path("file:///C:/Users/%é/id");
        let _ = file_uri_to_path("file:///C:/Users/%€x/id");
        let _ = file_uri_to_path("file:///home/%");
        let _ = file_uri_to_path("file:///home/%4");
        let p = file_uri_to_path("file:///home/me/caf%C3%A9/id");
        assert!(p.ends_with("café/id") || p.ends_with("café\\id"), "{p}");
    }

    #[test]
    fn file_uris() {
        let p = file_uri_to_path("file:///C:/Users/me/My%20Keys/id");
        assert!(p.contains("My Keys"));
        assert_eq!(file_uri_to_path("/home/me/.ssh/id"), "/home/me/.ssh/id");
    }
}
