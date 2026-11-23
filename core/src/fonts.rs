//! Installed font families, read straight from the font files' `name` and
//! `post` tables (no system APIs, no extra crates). Only the table directory
//! and those two small tables are read, never whole files.

use std::collections::BTreeMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontFamily {
    pub name: String,
    /// Every character has the same width (good for terminals).
    pub monospace: bool,
}

fn font_dirs() -> Vec<PathBuf> {
    let mut v = Vec::new();
    #[cfg(windows)]
    {
        if let Some(w) = std::env::var_os("WINDIR") {
            v.push(Path::new(&w).join("Fonts"));
        }
        if let Some(l) = std::env::var_os("LOCALAPPDATA") {
            v.push(Path::new(&l).join("Microsoft").join("Windows").join("Fonts"));
        }
    }
    #[cfg(target_os = "macos")]
    {
        v.push("/System/Library/Fonts".into());
        v.push("/Library/Fonts".into());
        if let Some(h) = std::env::var_os("HOME") {
            v.push(Path::new(&h).join("Library/Fonts"));
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        v.push("/usr/share/fonts".into());
        v.push("/usr/local/share/fonts".into());
        if let Some(h) = std::env::var_os("HOME") {
            v.push(Path::new(&h).join(".local/share/fonts"));
            v.push(Path::new(&h).join(".fonts"));
        }
    }
    v
}

/// Installed font families, sorted by name. Unreadable files are skipped.
pub fn installed() -> Vec<FontFamily> {
    let mut files = Vec::new();
    for d in font_dirs() {
        collect(&d, 0, &mut files);
    }
    let mut out: BTreeMap<String, FontFamily> = BTreeMap::new();
    for f in files {
        for fam in read_font_file(&f).unwrap_or_default() {
            let key = fam.name.to_lowercase();
            out.entry(key).and_modify(|e| e.monospace |= fam.monospace).or_insert(fam);
        }
    }
    out.into_values().collect()
}

fn collect(dir: &Path, depth: u32, out: &mut Vec<PathBuf>) {
    if depth > 6 || out.len() > 20_000 {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_dir() {
            collect(&p, depth + 1, out);
        } else if ft.is_file() {
            let ext = p.extension().and_then(|x| x.to_str()).unwrap_or("").to_ascii_lowercase();
            if matches!(ext.as_str(), "ttf" | "otf" | "ttc" | "otc") {
                out.push(p);
            }
        }
    }
}

fn read_font_file(path: &Path) -> std::io::Result<Vec<FontFamily>> {
    let mut f = File::open(path)?;
    parse_fonts(&mut f)
}

fn u16_at(b: &[u8], o: usize) -> Option<u16> {
    b.get(o..o + 2).map(|s| u16::from_be_bytes([s[0], s[1]]))
}
fn u32_at(b: &[u8], o: usize) -> Option<u32> {
    b.get(o..o + 4).map(|s| u32::from_be_bytes([s[0], s[1], s[2], s[3]]))
}

fn read_exact_at<R: Read + Seek>(r: &mut R, off: u64, len: usize) -> std::io::Result<Vec<u8>> {
    r.seek(SeekFrom::Start(off))?;
    let mut v = vec![0u8; len];
    r.read_exact(&mut v)?;
    Ok(v)
}

fn bad() -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidData, "not a font")
}

/// Families in one font file (a collection holds several fonts).
pub fn parse_fonts<R: Read + Seek>(r: &mut R) -> std::io::Result<Vec<FontFamily>> {
    let head = read_exact_at(r, 0, 12)?;
    let offsets: Vec<u64> = if &head[0..4] == b"ttcf" {
        let n = u32_at(&head, 8).ok_or_else(bad)?.min(64) as usize;
        let tbl = read_exact_at(r, 12, n * 4)?;
        (0..n).filter_map(|i| u32_at(&tbl, i * 4)).map(u64::from).collect()
    } else {
        vec![0]
    };
    let mut out = Vec::new();
    for off in offsets {
        if let Ok(Some(f)) = parse_one(r, off) {
            out.push(f);
        }
    }
    Ok(out)
}

fn parse_one<R: Read + Seek>(r: &mut R, off: u64) -> std::io::Result<Option<FontFamily>> {
    let hdr = read_exact_at(r, off, 12)?;
    let tag = u32_at(&hdr, 0).ok_or_else(bad)?;
    if tag != 0x0001_0000 && &hdr[0..4] != b"OTTO" && &hdr[0..4] != b"true" {
        return Err(bad());
    }
    let n = u16_at(&hdr, 4).ok_or_else(bad)?.min(256) as usize;
    let dir = read_exact_at(r, off + 12, n * 16)?;
    let mut name = None;
    let mut post = None;
    for i in 0..n {
        let rec = &dir[i * 16..i * 16 + 16];
        let (o, l) = (u32_at(rec, 8).ok_or_else(bad)?, u32_at(rec, 12).ok_or_else(bad)?);
        match &rec[0..4] {
            b"name" => name = Some((o, l)),
            b"post" => post = Some((o, l)),
            _ => {}
        }
    }
    let Some((no, nl)) = name else { return Ok(None) };
    if nl > 1 << 20 {
        return Err(bad());
    }
    let nb = read_exact_at(r, u64::from(no), nl as usize)?;
    let Some(family) = family_name(&nb) else { return Ok(None) };
    let monospace = match post {
        Some((po, pl)) if pl >= 16 => u32_at(&read_exact_at(r, u64::from(po), 16)?, 12).is_some_and(|v| v != 0),
        _ => false,
    };
    Ok(Some(FontFamily { name: family, monospace }))
}

/// Typographic family (ID 16) if present, else family (ID 1). Windows
/// English names first, then any Windows name, then Mac Roman.
pub fn family_name(t: &[u8]) -> Option<String> {
    let count = u16_at(t, 2)? as usize;
    let strings = u16_at(t, 4)? as usize;
    let mut best: Option<(u32, String)> = None;
    for i in 0..count.min(2048) {
        let r = 6 + i * 12;
        let (pid, eid, lang, nid, len, o) = (
            u16_at(t, r)?,
            u16_at(t, r + 2)?,
            u16_at(t, r + 4)?,
            u16_at(t, r + 6)?,
            u16_at(t, r + 8)?,
            u16_at(t, r + 10)?,
        );
        if nid != 1 && nid != 16 {
            continue;
        }
        let Some(raw) = t.get(strings + o as usize..strings + o as usize + len as usize) else { continue };
        let (text, plat_rank) = match pid {
            3 if eid == 1 || eid == 0 || eid == 10 => {
                let u: Vec<u16> = raw.chunks_exact(2).map(|c| u16::from_be_bytes([c[0], c[1]])).collect();
                (String::from_utf16_lossy(&u), if lang == 0x409 { 0 } else { 1 })
            }
            0 => {
                let u: Vec<u16> = raw.chunks_exact(2).map(|c| u16::from_be_bytes([c[0], c[1]])).collect();
                (String::from_utf16_lossy(&u), 2)
            }
            1 if eid == 0 => (raw.iter().map(|&b| if b < 0x80 { b as char } else { '?' }).collect(), 3),
            _ => continue,
        };
        let text = text.trim().to_string();
        if text.is_empty() || text.starts_with('.') || text.chars().any(|c| c.is_control()) || text.len() > 120 {
            continue;
        }
        let rank = (if nid == 16 { 0 } else { 10 }) + plat_rank;
        if best.as_ref().is_none_or(|(b, _)| rank < *b) {
            best = Some((rank, text));
        }
    }
    best.map(|(_, s)| s)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn name_table(records: &[(u16, u16, u16, u16, &[u8])]) -> Vec<u8> {
        let mut head = vec![0u8, 0];
        head.extend((records.len() as u16).to_be_bytes());
        head.extend(((6 + 12 * records.len()) as u16).to_be_bytes());
        let mut strings = Vec::new();
        for (pid, eid, lang, nid, s) in records {
            for v in [*pid, *eid, *lang, *nid, s.len() as u16, strings.len() as u16] {
                head.extend(v.to_be_bytes());
            }
            strings.extend_from_slice(s);
        }
        head.extend(strings);
        head
    }
    fn utf16(s: &str) -> Vec<u8> {
        s.encode_utf16().flat_map(|u| u.to_be_bytes()).collect()
    }
    fn font(name: &[u8], fixed: bool) -> Vec<u8> {
        let mut post = vec![0u8; 32];
        post[12..16].copy_from_slice(&(fixed as u32).to_be_bytes());
        let mut f = Vec::new();
        f.extend(0x0001_0000u32.to_be_bytes());
        f.extend(2u16.to_be_bytes());
        f.extend([0u8; 6]);
        let name_off = 12 + 32;
        let post_off = name_off + name.len();
        for (tag, o, l) in [(b"name", name_off, name.len()), (b"post", post_off, post.len())] {
            f.extend(tag);
            f.extend([0u8; 4]);
            f.extend((o as u32).to_be_bytes());
            f.extend((l as u32).to_be_bytes());
        }
        f.extend(name);
        f.extend(post);
        f
    }

    #[test]
    fn prefers_typographic_english_windows_names() {
        let fam_light = utf16("Cascadia Mono Light");
        let fam = utf16("Cascadia Mono");
        let t = name_table(&[
            (1, 0, 0, 1, b"Mac Name"),
            (3, 1, 0x409, 1, &fam_light),
            (3, 1, 0x411, 16, &utf16("Japanese")),
            (3, 1, 0x409, 16, &fam),
        ]);
        assert_eq!(family_name(&t).as_deref(), Some("Cascadia Mono"));
        let t = name_table(&[(1, 0, 0, 1, b"Only Mac")]);
        assert_eq!(family_name(&t).as_deref(), Some("Only Mac"));
        let t = name_table(&[(3, 1, 0x409, 1, &utf16(".Hidden"))]);
        assert_eq!(family_name(&t), None);
    }

    #[test]
    fn reads_fonts_and_collections() {
        let mono = font(&name_table(&[(3, 1, 0x409, 1, &utf16("Test Mono"))]), true);
        let fams = parse_fonts(&mut Cursor::new(mono.clone())).unwrap();
        assert_eq!(fams, vec![FontFamily { name: "Test Mono".into(), monospace: true }]);
        let sans = font(&name_table(&[(3, 1, 0x409, 1, &utf16("Test Sans"))]), false);
        // Collection: header + 2 offsets, then both fonts (offsets rebased).
        let mut ttc = b"ttcf".to_vec();
        ttc.extend(0x0001_0000u32.to_be_bytes());
        ttc.extend(2u32.to_be_bytes());
        let a = 20u32;
        let b = a + mono.len() as u32;
        ttc.extend(a.to_be_bytes());
        ttc.extend(b.to_be_bytes());
        let rebase = |f: &[u8], base: u32| {
            let mut f = f.to_vec();
            for i in 0..2 {
                let p = 12 + i * 16 + 8;
                let o = u32::from_be_bytes(f[p..p + 4].try_into().unwrap()) + base;
                f[p..p + 4].copy_from_slice(&o.to_be_bytes());
            }
            f
        };
        ttc.extend(rebase(&mono, a));
        ttc.extend(rebase(&sans, b));
        let fams = parse_fonts(&mut Cursor::new(ttc)).unwrap();
        assert_eq!(fams.len(), 2);
        assert!(fams[0].monospace && !fams[1].monospace && fams[1].name == "Test Sans");
        // Garbage is rejected, not panicked on.
        assert!(parse_fonts(&mut Cursor::new(b"not a font at all".to_vec())).unwrap_or_default().is_empty());
        let mut trunc = font(&name_table(&[(3, 1, 0x409, 1, &utf16("X"))]), true);
        trunc.truncate(30);
        assert!(parse_fonts(&mut Cursor::new(trunc)).unwrap_or_default().is_empty());
    }

    #[test]
    fn lists_real_fonts_without_panicking() {
        let all = installed();
        eprintln!(
            "{} families, {} monospace: {:?}",
            all.len(),
            all.iter().filter(|f| f.monospace).count(),
            all.iter().filter(|f| f.monospace).take(8).collect::<Vec<_>>()
        );
    }
}
