// Per-pane command status for the tab dots: blue (running), green (success),
// red (failure). A port of the Siakap plugin's TabCommandStatus.
//
// It prefers shell integration markers (OSC 133 / OSC 633: C = command started,
// D;<code> = finished), and can fall back to spotting a returned prompt and
// common error text. Everything stays in memory: no history, no logging. Typed
// text is never examined, only Enter and Ctrl+C.

export type CommandState = "idle" | "running" | "success" | "error" | "closed";

const ERROR_LINE =
  /^(?:(?:bash|zsh|sh|sudo|ssh|usbipd):\s*)?(?:error\b(?!s?\s*[:=]?\s*0\b)|fatal\b|exception\b|traceback \(most recent call last\)|%\s*(?:invalid|error|incomplete|ambiguous)|permission denied\b|access denied\b|connection (?:refused|timed out|closed)\b)/i;
const NOT_FOUND_LINE = /^(?:[\w./-]+:\s*)+(?:command not found|not found|permission denied)\b/i;
const PROMPT_END = /(?:^|\s|[\w)\]~/.:\\-])[$#>❯](?:\s*)$/;

export class TabCommandStatus {
  state: CommandState = "idle";
  detail = "";
  private line = "";
  private escape: "" | "esc" | "csi" | "osc" | "osc-end" | "osc-discard" | "discard-end" = "";
  private osc = "";
  private sawError = false;
  private reported = false;

  private change: (state: CommandState, detail: string) => void;
  fallback: boolean;

  constructor(change: (state: CommandState, detail: string) => void, fallback = true) {
    this.change = change;
    this.fallback = fallback;
  }

  reset() {
    this.state = "idle";
    this.detail = "";
    this.line = "";
    this.escape = "";
    this.osc = "";
    this.sawError = false;
    this.reported = false;
  }

  private set(state: CommandState, detail: string) {
    if (this.state === state && this.detail === detail) return;
    this.state = state;
    this.detail = detail;
    this.change(state, detail);
  }

  private begin(reported = false) {
    this.line = "";
    this.sawError = false;
    this.reported = reported;
    this.set("running", "Command running");
  }

  /** Data typed by the user (or a macro). Only Enter and Ctrl+C matter. */
  input(chunk: string) {
    if (!this.fallback) return;
    for (const ch of chunk) {
      if (ch === "\r" || ch === "\n") {
        if (this.state !== "running") this.begin();
      } else if (ch === "\x03" && this.state === "running") {
        this.line = "";
        this.sawError = true;
      }
    }
  }

  private finish(code: number) {
    this.line = "";
    this.sawError = false;
    this.reported = false;
    this.set(code === 0 ? "success" : "error", code === 0 ? "Command succeeded (exit 0)" : `Command failed (exit ${code})`);
  }

  private marker(value: string) {
    const parts = value.split(";");
    if (parts[0] !== "133" && parts[0] !== "633") return;
    if (parts[1] === "C") this.begin(true);
    if (parts[1] === "D") {
      if (/^\d+$/.test(parts[2] || "")) this.finish(Number(parts[2]));
      else {
        this.line = "";
        this.reported = false;
        this.set("idle", "Command finished; exit status unavailable");
      }
    }
    if (parts[1] === "A" && this.state === "running" && this.reported) {
      this.line = "";
      this.reported = false;
      this.set("idle", "Prompt ready; exit status unavailable");
    }
  }

  private checkError() {
    const line = this.line.trim();
    if (ERROR_LINE.test(line) || NOT_FOUND_LINE.test(line)) this.sawError = true;
  }

  /** Text received from the shell or device. */
  output(chunk: string) {
    for (const ch of chunk) {
      switch (this.escape) {
        case "osc":
          if (ch === "\x07") {
            this.marker(this.osc);
            this.osc = "";
            this.escape = "";
          } else if (ch === "\x1b") this.escape = "osc-end";
          else if (this.osc.length < 128) this.osc += ch;
          else {
            this.osc = "";
            this.escape = "osc-discard";
          }
          continue;
        case "osc-end":
          if (ch === "\\") {
            this.marker(this.osc);
            this.osc = "";
            this.escape = "";
          } else this.escape = "osc";
          continue;
        case "osc-discard":
          if (ch === "\x07") this.escape = "";
          else if (ch === "\x1b") this.escape = "discard-end";
          continue;
        case "discard-end":
          this.escape = ch === "\\" ? "" : "osc-discard";
          continue;
        case "esc":
          this.escape = ch === "]" ? "osc" : ch === "[" ? "csi" : "";
          continue;
        case "csi":
          if (/[@-~]/.test(ch)) this.escape = "";
          continue;
      }
      if (ch === "\x1b") {
        this.escape = "esc";
        continue;
      }
      if (!this.fallback || this.state !== "running") continue;
      if (ch === "\r" || ch === "\n") {
        this.checkError();
        this.line = "";
      } else if (ch >= " " && ch !== "\x7f") this.line = (this.line + ch).slice(-512);
    }
    if (!this.fallback || this.escape) return;
    if (this.state === "running") {
      this.checkError();
      if (!this.reported && PROMPT_END.test(this.line)) {
        this.set(this.sawError ? "error" : "success", this.sawError ? "Possible failure: error text detected" : "Prompt returned; success inferred");
        this.line = "";
        this.sawError = false;
      }
    }
  }

  closed() {
    this.line = "";
    this.osc = "";
    this.escape = "";
    this.reported = false;
    this.sawError = false;
    this.set("closed", "Session ended");
  }

  /** The user has seen the result: drop back to idle (keeps "running"). */
  clearNotification() {
    if (this.state === "running" || this.state === "closed") return;
    this.line = "";
    this.reported = false;
    this.sawError = false;
    this.set("idle", "");
  }
}

/** One state for a whole tab: running > error > success > closed. */
export function aggregate(states: CommandState[]): CommandState | null {
  for (const s of ["running", "error", "success", "closed"] as CommandState[]) if (states.includes(s)) return s;
  return null;
}
