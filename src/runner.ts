// Runs a macro against one pane: the focused one, or the one it was started
// for. Like the Siakap plugin:
//   * named inputs are asked for in one form, with paste buttons, the example
//     value as a hint, and a live command preview;
//   * "Edit the whole command before run" (or the global "review every macro"
//     setting) lets the user change the commands for this run only;
//   * it stops if that pane closes or focus moves elsewhere, and every wait can
//     be cancelled.
import { api, messageOf, type Macro } from "./api";
import { loader } from "./loader";
import { icon } from "./icons";
import { check, fill, inputNames, MacroError, validateInput } from "./macros";
import type { Pane, TabManager } from "./tabs";
import { $, h, modal, toast } from "./ui";

class Aborted extends Error {}

export type RunnableMacro = Pick<Macro, "name" | "script"> & Partial<Pick<Macro, "editBeforeRun" | "parameterDefaults">>;

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

async function pasteInto(el: HTMLInputElement | HTMLTextAreaElement, what: string) {
  try {
    const text = await api.clipboardRead();
    if (!text) return toast("The clipboard does not contain text.", "error");
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    el.value = el.value.slice(0, start) + text + el.value.slice(end);
    el.selectionStart = el.selectionEnd = start + text.length;
    el.dispatchEvent(new Event("input"));
    el.focus();
    toast(`Clipboard text inserted into ${what}. Review it before continuing.`, "info", 2500);
  } catch {
    toast("Clipboard access is unavailable.", "error");
  }
}

/** A paste-from-clipboard button for a text field. */
export function pasteButton(el: HTMLInputElement | HTMLTextAreaElement, what: string): HTMLButtonElement {
  return h("button", { type: "button", class: "tool", title: `Paste clipboard into ${what}`, onclick: () => void pasteInto(el, what) }, icon("paste", 15));
}

export class MacroRunner {
  private current: { pane: Pane; ctl: AbortController; name: string } | null = null;

  constructor(private tabs: TabManager) {
    tabs.onFocus((p) => {
      if (this.current && p !== this.current.pane) this.stop("focus moved to another pane");
    });
    tabs.onPaneClosed((p) => {
      if (this.current?.pane === p) this.stop("the target session closed");
    });
  }

  get busy() {
    return this.current !== null;
  }

  stop(reason = "stopped") {
    this.current?.ctl.abort(reason);
  }

  /** Run a macro. `target` pins the pane (startup commands); otherwise the focused pane is used. */
  async run(m: RunnableMacro, target?: Pane, opts: { approved?: boolean; quiet?: boolean } = {}): Promise<boolean> {
    if (this.current) {
      toast("A macro is already running. Stop it before starting another.", "error");
      return false;
    }
    const pane = target ?? this.tabs.focusedPane;
    if (!pane || pane.status !== "connected" || pane.termId === null) {
      toast("Select an open terminal first: click into the terminal you want the macro to type into.", "error");
      return false;
    }
    try {
      check(m.script);
    } catch (e) {
      toast(e instanceof MacroError ? e.message : String(e), "error");
      return false;
    }
    let script = m.script;
    let values: Record<string, string> = {};
    const names = inputNames(m.script);
    if (!opts.approved && (m.editBeforeRun || names.length || this.tabs.settings.reviewAll)) {
      const r = await this.runDialog(m, pane, names);
      if (!r) {
        toast("Run cancelled. No commands sent.", "info", 2500);
        return false;
      }
      ({ script, values } = r);
    }
    if (pane.status !== "connected" || pane.disposed) {
      toast("The target session changed. Run the macro again.", "error");
      return false;
    }
    let steps;
    try {
      steps = await api.macroRender(script, values);
    } catch (e) {
      toast(messageOf(e), "error");
      return false;
    }

    const ctl = new AbortController();
    this.current = { pane, ctl, name: m.name };
    const bar = $("macro-bar");
    const label = h("span", {});
    bar.replaceChildren(loader(13), label, h("button", { onclick: () => this.stop() }, icon("stop", 12), "Stop macro"));
    bar.classList.remove("hidden");
    const delay = Math.max(0, this.tabs.settings.lineDelayMs);
    try {
      for (let i = 0; i < steps.length; i++) {
        const s = steps[i];
        if (ctl.signal.aborted) throw new Aborted(String(ctl.signal.reason));
        if (pane.status !== "connected" || pane.termId === null) throw new Aborted("the target session closed");
        label.textContent = `Running "${m.name}" in ${pane.title}: step ${i + 1} of ${steps.length}${s.op === "wait" ? ` (waiting ${s.ms} ms)` : ""}`;
        if (s.op === "wait") {
          await sleep(s.ms, ctl.signal);
        } else {
          const text = s.op === "line" ? `${s.text}\r` : s.text;
          await api.termWrite(pane.termId, text);
          this.tabs.noteInput(pane, text);
          // Pause between commands only, so the macro is finished as soon as the last one is sent.
          if (i < steps.length - 1) await sleep(s.op === "line" ? delay : 50, ctl.signal);
        }
      }
      if (!opts.quiet) toast("Macro sent.", "ok", 2000);
      return true;
    } catch (e) {
      if (e instanceof Aborted) toast(ctl.signal.reason === "stopped" ? "Macro stopped." : `Macro stopped: ${e.message}.`, "info");
      else toast(messageOf(e), "error");
      return false;
    } finally {
      this.current = null;
      bar.classList.add("hidden");
      bar.replaceChildren();
    }
  }

  /** Ask for named inputs and/or let the user edit the commands. */
  private runDialog(m: RunnableMacro, pane: Pane, names: string[]): Promise<{ script: string; values: Record<string, string> } | null> {
    const mode = this.tabs.settings.validationMode;
    const editable = Boolean(m.editBeforeRun) || (!names.length && this.tabs.settings.reviewAll);
    return modal<{ script: string; values: Record<string, string> } | null>(
      names.length ? m.name : "Edit before run",
      (close) => {
        const err = h("div", { class: "error" });
        const fields: [string, HTMLInputElement][] = [];
        const rows: HTMLElement[] = [];
        for (const name of names) {
          const input = h("input", { "data-input": name, autocomplete: "off", spellcheck: "false", placeholder: m.parameterDefaults?.[name] ?? "" });
          fields.push([name, input]);
          rows.push(h("label", { class: "field" }, h("span", {}, name), h("div", { class: "inline" }, input, pasteButton(input, name))));
        }
        const preview = h("textarea", { rows: Math.min(12, Math.max(3, m.script.split("\n").length + 1)), class: "mono", spellcheck: "false" });
        preview.readOnly = !editable;
        preview.value = m.script;
        let previewEdited = false;
        preview.addEventListener("input", () => (previewEdited = true));
        const update = () => {
          if (previewEdited) return; // keep the user's own edits
          preview.value = fill(m.script, Object.fromEntries(fields.filter(([, f]) => f.value).map(([n, f]) => [n, f.value])));
        };
        const submit = () => {
          err.textContent = "";
          const missing = fields.find(([, f]) => !f.value.trim());
          if (missing) {
            missing[1].focus();
            return void (err.textContent = `Enter ${missing[0]}.`);
          }
          for (const [, f] of fields) {
            const e = validateInput(f.value, mode);
            if (e) {
              f.focus();
              return void (err.textContent = e);
            }
          }
          if (pane.status !== "connected" || pane.disposed) return void (err.textContent = "The target session changed. Cancel and run again.");
          const values = Object.fromEntries(fields.map(([n, f]) => [n, f.value]));
          const script = editable ? preview.value : m.script;
          if (!script.trim()) return void (err.textContent = "Enter at least one command.");
          close({ script, values });
        };
        for (const [, f] of fields) {
          f.addEventListener("input", update);
          f.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && !e.isComposing && !e.repeat) {
              e.preventDefault();
              submit();
            }
          });
        }
        const hint = names.length
          ? `Enter the value${names.length > 1 ? "s" : ""}, then click Run or press Enter. Runs in ${pane.title}.`
          : `Change anything you need for this run. Nothing is sent until you click Run, and your saved macro stays unchanged. Runs in ${pane.title}.`;
        return {
          body: h(
            "div",
            { class: "form" },
            h("p", { class: "muted small" }, hint),
            ...rows,
            h(
              "label",
              { class: "field" },
              h("span", {}, names.length ? "Command preview" : "Commands for this run"),
              preview,
              editable && names.length ? h("small", { class: "muted" }, "You can also edit the commands above for this run.") : null,
            ),
            err,
          ),
          actions: [h("button", { onclick: () => close(null) }, "Cancel"), h("button", { class: "primary", onclick: submit }, "Run")],
          focus: fields[0]?.[1] ?? preview,
        };
      },
      { dismissValue: null, wide: true },
    );
  }
}
