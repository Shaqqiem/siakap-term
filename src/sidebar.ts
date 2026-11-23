// Sessions and Macros panels.
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { api, messageOf, type Macro, type RedactedSession, type Session, type ShellInfo } from "./api";
import { parse, placeholders, MacroError } from "./macros";
import type { MacroRunner } from "./runner";
import type { TabManager } from "./tabs";
import { $, fill, buildTree, confirmDialog, field, h, modal, promptDialog, select, toast, type FolderNode } from "./ui";

export class Sidebar {
  sessions: RedactedSession[] = [];
  folders: string[] = [];
  macroFolders: string[] = [];
  macros: Macro[] = [];
  shells: ShellInfo[] = [];
  private collapsed = new Set<string>();
  private sessionQuery = "";
  private macroQuery = "";

  constructor(private tabs: TabManager, private runner: MacroRunner) {}

  async reload() {
    const [v, m] = await Promise.all([api.sessionsList(), api.macrosList()]);
    this.sessions = v.sessions;
    this.folders = v.folders;
    this.macroFolders = v.macroFolders;
    this.macros = m;
    if (!this.shells.length) this.shells = await api.shellsList().catch(() => []);
    this.renderSessions();
    this.renderMacros();
  }

  // ------------------------------------------------------------------ tree

  private renderTree<T>(
    root: FolderNode<T>,
    kind: "s" | "m",
    item: (t: T) => HTMLElement,
    filtering: boolean,
    onDeleteFolder: (path: string) => void,
  ): HTMLElement {
    const ul = h("ul", { class: "tree" });
    const walk = (node: FolderNode<T>, into: HTMLElement) => {
      const kids = [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name));
      for (const c of kids) {
        const key = `${kind}:${c.path}`;
        const open = filtering || !this.collapsed.has(key);
        const empty = c.items.length === 0 && c.children.size === 0;
        const sub = h("ul", { class: "tree" });
        const li = h(
          "li",
          { class: "folder" },
          h(
            "div",
            {
              class: "row folder-row",
              onclick: () => {
                if (this.collapsed.has(key)) this.collapsed.delete(key);
                else this.collapsed.add(key);
                kind === "s" ? this.renderSessions() : this.renderMacros();
              },
            },
            h("span", { class: "chev" }, open ? "▾" : "▸"),
            h("span", { class: "name" }, c.name),
            empty
              ? h("button", { class: "icon", title: "Delete empty folder", onclick: (e: Event) => (e.stopPropagation(), onDeleteFolder(c.path)) }, "×")
              : null,
          ),
          open ? sub : null,
        );
        into.append(li);
        if (open) walk(c, sub);
      }
      for (const it of node.items) into.append(item(it));
    };
    walk(root, ul);
    return ul;
  }

  // ------------------------------------------------------------------ sessions

  renderSessions() {
    const panel = $("panel-sessions");
    const q = this.sessionQuery.toLowerCase();
    const list = this.sessions
      .filter((s) => !q || [s.name, s.host, s.user, s.folder].some((x) => x.toLowerCase().includes(q)))
      .sort((a, b) => a.name.localeCompare(b.name));
    const search = h("input", { type: "search", placeholder: "Search sessions", value: this.sessionQuery, spellcheck: "false" });
    search.addEventListener("input", () => {
      this.sessionQuery = search.value;
      this.renderSessions();
      const s = panel.querySelector("input[type=search]") as HTMLInputElement;
      s.focus();
      s.setSelectionRange(s.value.length, s.value.length);
    });
    const tree = this.renderTree(
      buildTree(list, (s) => s.folder, q ? [] : this.folders),
      "s",
      (s) => this.sessionItem(s),
      !!q,
      (path) => this.deleteFolder("sessions", path),
    );
    fill(panel, 
      h("header", { class: "panel-head" }, h("h3", {}, "Sessions")),
      h(
        "div",
        { class: "toolbar" },
        h("button", { onclick: () => this.editSession(null, "ssh") }, "+ SSH"),
        h("button", { onclick: () => this.editSession(null, "local") }, "+ Local"),
        h("button", { onclick: () => this.newFolder("sessions") }, "+ Folder"),
      ),
      search,
      tree,
      list.length === 0 && !q ? h("p", { class: "muted small" }, "No saved sessions yet.") : null,
      h("h4", {}, "Local shells"),
      h(
        "ul",
        { class: "tree" },
        ...this.shells.map((sh) =>
          h(
            "li",
            {},
            h(
              "div",
              { class: "row item", title: "Open (Shift+click: split)", onclick: (e: Event) => this.tabs.openLocal(sh.id, sh.label, (e as MouseEvent).shiftKey ? "h" : "tab") },
              h("span", { class: "ico" }, "›_"),
              h("span", { class: "name" }, sh.label),
            ),
          ),
        ),
      ),
    );
  }

  private sessionItem(s: RedactedSession): HTMLElement {
    const connect = (where: "tab" | "h" | "v" = "tab") => {
      if (s.kind === "ssh") void this.tabs.openSsh(s, where);
      else {
        const sh = this.shells.find((x) => x.id === s.shell) ?? this.shells[0];
        if (!sh) return toast("No local shell available.", "error");
        void this.tabs.openLocal(sh.id, s.name, where);
      }
    };
    return h(
      "li",
      {},
      h(
        "div",
        {
          class: "row item",
          tabindex: 0,
          title: s.kind === "ssh" ? `${s.user}@${s.host}:${s.port} — double-click to connect` : "Local shell",
          ondblclick: () => connect(),
          onkeydown: (e: Event) => (e as KeyboardEvent).key === "Enter" && connect(),
        },
        h("span", { class: "ico" }, s.kind === "ssh" ? "⇄" : "›_"),
        h("span", { class: "name" }, s.name),
        h("span", { class: "sub" }, s.kind === "ssh" ? `${s.user}@${s.host}` : ""),
        h(
          "span",
          { class: "row-actions" },
          h("button", { class: "icon", title: "Connect", onclick: (e: Event) => (e.stopPropagation(), connect()) }, "▶"),
          h("button", { class: "icon", title: "Connect in split", onclick: (e: Event) => (e.stopPropagation(), connect("h")) }, "◫"),
          h("button", { class: "icon", title: "Edit", onclick: (e: Event) => (e.stopPropagation(), this.editSession(s, s.kind)) }, "✎"),
          h("button", { class: "icon", title: "Delete", onclick: (e: Event) => (e.stopPropagation(), this.deleteSession(s)) }, "🗑"),
        ),
      ),
    );
  }

  private async deleteSession(s: RedactedSession) {
    if (!(await confirmDialog("Delete session?", `Delete "${s.name}" and any saved password for it?`, "Delete", { danger: true }))) return;
    try {
      await api.sessionDelete(s.id);
      await this.reload();
    } catch (e) {
      toast(messageOf(e), "error");
    }
  }

  private async newFolder(kind: "sessions" | "macros") {
    const name = await promptDialog("New folder", "Folder path (use / for sub-folders, up to 16 levels)", {
      validate: (v) => (v.split(/[/\\]/).some((x) => x.trim() === "." || x.trim() === "..") ? "'.' and '..' are not allowed." : v.trim() ? null : "Required."),
    });
    if (!name) return;
    const list = kind === "sessions" ? this.folders : this.macroFolders;
    try {
      await api.foldersSave(kind, [...list, name]);
      await this.reload();
    } catch (e) {
      toast(messageOf(e), "error");
    }
  }

  private async deleteFolder(kind: "sessions" | "macros", path: string) {
    const list = kind === "sessions" ? this.folders : this.macroFolders;
    await api.foldersSave(kind, list.filter((f) => f !== path && !f.startsWith(path + "/"))).catch((e) => toast(messageOf(e), "error"));
    await this.reload();
  }

  private async editSession(existing: RedactedSession | null, kind: "ssh" | "local") {
    const s: Session = existing
      ? { ...existing }
      : { id: "", name: "", folder: "", kind, host: "", port: 22, user: "", auth: "auto", keyPath: "", shell: this.shells[0]?.id ?? "", postConnectMacro: null };
    const name = h("input", { value: s.name, spellcheck: "false" });
    const folder = h("input", { value: s.folder, list: "dl-folders", spellcheck: "false", placeholder: "e.g. Prod/Web" });
    const dl = h("datalist", { id: "dl-folders" }, ...this.folders.map((f) => h("option", { value: f })));
    const type = select([["ssh", "SSH"], ["local", "Local shell"]], s.kind);
    const host = h("input", { value: s.host, spellcheck: "false" });
    const port = h("input", { type: "number", min: 1, max: 65535, value: s.port || 22 });
    const user = h("input", { value: s.user, spellcheck: "false" });
    const auth = select(
      [["auto", "Auto (agent → Pageant → key → password)"], ["agent", "SSH agent / Pageant (YubiKey, FIDO)"], ["key", "Key file"], ["password", "Password"]],
      s.auth,
    );
    const keyPath = h("input", { value: s.keyPath, spellcheck: "false", placeholder: "C:\\Users\\you\\.ssh\\id_ed25519" });
    const browse = h("button", { type: "button" }, "Browse…");
    browse.addEventListener("click", async () => {
      const p = await openDialog({ multiple: false, directory: false, title: "Choose private key" });
      if (typeof p === "string") keyPath.value = p;
    });
    const pw = h("input", { type: "password", placeholder: existing?.hasPassword ? "•••••• (saved — leave empty to keep)" : "optional", autocomplete: "off" });
    const clearPw = h("input", { type: "checkbox" });
    const shell = select(this.shells.map((x) => [x.id, x.label]), s.shell);
    const macro = select([["", "— none —"], ...this.macros.map((m): [string, string] => [m.id, (m.folder ? m.folder + "/" : "") + m.name])], s.postConnectMacro ?? "");
    const err = h("div", { class: "error" });

    const sshFields = h(
      "div",
      { class: "grid2" },
      field("Host", host),
      field("Port", port),
      field("User", user),
      field("Authentication", auth),
      h("label", { class: "field span2" }, h("span", {}, "Key file"), h("div", { class: "inline" }, keyPath, browse)),
      field("Saved password", pw, "Stored encrypted in the vault; never sent to the UI."),
      existing?.hasPassword ? h("label", { class: "check" }, clearPw, " Forget saved password") : h("span", {}),
    );
    const localFields = h("div", {}, field("Shell", shell));
    const sync = () => {
      sshFields.classList.toggle("hidden", type.value !== "ssh");
      localFields.classList.toggle("hidden", type.value !== "local");
    };
    type.addEventListener("change", sync);
    sync();

    await modal<void>(
      existing ? `Edit session` : "New session",
      (close) => {
        const save = async () => {
          const out: Session = {
            ...s,
            name: name.value,
            folder: folder.value,
            kind: type.value as Session["kind"],
            host: host.value,
            port: Number(port.value) || 22,
            user: user.value,
            auth: auth.value as Session["auth"],
            keyPath: keyPath.value,
            shell: shell.value,
            postConnectMacro: macro.value || null,
          };
          try {
            await api.sessionSave(out, pw.value ? pw.value : null, clearPw.checked);
            pw.value = "";
            close();
            await this.reload();
          } catch (e) {
            err.textContent = messageOf(e);
          }
        };
        return {
          body: h("form", { class: "form", onsubmit: (e: Event) => (e.preventDefault(), void save()) },
            h("div", { class: "grid2" }, field("Name", name), field("Folder", folder), field("Type", type), field("Post-connect macro", macro)),
            dl, sshFields, localFields, err, h("button", { type: "submit", class: "hidden" })),
          actions: [h("button", { onclick: () => close() }, "Cancel"), h("button", { class: "primary", onclick: () => void save() }, "Save")],
          focus: name,
        };
      },
      { wide: true },
    );
  }

  // ------------------------------------------------------------------ macros

  renderMacros() {
    const panel = $("panel-macros");
    const q = this.macroQuery.toLowerCase();
    const list = this.macros
      .filter((m) => !q || [m.name, m.folder, m.script].some((x) => x.toLowerCase().includes(q)))
      .sort((a, b) => a.name.localeCompare(b.name));
    const search = h("input", { type: "search", placeholder: "Search macros", value: this.macroQuery, spellcheck: "false" });
    search.addEventListener("input", () => {
      this.macroQuery = search.value;
      this.renderMacros();
      const s = panel.querySelector("input[type=search]") as HTMLInputElement;
      s.focus();
      s.setSelectionRange(s.value.length, s.value.length);
    });
    fill(panel, 
      h("header", { class: "panel-head" }, h("h3", {}, "Macros")),
      h(
        "div",
        { class: "toolbar" },
        h("button", { onclick: () => this.editMacro(null) }, "+ Macro"),
        h("button", { onclick: () => this.newFolder("macros") }, "+ Folder"),
        h("button", { onclick: () => this.importMacros(), title: "Import macros from JSON" }, "Import"),
        h("button", { onclick: () => this.exportMacros(), title: "Export all macros to JSON" }, "Export"),
      ),
      search,
      this.renderTree(buildTree(list, (m) => m.folder, q ? [] : this.macroFolders), "m", (m) => this.macroItem(m), !!q, (p) => this.deleteFolder("macros", p)),
      list.length === 0 && !q ? h("p", { class: "muted small" }, "No macros yet. Macros send lines to the focused pane; use # @wait 500, # @type text and {{placeholders}}.") : null,
    );
  }

  private macroItem(m: Macro): HTMLElement {
    return h(
      "li",
      {},
      h(
        "div",
        { class: "row item", title: "Click to run on the focused pane", onclick: () => this.runner.run(m) },
        h("span", { class: "ico" }, "⚡"),
        h("span", { class: "name" }, m.name),
        placeholders(m.script).length ? h("span", { class: "sub" }, "{{…}}") : null,
        h(
          "span",
          { class: "row-actions" },
          h("button", { class: "icon", title: "Edit", onclick: (e: Event) => (e.stopPropagation(), this.editMacro(m)) }, "✎"),
          h("button", { class: "icon", title: "Delete", onclick: (e: Event) => (e.stopPropagation(), this.deleteMacro(m)) }, "🗑"),
        ),
      ),
    );
  }

  private async deleteMacro(m: Macro) {
    if (!(await confirmDialog("Delete macro?", `Delete "${m.name}"?`, "Delete", { danger: true }))) return;
    await api.macroDelete(m.id).catch((e) => toast(messageOf(e), "error"));
    await this.reload();
  }

  private async editMacro(existing: Macro | null) {
    const m: Macro = existing ? { ...existing } : { id: "", name: "", folder: "", script: "", preview: false };
    const name = h("input", { value: m.name, spellcheck: "false" });
    const folder = h("input", { value: m.folder, list: "dl-mfolders", spellcheck: "false" });
    const dl = h("datalist", { id: "dl-mfolders" }, ...this.macroFolders.map((f) => h("option", { value: f })));
    const script = h("textarea", { rows: 14, spellcheck: "false", class: "mono", placeholder: "# comment\nuname -a\n# @wait 1000\nping -c 3 {{host}}\n# @type y" });
    script.value = m.script;
    const preview = h("input", { type: "checkbox", checked: m.preview });
    const info = h("div", { class: "muted small" });
    const err = h("div", { class: "error" });
    const check = () => {
      try {
        const steps = parse(script.value);
        const ph = placeholders(script.value);
        info.textContent = `${steps.length} step(s)${ph.length ? ` · prompts for: ${ph.join(", ")}` : ""}`;
        err.textContent = "";
      } catch (e) {
        err.textContent = e instanceof MacroError ? e.message : String(e);
      }
    };
    script.addEventListener("input", check);
    check();
    await modal<void>(
      existing ? "Edit macro" : "New macro",
      (close) => {
        const save = async () => {
          try {
            await api.macroSave({ ...m, name: name.value, folder: folder.value, script: script.value, preview: preview.checked });
            close();
            await this.reload();
          } catch (e) {
            err.textContent = messageOf(e);
          }
        };
        return {
          body: h(
            "div",
            { class: "form" },
            h("div", { class: "grid2" }, field("Name", name), field("Folder", folder)),
            dl,
            field("Script", script, "Each line is sent followed by Enter. # @wait <ms> pauses, # @type <text> sends without Enter, other # lines are comments, {{name}} prompts once."),
            info,
            h("label", { class: "check" }, preview, " Preview before running"),
            err,
          ),
          actions: [h("button", { onclick: () => close() }, "Cancel"), h("button", { class: "primary", onclick: () => void save() }, "Save")],
          focus: name,
        };
      },
      { wide: true },
    );
  }

  private async importMacros() {
    const p = await openDialog({ multiple: false, title: "Import macros", filters: [{ name: "JSON", extensions: ["json"] }] });
    if (typeof p !== "string") return;
    try {
      const r = await api.macrosImportFile(p);
      toast(`Imported ${r.added}; ${r.duplicates} duplicate(s) and ${r.invalid} invalid skipped.`, "ok");
      await this.reload();
    } catch (e) {
      toast(messageOf(e), "error");
    }
  }

  private async exportMacros() {
    const p = await saveDialog({ title: "Export macros", defaultPath: "siakap-macros.json", filters: [{ name: "JSON", extensions: ["json"] }] });
    if (!p) return;
    try {
      const n = await api.macrosExportFile(p, null);
      toast(`Exported ${n} macro(s).`, "ok");
    } catch (e) {
      toast(messageOf(e), "error");
    }
  }
}
