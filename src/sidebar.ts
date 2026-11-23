// Sessions and Macros panels.
import { icon } from "./icons";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { api, messageOf, type Macro, type RedactedSession, type SerialConfig, type SerialPortInfo, type Session, type ShellInfo } from "./api";
import { MacroPanel } from "./macropanel";
import { DEFAULT_SERIAL, serialDialog, serialForm, serialSummary, type SerialForm } from "./serial";
import type { MacroRunner } from "./runner";
import type { TabManager } from "./tabs";
import { $, fill, showMenu, buildTree, confirmDialog, field, h, modal, promptDialog, select, toast, type FolderNode } from "./ui";

export class Sidebar {
  sessions: RedactedSession[] = [];
  folders: string[] = [];
  macroFolders: string[] = [];
  macros: Macro[] = [];
  shells: ShellInfo[] = [];
  private collapsed = new Set<string>();
  private sessionQuery = "";

  serialPorts: SerialPortInfo[] = [];
  private serialKey = "";

  readonly macroPanel: MacroPanel;

  constructor(public tabs: TabManager, runner: MacroRunner) {
    this.macroPanel = new MacroPanel(this, runner);
    // Keep the "Serial ports" list current so a newly plugged-in cable shows up.
    window.setInterval(() => {
      const panel = document.getElementById("panel-sessions");
      if (panel && !panel.classList.contains("hidden") && panel.offsetParent !== null) void this.pollSerial();
    }, 3000);
  }

  private async pollSerial(render = true) {
    try {
      const { ports } = await api.serialPortsList();
      const key = ports.map((p) => p.name + p.description).join("|");
      if (key === this.serialKey) return;
      this.serialKey = key;
      this.serialPorts = ports;
      if (render) this.renderSessions();
    } catch {
      /* listing ports is best-effort */
    }
  }

  /** Quick-connect a serial console, optionally saving it as a session. */
  async quickSerial(port?: string) {
    const r = await serialDialog(port ? { port } : undefined);
    if (!r) return;
    if (r.save) return this.editSession(null, "serial", r.config);
    void this.tabs.openSerial(r.config);
  }

  async reload() {
    const [v, m] = await Promise.all([api.sessionsList(), api.macrosList()]);
    this.sessions = v.sessions;
    this.folders = v.folders;
    this.macroFolders = v.macroFolders;
    this.macros = m;
    if (!this.shells.length) this.shells = await api.shellsList().catch(() => []);
    await this.pollSerial(false);
    this.renderSessions();
    this.renderMacros();
    this.onReload();
  }

  /** Called after sessions or macros change (main.ts refreshes the welcome screen). */
  onReload: () => void = () => {};

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
            h("span", { class: "chev" }, icon(open ? "chevron-down" : "chevron-right", 14)),
            h("span", { class: "name" }, c.name),
            empty
              ? h("button", { class: "icon", title: "Delete empty folder", onclick: (e: Event) => (e.stopPropagation(), onDeleteFolder(c.path)) }, icon("x", 14))
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
        h("button", { title: "Add a remote server (SSH)", onclick: () => this.editSession(null, "ssh") }, "+ SSH"),
        h("button", { title: "Save a terminal on this PC (PowerShell, WSL, cmd)", onclick: () => this.editSession(null, "local") }, "+ Local"),
        h("button", { title: "Connect a console cable (COM port)", onclick: () => this.quickSerial() }, "+ Serial"),
        h("button", {
          class: "tool",
          title: "More: new folder, import, export",
          onclick: (e: Event) =>
            showMenu(e as MouseEvent, [
              { label: "New folder", action: () => this.newFolder("sessions") },
              { label: "Import sessions and macros...", action: () => this.macroPanel.importBackup() },
              { label: "Export sessions and macros...", action: () => this.macroPanel.exportBackup("all") },
            ]),
        }, icon("more", 15)),
      ),
      search,
      tree,
      list.length === 0 && !q ? h("p", { class: "muted small" }, "No saved sessions yet. Click + SSH to add a server, or + Serial for a console cable.") : null,
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
              h("span", { class: "ico" }, icon("terminal", 15)),
              h("span", { class: "name" }, sh.label),
            ),
          ),
        ),
      ),
      h("h4", {}, "Serial ports"),
      this.serialPorts.length
        ? h(
            "ul",
            { class: "tree" },
            ...this.serialPorts.map((p) =>
              h(
                "li",
                {},
                h(
                  "div",
                  { class: "row item", title: `Connect to ${p.name}`, onclick: () => this.quickSerial(p.name) },
                  h("span", { class: "ico" }, icon("serial", 15)),
                  h("span", { class: "name" }, p.name),
                  h("span", { class: "sub" }, p.description),
                ),
              ),
            ),
          )
        : h("p", { class: "muted small" }, "No serial ports detected. Plug in a console cable and it appears here."),
    );
  }

  connectSession(s: RedactedSession, where: "tab" | "h" | "v" = "tab") {
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
    return h(
      "li",
      {},
      h(
        "div",
        {
          class: "row item",
          tabindex: 0,
          title:
            s.kind === "ssh"
              ? `${s.user}@${s.host}:${s.port} (double-click to connect)`
              : s.kind === "serial"
                ? `${serialSummary(s.serial)} (double-click to connect)`
                : "Local shell",
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
          h("button", { class: "icon", title: "Connect in split", onclick: (e: Event) => (e.stopPropagation(), connect("h")) }, icon("split-h", 14)),
          h("button", { class: "icon", title: "Edit", onclick: (e: Event) => (e.stopPropagation(), this.editSession(s, s.kind)) }, icon("edit", 14)),
          h("button", { class: "icon", title: "Delete", onclick: (e: Event) => (e.stopPropagation(), this.deleteSession(s)) }, icon("trash", 14)),
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

  /** Open the session editor for a new session of the given kind. */
  newSession(kind: Session["kind"]) {
    if (kind === "serial") return this.quickSerial();
    return this.editSession(null, kind);
  }

  private async editSession(existing: RedactedSession | null, kind: Session["kind"], serial?: SerialConfig) {
    const s: Session = existing
      ? { ...existing, serial: existing.serial ?? DEFAULT_SERIAL }
      : {
          id: "",
          name: serial ? `${serial.port} (${serial.baud})` : "",
          folder: "",
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
      const p = await openDialog({ multiple: false, directory: false, title: "Choose private key" });
      if (typeof p === "string") keyPath.value = p;
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
