//! "Check for updates": only when the user clicks the button, ask GitHub for
//! the latest release of this app. Nothing is sent but a plain HTTPS request
//! (no identifiers); nothing runs in the background, and nothing is
//! downloaded or installed automatically.

use std::time::Duration;

use serde::Serialize;

use crate::error::{CoreError, Result};

pub const RELEASES_API: &str = "https://api.github.com/repos/Shaqqiem/siakap-term/releases/latest";
/// Release pages Siakap will open in the browser.
pub const RELEASES_PAGE: &str = "https://github.com/Shaqqiem/siakap-term/releases";

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
    let notes: String = v
        .get("body")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .chars()
        .filter(|c| *c == '\n' || !c.is_control())
        .take(1500)
        .collect();
    let latest = tag.trim_start_matches(['v', 'V']).to_string();
    Ok(UpdateInfo { newer: is_newer(&latest, current), current: current.into(), latest, url, published, notes })
}

/// Ask GitHub for the latest release. Uses the system's certificates and proxy.
pub fn check(current: &str) -> Result<UpdateInfo> {
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(10))
        .try_proxy_from_env(true)
        .user_agent("Siakap-Terminal-update-check")
        .build();
    let resp = agent.get(RELEASES_API).set("Accept", "application/vnd.github+json").call().map_err(|e| match e {
        ureq::Error::Status(404, _) => CoreError::invalid("No published release was found."),
        ureq::Error::Status(code, _) => {
            CoreError::invalid(format!("GitHub answered with an error ({code}). Try again later."))
        }
        ureq::Error::Transport(_) => CoreError::invalid(
            "Couldn't reach GitHub. Check your internet connection or proxy, or open the Releases page yourself.",
        ),
    })?;
    let body = resp.into_string().map_err(|_| CoreError::invalid("Couldn't read GitHub's answer."))?;
    parse_release(&body, current)
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
        // A link anywhere else is replaced by the Releases page.
        let evil = r#"{"tag_name":"v9.9.9","html_url":"https://evil.example/x"}"#;
        assert_eq!(parse_release(evil, "0.6.1").unwrap().url, RELEASES_PAGE);
        assert!(parse_release("{}", "0.6.1").is_err());
        assert!(parse_release(r#"{"tag_name":"nightly"}"#, "0.6.1").is_err());
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
