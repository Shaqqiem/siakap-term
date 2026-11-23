//! Siakap-style macro scripts.
//!
//! * Each script line is sent followed by `\r`.
//! * `# @wait <ms>` pauses (0..=3_600_000 ms).
//! * `# @type <text>` sends `<text>` without Enter.
//! * Any other line starting with `#` is a comment.
//! * Empty lines inside the script send a bare Enter; trailing empty lines are
//!   ignored.
//! * `{{name}}` placeholders are prompted once per unique name.
//!
//! The frontend has an identical TypeScript port (`src/macros.ts`); both are
//! tested against the same cases.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{CoreError, Result};
use crate::model::{normalize_folder, validate_name, Macro, ValidationMode};

pub const MAX_WAIT_MS: u64 = 3_600_000;
pub const MAX_INPUT_LEN: usize = 1024;
const MAX_PLACEHOLDER_NAME: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum Step {
    /// Send text followed by `\r`.
    Line {
        text: String,
    },
    /// Send text without Enter.
    Type {
        text: String,
    },
    Wait {
        ms: u64,
    },
}

/// Parse a script into steps (placeholders are left as-is).
pub fn parse(script: &str) -> Result<Vec<Step>> {
    let mut steps = Vec::new();
    let lines: Vec<&str> = script.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect();
    let last = lines.iter().rposition(|l| !l.trim().is_empty());
    let Some(last) = last else { return Ok(steps) };
    for (i, line) in lines[..=last].iter().enumerate() {
        let n = i + 1;
        let trimmed = line.trim_start();
        if let Some(rest) = trimmed.strip_prefix('#') {
            let rest = rest.trim_start();
            if let Some(arg) = directive(rest, "@wait") {
                let ms: u64 = arg
                    .trim()
                    .parse()
                    .map_err(|_| CoreError::invalid(format!("Line {n}: @wait needs a number of milliseconds.")))?;
                if ms > MAX_WAIT_MS {
                    return Err(CoreError::invalid(format!("Line {n}: @wait is limited to 1 hour (3600000 ms).")));
                }
                steps.push(Step::Wait { ms });
            } else if let Some(arg) = directive(rest, "@type") {
                // Exactly one separating space is consumed; the rest is literal.
                let text = arg.strip_prefix(' ').unwrap_or(arg);
                if text.is_empty() {
                    return Err(CoreError::invalid(format!("Line {n}: @type needs some text.")));
                }
                steps.push(Step::Type { text: text.to_string() });
            }
            // Otherwise: comment.
            continue;
        }
        if line.chars().any(|c| c.is_control() && c != '\t') {
            return Err(CoreError::invalid(format!("Line {n} contains control characters.")));
        }
        steps.push(Step::Line { text: line.to_string() });
    }
    Ok(steps)
}

/// `rest` is the text after `#`. Matches `@wait`, `@wait 5`, but not `@waiter`.
fn directive<'a>(rest: &'a str, name: &str) -> Option<&'a str> {
    let after = rest.strip_prefix(name)?;
    if after.is_empty() || after.starts_with(' ') || after.starts_with('\t') {
        Some(after)
    } else {
        None
    }
}

fn is_name_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.'
}

/// Unique placeholder names in order of first appearance. `{{ name }}` with
/// surrounding spaces is accepted.
pub fn placeholders(script: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    scan(script, |name| {
        if !out.iter().any(|x| x == name) {
            out.push(name.to_string());
        }
        None
    });
    out
}

/// Walk `{{name}}` occurrences, letting `f` return a replacement.
fn scan(s: &str, mut f: impl FnMut(&str) -> Option<String>) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        if let Some(end) = after.find("}}") {
            let inner = after[..end].trim();
            if !inner.is_empty() && inner.len() <= MAX_PLACEHOLDER_NAME && inner.chars().all(is_name_char) {
                match f(inner) {
                    Some(v) => out.push_str(&v),
                    None => out.push_str(&rest[start..start + 2 + end + 2]),
                }
                rest = &after[end + 2..];
                continue;
            }
        }
        out.push_str("{{");
        rest = after;
    }
    out.push_str(rest);
    out
}

/// Validate a value typed by the user for a placeholder.
pub fn validate_input(value: &str, mode: ValidationMode) -> Result<()> {
    if value.is_empty() {
        return Err(CoreError::invalid("A value is required."));
    }
    if value.chars().count() > MAX_INPUT_LEN {
        return Err(CoreError::invalid(format!("Values are limited to {MAX_INPUT_LEN} characters.")));
    }
    if value.chars().any(char::is_control) {
        return Err(CoreError::invalid("Control characters (including newlines and tabs) are not allowed."));
    }
    if mode == ValidationMode::Safe
        && !value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '_' | '.' | '/' | ':' | '@' | ',' | '+' | '-'))
    {
        return Err(CoreError::invalid("Safe mode only allows letters, digits, space and _ . / : @ , + -"));
    }
    Ok(())
}

/// Substitute placeholder values into parsed steps. Single pass: a value that
/// itself contains `{{x}}` is not expanded again.
pub fn render(
    steps: &[Step],
    values: &std::collections::HashMap<String, String>,
    mode: ValidationMode,
) -> Result<Vec<Step>> {
    for v in values.values() {
        validate_input(v, mode)?;
    }
    let mut missing = None;
    let mut sub = |t: &str| {
        scan(t, |name| match values.get(name) {
            Some(v) => Some(v.clone()),
            None => {
                missing.get_or_insert_with(|| name.to_string());
                None
            }
        })
    };
    let out: Vec<Step> = steps
        .iter()
        .map(|s| match s {
            Step::Line { text } => Step::Line { text: sub(text) },
            Step::Type { text } => Step::Type { text: sub(text) },
            Step::Wait { ms } => Step::Wait { ms: *ms },
        })
        .collect();
    if let Some(m) = missing {
        return Err(CoreError::invalid(format!("No value for {{{{{m}}}}}.")));
    }
    Ok(out)
}

/// Signature used for duplicate detection: SHA-256 over the normalised script
/// (CRLF→LF, trailing whitespace per line and trailing blank lines removed).
pub fn signature(script: &str) -> String {
    let norm: Vec<&str> = script.split('\n').map(|l| l.trim_end()).collect();
    let end = norm.iter().rposition(|l| !l.is_empty()).map_or(0, |i| i + 1);
    let mut h = Sha256::new();
    h.update(norm[..end].join("\n").as_bytes());
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportFile {
    pub format: String,
    pub version: u32,
    pub macros: Vec<ExportMacro>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportMacro {
    pub name: String,
    #[serde(default)]
    pub folder: String,
    pub script: String,
    #[serde(default)]
    pub preview: bool,
}

pub fn export(macros: &[Macro]) -> Result<String> {
    let f = ExportFile {
        format: "siakap-macros".into(),
        version: 1,
        macros: macros
            .iter()
            .map(|m| ExportMacro {
                name: m.name.clone(),
                folder: m.folder.clone(),
                script: m.script.clone(),
                preview: m.preview,
            })
            .collect(),
    };
    Ok(serde_json::to_string_pretty(&f)?)
}

#[derive(Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub added: usize,
    pub duplicates: usize,
    pub invalid: usize,
}

pub const MAX_IMPORT_BYTES: usize = 4 * 1024 * 1024;

/// Parse an export (or a bare JSON array of macros) and append new macros to
/// `existing`, skipping duplicates by [`signature`].
pub fn import(json: &str, existing: &mut Vec<Macro>) -> Result<ImportReport> {
    if json.len() > MAX_IMPORT_BYTES {
        return Err(CoreError::invalid("The import file is too large."));
    }
    let list: Vec<ExportMacro> = match serde_json::from_str::<ExportFile>(json) {
        Ok(f) if f.format == "siakap-macros" => f.macros,
        Ok(_) => return Err(CoreError::format("Not a Siakap macro export.")),
        Err(_) => serde_json::from_str::<Vec<ExportMacro>>(json)
            .map_err(|_| CoreError::format("Not a Siakap macro export."))?,
    };
    let mut seen: std::collections::HashSet<String> = existing.iter().map(|m| signature(&m.script)).collect();
    let mut rep = ImportReport::default();
    for m in list {
        let (Ok(name), Ok(folder), Ok(_)) = (validate_name(&m.name), normalize_folder(&m.folder), parse(&m.script))
        else {
            rep.invalid += 1;
            continue;
        };
        if m.script.len() > 256 * 1024 {
            rep.invalid += 1;
            continue;
        }
        if !seen.insert(signature(&m.script)) {
            rep.duplicates += 1;
            continue;
        }
        existing.push(Macro { id: crate::model::new_id(), name, folder, script: m.script, preview: m.preview });
        rep.added += 1;
    }
    Ok(rep)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn line(s: &str) -> Step {
        Step::Line { text: s.into() }
    }

    #[test]
    fn parses_lines_waits_types_and_comments() {
        let s = "# comment\r\nuname -a\r\n# @wait 500\n#@type y\n#   @type   two  \nls\n\n\n";
        assert_eq!(
            parse(s).unwrap(),
            vec![
                line("uname -a"),
                Step::Wait { ms: 500 },
                Step::Type { text: "y".into() },
                Step::Type { text: "  two  ".into() },
                line("ls"),
            ]
        );
    }

    #[test]
    fn interior_blank_line_sends_enter() {
        assert_eq!(parse("a\n\nb").unwrap(), vec![line("a"), line(""), line("b")]);
        assert!(parse("").unwrap().is_empty());
        assert!(parse("\n\n  \n").unwrap().is_empty());
    }

    #[test]
    fn wait_limits() {
        assert_eq!(parse("# @wait 3600000").unwrap(), vec![Step::Wait { ms: 3_600_000 }]);
        assert!(parse("# @wait 3600001").is_err());
        assert!(parse("# @wait soon").is_err());
        assert!(parse("# @wait -1").is_err());
        // Not a directive, just a comment.
        assert!(parse("# @waiting 5").unwrap().is_empty());
        assert!(parse("# @type").is_err());
    }

    #[test]
    fn rejects_control_chars_in_lines() {
        assert!(parse("echo \u{1b}[31m").is_err());
        assert!(parse("a\tb").is_ok());
    }

    #[test]
    fn placeholders_unique_in_order() {
        let p = placeholders("ssh {{user}}@{{ host }}\necho {{user}} {{}} {{bad name}} {{x");
        assert_eq!(p, vec!["user", "host"]);
    }

    #[test]
    fn render_substitutes_single_pass() {
        let steps = parse("ping {{host}}\n# @type {{host}}").unwrap();
        let mut v = HashMap::new();
        v.insert("host".to_string(), "10.0.0.1".to_string());
        assert_eq!(
            render(&steps, &v, ValidationMode::Safe).unwrap(),
            vec![line("ping 10.0.0.1"), Step::Type { text: "10.0.0.1".into() }]
        );
        // Missing value is an error.
        assert!(render(&steps, &HashMap::new(), ValidationMode::Safe).is_err());
    }

    #[test]
    fn input_validation_safe_mode() {
        let m = ValidationMode::Safe;
        assert!(validate_input("user@host.example:22/path,a+b-c_d", m).is_ok());
        assert!(validate_input("a; rm -rf /", m).is_err());
        assert!(validate_input("$(id)", m).is_err());
        assert!(validate_input("a|b", m).is_err());
        assert!(validate_input("", m).is_err());
        assert!(validate_input("ok\n", m).is_err());
        assert!(validate_input("ünïcode", m).is_err());
    }

    #[test]
    fn input_validation_unrestricted_mode() {
        let m = ValidationMode::Unrestricted;
        assert!(validate_input("a; echo $(id) | grep 'x'", m).is_ok());
        assert!(validate_input("ünïcode", m).is_ok());
        assert!(validate_input("line\nbreak", m).is_err());
        assert!(validate_input("cr\r", m).is_err());
        assert!(validate_input("esc\u{1b}", m).is_err());
        assert!(validate_input("tab\t", m).is_err());
        assert!(validate_input("del\u{7f}", m).is_err());
        assert!(validate_input(&"a".repeat(MAX_INPUT_LEN + 1), m).is_err());
    }

    #[test]
    fn signature_ignores_line_endings_and_trailing_space() {
        assert_eq!(signature("a\r\nb  \n\n"), signature("a\nb"));
        assert_ne!(signature("a\nb"), signature("b\na"));
    }

    #[test]
    fn import_export_dedup() {
        let mut existing =
            vec![Macro { id: "1".into(), name: "a".into(), folder: "".into(), script: "ls".into(), preview: false }];
        let json = export(&existing).unwrap();
        let rep = import(&json, &mut existing).unwrap();
        assert_eq!(rep, ImportReport { added: 0, duplicates: 1, invalid: 0 });

        let arr = r#"[{"name":"b","folder":"x/y","script":"pwd"},{"name":"c","folder":"../z","script":"id"},{"name":"d","script":"pwd\r\n"}]"#;
        let rep = import(arr, &mut existing).unwrap();
        assert_eq!(rep, ImportReport { added: 1, duplicates: 1, invalid: 1 });
        assert_eq!(existing[1].folder, "x/y");
        assert!(import(r#"{"format":"other","version":1,"macros":[]}"#, &mut existing).is_err());
        assert!(import("not json", &mut existing).is_err());
    }
}
