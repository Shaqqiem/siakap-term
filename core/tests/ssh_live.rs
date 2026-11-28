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
        keepalive_secs: 30,
        connect_timeout_secs: 20,
        prompter: None,
        jump: None,
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
        .upload(&dir.path().join("siakap-upload-test.bin"), &home, false, Arc::new(AtomicBool::new(false)), |_, _| {})
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

    data_safety(&sftp, &home).await;
    folders(&sftp, &home).await;

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

/// Folder upload, download and recursive delete.
async fn folders(sftp: &Sftp, home: &str) {
    let flag = || Arc::new(AtomicBool::new(false));
    let d = tempfile::tempdir().unwrap();
    let name = format!("siakap-tree-{}", std::process::id());
    let src = d.path().join(&name);
    std::fs::create_dir_all(src.join("sub/deeper")).unwrap();
    std::fs::create_dir_all(src.join("empty")).unwrap();
    std::fs::write(src.join("top.txt"), b"top").unwrap();
    std::fs::write(src.join("sub/deeper/x.bin"), vec![7u8; 700_000]).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink("/etc", src.join("etc-link")).unwrap();

    let seen = Arc::new(Mutex::new(Vec::new()));
    let s2 = seen.clone();
    let up = sftp.upload_tree(&src, home, false, flag(), move |p| s2.lock().unwrap().push(p)).await.unwrap();
    assert_eq!((up.files, up.bytes), (2, 700_003));
    #[cfg(unix)]
    assert_eq!(up.skipped, vec!["etc-link".to_string()]);
    let last = seen.lock().unwrap().last().cloned().unwrap();
    assert_eq!((last.done, last.total, last.files, last.total_files), (700_003, 700_003, 2, 2));

    // Same name again: asks first, merging replaces files.
    let again = sftp.upload_tree(&src, home, false, flag(), |_| {}).await;
    assert!(matches!(again, Err(CoreError::RemoteExists { .. })), "{again:?}");
    std::fs::write(src.join("top.txt"), b"top v2").unwrap();
    sftp.upload_tree(&src, home, true, flag(), |_| {}).await.unwrap();

    let out = tempfile::tempdir().unwrap();
    let remote_root = format!("{home}/{name}");
    let down = sftp.download_tree(&remote_root, out.path(), flag(), |_| {}).await.unwrap();
    let got = out.path().join(&name);
    assert_eq!(down.files, 2);
    assert_eq!(std::fs::read(got.join("top.txt")).unwrap(), b"top v2");
    assert_eq!(std::fs::read(got.join("sub/deeper/x.bin")).unwrap().len(), 700_000);
    assert!(got.join("empty").is_dir());
    // Downloading into a folder that already has it refuses rather than merging.
    assert!(sftp.download_tree(&remote_root, out.path(), flag(), |_| {}).await.is_err());

    // A sibling folder must survive the delete.
    let keep = format!("siakap-keep-{}", std::process::id());
    sftp.mkdir(home, &keep).await.unwrap();
    sftp.upload(&src.join("top.txt"), &format!("{home}/{keep}"), false, flag(), |_, _| {}).await.unwrap();
    // Cancelled before it starts: nothing is deleted.
    let r = sftp.remove_tree(&remote_root, Arc::new(AtomicBool::new(true)), |_, _| {}).await;
    assert!(matches!(r, Err(CoreError::Cancelled { .. })));
    assert!(sftp.list(&remote_root).await.is_ok());
    let n = sftp.remove_tree(&remote_root, flag(), |_, _| {}).await.unwrap();
    assert!(n >= 6, "removed {n}");
    assert!(sftp.list(&remote_root).await.is_err());
    assert!(sftp.remove_tree("/", flag(), |_, _| {}).await.is_err());
    let kept = sftp.list(&format!("{home}/{keep}")).await.unwrap();
    assert_eq!(kept.len(), 1, "the sibling folder was left alone");
    sftp.remove_tree(&format!("{home}/{keep}"), flag(), |_, _| {}).await.unwrap();
}

/// Uploads never destroy an existing remote file; downloads never clobber a
/// local file unless they complete.
async fn data_safety(sftp: &Sftp, home: &str) {
    let flag = |v: bool| Arc::new(AtomicBool::new(v));
    let work = format!("siakap-safety-{}", std::process::id());
    sftp.mkdir(home, &work).await.unwrap();
    let rdir = format!("{home}/{work}");
    let local = tempfile::tempdir().unwrap();
    let put = |name: &str, body: &[u8]| {
        let p = local.path().join(name);
        std::fs::write(&p, body).unwrap();
        p
    };
    let read_remote = |path: String| {
        let out = local.path().join(format!("check-{}", siakap_core::model::new_id()));
        async move {
            sftp.download(&path, &out, flag(false), |_, _| {}).await.unwrap();
            std::fs::read(&out).unwrap()
        }
    };
    let leftovers = || async {
        sftp.list(&rdir)
            .await
            .unwrap()
            .into_iter()
            .filter(|e| e.name.contains("siakap-"))
            .map(|e| e.name)
            .collect::<Vec<_>>()
    };

    // An original remote file.
    let orig = put("keep.txt", b"ORIGINAL");
    let remote = sftp.upload(&orig, &rdir, false, flag(false), |_, _| {}).await.unwrap();
    assert_eq!(read_remote(remote.clone()).await, b"ORIGINAL");

    // 1. Without overwrite: refused before anything is written.
    let newer_dir = tempfile::tempdir().unwrap();
    let newer = newer_dir.path().join("keep.txt");
    std::fs::write(&newer, vec![b'N'; 3_000_000]).unwrap();
    let e = sftp.upload(&newer, &rdir, false, flag(false), |_, _| {}).await.unwrap_err();
    assert!(matches!(e, CoreError::RemoteExists { .. }), "{e:?}");
    assert_eq!(read_remote(remote.clone()).await, b"ORIGINAL");

    // 2. Cancelled while replacing: the original survives, no temp file is left.
    let cancel = flag(false);
    let c2 = cancel.clone();
    let e = sftp
        .upload(&newer, &rdir, true, cancel, move |done, _| {
            if done > 500_000 {
                c2.store(true, std::sync::atomic::Ordering::Relaxed);
            }
        })
        .await
        .unwrap_err();
    assert!(matches!(e, CoreError::Cancelled { .. }), "{e:?}");
    assert_eq!(read_remote(remote.clone()).await, b"ORIGINAL", "cancelled upload must not touch the original");
    assert!(leftovers().await.is_empty(), "temp files left: {:?}", leftovers().await);

    // 3. Replacing for real keeps the old file's permissions.
    let mut attrs = russh_sftp::protocol::FileAttributes::empty();
    attrs.permissions = Some(0o750);
    let _ = sftp_set_mode(sftp, &remote, attrs).await;
    sftp.upload(&newer, &rdir, true, flag(false), |_, _| {}).await.unwrap();
    assert_eq!(read_remote(remote.clone()).await.len(), 3_000_000);
    let mode = sftp.list(&rdir).await.unwrap().into_iter().find(|e| e.name == "keep.txt").unwrap().permissions.unwrap();
    assert_eq!(mode & 0o777, 0o750, "permissions kept");
    assert!(leftovers().await.is_empty());

    // 4. Servers without posix-rename: swap through a backup.
    let third = put("third.txt", b"THIRD");
    let staged = sftp.upload(&third, &rdir, false, flag(false), |_, _| {}).await.unwrap();
    sftp.test_move_into_place(&staged, &remote, true, false).await.unwrap();
    assert_eq!(read_remote(remote.clone()).await, b"THIRD");
    assert!(leftovers().await.is_empty(), "backup left behind: {:?}", leftovers().await);

    // 5. A cancelled download leaves the existing local file alone.
    let target = local.path().join("existing.txt");
    std::fs::write(&target, b"LOCAL").unwrap();
    let e = sftp.download(&remote, &target, flag(true), |_, _| {}).await.unwrap_err();
    assert!(matches!(e, CoreError::Cancelled { .. }));
    assert_eq!(std::fs::read(&target).unwrap(), b"LOCAL");
    assert!(!std::fs::read_dir(local.path()).unwrap().any(|e| e
        .unwrap()
        .file_name()
        .to_string_lossy()
        .contains("siakap-part")));

    sftp.remove(&remote, false).await.unwrap();
    sftp.remove(&rdir, true).await.unwrap();
}

async fn sftp_set_mode(
    sftp: &Sftp,
    path: &str,
    attrs: russh_sftp::protocol::FileAttributes,
) -> siakap_core::Result<()> {
    sftp.set_metadata(path, attrs).await
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

async fn banner(mut s: tokio::net::TcpStream) -> String {
    use tokio::io::AsyncReadExt;
    let mut b = [0u8; 64];
    let n = tokio::time::timeout(Duration::from_secs(10), s.read(&mut b)).await.unwrap().unwrap();
    String::from_utf8_lossy(&b[..n]).to_string()
}

#[tokio::test(flavor = "multi_thread")]
async fn live_jump_host_and_port_forwards() {
    use siakap_core::model::{Forward, ForwardKind};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let Some(t) = target() else {
        eprintln!("SIAKAP_TEST_SSH not set; skipping");
        return;
    };
    let known = trusted(&t).await;

    // Through a jump host (the same server, reached through itself).
    let mut p = params(&t, known.clone(), Some(&t.pass));
    p.jump = Some(Box::new(params(&t, known.clone(), Some(&t.pass))));
    let conn = SshConnection::connect(p).await.expect("connect through jump host");
    let sftp = Sftp::new(conn.open_sftp().await.unwrap());
    assert!(sftp.home().await.unwrap().starts_with('/'));

    // A failing jump host says which hop failed.
    let mut p = params(&t, known.clone(), Some(&t.pass));
    p.jump = Some(Box::new(params(&t, known.clone(), Some("wrong"))));
    match SshConnection::connect(p).await {
        Err(CoreError::Auth { message }) => assert!(message.starts_with("Jump host"), "{message}"),
        Err(e) => panic!("{e:?}"),
        Ok(_) => panic!("connected with a wrong jump password"),
    }
    // Unknown jump host key still asks first.
    let mut p = params(&t, known.clone(), Some(&t.pass));
    p.jump = Some(Box::new(params(&t, vec![], Some(&t.pass))));
    assert!(matches!(SshConnection::connect(p).await, Err(CoreError::HostKeyUnknown { .. })));
    // A chain longer than allowed is refused before connecting.
    let mut p = params(&t, known.clone(), Some(&t.pass));
    for _ in 0..6 {
        let mut outer = params(&t, known.clone(), Some(&t.pass));
        outer.jump = Some(Box::new(p));
        p = outer;
    }
    assert!(matches!(SshConnection::connect(p).await, Err(CoreError::Invalid { .. })));

    // Echo server on this side for the -R test.
    let echo = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let echo_port = echo.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut s, _)) = echo.accept().await {
            tokio::spawn(async move {
                let mut b = [0u8; 256];
                while let Ok(n) = s.read(&mut b).await {
                    if n == 0 || s.write_all(&b[..n]).await.is_err() {
                        break;
                    }
                }
            });
        }
    });
    let (l, d, r, l2, busy) = (free_port(), free_port(), free_port(), free_port(), free_port());
    let _hold = std::net::TcpListener::bind(("127.0.0.1", busy)).unwrap();
    let fwd = |kind, bind_port, dest_host: &str, dest_port| Forward {
        kind,
        bind_port,
        dest_host: dest_host.into(),
        dest_port,
        ..Default::default()
    };
    let list = vec![
        fwd(ForwardKind::Local, l, "127.0.0.1", t.port),
        fwd(ForwardKind::Dynamic, d, "", 0),
        fwd(ForwardKind::Remote, r, "127.0.0.1", echo_port),
        fwd(ForwardKind::Local, l2, "127.0.0.1", r),
        fwd(ForwardKind::Local, busy, "127.0.0.1", 1),
        Forward { enabled: false, ..fwd(ForwardKind::Local, free_port(), "127.0.0.1", 1) },
    ];
    let (fw, status) = siakap_core::forward::start(&conn, &list).await;
    assert_eq!(status.len(), 5, "disabled forwards are not started");
    assert!(status[..4].iter().all(|s| s.ok), "{status:?}");
    assert!(!status[4].ok && status[4].error.as_deref().unwrap().contains("already in use"));

    // -L reaches the SSH port from the server side.
    let s = tokio::net::TcpStream::connect(("127.0.0.1", l)).await.unwrap();
    assert!(banner(s).await.starts_with("SSH-2.0"));
    // -D: SOCKS5 with a host name.
    let mut s = tokio::net::TcpStream::connect(("127.0.0.1", d)).await.unwrap();
    s.write_all(&[5, 1, 0]).await.unwrap();
    let mut b = [0u8; 2];
    s.read_exact(&mut b).await.unwrap();
    assert_eq!(b, [5, 0]);
    let mut req = vec![5, 1, 0, 3, 9];
    req.extend(b"localhost");
    req.extend(t.port.to_be_bytes());
    s.write_all(&req).await.unwrap();
    let mut rep = [0u8; 10];
    s.read_exact(&mut rep).await.unwrap();
    assert_eq!(rep[1], 0, "SOCKS reply {rep:?}");
    assert!(banner(s).await.starts_with("SSH-2.0"));
    // -R: server port r → our echo server (reached via -L l2 → r).
    let mut s = tokio::net::TcpStream::connect(("127.0.0.1", l2)).await.unwrap();
    s.write_all(b"ping-42").await.unwrap();
    let mut b = [0u8; 7];
    tokio::time::timeout(Duration::from_secs(10), s.read_exact(&mut b)).await.unwrap().unwrap();
    assert_eq!(&b, b"ping-42");

    // Dropping the forwarder closes the local ports.
    drop(fw);
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(tokio::net::TcpStream::connect(("127.0.0.1", l)).await.is_err());
    conn.disconnect().await;
}
