//! Serial consoles (COM ports): port discovery and an interactive terminal.

use std::io::{ErrorKind, Read};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serialport::{DataBits, FlowControl, Parity, SerialPort, SerialPortType, StopBits};

use crate::error::{CoreError, Result};
use crate::pty::{EventSink, TermEvent};

/// Speeds offered in the UI. Any other value between 50 and 4 000 000 is accepted too.
pub const COMMON_BAUD_RATES: &[u32] =
    &[300, 1200, 2400, 4800, 9600, 14400, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortInfo {
    /// `COM3` on Windows, `/dev/ttyUSB0` on Linux.
    pub name: String,
    /// Human-readable label, e.g. "USB Serial Port (FTDI)".
    pub description: String,
    pub usb: bool,
    pub vid: Option<u16>,
    pub pid: Option<u16>,
}

/// List the serial ports the OS knows about, USB adapters first.
pub fn list_ports() -> Result<Vec<PortInfo>> {
    let ports = serialport::available_ports()
        .map_err(|e| CoreError::Io { message: format!("Could not list serial ports: {e}") })?;
    let mut out: Vec<PortInfo> = ports
        .into_iter()
        .map(|p| {
            let (description, usb, vid, pid) = match p.port_type {
                SerialPortType::UsbPort(u) => {
                    let product = u.product.unwrap_or_default();
                    let maker = u.manufacturer.unwrap_or_default();
                    let mut d = if product.is_empty() { "USB serial adapter".to_string() } else { product };
                    if !maker.is_empty() && !d.to_lowercase().contains(&maker.to_lowercase()) {
                        d = format!("{d} ({maker})");
                    }
                    (d, true, Some(u.vid), Some(u.pid))
                }
                SerialPortType::PciPort => ("Built-in serial port".to_string(), false, None, None),
                SerialPortType::BluetoothPort => ("Bluetooth serial port".to_string(), false, None, None),
                SerialPortType::Unknown => ("Serial port".to_string(), false, None, None),
            };
            PortInfo { name: p.port_name, description, usb, vid, pid }
        })
        .collect();
    out.sort_by(|a, b| b.usb.cmp(&a.usb).then_with(|| natural_key(&a.name).cmp(&natural_key(&b.name))));
    out.dedup_by(|a, b| a.name == b.name);
    Ok(out)
}

/// Sort COM2 before COM10.
fn natural_key(s: &str) -> (String, u64) {
    let digits: String =
        s.chars().rev().take_while(|c| c.is_ascii_digit()).collect::<Vec<_>>().into_iter().rev().collect();
    let prefix = s[..s.len() - digits.len()].to_ascii_lowercase();
    (prefix, digits.parse().unwrap_or(0))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum ParityOpt {
    #[default]
    None,
    Odd,
    Even,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum FlowOpt {
    #[default]
    None,
    /// XON/XOFF
    Software,
    /// RTS/CTS
    Hardware,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SerialConfig {
    pub port: String,
    pub baud: u32,
    pub data_bits: u8,
    pub parity: ParityOpt,
    pub stop_bits: u8,
    pub flow: FlowOpt,
}

impl Default for SerialConfig {
    fn default() -> Self {
        Self {
            port: String::new(),
            baud: 9600,
            data_bits: 8,
            parity: ParityOpt::None,
            stop_bits: 1,
            flow: FlowOpt::None,
        }
    }
}

impl SerialConfig {
    /// Check every field; returns a cleaned copy.
    pub fn validated(&self) -> Result<SerialConfig> {
        let port = validate_port(&self.port)?;
        if !(50..=4_000_000).contains(&self.baud) {
            return Err(CoreError::invalid("Speed must be between 50 and 4000000 baud."));
        }
        if !(5..=8).contains(&self.data_bits) {
            return Err(CoreError::invalid("Data bits must be 5, 6, 7 or 8."));
        }
        if !matches!(self.stop_bits, 1 | 2) {
            return Err(CoreError::invalid("Stop bits must be 1 or 2."));
        }
        Ok(SerialConfig { port, ..self.clone() })
    }

    /// e.g. "COM3 9600 8N1".
    pub fn summary(&self) -> String {
        let p = match self.parity {
            ParityOpt::None => 'N',
            ParityOpt::Odd => 'O',
            ParityOpt::Even => 'E',
        };
        format!("{} {} {}{}{}", self.port, self.baud, self.data_bits, p, self.stop_bits)
    }
}

/// Accepts `COM1`..`COM256` (also `\\.\COM10`) on Windows and `/dev/...` paths elsewhere.
pub fn validate_port(port: &str) -> Result<String> {
    let p = port.trim();
    if p.is_empty() {
        return Err(CoreError::invalid("Choose a serial port."));
    }
    if p.len() > 128 || p.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(CoreError::invalid("That doesn't look like a serial port name."));
    }
    if cfg!(windows) {
        let bare = p.strip_prefix(r"\\.\").unwrap_or(p);
        let ok = bare.len() > 3
            && bare[..3].eq_ignore_ascii_case("com")
            && bare[3..].chars().all(|c| c.is_ascii_digit())
            && bare[3..].parse::<u32>().is_ok_and(|n| (1..=256).contains(&n));
        if !ok {
            return Err(CoreError::invalid("Serial ports on Windows are named COM1, COM2, and so on."));
        }
        Ok(bare.to_ascii_uppercase())
    } else {
        if !p.starts_with("/dev/") || p.contains("/../") || p.ends_with("/..") {
            return Err(CoreError::invalid("Serial ports are device paths such as /dev/ttyUSB0."));
        }
        Ok(p.to_string())
    }
}

pub struct SerialTerm {
    writer: Mutex<Box<dyn SerialPort>>,
    queue: crate::pty::QueuedWriter,
    closed: Arc<AtomicBool>,
}

impl SerialTerm {
    pub fn open(cfg: &SerialConfig, sink: EventSink) -> Result<Self> {
        let cfg = cfg.validated()?;
        #[cfg(windows)]
        let path = format!(r"\\.\{}", cfg.port); // required for COM10 and above
        #[cfg(not(windows))]
        let path = cfg.port.clone();
        let port = serialport::new(&path, cfg.baud)
            .data_bits(match cfg.data_bits {
                5 => DataBits::Five,
                6 => DataBits::Six,
                7 => DataBits::Seven,
                _ => DataBits::Eight,
            })
            .parity(match cfg.parity {
                ParityOpt::None => Parity::None,
                ParityOpt::Odd => Parity::Odd,
                ParityOpt::Even => Parity::Even,
            })
            .stop_bits(if cfg.stop_bits == 2 { StopBits::Two } else { StopBits::One })
            .flow_control(match cfg.flow {
                FlowOpt::None => FlowControl::None,
                FlowOpt::Software => FlowControl::Software,
                FlowOpt::Hardware => FlowControl::Hardware,
            })
            .timeout(Duration::from_millis(100))
            .open()
            .map_err(|e| {
                let busy = matches!(e.kind(), serialport::ErrorKind::Io(ErrorKind::PermissionDenied))
                    || e.to_string().to_lowercase().contains("access is denied")
                    || e.to_string().to_lowercase().contains("busy");
                CoreError::Io {
                    message: if busy {
                        format!(
                            "{} is in use by another program (PuTTY, another tab?) or you don't have access to it.",
                            cfg.port
                        )
                    } else {
                        format!("Could not open {}: {e}", cfg.port)
                    },
                }
            })?;
        let mut reader =
            port.try_clone().map_err(|e| CoreError::Io { message: format!("Could not open {}: {e}", cfg.port) })?;
        let closed = Arc::new(AtomicBool::new(false));
        let flag = closed.clone();
        let label = cfg.port.clone();
        std::thread::Builder::new()
            .name("serial-reader".into())
            .spawn(move || {
                let mut buf = vec![0u8; 8192];
                let code = loop {
                    if flag.load(Ordering::Relaxed) {
                        break None;
                    }
                    match reader.read(&mut buf) {
                        Ok(0) => continue,
                        Ok(n) => sink(TermEvent::Data(buf[..n].to_vec())),
                        Err(e)
                            if matches!(
                                e.kind(),
                                ErrorKind::TimedOut | ErrorKind::WouldBlock | ErrorKind::Interrupted
                            ) => {}
                        Err(_) => {
                            // Cable unplugged or device gone.
                            sink(TermEvent::Data(format!("\r\n[{label} disconnected]").into_bytes()));
                            break Some(1);
                        }
                    }
                };
                sink(TermEvent::Exit(code));
            })
            .map_err(CoreError::from)?;
        let out = port.try_clone().map_err(|e| CoreError::Io { message: format!("Could not open {path}: {e}") })?;
        let queue = crate::pty::QueuedWriter::new(Box::new(out), "serial-writer")?;
        Ok(Self { writer: Mutex::new(port), queue, closed })
    }

    /// Queue output for the line; never blocks (a slow line or flow control
    /// would otherwise hold the caller for as long as the data takes to send).
    pub fn write(&self, data: &[u8]) -> Result<()> {
        self.queue.write(data)
    }

    /// Send a break signal (used for password recovery on network gear).
    pub fn send_break(&self) -> Result<()> {
        let w = self.writer.lock().map_err(|_| CoreError::invalid("poisoned"))?;
        w.set_break().map_err(|e| CoreError::Io { message: format!("Could not send break: {e}") })?;
        std::thread::sleep(Duration::from_millis(300));
        w.clear_break().map_err(|e| CoreError::Io { message: format!("Could not send break: {e}") })?;
        Ok(())
    }

    pub fn close(&self) {
        self.closed.store(true, Ordering::Relaxed);
        self.queue.close();
    }
}

impl Drop for SerialTerm {
    fn drop(&mut self) {
        self.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_validation() {
        let mut c = SerialConfig {
            port: if cfg!(windows) { "com3".into() } else { "/dev/ttyUSB0".into() },
            ..Default::default()
        };
        let v = c.validated().unwrap();
        assert_eq!(v.summary(), format!("{} 9600 8N1", v.port));
        c.baud = 10;
        assert!(c.validated().is_err());
        c.baud = 115200;
        c.data_bits = 9;
        assert!(c.validated().is_err());
        c.data_bits = 7;
        c.stop_bits = 3;
        assert!(c.validated().is_err());
    }

    #[test]
    fn port_names() {
        assert!(validate_port("").is_err());
        assert!(validate_port("COM3; calc").is_err());
        if cfg!(windows) {
            assert_eq!(validate_port("com12").unwrap(), "COM12");
            assert_eq!(validate_port(r"\\.\COM10").unwrap(), "COM10");
            assert!(validate_port("COM0").is_err());
            assert!(validate_port("LPT1").is_err());
        } else {
            assert_eq!(validate_port("/dev/ttyUSB0").unwrap(), "/dev/ttyUSB0");
            assert!(validate_port("/etc/passwd").is_err());
            assert!(validate_port("/dev/../etc/passwd").is_err());
        }
    }

    #[test]
    fn natural_sort() {
        let mut v = vec!["COM10", "COM2", "COM1"];
        v.sort_by_key(|s| natural_key(s));
        assert_eq!(v, vec!["COM1", "COM2", "COM10"]);
    }

    #[test]
    fn listing_does_not_fail() {
        // May be empty on CI machines; it just must not error.
        let _ = list_ports();
    }

    // Not on macOS: there, setting the line speed on a pseudo-terminal fails
    // ("Not a typewriter"); real USB serial adapters (/dev/cu.*) accept it.
    #[cfg(all(unix, not(target_os = "macos")))]
    #[test]
    fn talks_to_a_pty_device() {
        // A pseudo-terminal behaves like a serial device for reading/writing.
        use std::sync::mpsc;
        let pair = portable_pty::native_pty_system().openpty(portable_pty::PtySize::default()).unwrap();
        let Some(name) = pair.master.tty_name() else { return };
        let name = name.to_string_lossy().to_string();
        if !name.starts_with("/dev/") {
            return;
        }
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        let sink: EventSink = Arc::new(move |e| {
            let _ = tx.lock().unwrap().send(e);
        });
        let term = SerialTerm::open(&SerialConfig { port: name, baud: 115200, ..Default::default() }, sink).unwrap();
        let mut w = pair.master.take_writer().unwrap();
        // Opening the port may flush input that arrived first, so repeat the
        // prompt until it comes through (like pressing Enter on a console).
        let mut got = Vec::new();
        for _ in 0..30 {
            w.write_all(b"Router>").unwrap();
            if let Ok(TermEvent::Data(d)) = rx.recv_timeout(Duration::from_millis(200)) {
                got.extend(d);
                if String::from_utf8_lossy(&got).contains("Router>") {
                    break;
                }
            }
        }
        assert!(String::from_utf8_lossy(&got).contains("Router>"));
        term.write(b"show version\r").unwrap();
        term.close();
    }
}
