//! Move a hardware security key between Windows and WSL with `usbipd`.
//!
//! Behaviour follows the "YubiKey Desktop Shortcuts" helper (v2.x):
//! * Attach and Detach are separate actions. If the key is already in the
//!   requested state, nothing is sent.
//! * The usual key is matched by its USB identity `VID_1050&PID_0407` *and*
//!   its device name "USB Input Device, Microsoft Usbccid Smartcard Reader
//!   (WUDF)" (case and spacing ignored). Other Yubico devices are listed too,
//!   but never chosen automatically.
//! * The chosen device is re-read right before acting and must still have the
//!   same BUSID, instance id and sharing identity.
//! * Sharing (`usbipd bind`) needs administrator rights: we explain it and
//!   never elevate.
//! * Every usbipd call has a time limit. After acting, the new state is
//!   verified for up to 6 s by the key's stable sharing identity
//!   (PersistedGuid), waiting out Windows USB re-enumeration. A missing device
//!   is never taken as proof of success.
//! * `usbipd state` output is validated strictly; anything unexpected stops
//!   with an error instead of guessing.
//!
//! `usbipd state` prints JSON like
//! `{"Devices":[{"BusId":"1-3","ClientIPAddress":null,"Description":"...",
//!   "InstanceId":"USB\\VID_1050&PID_0407\\...","PersistedGuid":"...", ...}]}`:
//! shared ⇔ PersistedGuid set, attached ⇔ ClientIPAddress set, connected ⇔ BusId set.

use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;

use crate::error::{CoreError, Result};
use crate::process::run_capture_timeout;

pub const SECURITY_KEY_VID: &str = "VID_1050";
const USUAL_PID: &str = "PID_0407";
const USUAL_NAME: &str = "USB Input Device, Microsoft Usbccid Smartcard Reader (WUDF)";
const STATE_TIMEOUT: Duration = Duration::from_secs(10);
const ACTION_TIMEOUT: Duration = Duration::from_secs(30);
const VERIFY_BUDGET: Duration = Duration::from_secs(6);
const VERIFY_POLL: Duration = Duration::from_millis(150);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub bus_id: Option<String>,
    pub description: String,
    pub instance_id: String,
    pub persisted_guid: Option<String>,
    pub shared: bool,
    pub attached: bool,
    /// "Attached", "Shared", "Not shared" or "Disconnected".
    pub state: String,
    /// The usual key (USB identity and device name both match).
    pub recommended: bool,
}

fn normalize(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

fn valid_bus_id(b: &str) -> bool {
    // ^\d+-\d+(?:\.\d+)*$
    let Some((a, rest)) = b.split_once('-') else { return false };
    !a.is_empty()
        && a.chars().all(|c| c.is_ascii_digit())
        && rest.split('.').all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
}

fn identity_matches(instance: &str, needle: &str) -> bool {
    // (?:^|\\)VID_1050&PID_xxxx(?:[&\\]|$), case-insensitive
    let up = instance.to_ascii_uppercase();
    let needle = needle.to_ascii_uppercase();
    up.match_indices(&needle).any(|(i, _)| {
        let before_ok = i == 0 || up.as_bytes()[i - 1] == b'\\';
        let after = up.as_bytes().get(i + needle.len());
        before_ok && matches!(after, None | Some(b'&') | Some(b'\\'))
    })
}

fn state_error(detail: &str) -> CoreError {
    CoreError::usbipd(format!(
        "usbipd returned an unsupported device-state format. {detail}\n\nNo device will be guessed. Check usbipd-win and keep this message for troubleshooting."
    ))
}

fn opt_str(item: &serde_json::Map<String, Value>, key: &str, required: bool) -> Result<Option<String>> {
    match item.get(key) {
        None if required => Err(state_error(&format!("Missing device property: {key}."))),
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        Some(_) => Err(state_error(&format!("Unsupported device property: {key}."))),
    }
}

fn is_guid(s: &str) -> bool {
    let t = s.trim_matches(|c| c == '{' || c == '}');
    let parts: Vec<&str> = t.split('-').collect();
    parts.len() == 5
        && [8, 4, 4, 4, 12].iter().zip(&parts).all(|(n, p)| p.len() == *n && p.chars().all(|c| c.is_ascii_hexdigit()))
}

/// Parse and strictly validate `usbipd state` output. Returns Yubico devices only.
pub fn parse_state(json: &str) -> Result<Vec<Device>> {
    let root: Value = serde_json::from_str(json).map_err(|_| state_error("The state response was not valid JSON."))?;
    let devices =
        root.get("Devices").and_then(Value::as_array).ok_or_else(|| state_error("The Devices array is missing."))?;
    let mut out = Vec::new();
    let mut seen_bus = std::collections::HashSet::new();
    for raw in devices {
        let item = raw.as_object().ok_or_else(|| state_error("An entry in Devices was not an object."))?;
        let bus = opt_str(item, "BusId", true)?;
        if let Some(b) = &bus {
            if !valid_bus_id(b) {
                return Err(state_error("A connected device has an invalid BUSID."));
            }
        }
        let instance = opt_str(item, "InstanceId", true)?.ok_or_else(|| state_error("A device has no InstanceId."))?;
        if !identity_matches(&instance, SECURITY_KEY_VID) {
            continue; // not a Yubico device
        }
        let description = opt_str(item, "Description", false)?;
        let persisted = opt_str(item, "PersistedGuid", true)?;
        let client = opt_str(item, "ClientIPAddress", true)?;
        if let Some(g) = &persisted {
            if !is_guid(g) {
                return Err(state_error("A security key has an invalid sharing identifier."));
            }
        }
        if let Some(c) = &client {
            if c.parse::<std::net::IpAddr>().is_err() {
                return Err(state_error("A security key has an invalid client address."));
            }
            if persisted.is_none() {
                return Err(state_error("An attached security key is unexpectedly marked as unshared."));
            }
            if bus.is_none() {
                return Err(state_error("A disconnected security key is unexpectedly marked as attached."));
            }
        }
        if let Some(b) = &bus {
            if !seen_bus.insert(b.to_ascii_lowercase()) {
                return Err(state_error("A BUSID is repeated."));
            }
        }
        let shared = persisted.is_some();
        let attached = client.is_some();
        let state = if bus.is_none() {
            "Disconnected"
        } else if attached {
            "Attached"
        } else if shared {
            "Shared"
        } else {
            "Not shared"
        };
        let recommended = identity_matches(&instance, &format!("{SECURITY_KEY_VID}&{USUAL_PID}"))
            && description.as_deref().is_some_and(|d| normalize(d) == normalize(USUAL_NAME));
        out.push(Device {
            bus_id: bus,
            description: description.unwrap_or_default(),
            instance_id: instance,
            persisted_guid: persisted.map(|g| g.trim_matches(|c| c == '{' || c == '}').to_ascii_lowercase()),
            shared,
            attached,
            state: state.into(),
            recommended,
        });
    }
    Ok(out)
}

/// Connected devices the user can pick, usual key first.
pub fn candidates(devices: &[Device]) -> Vec<Device> {
    let mut c: Vec<Device> = devices.iter().filter(|d| d.bus_id.is_some()).cloned().collect();
    c.sort_by_key(|d| !d.recommended);
    c
}

/// The device the user picked, identified exactly.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Selection {
    pub bus_id: String,
    pub instance_id: String,
    pub persisted_guid: Option<String>,
}

/// Find the selection in a fresh snapshot (same BUSID, instance and sharing id).
pub fn find_selected(devices: &[Device], sel: &Selection) -> Result<Device> {
    devices
        .iter()
        .find(|d| {
            d.bus_id.as_deref() == Some(sel.bus_id.as_str())
                && d.instance_id.eq_ignore_ascii_case(&sel.instance_id)
                && d.persisted_guid.as_deref().map(str::to_ascii_lowercase) == sel.persisted_guid.as_deref().map(str::to_ascii_lowercase)
        })
        .cloned()
        .ok_or_else(|| {
            CoreError::usbipd(format!(
                "The selected security key at BUSID {} was disconnected, moved or replaced in the meantime.\n\nNo other device was chosen. Check the connection and try again.",
                sel.bus_id
            ))
        })
}

/// After acting: is the same key (by sharing identity) connected in the
/// expected state? Err(reason) while not yet verified.
pub fn check_post_state(
    snapshot: &[Device],
    selected: &Device,
    expect_attached: bool,
) -> std::result::Result<Device, String> {
    let same: Vec<&Device> = snapshot
        .iter()
        .filter(|d| match &selected.persisted_guid {
            Some(g) => d.persisted_guid.as_deref() == Some(g.as_str()),
            None => d.instance_id.eq_ignore_ascii_case(&selected.instance_id),
        })
        .collect();
    match same.as_slice() {
        [] => Err("The selected key's identity is not in the latest device list.".into()),
        [d] if d.bus_id.is_none() => Err("The key is briefly disconnected while Windows re-detects it.".into()),
        [d] if d.attached != expect_attached => {
            Err(format!("The key at BUSID {} is still {}.", d.bus_id.as_deref().unwrap_or("?"), d.state.to_lowercase()))
        }
        [d] => Ok((*d).clone()),
        _ => Err("More than one device has the selected identity; none was guessed.".into()),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    /// "done" or "already".
    pub kind: String,
    pub title: String,
    pub message: String,
    pub bus_id: String,
}

/// usbipd as an absolute path: the standard install folder first, then PATH.
fn usbipd_path() -> Option<String> {
    #[cfg(windows)]
    {
        for base in [std::env::var_os("ProgramW6432"), std::env::var_os("ProgramFiles")].into_iter().flatten() {
            let p = std::path::Path::new(&base).join("usbipd-win").join("usbipd.exe");
            if p.is_file() {
                return Some(p.to_string_lossy().to_string());
            }
        }
    }
    crate::process::which("usbipd").filter(|p| p.is_absolute()).map(|p| p.to_string_lossy().to_string())
}

fn usbipd() -> Result<String> {
    usbipd_path().ok_or_else(|| {
        CoreError::usbipd("usbipd-win is not installed (expected C:\\Program Files\\usbipd-win\\usbipd.exe). Install it to move a security key to WSL.")
    })
}

fn read_state(exe: &str, timeout: Duration) -> Result<Vec<Device>> {
    let out = run_capture_timeout(exe, &["state"], timeout)
        .map_err(|e| CoreError::usbipd(format!("Could not read the USB device state: {e}")))?;
    if !out.success {
        return Err(CoreError::usbipd(format!("Could not read the USB device state: {}", out.stderr.trim())));
    }
    parse_state(&out.stdout)
}

/// Current Yubico devices (connected and remembered).
pub fn state() -> Result<Vec<Device>> {
    read_state(&usbipd()?, STATE_TIMEOUT)
}

/// Attach (`attach = true`) the selected key to WSL, or detach it back to Windows.
pub fn act(attach: bool, sel: &Selection) -> Result<Outcome> {
    if !valid_bus_id(&sel.bus_id) {
        return Err(CoreError::usbipd("Invalid BUSID."));
    }
    let exe = usbipd()?;
    // The chooser may have been open a while: never act on a stale row.
    let device = find_selected(&read_state(&exe, STATE_TIMEOUT)?, sel)?;
    let bus = device.bus_id.clone().unwrap_or_default();
    if attach && device.attached {
        return Ok(Outcome {
            kind: "already".into(),
            title: "Already attached".into(),
            message: format!("The key at BUSID {bus} is already attached to WSL. Nothing was changed."),
            bus_id: bus,
        });
    }
    if !attach && !device.attached {
        return Ok(Outcome {
            kind: "already".into(),
            title: "Already detached".into(),
            message: format!("The key at BUSID {bus} is already available to Windows. Nothing was changed."),
            bus_id: bus,
        });
    }
    if attach && !device.shared {
        return Err(CoreError::usbipd(format!(
            "The security key at BUSID {bus} is not shared yet.\n\nSharing is a one-time step that needs administrator rights. Ask IT, or run this once in an administrator terminal:\n\nusbipd bind --busid {bus}\n\nSiakap did not change anything and does not ask for administrator rights itself."
        )));
    }
    let args: Vec<&str> =
        if attach { vec!["attach", "--wsl", "--busid", &bus] } else { vec!["detach", "--busid", &bus] };
    let out = run_capture_timeout(&exe, &args, ACTION_TIMEOUT).map_err(|e| {
        CoreError::usbipd(format!(
            "usbipd {} did not finish: {e}\n\nCheck the key's current state before trying again.",
            args[0]
        ))
    })?;
    if !out.success {
        let hint = if attach { "\n\nKeep a WSL terminal open, then try again." } else { "" };
        return Err(CoreError::usbipd(format!(
            "Could not {} the security key: {}{hint}",
            if attach { "attach" } else { "detach" },
            out.stderr.trim()
        )));
    }
    // Verify by stable identity, waiting out USB re-enumeration.
    let start = Instant::now();
    let mut last = String::from("No device list was read yet.");
    while start.elapsed() < VERIFY_BUDGET {
        let left = VERIFY_BUDGET.saturating_sub(start.elapsed());
        match read_state(&exe, left.min(Duration::from_secs(2))) {
            Ok(snapshot) => match check_post_state(&snapshot, &device, attach) {
                Ok(d) => {
                    let b = d.bus_id.unwrap_or_default();
                    return Ok(Outcome {
                        kind: "done".into(),
                        title: if attach {
                            "Security key attached to WSL".into()
                        } else {
                            "Security key back on Windows".into()
                        },
                        message: format!(
                            "BUSID {b}. {}",
                            if attach { "Ready for use in WSL." } else { "Available to Windows again." }
                        ),
                        bus_id: b,
                    });
                }
                Err(r) => last = r,
            },
            Err(e) => last = e.to_string(),
        }
        std::thread::sleep(VERIFY_POLL.min(VERIFY_BUDGET.saturating_sub(start.elapsed())));
    }
    Err(CoreError::usbipd(format!(
        "The usbipd command finished, but the result couldn't be confirmed within 6 seconds.\n\nLast check: {last}\n\nCheck the key's current state before trying again. A missing device is not treated as a successful detach."
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    const GUID: &str = "0b8e1d7a-1111-2222-3333-444455556666";
    fn dev_json(bus: Option<&str>, inst: &str, name: &str, guid: Option<&str>, client: Option<&str>) -> String {
        let q = |v: Option<&str>| v.map(|x| format!("\"{x}\"")).unwrap_or_else(|| "null".into());
        format!(
            r#"{{"BusId":{},"ClientIPAddress":{},"Description":"{name}","InstanceId":"{}","IsForced":false,"PersistedGuid":{},"StubInstanceId":null}}"#,
            q(bus),
            q(client),
            inst.replace('\\', "\\\\"),
            q(guid)
        )
    }
    fn state_json(devs: &[String]) -> String {
        format!(r#"{{"Devices":[{}]}}"#, devs.join(","))
    }
    const KEY: &str = "USB\\VID_1050&PID_0407\\5&2A3B4C&0&3";

    #[test]
    fn parses_and_recommends_the_usual_key() {
        let j = state_json(&[
            dev_json(
                Some("1-3"),
                KEY,
                "USB Input Device,  Microsoft Usbccid Smartcard Reader (WUDF)",
                Some(GUID),
                None,
            ),
            dev_json(Some("1-4"), "USB\\VID_046D&PID_C52B\\6&1", "Mouse", None, None),
            dev_json(Some("2-1"), "USB\\VID_1050&PID_0406\\7&1", "FIDO only", None, None),
            dev_json(
                None,
                "USB\\VID_1050&PID_0407\\9&9",
                "USB Input Device, Microsoft Usbccid Smartcard Reader (WUDF)",
                Some("0b8e1d7a-aaaa-bbbb-cccc-ddddeeeeffff"),
                None,
            ),
        ]);
        let d = parse_state(&j).unwrap();
        assert_eq!(d.len(), 3, "Yubico only");
        assert!(d[0].recommended && d[0].shared && !d[0].attached && d[0].state == "Shared");
        assert!(!d[1].recommended && d[1].state == "Not shared");
        assert_eq!(d[2].state, "Disconnected");
        let c = candidates(&d);
        assert_eq!(c.len(), 2, "connected only");
        assert!(c[0].recommended);
    }

    #[test]
    fn rejects_inconsistent_state() {
        // Invalid BUSID anywhere.
        assert!(parse_state(&state_json(&[dev_json(Some("1-3; calc"), "USB\\VID_046D&PID_1\\1", "x", None, None)]))
            .is_err());
        // Attached but not shared.
        assert!(parse_state(&state_json(&[dev_json(Some("1-3"), KEY, "k", None, Some("172.20.0.2"))])).is_err());
        // Attached but disconnected.
        assert!(parse_state(&state_json(&[dev_json(None, KEY, "k", Some(GUID), Some("172.20.0.2"))])).is_err());
        // Bad GUID / bad IP.
        assert!(parse_state(&state_json(&[dev_json(Some("1-3"), KEY, "k", Some("nope"), None)])).is_err());
        assert!(parse_state(&state_json(&[dev_json(Some("1-3"), KEY, "k", Some(GUID), Some("not-an-ip"))])).is_err());
        // Repeated BUSID.
        assert!(parse_state(&state_json(&[
            dev_json(Some("1-3"), KEY, "k", Some(GUID), None),
            dev_json(Some("1-3"), KEY, "k", None, None)
        ]))
        .is_err());
        assert!(parse_state("{}").is_err());
        assert!(parse_state("not json").is_err());
    }

    #[test]
    fn identity_and_bus_rules() {
        assert!(identity_matches("USB\\VID_1050&PID_0407\\5&1", "VID_1050&PID_0407"));
        assert!(identity_matches("usb\\vid_1050&pid_0407", "VID_1050&PID_0407"));
        assert!(!identity_matches("USB\\VID_1050&PID_04071\\5", "VID_1050&PID_0407"));
        assert!(!identity_matches("USB\\XVID_1050&PID_0407", "VID_1050&PID_0407"));
        assert!(valid_bus_id("1-3") && valid_bus_id("2-10.1.4"));
        assert!(!valid_bus_id("1-") && !valid_bus_id("-1") && !valid_bus_id("1-3.") && !valid_bus_id("a-1"));
    }

    #[test]
    fn selection_must_be_the_same_device() {
        let d = parse_state(&state_json(&[dev_json(Some("1-3"), KEY, "k", Some(GUID), None)])).unwrap();
        let sel =
            Selection { bus_id: "1-3".into(), instance_id: KEY.into(), persisted_guid: Some(GUID.to_uppercase()) };
        assert!(find_selected(&d, &sel).is_ok());
        let moved = Selection { bus_id: "1-4".into(), ..sel.clone() };
        assert!(find_selected(&d, &moved).is_err());
        let swapped = Selection { persisted_guid: Some("0b8e1d7a-9999-2222-3333-444455556666".into()), ..sel };
        assert!(find_selected(&d, &swapped).is_err());
    }

    #[test]
    fn post_state_verification() {
        let before = &parse_state(&state_json(&[dev_json(Some("1-3"), KEY, "k", Some(GUID), None)])).unwrap()[0];
        // Re-enumerating (briefly disconnected): not yet.
        let gone = parse_state(&state_json(&[dev_json(None, KEY, "", Some(GUID), None)])).unwrap();
        assert!(check_post_state(&gone, before, true).is_err());
        // Missing entirely: never success, even for detach.
        assert!(check_post_state(&[], before, false).is_err());
        // Attached on a new BUSID with a new name: verified by sharing identity.
        let after =
            parse_state(&state_json(&[dev_json(Some("1-7"), KEY, "Renamed", Some(GUID), Some("172.20.0.2"))])).unwrap();
        assert_eq!(check_post_state(&after, before, true).unwrap().bus_id.as_deref(), Some("1-7"));
        assert!(check_post_state(&after, before, false).is_err());
    }

    #[test]
    fn outcome_json_matches_the_frontend() {
        let o = Outcome { kind: "done".into(), title: "t".into(), message: "m".into(), bus_id: "1-3".into() };
        assert_eq!(
            serde_json::to_value(o).unwrap(),
            serde_json::json!({"kind":"done","title":"t","message":"m","busId":"1-3"})
        );
    }
}
