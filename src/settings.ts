// Settings panel: appearance, behaviour, security, known hosts.
import { icon } from "./icons";
import { api, messageOf, type KnownHost, type RedactedSession, type Settings, type ShellInfo } from "./api";
import { $, confirmDialog, field, h, modal, promptDialog, select, toast } from "./ui";

const THEMES: Record<string, { label: string; background: string; foreground: string; cursor: string; selection: string }> = {
  dark: { label: "Dark (default)", background: "#11151c", foreground: "#d8dee9", cursor: "#88c0d0", selection: "#3b4252" },
  black: { label: "Black", background: "#000000", foreground: "#e6e6e6", cursor: "#ffffff", selection: "#444444" },
  ocean: { label: "Ocean", background: "#0b1d2a", foreground: "#cfe3f0", cursor: "#5ec4ff", selection: "#1f4560" },
  green: { label: "Classic green", background: "#0a0f0a", foreground: "#33ff66", cursor: "#33ff66", selection: "#1e4d2b" },
  light: { label: "Light", background: "#fafafa", foreground: "#1f2328", cursor: "#0969da", selection: "#c8ddf5" },
};

let fontCache: { name: string; monospace: boolean }[] | null = null;

export class SettingsPanel {
  constructor(
    private onSaved: (s: Settings) => void,
    private onTour: (kind: "full" | "whatsNew") => void = () => {},
  ) {}

  async render() {
    const panel = $("panel-settings");
    let s: Settings;
    let hosts: KnownHost[];
    let shells: ShellInfo[];
    let sessions: RedactedSession[];
    try {
      [s, hosts, shells, { sessions }] = await Promise.all([
        api.settingsGet(),
        api.knownHostsList(),
        api.shellsList(),
        api.sessionsList(),
      ]);
    } catch (e) {
      panel.replaceChildren(h("p", { class: "error" }, messageOf(e)));
      return;
    }
    const fontFamily = h("input", { value: s.fontFamily, spellcheck: "false" }) as HTMLInputElement;
    // Installed fonts: fixed-width ones first (best for terminals).
    fontCache ??= await api.fontsList().catch(() => []);
    const clean = (n: string) => n.replace(/['";{}<>\\]/g, "").trim();
    const firstFamily = (css: string) => clean(css.split(",")[0] ?? "");
    const current = firstFamily(s.fontFamily);
    const mono = fontCache.filter((f) => f.monospace).map((f) => clean(f.name)).filter(Boolean);
    const other = fontCache.filter((f) => !f.monospace).map((f) => clean(f.name)).filter(Boolean);
    const fontPick = h("select", {}) as HTMLSelectElement;
    const group = (label: string, names: string[]) =>
      names.length ? h("optgroup", { label }, ...names.map((n) => h("option", { value: n }, n))) : null;
    const known = new Set([...mono, ...other].map((n) => n.toLowerCase()));
    for (const g of [
      known.has(current.toLowerCase()) ? null : group("Current", [current]),
      group("Fixed width (recommended)", mono),
      group("Other fonts", other),
    ])
      if (g) fontPick.append(g);
    fontPick.value = [...fontPick.options].find((o) => o.value.toLowerCase() === current.toLowerCase())?.value ?? current;
    const preview = h("div", { class: "font-preview" }, "user@server:~$ ls -la  0O 1lI {}[] =>");
    const showPreview = () => (preview.style.fontFamily = fontFamily.value);
    fontPick.addEventListener("change", () => {
      fontFamily.value = `'${fontPick.value}', monospace`;
      showPreview();
    });
    fontFamily.addEventListener("input", showPreview);
    showPreview();
    const fontSize = h("input", { type: "number", min: 6, max: 48, value: s.fontSize });
    const bg = h("input", { type: "color", value: s.background });
    const fg = h("input", { type: "color", value: s.foreground });
    const cursor = h("input", { type: "color", value: s.cursor });
    const selection = h("input", { type: "color", value: s.selection });
    const scrollback = h("input", { type: "number", min: 0, max: 200000, step: 1000, value: s.scrollback });
    const copyOnSelect = h("input", { type: "checkbox", checked: s.copyOnSelect });
    const confirmPaste = h("input", { type: "checkbox", checked: s.confirmMultilinePaste });
    const lineDelay = h("input", { type: "number", min: 0, max: 60000, step: 10, value: s.lineDelayMs });
    const mode = select([["safe", "Safe (A-Z 0-9 space _ . / : @ , + -)"], ["unrestricted", "Unrestricted (control characters still blocked)"]], s.validationMode);
    const lockChoices: [string, string][] = [["0", "Never"], ["5", "After 5 minutes"], ["15", "After 15 minutes"], ["30", "After 30 minutes"], ["60", "After 1 hour"], ["240", "After 4 hours"]];
    if (!lockChoices.some(([v]) => Number(v) === s.autoLockMinutes)) lockChoices.push([String(s.autoLockMinutes), `After ${s.autoLockMinutes} minutes`]);
    const autoLock = select(lockChoices, String(s.autoLockMinutes));

    // Theme presets fill in the four colours; "Custom" keeps whatever is set.
    const presetKey = Object.entries(THEMES).find(([, t]) => t.background === s.background && t.foreground === s.foreground)?.[0] ?? "custom";
    const theme = select([...Object.entries(THEMES).map(([k, t]): [string, string] => [k, t.label]), ["custom", "Custom (see Advanced settings)"]], presetKey);
    theme.addEventListener("change", () => {
      const t = THEMES[theme.value];
      if (!t) return;
      bg.value = t.background;
      fg.value = t.foreground;
      cursor.value = t.cursor;
      selection.value = t.selection;
    });
    const sizeChoices: [string, string][] = [["12", "Small (12)"], ["14", "Normal (14)"], ["16", "Large (16)"], ["18", "Extra large (18)"]];
    if (!sizeChoices.some(([v]) => Number(v) === s.fontSize)) sizeChoices.push([String(s.fontSize), `Custom (${s.fontSize})`]);
    const textSize = select(sizeChoices, String(s.fontSize));
    textSize.addEventListener("change", () => (fontSize.value = textSize.value));
    fontSize.addEventListener("change", () => {
      if (![...textSize.options].some((o) => o.value === fontSize.value)) textSize.append(h("option", { value: fontSize.value }, `Custom (${fontSize.value})`));
      textSize.value = fontSize.value;
    });

    const shellOpts = (firstLabel: string): [string, string][] => [["", firstLabel], ...shells.map((x): [string, string] => [x.id, x.label])];
    const firstShell = shells[0]?.label ?? "none found";
    const startupAction = select(
      [["shell", "Open a terminal (PowerShell, WSL, ...)"], ["session", "Connect to a saved session"], ["nothing", "Show the welcome screen"]],
      s.startupAction,
    );
    const startupShell = select(shellOpts("My default terminal"), shells.some((x) => x.id === s.startupShell) ? s.startupShell : "");
    const startupSession = select(
      sessions.length
        ? sessions.map((x): [string, string] => [x.id, (x.folder ? x.folder + "/" : "") + x.name])
        : [["", "No saved sessions yet"]],
      s.startupSession,
    );
    const defaultChoices: [string, string][] = [
      ...shellOpts(`First available (${firstShell})`),
      ...sessions
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((x): [string, string] => [`session:${x.id}`, `Session: ${(x.folder ? x.folder + "/" : "") + x.name}`]),
    ];
    const defaultShell = select(defaultChoices, defaultChoices.some(([v]) => v === s.defaultShell) ? s.defaultShell : "");
    const startupPanes = select([["1", "One pane"], ["2", "Two panes side by side"], ["4", "Four panes (2×2 grid)"]], String(s.startupPanes));
    const startupPanesField = field("Layout", startupPanes);
    const startupShellField = field("Which terminal", startupShell);
    const startupSessionField = field("Session", startupSession);
    const syncStartup = () => {
      startupShellField.classList.toggle("hidden", startupAction.value !== "shell");
      startupSessionField.classList.toggle("hidden", startupAction.value !== "session");
      startupPanesField.classList.toggle("hidden", startupAction.value === "nothing");
    };
    startupAction.addEventListener("change", syncStartup);
    syncStartup();

    const chk = (v: boolean) => h("input", { type: "checkbox", checked: v });
    const reviewAll = chk(s.reviewAll);
    const newMacroReview = chk(s.newMacroReview);
    const searchInCommands = chk(s.searchInCommands);
    const macroSort = select([["manual", "Saved order"], ["name", "Folder, then name"]], s.macroSort);
    const activation = select([["single", "Single click"], ["double", "Double click"]], s.activation);
    const startupMacros = chk(s.startupMacrosEnabled);
    const startupTimeout = h("input", { type: "number", min: 1000, max: 60000, step: 1000, value: s.startupTimeoutMs });
    const tabStatus = chk(s.tabStatus);
    const tabStatusFallback = chk(s.tabStatusFallback);
    const lockDisconnects = chk(s.lockDisconnects);
    const rightClickPaste = chk(s.rightClickPaste);
    const logAuto = chk(s.logAuto);
    const logDirText = h("span", { class: "mono small log-dir" }, s.logDir || "No folder chosen");
    logAuto.disabled = !s.logDir;
    const pickLogDir = h("button", {
      type: "button",
      onclick: async () => {
        try {
          const dir = await api.logFolderPick();
          if (!dir) return;
          logDirText.textContent = dir;
          logAuto.disabled = false;
        } catch (e) {
          toast(messageOf(e), "error");
        }
      },
    }, "Choose folder...");
    // Applies at once (not with Save): it needs the master password to turn off.
    const vs = await api.vaultStatus();
    const askOnOpen = h("input", { type: "checkbox", checked: !vs.remembered, disabled: !vs.rememberAvailable || vs.passwordless }) as HTMLInputElement;
    askOnOpen.addEventListener("change", async () => {
      const ask = askOnOpen.checked;
      askOnOpen.disabled = true;
      try {
        if (ask) {
          await api.vaultSetRemember(false);
          toast("Siakap will ask for the master password when it opens.", "ok");
        } else {
          const pw = await promptDialog("Open without the master password", "Master password", {
            password: true,
            okLabel: "Turn off",
            hint: "Siakap will open straight away on this PC, for your Windows account only. Anyone who can sign in to your Windows account can then open your sessions and saved passwords.",
            validate: (v) => (v ? null : "Enter your master password."),
          });
          if (pw === null) {
            askOnOpen.checked = true;
            return;
          }
          await api.vaultSetRemember(true, pw);
          toast("Siakap will open without asking for the master password on this PC.", "ok");
        }
      } catch (e) {
        askOnOpen.checked = !ask;
        toast(messageOf(e), "error");
      } finally {
        askOnOpen.disabled = !vs.rememberAvailable || vs.passwordless;
      }
    });

    const save = async () => {
      const next: Settings = {
        ...s,
        reviewAll: reviewAll.checked,
        newMacroReview: newMacroReview.checked,
        searchInCommands: searchInCommands.checked,
        macroSort: macroSort.value as Settings["macroSort"],
        activation: activation.value as Settings["activation"],
        startupMacrosEnabled: startupMacros.checked,
        startupTimeoutMs: Number(startupTimeout.value) || 10000,
        tabStatus: tabStatus.checked,
        tabStatusFallback: tabStatusFallback.checked,
        lockDisconnects: lockDisconnects.checked,
        rightClickPaste: rightClickPaste.checked,
        logAuto: logAuto.checked && !logAuto.disabled,
        logDir: s.logDir,
        fontFamily: fontFamily.value,
        fontSize: Number(fontSize.value),
        background: bg.value,
        foreground: fg.value,
        cursor: cursor.value,
        selection: selection.value,
        scrollback: Number(scrollback.value),
        copyOnSelect: copyOnSelect.checked,
        confirmMultilinePaste: confirmPaste.checked,
        lineDelayMs: Number(lineDelay.value),
        validationMode: mode.value as Settings["validationMode"],
        autoLockMinutes: Number(autoLock.value),
        startupAction: startupAction.value as Settings["startupAction"],
        startupShell: startupShell.value,
        startupSession: startupSession.value,
        defaultShell: defaultShell.value,
        startupPanes: Number(startupPanes.value) as Settings["startupPanes"],
      };
      try {
        const saved = await api.settingsSave(next);
        this.onSaved(saved);
        toast("Settings saved.", "ok", 2000);
        await this.render();
      } catch (e) {
        toast(messageOf(e), "error");
      }
    };

    const hostRows = hosts.map((k) =>
      h(
        "div",
        { class: "kh-row" },
        h("div", {}, h("strong", {}, `${k.host}:${k.port}`), h("div", { class: "mono small" }, `${k.keyType} ${k.fingerprint}`)),
        h(
          "button",
          {
            class: "icon",
            title: "Forget this host key",
            onclick: async () => {
              if (!(await confirmDialog("Forget host key?", `Remove the stored key for ${k.host}:${k.port}? You will be asked to verify the fingerprint again on the next connection.`, "Forget", { danger: true }))) return;
              await api.knownHostRemove(k.host, k.port).catch((e) => toast(messageOf(e), "error"));
              await this.render();
            },
          },
          icon("trash", 15),
        ),
      ),
    );

    panel.replaceChildren(
      h("header", { class: "panel-head" }, h("h3", {}, "Settings")),
      h(
        "form",
        { class: "form", onsubmit: (e: Event) => (e.preventDefault(), void save()) },
        h("h4", {}, "When Siakap starts"),
        field("Open", startupAction),
        startupShellField,
        startupSessionField,
        startupPanesField,
        field("New tabs open", defaultShell, "What the + button and Ctrl+Shift+T open: a terminal on this PC, or one of your saved sessions. Right-click + to pick something else."),
        h("h4", {}, "Look"),
        field("Theme", theme),
        field("Font", fontPick, fontCache.length ? undefined : "Couldn't list the fonts on this PC. Type a font name under Advanced settings."),
        preview,
        field("Text size", textSize),
        h("label", { class: "check" }, rightClickPaste, " Right-click pastes"),
        h("small", { class: "muted" }, "With text selected, right-click copies it instead. Shift+right-click shows the menu. Off: right-click shows the menu."),
        h("h4", {}, "Session logs"),
        h("label", { class: "check" }, logAuto, " Log every terminal to a file automatically"),
        h("div", { class: "inline log-dir-row" }, logDirText, pickLogDir),
        h(
          "small",
          { class: "muted" },
          "Each terminal gets its own .log file in this folder, named with the date, time and session. Logs are plain text and contain everything the terminal shows, so keep the folder private. To log just one terminal, right-click it and choose Log to file.",
        ),
        h("h4", {}, "Security"),
        ...(vs.passwordless
          ? [
              h("p", { class: "muted small" }, "No master password: Siakap opens with your Windows account on this PC. Lock only hides the window."),
              h("button", { type: "button", onclick: () => void this.setMasterPassword() }, "Set a master password"),
            ]
          : [
              h("label", { class: "check" }, askOnOpen, " Ask for the master password when Siakap opens"),
              h(
                "small",
                { class: "muted" },
                vs.rememberAvailable
                  ? "Off: Siakap opens straight away on this PC, for your Windows account only. The Lock button and auto-lock still ask for the password."
                  : "Turning this off is only available on Windows.",
              ),
            ]),
        field("Lock the app", autoLock, "When nobody has used Siakap for this long, it locks and asks for the master password."),
        h("label", { class: "check" }, lockDisconnects, " Disconnect all sessions when Siakap locks"),
        h("small", { class: "muted" }, "Off: open terminals keep running but stay hidden until you unlock. On: every terminal is closed when Siakap locks."),
        h(
          "details",
          { class: "advanced" },
          h("summary", {}, "Advanced settings"),
          h("div", { class: "form" },
            field("Font (with fallbacks)", fontFamily, "Fonts are tried in order, e.g. Cascadia Mono, Consolas, monospace."),
            field("Exact text size", fontSize),
            h("div", { class: "grid2" }, field("Background", bg), field("Text", fg), field("Cursor", cursor), field("Selection", selection)),
            field("Lines of history to keep", scrollback),
            h("label", { class: "check" }, copyOnSelect, " Copy text as soon as it is selected"),
            h("label", { class: "check" }, confirmPaste, " Ask before pasting more than one line"),
            h("h4", {}, "Macros"),
            field("Run a macro with", activation, "Applies to macro names. The run button always takes one click."),
            field("Sort macros", macroSort),
            h("label", { class: "check" }, searchInCommands, " Search inside macro commands (names and folders are always searched)"),
            field("Pause between commands (ms)", lineDelay, "# @wait pauses in a macro are added on top."),
            h("label", { class: "check" }, reviewAll, " Review every macro before running"),
            h("label", { class: "check" }, newMacroReview, " New macros: edit the whole command before run"),
            field("Allowed characters in input values", mode, "Safe mode blocks shell operators and control characters."),
            h("h4", {}, "Startup commands"),
            h("label", { class: "check" }, startupMacros, " Run sessions' startup commands after connecting"),
            field("Wait for a prompt for up to (ms)", startupTimeout, "If no prompt appears in time, the startup commands are skipped."),
            h("h4", {}, "Tab status dots"),
            h("label", { class: "check" }, tabStatus, " Show command status on tabs (blue running, green success, red failure)"),
            h("label", { class: "check" }, tabStatusFallback, " Detect prompts and error messages"),
            h("small", { class: "muted" }, "For devices and shells that don't report command results. Results are estimates. Kept in memory only."),
          ),
        ),
        h("button", { type: "submit", class: "primary" }, "Save settings"),
      ),
      ...(vs.passwordless ? [] : [h("button", { onclick: () => this.changePassword() }, "Change master password")]),
      h("div", { class: "inline" },
        h("button", { onclick: () => this.onTour("full") }, "Show the tour again"),
        h("button", { onclick: () => this.onTour("whatsNew") }, "What's new"),
      ),
      h(
        "details",
        { class: "advanced" },
        h("summary", {}, `Trusted servers (${hosts.length})`),
        h("p", { class: "muted small" }, "Servers whose identity you have confirmed. Remove one only if its administrator told you its key changed."),
        hosts.length ? h("div", { class: "kh-list" }, ...hostRows) : h("p", { class: "muted small" }, "None yet."),
      ),
      h("p", { class: "muted small" }, "Siakap only connects to the servers and devices you open. It sends no usage data and checks for nothing online."),
    );
  }

  private async setMasterPassword() {
    const n1 = h("input", { type: "password", autocomplete: "off" });
    const n2 = h("input", { type: "password", autocomplete: "off" });
    const err = h("div", { class: "error" });
    const done = await modal<boolean>("Set a master password", (close) => {
      const go = async () => {
        if (n1.value !== n2.value) return void (err.textContent = "The passwords don't match.");
        if (n1.value.length < 12) return void (err.textContent = "Use at least 12 characters. A short sentence works well.");
        try {
          await api.vaultSetMasterPassword(n1.value);
          n1.value = n2.value = "";
          close(true);
        } catch (e) {
          err.textContent = messageOf(e);
        }
      };
      return {
        body: h(
          "div",
          { class: "form" },
          h("p", { class: "muted small" }, "Siakap will ask for it when it opens and when it is locked. You can still turn off asking when it opens, below."),
          field("Master password", n1),
          field("Repeat master password", n2),
          err,
        ),
        actions: [h("button", { onclick: () => close(false) }, "Cancel"), h("button", { class: "primary", onclick: () => void go() }, "Set password")],
        focus: n1,
      };
    }, { dismissValue: false });
    if (done) {
      toast("Master password set. Siakap will ask for it when it opens.", "ok");
      this.onPasswordModeChanged?.();
      await this.render();
    }
  }

  /** Set by main.ts: the vault's password mode changed. */
  onPasswordModeChanged?: () => void;

  private async changePassword() {
    const old = h("input", { type: "password", autocomplete: "off" });
    const n1 = h("input", { type: "password", autocomplete: "off" });
    const n2 = h("input", { type: "password", autocomplete: "off" });
    const err = h("div", { class: "error" });
    await modal<void>("Change master password", (close) => {
      const go = async () => {
        if (n1.value !== n2.value) return void (err.textContent = "The new passwords don't match.");
        if (n1.value.length < 12) return void (err.textContent = "Use at least 12 characters. A short sentence works well.");
        try {
          await api.vaultChangePassword(old.value, n1.value);
          old.value = n1.value = n2.value = "";
          toast("Master password changed.", "ok");
          close();
        } catch (e) {
          err.textContent = messageOf(e);
        }
      };
      return {
        body: h("div", { class: "form" }, field("Current password", old), field("New password", n1), field("Repeat new password", n2), err),
        actions: [h("button", { onclick: () => close() }, "Cancel"), h("button", { class: "primary", onclick: () => void go() }, "Change")],
        focus: old,
      };
    });
  }
}
