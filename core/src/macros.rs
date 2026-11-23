//! Siakap macro scripts (same rules as the Siakap 2.1.15 Tabby plugin).
//!
//! * Each non-empty line is sent followed by `\r`. Blank lines are skipped.
//! * `# @wait <ms>` pauses (0..=3_600_000 ms).
//! * `# @type <text>` sends `<text>` without Enter.
//! * `# @key <name>` presses a key: enter, tab, up, down, left, right, esc,
//!   backspace, home, end, pageup, pagedown, delete, ctrl+c, ctrl+d, ...
//! * The `#` is optional and spacing/case are forgiving: `@wait 100`,
//!   `@ wait 100`, `#@WAIT 100` all pause. Other lines starting with `@`
//!   (such as cmd's `@echo off`) are sent as normal commands.
//! * Any other line starting with `#` is a comment.
//! * `{{name}}` is a named input, prompted once per unique name. Names may
//!   contain spaces (`{{Switch port}}`), up to 80 characters.
//!
//! Inputs are filled in *before* the script is parsed, exactly like the
//! plugin, so `# @wait {{delay}}` works. Input values can never contain control
//! characters, so a value cannot add an extra Enter.
//!
//! The frontend has an identical TypeScript port (`src/macros.ts`); both are
//! tested against the same cases.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::error::{CoreError, Result};
use crate::model::ValidationMode;

pub const MAX_WAIT_MS: u64 = 3_600_000;
pub const MAX_INPUT_LEN: usize = 1024;
pub const MAX_INPUT_NAME: usize = 80;

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

/// Parse a (filled-in) script into steps.
pub fn parse(script: &str) -> Result<Vec<Step>> {
    let mut steps = Vec::new();
    for (i, raw) in script.split('\n').enumerate() {
        let n = i + 1;
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        if line.trim().is_empty() {
            continue;
        }
        let trimmed = line.trim_start();
        // "# @wait 100" (Siakap's form), plus the forgiving spellings people
        // actually type: "#@wait 100", "@wait 100", "@ wait 100", "@WAIT 100".
        let (commented, body) = match trimmed.strip_prefix('#') {
            Some(rest) => (true, rest.trim_start()),
            None => (false, trimmed),
        };
        if let Some(after_at) = body.strip_prefix('@') {
            let after_at = after_at.trim_start();
            if let Some(arg) = directive(after_at, "wait") {
                let ms: u64 = arg.trim().parse().map_err(|_| {
                    CoreError::invalid(format!("Line {n}: @wait needs a number of milliseconds, e.g. @wait 1000."))
                })?;
                if ms > MAX_WAIT_MS {
                    return Err(CoreError::invalid(format!(
                        "Line {n}: a pause must be one hour (3600000 ms) or less."
                    )));
                }
                steps.push(Step::Wait { ms });
                continue;
            }
            if let Some(arg) = directive(after_at, "key") {
                let name = arg.trim();
                let seq = key_sequence(name).ok_or_else(|| {
                    CoreError::invalid(format!("Line {n}: unknown key \"{name}\". Use e.g. @key enter, tab, up, down, left, right, esc, backspace, ctrl+c."))
                })?;
                steps.push(Step::Type { text: seq.to_string() });
                continue;
            }
            if let Some(arg) = directive(after_at, "type") {
                // Exactly one separating space is consumed; the rest is literal.
                let text = arg.strip_prefix(' ').unwrap_or(arg);
                if text.is_empty() {
                    return Err(CoreError::invalid(format!("Line {n}: @type needs some text, e.g. @type y.")));
                }
                steps.push(Step::Type { text: text.to_string() });
                continue;
            }
        }
        if commented {
            continue; // any other # line is a note
        }
        if line.chars().any(|c| c.is_control() && c != '\t') {
            return Err(CoreError::invalid(format!("Line {n} contains control characters.")));
        }
        steps.push(Step::Line { text: line.to_string() });
    }
    Ok(steps)
}

/// Keys for `@key <name>` (case-insensitive), as the bytes a terminal sends.
pub fn key_sequence(name: &str) -> Option<&'static str> {
    Some(match name.to_ascii_lowercase().replace(['-', '_', ' '], "+").as_str() {
        "enter" | "return" => "\r",
        "tab" => "\t",
        "esc" | "escape" => "\x1b",
        "space" => " ",
        "backspace" | "bksp" => "\x7f",
        "up" => "\x1b[A",
        "down" => "\x1b[B",
        "right" => "\x1b[C",
        "left" => "\x1b[D",
        "home" => "\x1b[H",
        "end" => "\x1b[F",
        "pageup" | "pgup" => "\x1b[5~",
        "pagedown" | "pgdn" => "\x1b[6~",
        "delete" | "del" => "\x1b[3~",
        "insert" | "ins" => "\x1b[2~",
        "ctrl+c" => "\x03",
        "ctrl+d" => "\x04",
        "ctrl+z" => "\x1a",
        "ctrl+l" => "\x0c",
        "ctrl+a" => "\x01",
        "ctrl+e" => "\x05",
        "ctrl+u" => "\x15",
        "ctrl+r" => "\x12",
        "ctrl+]" => "\x1d",
        _ => return None,
    })
}

/// `rest` is the text after `#`. Matches `@wait`, `@wait 5`, but not `@waiter`.
fn directive<'a>(rest: &'a str, name: &str) -> Option<&'a str> {
    // Case-insensitive keyword ("wait", "WAIT").
    let head = rest.get(..name.len())?;
    if !head.eq_ignore_ascii_case(name) {
        return None;
    }
    let after = &rest[name.len()..];
    if after.is_empty() || after.starts_with(' ') || after.starts_with('\t') {
        Some(after)
    } else {
        None
    }
}

/// Walk `{{name}}` occurrences (name: no braces or newlines), letting `f`
/// return a replacement. Names are trimmed.
fn scan(s: &str, mut f: impl FnMut(&str) -> Option<String>) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        // The name runs to the first "}}" and may not contain braces or newlines.
        let end = after.find(['{', '}', '\r', '\n']);
        if let Some(end) = end {
            if after[end..].starts_with("}}") && end > 0 {
                let name = after[..end].trim();
                if !name.is_empty() {
                    match f(name) {
                        Some(v) => out.push_str(&v),
                        None => out.push_str(&rest[start..start + 2 + end + 2]),
                    }
                    rest = &after[end + 2..];
                    continue;
                }
            }
        }
        out.push_str("{{");
        rest = after;
    }
    out.push_str(rest);
    out
}

/// Unique input names in order of first appearance.
pub fn input_names(script: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    scan(script, |name| {
        if !out.iter().any(|x| x == name) {
            out.push(name.to_string());
        }
        None
    });
    out
}

/// Validate an input name chosen with "Make input".
pub fn validate_input_name(name: &str) -> Result<String> {
    let n = name.trim();
    if n.is_empty() || n.chars().count() > MAX_INPUT_NAME || n.contains(['{', '}', '\r', '\n']) {
        return Err(CoreError::invalid("Enter an input name, such as Switch port (up to 80 characters)."));
    }
    Ok(n.to_string())
}

/// Validate a value typed for a named input.
pub fn validate_input(value: &str, mode: ValidationMode) -> Result<()> {
    if value.trim().is_empty() {
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
        return Err(CoreError::invalid(
            "Use letters, digits, spaces, or _ . / : @ , + - for input values. Shell operators and control characters are blocked.",
        ));
    }
    Ok(())
}

/// Fill named inputs into the script (single pass: a value containing
/// `{{x}}` is not expanded again). Every name must have a value.
pub fn fill(script: &str, values: &HashMap<String, String>, mode: ValidationMode) -> Result<String> {
    for v in values.values() {
        validate_input(v, mode)?;
    }
    let mut missing = None;
    let out = scan(script, |name| match values.get(name) {
        Some(v) => Some(v.clone()),
        None => {
            missing.get_or_insert_with(|| name.to_string());
            None
        }
    });
    if let Some(m) = missing {
        return Err(CoreError::invalid(format!("Enter {m}.")));
    }
    Ok(out)
}

/// Fill inputs, then parse: the steps that will actually be sent.
pub fn render(script: &str, values: &HashMap<String, String>, mode: ValidationMode) -> Result<Vec<Step>> {
    parse(&fill(script, values, mode)?)
}

/// Check a saved script is valid, with every input filled by a placeholder
/// value (so `# @wait {{delay}}` is accepted).
pub fn check(script: &str) -> Result<()> {
    let dummy: HashMap<String, String> = input_names(script).into_iter().map(|n| (n, "1".to_string())).collect();
    parse(&fill(script, &dummy, ValidationMode::Unrestricted)?)?;
    Ok(())
}

/// Duplicate-detection signature, identical to the plugin's `macroSignature`:
/// lower-cased folder, `|`, then the script with every input replaced by
/// `{{input}}`, whitespace collapsed, trimmed and lower-cased.
pub fn signature(folder: &str, script: &str) -> String {
    let generic = scan(script, |_| Some("{{input}}".into()));
    let collapsed = generic.split_whitespace().collect::<Vec<_>>().join(" ");
    format!("{}|{}", folder.to_lowercase(), collapsed.to_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(s: &str) -> Step {
        Step::Line { text: s.into() }
    }
    fn vals(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn parses_lines_waits_types_and_comments() {
        let s = "# comment\r\nuname -a\r\n# @wait 500\n#@type y\n#   @type   two  \n\nls\n\n\n";
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
    fn blank_lines_are_skipped_like_the_plugin() {
        assert_eq!(parse("a\n\n  \nb").unwrap(), vec![line("a"), line("b")]);
        assert!(parse("").unwrap().is_empty());
    }

    #[test]
    fn forgiving_directive_spellings() {
        for w in ["# @wait 100", "#@wait 100", "@wait 100", "@ wait 100", "  @WAIT 100", "# @ Wait 100"] {
            assert_eq!(parse(w).unwrap(), vec![Step::Wait { ms: 100 }], "{w}");
        }
        assert_eq!(parse("@type y").unwrap(), vec![Step::Type { text: "y".into() }]);
        assert_eq!(parse("@ type yes please").unwrap(), vec![Step::Type { text: "yes please".into() }]);
        // Real commands that start with @ are still sent.
        assert_eq!(parse("@echo off").unwrap(), vec![line("@echo off")]);
        assert_eq!(parse("@{a=1}").unwrap(), vec![line("@{a=1}")]);
        assert!(parse("@wait soon").is_err());
        assert!(parse("@ wait").is_err());
    }

    #[test]
    fn keys() {
        assert_eq!(
            parse("@key tab\n# @key UP\n@key ctrl+c\n@key Ctrl-D").unwrap(),
            vec![
                Step::Type { text: "\t".into() },
                Step::Type { text: "\x1b[A".into() },
                Step::Type { text: "\x03".into() },
                Step::Type { text: "\x04".into() },
            ]
        );
        assert!(parse("@key flux").is_err());
        assert!(parse("@key").is_err());
    }

    #[test]
    fn wait_limits() {
        assert_eq!(parse("# @wait 3600000").unwrap(), vec![Step::Wait { ms: 3_600_000 }]);
        assert!(parse("# @wait 3600001").is_err());
        assert!(parse("# @wait soon").is_err());
        assert!(parse("# @wait -1").is_err());
        assert!(parse("# @waiting 5").unwrap().is_empty());
        assert!(parse("# @type").is_err());
    }

    #[test]
    fn rejects_control_chars_in_lines() {
        assert!(parse("echo \u{1b}[31m").is_err());
        assert!(parse("a\tb").is_ok());
    }

    #[test]
    fn input_names_allow_spaces_and_are_unique() {
        let p = input_names("int {{Switch port}}\ndesc {{ Switch port }} {{vlan}} {{}} {{a{b}} {{x\ny}}");
        assert_eq!(p, vec!["Switch port", "vlan"]);
    }

    #[test]
    fn fill_then_parse() {
        let steps = render(
            "ping {{host}}\n# @wait {{delay}}\n# @type {{host}}",
            &vals(&[("host", "10.0.0.1"), ("delay", "250")]),
            ValidationMode::Safe,
        )
        .unwrap();
        assert_eq!(steps, vec![line("ping 10.0.0.1"), Step::Wait { ms: 250 }, Step::Type { text: "10.0.0.1".into() }]);
        let e = render("ping {{host}}", &HashMap::new(), ValidationMode::Safe).unwrap_err();
        assert!(e.to_string().contains("host"));
        // Single pass.
        assert_eq!(fill("{{a}}", &vals(&[("a", "{{a}}")]), ValidationMode::Unrestricted).unwrap(), "{{a}}");
    }

    #[test]
    fn input_validation_safe_mode() {
        let m = ValidationMode::Safe;
        assert!(validate_input("user@host.example:22/path,a+b-c_d", m).is_ok());
        for bad in ["a; rm -rf /", "$(id)", "a|b", "", "   ", "ok\n", "ünïcode"] {
            assert!(validate_input(bad, m).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn input_validation_unrestricted_mode() {
        let m = ValidationMode::Unrestricted;
        assert!(validate_input("a; echo $(id) | grep 'x'", m).is_ok());
        assert!(validate_input("ünïcode", m).is_ok());
        for bad in ["line\nbreak", "cr\r", "esc\u{1b}", "tab\t", "del\u{7f}"] {
            assert!(validate_input(bad, m).is_err(), "{bad:?}");
        }
        assert!(validate_input(&"a".repeat(MAX_INPUT_LEN + 1), m).is_err());
    }

    #[test]
    fn input_name_rules() {
        assert_eq!(validate_input_name(" Switch port ").unwrap(), "Switch port");
        assert!(validate_input_name("").is_err());
        assert!(validate_input_name("a{b").is_err());
        assert!(validate_input_name(&"x".repeat(81)).is_err());
    }

    #[test]
    fn check_accepts_inputs_in_waits() {
        assert!(check("# @wait {{delay}}\nshow {{x}}").is_ok());
        assert!(check("# @wait soon").is_err());
    }

    #[test]
    fn signature_matches_plugin_rules() {
        assert_eq!(signature("NCP/NV", "show  int {{port}}\r\n"), "ncp/nv|show int {{input}}");
        assert_eq!(signature("", "show int {{a}}"), signature("", "SHOW INT {{other}}"));
        assert_ne!(signature("a", "ls"), signature("b", "ls"));
    }
}
