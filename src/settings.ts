// Settings, shown as its own tab: a section list on the left (with search) and
// compact rows on the right. Every change is saved straight away.
import { icon } from "./icons";
import { api, Channel, messageOf, type AnimStyle, type UiStyle, type KnownHost, type RedactedSession, type Settings, type ShellInfo, type TerminalTheme } from "./api";
import { BUILTIN_THEMES, DEFAULT_PALETTE, currentTheme, exportTheme, parseThemes, uniqueName, withTheme } from "./themes";
import { confirmDialog, field, h, modal, promptDialog, select, showMenu, toast } from "./ui";
import { play } from "./sound";
import { openReport } from "./report";
import { openThemeEditor } from "./themeeditor";
import { searchEgg, versionClicked } from "./eggs";
import { accentOf, setGlass } from "./skin";
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
  /** Settings before each change (newest last), for Undo. */
  private history: Settings[] = [];
  /** Settings as they were when this Settings tab was opened, for Revert all. */
  private opened: Settings | null = null;
  private undoBtn = h("button", { type: "button", class: "small-btn", title: "Undo the last change (Ctrl+Z)" }, icon("undo", 14), " Undo") as HTMLButtonElement;
  private revertBtn = h("button", { type: "button", class: "small-btn", title: "Put back every setting as it was when you opened Settings" }, icon("refresh", 14), " Revert all") as HTMLButtonElement;
  /** Set by main.ts: show the screensaver now. */
  onPreviewScreensaver?: () => void;

  constructor(
    private onSaved: (s: Settings) => void,
    private onTour: (kind: "full" | "whatsNew") => void = () => {},
  ) {
    // Ctrl+Z undoes the last settings change (not while typing in a box).
    this.el.addEventListener("keydown", (e) => {
      if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "z" && !(e.target as HTMLElement).matches("input:not([type=checkbox]):not([type=range]), textarea")) {
        e.preventDefault();
        this.undo();
      }
    });
  }

  /** Set by main.ts: the vault's password mode changed. */
  onPasswordModeChanged?: () => void;
  /** Set by main.ts: show a section (used by the tour). */
  show(section: string) {
    this.scrollTo = section;
    void this.render();
  }

  // ------------------------------------------------------------ saving

  /** Merge a change into the settings and save it shortly after. */
  private set(patch: Partial<Settings>, rerender = false, undoable = true) {
    if (undoable) {
      this.history.push(this.s);
      if (this.history.length > 100) this.history.shift();
    }
    this.s = { ...this.s, ...patch };
    this.syncUndo();
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

  private syncUndo() {
    this.undoBtn.disabled = !this.history.length;
    this.revertBtn.disabled = !this.opened || JSON.stringify(this.opened) === JSON.stringify(this.s);
  }

  /** Put back the settings from before the last change. */
  undo() {
    const prev = this.history.pop();
    if (!prev) return;
    this.set(prev, true, false);
    toast("Undid the last change.", "info", 1800);
  }

  /** Put back every setting as it was when Settings was opened. */
  revertAll() {
    if (!this.opened) return;
    this.history.push(this.s);
    this.set(this.opened, true, false);
    toast("Settings are back to how they were when you opened this tab.", "info", 2500);
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

  private sub(title: string) {
    return h("div", { class: "set-subhead set-group", "data-search": title.toLowerCase() }, title);
  }

  private textSetting<K extends keyof Settings>(key: K, label: string, desc: string, placeholder = "") {
    const input = h("input", { value: String(this.s[key] ?? ""), spellcheck: "false", placeholder }) as HTMLInputElement;
    input.addEventListener("change", () => this.set({ [key]: input.value.trim() } as Partial<Settings>));
    return this.row(label, desc, input);
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
      if (!keepScroll) {
        // A fresh open of Settings: this is what "Revert all" goes back to.
        this.opened = this.s;
        this.history = [];
      }
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
      { id: "startup", title: "Startup, tabs and window", icon: "play", build: () => this.startup(shells, sessions) },
      { id: "connections", title: "Connections", icon: "remote", build: () => this.connections() },
      { id: "mouse", title: "Mouse and clipboard", icon: "paste", build: () => this.mouse() },
      { id: "sound", title: "Sound and effects", icon: "sound", build: () => this.sound() },
      { id: "macros", title: "Macros", icon: "macros", build: () => this.macros() },
      { id: "logs", title: "Files and session logs", icon: "file", build: () => this.logs() },
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
      empty.textContent = searchEgg(q, accentOf(this.s)) ? "No setting by that name, but here's one swimming past." : "No setting matches your search.";
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
      h(
        "aside",
        { class: "settings-side" },
        h("h1", {}, "Settings"),
        h("div", { class: "settings-version muted small" }, `Siakap Terminal ${APP_VERSION}`),
        search,
        nav,
        h("div", { class: "undo-bar" }, this.undoBtn, this.revertBtn),
        this.status,
      ),
      body,
    );
    if (this.query) filter();
    this.undoBtn.onclick = () => this.undo();
    this.revertBtn.onclick = () => this.revertAll();
    this.syncUndo();
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
            { label: isCustom(t) ? "Edit..." : "Edit a copy...", action: () => void this.editTheme(t) },
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

    const pal = s.palette.length === 16 ? s.palette : DEFAULT_PALETTE;
    const editor = this.row(
      "Theme editor",
      "Change any colour with a live preview of the whole app. Save uses the colours; Save as... keeps them as a new theme to reuse.",
      h(
        "div",
        { class: "inline" },
        h("button", { type: "button", class: "primary", onclick: () => void this.editTheme(currentTheme(this.s)) }, icon("palette", 14), " Edit colours..."),
        h("button", { type: "button", onclick: () => void this.saveAsTheme() }, "Save current as..."),
      ),
    );
    editor.dataset.search = (editor.dataset.search ?? "") + " customise colours editor background text cursor selection accent ansi";

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
      ...this.styleAndMotion(),
      this.sub("Interface"),
      this.toggle("appSkin", "Colour the whole app with the theme", "Panels, tabs, menus and dialogs take the theme's colours too. A light theme gives a light app."),
      this.toggle("themeIcon", "Match the app icon to the theme", "The icon in the taskbar and title uses the theme's colours while Siakap runs."),
      this.choice("uiScale", "Interface size", "Makes menus, panels and tabs bigger or smaller. Terminal text has its own size under Terminal.", [["90", "Small (90%)"], ["100", "Normal"], ["110", "Large (110%)"], ["125", "Larger (125%)"], ["150", "Largest (150%)"]], (v) => Number(v)),
      this.toggle("railLabels", "Show labels under the left-hand buttons"),
      this.choice("tabWidth", "Tab width", "", [["compact", "Compact"], ["normal", "Normal"], ["wide", "Wide"]], (v) => v as Settings["tabWidth"]),
      this.toggle("tabCloseOnHover", "Show a tab's close button only when pointing at it"),
    ];
  }

  private styleAndMotion(): HTMLElement[] {
    const s = this.s;
    const looks: [UiStyle, string, string][] = [
      ["standard", "Standard", "Siakap's own look"],
      ["glass", "Glass", "Floating glass and grouped lists (iOS-like)"],
      ["material", "Material", "Calm surfaces, outlined buttons, ripples"],
      ["fluent", "Fluent", "Clean and layered, like Windows 11"],
      ["dot", "Dot matrix", "Black, white and red with dotted type (Nothing OS-like)"],
      ["retro", "Retro", "Square, glowing, with CRT scan lines"],
      ["minimal", "Minimal", "No borders or boxes, just content"],
    ];
    const lookGallery = h(
      "div",
      { class: "look-gallery" },
      ...looks.map(([id, name, sub]) =>
        h(
          "button",
          { type: "button", class: `look-card${(s.uiStyle ?? "standard") === id ? " active" : ""}`, "data-look-id": id, title: sub, onclick: () => this.set({ uiStyle: id }, true) },
          h(
            "div",
            { class: "lc", "data-look": id },
            h("div", { class: "lc-rail" }),
            h("div", { class: "lc-body" }, h("div", { class: "lc-card" }, h("div", { class: "lc-line" }), h("div", { class: "lc-sw" })), h("div", { class: "lc-btns" }, h("div", { class: "lc-btn" }), h("div", { class: "lc-btn p" }))),
          ),
          h("span", { class: "look-name" }, name),
          h("span", { class: "look-sub" }, sub),
        ),
      ),
    );
    const anims: [AnimStyle, string, string][] = [
      ["fluid", "Fluid", "Smooth and quick"],
      ["bouncy", "Bouncy", "Playful overshoot"],
      ["slide", "Slide", "Things glide in"],
      ["subtle", "Subtle", "Gentle fades only"],
      ["off", "Off", "No animation"],
    ];
    const animGallery = h(
      "div",
      { class: "anim-gallery" },
      ...anims.map(([id, name, sub]) =>
        h(
          "button",
          { type: "button", class: `anim-card${(s.animations ?? "fluid") === id ? " active" : ""}`, "data-anim-id": id, title: sub, onclick: () => this.set({ animations: id }, true) },
          h("div", { class: "ac", "data-a": id }, h("i")),
          h("span", { class: "look-name" }, name),
          h("span", { class: "look-sub" }, sub),
        ),
      ),
    );
    const demo = h("button", { type: "button", onclick: () => toast("This is how messages move now.", "ok", 2500) }, "Try it");
    // Glass controls: they change the app live while dragging and save on release.
    const slider = (key: "glassTransparency" | "glassBlur", max: number, unit: string) => {
      const input = h("input", { type: "range", min: 0, max, step: 1, value: String(this.s[key] ?? (key === "glassBlur" ? 30 : 42)), "data-glass": key }) as HTMLInputElement;
      const out = h("span", { class: "muted small vol-pct" }, `${input.value}${unit}`);
      const live = () => {
        out.textContent = `${input.value}${unit}`;
        const t = key === "glassTransparency" ? Number(input.value) : (this.s.glassTransparency ?? 42);
        const b = key === "glassBlur" ? Number(input.value) : (this.s.glassBlur ?? 30);
        setGlass(t, b);
      };
      input.addEventListener("input", live);
      input.addEventListener("change", () => this.set({ [key]: Number(input.value) } as Partial<Settings>));
      return h("div", { class: "inline vol" }, input, out);
    };
    const glass = (s.uiStyle ?? "standard") === "glass";
    return [
      this.sub("Style"),
      h("div", { class: "set-block", "data-search": "style look ui glass apple material fluent windows dot matrix nothing retro minimal" }, lookGallery),
      ...(glass
        ? [
            this.row("Glass transparency", "How much of the backdrop shows through the panels, tabs, menus and dialogs. 0% is solid.", slider("glassTransparency", 90, "%")),
            this.row("Glass blur", "How soft the backdrop looks through the glass. 0 is clear glass.", slider("glassBlur", 60, " px")),
          ]
        : []),
      h("p", { class: "muted small set-block" }, "Styles change shapes, depth and type. Your theme's colours still apply (Dot matrix uses red for its accent). All styles are part of Siakap; nothing is downloaded."),
      this.sub("Animations"),
      h("div", { class: "set-block", "data-search": "animation motion fluid bouncy slide subtle off" }, animGallery),
      this.row("See it move", "Shows a message, so you can see the animation you picked. When Windows is set to reduce animations, Siakap keeps fades and drops movement.", demo),
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
      this.choice("fontWeight", "Text weight", "", [["300", "Light"], ["normal", "Normal"], ["500", "Medium"], ["bold", "Bold"]], (v) => v as Settings["fontWeight"]),
      this.choice("lineHeight", "Line spacing", "", [["100", "Normal"], ["110", "Relaxed (110%)"], ["120", "Loose (120%)"], ["135", "Extra loose (135%)"]], (v) => Number(v), true),
      this.choice("letterSpacing", "Letter spacing", "", [["0", "Normal"], ["1", "+1 px"], ["2", "+2 px"], ["3", "+3 px"]], (v) => Number(v)),
      this.toggle("boldIsBright", "Show bold text in bright colours", "How many older programs highlight text."),
      this.choice("termPadding", "Space around the text", "", [["0", "None"], ["4", "Small"], ["6", "Normal"], ["10", "Large"], ["16", "Extra large"]], (v) => Number(v)),
      this.choice("cursorStyle", "Cursor shape", "", [["block", "Block"], ["bar", "Bar"], ["underline", "Underline"]], (v) => v as Settings["cursorStyle"]),
      this.toggle("cursorBlink", "Blinking cursor"),
      this.choice("cursorInactive", "Cursor in terminals you're not typing in", "", [["outline", "Outline"], ["block", "Block"], ["bar", "Bar"], ["underline", "Underline"], ["none", "Hidden"]], (v) => v as Settings["cursorInactive"]),
      this.choice("scrollSpeed", "Mouse wheel speed", "", [["1", "Normal"], ["2", "Fast (2×)"], ["3", "Faster (3×)"], ["5", "Fastest (5×)"]], (v) => Number(v)),
      this.toggle("scrollOnInput", "Jump to the bottom when you type"),
      this.choice("tabStopWidth", "Tab stop width", "How far the Tab character moves the cursor.", [["2", "2 columns"], ["4", "4 columns"], ["8", "8 columns (standard)"]], (v) => Number(v)),
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
      this.sub("Tabs"),
      this.choice("newTabPosition", "Open new tabs", "", [["end", "At the end"], ["next", "Next to the current tab"]], (v) => v as Settings["newTabPosition"]),
      this.toggle("programTitles", "Show the title a program sets on its tab", "For example the current folder or host, when your shell or server sets one. Renamed tabs keep your name."),
      this.toggle("middleClickClose", "Close a tab with a middle click"),
      this.toggle("confirmCloseTab", "Ask before closing a tab with several sessions"),
      this.toggle("notifyBackground", "Tell me when a command finishes in another tab", "Needs command status on tabs (below)."),
      this.toggle("tabStatus", "Command status on tabs", "Blue while a command runs, then green for success or red for failure."),
      this.toggle("tabStatusFallback", "Guess status from prompts and errors", "For devices and shells that don't report command results. Results are estimates."),
      this.sub("Window"),
      this.toggle("startMaximized", "Start maximised"),
      this.toggle("confirmQuit", "Ask before closing the window while sessions are open"),
    ];
    return rows.filter((x): x is HTMLElement => !!x);
  }

  private connections(): HTMLElement[] {
    return [
      this.choice("sshKeepaliveSecs", "Keep SSH connections alive", "Sends a small message now and then so firewalls don't drop idle sessions. Applies to new connections.", [["0", "Off"], ["15", "Every 15 seconds"], ["30", "Every 30 seconds"], ["60", "Every minute"], ["120", "Every 2 minutes"]], (v) => Number(v)),
      this.choice("sshConnectTimeoutSecs", "Give up connecting after", "", [["10", "10 seconds"], ["20", "20 seconds"], ["30", "30 seconds"], ["60", "1 minute"]], (v) => Number(v)),
      this.toggle("autoReconnect", "Reconnect automatically if a connection drops", "Tries up to 3 times, 3 seconds apart. Typing exit doesn't count as a drop."),
      this.sub("New SSH sessions"),
      this.textSetting("defaultSshUser", "Default username", "Filled in when you add a server.", "e.g. admin"),
      this.number("defaultSshPort", "Default port", "", 1, 65535, 1),
    ];
  }

  private sound(): HTMLElement[] {
    const vol = h("input", { type: "range", min: 0, max: 100, step: 5, value: String(this.s.soundVolume ?? 40) }) as HTMLInputElement;
    const pct = h("span", { class: "muted small vol-pct" }, `${vol.value}%`);
    vol.addEventListener("input", () => (pct.textContent = `${vol.value}%`));
    vol.addEventListener("change", () => {
      this.set({ soundVolume: Number(vol.value) });
      play("chime");
    });
    const test = (label: string, name: Parameters<typeof play>[0]) => h("button", { type: "button", onclick: () => play(name) }, label);
    return [
      this.toggle("soundChime", "Chime when a tab finishes its work", "Plays when a command finishes (a different sound if it failed). Needs command status on tabs."),
      this.choice("chimeMinSecs", "Only for commands that took at least", "So quick commands like ls stay quiet.", [["0", "Every command"], ["3", "3 seconds"], ["5", "5 seconds"], ["10", "10 seconds"], ["30", "30 seconds"], ["60", "1 minute"]], (v) => Number(v)),
      this.toggle("soundUi", "Interface sounds", "Soft clicks for buttons and tabs, a tap on Enter, and sounds for opening and closing tabs and for errors."),
      this.row("Volume", "", h("div", { class: "inline vol" }, vol, pct)),
      this.row("Try the sounds", "", h("div", { class: "inline" }, test("Chime", "chime"), test("Failed", "fail"), test("Click", "click"), test("Enter", "enter"))),
      this.sub("Screensaver"),
      this.choice("screensaverMinutes", "Show the swimming siakap after", "Pixel-art siakap swim across the screen when you're away. Move the mouse or press a key to come back; that key isn't typed anywhere.", [["0", "Never"], ["2", "2 minutes"], ["5", "5 minutes"], ["10", "10 minutes"], ["15", "15 minutes"], ["30", "30 minutes"]], (v) => Number(v)),
      this.row("Preview", "", h("button", { type: "button", onclick: () => this.onPreviewScreensaver?.() }, "Show it now")),
      this.sub("Welcome splash"),
      this.toggle("splash", "Show a welcome splash when Siakap starts", "The logo, a greeting and the version, for about two seconds. Click or press a key to skip it."),
    ];
  }

  private mouse(): HTMLElement[] {
    return [
      this.toggle("rightClickPaste", "Right-click pastes", "With text selected, right-click copies it instead. Shift+right-click shows the menu."),
      this.toggle("copyOnSelect", "Copy as soon as text is selected"),
      this.toggle("confirmMultilinePaste", "Ask before pasting more than one line", "Each line break can run a command, so Siakap shows the text first."),
      this.toggle("trimPasteNewline", "Don't run a single pasted line by itself", "Removes the line break at the end of one copied line, so you can check it before pressing Enter."),
      this.toggle("trimCopyWhitespace", "Remove spaces at the ends of copied lines"),
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
      this.sub("SFTP"),
      this.toggle("sftpShowHidden", "Show hidden files (names starting with a dot)"),
      this.sub("Session logs"),
      auto,
      this.toggle("logTimestamps", "Start each logged line with the time", "Applies to logs started from now on."),
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
      this.toggle("lockOnMinimize", "Lock when the window is minimised"),
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
    const result = h("div", { class: "update-result hidden" });
    const btn = h("button", { type: "button" }, icon("refresh", 14), " Check for updates") as HTMLButtonElement;
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.lastChild!.textContent = " Checking...";
      result.classList.add("hidden");
      try {
        const u = await api.updateCheck();
        const open = h("button", { type: "button", onclick: () => api.openReleasePage(u.url).catch((e) => toast(messageOf(e), "error")) }, "Open download page");
        const install = h("button", { type: "button", class: "primary" }, icon("download", 14), " Download and install") as HTMLButtonElement;
        const bar = h("div", { class: "update-progress hidden" }, h("div", { class: "update-bar" }), h("span", { class: "muted small update-status" }));
        install.addEventListener("click", () => void this.downloadAndInstall(install, bar));
        const copy = h("button", { type: "button", onclick: () => api.clipboardWrite(u.url).then(() => toast("Link copied.", "ok", 1500)) }, "Copy link");
        result.replaceChildren(
          u.newer
            ? h("div", { class: "update-new" }, h("strong", {}, `Version ${u.latest} is available`), u.published ? h("span", { class: "muted small" }, ` (released ${u.published})`) : null, h("div", { class: "muted small" }, `You have ${u.current}. Download and install updates Siakap and opens it again; your sessions and settings are kept.`))
            : h("div", { class: "update-ok" }, h("strong", {}, "You have the latest version"), h("span", { class: "muted small" }, ` (${u.current})`)),
          ...(u.newer && u.notes.trim() ? [h("details", {}, h("summary", { class: "small" }, "What's in it"), h("pre", { class: "update-notes" }, u.notes))] : []),
          h("div", { class: "inline" }, ...(u.newer ? (u.installerUrl ? [install, open, copy] : [open, copy]) : [])),
          ...(u.newer ? [bar] : []),
        );
        result.classList.remove("hidden");
      } catch (e) {
        result.replaceChildren(h("div", { class: "error" }, messageOf(e)));
        result.classList.remove("hidden");
      } finally {
        btn.disabled = false;
        btn.lastChild!.textContent = " Check for updates";
      }
    });
    return [
      this.row("Version", "", h("span", { class: "mono", onclick: () => versionClicked(APP_VERSION) }, APP_VERSION)),
      this.row("Updates", "Asks GitHub for the newest release, only when you click. Siakap never checks on its own.", btn),
      h("div", { class: "set-block update-block", "data-search": "update check version download" }, result),
      this.row(
        "Report a problem",
        "Makes a report of what went wrong (versions, settings and recent errors) for you to save or copy and send to the developer. Nothing is sent by the app.",
        h("button", { type: "button", onclick: () => void openReport() }, icon("bug", 14), " Report a problem"),
      ),
      this.row(
        "Guided tour",
        "",
        h("div", { class: "inline" }, h("button", { type: "button", onclick: () => this.onTour("whatsNew") }, "What's new"), h("button", { type: "button", onclick: () => this.onTour("full") }, "Show the tour again")),
      ),
      h("p", { class: "muted small set-block" }, "Siakap only connects to the servers and devices you open, and to GitHub when you click Check for updates or Download and install. It sends no usage data and never checks for anything on its own."),
    ];
  }

  /** Set by main.ts: confirm closing sessions and close them; false = not now. */
  prepareInstall?: () => Promise<boolean>;

  private async downloadAndInstall(btn: HTMLButtonElement, bar: HTMLElement) {
    const fill = bar.querySelector(".update-bar") as HTMLElement;
    const status = bar.querySelector(".update-status") as HTMLElement;
    const mb = (n: number) => (n / 1048576).toFixed(1);
    btn.disabled = true;
    bar.classList.remove("hidden");
    status.textContent = "Starting the download...";
    try {
      const ch = new Channel<{ done: number; total: number }>();
      ch.onmessage = ({ done, total }) => {
        const pct = total ? Math.round((done / total) * 100) : 0;
        fill.style.width = `${pct}%`;
        status.textContent = total ? `Downloading... ${mb(done)} of ${mb(total)} MB (${pct}%)` : `Downloading... ${mb(done)} MB`;
      };
      await api.updateDownload(ch);
      fill.style.width = "100%";
      status.textContent = "Downloaded and checked against the release's checksum.";
      play("chime");
      // Count down, so there's a moment to cancel.
      let left = 3;
      const cancel = h("button", { type: "button", class: "small-btn" }, "Not now") as HTMLButtonElement;
      const later = new Promise<boolean>((res) => {
        cancel.onclick = () => res(false);
        const tick = () => {
          if (left <= 0) return res(true);
          status.replaceChildren(`Installing in ${left}... Siakap will close, update, and open again.  `, cancel);
          left--;
          window.setTimeout(tick, 1000);
        };
        tick();
      });
      if (!(await later)) {
        status.replaceChildren("Downloaded. ", h("button", { type: "button", class: "small-btn", onclick: () => void this.installNow(status) }, "Install now"));
        return;
      }
      await this.installNow(status);
    } catch (e) {
      status.textContent = messageOf(e);
      status.classList.add("error");
      btn.disabled = false;
    }
  }

  private async installNow(status: HTMLElement) {
    status.textContent = "Ready to install.";
    if (this.prepareInstall && !(await this.prepareInstall())) {
      status.replaceChildren("Downloaded. ", h("button", { type: "button", class: "small-btn", onclick: () => void this.installNow(status) }, "Install now"));
      return;
    }
    status.textContent = "Starting the installer...";
    try {
      await api.updateInstall();
    } catch (e) {
      status.textContent = messageOf(e);
      status.classList.add("error");
    }
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

  private async editTheme(start: TerminalTheme) {
    const mine = (n: string) => this.s.customThemes.some((x) => x.name === n);
    const all = [...BUILTIN_THEMES, ...this.s.customThemes];
    const r = await openThemeEditor({
      start,
      settings: this.s,
      themes: all,
      isMine: mine,
      taken: all.map((t) => t.name.toLowerCase()),
      suggest: (b) => uniqueName(b, all.map((t) => t.name)),
    });
    if (!r) return;
    if (r.mode === "saveAs") {
      this.set({ ...withTheme(this.s, r.theme), customThemes: [...this.s.customThemes, r.theme].slice(0, 100) }, true);
      toast(`Saved "${r.theme.name}" to your themes and switched to it.`, "ok");
    } else if (mine(r.theme.name)) {
      this.set({ ...withTheme(this.s, r.theme), customThemes: this.s.customThemes.map((x) => (x.name === r.theme.name ? r.theme : x)) }, true);
      toast(`Saved "${r.theme.name}".`, "ok");
    } else {
      this.set(withTheme(this.s, r.theme), true);
      toast("Saved. To keep these colours as a theme of their own, use Save as...", "ok");
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
