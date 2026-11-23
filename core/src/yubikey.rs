//! YubiKey → WSL toggle via `usbipd` (usbipd-win 4.x).
//!
//! `usbipd state` prints JSON like:
//! ```json
//! {"Devices":[{"BusId":"1-3","ClientIPAddress":null,"Description":"...",
//!   "InstanceId":"USB\\VID_1050&PID_0407\\5&...","IsForced":false,
//!   "PersistedGuid":"...","StubInstanceId":null}]}
//! ```
//! * shared (bound)  ⇔ `PersistedGuid` is set
//! * attached        ⇔ `ClientIPAddress` is set
//! * connected       ⇔ `BusId` is set

use serde::{Deserialize, Serialize};

use crate::error::{CoreError, Result};
use crate::process::run_capture;

pub const YUBICO_VID: &str = "VID_1050";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct StateJson {
    #[serde(default)]
    devices: Vec<RawDevice>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct RawDevice {
    bus_id: Option<String>,
    #[serde(rename = "ClientIPAddress")]
    client_ip_address: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    instance_id: Option<String>,
    persisted_guid: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub bus_id: Option<String>,
    pub description: String,
    pub instance_id: String,
    pub shared: bool,
    pub attached: bool,
}

/// Parse `usbipd state` output and return only Yubico devices.
pub fn parse_state(json: &str) -> Result<Vec<Device>> {
    let s: StateJson =
        serde_json::from_str(json).map_err(|e| CoreError::usbipd(format!("Unexpected `usbipd state` output: {e}")))?;
    Ok(s.devices
        .into_iter()
        .filter(|d| d.instance_id.as_deref().is_some_and(|i| i.to_ascii_uppercase().contains(YUBICO_VID)))
        .map(|d| Device {
            bus_id: d.bus_id.filter(|b| !b.is_empty()),
            description: d.description.unwrap_or_default(),
            instance_id: d.instance_id.unwrap_or_default(),
            shared: d.persisted_guid.is_some_and(|g| !g.is_empty()),
            attached: d.client_ip_address.is_some_and(|a| !a.is_empty()),
        })
        .collect())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum Plan {
    Attach { bus_ids: Vec<String> },
    Detach { bus_ids: Vec<String> },
}

fn valid_bus_id(b: &str) -> bool {
    !b.is_empty() && b.len() <= 16 && b.chars().all(|c| c.is_ascii_digit() || c == '-') && !b.starts_with('-')
}

/// Decide what the toggle should do, or explain why it can't.
pub fn plan_toggle(devices: &[Device]) -> Result<Plan> {
    let connected: Vec<&Device> = devices.iter().filter(|d| d.bus_id.is_some()).collect();
    if connected.is_empty() {
        return Err(CoreError::usbipd("No YubiKey (USB VID 1050) is plugged in."));
    }
    let not_shared: Vec<String> = connected.iter().filter(|d| !d.shared).filter_map(|d| d.bus_id.clone()).collect();
    if !not_shared.is_empty() {
        let cmds = not_shared.iter().map(|b| format!("usbipd bind --busid {b}")).collect::<Vec<_>>().join("\n");
        return Err(CoreError::usbipd(format!(
            "The YubiKey is not shared with usbipd yet. Sharing needs administrator rights, so Siakap will not do it \
             for you. Run this once in an elevated terminal:\n\n{cmds}"
        )));
    }
    let bus_ids: Vec<String> = connected.iter().filter_map(|d| d.bus_id.clone()).collect();
    if let Some(b) = bus_ids.iter().find(|b| !valid_bus_id(b)) {
        return Err(CoreError::usbipd(format!("Unexpected bus id {b:?}.")));
    }
    let attached = connected.iter().filter(|d| d.attached).count();
    if attached == connected.len() {
        Ok(Plan::Detach { bus_ids })
    } else if attached == 0 {
        Ok(Plan::Attach { bus_ids })
    } else {
        Err(CoreError::usbipd(format!(
            "Inconsistent state: {attached} of {} YubiKeys are attached to WSL. Attach or detach them manually \
             with usbipd so they all match, then try again.",
            connected.len()
        )))
    }
}

/// Query the current Yubico devices.
pub fn state() -> Result<Vec<Device>> {
    let out = run_capture("usbipd", &["state"])
        .map_err(|e| CoreError::usbipd(format!("Could not run usbipd ({e}). Is usbipd-win installed and on PATH?")))?;
    if !out.success {
        return Err(CoreError::usbipd(format!("usbipd state failed: {}", out.stderr.trim())));
    }
    parse_state(&out.stdout)
}

/// Toggle all connected YubiKeys between Windows and WSL. Returns the new plan
/// that was executed.
pub fn toggle() -> Result<Plan> {
    let devices = state()?;
    let plan = plan_toggle(&devices)?;
    let ids = match &plan {
        Plan::Attach { bus_ids } | Plan::Detach { bus_ids } => bus_ids.clone(),
    };
    for b in &ids {
        let args: Vec<&str> = match plan {
            Plan::Attach { .. } => vec!["attach", "--wsl", "--busid", b],
            Plan::Detach { .. } => vec!["detach", "--busid", b],
        };
        let out = run_capture("usbipd", &args).map_err(|e| CoreError::usbipd(format!("usbipd failed: {e}")))?;
        if !out.success {
            return Err(CoreError::usbipd(format!("usbipd {} failed: {}", args[0], out.stderr.trim())));
        }
    }
    Ok(plan)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"{
      "Devices": [
        {"BusId":"1-3","ClientIPAddress":null,"Description":"YubiKey OTP+FIDO+CCID",
         "InstanceId":"USB\\VID_1050&PID_0407\\5&2A3B4C&0&3","IsForced":false,
         "PersistedGuid":"0b8e1d7a-0000-0000-0000-000000000000","StubInstanceId":null},
        {"BusId":"1-4","ClientIPAddress":null,"Description":"USB Input Device",
         "InstanceId":"USB\\VID_046D&PID_C52B\\6&1","IsForced":false,"PersistedGuid":null,"StubInstanceId":null},
        {"BusId":null,"ClientIPAddress":null,"Description":"YubiKey (unplugged)",
         "InstanceId":"USB\\vid_1050&pid_0402\\X","IsForced":false,"PersistedGuid":"g","StubInstanceId":null}
      ]
    }"#;

    #[test]
    fn parses_usbipd_state() {
        let d = parse_state(SAMPLE).unwrap();
        assert_eq!(d.len(), 2, "only Yubico devices, case-insensitive VID");
        assert_eq!(d[0].bus_id.as_deref(), Some("1-3"));
        assert!(d[0].shared && !d[0].attached);
        assert_eq!(d[1].bus_id, None);
        assert!(parse_state("{}").unwrap().is_empty());
        assert!(parse_state("not json").is_err());
    }

    fn dev(bus: &str, shared: bool, attached: bool) -> Device {
        Device { bus_id: Some(bus.into()), description: String::new(), instance_id: String::new(), shared, attached }
    }

    #[test]
    fn plans() {
        assert_eq!(plan_toggle(&[dev("1-3", true, false)]).unwrap(), Plan::Attach { bus_ids: vec!["1-3".into()] });
        assert_eq!(
            plan_toggle(&[dev("1-3", true, true), dev("2-1", true, true)]).unwrap(),
            Plan::Detach { bus_ids: vec!["1-3".into(), "2-1".into()] }
        );
        let e = plan_toggle(&[dev("1-3", true, true), dev("2-1", true, false)]).unwrap_err();
        assert!(e.to_string().contains("Inconsistent"));
        let e = plan_toggle(&[dev("1-3", false, false)]).unwrap_err();
        assert!(e.to_string().contains("usbipd bind --busid 1-3"));
        assert!(plan_toggle(&[]).is_err());
        assert!(plan_toggle(&[dev("1-3; calc", true, false)]).is_err());
    }

    #[test]
    fn attached_after_parse() {
        let json = r#"{"Devices":[{"BusId":"3-1","ClientIPAddress":"172.20.0.2","InstanceId":"USB\\VID_1050&PID_0407\\1","PersistedGuid":"g"}]}"#;
        let d = parse_state(json).unwrap();
        assert!(d[0].attached);
        assert_eq!(plan_toggle(&d).unwrap(), Plan::Detach { bus_ids: vec!["3-1".into()] });
    }
}
