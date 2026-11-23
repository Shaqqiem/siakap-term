// Pure macro parser: a TypeScript port of core/src/macros.rs (same rules,
// same test cases in macros.test.ts). No DOM, no Tauri: unit-testable in Node.
//
//   plain line        sent followed by "\r"
//   # @wait <ms>      pause (0..3600000 ms), cancellable
//   # @type <text>    sent without Enter
//   # anything else   comment
//   interior blank    bare Enter; trailing blank lines ignored
//   {{name}}          prompted once per unique name

export type Step = { op: "line"; text: string } | { op: "type"; text: string } | { op: "wait"; ms: number };
export type ValidationMode = "safe" | "unrestricted";

export const MAX_WAIT_MS = 3_600_000;
export const MAX_INPUT_LEN = 1024;
const MAX_PLACEHOLDER_NAME = 64;

export class MacroError extends Error {}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
// eslint-disable-next-line no-control-regex
const CONTROL_EXCEPT_TAB = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/;
const SAFE = /^[A-Za-z0-9 _./:@,+-]+$/;
const NAME = /^[A-Za-z0-9_.-]+$/;

function directive(rest: string, name: string): string | null {
  if (!rest.startsWith(name)) return null;
  const after = rest.slice(name.length);
  if (after === "" || after.startsWith(" ") || after.startsWith("\t")) return after;
  return null;
}

export function parse(script: string): Step[] {
  const lines = script.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() !== "") {
      last = i;
      break;
    }
  }
  const steps: Step[] = [];
  for (let i = 0; i <= last; i++) {
    const n = i + 1;
    const line = lines[i];
    const trimmed = line.trimStart();
    if (trimmed.startsWith("#")) {
      const rest = trimmed.slice(1).trimStart();
      const wait = directive(rest, "@wait");
      if (wait !== null) {
        const t = wait.trim();
        if (!/^\d+$/.test(t)) throw new MacroError(`Line ${n}: @wait needs a number of milliseconds.`);
        const ms = Number(t);
        if (ms > MAX_WAIT_MS) throw new MacroError(`Line ${n}: @wait is limited to 1 hour (3600000 ms).`);
        steps.push({ op: "wait", ms });
        continue;
      }
      const type = directive(rest, "@type");
      if (type !== null) {
        const text = type.startsWith(" ") ? type.slice(1) : type;
        if (text === "") throw new MacroError(`Line ${n}: @type needs some text.`);
        steps.push({ op: "type", text });
      }
      continue;
    }
    if (CONTROL_EXCEPT_TAB.test(line)) throw new MacroError(`Line ${n} contains control characters.`);
    steps.push({ op: "line", text: line });
  }
  return steps;
}

function scan(s: string, f: (name: string) => string | null): string {
  let out = "";
  let rest = s;
  for (;;) {
    const start = rest.indexOf("{{");
    if (start < 0) break;
    out += rest.slice(0, start);
    const after = rest.slice(start + 2);
    const end = after.indexOf("}}");
    if (end >= 0) {
      const inner = after.slice(0, end).trim();
      if (inner !== "" && inner.length <= MAX_PLACEHOLDER_NAME && NAME.test(inner)) {
        const v = f(inner);
        out += v ?? rest.slice(start, start + 2 + end + 2);
        rest = after.slice(end + 2);
        continue;
      }
    }
    out += "{{";
    rest = after;
  }
  return out + rest;
}

/** Unique placeholder names in order of first appearance. */
export function placeholders(script: string): string[] {
  const out: string[] = [];
  scan(script, (name) => {
    if (!out.includes(name)) out.push(name);
    return null;
  });
  return out;
}

/** Returns an error message, or null if the value is acceptable. */
export function validateInput(value: string, mode: ValidationMode): string | null {
  if (value === "") return "A value is required.";
  if ([...value].length > MAX_INPUT_LEN) return `Values are limited to ${MAX_INPUT_LEN} characters.`;
  if (CONTROL.test(value)) return "Control characters (including newlines and tabs) are not allowed.";
  if (mode === "safe" && !SAFE.test(value)) return "Safe mode only allows letters, digits, space and _ . / : @ , + -";
  return null;
}

/** Substitute values (single pass) after validating each of them. */
export function render(steps: Step[], values: Record<string, string>, mode: ValidationMode): Step[] {
  for (const v of Object.values(values)) {
    const err = validateInput(v, mode);
    if (err) throw new MacroError(err);
  }
  let missing: string | null = null;
  const sub = (t: string) =>
    scan(t, (name) => {
      if (Object.prototype.hasOwnProperty.call(values, name)) return values[name];
      missing ??= name;
      return null;
    });
  const out = steps.map((s): Step => (s.op === "wait" ? { ...s } : { op: s.op, text: sub(s.text) }));
  if (missing !== null) throw new MacroError(`No value for {{${missing}}}.`);
  return out;
}

/** Human-readable preview of rendered steps. */
export function describe(steps: Step[]): string {
  return steps
    .map((s) => (s.op === "wait" ? `wait  ${s.ms} ms` : s.op === "type" ? `type  ${s.text}` : `send  ${s.text}`))
    .join("\n");
}
