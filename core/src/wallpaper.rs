//! Wallpaper images for the app and the terminal. The user picks a picture;
//! it is checked to really be an image and copied into the app data folder.

/// Largest picture accepted, in bytes.
pub const MAX_BYTES: usize = 25 * 1024 * 1024;

/// The image type from the file's first bytes (not its name): MIME type and extension.
pub fn image_kind(bytes: &[u8]) -> Option<(&'static str, &'static str)> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some(("image/png", "png"))
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some(("image/jpeg", "jpg"))
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some(("image/gif", "gif"))
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some(("image/webp", "webp"))
    } else if bytes.starts_with(b"BM") && bytes.len() > 26 {
        Some(("image/bmp", "bmp"))
    } else {
        None
    }
}

/// File-name stem for a target ("app" or "term"); anything else is refused.
pub fn stem(target: &str) -> Option<&'static str> {
    match target {
        "app" => Some("wallpaper-app"),
        "term" => Some("wallpaper-term"),
        _ => None,
    }
}

pub const EXTENSIONS: [&str; 5] = ["png", "jpg", "gif", "webp", "bmp"];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn image_types_by_content() {
        assert_eq!(image_kind(b"\x89PNG\r\n\x1a\n...."), Some(("image/png", "png")));
        assert_eq!(image_kind(&[0xFF, 0xD8, 0xFF, 0xE0, 0, 0]), Some(("image/jpeg", "jpg")));
        assert_eq!(image_kind(b"GIF89a......"), Some(("image/gif", "gif")));
        assert_eq!(image_kind(b"RIFF\0\0\0\0WEBPVP8 "), Some(("image/webp", "webp")));
        assert_eq!(image_kind(b"<svg xmlns=..."), None);
        assert_eq!(image_kind(b"MZ\x90\0 not an image"), None);
        assert_eq!(image_kind(b""), None);
    }

    #[test]
    fn only_known_targets() {
        assert_eq!(stem("app"), Some("wallpaper-app"));
        assert_eq!(stem("term"), Some("wallpaper-term"));
        assert_eq!(stem("../x"), None);
    }
}
