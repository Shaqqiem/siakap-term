//! SFTP over an existing SSH connection, with chunked, cancellable transfers.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use russh_sftp::client::SftpSession;
use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::error::{CoreError, Result};

pub const CHUNK: usize = 256 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    pub mtime: Option<u32>,
    pub permissions: Option<u32>,
}

pub struct Sftp {
    s: SftpSession,
}

/// Join a remote POSIX directory and a single file name.
pub fn join(dir: &str, name: &str) -> Result<String> {
    validate_name(name)?;
    if dir.ends_with('/') {
        Ok(format!("{dir}{name}"))
    } else {
        Ok(format!("{dir}/{name}"))
    }
}

/// Parent of a remote POSIX path (`/` stays `/`).
pub fn parent(path: &str) -> String {
    let t = path.trim_end_matches('/');
    match t.rfind('/') {
        Some(0) | None => "/".into(),
        Some(i) => t[..i].into(),
    }
}

pub fn validate_name(name: &str) -> Result<()> {
    if name.is_empty() || name == "." || name == ".." || name.contains('/') || name.chars().any(char::is_control) {
        return Err(CoreError::invalid(format!("Invalid file name {name:?}.")));
    }
    Ok(())
}

pub fn validate_path(p: &str) -> Result<()> {
    if p.is_empty() || p.chars().any(char::is_control) {
        return Err(CoreError::invalid("Invalid remote path."));
    }
    Ok(())
}

impl Sftp {
    pub fn new(s: SftpSession) -> Self {
        Self { s }
    }

    pub async fn home(&self) -> Result<String> {
        Ok(self.s.canonicalize(".").await?)
    }

    pub async fn list(&self, path: &str) -> Result<Vec<Entry>> {
        validate_path(path)?;
        let dir = self.s.canonicalize(path).await?;
        let mut out = Vec::new();
        for e in self.s.read_dir(dir.clone()).await? {
            let name = e.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let md = e.metadata();
            let ft = e.file_type();
            let mut is_dir = ft.is_dir();
            if ft.is_symlink() {
                if let Ok(m) = self.s.metadata(join(&dir, &name).unwrap_or_default()).await {
                    is_dir = m.is_dir();
                }
            }
            out.push(Entry {
                path: if dir.ends_with('/') { format!("{dir}{name}") } else { format!("{dir}/{name}") },
                name,
                is_dir,
                is_symlink: ft.is_symlink(),
                size: md.size.unwrap_or(0),
                mtime: md.mtime,
                permissions: md.permissions,
            });
        }
        out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
        Ok(out)
    }

    pub async fn canonicalize(&self, path: &str) -> Result<String> {
        validate_path(path)?;
        Ok(self.s.canonicalize(path).await?)
    }

    pub async fn mkdir(&self, dir: &str, name: &str) -> Result<()> {
        self.s.create_dir(join(dir, name)?).await?;
        Ok(())
    }

    pub async fn rename(&self, path: &str, new_name: &str) -> Result<()> {
        validate_path(path)?;
        let target = join(&parent(path), new_name)?;
        self.s.rename(path, target).await?;
        Ok(())
    }

    /// Delete a file, or an *empty* directory.
    pub async fn remove(&self, path: &str, is_dir: bool) -> Result<()> {
        validate_path(path)?;
        if path.trim_end_matches('/').is_empty() {
            return Err(CoreError::invalid("Refusing to delete /."));
        }
        if is_dir {
            self.s
                .remove_dir(path)
                .await
                .map_err(|e| CoreError::sftp(format!("Could not delete folder (is it empty?): {e}")))?;
        } else {
            self.s.remove_file(path).await?;
        }
        Ok(())
    }

    /// Stream a remote file to a local path. `progress(done, total)`.
    pub async fn download(
        &self,
        remote: &str,
        local: &Path,
        cancel: Arc<AtomicBool>,
        progress: impl Fn(u64, u64),
    ) -> Result<u64> {
        validate_path(remote)?;
        let total = self.s.metadata(remote).await?.size.unwrap_or(0);
        let mut rf = self.s.open(remote).await?;
        let part = local.with_extension(format!(
            "{}siakap-part",
            local.extension().map(|e| format!("{}.", e.to_string_lossy())).unwrap_or_default()
        ));
        let mut lf = tokio::fs::File::create(&part).await?;
        let res: Result<u64> = async {
            let mut buf = vec![0u8; CHUNK];
            let mut done = 0u64;
            loop {
                if cancel.load(Ordering::Relaxed) {
                    return Err(CoreError::cancelled());
                }
                let n = rf.read(&mut buf).await?;
                if n == 0 {
                    break;
                }
                lf.write_all(&buf[..n]).await?;
                done += n as u64;
                progress(done, total.max(done));
            }
            lf.flush().await?;
            lf.sync_all().await?;
            Ok(done)
        }
        .await;
        drop(lf);
        match res {
            Ok(n) => {
                tokio::fs::rename(&part, local).await?;
                Ok(n)
            }
            Err(e) => {
                let _ = tokio::fs::remove_file(&part).await;
                Err(e)
            }
        }
    }

    /// Stream a local file into `remote_dir`. Returns the remote path.
    pub async fn upload(
        &self,
        local: &Path,
        remote_dir: &str,
        cancel: Arc<AtomicBool>,
        progress: impl Fn(u64, u64),
    ) -> Result<String> {
        let name = local
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| CoreError::invalid("The local file name is not valid UTF-8."))?;
        let meta = tokio::fs::metadata(local).await?;
        if !meta.is_file() {
            return Err(CoreError::invalid("Only regular files can be uploaded."));
        }
        let total = meta.len();
        let remote = join(remote_dir, name)?;
        let mut lf = tokio::fs::File::open(local).await?;
        let mut rf = self.s.create(remote.clone()).await?;
        let mut buf = vec![0u8; CHUNK];
        let mut done = 0u64;
        let res: Result<()> = async {
            loop {
                if cancel.load(Ordering::Relaxed) {
                    return Err(CoreError::cancelled());
                }
                let n = lf.read(&mut buf).await?;
                if n == 0 {
                    break;
                }
                rf.write_all(&buf[..n]).await?;
                done += n as u64;
                progress(done, total.max(done));
            }
            rf.flush().await?;
            rf.shutdown().await?;
            Ok(())
        }
        .await;
        if let Err(e) = res {
            drop(rf);
            let _ = self.s.remove_file(remote.clone()).await;
            return Err(e);
        }
        Ok(remote)
    }

    pub async fn close(&self) {
        let _ = self.s.close().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths() {
        assert_eq!(join("/home/u", "a.txt").unwrap(), "/home/u/a.txt");
        assert_eq!(join("/", "etc").unwrap(), "/etc");
        assert!(join("/x", "../y").is_err());
        assert!(join("/x", "a/b").is_err());
        assert!(join("/x", "..").is_err());
        assert_eq!(parent("/home/u/a"), "/home/u");
        assert_eq!(parent("/home"), "/");
        assert_eq!(parent("/"), "/");
        assert_eq!(parent("/home/u/"), "/home");
    }
}
