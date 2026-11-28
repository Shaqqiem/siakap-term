//! Port forwarding over an SSH connection: local (-L), remote (-R) and
//! dynamic SOCKS5 (-D). Every forward stops when its [`Forwarder`] is dropped
//! (the terminal tab closes).

use std::net::SocketAddr;
use std::sync::Arc;

use serde::Serialize;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;

use crate::error::{CoreError, Result};
use crate::model::{Forward, ForwardKind};
use crate::ssh::SshConnection;

/// How one forward started.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardStatus {
    pub text: String,
    pub ok: bool,
    pub error: Option<String>,
    /// Reachable from other machines (not only 127.0.0.1).
    pub public: bool,
}

/// Running forwards; dropping it stops them all.
#[derive(Default)]
pub struct Forwarder {
    tasks: Vec<JoinHandle<()>>,
    remote_ports: Vec<u32>,
    conn: Option<Arc<SshConnection>>,
}

impl Drop for Forwarder {
    fn drop(&mut self) {
        for t in &self.tasks {
            t.abort();
        }
        if let Some(c) = &self.conn {
            if let Ok(mut m) = c.remote.lock() {
                for p in &self.remote_ports {
                    m.remove(p);
                }
            }
        }
    }
}

/// Start every enabled forward. Failures (port in use, server refused) are
/// reported per forward and don't stop the others or the shell.
pub async fn start(conn: &Arc<SshConnection>, list: &[Forward]) -> (Forwarder, Vec<ForwardStatus>) {
    let mut fw = Forwarder { tasks: Vec::new(), remote_ports: Vec::new(), conn: Some(conn.clone()) };
    let mut status = Vec::new();
    for f in list.iter().filter(|f| f.enabled) {
        let r = match f.clone().validated() {
            Ok(f) => start_one(conn, &f, &mut fw).await,
            Err(e) => Err(e),
        };
        status.push(ForwardStatus {
            text: f.describe(),
            ok: r.is_ok(),
            error: r.err().map(|e| e.to_string()),
            public: f.is_public(),
        });
    }
    (fw, status)
}

async fn start_one(conn: &Arc<SshConnection>, f: &Forward, fw: &mut Forwarder) -> Result<()> {
    match f.kind {
        ForwardKind::Local | ForwardKind::Dynamic => {
            let listener = bind(&f.bind_host, f.bind_port).await?;
            let conn = conn.clone();
            let f = f.clone();
            fw.tasks.push(tokio::spawn(async move {
                while let Ok((tcp, peer)) = listener.accept().await {
                    let conn = conn.clone();
                    let f = f.clone();
                    tokio::spawn(async move {
                        let _ = tcp.set_nodelay(true);
                        let _ = if f.kind == ForwardKind::Dynamic {
                            socks_session(&conn, tcp, peer).await
                        } else {
                            relay(&conn, tcp, peer, &f.dest_host, f.dest_port).await
                        };
                    });
                }
            }));
            Ok(())
        }
        ForwardKind::Remote => {
            let port = u32::from(f.bind_port);
            if let Ok(mut m) = conn.remote.lock() {
                m.insert(port, (f.dest_host.clone(), f.dest_port));
            }
            match conn.handle.tcpip_forward(f.bind_host.clone(), port).await {
                Ok(_) => {
                    fw.remote_ports.push(port);
                    Ok(())
                }
                Err(e) => {
                    if let Ok(mut m) = conn.remote.lock() {
                        m.remove(&port);
                    }
                    Err(CoreError::ssh(format!("The server refused to listen on {}:{}: {e}", f.bind_host, f.bind_port)))
                }
            }
        }
    }
}

async fn bind(host: &str, port: u16) -> Result<TcpListener> {
    let h = host.trim_start_matches('[').trim_end_matches(']');
    TcpListener::bind((h, port)).await.map_err(|e| {
        if e.kind() == std::io::ErrorKind::AddrInUse {
            CoreError::invalid(format!("Port {port} on {host} is already in use."))
        } else {
            CoreError::invalid(format!("Could not listen on {host}:{port}: {e}"))
        }
    })
}

async fn relay(conn: &SshConnection, mut tcp: TcpStream, peer: SocketAddr, host: &str, port: u16) -> Result<()> {
    let ch = conn
        .handle
        .channel_open_direct_tcpip(host.to_string(), u32::from(port), peer.ip().to_string(), u32::from(peer.port()))
        .await?;
    let mut stream = ch.into_stream();
    let _ = tokio::io::copy_bidirectional(&mut tcp, &mut stream).await;
    Ok(())
}

/// One SOCKS5 client: handshake, then the server opens the connection.
async fn socks_session(conn: &SshConnection, mut tcp: TcpStream, peer: SocketAddr) -> Result<()> {
    let (host, port) = socks5_handshake(&mut tcp).await?;
    match conn
        .handle
        .channel_open_direct_tcpip(host, u32::from(port), peer.ip().to_string(), u32::from(peer.port()))
        .await
    {
        Ok(ch) => {
            tcp.write_all(&SOCKS_OK).await?;
            let mut stream = ch.into_stream();
            let _ = tokio::io::copy_bidirectional(&mut tcp, &mut stream).await;
        }
        Err(_) => {
            // 0x05: connection refused.
            let _ = tcp.write_all(&[5, 5, 0, 1, 0, 0, 0, 0, 0, 0]).await;
        }
    }
    Ok(())
}

const SOCKS_OK: [u8; 10] = [5, 0, 0, 1, 0, 0, 0, 0, 0, 0];

/// SOCKS5 (RFC 1928), no authentication, CONNECT only. Returns where the
/// client wants to go. Names are passed on as names, so DNS is resolved by the
/// server, not on this computer. Errors are answered before returning.
pub async fn socks5_handshake<S: AsyncRead + AsyncWrite + Unpin>(s: &mut S) -> Result<(String, u16)> {
    let bad = || CoreError::invalid("not a SOCKS5 request");
    let mut hdr = [0u8; 2];
    s.read_exact(&mut hdr).await?;
    if hdr[0] != 5 || hdr[1] == 0 {
        return Err(bad());
    }
    let mut methods = vec![0u8; usize::from(hdr[1])];
    s.read_exact(&mut methods).await?;
    if !methods.contains(&0) {
        s.write_all(&[5, 0xff]).await?;
        return Err(CoreError::invalid("SOCKS client wants authentication"));
    }
    s.write_all(&[5, 0]).await?;
    let mut req = [0u8; 4];
    s.read_exact(&mut req).await?;
    if req[0] != 5 {
        return Err(bad());
    }
    let host = match req[3] {
        1 => {
            let mut a = [0u8; 4];
            s.read_exact(&mut a).await?;
            std::net::Ipv4Addr::from(a).to_string()
        }
        3 => {
            let mut n = [0u8; 1];
            s.read_exact(&mut n).await?;
            let mut name = vec![0u8; usize::from(n[0])];
            s.read_exact(&mut name).await?;
            let name = String::from_utf8(name).map_err(|_| bad())?;
            if name.is_empty() || name.chars().any(|c| c.is_control() || c.is_whitespace()) {
                s.write_all(&[5, 1, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
                return Err(bad());
            }
            name
        }
        4 => {
            let mut a = [0u8; 16];
            s.read_exact(&mut a).await?;
            std::net::Ipv6Addr::from(a).to_string()
        }
        _ => {
            // 0x08: address type not supported.
            s.write_all(&[5, 8, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
            return Err(bad());
        }
    };
    let mut p = [0u8; 2];
    s.read_exact(&mut p).await?;
    if req[1] != 1 {
        // 0x07: command not supported (BIND, UDP ASSOCIATE).
        s.write_all(&[5, 7, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
        return Err(CoreError::invalid("only SOCKS CONNECT is supported"));
    }
    Ok((host, u16::from_be_bytes(p)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::duplex;

    async fn run(client_bytes: Vec<u8>) -> (Result<(String, u16)>, Vec<u8>) {
        let (mut a, mut b) = duplex(1024);
        let srv = tokio::spawn(async move { socks5_handshake(&mut b).await });
        a.write_all(&client_bytes).await.unwrap();
        let r = srv.await.unwrap();
        drop(a.shutdown().await);
        let mut out = Vec::new();
        let _ = tokio::time::timeout(std::time::Duration::from_millis(200), a.read_to_end(&mut out)).await;
        (r, out)
    }

    #[tokio::test]
    async fn socks5_domain_ipv4_ipv6() {
        let mut m = vec![5, 1, 0, 5, 1, 0, 3, 11];
        m.extend(b"example.com");
        m.extend([0x01, 0xbb]);
        let (r, out) = run(m).await;
        assert_eq!(r.unwrap(), ("example.com".into(), 443));
        assert_eq!(out, [5, 0]);

        let (r, _) = run(vec![5, 2, 2, 0, 5, 1, 0, 1, 10, 0, 0, 7, 0, 22]).await;
        assert_eq!(r.unwrap(), ("10.0.0.7".into(), 22));

        let mut m = vec![5, 1, 0, 5, 1, 0, 4];
        m.extend(std::net::Ipv6Addr::LOCALHOST.octets());
        m.extend([0, 80]);
        assert_eq!(run(m).await.0.unwrap(), ("::1".into(), 80));
    }

    #[tokio::test]
    async fn socks5_refuses_what_it_does_not_support() {
        // Wants username/password only.
        let (r, out) = run(vec![5, 1, 2]).await;
        assert!(r.is_err());
        assert_eq!(out, [5, 0xff]);
        // SOCKS4.
        assert!(run(vec![4, 1, 0, 80, 1, 2, 3, 4, 0]).await.0.is_err());
        // BIND command.
        let (r, out) = run(vec![5, 1, 0, 5, 2, 0, 1, 1, 2, 3, 4, 0, 80]).await;
        assert!(r.is_err());
        assert_eq!(out[2..4], [5, 7]);
        // Control characters in a name.
        let (r, _) = run(vec![5, 1, 0, 5, 1, 0, 3, 3, b'a', b'\n', b'b', 0, 80]).await;
        assert!(r.is_err());
    }

    #[test]
    fn forwards_are_validated() {
        let ok = Forward { bind_port: 8080, dest_host: "db.internal".into(), dest_port: 5432, ..Default::default() };
        let v = ok.clone().validated().unwrap();
        assert_eq!(v.bind_host, "127.0.0.1");
        assert!(!v.is_public());
        assert_eq!(v.describe(), "-L 127.0.0.1:8080 → db.internal:5432");
        assert!(Forward { bind_port: 0, ..ok.clone() }.validated().is_err());
        assert!(Forward { dest_port: 0, ..ok.clone() }.validated().is_err());
        assert!(Forward { dest_host: "a b".into(), ..ok.clone() }.validated().is_err());
        assert!(Forward { dest_host: "x;rm".into(), ..ok.clone() }.validated().is_err());
        assert!(Forward { bind_host: "0.0.0.0".into(), ..ok.clone() }.validated().unwrap().is_public());
        let d = Forward { kind: ForwardKind::Dynamic, bind_port: 1080, ..Default::default() }.validated().unwrap();
        assert_eq!(d.describe(), "-D SOCKS 127.0.0.1:1080");
    }
}
