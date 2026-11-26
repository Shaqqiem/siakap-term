// Diagnostics for "Report a problem": a short, in-memory list of what went
// wrong in this run of the app (failed commands, error messages, crashes,
// terminals opening and closing). It is never written to disk or sent anywhere;
// it only ends up in a report when the user saves or copies one.
// Never record terminal data, typed text, passwords, keys or command arguments.

export interface DiagEvent {
  t: number;
  kind: "error" | "warn" | "info";
  text: string;
}

const MAX = 500;
const events: DiagEvent[] = [];
const started = Date.now();

export function record(kind: DiagEvent["kind"], text: string) {
  const clean = String(text)
    // Control characters would garble the report.
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ")
    .slice(0, 1000);
  const last = events[events.length - 1];
  if (last && last.text === clean && last.kind === kind) return; // the same thing again
  events.push({ t: Date.now(), kind, text: clean });
  if (events.length > MAX) events.splice(0, events.length - MAX);
}

export function diagEvents(): readonly DiagEvent[] {
  return events;
}

export function appStarted() {
  return started;
}

function describe(v: unknown): string {
  if (v instanceof Error) return `${v.name}: ${v.message}${v.stack ? `\n${v.stack.split("\n").slice(1, 6).join("\n")}` : ""}`;
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

let installed = false;
/** Catch uncaught errors and console errors/warnings. `onCrash` is told about uncaught ones. */
export function installDiag(onCrash?: (msg: string) => void) {
  if (installed) return;
  installed = true;
  window.addEventListener("error", (e) => {
    const msg = `Uncaught ${describe(e.error ?? e.message)}${e.filename ? ` (${e.filename.split("/").pop()}:${e.lineno})` : ""}`;
    record("error", msg);
    onCrash?.(msg);
  });
  window.addEventListener("unhandledrejection", (e) => {
    const msg = `Unhandled promise rejection: ${describe(e.reason)}`;
    record("error", msg);
    onCrash?.(msg);
  });
  for (const level of ["error", "warn"] as const) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      record(level, `console.${level}: ${args.map(describe).join(" ")}`);
      orig(...args);
    };
  }
}

export interface Redactor {
  /** Server names and user names from saved sessions. */
  words: string[];
  home?: string;
}

/** Hide server names, user names, IP and e-mail addresses and the home folder. */
export function redact(text: string, r: Redactor): string {
  let out = text;
  if (r.home && r.home.length > 3) out = out.split(r.home).join("<home>");
  // Windows user folder even if the home path wasn't known.
  out = out.replace(/([A-Za-z]:\\Users\\)[^\\\s"']+/g, "$1<user>").replace(/(\/home\/|\/Users\/)[^/\s"']+/g, "$1<user>");
  out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>");
  out = out.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "<ip>");
  // IPv6 (three or more colon groups; times such as 12:30:45 are kept).
  out = out.replace(/(?<![\w:])[0-9a-fA-F]{0,4}(?::[0-9a-fA-F]{0,4}){2,7}(?![\w:])/g, (m) => (/^\d{1,2}:\d{2}(:\d{2})?$/.test(m) ? m : "<ip>"));
  // Longest first so "db.example.com" goes before "db".
  const words = [...new Set(r.words.map((w) => w.trim()).filter((w) => w.length >= 2))].sort((a, b) => b.length - a.length);
  words.forEach((w, i) => {
    const esc = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`(^|[^A-Za-z0-9_-])${esc}(?![A-Za-z0-9_-])`, "gi"), `$1<name${i + 1}>`);
  });
  return out;
}

function stamp(t: number) {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** The report as plain text. `info` comes from the backend (diag_info). */
export function buildReport(what: string, info: Record<string, unknown>, evs: readonly DiagEvent[], extra: Record<string, unknown> = {}): string {
  const lines: string[] = [];
  lines.push("Siakap Terminal problem report");
  lines.push(`Created: ${stamp(Date.now())} (UTC${-new Date().getTimezoneOffset() >= 0 ? "+" : ""}${-new Date().getTimezoneOffset() / 60})`);
  lines.push("");
  lines.push("## What happened");
  lines.push(what.trim() || "(not described)");
  lines.push("");
  lines.push("## App and system");
  const all = { ...info, ...extra };
  for (const [k, v] of Object.entries(all)) {
    if (k === "settings" || k === "crashes") continue;
    lines.push(`${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
  }
  lines.push("");
  lines.push(`## Recent events (${evs.length}, oldest first, since ${stamp(appStarted())})`);
  if (!evs.length) lines.push("(none)");
  for (const e of evs) lines.push(`${stamp(e.t)} ${e.kind.toUpperCase().padEnd(5)} ${e.text}`);
  const crashes = info.crashes as string[] | undefined;
  if (crashes?.length) {
    lines.push("");
    lines.push("## Backend crashes");
    lines.push(...crashes);
  }
  if (info.settings) {
    lines.push("");
    lines.push("## Settings");
    lines.push(JSON.stringify(info.settings, null, 2));
  }
  lines.push("");
  lines.push("Not included: terminal output, what you typed, passwords, keys, macros' contents and saved sessions' details.");
  return lines.join("\n");
}
