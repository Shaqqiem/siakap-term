// Theme editor: change colours with a live preview of the whole app (window,
// tabs, side panel, terminal and a dialog). Nothing changes in the real app
// until Save; Save as... keeps the colours as a new theme you can reuse.
import type { Settings, TerminalTheme } from "./api";
import { accentOf, appColours, skinVars, uiOverrides } from "./skin";
import { ANSI_NAMES, DEFAULT_PALETTE, hex6, isHex, withTheme, type UiKey } from "./themes";
import { h, modal, promptDialog } from "./ui";

export type EditorResult = { mode: "save" | "saveAs"; theme: TerminalTheme } | null;

export interface EditorOptions {
  /** The theme to start from. */
  start: TerminalTheme;
  /** Current settings (font, app skin) for the preview. */
  settings: Settings;
  /** Every theme, for "Start from". */
  themes: TerminalTheme[];
  /** Whether `name` is one of the user's own themes (Save then updates it). */
  isMine: (name: string) => boolean;
  /** Theme names already in use (lower case), for Save as. */
  taken: string[];
  /** Suggested name for Save as. */
  suggest: (base: string) => string;
}

type Key = "background" | "foreground" | "cursor" | "selection" | "accent";
interface Draft {
  background: string;
  foreground: string;
  cursor: string;
  selection: string;
  accent: string; // "" = automatic
  palette: string[]; // always 16 here
  ui: Record<string, string>; // app colours set by hand; missing = automatic
}

const UI_FIELDS: [UiKey, string, string][] = [
  ["bg", "Window background", "--bg"],
  ["panel", "Panels and bars", "--bg2"],
  ["surface", "Cards and fields", "--bg3"],
  ["hover", "Hover", "--hover"],
  ["line", "Lines and borders", "--line"],
  ["text", "App text", "--fg"],
  ["muted", "Quiet text", "--muted"],
  ["accentText", "Text on accent", "--accent-fg"],
  ["ok", "Success", "--ok"],
  ["warn", "Warning", "--warn"],
  ["err", "Error", "--err"],
];

const draftOf = (t: TerminalTheme): Draft => ({
  background: hex6(t.background),
  foreground: hex6(t.foreground),
  cursor: hex6(t.cursor || t.foreground),
  selection: hex6(t.selection || "#264f78"),
  accent: t.accent && isHex(t.accent) ? hex6(t.accent) : "",
  palette: (t.palette.length === 16 ? t.palette : DEFAULT_PALETTE).map(hex6),
  ui: { ...(t.ui ?? {}) },
});

const themeOf = (d: Draft, name: string): TerminalTheme => ({
  name,
  background: d.background,
  foreground: d.foreground,
  cursor: d.cursor,
  selection: d.selection,
  // The built-in terminal colours are stored as "none" so they keep following Siakap's defaults.
  palette: d.palette.every((c, i) => c.toLowerCase() === hex6(DEFAULT_PALETTE[i]).toLowerCase()) ? [] : [...d.palette],
  accent: d.accent,
  ui: { ...d.ui },
});

export function openThemeEditor(o: EditorOptions): Promise<EditorResult> {
  const base = o.start.name.replace(/ \(edited\)$/, "");
  const mine = o.isMine(o.start.name);
  let d = draftOf(o.start);
  const original = JSON.stringify(d);
  const fields = new Map<string, { set: (v: string) => void; el: HTMLElement }>();

  return modal<EditorResult>(
    "Theme editor",
    (close) => {
      // ---------------------------------------------------------- preview
      const P = (cls: string, ...kids: (Node | string | null)[]) => h("div", { class: cls }, ...kids);
      const pick = (key: string, el: HTMLElement) => {
        el.dataset.edit = key;
        return el;
      };
      const span = (i: number, text: string) => pick(`p${i}`, h("span", { class: "tp-c", "data-c": String(i) }, text));
      const term = pick(
        "background",
        P(
          "tp-term",
          h("div", {}, span(2, "you@workstation"), pick("foreground", h("span", {}, ":")), span(4, "~/projects"), pick("foreground", h("span", {}, "$ ls -l"))),
          h("div", {}, span(4, "docs/  "), span(2, "deploy.sh  "), span(6, "link@  "), span(3, "notes.txt  "), span(5, "photo.png  "), span(1, "core.dump")),
          h("div", {}, span(8, "# bright black is used for comments and hints")),
          h("div", {}, pick("foreground", h("span", {}, "$ git status")), " ", span(10, "✔ 3 files staged  "), span(9, "✖ 1 conflict")),
          h("div", {}, span(11, "warning: "), pick("foreground", h("span", {}, "disk 91% full  ")), span(12, "info: "), span(13, "debug "), span(14, "trace "), span(15, "bright white")),
          h("div", { class: "tp-strip" }, ...Array.from({ length: 16 }, (_, i) => pick(`p${i}`, h("i", { "data-c": String(i), title: ANSI_NAMES[i] })))),
          h(
            "div",
            {},
            span(2, "you@workstation"),
            pick("foreground", h("span", {}, ":")),
            span(4, "~"),
            pick("foreground", h("span", {}, "$ ")),
            pick("selection", h("span", { class: "tp-sel" }, "selected text")),
            pick("foreground", h("span", {}, " ")),
            pick("cursor", h("span", { class: "tp-cursor" }, " ")),
          ),
        ),
      );
      const win = P(
        "tp-window",
        P(
          "tp-titlebar",
          P("tp-logo"),
          pick("accent", P("tp-tab active", h("span", { class: "tp-dot ok" }), "PowerShell")),
          P("tp-tab", h("span", { class: "tp-dot ok" }), "web-01"),
          P("tp-tab", h("span", { class: "tp-dot err" }), "db (closed)"),
          P("tp-plus", "+"),
          P("tp-ctrls", "–  ☐  ✕"),
        ),
        P(
          "tp-body",
          P("tp-rail", pick("accent", P("tp-railbtn active")), P("tp-railbtn"), P("tp-railbtn"), P("tp-railbtn"), P("tp-railbtn")),
          P(
            "tp-panel",
            P("tp-panelhead", "Sessions"),
            P("tp-search", "Search sessions"),
            P("tp-folder", "▾ Servers"),
            P("tp-item", h("span", { class: "tp-dot ok" }), "web-01"),
            P("tp-item hover", h("span", { class: "tp-dot" }), "db"),
            P("tp-item", h("span", { class: "tp-dot" }), "router"),
            P("tp-folder", "▸ Lab"),
            P("tp-hint", "Right-click for more"),
          ),
          P(
            "tp-main",
            term,
            P(
              "tp-dialog",
              P("tp-dialog-title", "Trust this server?"),
              P("tp-dialog-text", "SHA256:8xV2…aQ  ed25519"),
              P("tp-dialog-btns", P("tp-btn", "Cancel"), pick("accent", P("tp-btn primary", "Trust and connect"))),
            ),
          ),
        ),
        P("tp-toasts", P("tp-toast ok", "Saved"), P("tp-toast err", "Connection refused")),
      );

      const paint = () => {
        const pal = d.palette;
        const s = withTheme(o.settings, themeOf(d, "preview"));
        win.style.cssText = "";
        const own = uiOverrides(s);
        const vars = o.settings.appSkin !== false ? appColours(s) : Object.keys(own).length ? own : null;
        if (vars) for (const [k, v] of Object.entries(vars)) win.style.setProperty(k, v);
        else win.style.setProperty("--accent", accentOf(s));
        win.style.setProperty("--tp-bg", d.background);
        win.style.setProperty("--tp-fg", d.foreground);
        win.style.setProperty("--tp-cursor", d.cursor);
        win.style.setProperty("--tp-sel", d.selection);
        term.style.fontFamily = o.settings.fontFamily;
        term.style.fontSize = `${Math.min(o.settings.fontSize, 14)}px`;
        for (const el of win.querySelectorAll<HTMLElement>("[data-c]")) {
          const c = pal[Number(el.dataset.c)];
          if (el.tagName === "I") el.style.background = c;
          else el.style.color = c;
        }
        const derived = skinVars({ ...s, uiColors: {} }) ?? {};
        for (const [k, f] of fields) {
          if (k.startsWith("ui:")) {
            const key = k.slice(3) as UiKey;
            const cssVar = UI_FIELDS.find((x) => x[0] === key)![2];
            f.set(d.ui[key] ?? derived[cssVar] ?? getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim() ?? "#000000");
            f.el.classList.toggle("is-auto", !d.ui[key]);
          } else f.set(k.startsWith("p") ? pal[Number(k.slice(1))] : k === "accent" ? d.accent || accentOf(s) : d[k as Key]);
        }
        autoAccent.checked = !d.accent;
        dirty.textContent = JSON.stringify(d) === original ? "" : "Not saved yet";
      };

      // ---------------------------------------------------------- fields
      const update = (key: string, v: string) => {
        if (!isHex(v)) return;
        v = hex6(v);
        if (key.startsWith("ui:")) d = { ...d, ui: { ...d.ui, [key.slice(3)]: v } };
        else if (key.startsWith("p")) {
          const pal = [...d.palette];
          pal[Number(key.slice(1))] = v;
          d = { ...d, palette: pal };
        } else d = { ...d, [key]: v };
        paint();
      };
      const colour = (key: string, label: string) => {
        const pickEl = h("input", { type: "color" }) as HTMLInputElement;
        const text = h("input", { type: "text", class: "mono", maxlength: "7", spellcheck: "false", "aria-label": `${label} (hex)` }) as HTMLInputElement;
        pickEl.addEventListener("input", () => update(key, pickEl.value)); // live while dragging
        text.addEventListener("input", () => {
          const v = text.value.trim();
          text.classList.toggle("bad", !isHex(v.startsWith("#") ? v : `#${v}`));
          update(key, v.startsWith("#") ? v : `#${v}`);
        });
        text.addEventListener("blur", () => paint());
        const el = h("label", { class: "te-field", "data-key": key }, pickEl, h("span", { class: "te-label" }, label), text);
        fields.set(key, {
          el,
          set: (v) => {
            pickEl.value = hex6(v);
            if (document.activeElement !== text) {
              text.value = hex6(v);
              text.classList.remove("bad");
            }
          },
        });
        return el;
      };
      const autoAccent = h("input", { type: "checkbox" }) as HTMLInputElement;
      autoAccent.addEventListener("change", () => {
        d = { ...d, accent: autoAccent.checked ? "" : hex6(accentOf(withTheme(o.settings, themeOf(d, "x")))) };
        paint();
      });
      const startFrom = h("select", { "aria-label": "Start from" }, h("option", { value: "" }, "Start from another theme..."), ...o.themes.map((t) => h("option", { value: t.name }, t.name))) as HTMLSelectElement;
      startFrom.addEventListener("change", () => {
        const t = o.themes.find((x) => x.name === startFrom.value);
        if (t) d = draftOf(t);
        startFrom.value = "";
        paint();
      });
      const dirty = h("span", { class: "muted small te-dirty" });
      const fieldsBox = h(
        "div",
        { class: "te-fields" },
        h("div", { class: "te-head" }, "Basics"),
        colour("background", "Background"),
        colour("foreground", "Text"),
        colour("cursor", "Cursor"),
        colour("selection", "Selection"),
        colour("accent", "App accent"),
        h("label", { class: "check small te-auto" }, autoAccent, " Pick the accent automatically"),
        h("div", { class: "te-head" }, "App colours"),
        h("p", { class: "muted small te-note" }, "Auto colours are worked out from the terminal colours. Change one to set it yourself; Auto puts it back."),
        ...UI_FIELDS.map(([key, label]) => {
          const el = colour(`ui:${key}`, label);
          const auto = h("button", { type: "button", class: "te-autobtn", title: "Work this colour out automatically again" }, "Auto");
          auto.addEventListener("click", (e) => {
            e.preventDefault();
            const ui = { ...d.ui };
            delete ui[key];
            d = { ...d, ui };
            paint();
          });
          el.append(auto);
          return el;
        }),
        h("div", { class: "te-head" }, "Terminal colours"),
        h("div", { class: "te-ansi" }, ...ANSI_NAMES.slice(0, 8).map((n, i) => colour(`p${i}`, n))),
        h("div", { class: "te-head" }, "Bright terminal colours"),
        h("div", { class: "te-ansi" }, ...ANSI_NAMES.slice(8).map((n, i) => colour(`p${i + 8}`, n))),
      );

      // App parts of the preview point at their app colour.
      const tag = (sel: string, key: string) => win.querySelectorAll<HTMLElement>(sel).forEach((el) => (el.dataset.edit ??= key));
      tag(".tp-item.hover", "ui:hover");
      tag(".tp-search, .tp-dialog, .tp-btn:not(.primary)", "ui:surface");
      tag(".tp-toast.ok", "ui:ok");
      tag(".tp-toast.err", "ui:err");
      tag(".tp-hint, .tp-folder, .tp-ctrls, .tp-plus", "ui:muted");
      tag(".tp-panelhead, .tp-item", "ui:text");
      tag(".tp-titlebar, .tp-rail, .tp-panel", "ui:panel");
      tag(".tp-body, .tp-window", "ui:bg");

      // Click a part of the preview to jump to its colour.
      win.addEventListener("click", (e) => {
        const key = (e.target as HTMLElement).closest<HTMLElement>("[data-edit]")?.dataset.edit;
        const f = key && fields.get(key);
        if (!f) return;
        f.el.scrollIntoView({ block: "nearest" });
        f.el.classList.remove("flash");
        void f.el.offsetWidth;
        f.el.classList.add("flash");
        (f.el.querySelector("input[type=text]") as HTMLInputElement).focus();
      });

      const reset = h("button", { type: "button", onclick: () => ((d = JSON.parse(original)), paint()) }, "Reset");
      const saveAs = h("button", { type: "button" }, "Save as...");
      saveAs.addEventListener("click", async () => {
        const name = await promptDialog("Save as a new theme", "Theme name", {
          value: o.suggest(base || "My theme"),
          okLabel: "Save",
          hint: "It's added to your themes, so you can use it again or start other themes from it.",
          validate: (v) => (!v.trim() ? "Enter a name." : o.taken.includes(v.trim().toLowerCase()) ? "A theme with this name already exists." : null),
        });
        if (name) close({ mode: "saveAs", theme: themeOf(d, name.trim().slice(0, 60)) });
      });
      const save = h("button", { type: "button", class: "primary" }, "Save");
      save.title = mine ? `Updates your theme "${o.start.name}" and uses it` : `Uses these colours now. "${base}" itself stays as it is; use Save as... to keep them as a theme`;
      save.addEventListener("click", () => close({ mode: "save", theme: themeOf(d, mine ? o.start.name : `${base} (edited)`) }));

      paint();
      return {
        body: h(
          "div",
          { class: "te" },
          h(
            "div",
            { class: "te-top" },
            h("span", { class: "muted small" }, mine ? `Editing your theme "${o.start.name}".` : `Editing a copy of "${base}".`, " Click any part of the preview to change its colour."),
            startFrom,
          ),
          h("div", { class: "te-grid" }, fieldsBox, h("div", { class: "te-preview" }, h("div", { class: "te-head" }, "Live preview"), win)),
        ),
        actions: [dirty, reset, h("button", { type: "button", onclick: () => close(null) }, "Cancel"), saveAs, save],
        focus: save as HTMLElement,
      };
    },
    { wide: true, className: "theme-editor-modal", dismissValue: null },
  );
}
