// Developer preview panel: buttons that show every screen, dialog, animation
// and message the app has, with made-up sample data. Nothing here connects,
// changes sessions or reads secrets; style buttons change settings like the
// Appearance page does.
import { api, messageOf, type AnimStyle, type Settings, type UiStyle } from "./api";
import { diagEvents } from "./diag";
import { showCredits } from "./eggs";
import { icon } from "./icons";
import { loader, type LoaderStyle } from "./loader";
import { swimBy } from "./screensaver";
import { play, type SoundName } from "./sound";
import { showSplash } from "./splash";
import { alertDialog, confirmDialog, h, promptDialog, toast } from "./ui";
import { resolveApp, resolveTerm } from "./wallpaper";

export interface AdminContext {
  version: string;
  accent: () => string;
  settings: () => Promise<Settings>;
  saveSettings: (patch: Partial<Settings>) => Promise<void>;
  openSettings: (section?: string) => void;
  tour: (kind: "full" | "whatsNew") => void;
  screensaver: () => void;
  morphLogo: () => void;
  report: () => void;
  trust: (host: string, port: number, keyType: string, fp: string) => Promise<boolean>;
  keyChanged: (message: string, known: string, fp: string, keyType: string) => Promise<void>;
  lock: () => void;
  leave: () => void;
}

const STYLES: [UiStyle, string][] = [
  ["standard", "Standard"],
  ["glass", "Glass"],
  ["material", "Material"],
  ["fluent", "Fluent"],
  ["dot", "Dot matrix"],
  ["retro", "Retro"],
  ["minimal", "Minimal"],
];
const ANIMS: AnimStyle[] = ["fluid", "bouncy", "slide", "subtle", "off"];
const SOUNDS: SoundName[] = ["click", "enter", "open", "close", "chime", "fail", "error", "toggle", "splash"];
const DAYS: [string, Date][] = [
  ["Normal day", new Date(2026, 5, 10)],
  ["Merdeka (31 Aug)", new Date(2026, 7, 31)],
  ["Hari Malaysia (16 Sep)", new Date(2026, 8, 16)],
  ["New Year", new Date(2027, 0, 1)],
  ["App birthday (23 Nov)", new Date(2026, 10, 23)],
  ["April Fools", new Date(2027, 3, 1)],
  ["Friday the 13th", new Date(2026, 10, 13)],
];
const FP = "SHA256:q6Hn3cU1v0xJ2lB9fKpR8tYwE4aZ7mDsQe5LgVhN0uI";

export function buildAdmin(ctx: AdminContext): HTMLElement {
  const btn = (label: string, run: () => unknown, cls = "") =>
    h(
      "button",
      {
        type: "button",
        class: cls,
        onclick: async () => {
          try {
            await run();
          } catch (e) {
            toast(messageOf(e), "error");
          }
        },
      },
      label,
    );
  const group = (title: string, note: string, ...items: Node[]) =>
    h("section", { class: "set-section admin-group" }, h("h2", {}, title), note ? h("p", { class: "muted small set-block" }, note) : null, h("div", { class: "admin-buttons" }, ...items));

  const info = h("pre", { class: "admin-info" }, "Loading...");
  const refreshInfo = async () => {
    const s = await ctx.settings();
    info.textContent = [
      `Version        ${ctx.version}`,
      `Platform       ${navigator.platform} · ${navigator.userAgent.match(/(Windows NT [\d.]+|Linux|Mac OS X [\d_]+)/)?.[0] ?? "?"}`,
      `Style          ${s.uiStyle} · animations ${s.animations}`,
      `Wallpaper      app ${s.wallpaper} → ${resolveApp(s)} · terminal ${s.termWallpaper} → ${resolveTerm(s)}`,
      `Theme          ${s.themeName}`,
      `Window         ${innerWidth}×${innerHeight} @ ${devicePixelRatio}x`,
      `Events logged  ${diagEvents().length}`,
    ].join("\n");
  };
  void refreshInfo();

  const loaders = h(
    "div",
    { class: "admin-loaders" },
    ...STYLES.map(([id, name]) => h("div", { class: "admin-loader" }, loader(28, id as LoaderStyle), loader(16, id as LoaderStyle), h("span", { class: "small muted" }, name))),
  );

  const events = h("pre", { class: "admin-info admin-events" });
  const showEvents = () => {
    const evs = diagEvents();
    events.textContent = evs.length ? evs.slice(-40).map((e) => `${new Date(e.t).toLocaleTimeString()} ${e.kind.toUpperCase().padEnd(5)} ${e.text}`).join("\n") : "(no events yet)";
  };
  showEvents();

  const page = h(
    "div",
    { class: "settings-body admin-page" },
    h(
      "div",
      { class: "admin-head" },
      h("h1", {}, icon("shield", 22), " Preview panel"),
      h("p", { class: "muted" }, "Every screen, dialog, animation and message, with sample data. Nothing here connects anywhere or touches your sessions."),
      h("div", { class: "inline" }, btn("Refresh info", refreshInfo), btn("Leave preview mode", ctx.leave, "danger")),
    ),
    h("section", { class: "set-section admin-group" }, h("h2", {}, "This app"), info),
    group(
      "Styles",
      "Switches the style for real (same as Settings → Appearance).",
      ...STYLES.map(([id, name]) => btn(name, () => ctx.saveSettings({ uiStyle: id }).then(refreshInfo))),
    ),
    group("Animations", "", ...ANIMS.map((a) => btn(a[0].toUpperCase() + a.slice(1), () => ctx.saveSettings({ animations: a }).then(() => toast(`Animations: ${a}`, "ok", 2000))))),
    h("section", { class: "set-section admin-group" }, h("h2", {}, "Loading animations"), h("p", { class: "muted small set-block" }, "Each style's loader, large and small."), loaders),
    group(
      "Start-up",
      "The welcome splash, including the special days.",
      ...DAYS.map(([label, date]) => btn(label, () => showSplash({ force: true, date }))),
      btn("Screensaver now", ctx.screensaver),
      btn("Lock screen", ctx.lock),
    ),
    group("Guided tour", "", btn("Full tour", () => ctx.tour("full")), btn("What's new", () => ctx.tour("whatsNew"))),
    group(
      "Fish",
      "",
      btn("School swims by", () => swimBy(ctx.accent())),
      btn("Golden siakap", () => swimBy(ctx.accent(), { giant: true })),
      btn("Logo turns into the fish", ctx.morphLogo),
      btn("Credits and fish tank", () => showCredits(ctx.version)),
    ),
    group(
      "Messages",
      "",
      btn("Info", () => toast("Connected to web-01.", "info")),
      btn("Success", () => toast("Saved.", "ok")),
      btn("Error", () => toast("Connection refused by db.example.com:22.", "error")),
      btn("Unexpected error notice", () => {
        window.setTimeout(() => {
          throw new Error("Preview: something unexpected happened");
        });
      }),
      btn("Alert", () => alertDialog("Security key", "No security key is connected.\n\nPlug it in, wait a moment and try again.")),
      btn("Confirm", () => confirmDialog("Close 3 sessions?", "The tab has three panes. Closing it ends their sessions.", "Close tab")),
      btn("Danger confirm", () => confirmDialog("Delete folder?", "Delete the folder Production and its 4 sessions?", "Delete", { danger: true })),
      btn("Text prompt", () => promptDialog("Macro input", "Value for {{hostname}}", { hint: "Letters, numbers and . _ - only.", validate: (v) => (/^[\w.-]+$/.test(v) ? null : "Only letters, numbers and . _ -") })),
      btn("Password prompt", () => promptDialog("Password", "Password for deploy@web01.example.com", { password: true })),
    ),
    group(
      "Security dialogs",
      "Shown with sample data; nothing is trusted or saved.",
      btn("New server fingerprint", () => ctx.trust("web01.example.com", 22, "ssh-ed25519", FP)),
      btn("Changed key warning", () => ctx.keyChanged("The host key for db1.example.com:22 does not match the one you trusted.", "SHA256:Zk2p0b7QeXq1rR9mWc4vT8yLs3aH6dJ5uNfG2iKoP1E", FP, "ssh-ed25519")),
      btn("Multi-line paste", () =>
        confirmDialog(
          "Paste multiple lines?",
          h("div", {}, h("p", {}, "The clipboard contains 3 lines. Each line break may run a command."), h("pre", { class: "paste-preview" }, "cd /srv/app\ngit pull\nsudo systemctl restart app")),
          "Paste",
          { danger: true },
        ),
      ),
    ),
    group(
      "Screens",
      "",
      btn("Settings", () => ctx.openSettings()),
      btn("Appearance", () => ctx.openSettings("appearance")),
      btn("About and updates", () => ctx.openSettings("about")),
      btn("Report a problem", ctx.report),
    ),
    group("Sounds", "", ...SOUNDS.map((n) => btn(n, () => play(n)))),
    h("section", { class: "set-section admin-group" }, h("h2", {}, "Recent events"), h("div", { class: "admin-buttons" }, btn("Refresh", showEvents)), events),
  );
  return h("div", { class: "admin-wrap" }, page);
}

/** Ask for the password; true when it was right. */
export async function askAdminPassword(): Promise<boolean> {
  const pw = await promptDialog("Preview panel", "Password", { password: true, okLabel: "Open" });
  if (pw === null) return false;
  if (await api.adminCheck(pw).catch(() => false)) return true;
  toast("That's not it.", "error", 2500);
  return false;
}
