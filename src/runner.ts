// Runs a macro against the focused pane only. Aborts if that pane closes or
// focus moves elsewhere, and every wait is cancellable.
import { icon } from "./icons";
import { api, messageOf, type Macro } from "./api";
import { describe, parse, placeholders, validateInput, MacroError } from "./macros";
import type { Pane, TabManager } from "./tabs";
import { $, confirmDialog, h, promptDialog, toast } from "./ui";

class Aborted extends Error {}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Aborted(String(signal.reason)));
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Aborted(String(signal.reason)));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export class MacroRunner {
  private current: { pane: Pane; ctl: AbortController; name: string } | null = null;

  constructor(private tabs: TabManager) {
    tabs.onFocus((p) => {
      if (this.current && p !== this.current.pane) this.stop("focus moved to another pane");
    });
    tabs.onPaneClosed((p) => {
      if (this.current?.pane === p) this.stop("the session closed");
    });
  }

  get busy() {
    return this.current !== null;
  }

  stop(reason = "stopped") {
    this.current?.ctl.abort(reason);
  }

  async run(m: Macro, target?: Pane) {
    if (this.current) {
      toast("A macro is already running.", "error");
      return;
    }
    const pane = target ?? this.tabs.focusedPane;
    if (!pane || pane.status !== "connected" || pane.termId === null) {
      toast("Focus a connected terminal pane first.", "error");
      return;
    }
    try {
      parse(m.script);
    } catch (e) {
      toast(e instanceof MacroError ? e.message : String(e), "error");
      return;
    }
    const mode = this.tabs.settings.validationMode;
    const values: Record<string, string> = {};
    for (const name of placeholders(m.script)) {
      const v = await promptDialog(`Macro: ${m.name}`, `Enter a value for "${name}"`, {
        validate: (x) => validateInput(x, mode),
        hint: mode === "safe" ? "Safe mode: letters, digits, space and _ . / : @ , + -" : "Unrestricted mode: control characters are still blocked.",
        okLabel: "Next",
      });
      if (v === null) return;
      values[name] = v;
    }
    let steps;
    try {
      steps = await api.macroRender(m.script, values);
    } catch (e) {
      toast(messageOf(e), "error");
      return;
    }
    if (m.preview) {
      const ok = await confirmDialog(`Run "${m.name}"?`, h("pre", { class: "paste-preview" }, describe(steps)), "Run");
      if (!ok) return;
    }
    if (target === undefined && this.tabs.focusedPane !== pane) {
      toast("Focus changed; macro not started.", "error");
      return;
    }
    if (pane.status !== "connected") {
      toast("The session closed; macro not started.", "error");
      return;
    }

    const ctl = new AbortController();
    this.current = { pane, ctl, name: m.name };
    const bar = $("macro-bar");
    const label = h("span", {});
    bar.replaceChildren(h("span", { class: "spinner" }), label, h("button", { onclick: () => this.stop() }, icon("stop", 12), "Stop"));
    bar.classList.remove("hidden");
    const delay = Math.max(0, this.tabs.settings.lineDelayMs);
    try {
      for (let i = 0; i < steps.length; i++) {
        const s = steps[i];
        if (ctl.signal.aborted) throw new Aborted(String(ctl.signal.reason));
        if (pane.status !== "connected" || pane.termId === null) throw new Aborted("the session closed");
        label.textContent = `Running "${m.name}", step ${i + 1} of ${steps.length}${s.op === "wait" ? ` (waiting ${s.ms} ms)` : ""}`;
        if (s.op === "wait") {
          await sleep(s.ms, ctl.signal);
        } else {
          await api.termWrite(pane.termId, s.op === "line" ? `${s.text}\r` : s.text);
          if (s.op === "line" && delay > 0 && i < steps.length - 1) await sleep(delay, ctl.signal);
        }
      }
      toast(`Macro "${m.name}" finished.`, "ok", 2500);
    } catch (e) {
      if (e instanceof Aborted) toast(`Macro "${m.name}" aborted: ${e.message}.`, "error");
      else toast(messageOf(e), "error");
    } finally {
      this.current = null;
      bar.classList.add("hidden");
      bar.replaceChildren();
    }
  }
}
