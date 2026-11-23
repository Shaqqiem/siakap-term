//! SFTP over an existing SSH connection, with chunked, cancellable transfers.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use russh_sftp::client::SftpSession;
use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::error::{CoreError, Result};
use crate::model::new_id;
use russh_sftp::protocol::OpenFlags;

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
    ///
    /// Data goes to a new, unpredictably named temporary file in the target
    /// folder (created exclusively, so two transfers can never share it) and
    /// is renamed over `local` only after the whole file arrived. A failed or
    /// cancelled download leaves `local` untouched.
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
        let dir = local.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
        let name = local.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "download".into());
        let part = dir.join(format!(".{name}.{}.siakap-part", new_id()));
        let mut lf = tokio::fs::OpenOptions::new().write(true).create_new(true).open(&part).await?;
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
                if let Err(e) = tokio::fs::rename(&part, local).await {
                    let _ = tokio::fs::remove_file(&part).await;
                    return Err(e.into());
                }
                Ok(n)
            }
            Err(e) => {
                let _ = tokio::fs::remove_file(&part).await;
                Err(e)
            }
        }
    }

    /// Stream a local file into `remote_dir`. Returns the remote path.
    ///
    /// The existing remote file is never opened or truncated. Data goes to a
    /// new temporary file next to it (created exclusively); only when the
    /// upload has completed is it moved into place. If the destination exists
    /// and `overwrite` is false, `RemoteExists` is returned before anything is
    /// written. A failed or cancelled upload removes only its own temp file.
    pub async fn upload(
        &self,
        local: &Path,
        remote_dir: &str,
        overwrite: bool,
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

        let existing = self.s.metadata(remote.clone()).await.ok();
        if let Some(m) = &existing {
            if m.is_dir() {
                return Err(CoreError::invalid(format!("{remote} is a folder on the server.")));
            }
            if !overwrite {
                return Err(CoreError::RemoteExists {
                    message: format!("{name} already exists in {remote_dir}."),
                    path: remote,
                });
            }
        }

        let tmp = join(remote_dir, &format!(".{name}.{}.siakap-upload", new_id()))?;
        let mut rf =
            self.s.open_with_flags(tmp.clone(), OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE).await?;
        let mut lf = tokio::fs::File::open(local).await?;
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
        drop(rf);
        if let Err(e) = res {
            let _ = self.s.remove_file(tmp.clone()).await;
            return Err(e);
        }
        // Keep the permissions of the file being replaced (e.g. an executable script).
        if let Some(perm) = existing.as_ref().and_then(|m| m.permissions) {
            let mut attrs = russh_sftp::protocol::FileAttributes::empty();
            attrs.permissions = Some(perm & 0o7777);
            let _ = self.s.set_metadata(tmp.clone(), attrs).await;
        }
        match self.move_into_place(&tmp, &remote, existing.is_some(), true).await {
            Ok(()) => Ok(remote),
            Err(e) => {
                let _ = self.s.remove_file(tmp).await;
                Err(e)
            }
        }
    }

    /// Move a finished temp file onto `dest`.
    ///
    /// * New file: plain SFTP rename, which fails rather than replacing if
    ///   something appeared at `dest` meanwhile.
    /// * Replacing: atomic `posix-rename@openssh.com` when the server has it;
    ///   otherwise the old file is renamed aside, the new one moved in, and the
    ///   old one put back if that fails.
    async fn move_into_place(&self, tmp: &str, dest: &str, replacing: bool, allow_posix: bool) -> Result<()> {
        if !replacing {
            self.s.rename(tmp, dest).await.map_err(|e| CoreError::sftp(format!("Could not finish the upload: {e}")))?;
            return Ok(());
        }
        if allow_posix
            && self
                .s
                .posix_rename(tmp, dest)
                .await
                .map_err(|e| CoreError::sftp(format!("Could not replace {dest}: {e}")))?
        {
            return Ok(());
        }
        let dir = parent(dest);
        let base = dest.rsplit('/').next().unwrap_or("file");
        let backup = join(&dir, &format!(".{base}.{}.siakap-old", new_id()))?;
        self.s
            .rename(dest, backup.clone())
            .await
            .map_err(|e| CoreError::sftp(format!("Could not replace {dest}: {e}")))?;
        if let Err(e) = self.s.rename(tmp, dest).await {
            // Put the original back.
            let _ = self.s.rename(backup.clone(), dest).await;
            return Err(CoreError::sftp(format!("Could not replace {dest}; the original was kept: {e}")));
        }
        let _ = self.s.remove_file(backup).await;
        Ok(())
    }

    /// Change attributes such as permissions.
    pub async fn set_metadata(&self, path: &str, attrs: russh_sftp::protocol::FileAttributes) -> Result<()> {
        validate_path(path)?;
        self.s.set_metadata(path, attrs).await?;
        Ok(())
    }

    #[doc(hidden)]
    pub async fn test_move_into_place(&self, tmp: &str, dest: &str, replacing: bool, allow_posix: bool) -> Result<()> {
        self.move_into_place(tmp, dest, replacing, allow_posix).await
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
