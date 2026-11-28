//! "Check for updates": only when the user clicks the button, ask GitHub for
//! the latest release of this app. Nothing is sent but a plain HTTPS request
//! (no identifiers) and nothing runs in the background.
//!
//! "Download and install" (also only on a click) downloads the release's
//! setup.exe from this repository's release files, checks its SHA-256
//! against the release's SHA256SUMS.txt, and only then runs that exact file
//! (the path never comes from the web view).

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;

use crate::error::{CoreError, Result};

pub const RELEASES_API: &str = "https://api.github.com/repos/Shaqqiem/siakap-term/releases/latest";
/// Release pages Siakap will open in the browser.
pub const RELEASES_PAGE: &str = "https://github.com/Shaqqiem/siakap-term/releases";
/// Release files Siakap will download (GitHub then redirects to its file host).
pub const RELEASE_FILES: &str = "https://github.com/Shaqqiem/siakap-term/releases/download/";
const MAX_INSTALLER: u64 = 300 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current: String,
    pub latest: String,
    pub newer: bool,
    /// The release page (always under RELEASES_PAGE).
    pub url: String,
    pub published: String,
    /// Release notes, shortened.
    pub notes: String,
    /// The Windows setup.exe and the checksum list of this release, if present.
    pub installer_url: Option<String>,
    pub installer_size: u64,
    pub sums_url: Option<String>,
}

fn is_release_file(url: &str) -> bool {
    url.starts_with(RELEASE_FILES) && !url.contains(['"', '\'', ' ', '<', '>', '\\']) && !url.contains("..")
}

/// Version numbers from "v1.2.3" / "1.2.3" (anything after a '-' is ignored).
fn parts(v: &str) -> Option<Vec<u64>> {
    let v = v.trim().trim_start_matches(['v', 'V']);
    let core = v.split(['-', '+']).next()?;
    let p: Option<Vec<u64>> = core.split('.').map(|x| x.parse().ok()).collect();
    p.filter(|p| !p.is_empty() && p.len() <= 4)
}

pub fn is_newer(latest: &str, current: &str) -> bool {
    match (parts(latest), parts(current)) {
        (Some(mut a), Some(mut b)) => {
            let n = a.len().max(b.len());
            a.resize(n, 0);
            b.resize(n, 0);
            a > b
        }
        _ => false,
    }
}

pub fn is_release_page(url: &str) -> bool {
    url == RELEASES_PAGE
        || (url.starts_with(&format!("{RELEASES_PAGE}/"))
            && !url.contains(['"', '\'', ' ', '<', '>', '\\'])
            && !url.contains(".."))
}

/// Read GitHub's "latest release" answer.
pub fn parse_release(json: &str, current: &str) -> Result<UpdateInfo> {
    let v: serde_json::Value = serde_json::from_str(json)
        .map_err(|_| CoreError::invalid("GitHub sent an answer Siakap didn't understand."))?;
    let tag = v.get("tag_name").and_then(|x| x.as_str()).ok_or_else(|| CoreError::invalid("No release was found."))?;
    if parts(tag).is_none() {
        return Err(CoreError::invalid("The latest release has no version number."));
    }
    let url =
        v.get("html_url").and_then(|x| x.as_str()).filter(|u| is_release_page(u)).unwrap_or(RELEASES_PAGE).to_string();
    let published = v.get("published_at").and_then(|x| x.as_str()).unwrap_or("").chars().take(10).collect();
    // The changelog part only (release notes continue with install steps and checksums).
    let body = v.get("body").and_then(|x| x.as_str()).unwrap_or("");
    let body = body.split("### Install or update").next().unwrap_or("").trim();
    let notes: String = body.chars().filter(|c| *c == '\n' || !c.is_control()).take(2000).collect();
    let latest = tag.trim_start_matches(['v', 'V']).to_string();
    let assets = v.get("assets").and_then(|a| a.as_array()).cloned().unwrap_or_default();
    let asset = |pred: &dyn Fn(&str) -> bool| {
        assets.iter().find_map(|a| {
            let name = a.get("name")?.as_str()?;
            let link = a.get("browser_download_url")?.as_str()?;
            (pred(name) && is_release_file(link))
                .then(|| (link.to_string(), a.get("size").and_then(|s| s.as_u64()).unwrap_or(0)))
        })
    };
    let installer = asset(&|n: &str| n.ends_with("_x64-setup.exe"));
    let sums = asset(&|n: &str| n == "SHA256SUMS.txt");
    Ok(UpdateInfo {
        newer: is_newer(&latest, current),
        current: current.into(),
        latest,
        url,
        published,
        notes,
        installer_size: installer.as_ref().map(|i| i.1).unwrap_or(0),
        installer_url: installer.map(|i| i.0),
        sums_url: sums.map(|s| s.0),
    })
}

/// Ask GitHub for the latest release. Uses the system's certificates and proxy.
/// Installing from inside the app is Windows-only; elsewhere the user gets
/// the release page.
pub fn check(current: &str) -> Result<UpdateInfo> {
    let mut info = check_any(current)?;
    if !cfg!(windows) {
        info.installer_url = None;
        info.installer_size = 0;
    }
    Ok(info)
}

/// Like [`check`], but keeps the Windows installer on every platform. Only for
/// debug-build tests of the download and checksum steps.
#[doc(hidden)]
pub fn check_any(current: &str) -> Result<UpdateInfo> {
    match agent(10).get(RELEASES_API).set("Accept", "application/vnd.github+json").call() {
        Ok(resp) => {
            let body = resp.into_string().map_err(|_| CoreError::invalid("Couldn't read GitHub's answer."))?;
            parse_release(&body, current)
        }
        Err(ureq::Error::Status(404, _)) => Err(CoreError::invalid("No published release was found.")),
        // 403/429: GitHub's API allows only 60 anonymous requests an hour per
        // internet address, which a company network shares. The Releases page
        // isn't limited that way, so ask it instead.
        Err(ureq::Error::Status(code, _)) => check_via_web(current).map_err(|e| {
            CoreError::invalid(format!("GitHub's update service answered {code}, and the Releases page couldn't be read either ({e}). Try again later, or open the Releases page yourself."))
        }),
        Err(ureq::Error::Transport(_)) => check_via_web(current).map_err(|_| {
            CoreError::invalid("Couldn't reach GitHub. Check your internet connection or proxy, or open the Releases page yourself.")
        }),
    }
}

/// The tag `…/releases/latest` redirects to, e.g. ".../releases/tag/v0.7.3" -> "v0.7.3".
pub fn tag_from_location(location: &str) -> Option<String> {
    let tag = location.strip_prefix(&format!("{RELEASES_PAGE}/tag/"))?;
    let tag = tag.split(['?', '#']).next()?;
    (parts(tag).is_some() && tag.len() < 32 && tag.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-'))
        .then(|| tag.to_string())
}

/// Version notes from a CHANGELOG.md (the section for `version`).
pub fn changelog_section(text: &str, version: &str) -> String {
    let head = format!("## [{version}]");
    let Some(start) = text.find(&head) else { return String::new() };
    let rest = &text[start..];
    let body = rest.split_once('\n').map(|x| x.1).unwrap_or("");
    let end = body.find("\n## [").or_else(|| body.find("\n[0")).unwrap_or(body.len());
    body[..end].trim().chars().take(2000).collect()
}

/// Without the API: follow the "latest release" redirect for the version, and
/// build the release-file addresses from it (always under RELEASE_FILES).
pub fn check_via_web(current: &str) -> Result<UpdateInfo> {
    let no_redirects = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(15))
        .timeout_read(Duration::from_secs(10))
        .try_proxy_from_env(true)
        .redirects(0)
        .user_agent("Siakap-Terminal-update-check")
        .build();
    let resp = no_redirects.get(&format!("{RELEASES_PAGE}/latest")).call().map_err(|e| match e {
        ureq::Error::Status(code, _) => CoreError::invalid(format!("the Releases page answered {code}")),
        ureq::Error::Transport(_) => CoreError::invalid("the Releases page couldn't be reached"),
    })?;
    let tag = resp
        .header("Location")
        .and_then(tag_from_location)
        .ok_or_else(|| CoreError::invalid("the latest release couldn't be found"))?;
    let latest = tag.trim_start_matches(['v', 'V']).to_string();
    // Notes from that release's CHANGELOG.md (best effort).
    let notes_from = |rev: &str| {
        agent(10)
            .get(&format!("https://raw.githubusercontent.com/Shaqqiem/siakap-term/{rev}/CHANGELOG.md"))
            .call()
            .ok()
            .and_then(|r| r.into_string().ok())
            .map(|t| changelog_section(&t, &latest))
            .unwrap_or_default()
    };
    let mut notes = notes_from(&tag);
    if notes.is_empty() {
        notes = notes_from("main"); // releases from before the changelog existed
    }
    let files = format!("{RELEASE_FILES}{tag}/");
    Ok(UpdateInfo {
        newer: is_newer(&latest, current),
        current: current.into(),
        url: format!("{RELEASES_PAGE}/tag/{tag}"),
        published: String::new(),
        notes,
        installer_url: Some(format!("{files}Siakap.Terminal_{latest}_x64-setup.exe")),
        installer_size: 0,
        sums_url: Some(format!("{files}SHA256SUMS.txt")),
        latest,
    })
}

fn agent(timeout_secs: u64) -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(15))
        .timeout_read(Duration::from_secs(timeout_secs))
        .try_proxy_from_env(true)
        .user_agent("Siakap-Terminal-update-check")
        .build()
}

/// Is `hash` listed for a setup.exe in a SHA256SUMS.txt?
pub fn hash_listed(sums: &str, hash: &str) -> bool {
    sums.lines().any(|l| {
        let mut it = l.split_whitespace();
        let (Some(h), Some(name)) = (it.next(), it.next()) else { return false };
        h.eq_ignore_ascii_case(hash) && (name.ends_with("-setup.exe") || l.trim_end().ends_with("-setup.exe"))
    })
}

/// Download the setup.exe into `dir` (streamed, size-limited), check its
/// SHA-256 against the release's SHA256SUMS.txt, and return its path. A file
/// that doesn't match is deleted.
pub fn download_installer(info: &UpdateInfo, dir: &Path, progress: &mut dyn FnMut(u64, u64)) -> Result<PathBuf> {
    use sha2::{Digest, Sha256};
    use std::io::{Read, Write};
    let url = info
        .installer_url
        .as_deref()
        .filter(|u| is_release_file(u))
        .ok_or_else(|| CoreError::invalid("This release has no Windows installer to download."))?;
    let sums_url =
        info.sums_url.as_deref().filter(|u| is_release_file(u)).ok_or_else(|| {
            CoreError::invalid("This release has no checksum list, so the download can't be checked.")
        })?;
    let a = agent(60);
    let net = || CoreError::invalid("The download was interrupted. Check your connection and try again.");
    // Checksums first (small).
    let sums = a
        .get(sums_url)
        .call()
        .map_err(|_| net())?
        .into_string()
        .map_err(|_| CoreError::invalid("Couldn't read the checksum list."))?;
    if sums.len() > 64 * 1024 {
        return Err(CoreError::invalid("The checksum list is unexpectedly large."));
    }
    std::fs::create_dir_all(dir)?;
    let name = format!("Siakap-Terminal-{}-setup.exe", crate::termlog::safe_part(&info.latest, 20));
    let path = dir.join(name);
    let _ = std::fs::remove_file(&path);
    let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&path)?;
    let resp = a.get(url).call().map_err(|_| net())?;
    let total = resp.header("Content-Length").and_then(|v| v.parse().ok()).unwrap_or(info.installer_size);
    if total > MAX_INSTALLER {
        let _ = std::fs::remove_file(&path);
        return Err(CoreError::invalid("The installer is unexpectedly large."));
    }
    let mut reader = resp.into_reader().take(MAX_INSTALLER + 1);
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    let mut done: u64 = 0;
    let fail = |path: &Path, e: CoreError| {
        let _ = std::fs::remove_file(path);
        e
    };
    loop {
        let n = reader.read(&mut buf).map_err(|_| fail(&path, net()))?;
        if n == 0 {
            break;
        }
        done += n as u64;
        if done > MAX_INSTALLER {
            return Err(fail(&path, CoreError::invalid("The installer is unexpectedly large.")));
        }
        hasher.update(&buf[..n]);
        file.write_all(&buf[..n]).map_err(|e| fail(&path, e.into()))?;
        progress(done, total);
    }
    file.sync_all().map_err(|e| fail(&path, e.into()))?;
    drop(file);
    let hash = hasher.finalize().iter().map(|b| format!("{b:02x}")).collect::<String>();
    if !hash_listed(&sums, &hash) {
        return Err(fail(&path, CoreError::invalid("The downloaded installer doesn't match the release's checksum, so it was deleted. Nothing was installed.")));
    }
    Ok(path)
}

/// Run a downloaded installer: passive (a progress window, no questions), then
/// start Siakap again. The caller exits the app straight after.
pub fn run_installer(path: &Path) -> Result<()> {
    if !cfg!(windows) {
        return Err(CoreError::invalid("Installing updates from the app is only available on Windows."));
    }
    std::process::Command::new(path)
        .args(["/P", "/R"])
        .spawn()
        .map(|_| ())
        .map_err(|e| CoreError::invalid(format!("Couldn't start the installer: {e}")))
}

/// Open a release page in the default browser (only GitHub release pages of this app).
pub fn open_page(url: &str) -> Result<()> {
    if !is_release_page(url) {
        return Err(CoreError::invalid("Only Siakap's release page can be opened."));
    }
    #[cfg(windows)]
    let r = crate::process::command("explorer.exe", &[url]).spawn();
    #[cfg(target_os = "macos")]
    let r = crate::process::command("open", &[url]).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let r = crate::process::command("xdg-open", &[url]).spawn();
    r.map(|_| ()).map_err(|_| CoreError::invalid(format!("Couldn't open the browser. The page is {url}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_versions() {
        assert!(is_newer("v0.6.2", "0.6.1"));
        assert!(is_newer("0.10.0", "0.9.9"));
        assert!(is_newer("1.0", "0.9.9"));
        assert!(!is_newer("0.6.1", "0.6.1"));
        assert!(!is_newer("0.6.0", "0.6.1"));
        assert!(!is_newer("v0.6.1-beta", "0.6.1"));
        assert!(!is_newer("garbage", "0.6.1"));
    }

    #[test]
    fn reads_github_answers() {
        let j = r#"{"tag_name":"v0.7.0","html_url":"https://github.com/Shaqqiem/siakap-term/releases/tag/v0.7.0","published_at":"2026-12-01T10:00:00Z","body":"Fixes\nand more\u0007"}"#;
        let u = parse_release(j, "0.6.1").unwrap();
        assert!(u.newer);
        assert_eq!(u.latest, "0.7.0");
        assert_eq!(u.published, "2026-12-01");
        assert_eq!(u.notes, "Fixes\nand more");
        let with_table =
            serde_json::json!({"tag_name": "v0.8.0", "body": "### New\n- A thing\n\n### Install or update\n| a | b |"})
                .to_string();
        assert_eq!(parse_release(&with_table, "0.7.0").unwrap().notes, "### New\n- A thing", "only the changelog part");
        // A link anywhere else is replaced by the Releases page.
        let evil = r#"{"tag_name":"v9.9.9","html_url":"https://evil.example/x"}"#;
        assert_eq!(parse_release(evil, "0.6.1").unwrap().url, RELEASES_PAGE);
        assert!(parse_release("{}", "0.6.1").is_err());
        assert!(parse_release(r#"{"tag_name":"nightly"}"#, "0.6.1").is_err());
    }

    #[test]
    fn finds_installer_assets_and_checks_sums() {
        let j = r#"{"tag_name":"v0.8.0","html_url":"https://github.com/Shaqqiem/siakap-term/releases/tag/v0.8.0","assets":[
            {"name":"Siakap.Terminal_0.8.0_x64-setup.exe","size":4000000,"browser_download_url":"https://github.com/Shaqqiem/siakap-term/releases/download/v0.8.0/Siakap.Terminal_0.8.0_x64-setup.exe"},
            {"name":"SHA256SUMS.txt","size":200,"browser_download_url":"https://github.com/Shaqqiem/siakap-term/releases/download/v0.8.0/SHA256SUMS.txt"}]}"#;
        let u = parse_release(j, "0.7.0").unwrap();
        assert_eq!(u.installer_size, 4_000_000);
        assert!(u.installer_url.unwrap().ends_with("_x64-setup.exe"));
        assert!(u.sums_url.unwrap().ends_with("SHA256SUMS.txt"));
        // Assets hosted anywhere else are ignored.
        let evil = j.replace(
            "https://github.com/Shaqqiem/siakap-term/releases/download/v0.8.0/Siakap",
            "https://evil.example/Siakap",
        );
        assert!(parse_release(&evil, "0.7.0").unwrap().installer_url.is_none());
        let sums = "aa11  Siakap Terminal_0.8.0_x64_en-US.msi\nBB22  Siakap Terminal_0.8.0_x64-setup.exe\n";
        assert!(hash_listed(sums, "bb22"));
        assert!(!hash_listed(sums, "aa11"), "the MSI's hash doesn't count for setup.exe");
        assert!(!hash_listed(sums, "cc33"));
    }

    /// Real download from GitHub: `cargo test -p siakap-core --lib update -- --ignored`.
    #[test]
    #[ignore]
    fn live_download() {
        let u = check("0.0.1").unwrap();
        let dir = std::env::temp_dir().join("siakap-update-test");
        let mut last = 0;
        let p = download_installer(&u, &dir, &mut |d, _| last = d).unwrap();
        eprintln!("{} bytes -> {}", last, p.display());
        assert!(p.exists() && last > 1_000_000);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn web_fallback_parsing() {
        assert_eq!(
            tag_from_location("https://github.com/Shaqqiem/siakap-term/releases/tag/v0.7.3").as_deref(),
            Some("v0.7.3")
        );
        assert_eq!(tag_from_location("https://github.com/evil/repo/releases/tag/v9.9.9"), None);
        assert_eq!(tag_from_location("https://github.com/Shaqqiem/siakap-term/releases/tag/v1/../x"), None);
        assert_eq!(tag_from_location("https://github.com/Shaqqiem/siakap-term/releases/tag/nightly"), None);
        let cl = "# Changelog\n\n## [0.7.3] - 2026-11-27\n\n**Big.**\n\n### New\n- A\n\n## [0.7.2] - x\n- old\n\n[0.7.3]: link\n";
        assert_eq!(changelog_section(cl, "0.7.3"), "**Big.**\n\n### New\n- A");
        assert_eq!(changelog_section(cl, "0.7.2"), "- old");
        assert_eq!(changelog_section(cl, "1.0.0"), "");
    }

    /// The fallback against the real Releases page: `-- --ignored`.
    #[test]
    #[ignore]
    fn live_web_fallback() {
        let u = check_via_web("0.0.1").unwrap();
        eprintln!("{u:?}");
        assert!(u.newer && u.installer_url.is_some() && !u.notes.is_empty());
    }

    /// Real request to GitHub: `cargo test -p siakap-core --lib update -- --ignored`.
    #[test]
    #[ignore]
    fn live_check() {
        let u = check("0.0.1").unwrap();
        eprintln!("{u:?}");
        assert!(u.newer && is_release_page(&u.url));
    }

    #[test]
    fn only_release_pages_open() {
        assert!(is_release_page("https://github.com/Shaqqiem/siakap-term/releases/tag/v0.7.0"));
        assert!(is_release_page(RELEASES_PAGE));
        assert!(!is_release_page("https://github.com/Shaqqiem/siakap-term/releases-evil"));
        assert!(!is_release_page("https://github.com/Shaqqiem/siakap-term/releases/../../x"));
        assert!(!is_release_page("file:///C:/Windows/System32/calc.exe"));
        assert!(!is_release_page("https://github.com/Shaqqiem/siakap-term/releases/x\" & calc"));
    }
}
