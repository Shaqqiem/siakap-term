// Macros panel (port + improvement of the Siakap plugin's macro sidebar):
// folders with drag and drop, folder menus (add macro here / add subfolder /
// rename / delete), duplicate, search across all folders (optionally inside
// commands), saved-order or name sorting, single/double click to run, and
// backups in the Siakap format.
import { api, messageOf, type ImportReport, type Macro } from "./api";
import { icon } from "./icons";
import { check, explain, inputNames, MacroError, validateInputName } from "./macros";
import { pasteButton, type MacroRunner } from "./runner";
import type { Sidebar } from "./sidebar";
import { $, confirmDialog, field, fill as fillEl, h, modal, select, showMenu, toast, type MenuEntry } from "./ui";

const CLOSED_KEY = "siakap.closedMacroFolders";

function loadClosed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(CLOSED_KEY) || "[]"));
  } catch {
    return new Set();
  }
}

interface FolderNode {
  name: string;
  path: string;
  children: Map<string, FolderNode>;
  items: Macro[];
}

export class MacroPanel {
  private query = "";
  private closed = loadClosed();
  private dragged: string | null = null;

  constructor(private sb: Sidebar, private runner: MacroRunner) {}

  private get settings() {
    return this.sb.tabs.settings;
  }

  private saveClosed() {
    try {
      localStorage.setItem(CLOSED_KEY, JSON.stringify([...this.closed]));
    } catch {
      /* per-device convenience only */
    }
  }

  /** Every folder path that exists (explicit folders plus macros' folders and their parents). */
  allFolders(): string[] {
    const out = new Set<string>();
    for (const p of [...this.sb.macroFolders, ...this.sb.macros.map((m) => m.folder)]) {
      const parts = p.split("/").filter(Boolean);
      for (let i = 1; i <= parts.length; i++) out.add(parts.slice(0, i).join("/"));
    }
    return [...out].sort((a, b) => a.localeCompare(b));
  }

  private sorted(list: Macro[]): Macro[] {
    if (this.settings?.macroSort === "name") return [...list].sort((a, b) => a.name.localeCompare(b.name));
    return list; // saved order
  }

  render() {
    const panel = $("panel-macros");
    const q = this.query.trim().toLowerCase();
    const inCommands = this.settings?.searchInCommands ?? true;
    const search = h("input", { type: "search", placeholder: "Search all macro folders", value: this.query, spellcheck: "false" });
    search.addEventListener("input", () => {
      this.query = search.value;
      this.render();
      const s = panel.querySelector("input[type=search]") as HTMLInputElement;
      s.focus();
      s.setSelectionRange(s.value.length, s.value.length);
    });

    const body = h("div", { class: "macro-list" });
    if (q) {
      const hits = this.sorted(this.sb.macros).filter((m) => [m.name, m.folder, inCommands ? m.script : ""].some((x) => x.toLowerCase().includes(q)));
      for (const m of hits) body.append(this.row(m, true));
      if (!hits.length) body.append(h("p", { class: "muted small" }, "No macros match your search."));
    } else {
      this.tree(body);
      // Dropping on empty space moves a macro out of its folder.
      this.bindDrop(body, "");
      if (!this.sb.macros.length && !this.sb.macroFolders.length)
        body.append(
          h(
            "div",
            { class: "empty-hint" },
            h("p", {}, "No macros yet."),
            h("p", { class: "muted small" }, "A macro types a list of commands into a terminal for you. Click + Macro to make one, or import a backup from Siakap."),
          ),
        );
    }

    const exportMenu = (e: Event) =>
      showMenu(e as MouseEvent, [
        { label: "Export macros", action: () => this.exportBackup("macros") },
        { label: "Export sessions and macros", action: () => this.exportBackup("all") },
      ]);
    fillEl(
      panel,
      h("header", { class: "panel-head" }, h("h3", {}, "Macros"), h("small", { class: "muted" }, "Runs in the selected terminal.")),
      h(
        "div",
        { class: "toolbar" },
        h("button", { title: "Add a macro", onclick: () => this.edit(null) }, "+ Macro"),
        h("button", { class: "tool", title: "New folder", onclick: () => this.folderDialog("", null) }, icon("folder-plus", 15)),
        h("button", { class: "tool", title: "Import sessions and macros (Siakap backup)", onclick: () => this.importBackup() }, icon("import", 15)),
        h("button", { class: "tool", title: "Export", onclick: exportMenu }, icon("export", 15)),
      ),
      search,
      body,
    );
  }

  private tree(into: HTMLElement) {
    const root: FolderNode = { name: "", path: "", children: new Map(), items: [] };
    const node = (path: string) => {
      let n = root;
      let acc = "";
      for (const part of path.split("/").filter(Boolean)) {
        acc = acc ? `${acc}/${part}` : part;
        let c = n.children.get(part);
        if (!c) {
          c = { name: part, path: acc, children: new Map(), items: [] };
          n.children.set(part, c);
        }
        n = c;
      }
      return n;
    };
    for (const f of this.sb.macroFolders) node(f);
    for (const m of this.sorted(this.sb.macros)) node(m.folder).items.push(m);
    const draw = (parent: HTMLElement, n: FolderNode) => {
      for (const c of [...n.children.values()].sort((a, b) => a.name.localeCompare(b.name))) {
        const isClosed = this.closed.has(c.path);
        const empty = !c.items.length && !c.children.size;
        const entries: MenuEntry[] = [
          { label: "Add macro here", action: () => this.edit(null, c.path) },
          { label: "Add subfolder", action: () => this.folderDialog(c.path, null) },
          { label: "Rename folder", action: () => this.folderDialog(n.path, c.path) },
          { label: empty ? "Delete folder" : "Delete folder (empty it first)", danger: true, disabled: !empty, action: () => this.deleteFolder(c.path) },
        ];
        const head = h(
          "div",
          { class: "row folder-row", title: c.path },
          h("span", { class: "chev" }, icon(isClosed ? "chevron-right" : "chevron-down", 14)),
          h("span", { class: "ico dir" }, icon("folder", 15)),
          h("span", { class: "name" }, c.name),
          h(
            "span",
            { class: "row-actions" },
            h("button", { class: "icon", title: "Add macro here", onclick: (e: Event) => (e.stopPropagation(), this.edit(null, c.path)) }, icon("plus", 14)),
            h("button", { class: "icon", title: "Folder actions", onclick: (e: Event) => showMenu(e as MouseEvent, entries) }, icon("more", 14)),
          ),
        );
        head.addEventListener("click", () => {
          if (this.closed.has(c.path)) this.closed.delete(c.path);
          else this.closed.add(c.path);
          this.saveClosed();
          this.render();
        });
        head.addEventListener("contextmenu", (e) => showMenu(e, entries));
        this.bindDrop(head, c.path);
        const box = h("div", { class: "folder" }, head);
        parent.append(box);
        if (!isClosed) {
          const inner = h("div", { class: "folder-content" });
          box.append(inner);
          draw(inner, c);
        }
      }
      for (const m of n.items) parent.append(this.row(m, false));
    };
    draw(into, root);
  }

  private bindDrop(target: HTMLElement, folder: string) {
    target.addEventListener("dragover", (e) => {
      if (!this.dragged) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      target.classList.add("drop-target");
    });
    target.addEventListener("dragleave", () => target.classList.remove("drop-target"));
    target.addEventListener("drop", (e) => {
      if (!this.dragged) return;
      e.preventDefault();
      e.stopPropagation();
      target.classList.remove("drop-target");
      const id = this.dragged;
      this.dragged = null;
      void this.move(id, folder);
    });
  }

  private async move(id: string, folder: string) {
    const m = this.sb.macros.find((x) => x.id === id);
    if (!m) return toast("That macro is no longer available.", "error");
    if (m.folder === folder) return;
    try {
      await api.macroMove(id, folder);
      this.closed.delete(folder);
      this.saveClosed();
      toast(folder ? `Moved to ${folder}.` : "Moved outside folders.", "ok", 2000);
      await this.sb.reload();
    } catch (e) {
      toast(messageOf(e), "error");
    }
  }

  private row(m: Macro, showPath: boolean): HTMLElement {
    const run = () => void this.runner.run(m);
    const entries: MenuEntry[] = [
      { label: "Run macro", action: run },
      { label: "Edit", action: () => this.edit(m) },
      { label: "Duplicate macro", action: () => this.duplicate(m) },
      ...(m.folder ? [{ label: "Move outside folders", action: () => this.move(m.id, "") }] : []),
      { label: "Delete", danger: true, action: () => this.remove(m) },
    ];
    const activation = this.settings?.activation ?? "single";
    const row = h(
      "div",
      {
        class: "row item macro-row",
        draggable: "true",
        tabindex: 0,
        title: `${activation === "single" ? "Click" : "Double-click"} to run in the selected terminal. Drag onto a folder to move it.`,
        onkeydown: (e: Event) => (e as KeyboardEvent).key === "Enter" && run(),
      },
      h("span", { class: "ico" }, icon("macros", 15)),
      h(
        "span",
        { class: "name" },
        m.name,
        showPath && m.folder ? h("small", { class: "muted path" }, ` ${m.folder}`) : null,
      ),
      inputNames(m.script).length ? h("span", { class: "badge", title: `Asks for: ${inputNames(m.script).join(", ")}` }, "input") : null,
      m.editBeforeRun ? h("span", { class: "badge", title: "You can edit the commands before each run" }, "review") : null,
      h(
        "span",
        { class: "row-actions" },
        h("button", { class: "icon", title: `Run ${m.name}`, onclick: (e: Event) => (e.stopPropagation(), run()) }, icon("play", 14)),
        h("button", { class: "icon", title: `Actions for ${m.name}`, onclick: (e: Event) => showMenu(e as MouseEvent, entries) }, icon("more", 14)),
      ),
    );
    row.addEventListener(activation === "single" ? "click" : "dblclick", (e) => {
      if ((e.target as HTMLElement).closest(".row-actions")) return;
      run();
    });
    row.addEventListener("contextmenu", (e) => showMenu(e, entries));
    row.addEventListener("dragstart", (e) => {
      this.dragged = m.id;
      e.dataTransfer?.setData("application/x-siakap-macro", m.id);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      row.classList.add("dragging");
    });
    row.addEventListener("dragend", () => {
      this.dragged = null;
      row.classList.remove("dragging");
    });
    return row;
  }

  private async duplicate(m: Macro) {
    try {
      await api.macroDuplicate(m.id);
      toast(`Duplicated "${m.name}".`, "ok", 2000);
      await this.sb.reload();
    } catch (e) {
      toast(messageOf(e), "error");
    }
  }

  private async remove(m: Macro) {
    if (!(await confirmDialog("Delete macro?", `Delete "${m.name}"? This can't be undone.`, "Delete", { danger: true }))) return;
    await api.macroDelete(m.id).catch((e) => toast(messageOf(e), "error"));
    await this.sb.reload();
  }

  private async deleteFolder(path: string) {
    await api.foldersSave("macros", this.sb.macroFolders.filter((f) => f !== path && !f.startsWith(path + "/"))).catch((e) => toast(messageOf(e), "error"));
    await this.sb.reload();
  }

  /** New folder (oldPath null) or rename/move (oldPath set). */
  private async folderDialog(parent: string, oldPath: string | null) {
    const name = h("input", { value: oldPath ? oldPath.split("/").at(-1)! : "", spellcheck: "false", placeholder: "e.g. ncp" });
    const opts: [string, string][] = [["", "Top level"]];
    for (const p of this.allFolders()) if (!(oldPath && (p === oldPath || p.startsWith(oldPath + "/")))) opts.push([p, p]);
    const inside = select(opts, parent);
    const err = h("div", { class: "error" });
    await modal<void>(oldPath ? "Rename folder" : "New folder", (close) => {
      const save = async () => {
        try {
          const path = await api.macroFolderSave(name.value, inside.value, oldPath);
          if (oldPath && this.closed.has(oldPath)) {
            this.closed.delete(oldPath);
            this.saveClosed();
          }
          close();
          toast(oldPath ? `Folder renamed to ${path}.` : "Folder saved.", "ok", 2000);
          await this.sb.reload();
        } catch (e) {
          err.textContent = messageOf(e);
        }
      };
      name.addEventListener("keydown", (e) => e.key === "Enter" && void save());
      return {
        body: h("div", { class: "form" }, field("Folder name", name), field("Inside folder", inside), err),
        actions: [h("button", { onclick: () => close() }, "Cancel"), h("button", { class: "primary", onclick: () => void save() }, "Save")],
        focus: name,
      };
    });
  }

  /** Macro editor: name, folder, commands (with paste and Make input), review option. */
  async edit(existing: Macro | null, folder = "") {
    const m: Macro = existing
      ? { ...existing, parameterDefaults: { ...(existing.parameterDefaults ?? {}) } }
      : { id: "", name: "", folder, script: "", editBeforeRun: this.settings?.newMacroReview ?? false, parameterDefaults: {} };
    const name = h("input", { "data-f": "macro-name", value: m.name, spellcheck: "false", placeholder: "e.g. Check port status" });
    const folderIn = h("input", { "data-f": "macro-folder", value: m.folder, list: "dl-mfolders", spellcheck: "false", placeholder: "Optional, e.g. ncp/nv" });
    const dl = h("datalist", { id: "dl-mfolders" }, ...this.allFolders().map((f) => h("option", { value: f })));
    const script = h("textarea", { "data-f": "macro-script", rows: 12, spellcheck: "false", class: "mono", placeholder: "show interface status\n# @wait 1000\nshow interface {{Switch port}}" });
    script.value = m.script;
    const inputName = h("input", { "data-f": "input-name", spellcheck: "false", placeholder: "e.g. Switch port" });
    const review = h("input", { type: "checkbox", checked: m.editBeforeRun });
    const info = h("div", { class: "muted small" });
    const plan = h("div", { class: "plan" });
    const err = h("div", { class: "error" });
    const refresh = () => {
      const rows = explain(script.value);
      const label = { send: "Type + Enter", wait: "Pause", type: "Type only", note: "Note", error: "Problem" } as const;
      fillEl(
        plan,
        ...rows.slice(0, 40).map((r) =>
          h("div", { class: `plan-row ${r.kind}` }, h("span", { class: "plan-n" }, String(r.line)), h("span", { class: "plan-kind" }, label[r.kind]), h("span", { class: "plan-text" }, r.text)),
        ),
        rows.length > 40 ? h("div", { class: "muted small" }, `... and ${rows.length - 40} more lines`) : null,
      );
      plan.classList.toggle("hidden", !rows.length);
      try {
        check(script.value);
        const names = inputNames(script.value);
        const lines = rows.filter((r) => r.kind === "send" || r.kind === "type").length;
        info.textContent = `${lines} command${lines === 1 ? "" : "s"}${names.length ? `. Asks for: ${names.join(", ")}` : ""}`;
        err.textContent = "";
      } catch (e) {
        info.textContent = "";
        err.textContent = e instanceof MacroError ? e.message : String(e);
      }
    };
    script.addEventListener("input", refresh);
    refresh();

    const makeInput = () => {
      const start = script.selectionStart;
      const end = script.selectionEnd;
      const n = inputName.value.trim();
      if (start === end) return void (err.textContent = "Highlight the value to replace in Commands first.");
      const nameErr = validateInputName(n);
      if (nameErr) return void (err.textContent = nameErr, inputName.focus());
      const selected = script.value.slice(start, end);
      if (/[{}\r\n]/.test(selected)) return void (err.textContent = "Highlight a single command value.");
      m.parameterDefaults[n] = selected;
      script.value = script.value.slice(0, start) + `{{${n}}}` + script.value.slice(end);
      inputName.value = "";
      refresh();
      toast(`Input "${n}" added. You will be asked for it when running.`, "ok", 2500);
    };

    await modal<void>(
      existing ? "Edit macro" : "Add macro",
      (close) => {
        const save = async () => {
          if (!name.value.trim() || !script.value.trim()) return void (err.textContent = "Enter a name and at least one command.");
          try {
            await api.macroSave({ ...m, name: name.value, folder: folderIn.value, script: script.value, editBeforeRun: review.checked });
            close();
            toast("Macro saved.", "ok", 2000);
            await this.sb.reload();
          } catch (e) {
            err.textContent = messageOf(e);
          }
        };
        return {
          body: h(
            "div",
            { class: "form" },
            h("div", { class: "grid2" }, field("Name", name), field("Folder (optional)", folderIn, "Use / for nested folders. New folders are created when you save.")),
            dl,
            h(
              "label",
              { class: "field" },
              h("span", { class: "label-row" }, "Commands", pasteButton(script, "Commands")),
              script,
              h("small", { class: "muted" }, "One command per line. Each is typed into the terminal followed by Enter."),
            ),
            h("div", { class: "field" }, h("span", { class: "muted small" }, "What will happen"), plan),
            info,
            h(
              "div",
              { class: "make-input" },
              h("label", { class: "field" }, h("span", {}, "Input name"), inputName),
              h("button", { type: "button", onclick: makeInput }, "Make input"),
              h("small", { class: "muted span-all" }, "Highlight the changing value in Commands (for example a port), name it, then click Make input. You will be asked for it each time the macro runs."),
            ),
            h("label", { class: "check" }, review, " Edit the whole command before run"),
            h("small", { class: "muted" }, "Named inputs always prompt before running. This also lets you change the commands for one run."),
            h(
              "details",
              { class: "advanced" },
              h("summary", {}, "How to write a macro"),
              h(
                "dl",
                { class: "help-list" },
                h("dt", {}, h("code", {}, "show version")), h("dd", {}, "A normal line is typed and Enter is pressed."),
                h("dt", {}, h("code", {}, "@wait 1000")), h("dd", {}, "Wait 1 second (1000 ms) before the next line. Also written # @wait 1000."),
                h("dt", {}, h("code", {}, "@type y")), h("dd", {}, "Type y without pressing Enter (for yes/no questions)."),
                h("dt", {}, h("code", {}, "{{Switch port}}")), h("dd", {}, "Asks you for a value each time the macro runs."),
                h("dt", {}, h("code", {}, "# my note")), h("dd", {}, "Lines starting with # are notes and are not typed."),
              ),
              h("p", { class: "muted small" }, "A macro always types into the terminal you clicked last. Press Esc or Stop to cancel it."),
            ),
            err,
          ),
          actions: [h("button", { onclick: () => close() }, "Cancel"), h("button", { class: "primary", onclick: () => void save() }, "Save")],
          focus: existing ? script : name,
        };
      },
      { wide: true },
    );
  }

  /**
   * Import one or more files: Siakap backups, Siakap plugin exports, MobaXterm
   * session exports (.mxtsessions), macro exports (.mxtmacros) or MobaXterm.ini.
   * Macro files go first so sessions can find the macros they refer to.
   */
  async importBackup() {
    const picked = await api.pickFiles("import", true).catch((e) => (toast(messageOf(e), "error"), [] as string[]));
    if (!picked.length) return;
    const order = (p: string) => (/\.mxtmacros$/i.test(p) ? 0 : /\.mxtsessions$/i.test(p) ? 2 : 1);
    const files = [...picked].sort((a, b) => order(a) - order(b));
    const total: ImportReport = { macros: 0, duplicates: 0, sessions: 0, skippedSessions: 0, invalid: 0, startupDisabled: 0, needsReview: [], skippedTypes: {}, source: "siakap", startupSessionIds: [] };
    const failed: string[] = [];
    for (const f of files) {
      try {
        const r = await api.backupImportFile(f);
        total.macros += r.macros;
        total.duplicates += r.duplicates;
        total.sessions += r.sessions;
        total.skippedSessions += r.skippedSessions;
        total.invalid += r.invalid;
        total.startupDisabled += r.startupDisabled;
        total.needsReview.push(...r.needsReview);
        total.startupSessionIds.push(...(r.startupSessionIds ?? []));
        for (const [k, v] of Object.entries(r.skippedTypes ?? {})) total.skippedTypes[k] = (total.skippedTypes[k] ?? 0) + v;
        if (r.source === "mobaxterm") total.source = "mobaxterm";
      } catch (e) {
        failed.push(`${f.split(/[\\/]/).pop()}: ${messageOf(e)}`);
      }
    }
    await this.sb.reload();
    // Sessions that referred to a macro imported in the same batch are fine now.
    total.needsReview = total.needsReview.filter((x) => !(x.includes("uses MobaXterm macro") && files.some((f) => /\.mxtmacros$/i.test(f))));
    await this.importSummary(total, failed);
  }

  /** What came across, what was skipped, what to check. */
  private importSummary(r: ImportReport, failed: string[]) {
    const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
    const skipped = Object.entries(r.skippedTypes).map(([t, n]) => `${n} ${t}`).join(", ");
    const enableBtn = h("button", {}, `Turn on startup commands (${r.startupSessionIds.length})`);
    enableBtn.addEventListener("click", async () => {
      try {
        const n = await api.sessionsEnableStartup(r.startupSessionIds);
        toast(`Startup commands turned on for ${plural(n, "session")}.`, "ok");
        enableBtn.disabled = true;
        enableBtn.textContent = "Startup commands turned on";
        await this.sb.reload();
      } catch (e) {
        toast(messageOf(e), "error");
      }
    });
    return modal<void>(
      r.source === "mobaxterm" ? "MobaXterm import finished" : "Import finished",
      (close) => ({
        body: h(
          "div",
          { class: "form" },
          h("p", {}, `Imported ${plural(r.sessions, "session")} and ${plural(r.macros, "macro")}, in the same folders as before.`),
          r.duplicates || r.skippedSessions
            ? h("p", { class: "muted" }, `Already there, so skipped: ${[r.duplicates ? plural(r.duplicates, "macro") : "", r.skippedSessions ? plural(r.skippedSessions, "session") : ""].filter(Boolean).join(" and ")}.`)
            : null,
          skipped ? h("p", { class: "muted" }, `Not supported by Siakap, so skipped: ${skipped}.`) : null,
          r.invalid ? h("p", { class: "muted" }, `${plural(r.invalid, "entry")} couldn't be read and ${r.invalid === 1 ? "was" : "were"} skipped.`) : null,
          r.macros ? h("p", { class: "muted small" }, "Imported macros show you their commands before their first run. Untick \"Edit the whole command before run\" in a macro once you're happy with it.") : null,
          r.startupSessionIds.length
            ? h(
                "div",
                { class: "callout" },
                h("p", {}, `${plural(r.startupSessionIds.length, "session")} had a login macro or "execute command". It was imported as startup commands, switched off for safety. Check one or two (edit a session > Advanced settings), then turn them all on:`),
                enableBtn,
              )
            : null,
          r.needsReview.length ? h("div", {}, h("p", {}, "Please check:"), h("ul", { class: "review-list" }, ...r.needsReview.map((x) => h("li", {}, x)))) : null,
          failed.length ? h("div", { class: "error" }, failed.join("\n")) : null,
          r.source === "mobaxterm" ? h("p", { class: "muted small" }, "Passwords saved in MobaXterm aren't imported; you'll be asked when you first connect, and can save them in Siakap.") : null,
        ),
        actions: [h("button", { class: "primary", onclick: () => close() }, "Done")],
      }),
      { wide: true },
    );
  }

  async exportBackup(scope: "macros" | "all") {
    const p = await api.pickSave("export", scope === "all" ? "siakap-backup.json" : "siakap-macros.json").catch((e) => (toast(messageOf(e), "error"), null));
    if (!p) return;
    try {
      await api.backupExportFile(p, scope);
      toast(scope === "all" ? "Sessions, macros, folders and startup commands exported (no passwords)." : "Macros and folders exported.", "ok");
    } catch (e) {
      toast(messageOf(e), "error");
    }
  }
}
