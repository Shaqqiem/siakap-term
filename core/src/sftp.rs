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

    /// Walk a remote folder (symlinks are listed, never followed).
    /// Returns every entry below `root`, parents before children.
    async fn walk_remote(&self, root: &str, cancel: &AtomicBool) -> Result<Vec<TreeItem>> {
        let mut out = Vec::new();
        let mut stack = vec![(root.to_string(), String::new(), 0usize)];
        while let Some((dir, rel, depth)) = stack.pop() {
            if depth > MAX_DEPTH {
                return Err(CoreError::invalid(format!("{dir} is nested more than {MAX_DEPTH} folders deep.")));
            }
            for e in self.s.read_dir(dir.clone()).await? {
                if cancel.load(Ordering::Relaxed) {
                    return Err(CoreError::cancelled());
                }
                let name = e.file_name();
                if name == "." || name == ".." {
                    continue;
                }
                validate_name(&name)?;
                let path = join(&dir, &name)?;
                let rel_path = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
                let ft = e.file_type();
                let kind = if ft.is_symlink() {
                    TreeKind::Other
                } else if ft.is_dir() {
                    TreeKind::Dir
                } else if ft.is_file() {
                    TreeKind::File
                } else {
                    TreeKind::Other
                };
                if kind == TreeKind::Dir {
                    stack.push((path.clone(), rel_path.clone(), depth + 1));
                }
                out.push(TreeItem { path, rel: rel_path, kind, size: e.metadata().size.unwrap_or(0) });
                if out.len() > MAX_ENTRIES {
                    return Err(CoreError::invalid(format!("{root} holds more than {MAX_ENTRIES} items.")));
                }
            }
        }
        Ok(out)
    }

    /// Delete a folder and everything in it. Symlinks inside are removed as
    /// links; what they point to is never touched. `progress(done, total)`
    /// counts items.
    pub async fn remove_tree(&self, path: &str, cancel: Arc<AtomicBool>, progress: impl Fn(u64, u64)) -> Result<u64> {
        validate_path(path)?;
        let root = self.s.canonicalize(path).await?;
        if root.trim_end_matches('/').is_empty() {
            return Err(CoreError::invalid("Refusing to delete /."));
        }
        if self.s.symlink_metadata(root.clone()).await?.is_symlink() {
            // Delete the link itself, not the folder it points to.
            self.s.remove_file(root).await?;
            return Ok(1);
        }
        let items = self.walk_remote(&root, &cancel).await?;
        let total = items.len() as u64 + 1;
        let mut done = 0u64;
        // Children come after their parents, so delete in reverse.
        for it in items.iter().rev() {
            if cancel.load(Ordering::Relaxed) {
                return Err(CoreError::cancelled());
            }
            let r = if it.kind == TreeKind::Dir {
                self.s.remove_dir(it.path.clone()).await
            } else {
                self.s.remove_file(it.path.clone()).await
            };
            r.map_err(|e| CoreError::sftp(format!("Could not delete {}: {e}", it.path)))?;
            done += 1;
            progress(done, total);
        }
        self.s.remove_dir(root.clone()).await.map_err(|e| CoreError::sftp(format!("Could not delete {root}: {e}")))?;
        progress(total, total);
        Ok(total)
    }

    /// Download a remote folder into a new folder `local_parent/<name>`.
    /// Fails if that local folder already exists. Symlinks and special files
    /// are skipped, as are names this computer cannot store safely.
    pub async fn download_tree(
        &self,
        remote: &str,
        local_parent: &Path,
        cancel: Arc<AtomicBool>,
        progress: impl Fn(TreeProgress),
    ) -> Result<TreeSummary> {
        validate_path(remote)?;
        let root = self.s.canonicalize(remote).await?;
        let base =
            root.trim_end_matches('/').rsplit('/').next().filter(|b| !b.is_empty()).unwrap_or("root").to_string();
        if !local_name_ok(&base) {
            return Err(CoreError::invalid(format!("{base:?} can't be used as a folder name on this computer.")));
        }
        let items = self.walk_remote(&root, &cancel).await?;
        let total: u64 = items.iter().filter(|i| i.kind == TreeKind::File).map(|i| i.size).sum();
        let total_files = items.iter().filter(|i| i.kind == TreeKind::File).count() as u64;
        let dest = local_parent.join(&base);
        tokio::fs::create_dir(&dest).await.map_err(|e| {
            if e.kind() == std::io::ErrorKind::AlreadyExists {
                CoreError::invalid(format!(
                    "{} already exists. Pick another folder or remove it first.",
                    dest.display()
                ))
            } else {
                e.into()
            }
        })?;
        let mut sum = TreeSummary { files: 0, bytes: 0, skipped: Vec::new(), path: dest.to_string_lossy().to_string() };
        let mut skipped_dirs: Vec<String> = Vec::new();
        for it in &items {
            if cancel.load(Ordering::Relaxed) {
                return Err(CoreError::cancelled());
            }
            if skipped_dirs.iter().any(|d| it.rel.starts_with(&format!("{d}/"))) {
                continue;
            }
            if it.kind == TreeKind::Other || !it.rel.split('/').all(local_name_ok) {
                if it.kind == TreeKind::Dir {
                    skipped_dirs.push(it.rel.clone());
                }
                sum.skipped.push(it.rel.clone());
                continue;
            }
            let local = it.rel.split('/').fold(dest.clone(), |p, part| p.join(part));
            match it.kind {
                TreeKind::Dir => tokio::fs::create_dir(&local).await?,
                TreeKind::File => {
                    let before = sum.bytes;
                    let n = self
                        .download(&it.path, &local, cancel.clone(), |d, _| {
                            progress(TreeProgress {
                                done: before + d,
                                total,
                                files: sum.files,
                                total_files,
                                name: it.rel.clone(),
                            })
                        })
                        .await?;
                    sum.bytes += n;
                    sum.files += 1;
                    progress(TreeProgress {
                        done: sum.bytes,
                        total: total.max(sum.bytes),
                        files: sum.files,
                        total_files,
                        name: it.rel.clone(),
                    });
                }
                TreeKind::Other => {}
            }
        }
        Ok(sum)
    }

    /// Upload a local folder into `remote_dir/<name>`. If that remote folder
    /// exists, `RemoteExists` is returned unless `merge` is true, in which case
    /// files with the same name are replaced (each only once it fully arrived).
    /// Local symlinks and special files are skipped, never followed.
    pub async fn upload_tree(
        &self,
        local: &Path,
        remote_dir: &str,
        merge: bool,
        cancel: Arc<AtomicBool>,
        progress: impl Fn(TreeProgress),
    ) -> Result<TreeSummary> {
        let name = local
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| CoreError::invalid("The local folder name is not valid UTF-8."))?
            .to_string();
        if !tokio::fs::symlink_metadata(local).await?.is_dir() {
            return Err(CoreError::invalid("Only folders can be uploaded this way."));
        }
        let remote_root = join(remote_dir, &name)?;
        let items = walk_local(local, &cancel).await?;
        let total: u64 = items.iter().filter(|i| i.kind == TreeKind::File).map(|i| i.size).sum();
        let total_files = items.iter().filter(|i| i.kind == TreeKind::File).count() as u64;

        match self.s.symlink_metadata(remote_root.clone()).await {
            Ok(m) if m.is_dir() && !m.is_symlink() => {
                if !merge {
                    return Err(CoreError::RemoteExists {
                        message: format!("A folder named {name} already exists in {remote_dir}."),
                        path: remote_root,
                    });
                }
            }
            Ok(_) => {
                return Err(CoreError::invalid(format!("{remote_root} exists on the server and is not a folder.")))
            }
            Err(_) => self.s.create_dir(remote_root.clone()).await?,
        }
        let mut sum = TreeSummary { files: 0, bytes: 0, skipped: Vec::new(), path: remote_root.clone() };
        let mut skipped_dirs: Vec<String> = Vec::new();
        for it in &items {
            if cancel.load(Ordering::Relaxed) {
                return Err(CoreError::cancelled());
            }
            if skipped_dirs.iter().any(|d| it.rel.starts_with(&format!("{d}/"))) {
                continue;
            }
            let parts: Vec<&str> = it.rel.split('/').collect();
            if it.kind == TreeKind::Other || parts.iter().any(|p| validate_name(p).is_err()) {
                if it.kind == TreeKind::Dir {
                    skipped_dirs.push(it.rel.clone());
                }
                sum.skipped.push(it.rel.clone());
                continue;
            }
            let (parent_rel, leaf) = match it.rel.rfind('/') {
                Some(i) => (&it.rel[..i], &it.rel[i + 1..]),
                None => ("", it.rel.as_str()),
            };
            let rdir = if parent_rel.is_empty() { remote_root.clone() } else { format!("{remote_root}/{parent_rel}") };
            match it.kind {
                TreeKind::Dir => {
                    let p = join(&rdir, leaf)?;
                    match self.s.symlink_metadata(p.clone()).await {
                        Ok(m) if m.is_dir() && !m.is_symlink() => {}
                        Ok(_) => {
                            sum.skipped.push(it.rel.clone());
                            skipped_dirs.push(it.rel.clone());
                        }
                        Err(_) => self.s.create_dir(p).await?,
                    }
                }
                TreeKind::File => {
                    let before = sum.bytes;
                    let r = self
                        .upload(&it.local, &rdir, merge, cancel.clone(), |d, _| {
                            progress(TreeProgress {
                                done: before + d,
                                total,
                                files: sum.files,
                                total_files,
                                name: it.rel.clone(),
                            })
                        })
                        .await;
                    match r {
                        Ok(_) => {
                            sum.bytes += it.size;
                            sum.files += 1;
                        }
                        // A folder on the server with this file's name.
                        Err(CoreError::Invalid { .. }) => sum.skipped.push(it.rel.clone()),
                        Err(e) => return Err(e),
                    }
                    progress(TreeProgress {
                        done: sum.bytes,
                        total: total.max(sum.bytes),
                        files: sum.files,
                        total_files,
                        name: it.rel.clone(),
                    });
                }
                TreeKind::Other => {}
            }
        }
        Ok(sum)
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

pub const MAX_DEPTH: usize = 64;
pub const MAX_ENTRIES: usize = 200_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TreeKind {
    Dir,
    File,
    Other,
}

struct TreeItem {
    path: String,
    rel: String,
    kind: TreeKind,
    size: u64,
}

struct LocalItem {
    local: std::path::PathBuf,
    rel: String,
    kind: TreeKind,
    size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeProgress {
    pub done: u64,
    pub total: u64,
    pub files: u64,
    pub total_files: u64,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeSummary {
    pub files: u64,
    pub bytes: u64,
    /// Relative paths left out (symlinks, special files, unsafe names).
    pub skipped: Vec<String>,
    /// Where the folder ended up.
    pub path: String,
}

/// Can a name from the server be used as one local path component here?
/// Rejects anything that could climb out of the target folder or that
/// Windows would read as a device, a drive or a stream.
pub fn local_name_ok(name: &str) -> bool {
    if name.is_empty() || name == "." || name == ".." || name.len() > 255 {
        return false;
    }
    if name.chars().any(|c| c.is_control() || matches!(c, '/' | '\\' | ':' | '<' | '>' | '"' | '|' | '?' | '*')) {
        return false;
    }
    if name.ends_with('.') || name.ends_with(' ') {
        return false;
    }
    let stem = name.split('.').next().unwrap_or("").trim_end().to_ascii_uppercase();
    let reserved = ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"];
    if reserved.contains(&stem.as_str()) {
        return false;
    }
    if (stem.starts_with("COM") || stem.starts_with("LPT"))
        && stem.len() == 4
        && stem[3..].chars().all(|c| c.is_ascii_digit() || matches!(c, '¹' | '²' | '³'))
    {
        return false;
    }
    true
}

/// Walk a local folder without following symlinks (or Windows junctions).
async fn walk_local(root: &Path, cancel: &AtomicBool) -> Result<Vec<LocalItem>> {
    let mut out = Vec::new();
    let mut stack = vec![(root.to_path_buf(), String::new(), 0usize)];
    while let Some((dir, rel, depth)) = stack.pop() {
        if depth > MAX_DEPTH {
            return Err(CoreError::invalid(format!("{} is nested more than {MAX_DEPTH} folders deep.", dir.display())));
        }
        let mut rd = tokio::fs::read_dir(&dir).await?;
        let mut here = Vec::new();
        while let Some(e) = rd.next_entry().await? {
            if cancel.load(Ordering::Relaxed) {
                return Err(CoreError::cancelled());
            }
            let name = e.file_name().to_string_lossy().to_string();
            let md = tokio::fs::symlink_metadata(e.path()).await?;
            let kind = if md.file_type().is_symlink() || is_reparse_point(&md) {
                TreeKind::Other
            } else if md.is_dir() {
                TreeKind::Dir
            } else if md.is_file() {
                TreeKind::File
            } else {
                TreeKind::Other
            };
            let rel_path = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
            here.push(LocalItem { local: e.path(), rel: rel_path, kind, size: md.len() });
        }
        here.sort_by(|a, b| a.rel.cmp(&b.rel));
        for it in here {
            if it.kind == TreeKind::Dir {
                stack.push((it.local.clone(), it.rel.clone(), depth + 1));
            }
            out.push(it);
            if out.len() > MAX_ENTRIES {
                return Err(CoreError::invalid(format!("{} holds more than {MAX_ENTRIES} items.", root.display())));
            }
        }
    }
    Ok(out)
}

#[cfg(windows)]
fn is_reparse_point(md: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    md.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
fn is_reparse_point(_: &std::fs::Metadata) -> bool {
    false
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

    #[test]
    fn server_names_that_could_escape_or_misbehave_locally_are_refused() {
        for bad in [
            "", ".", "..", "a/b", "a\\b", "..\\x", "C:", "x:y", "con", "CON.txt", "nul", "Com1", "lpt9.log", "a?",
            "a*", "end.", "end ", "a\nb", "a|b",
        ] {
            assert!(!local_name_ok(bad), "{bad:?} should be refused");
        }
        for ok in ["file.txt", ".bashrc", "con1", "console", "my file", "café", "COM10", "a-b_c+d@e"] {
            assert!(local_name_ok(ok), "{ok:?} should be allowed");
        }
    }

    #[tokio::test]
    async fn local_walk_skips_symlinks_and_lists_parents_first() {
        let d = tempfile::tempdir().unwrap();
        let r = d.path().join("top");
        std::fs::create_dir_all(r.join("a/b")).unwrap();
        std::fs::write(r.join("a/b/f.txt"), b"hello").unwrap();
        std::fs::write(r.join("z.txt"), b"x").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(d.path(), r.join("loop")).unwrap();
        let items = walk_local(&r, &AtomicBool::new(false)).await.unwrap();
        let rels: Vec<_> = items.iter().map(|i| i.rel.as_str()).collect();
        let pos = |n: &str| rels.iter().position(|r| *r == n).unwrap();
        assert!(pos("a") < pos("a/b") && pos("a/b") < pos("a/b/f.txt"));
        assert_eq!(items[pos("a/b/f.txt")].size, 5);
        #[cfg(unix)]
        assert_eq!(items[pos("loop")].kind, TreeKind::Other);
        assert!(!rels.iter().any(|r| r.starts_with("loop/")));
    }
}
