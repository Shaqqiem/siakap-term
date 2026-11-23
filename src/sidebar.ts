// Sessions and Macros panels.
import { icon } from "./icons";
import { api, messageOf, type Macro, type RedactedSession, type SerialConfig, type Session, type ShellInfo } from "./api";
import { MacroPanel } from "./macropanel";
import { DEFAULT_SERIAL, serialDialog, serialForm, serialSummary, type SerialForm } from "./serial";
import type { MacroRunner } from "./runner";
import type { TabManager, Where } from "./tabs";
import { $, fill, showMenu, buildTree, confirmDialog, enableDrag, field, h, modal, promptDialog, select, toast, type FolderNode, type MenuEntry } from "./ui";

export class Sidebar {
  sessions: RedactedSession[] = [];
  folders: string[] = [];
  macroFolders: string[] = [];
  macros: Macro[] = [];
  shells: ShellInfo[] = [];
  private collapsed = new Set<string>();
  private sessionQuery = "";

  /** Folder for the next new session (set by a folder's menu). */
  private newIn = "";

  readonly macroPanel: MacroPanel;

  constructor(public tabs: TabManager, runner: MacroRunner) {
    this.macroPanel = new MacroPanel(this, runner);
    try {
      for (const k of JSON.parse(localStorage.getItem("siakap.sessions.collapsed") ?? "[]")) this.collapsed.add(String(k));
    } catch {
      /* per-viewer convenience only */
    }
  }

  private saveCollapsed() {
    try {
      localStorage.setItem("siakap.sessions.collapsed", JSON.stringify([...this.collapsed]));
    } catch {
      /* ignore */
    }
  }

  /** Quick-connect a serial console, optionally saving it as a session. */
  async quickSerial(port?: string) {
    const r = await serialDialog(port ? { port } : undefined);
    if (!r) return;
    if (r.save) return this.editSession(null, "serial", r.config);
    void this.tabs.openSerial(r.config);
  }

  /** Forget everything decrypted from the vault (called when it locks). */
  clear() {
    this.sessions = [];
    this.folders = [];
    this.macroFolders = [];
    this.macros = [];
    $("panel-sessions").replaceChildren();
    $("panel-macros").replaceChildren();
  }

  async reload() {
    const [v, m] = await Promise.all([api.sessionsList(), api.macrosList()]);
    this.sessions = v.sessions;
    this.folders = v.folders;
    this.macroFolders = v.macroFolders;
    this.macros = m;
    if (!this.shells.length) this.shells = await api.shellsList().catch(() => []);
    this.renderSessions();
    this.renderMacros();
    this.onReload();
  }

  /** Called after sessions or macros change (main.ts refreshes the welcome screen). */
  onReload: () => void = () => {};

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
    const root = buildTree(list, (s) => s.folder, q ? [] : this.folders);
    const tree = h("div", { class: "session-tree session-root", "data-drop": "" });
    this.drawFolder(tree, root, !!q);
    fill(
      panel,
      h("header", { class: "panel-head" }, h("h3", {}, "Sessions")),
      h(
        "div",
        { class: "toolbar" },
        h("button", { title: "Add a remote server (SSH)", onclick: () => this.newSessionIn("ssh", "") }, "+ SSH"),
        h("button", { title: "Save a terminal on this PC (PowerShell, WSL, cmd)", onclick: () => this.newSessionIn("local", "") }, "+ Local"),
        h("button", { title: "Connect a console cable (COM port)", onclick: () => this.newSessionIn("serial", "") }, "+ Serial"),
        h("button", { class: "tool", title: "New folder", onclick: () => this.folderDialog("", null) }, icon("folder-plus", 15)),
        h("button", {
          class: "tool",
          title: "More: import, export",
          onclick: (e: Event) =>
            showMenu(e as MouseEvent, [
              { label: "New folder", action: () => this.folderDialog("", null) },
              { label: "Import sessions and macros...", action: () => this.macroPanel.importBackup() },
              { label: "Export sessions and macros...", action: () => this.macroPanel.exportBackup("all") },
            ]),
        }, icon("more", 15)),
      ),
      search,
      tree,
      list.length === 0 && !q && !this.folders.length
        ? h("p", { class: "muted small" }, "No saved sessions yet. Click + SSH to add a server, + Local for a terminal on this PC, or + Serial for a console cable. Use the folder button to group them.")
        : null,
      list.length && !q ? h("p", { class: "muted small hint" }, "Right-click a session or folder for more. Drag sessions onto a folder to move them.") : null,
    );
  }

  private drawFolder(into: HTMLElement, node: FolderNode<RedactedSession>, filtering: boolean) {
    const kids = [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name));
    for (const c of kids) {
      const key = `s:${c.path}`;
      const open = filtering || !this.collapsed.has(key);
      const count = this.sessions.filter((s) => s.folder === c.path || s.folder.startsWith(c.path + "/")).length;
      const empty = count === 0 && c.children.size === 0;
      const entries: MenuEntry[] = [
        { label: "New SSH session here", action: () => this.newSessionIn("ssh", c.path) },
        { label: "New local terminal here", action: () => this.newSessionIn("local", c.path) },
        { label: "New serial session here", action: () => this.newSessionIn("serial", c.path) },
        { label: "New subfolder", action: () => this.folderDialog(c.path, null) },
        { label: "Rename folder", action: () => this.folderDialog("", c.path) },
        { label: empty ? "Delete folder" : "Delete folder (empty it first)", danger: true, disabled: !empty, action: () => this.deleteFolder("sessions", c.path) },
      ];
      const head = h(
        "div",
        { class: "row folder-row folder-head", title: c.path, "data-drop": c.path },
        h("span", { class: "chev" }, icon(open ? "chevron-down" : "chevron-right", 14)),
        h("span", { class: "ico dir" }, icon("folder", 15)),
        h("span", { class: "name" }, c.name),
        h("span", { class: "count muted" }, String(count)),
        h(
          "span",
          { class: "row-actions" },
          h("button", { class: "icon", title: "Folder actions", onclick: (e: Event) => (e.stopPropagation(), showMenu(e as MouseEvent, entries)) }, icon("more", 14)),
        ),
      );
      head.addEventListener("click", () => {
        if (this.collapsed.has(key)) this.collapsed.delete(key);
        else this.collapsed.add(key);
        this.saveCollapsed();
        this.renderSessions();
      });
      head.addEventListener("contextmenu", (e) => showMenu(e, entries));
      const box = h("div", { class: "folder" }, head);
      into.append(box);
      if (open) {
        const inner = h("div", { class: "folder-content" });
        box.append(inner);
        this.drawFolder(inner, c, filtering);
      }
    }
    for (const s of node.items) into.append(this.sessionItem(s));
  }

  connectSession(s: RedactedSession, where: Where = "tab") {
    if (s.kind === "ssh") void this.tabs.openSsh(s, where);
    else if (s.kind === "serial") void this.tabs.openSerial(s.serial, s.name, where, s);
    else {
      const sh = this.shells.find((x) => x.id === s.shell) ?? this.shells[0];
      if (!sh) return toast("No terminal program was found on this PC.", "error");
      void this.tabs.openLocal(sh.id, s.name, where, s);
    }
  }

  private sessionItem(s: RedactedSession): HTMLElement {
    const connect = (where: "tab" | "h" | "v" = "tab") => this.connectSession(s, where);
    const entries: MenuEntry[] = [
      { label: "Connect", action: () => connect() },
      { label: "Connect beside the current terminal", disabled: s.kind === "serial" || !this.tabs.focusedPane, action: () => connect("h") },
      { label: "Edit...", action: () => this.editSession(s, s.kind) },
      { label: "Duplicate", action: () => this.duplicateSession(s) },
      { label: "Move to folder...", action: () => this.moveDialog(s) },
      ...(s.folder ? [{ label: "Move out of folder", action: () => this.moveSession(s, "") }] : []),
      { label: "Delete", danger: true, action: () => this.deleteSession(s) },
    ];
    const row = h(
      "div",
      {
        class: "row item",
        tabindex: 0,
        title:
          (s.kind === "ssh" ? `${s.user}@${s.host}:${s.port}` : s.kind === "serial" ? serialSummary(s.serial) : "Terminal on this PC") +
          "\nDouble-click to connect. Right-click for more. Drag onto a folder to move it.",
        ondblclick: () => connect(),
        onkeydown: (e: Event) => (e as KeyboardEvent).key === "Enter" && connect(),
      },
      h("span", { class: "ico" }, icon(s.kind === "ssh" ? "remote" : s.kind === "serial" ? "serial" : "terminal", 15)),
      h("span", { class: "name" }, s.name),
      h("span", { class: "sub" }, s.kind === "ssh" ? `${s.user}@${s.host}` : s.kind === "serial" ? `${s.serial.port} ${s.serial.baud}` : ""),
      h(
        "span",
        { class: "row-actions" },
        h("button", { class: "icon", title: "Connect", onclick: (e: Event) => (e.stopPropagation(), connect()) }, icon("play", 14)),
        h("button", { class: "icon", title: "More", onclick: (e: Event) => (e.stopPropagation(), showMenu(e as MouseEvent, entries)) }, icon("more", 14)),
      ),
    );
    row.addEventListener("contextmenu", (e) => showMenu(e, entries));
    enableDrag(row, {
      label: s.name,
      accept: (t) => t !== s.folder,
      onDrop: (t) => void this.moveSession(s, t),
    });
    return h("div", { class: "session-item" }, row);
  }

  private plain(s: RedactedSession): Session {
    const { hasPassword: _h, ...rest } = s as RedactedSession & { hasPassword?: boolean };
    void _h;
    return rest as Session;
  }

  private async moveSession(s: RedactedSession, folder: string) {
    if (s.folder === folder) return;
    try {
      await api.sessionSave({ ...this.plain(s), folder }, null, false);
      if (folder) this.collapsed.delete(`s:${folder}`);
      this.saveCollapsed();
      toast(folder ? `Moved ${s.name} to ${folder}.` : `Moved ${s.name} out of its folder.`, "ok", 2000);
      await this.reload();
    } catch (e) {
      toast(messageOf(e), "error");
    }
  }

  private async moveDialog(s: RedactedSession) {
    const folder = select([["", "(No folder)"], ...this.folders.map((f): [string, string] => [f, f])], s.folder);
    const ok = await modal<boolean>("Move to folder", (close) => ({
      body: h("div", { class: "form" }, field(`Move ${s.name} to`, folder), h("small", { class: "muted" }, "To make a new folder, use the folder button above the list.")),
      actions: [h("button", { onclick: () => close(false) }, "Cancel"), h("button", { class: "primary", onclick: () => close(true) }, "Move")],
      focus: folder,
    }), { dismissValue: false });
    if (ok) await this.moveSession(s, folder.value);
  }

  private async duplicateSession(s: RedactedSession) {
    const base = s.name.replace(/ copy( \d+)?$/, "");
    let name = `${base} copy`;
    for (let i = 2; this.sessions.some((x) => x.name === name); i++) name = `${base} copy ${i}`;
    try {
      await api.sessionSave({ ...this.plain(s), id: "", name }, null, false);
      toast(`Created ${name}.${s.hasPassword ? " The saved password was not copied." : ""}`, "ok");
      await this.reload();
    } catch (e) {
      toast(messageOf(e), "error");
    }
  }

  /** New folder inside `parent`, or rename `existing`. */
  private async folderDialog(parent: string, existing: string | null) {
    const leaf = existing ? existing.split("/").pop()! : "";
    const name = await promptDialog(existing ? "Rename folder" : parent ? `New folder in ${parent}` : "New folder", "Folder name", {
      value: leaf,
      okLabel: existing ? "Rename" : "Create",
      hint: "Use / to make sub-folders, e.g. Production/Web.",
      validate: (v) =>
        !v.trim() ? "Enter a name." : v.split(/[/\\]/).some((x) => x.trim() === "." || x.trim() === "..") ? "'.' and '..' are not allowed." : null,
    });
    if (!name) return;
    try {
      if (!existing) {
        const path = parent ? `${parent}/${name.trim()}` : name.trim();
        await api.foldersSave("sessions", [...this.folders, path]);
        this.collapsed.delete(`s:${parent}`);
      } else {
        const base = existing.includes("/") ? existing.slice(0, existing.lastIndexOf("/") + 1) : "";
        const to = base + name.trim();
        if (to === existing) return;
        const remap = (f: string) => (f === existing ? to : f.startsWith(existing + "/") ? to + f.slice(existing.length) : f);
        await api.foldersSave("sessions", this.folders.map(remap));
        for (const s of this.sessions.filter((x) => remap(x.folder) !== x.folder)) {
          await api.sessionSave({ ...this.plain(s), folder: remap(s.folder) }, null, false);
        }
      }
      this.saveCollapsed();
      await this.reload();
    } catch (e) {
      toast(messageOf(e), "error");
    }
  }

  private newSessionIn(kind: Session["kind"], folder: string) {
    this.newIn = folder;
    return kind === "serial" ? this.quickSerial() : this.editSession(null, kind);
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

  private async deleteFolder(kind: "sessions" | "macros", path: string) {
    const list = kind === "sessions" ? this.folders : this.macroFolders;
    await api.foldersSave(kind, list.filter((f) => f !== path && !f.startsWith(path + "/"))).catch((e) => toast(messageOf(e), "error"));
    await this.reload();
  }

  /** Open the session editor for a new session of the given kind. */
  newSession(kind: Session["kind"]) {
    return this.newSessionIn(kind, "");
  }

  private async editSession(existing: RedactedSession | null, kind: Session["kind"], serial?: SerialConfig) {
    const s: Session = existing
      ? { ...existing, serial: existing.serial ?? DEFAULT_SERIAL }
      : {
          id: "",
          name: serial ? `${serial.port} (${serial.baud})` : "",
          folder: this.newIn,
          kind,
          host: "",
          port: 22,
          user: "",
          auth: "auto",
          keyPath: "",
          shell: this.shells[0]?.id ?? "",
          postConnectMacro: null,
          serial: serial ?? DEFAULT_SERIAL,
          startupScript: "",
          startupEnabled: true,
          startupDir: "",
        };
    this.newIn = "";
    // data-f attributes give every field a stable name (used by tests too).
    const name = h("input", { "data-f": "name", value: s.name, spellcheck: "false", placeholder: "Optional, e.g. Web server" });
    const folder = h("input", { "data-f": "folder", value: s.folder, list: "dl-folders", spellcheck: "false", placeholder: "Optional, e.g. Production/Web" });
    const dl = h("datalist", { id: "dl-folders" }, ...this.folders.map((f) => h("option", { value: f })));
    const type = select(
      [["ssh", "Remote server (SSH)"], ["local", "Terminal on this PC (PowerShell, WSL, cmd)"], ["serial", "Serial console (COM port)"]],
      s.kind,
    );
    type.dataset.f = "type";
    const host = h("input", { "data-f": "host", value: s.host, spellcheck: "false", placeholder: "e.g. 10.0.0.5 or server.company.local" });
    const port = h("input", { "data-f": "port", type: "number", min: 1, max: 65535, value: s.port || 22 });
    const user = h("input", { "data-f": "user", value: s.user, spellcheck: "false", placeholder: "e.g. admin" });
    const auth = select(
      [
        ["auto", "Automatic (recommended)"],
        ["password", "Password only"],
        ["key", "Key file only"],
        ["agent", "SSH agent / Pageant only (incl. hardware keys)"],
      ],
      s.auth,
    );
    auth.dataset.f = "auth";
    const keyPath = h("input", { "data-f": "keyPath", value: s.keyPath, spellcheck: "false", placeholder: "C:\\Users\\you\\.ssh\\id_ed25519" });
    const browse = h("button", { type: "button" }, "Browse");
    browse.addEventListener("click", async () => {
      const [p] = await api.pickFiles("key", false).catch((e) => (toast(messageOf(e), "error"), [] as string[]));
      if (p) keyPath.value = p;
    });
    const pw = h("input", {
      "data-f": "password",
      type: "password",
      placeholder: existing?.hasPassword ? "Saved. Leave empty to keep it." : "Optional",
      autocomplete: "off",
    });
    const clearPw = h("input", { type: "checkbox" });
    const shell = select(this.shells.map((x) => [x.id, x.label]), s.shell);
    shell.dataset.f = "shell";
    // Startup commands (Siakap "startup macro"): typed once the prompt is ready.
    const legacy = s.postConnectMacro ? this.macros.find((x) => x.id === s.postConnectMacro) : undefined;
    const startupScript = h("textarea", {
      "data-f": "startup",
      rows: 4,
      class: "mono",
      spellcheck: "false",
      placeholder: "One command per line, e.g.\nterminal length 0\n# @wait 1000",
    });
    startupScript.value = s.startupScript || legacy?.script || "";
    const startupEnabled = h("input", { type: "checkbox", "data-f": "startup-enabled", checked: s.startupEnabled !== false });
    const startupDir = h("input", { "data-f": "startup-dir", value: s.startupDir, spellcheck: "false", placeholder: "Optional, e.g. /var/log or C:\\Projects" });
    const insertMacro = select([["", "Insert a saved macro..."], ...this.macros.map((m): [string, string] => [m.id, (m.folder ? m.folder + "/" : "") + m.name])], "");
    insertMacro.addEventListener("change", () => {
      const m = this.macros.find((x) => x.id === insertMacro.value);
      if (m) startupScript.value = (startupScript.value.trim() ? startupScript.value.replace(/\s*$/, "\n") : "") + m.script;
      insertMacro.value = "";
    });
    const startupFields = h(
      "div",
      { class: "form startup-fields" },
      h("label", { class: "check" }, startupEnabled, " Run startup commands after connecting"),
      h("label", { class: "field" }, h("span", {}, "Startup commands"), startupScript, insertMacro,
        h("small", { class: "muted" }, "Typed once the prompt is ready (not for serial consoles). If no prompt appears in time, they are skipped.")),
      field("Start in folder", startupDir, "Optional. Changes to this folder first."),
    );
    const err = h("div", { class: "error" });

    // Basic fields first; everything else lives under "Advanced settings".
    const sshFields = h(
      "div",
      { class: "grid2" },
      h("label", { class: "field span2" }, h("span", {}, "Server address"), host, h("small", { class: "muted" }, "The server's name or IP address.")),
      field("Username", user),
      field("Password", pw, existing?.hasPassword ? "A password is saved (encrypted)." : "Leave empty to be asked each time."),
    );
    const sshAdvanced = h(
      "div",
      { class: "grid2" },
      field("Port", port, "Almost always 22."),
      field("Sign-in method", auth, "Automatic tries your SSH agent, then a key file, then the password."),
      h("label", { class: "field span2" }, h("span", {}, "Key file"), h("div", { class: "inline" }, keyPath, browse), h("small", { class: "muted" }, "Only needed if you sign in with a private key file.")),
      existing?.hasPassword ? h("label", { class: "check span2" }, clearPw, " Forget the saved password") : null,
    );
    const localFields = h("div", {}, field("Program", shell, "For example PowerShell, Command Prompt or a WSL distro."));
    const serialFields = h("div", {});
    const advanced = h(
      "details",
      { class: "advanced" },
      h("summary", {}, "Advanced settings"),
      sshAdvanced,
      startupFields,
    );
    const nonDefault =
      !!s.postConnectMacro || !!s.startupScript.trim() || !!s.startupDir || (s.kind === "ssh" && ((s.port && s.port !== 22) || s.auth !== "auto" || !!s.keyPath));
    if (nonDefault) advanced.open = true;

    let sform: SerialForm | null = null;
    const sync = () => {
      sshFields.classList.toggle("hidden", type.value !== "ssh");
      sshAdvanced.classList.toggle("hidden", type.value !== "ssh");
      startupFields.classList.toggle("hidden", type.value === "serial");
      localFields.classList.toggle("hidden", type.value !== "local");
      serialFields.classList.toggle("hidden", type.value !== "serial");
      if (type.value === "serial" && !sform) {
        sform = serialForm(s.serial);
        serialFields.append(sform.el);
      }
    };
    type.addEventListener("change", sync);
    sync();

    await modal<void>(
      existing ? "Edit session" : "New session",
      (close) => {
        const save = async (connect: boolean) => {
          err.textContent = "";
          let serialCfg = s.serial;
          const k = type.value as Session["kind"];
          if (k === "serial" && sform) {
            const r = sform.read();
            if (typeof r === "string") return void (err.textContent = r);
            serialCfg = r;
          }
          if (k === "ssh" && !host.value.trim()) return void (err.textContent = "Enter the server address.", host.focus());
          if (k === "ssh" && !user.value.trim()) return void (err.textContent = "Enter your username.", user.focus());
          // The name is optional: fall back to something sensible.
          const fallback =
            k === "ssh" ? host.value.trim() : k === "serial" ? `${serialCfg.port} (${serialCfg.baud})` : (this.shells.find((x) => x.id === shell.value)?.label ?? "Terminal");
          const out: Session = {
            ...s,
            name: name.value.trim() || fallback,
            folder: folder.value,
            kind: k,
            host: host.value,
            port: Number(port.value) || 22,
            user: user.value,
            auth: auth.value as Session["auth"],
            keyPath: keyPath.value,
            shell: shell.value,
            postConnectMacro: null,
            startupScript: startupScript.value,
            startupEnabled: startupEnabled.checked,
            startupDir: startupDir.value,
            serial: serialCfg,
          };
          try {
            const id = await api.sessionSave(out, pw.value ? pw.value : null, clearPw.checked);
            pw.value = "";
            close();
            await this.reload();
            if (connect) {
              const saved = this.sessions.find((x) => x.id === id);
              if (saved) this.connectSession(saved);
            }
          } catch (e) {
            err.textContent = messageOf(e);
          }
        };
        return {
          body: h(
            "form",
            { class: "form", onsubmit: (e: Event) => (e.preventDefault(), void save(false)) },
            field("Type", type),
            sshFields,
            localFields,
            serialFields,
            h("div", { class: "grid2" }, field("Name", name), field("Folder", folder)),
            dl,
            advanced,
            err,
            h("button", { type: "submit", class: "hidden" }),
          ),
          actions: [
            h("button", { onclick: () => close() }, "Cancel"),
            h("button", { onclick: () => void save(false) }, "Save"),
            h("button", { class: "primary", onclick: () => void save(true) }, "Save and connect"),
          ],
          focus: existing ? name : type.value === "ssh" ? host : name,
        };
      },
      { wide: true },
    );
    (sform as SerialForm | null)?.dispose();
  }

  // ------------------------------------------------------------------ macros

  renderMacros() {
    this.macroPanel.render();
  }
}
