//! Live tests against a real SSH server. Skipped unless SIAKAP_TEST_SSH is set:
//!
//! ```text
//! SIAKAP_TEST_SSH=user:password@127.0.0.1:2222 cargo test -p siakap-core --test ssh_live
//! ```
//! The user's home directory must contain a readable file `big.bin`.

use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use siakap_core::model::{AuthMethod, KnownHost};
use siakap_core::pty::{EventSink, TermEvent};
use siakap_core::sftp::Sftp;
use siakap_core::ssh::{known_host_entry, ConnectParams, PresentedKey, SshConnection};
use siakap_core::CoreError;
use zeroize::Zeroizing;

struct Target {
    user: String,
    pass: String,
    host: String,
    port: u16,
}

fn target() -> Option<Target> {
    let v = std::env::var("SIAKAP_TEST_SSH").ok()?;
    let (cred, addr) = v.rsplit_once('@')?;
    let (user, pass) = cred.split_once(':')?;
    let (host, port) = addr.rsplit_once(':')?;
    Some(Target { user: user.into(), pass: pass.into(), host: host.into(), port: port.parse().ok()? })
}

fn params(t: &Target, known: Vec<KnownHost>, password: Option<&str>) -> ConnectParams {
    ConnectParams {
        host: t.host.clone(),
        port: t.port,
        user: t.user.clone(),
        auth: AuthMethod::Password,
        key_path: String::new(),
        password: password.map(|p| Zeroizing::new(p.to_string())),
        passphrase: None,
        known_hosts: known,
    }
}

async fn trusted(t: &Target) -> Vec<KnownHost> {
    match SshConnection::connect(params(t, vec![], Some(&t.pass))).await {
        Err(CoreError::HostKeyUnknown { fingerprint, key_type, public_key, .. }) => {
            assert!(fingerprint.starts_with("SHA256:"));
            vec![known_host_entry(&t.host, t.port, &PresentedKey { key_type, fingerprint, public_key })]
        }
        Err(e) => panic!("expected HostKeyUnknown, got {e:?}"),
        Ok(_) => panic!("connected without a known host key"),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn live_ssh_tofu_shell_and_sftp() {
    let Some(t) = target() else {
        eprintln!("SIAKAP_TEST_SSH not set; skipping");
        return;
    };

    // 1. Unknown key → HostKeyUnknown; never auto-accepted.
    let known = trusted(&t).await;

    // 2. Changed key → hard refusal.
    let mut fake = known[0].clone();
    fake.fingerprint = "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".into();
    fake.public_key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl".into();
    match SshConnection::connect(params(&t, vec![fake], Some(&t.pass))).await {
        Err(CoreError::HostKeyChanged { message, .. }) => assert!(message.contains("HAS CHANGED")),
        Err(e) => panic!("expected HostKeyChanged, got {e:?}"),
        Ok(_) => panic!("connected despite a changed host key"),
    }

    // 3. No password → PasswordRequired; wrong password → Auth error.
    assert!(matches!(
        SshConnection::connect(params(&t, known.clone(), None)).await.err(),
        Some(CoreError::PasswordRequired { .. })
    ));
    assert!(matches!(
        SshConnection::connect(params(&t, known.clone(), Some("wrong"))).await.err(),
        Some(CoreError::Auth { .. })
    ));

    // 4. Shell round trip.
    let conn = SshConnection::connect(params(&t, known.clone(), Some(&t.pass))).await.expect("connect");
    let out = Arc::new(Mutex::new(Vec::<u8>::new()));
    let exited = Arc::new(Mutex::new(None::<Option<i32>>));
    let (o, x) = (out.clone(), exited.clone());
    let sink: EventSink = Arc::new(move |e| match e {
        TermEvent::Data(d) => o.lock().unwrap().extend(d),
        TermEvent::Exit(c) => *x.lock().unwrap() = Some(c),
    });
    let shell = conn.open_shell(100, 30, sink).await.expect("shell");
    shell.write(b"echo live-$((6*7))\r".to_vec()).unwrap();
    shell.resize(120, 40).unwrap();
    let mut seen = false;
    for _ in 0..100 {
        tokio::time::sleep(Duration::from_millis(100)).await;
        if String::from_utf8_lossy(&out.lock().unwrap()).contains("live-42") {
            seen = true;
            break;
        }
    }
    assert!(seen, "shell output");

    // 5. SFTP on the same connection: list, download, upload, verify, delete.
    let sftp = Sftp::new(conn.open_sftp().await.expect("sftp"));
    let home = sftp.home().await.unwrap();
    let list = sftp.list(&home).await.unwrap();
    let big = list.iter().find(|e| e.name == "big.bin").expect("big.bin in home");
    let dir = tempfile::tempdir().unwrap();
    let local = dir.path().join("big.bin");
    let calls = Arc::new(Mutex::new(0usize));
    let c2 = calls.clone();
    let n = sftp
        .download(&big.path, &local, Arc::new(AtomicBool::new(false)), move |_, _| *c2.lock().unwrap() += 1)
        .await
        .unwrap();
    assert_eq!(n, big.size);
    assert!(*calls.lock().unwrap() > 1, "streamed in chunks");
    std::fs::rename(&local, dir.path().join("siakap-upload-test.bin")).unwrap();
    let remote = sftp
        .upload(&dir.path().join("siakap-upload-test.bin"), &home, Arc::new(AtomicBool::new(false)), |_, _| {})
        .await
        .unwrap();
    let back = dir.path().join("roundtrip.bin");
    sftp.download(&remote, &back, Arc::new(AtomicBool::new(false)), |_, _| {}).await.unwrap();
    assert_eq!(std::fs::read(&back).unwrap(), std::fs::read(dir.path().join("siakap-upload-test.bin")).unwrap());
    // Cancelled transfer leaves no partial file behind.
    let cancelled = dir.path().join("cancelled.bin");
    let r = sftp.download(&big.path, &cancelled, Arc::new(AtomicBool::new(true)), |_, _| {}).await;
    assert!(matches!(r, Err(CoreError::Cancelled { .. })));
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 2);

    sftp.mkdir(&home, "siakap-dir").await.unwrap();
    sftp.rename(&format!("{home}/siakap-dir"), "siakap-dir2").await.unwrap();
    sftp.remove(&format!("{home}/siakap-dir2"), true).await.unwrap();
    sftp.remove(&remote, false).await.unwrap();

    // 6. Closing the shell reports an exit.
    shell.close();
    for _ in 0..50 {
        if exited.lock().unwrap().is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(exited.lock().unwrap().is_some(), "exit event");
    conn.disconnect().await;
}
