// Pure macro parser: a TypeScript port of core/src/macros.rs (same rules as the
// Siakap 2.1.15 Tabby plugin; same test cases in macros.test.ts). No DOM, no
// Tauri: unit-testable in Node.
//
//   plain line        sent followed by "\r" (blank lines are skipped)
//   # @wait <ms>      pause (0..3600000 ms), cancellable
//   # @type <text>    sent without Enter
//   # anything else   comment
//   {{Switch port}}   named input, asked once per run (names may contain spaces)
//
// Inputs are filled in before parsing, so `# @wait {{delay}}` works.

export type Step = { op: "line"; text: string } | { op: "type"; text: string } | { op: "wait"; ms: number };
export type ValidationMode = "safe" | "unrestricted";

export const MAX_WAIT_MS = 3_600_000;
export const MAX_INPUT_LEN = 1024;
export const MAX_INPUT_NAME = 80;

export class MacroError extends Error {}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
// eslint-disable-next-line no-control-regex
const CONTROL_EXCEPT_TAB = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/;
const SAFE = /^[A-Za-z0-9 _./:@,+-]+$/;
const INPUT = /\{\{([^{}\r\n]+)\}\}/g;

function directive(rest: string, name: string): string | null {
  if (!rest.startsWith(name)) return null;
  const after = rest.slice(name.length);
  if (after === "" || after.startsWith(" ") || after.startsWith("\t")) return after;
  return null;
}

/** Parse a filled-in script into steps. */
export function parse(script: string): Step[] {
  const steps: Step[] = [];
  script.split("\n").forEach((raw, i) => {
    const n = i + 1;
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.trim() === "") return;
    const trimmed = line.trimStart();
    if (trimmed.startsWith("#")) {
      const rest = trimmed.slice(1).trimStart();
      const wait = directive(rest, "@wait");
      if (wait !== null) {
        const t = wait.trim();
        if (!/^\d+$/.test(t)) throw new MacroError(`Line ${n}: @wait needs a number of milliseconds.`);
        const ms = Number(t);
        if (ms > MAX_WAIT_MS) throw new MacroError(`Line ${n}: a pause must be one hour (3600000 ms) or less.`);
        steps.push({ op: "wait", ms });
        return;
      }
      const type = directive(rest, "@type");
      if (type !== null) {
        const text = type.startsWith(" ") ? type.slice(1) : type;
        if (text === "") throw new MacroError(`Line ${n}: @type needs some text.`);
        steps.push({ op: "type", text });
      }
      return;
    }
    if (CONTROL_EXCEPT_TAB.test(line)) throw new MacroError(`Line ${n} contains control characters.`);
    steps.push({ op: "line", text: line });
  });
  return steps;
}

/** Unique input names in order of first appearance (trimmed). */
export function inputNames(script: string): string[] {
  const out: string[] = [];
  for (const m of script.matchAll(INPUT)) {
    const name = m[1].trim();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/** Returns an error message, or null if the value is acceptable. */
export function validateInput(value: string, mode: ValidationMode): string | null {
  if (value.trim() === "") return "A value is required.";
  if ([...value].length > MAX_INPUT_LEN) return `Values are limited to ${MAX_INPUT_LEN} characters.`;
  if (CONTROL.test(value)) return "Control characters (including newlines and tabs) are not allowed.";
  if (mode === "safe" && !SAFE.test(value))
    return "Use letters, digits, spaces, or _ . / : @ , + - for input values. Shell operators and control characters are blocked.";
  return null;
}

/** Returns an error message for a "Make input" name, or null. */
export function validateInputName(name: string): string | null {
  const n = name.trim();
  if (!n || [...n].length > MAX_INPUT_NAME || /[{}\r\n]/.test(n)) return "Enter an input name, such as Switch port (up to 80 characters).";
  return null;
}

/** Fill values into the script (single pass). Missing values stay as {{name}} unless `strict`. */
export function fill(script: string, values: Record<string, string>, strict = false): string {
  let missing: string | null = null;
  const out = script.replace(INPUT, (whole, raw: string) => {
    const name = raw.trim();
    if (!name) return whole;
    if (Object.prototype.hasOwnProperty.call(values, name)) return values[name];
    missing ??= name;
    return whole;
  });
  if (strict && missing !== null) throw new MacroError(`Enter ${missing}.`);
  return out;
}

/** Validate values, fill them in and parse: the steps that will be sent. */
export function render(script: string, values: Record<string, string>, mode: ValidationMode): Step[] {
  for (const v of Object.values(values)) {
    const err = validateInput(v, mode);
    if (err) throw new MacroError(err);
  }
  return parse(fill(script, values, true));
}

/** Check a saved script, with every input filled by a placeholder value. */
export function check(script: string): void {
  parse(fill(script, Object.fromEntries(inputNames(script).map((n) => [n, "1"]))));
}

/** Same as the plugin's macroSignature: folder | script with generic inputs, collapsed whitespace. */
export function signature(folder: string, script: string): string {
  const generic = script.replace(INPUT, (whole, raw: string) => (raw.trim() ? "{{input}}" : whole));
  return `${folder.toLowerCase()}|${generic.split(/\s+/).filter(Boolean).join(" ").toLowerCase()}`;
}

/** Human-readable preview of rendered steps. */
export function describe(steps: Step[]): string {
  return steps.map((s) => (s.op === "wait" ? `# @wait ${s.ms}` : s.op === "type" ? `# @type ${s.text}` : s.text)).join("\n");
}
