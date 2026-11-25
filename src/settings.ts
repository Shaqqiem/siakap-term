// Settings, shown as its own tab: a section list on the left (with search) and
// compact rows on the right. Every change is saved straight away.
import { icon } from "./icons";
import { api, messageOf, type KnownHost, type RedactedSession, type Settings, type ShellInfo, type TerminalTheme } from "./api";
import { ANSI_NAMES, BUILTIN_THEMES, DEFAULT_PALETTE, currentTheme, exportTheme, hex6, parseThemes, uniqueName, withTheme } from "./themes";
import { confirmDialog, field, h, modal, promptDialog, select, showMenu, toast } from "./ui";
import { version as APP_VERSION } from "../package.json";

let fontCache: { name: string; monospace: boolean }[] | null = null;

interface Section {
  id: string;
  title: string;
  icon: string;
  build: () => (HTMLElement | null)[];
}

type Opt = [string, string];

const SHORTCUTS: [string, string][] = [
  ["Ctrl+Shift+T", "New tab"],
  ["Ctrl+Shift+D", "Split side by side"],
  ["Ctrl+Shift+E", "Split top and bottom"],
  ["Ctrl+Shift+G", "Split into four panes"],
  ["Ctrl+Shift+W", "Close the focused pane"],
  ["Ctrl+Tab / Ctrl+Shift+Tab", "Next / previous tab"],
  ["Ctrl+Shift+C", "Copy the selection"],
  ["Ctrl+Shift+V", "Paste"],
  ["Right-click", "Paste, or copy when text is selected (if turned on below)"],
  ["Shift+right-click", "Terminal menu"],
  ["Ctrl+Shift+B", "Send a break (serial consoles)"],
  ["Esc", "Stop a running macro"],
  ["Middle-click a tab", "Close it"],
];

export class SettingsPanel {
  /** The page's content (id "panel-settings"). */
  readonly el = h("div", { id: "panel-settings", class: "settings-page" });
  private s!: Settings;
  private saveTimer = 0;
  private status = h("span", { class: "save-status muted small" });
  private query = "";
  private scrollTo = "";

  constructor(
    private onSaved: (s: Settings) => void,
    private onTour: (kind: "full" | "whatsNew") => void = () => {},
  ) {}

  /** Set by main.ts: the vault's password mode changed. */
  onPasswordModeChanged?: () => void;
  /** Set by main.ts: show a section (used by the tour). */
  show(section: string) {
    this.scrollTo = section;
    void this.render();
  }

  // ------------------------------------------------------------ saving

  /** Merge a change into the settings and save it shortly after. */
  private set(patch: Partial<Settings>, rerender = false) {
    this.s = { ...this.s, ...patch };
    this.onSaved(this.s); // apply at once (theme, fonts, ...)
    window.clearTimeout(this.saveTimer);
    this.status.textContent = "Saving...";
    this.saveTimer = window.setTimeout(async () => {
      try {
        this.s = await api.settingsSave(this.s);
        this.onSaved(this.s);
        this.status.textContent = "All changes saved";
      } catch (e) {
        this.status.textContent = "";
        toast(messageOf(e), "error");
      }
    }, 300);
    if (rerender) void this.render(true);
  }

  // ------------------------------------------------------------ controls

  private row(label: string, desc: string, control: HTMLElement | null, opts: { extra?: HTMLElement | null; cls?: string } = {}) {
    return h(
      "div",
      { class: `set-row ${opts.cls ?? ""}`, "data-search": `${label} ${desc}`.toLowerCase() },
      h("div", { class: "set-text" }, h("div", { class: "set-label" }, label), desc ? h("div", { class: "set-desc" }, desc) : null),
      h("div", { class: "set-control" }, control),
      opts.extra ?? null,
    );
  }

  /** On/off switch. A `label.check` so clicking the text toggles it too. */
  private toggle<K extends keyof Settings>(key: K, label: string, desc = "", after?: (v: boolean) => void) {
    const input = h("input", { type: "checkbox", class: "switch", checked: !!this.s[key] }) as HTMLInputElement;
    input.addEventListener("change", () => {
      this.set({ [key]: input.checked } as Partial<Settings>);
      after?.(input.checked);
    });
    return h(
      "label",
      { class: "set-row check", "data-search": `${label} ${desc}`.toLowerCase() },
      h("div", { class: "set-text" }, h("div", { class: "set-label" }, label), desc ? h("div", { class: "set-desc" }, desc) : null),
      h("div", { class: "set-control" }, input),
    );
  }

  private choice<K extends keyof Settings>(key: K, label: string, desc: string, options: Opt[], parse: (v: string) => Settings[K] = (v) => v as Settings[K], rerender = false) {
    const sel = select(options, String(this.s[key]));
    sel.addEventListener("change", () => this.set({ [key]: parse(sel.value) } as Partial<Settings>, rerender));
    return this.row(label, desc, sel);
  }

  private number<K extends keyof Settings>(key: K, label: string, desc: string, min: number, max: number, step: number, unit = "") {
    const input = h("input", { type: "number", min, max, step, value: String(this.s[key]) }) as HTMLInputElement;
    input.addEventListener("change", () => {
      const v = Math.min(max, Math.max(min, Number(input.value) || min));
      input.value = String(v);
      this.set({ [key]: v } as Partial<Settings>);
    });
    return this.row(label, desc, h("div", { class: "inline num" }, input, unit ? h("span", { class: "muted small" }, unit) : null));
  }

  // ------------------------------------------------------------ render

  async render(keepScroll = false) {
    const el = this.el;
    let hosts: KnownHost[];
    let shells: ShellInfo[];
    let sessions: RedactedSession[];
    let vs: Awaited<ReturnType<typeof api.vaultStatus>>;
    try {
      // A redraw after a change keeps the settings being edited (a save may still be pending).
      const fresh = keepScroll && this.s ? Promise.resolve(this.s) : api.settingsGet();
      [this.s, hosts, shells, { sessions }, vs] = await Promise.all([fresh, api.knownHostsList(), api.shellsList(), api.sessionsList(), api.vaultStatus()]);
    } catch (e) {
      el.replaceChildren(h("p", { class: "error" }, messageOf(e)));
      return;
    }
    fontCache ??= await api.fontsList().catch(() => []);
    const scroller = el.querySelector(".settings-body") as HTMLElement | null;
    const top = keepScroll && scroller ? scroller.scrollTop : 0;

    const sections: Section[] = [
      { id: "appearance", title: "Appearance", icon: "palette", build: () => this.appearance() },
      { id: "terminal", title: "Terminal", icon: "terminal", build: () => this.terminal() },
      { id: "startup", title: "Startup and tabs", icon: "play", build: () => this.startup(shells, sessions) },
      { id: "mouse", title: "Mouse and clipboard", icon: "paste", build: () => this.mouse() },
      { id: "macros", title: "Macros", icon: "macros", build: () => this.macros() },
      { id: "logs", title: "Session logs", icon: "file", build: () => this.logs() },
      { id: "security", title: "Security", icon: "lock", build: () => this.security(vs) },
      { id: "hosts", title: `Trusted servers (${hosts.length})`, icon: "shield", build: () => this.hosts(hosts) },
      { id: "keys", title: "Keyboard shortcuts", icon: "keyboard", build: () => this.shortcuts() },
      { id: "about", title: "About", icon: "logo", build: () => this.about() },
    ];

    const body = h("div", { class: "settings-body" });
    const nav = h("nav", { class: "settings-nav" });
    for (const sec of sections) {
      const card = h("section", { class: "set-section", id: `set-${sec.id}`, "data-section": sec.id }, h("h2", {}, icon(sec.icon, 17), sec.title), ...sec.build());
      body.append(card);
      nav.append(
        h("button", { class: "set-nav-item", "data-target": sec.id, onclick: () => card.scrollIntoView({ behavior: "smooth", block: "start" }) }, icon(sec.icon, 15), h("span", {}, sec.title)),
      );
    }
    const empty = h("p", { class: "muted set-empty hidden" }, "No setting matches your search.");
    body.append(empty);

    const search = h("input", { type: "search", class: "set-search", placeholder: "Search settings", spellcheck: "false", value: this.query }) as HTMLInputElement;
    const filter = () => {
      this.query = search.value;
      const q = search.value.trim().toLowerCase();
      let any = false;
      body.querySelectorAll<HTMLElement>(".set-section").forEach((sec) => {
        let shown = 0;
        sec.querySelectorAll<HTMLElement>("[data-search]").forEach((r) => {
          const hit = !q || (r.dataset.search ?? "").includes(q) || (sec.querySelector("h2")?.textContent ?? "").toLowerCase().includes(q);
          r.classList.toggle("hidden", !hit);
          if (hit) shown++;
        });
        const blocks = sec.querySelectorAll(".set-block");
        blocks.forEach((b) => b.classList.toggle("hidden", !!q && !(sec.querySelector("h2")?.textContent ?? "").toLowerCase().includes(q)));
        const visible = shown > 0 || (!q && blocks.length > 0);
        sec.classList.toggle("hidden", !visible);
        nav.querySelector<HTMLElement>(`[data-target="${sec.dataset.section}"]`)?.classList.toggle("dim", !visible);
        any ||= visible;
      });
      empty.classList.toggle("hidden", any);
    };
    search.addEventListener("input", filter);

    // Highlight the section in view.
    body.addEventListener("scroll", () => {
      let current = sections[0].id;
      for (const sec of body.querySelectorAll<HTMLElement>(".set-section:not(.hidden)")) {
        if (sec.offsetTop - body.scrollTop <= 40) current = sec.dataset.section!;
      }
      nav.querySelectorAll<HTMLElement>(".set-nav-item").forEach((b) => b.classList.toggle("active", b.dataset.target === current));
    });

    el.replaceChildren(
      h("aside", { class: "settings-side" }, h("h1", {}, "Settings"), search, nav, this.status),
      body,
    );
    if (this.query) filter();
    nav.querySelector(".set-nav-item")?.classList.add("active");
    if (this.scrollTo) {
      const target = body.querySelector(`#set-${this.scrollTo}`);
      this.scrollTo = "";
      requestAnimationFrame(() => target?.scrollIntoView({ block: "start" }));
    } else if (top) body.scrollTop = top;
  }

  // ------------------------------------------------------------ sections

  private appearance(): HTMLElement[] {
    const s = this.s;
    const cur = currentTheme(s);
    const all = [...BUILTIN_THEMES, ...s.customThemes];
    const isCustom = (t: TerminalTheme) => s.customThemes.some((x) => x.name === t.name);
    const swatch = (t: TerminalTheme) => {
      const pal = t.palette.length === 16 ? t.palette : DEFAULT_PALETTE;
      return h(
        "div",
        { class: "theme-swatch", style: `background:${t.background};color:${t.foreground}` },
        h("span", { class: "sw-text" }, "Aa ~$"),
        h("span", { class: "sw-dots" }, ...[1, 2, 3, 4, 5, 6].map((i) => h("i", { style: `background:${pal[i]}` }))),
      );
    };
    const gallery = h(
      "div",
      { class: "theme-gallery" },
      ...all.map((t) => {
        const active = t.name === s.themeName;
        const card = h(
          "button",
          { class: `theme-card${active ? " active" : ""}`, title: t.name, "data-theme": t.name, onclick: () => this.set(withTheme(this.s, t), true) },
          swatch(t),
          h("span", { class: "theme-name" }, t.name, isCustom(t) ? h("span", { class: "badge" }, "mine") : null),
        );
        card.addEventListener("contextmenu", (e) =>
          showMenu(e, [
            { label: "Use this theme", action: () => this.set(withTheme(this.s, t), true) },
            { label: "Export...", action: () => this.exportTheme(t) },
            ...(isCustom(t)
              ? [
                  { label: "Rename...", action: () => this.renameTheme(t) },
                  { label: "Delete", danger: true, action: () => this.deleteTheme(t) },
                ]
              : []),
          ]),
        );
        return card;
      }),
    );

    // Colour editor.
    const colour = (label: string, value: string, onChange: (v: string) => void) => {
      const input = h("input", { type: "color", value: hex6(value) }) as HTMLInputElement;
      input.addEventListener("change", () => onChange(input.value));
      return h("label", { class: "colour-field", "data-search": label.toLowerCase() }, input, h("span", {}, label));
    };
    const edit = (patch: Partial<Settings>) => {
      const named = this.s.themeName.endsWith(" (edited)") || this.s.themeName === "Custom" ? this.s.themeName : `${this.s.themeName || "Custom"} (edited)`;
      this.set({ ...patch, themeName: named }, true);
    };
    const pal = s.palette.length === 16 ? s.palette : DEFAULT_PALETTE;
    const editor = h(
      "details",
      { class: "set-block theme-editor", open: s.themeName.endsWith("(edited)") || s.themeName === "Custom" },
      h("summary", {}, "Customise colours"),
      h(
        "div",
        { class: "colour-grid" },
        colour("Background", s.background, (v) => edit({ background: v })),
        colour("Text", s.foreground, (v) => edit({ foreground: v })),
        colour("Cursor", s.cursor, (v) => edit({ cursor: v })),
        colour("Selection", s.selection, (v) => edit({ selection: v })),
        colour("App accent", s.accent || "#5aa9e6", (v) => edit({ accent: v })),
      ),
      h("div", { class: "set-subhead" }, "Terminal colours (ANSI)"),
      h(
        "div",
        { class: "colour-grid ansi" },
        ...ANSI_NAMES.map((name, i) =>
          colour(name, pal[i], (v) => {
            const next = [...pal];
            next[i] = v;
            edit({ palette: next });
          }),
        ),
      ),
      h(
        "div",
        { class: "inline" },
        h("button", { type: "button", onclick: () => this.saveAsTheme() }, "Save as a new theme..."),
        s.palette.length ? h("button", { type: "button", onclick: () => edit({ palette: [] }) }, "Use built-in terminal colours") : null,
        s.accent ? h("button", { type: "button", onclick: () => edit({ accent: "" }) }, "Default accent") : null,
      ),
    );

    // Live preview using the current colours.
    const c = (i: number, text: string) => h("span", { style: `color:${pal[i]}` }, text);
    const preview = h(
      "div",
      { class: "set-block term-preview", style: `background:${s.background};color:${s.foreground};font-family:${s.fontFamily};font-size:${Math.min(s.fontSize, 15)}px;line-height:${(s.lineHeight || 100) / 100}` },
      h("div", {}, c(2, "you@workstation"), ":", c(4, "~/projects"), "$ ls"),
      h("div", {}, c(4, "docs  "), c(2, "deploy.sh  "), c(1, "broken-link  "), c(3, "notes.txt  "), c(5, "photo.png  "), c(6, "socket")),
      h("div", {}, c(8, "# a comment in bright black")),
      h("div", {}, c(9, "error: "), "connection refused  ", c(10, "ok "), c(11, "warn "), c(12, "info "), c(13, "debug "), c(14, "trace")),
      h("div", {}, c(2, "you@workstation"), ":", c(4, "~"), "$ ", h("span", { class: "preview-sel", style: `background:${s.selection}` }, "selected text"), " ", h("span", { class: "preview-cursor", style: `background:${s.cursor}` }, " ")),
    );

    return [
      this.row("Theme", `Click a theme to use it. Right-click a theme to export it${s.customThemes.length ? ", or rename or delete your own" : ""}.`, h("span", { class: "muted small" }, cur.name)),
      h("div", { class: "set-block" }, gallery),
      preview,
      this.row(
        "Import or export",
        "Theme files are JSON. Siakap also reads Windows Terminal colour schemes (a single scheme, or the \"schemes\" list from its settings file).",
        h(
          "div",
          { class: "inline" },
          h("button", { type: "button", onclick: () => this.importThemes() }, icon("import", 14), " Import..."),
          h("button", { type: "button", onclick: () => this.exportTheme(currentTheme(this.s)) }, icon("export", 14), " Export current"),
        ),
      ),
      editor,
    ];
  }

  private terminal(): HTMLElement[] {
    const s = this.s;
    const clean = (n: string) => n.replace(/['";{}<>\\]/g, "").trim();
    const current = clean(s.fontFamily.split(",")[0] ?? "");
    const mono = (fontCache ?? []).filter((f) => f.monospace).map((f) => clean(f.name)).filter(Boolean);
    const other = (fontCache ?? []).filter((f) => !f.monospace).map((f) => clean(f.name)).filter(Boolean);
    const fontPick = h("select", {}) as HTMLSelectElement;
    const group = (label: string, names: string[]) => (names.length ? h("optgroup", { label }, ...names.map((n) => h("option", { value: n }, n))) : null);
    const known = new Set([...mono, ...other].map((n) => n.toLowerCase()));
    for (const g of [known.has(current.toLowerCase()) ? null : group("Current", [current]), group("Fixed width (recommended)", mono), group("Other fonts", other)]) if (g) fontPick.append(g);
    fontPick.value = [...fontPick.options].find((o) => o.value.toLowerCase() === current.toLowerCase())?.value ?? current;
    fontPick.addEventListener("change", () => this.set({ fontFamily: `'${fontPick.value}', monospace` }, true));
    const fallback = h("input", { value: s.fontFamily, spellcheck: "false" }) as HTMLInputElement;
    fallback.addEventListener("change", () => this.set({ fontFamily: fallback.value }, true));

    const sizes: Opt[] = [10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24].map((n) => [String(n), `${n}${n === 14 ? " (normal)" : ""}`]);
    if (!sizes.some(([v]) => Number(v) === s.fontSize)) sizes.push([String(s.fontSize), String(s.fontSize)]);
    return [
      this.row("Font", fontCache?.length ? "Fonts installed on this PC. Fixed-width fonts line up columns properly." : "Couldn't list the fonts on this PC. Type a font name below.", fontPick),
      this.row("Font with fallbacks", "Tried in order, e.g. Cascadia Mono, Consolas, monospace.", fallback),
      this.choice("fontSize", "Text size", "", sizes, (v) => Number(v), true),
      this.choice("lineHeight", "Line spacing", "", [["100", "Normal"], ["110", "Relaxed (110%)"], ["120", "Loose (120%)"], ["135", "Extra loose (135%)"]], (v) => Number(v), true),
      this.choice("cursorStyle", "Cursor shape", "", [["block", "Block"], ["bar", "Bar"], ["underline", "Underline"]], (v) => v as Settings["cursorStyle"]),
      this.toggle("cursorBlink", "Blinking cursor"),
      this.number("scrollback", "Lines of history", "How far back you can scroll. More uses more memory.", 0, 200000, 1000, "lines"),
      this.toggle("minContrast", "Improve hard-to-read colours", "Raises the contrast of text whose colour is too close to the background."),
      this.choice("bell", "Terminal bell", "What happens when a program rings the bell.", [["flash", "Flash the pane and mark its tab"], ["off", "Nothing"]], (v) => v as Settings["bell"]),
      this.row("Word boundaries", "Characters that end a word when you double-click to select.", this.textInput("wordSeparators")),
    ];
  }

  private textInput<K extends keyof Settings>(key: K) {
    const input = h("input", { value: String(this.s[key] ?? ""), spellcheck: "false" }) as HTMLInputElement;
    input.addEventListener("change", () => this.set({ [key]: input.value } as Partial<Settings>));
    return input;
  }

  private startup(shells: ShellInfo[], sessions: RedactedSession[]): HTMLElement[] {
    const s = this.s;
    const firstShell = shells[0]?.label ?? "none found";
    const shellOpts = (firstLabel: string): Opt[] => [["", firstLabel], ...shells.map((x): Opt => [x.id, x.label])];
    const sorted = sessions.slice().sort((a, b) => a.name.localeCompare(b.name));
    const sessionLabel = (x: RedactedSession) => (x.folder ? x.folder + "/" : "") + x.name;
    const defaults: Opt[] = [...shellOpts(`First available (${firstShell})`), ...sorted.map((x): Opt => [`session:${x.id}`, `Session: ${sessionLabel(x)}`])];
    const rows: (HTMLElement | null)[] = [
      this.choice("startupAction", "When Siakap starts", "", [["shell", "Open a terminal"], ["session", "Connect to a saved session"], ["nothing", "Show the welcome screen"]], (v) => v as Settings["startupAction"], true),
      s.startupAction === "shell" ? this.choice("startupShell", "Which terminal", "", shellOpts("My default terminal")) : null,
      s.startupAction === "session"
        ? this.choice("startupSession", "Which session", "", sessions.length ? sorted.map((x): Opt => [x.id, sessionLabel(x)]) : [["", "No saved sessions yet"]])
        : null,
      s.startupAction !== "nothing" ? this.choice("startupPanes", "Layout at start", "", [["1", "One pane"], ["2", "Two panes side by side"], ["4", "Four panes (2×2)"]], (v) => Number(v) as Settings["startupPanes"]) : null,
      this.choice("defaultShell", "New tabs open", "What + and Ctrl+Shift+T open. Right-click + to pick something else.", defaults.some(([v]) => v === s.defaultShell) ? defaults : [...defaults, [s.defaultShell, s.defaultShell]]),
      this.toggle("confirmCloseTab", "Ask before closing a tab with several sessions"),
      this.toggle("tabStatus", "Command status on tabs", "Blue while a command runs, then green for success or red for failure."),
      this.toggle("tabStatusFallback", "Guess status from prompts and errors", "For devices and shells that don't report command results. Results are estimates."),
    ];
    return rows.filter((x): x is HTMLElement => !!x);
  }

  private mouse(): HTMLElement[] {
    return [
      this.toggle("rightClickPaste", "Right-click pastes", "With text selected, right-click copies it instead. Shift+right-click shows the menu."),
      this.toggle("copyOnSelect", "Copy as soon as text is selected"),
      this.toggle("confirmMultilinePaste", "Ask before pasting more than one line", "Each line break can run a command, so Siakap shows the text first."),
    ];
  }

  private macros(): HTMLElement[] {
    return [
      this.choice("activation", "Run a macro with", "", [["single", "A single click"], ["double", "A double click"]], (v) => v as Settings["activation"]),
      this.choice("macroSort", "Macro order", "", [["manual", "The order you saved them"], ["name", "Folder, then name"]], (v) => v as Settings["macroSort"]),
      this.toggle("searchInCommands", "Search inside macro commands", "Macro names and folders are always searched."),
      this.toggle("reviewAll", "Let me edit every macro before it runs"),
      this.toggle("newMacroReview", "New macros ask to be reviewed before running"),
      this.number("lineDelayMs", "Pause between lines", "How long a macro waits after each line it types.", 0, 60000, 10, "ms"),
      this.choice("validationMode", "Input values allowed", "What you may type when a macro asks for a value.", [["safe", "Safe: letters, digits, space and _ . / : @ , + -"], ["unrestricted", "Anything except control characters"]], (v) => v as Settings["validationMode"]),
      this.toggle("startupMacrosEnabled", "Run sessions' startup commands"),
      this.number("startupTimeoutMs", "Wait for a prompt for up to", "If no prompt appears in time, the startup commands are skipped.", 1000, 60000, 1000, "ms"),
    ];
  }

  private logs(): HTMLElement[] {
    const s = this.s;
    const dir = h("span", { class: "mono small log-dir" }, s.logDir || "No folder chosen");
    const pick = h("button", {
      type: "button",
      onclick: async () => {
        try {
          const d = await api.logFolderPick();
          if (!d) return;
          this.s = { ...this.s, logDir: d }; // the backend stored it; keep the page in step
          await this.render(true);
          toast(`Session logs will go to ${d}`, "ok");
        } catch (e) {
          toast(messageOf(e), "error");
        }
      },
    }, "Choose folder...");
    const auto = this.toggle("logAuto", "Log every terminal to a file automatically", "Each terminal gets its own .log file, named with the date, time and session.");
    const input = auto.querySelector("input") as HTMLInputElement;
    input.disabled = !s.logDir;
    return [
      auto,
      this.row("Log folder", "Logs are plain text and contain everything the terminal shows, so keep this folder private. To log just one terminal, right-click its tab.", h("div", { class: "inline log-dir-row" }, dir, pick)),
    ];
  }

  private security(vs: Awaited<ReturnType<typeof api.vaultStatus>>): HTMLElement[] {
    const lockChoices: Opt[] = [["0", "Never"], ["5", "After 5 minutes"], ["15", "After 15 minutes"], ["30", "After 30 minutes"], ["60", "After 1 hour"], ["240", "After 4 hours"]];
    if (!lockChoices.some(([v]) => Number(v) === this.s.autoLockMinutes)) lockChoices.push([String(this.s.autoLockMinutes), `After ${this.s.autoLockMinutes} minutes`]);
    const rows: HTMLElement[] = [];
    if (vs.passwordless) {
      rows.push(
        this.row(
          "Master password",
          "None: Siakap opens with your Windows account on this PC, and Lock only hides the window.",
          h("button", { type: "button", onclick: () => void this.setMasterPassword() }, "Set a master password"),
        ),
      );
    } else {
      const ask = h("input", { type: "checkbox", class: "switch", checked: !vs.remembered, disabled: !vs.rememberAvailable }) as HTMLInputElement;
      ask.addEventListener("change", async () => {
        const want = ask.checked;
        ask.disabled = true;
        try {
          if (want) {
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
              ask.checked = true;
              return;
            }
            await api.vaultSetRemember(true, pw);
            toast("Siakap will open without asking for the master password on this PC.", "ok");
          }
        } catch (e) {
          ask.checked = !want;
          toast(messageOf(e), "error");
        } finally {
          ask.disabled = !vs.rememberAvailable;
        }
      });
      const label = "Ask for the master password when Siakap opens";
      const desc = vs.rememberAvailable ? "Off: Siakap opens straight away on this PC, for your Windows account only. Lock and auto-lock still ask." : "Turning this off is only available on Windows.";
      rows.push(
        h("label", { class: "set-row check", "data-search": `${label} ${desc}`.toLowerCase() }, h("div", { class: "set-text" }, h("div", { class: "set-label" }, label), h("div", { class: "set-desc" }, desc)), h("div", { class: "set-control" }, ask)),
        this.row("Master password", "", h("button", { type: "button", onclick: () => this.changePassword() }, "Change master password")),
      );
    }
    rows.push(
      this.choice("autoLockMinutes", "Lock the app", "When nobody has used Siakap for this long.", lockChoices, (v) => Number(v)),
      this.toggle("lockDisconnects", "Disconnect all sessions when Siakap locks", "Off: terminals keep running but stay hidden until you unlock."),
    );
    return rows;
  }

  private hosts(hosts: KnownHost[]): HTMLElement[] {
    if (!hosts.length) return [h("p", { class: "muted small set-block" }, "None yet. Servers appear here after you confirm their fingerprint the first time you connect.")];
    return [
      h("p", { class: "muted small set-block" }, "Servers whose identity you confirmed. Remove one only if its administrator told you its key changed; you'll confirm the new fingerprint on the next connection."),
      ...hosts.map((k) =>
        h(
          "div",
          { class: "set-row kh-row", "data-search": `${k.host} ${k.port} ${k.keyType} ${k.fingerprint}`.toLowerCase() },
          h("div", { class: "set-text" }, h("div", { class: "set-label" }, `${k.host}:${k.port}`), h("div", { class: "set-desc mono" }, `${k.keyType} ${k.fingerprint}`)),
          h(
            "div",
            { class: "set-control" },
            h(
              "button",
              {
                class: "icon",
                title: "Forget this host key",
                onclick: async () => {
                  if (!(await confirmDialog("Forget host key?", `Remove the stored key for ${k.host}:${k.port}? You will be asked to verify the fingerprint again on the next connection.`, "Forget", { danger: true }))) return;
                  await api.knownHostRemove(k.host, k.port).catch((e) => toast(messageOf(e), "error"));
                  await this.render(true);
                },
              },
              icon("trash", 15),
            ),
          ),
        ),
      ),
    ];
  }

  private shortcuts(): HTMLElement[] {
    return SHORTCUTS.map(([k, what]) => h("div", { class: "set-row compact", "data-search": `${k} ${what}`.toLowerCase() }, h("div", { class: "set-text" }, h("div", { class: "set-label" }, what)), h("div", { class: "set-control" }, h("kbd", {}, k))));
  }

  private about(): HTMLElement[] {
    return [
      this.row("Version", "", h("span", { class: "mono" }, APP_VERSION)),
      this.row(
        "Guided tour",
        "",
        h("div", { class: "inline" }, h("button", { type: "button", onclick: () => this.onTour("whatsNew") }, "What's new"), h("button", { type: "button", onclick: () => this.onTour("full") }, "Show the tour again")),
      ),
      h("p", { class: "muted small set-block" }, "Siakap only connects to the servers and devices you open. It sends no usage data and checks for nothing online."),
    ];
  }

  // ------------------------------------------------------------ themes

  private async importThemes() {
    try {
      const [path] = await api.pickFiles("theme", false);
      if (!path) return;
      const found = parseThemes(await api.themeReadFile(path));
      const taken = [...BUILTIN_THEMES, ...this.s.customThemes].map((t) => t.name);
      const added = found.map((t) => {
        const name = uniqueName(t.name, taken);
        taken.push(name);
        return { ...t, name };
      });
      const custom = [...this.s.customThemes, ...added].slice(0, 100);
      this.set(added.length === 1 ? { ...withTheme(this.s, added[0]), customThemes: custom } : { customThemes: custom }, true);
      toast(added.length === 1 ? `Imported and applied "${added[0].name}".` : `Imported ${added.length} themes. Click one to use it.`, "ok");
    } catch (e) {
      toast(messageOf(e), "error");
    }
  }

  private async exportTheme(t: TerminalTheme) {
    try {
      const name = t.name.replace(/[^\w .@-]+/g, "-").trim() || "theme";
      const path = await api.pickSave("theme", `${name}.json`);
      if (!path) return;
      await api.saveTextFile(path, exportTheme(t));
      toast(`Exported "${t.name}" to ${path}`, "ok");
    } catch (e) {
      toast(messageOf(e), "error");
    }
  }

  private async saveAsTheme() {
    const taken = [...BUILTIN_THEMES, ...this.s.customThemes].map((t) => t.name.toLowerCase());
    const name = await promptDialog("Save theme", "Theme name", {
      value: uniqueName(this.s.themeName.replace(/ \(edited\)$/, "") || "My theme", taken),
      okLabel: "Save",
      validate: (v) => (!v.trim() ? "Enter a name." : taken.includes(v.trim().toLowerCase()) ? "A theme with this name already exists." : null),
    });
    if (!name) return;
    const theme = { ...currentTheme(this.s), name: name.trim().slice(0, 60) };
    this.set({ customThemes: [...this.s.customThemes, theme], themeName: theme.name }, true);
    toast(`Saved "${theme.name}". Right-click it to export it.`, "ok");
  }

  private async renameTheme(t: TerminalTheme) {
    const taken = [...BUILTIN_THEMES, ...this.s.customThemes].filter((x) => x.name !== t.name).map((x) => x.name.toLowerCase());
    const name = await promptDialog("Rename theme", "Theme name", {
      value: t.name,
      okLabel: "Rename",
      validate: (v) => (!v.trim() ? "Enter a name." : taken.includes(v.trim().toLowerCase()) ? "A theme with this name already exists." : null),
    });
    if (!name) return;
    const n = name.trim().slice(0, 60);
    this.set({ customThemes: this.s.customThemes.map((x) => (x.name === t.name ? { ...x, name: n } : x)), themeName: this.s.themeName === t.name ? n : this.s.themeName }, true);
  }

  private async deleteTheme(t: TerminalTheme) {
    if (!(await confirmDialog("Delete theme?", `Delete "${t.name}"? Terminals keep their current colours until you pick another theme.`, "Delete", { danger: true }))) return;
    this.set({ customThemes: this.s.customThemes.filter((x) => x.name !== t.name) }, true);
  }

  // ------------------------------------------------------------ passwords

  private async setMasterPassword() {
    const n1 = h("input", { type: "password", autocomplete: "off" });
    const n2 = h("input", { type: "password", autocomplete: "off" });
    const err = h("div", { class: "error" });
    const done = await modal<boolean>(
      "Set a master password",
      (close) => {
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
            h("p", { class: "muted small" }, "Siakap will ask for it when it opens and when it is locked. You can still turn off asking when it opens, in Settings."),
            field("Master password", n1),
            field("Repeat master password", n2),
            err,
          ),
          actions: [h("button", { onclick: () => close(false) }, "Cancel"), h("button", { class: "primary", onclick: () => void go() }, "Set password")],
          focus: n1,
        };
      },
      { dismissValue: false },
    );
    if (done) {
      toast("Master password set. Siakap will ask for it when it opens.", "ok");
      this.onPasswordModeChanged?.();
      await this.render(true);
    }
  }

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
