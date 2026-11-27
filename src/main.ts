import "./styles.css";
import "./looks.css";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api, messageOf, type KeyDevice, type Settings } from "./api";
import { hydrateIcons } from "./icons";
import { installDiag } from "./diag";
import { installEggs } from "./eggs";
import { accentOf, applyIcon, applySkin, drawIcon, setGlass } from "./skin";
import { configure as configureSound, play } from "./sound";
import { Screensaver, fishIcon, swimBy } from "./screensaver";
import { preloadLook, showSplash } from "./splash";
import { MacroRunner } from "./runner";
import { SettingsPanel } from "./settings";
import { SftpPanel } from "./sftp";
import { Sidebar } from "./sidebar";
import { TabManager, chooseShell, type Pane, type Slot, type Where } from "./tabs";
import { $, alertDialog, closeAllModals, closeMenu, confirmDialog, h, isModalOpen, modal, showMenu, toast } from "./ui";
import { icon } from "./icons";
import { APP_VERSION, FIRST_SEEN, markSeen, pendingTour, readSeen, runTour, stepsSince, tourRunning, type TourStep } from "./tour";

// Note unexpected errors for "Report a problem" (kept in memory only).
let lastCrashNotice = 0;
let siakapAccent = "#5aa9e6";
installDiag(() => {
  if (Date.now() - lastCrashNotice < 60_000) return;
  lastCrashNotice = Date.now();
  toast("Something went wrong inside Siakap. To tell the developer, use Settings → About → Report a problem.", "error", 8000);
});

type PanelName = "sessions" | "macros" | "sftp" | "settings";

hydrateIcons();

// Siakap never opens other pages or windows (the backend also blocks navigation).
window.open = () => null;

// ------------------------------------------------------------------ title bar
// The native title bar is hidden: the tab bar is the title bar, with these controls.
const appWindow = getCurrentWindow();
async function syncMaxButton() {
  const max = await appWindow.isMaximized().catch(() => false);
  const b = $("win-max");
  b.title = max ? "Restore" : "Maximize";
  b.replaceChildren(icon(max ? "win-restore" : "win-max", 14));
  document.documentElement.classList.toggle("maximized", max);
}
$("win-min").addEventListener("click", () => void appWindow.minimize());
$("win-max").addEventListener("click", () => void appWindow.toggleMaximize());
$("win-close").addEventListener("click", async () => {
  const live = tabs.allPanes().filter((p) => p.status === "connected").length;
  if (live && !$("app").classList.contains("hidden") && tabs.settings?.confirmQuit !== false) {
    const ok = await confirmDialog("Close Siakap Terminal?", `${live} session${live === 1 ? " is" : "s are"} still open and will be disconnected.`, "Close", { danger: true });
    if (!ok) return;
  }
  await tabs.closeAll();
  void appWindow.close();
});
void appWindow.onResized(() => void syncMaxButton());
void syncMaxButton();

const tabs = new TabManager();
const runner = new MacroRunner(tabs);
const sidebar = new Sidebar(tabs, runner);
let currentPanel: PanelName = "sessions";
let collapsed = false;
const screensaver = new Screensaver();
const sftp = new SftpPanel(tabs, () => !collapsed && currentPanel === "sftp" && !$("app").classList.contains("hidden"));
const settingsPanel = new SettingsPanel((s) => applySettings(s), (kind) => void startTour(kind, kind === "whatsNew" ? previousMinor() : undefined));
settingsPanel.onPasswordModeChanged = () => void refreshVaultStatus().catch(() => {});
settingsPanel.onPreviewScreensaver = () => screensaver.start();
settingsPanel.prepareInstall = async () => {
  const live = tabs.allPanes().filter((p) => p.status === "connected").length;
  if (live && !(await confirmDialog("Install the update now?", `Siakap will close to install the update and then open again. ${live} open session${live === 1 ? "" : "s"} will be disconnected.`, "Install now"))) return false;
  await tabs.closeAll();
  return true;
};

/** For "What's new" from Settings: show what this version added. */
function previousMinor(): string {
  const [maj, min] = APP_VERSION.split(".").map(Number);
  return min > 0 ? `${maj}.${min - 1}.999` : `${maj - 1}.999.999`;
}

let shownHidden: boolean | undefined;
function applySettings(s: Settings) {
  tabs.applySettings(s);
  const root = document.documentElement.style;
  root.setProperty("--term-bg", s.background);
  // Interface zoom applies to the app's own controls, never inside terminals.
  root.setProperty("--ui-zoom", String((s.uiScale || 100) / 100));
  root.setProperty("--term-pad", `${Math.min(32, s.termPadding ?? 6)}px`);
  const app = $("app").classList;
  app.toggle("no-rail-labels", s.railLabels === false);
  app.toggle("tabs-compact", s.tabWidth === "compact");
  app.toggle("tabs-wide", s.tabWidth === "wide");
  app.toggle("tab-close-hover", !!s.tabCloseOnHover);
  if (shownHidden !== s.sftpShowHidden) {
    shownHidden = s.sftpShowHidden;
    void sftp.refresh();
  }
  applySkin(s);
  void applyIcon(s);
  document.documentElement.dataset.ui = s.uiStyle ?? "standard";
  document.documentElement.dataset.anim = s.animations ?? "fluid";
  setGlass(s.glassTransparency ?? 42, s.glassBlur ?? 30);
  siakapAccent = accentOf(s);
  siakapLook = s;
  drawSiakapButton();
  configureSound({ ui: s.soundUi !== false, chime: s.soundChime !== false, volume: s.soundVolume ?? 40 });
  screensaver.configure(s.screensaverMinutes ?? 0, s);
  // Needed before the vault is unlocked, so kept on this PC (not secret).
  try {
    localStorage.setItem("siakap.splash", s.splash === false ? "0" : "1");
    localStorage.setItem("siakap.skin", JSON.stringify({ bg: s.background, fg: s.foreground, accent: s.accent, palette: s.palette, appSkin: s.appSkin, ui: s.uiStyle, anim: s.animations, gt: s.glassTransparency, gb: s.glassBlur }));
  } catch {
    /* per-PC convenience only */
  }
}

// The Siakap Terminal logo at the top of the rail. Five clicks turn it into a
// pixel siakap; after that, each click sends a school swimming across the app.
let siakapClicks = 0;
let siakapFish = false;
let siakapLook: Settings | null = null;
function drawSiakapButton() {
  const btn = $("btn-siakap");
  let art: HTMLCanvasElement;
  if (siakapFish) art = fishIcon(siakapAccent);
  else {
    art = siakapLook ? drawIcon(siakapLook, 64) : drawIcon({ background: "#11151c", foreground: "#d8dee9", accent: "", palette: [] } as unknown as Settings, 64);
    art.classList.add("rail-logo");
  }
  btn.title = siakapFish ? "Siakap! Click to swim" : "Siakap Terminal";
  btn.replaceChildren(art, h("span", {}, "Siakap"));
}
drawSiakapButton();
$("btn-siakap").addEventListener("click", () => {
  const btn = $("btn-siakap");
  if (siakapFish) {
    play("splash");
    swimBy(siakapAccent);
    return;
  }
  siakapClicks++;
  if (siakapClicks < 5) {
    play("click");
    btn.classList.remove("wiggle");
    void btn.offsetWidth; // restart the animation
    btn.classList.add("wiggle");
    return;
  }
  siakapFish = true;
  play("chime");
  drawSiakapButton();
  btn.classList.remove("wiggle", "morph");
  void btn.offsetWidth;
  btn.classList.add("morph");
  toast("You found the siakap! Click it again to watch it swim.", "ok", 4000);
});
$("btn-siakap").addEventListener("contextmenu", (e) => {
  if (!siakapFish) return;
  showMenu(e as MouseEvent, [
    {
      label: "Back to the Siakap Terminal logo",
      action: () => {
        siakapFish = false;
        siakapClicks = 0;
        drawSiakapButton();
      },
    },
  ]);
});

installEggs(() => siakapAccent);

// Material style: a ripple where a button is pressed.
document.addEventListener(
  "pointerdown",
  (e) => {
    const root = document.documentElement;
    if (root.dataset.ui !== "material" || root.dataset.anim === "off") return;
    const b = (e.target as HTMLElement).closest?.("button");
    if (!b || (b as HTMLButtonElement).disabled) return;
    const r = b.getBoundingClientRect();
    const size = Math.max(r.width, r.height) * 2.2;
    const z = parseFloat(getComputedStyle(b).zoom || "1") || 1;
    const dot = h("span", { class: "ripple" });
    dot.style.cssText = `width:${size / z}px;height:${size / z}px;left:${(e.clientX - r.left - size / 2) / z}px;top:${(e.clientY - r.top - size / 2) / z}px`;
    if (getComputedStyle(b).position === "static") b.style.position = "relative";
    b.style.overflow = "hidden";
    b.append(dot);
    window.setTimeout(() => dot.remove(), 600);
  },
  true,
);

// A full-page tab (Settings) hides the side panel while it's in front.
tabs.onPageChange = (p) => {
  $("app").classList.toggle("page-full", !!p);
  document.querySelectorAll<HTMLElement>(".rail button[data-panel]").forEach((b) =>
    b.classList.toggle("active", p ? b.dataset.panel === p.id : b.dataset.panel === currentPanel && !collapsed),
  );
};

/** Settings opens as its own tab. */
function openSettings(section = "") {
  tabs.openPage("settings", "Settings", "settings", () => settingsPanel.el);
  if (section) settingsPanel.show(section);
  else void settingsPanel.render();
}

// ------------------------------------------------------------------ guided tour

const TOUR: TourStep[] = [
  { since: "0.1.0", frame: true, title: "Welcome to Siakap Terminal", text: "A quick tour of the main parts. It takes about a minute. You can skip it and replay it any time from Settings." },
  {
    since: "0.1.0",
    title: "Sessions",
    text: "Your saved servers and devices live here, sorted into folders. Use + SSH for a server, + Local for a terminal on this PC and + Serial for a console cable. Double-click a session to connect.",
    target: '.rail button[data-panel="sessions"]',
    before: railStep,
    action: "click",
  },
  { since: "0.1.0", title: "New terminal", text: "Opens your default terminal: PowerShell, WSL, cmd and so on. Shortcut: Ctrl+Shift+T. Right-click it to pick any terminal or saved session.", target: "#btn-new-local", before: leavePage, action: "click" },
  { since: "0.1.0", title: "Split the screen", text: "Split the current tab side by side or top and bottom. The new pane asks what to show: one of your open sessions, a terminal or a saved session. Drag the divider to resize.", target: "#btn-split-h", before: leavePage, action: "click" },
  { since: "0.2.0", title: "Four panes at once", text: "Ctrl+Shift+G (or this button) splits a tab into a 2×2 grid. Close a pane with the x in its corner.", target: "#btn-grid", before: leavePage },
  {
    since: "0.2.0",
    title: "Choose what opens at start",
    text: "Here in Settings, under Startup, tabs and window, pick a terminal (for example your WSL distro) or a saved session, in one, two or four panes.",
    target: "#set-startup",
    before: () => openSettings("startup"),
  },
  {
    since: "0.3.0",
    title: "Serial consoles",
    text: "Plug in a console cable and click + Serial. The COM port is found automatically; pick the speed (usually 9600) and connect. Ctrl+Shift+B sends a break.",
    target: '#panel-sessions button[title^="Connect a console"]',
    before: () => showPanel("sessions"),
  },
  {
    since: "0.1.0",
    title: "Macros",
    text: "A macro types a list of commands for you, into the terminal you clicked last. Click a macro to run it; Esc stops it.",
    target: '.rail button[data-panel="macros"]',
    before: railStep,
    action: "click",
  },
  {
    since: "0.3.0",
    title: "Smarter macros",
    text: "Highlight a value in a macro and click Make input to be asked for it on each run. Drag macros into folders, right-click to duplicate or rename, and import your Siakap backups with the import button.",
    target: "#panel-macros .toolbar",
    before: () => showPanel("macros"),
  },
  {
    since: "0.4.0",
    title: "Bring your MobaXterm sessions and macros",
    text: "In MobaXterm, export your sessions (.mxtsessions) and macros (.mxtmacros). Then click the import button here and pick both files at once. Folders, serial ports, WSL, SSH and login macros come across.",
    target: '#panel-macros button[title^="Import"]',
    before: () => showPanel("macros"),
  },
  {
    since: "0.7.5",
    title: "Pick a style and how things move",
    text: "Choose how Siakap looks: Standard, Glass, Material, Fluent, Dot matrix, Retro or Minimal. Then pick the animations: Fluid, Bouncy, Slide, Subtle or Off.",
    target: "#set-appearance",
    before: () => openSettings("appearance"),
  },
  {
    since: "0.7.5",
    title: "The Siakap Terminal logo",
    text: "The logo now sits at the top of this bar. Some say clicking it a few times does something.",
    target: "#btn-siakap",
    before: leavePage,
  },
  {
    since: "0.7.4",
    title: "Theme editor with a live preview",
    text: "Edit colours opens the theme editor. A small Siakap window shows every change as you pick it; click any part of it to change that colour. Save uses the colours, and Save as... keeps them as a new theme you can reuse.",
    target: "#set-appearance",
    before: () => openSettings("appearance"),
  },
  {
    since: "0.7.3",
    title: "Orchid themes and Report a problem",
    text: "Two new themes, Orchid and Orchid Light, in pink, purple, green and gold. If something goes wrong, Report a problem here makes a report you can read, save or copy and send to the developer. Nothing is sent by the app.",
    target: "#set-about",
    before: () => openSettings("about"),
  },
  {
    since: "0.7.2",
    title: "Touchscreen",
    text: "On a touchscreen, swipe a terminal to scroll (flick for speed), tap it to type, and pinch to make its text bigger or smaller. In the side lists, swipe to scroll and press and hold to drag.",
    target: "#workspace",
    before: leavePage,
  },
  {
    since: "0.7.1",
    title: "Update with one click",
    text: "Check for updates, then Download and install: Siakap downloads the new version, checks it, and after a short countdown closes, updates itself and opens again.",
    target: "#set-about",
    before: () => openSettings("about"),
  },
  {
    since: "0.7.0",
    title: "Themes colour the whole app",
    text: "A theme now recolours the panels, tabs and menus too (light themes give a light app), and the app icon matches it. Undo and Revert all, bottom left, put back any change you make here.",
    target: "#set-appearance",
    before: () => openSettings("appearance"),
  },
  {
    since: "0.7.0",
    title: "Sounds, screensaver and a welcome splash",
    text: "A chime plays when a tab finishes a long command, with soft sounds for clicks and Enter. After a few idle minutes, pixel siakap swim across the screen. All of it, and the splash, can be changed or turned off here.",
    target: "#set-sound",
    before: () => openSettings("sound"),
  },
  {
    since: "0.7.0",
    title: "The tour now shows you around",
    text: "This tour opens the screens it talks about, and you can click what it highlights. Some steps carry on by themselves when you try them.",
  },
  {
    since: "0.6.2",
    title: "Check for updates",
    text: "Settings, under About, has a Check for updates button. It asks GitHub for the newest version only when you click it, and offers the download page if there's a newer one.",
    target: "#set-about",
    before: () => openSettings("about"),
  },
  {
    since: "0.6.1",
    title: "Many more settings",
    text: "Settings now covers the interface size, tab behaviour, the window, SSH keep-alive and automatic reconnect, paste and copy, hidden SFTP files and timestamps in session logs. The version is shown at the top of Settings.",
    target: "#set-connections",
    before: () => openSettings("connections"),
  },
  {
    since: "0.6.0",
    title: "A new Settings tab",
    text: "Settings now opens as its own tab, with sections and a search box. Pick from a gallery of colour themes, customise every colour, and import or export themes, including Windows Terminal colour schemes. Changes save as you make them.",
    target: '.rail button[data-panel="settings"]',
    before: leavePage,
    action: "click",
  },
  {
    since: "0.5.4",
    title: "Save and log terminal output",
    text: "Right-click a tab (or Shift+right-click in a terminal) to save everything on screen to a file, or to log the session to a file while it runs. Settings, under Session logs, can log every terminal automatically.",
    target: "#tabs",
    before: leavePage,
  },
  {
    since: "0.5.3",
    title: "Choose what goes in a split",
    text: "Split now adds an empty pane that asks what to show: move one of your open sessions into it, open a terminal, or pick a saved session. Double-clicking a session in the Sessions panel also fills the empty pane.",
    target: "#btn-split-h",
  },
  {
    since: "0.5.1",
    title: "Right-click to paste",
    text: "Right-click in a terminal to paste. If text is selected, right-click copies it instead. Shift+right-click shows the menu. You can turn this off in Settings, under Mouse and clipboard.",
    target: "#workspace",
    before: leavePage,
  },
  {
    since: "0.5.0",
    title: "Folders, right-click menus and tidier tabs",
    text: "Make folders with the folder button and drag sessions onto them. Right-click sessions, folders, tabs and terminals for more options, including Copy and Paste. Drag tabs to reorder them, and pick any installed font in Settings.",
    target: '.rail button[data-panel="sessions"]',
    before: () => showPanel("sessions"),
  },
  {
    since: "0.4.3",
    title: "Skip the master password if you like",
    text: "In Settings, under Security, you can untick Ask for the master password when Siakap opens. Siakap then opens straight away on this PC, for your Windows account only. Lock still asks for it.",
    target: "#set-security",
    before: () => openSettings("security"),
  },
  {
    since: "0.4.1",
    title: "Choose which security key to move",
    text: "Key now lists your connected security keys. Pick one, then Attach to WSL or Detach. Siakap checks afterwards that the key really moved.",
    target: "#btn-security-key",
  },
  {
    since: "0.4.0",
    title: "One clean title bar",
    text: "The tabs now sit in the window's title bar. Drag the empty space to move the window, double-click it to maximise, and use the buttons on the right to minimise, maximise or close.",
    target: "#win-controls",
  },
  {
    since: "0.3.1",
    title: "Easier pauses in macros",
    text: "Write @wait 1000 to pause for a second; the # in front is optional and spacing doesn't matter. While you edit a macro, Siakap shows what each line will do, so mistakes show up before you run it.",
    target: '.rail button[data-panel="macros"]',
    before: () => showPanel("macros"),
  },
  {
    since: "0.3.0",
    title: "Command status on tabs",
    text: "The dot on each tab turns blue while a command runs, green when it succeeds and red when it fails, so you can keep an eye on other tabs.",
    target: "#tabs",
    before: leavePage,
  },
  {
    since: "0.3.0",
    title: "Startup commands",
    text: "A saved session can type commands for you once it's connected, for example terminal length 0. Find them under Advanced settings when you edit a session.",
    target: '.rail button[data-panel="sessions"]',
    before: () => showPanel("sessions"),
  },
  {
    since: "0.1.0",
    title: "Files (SFTP)",
    text: "Browse, upload and download files on the server you're connected to. Drag files from Explorer onto this panel to upload them.",
    target: '.rail button[data-panel="sftp"]',
    before: railStep,
    action: "click",
  },
  { since: "0.1.0", title: "Security key", text: "Moves your USB security key between Windows and WSL (needs usbipd-win). Pick the key, then Attach to WSL or Detach.", target: "#btn-security-key", before: leavePage },
  {
    since: "0.1.0",
    title: "Lock",
    text: "Locks Siakap and wipes your saved passwords from memory. Siakap also locks itself when you're away; you can change the time in Settings.",
    target: "#btn-lock",
    before: () => showPanel("sessions"),
  },
  { since: "0.1.0", frame: true, title: "You're all set", text: "You can replay this tour any time from Settings > Show the tour again." },
];

async function startTour(kind: "full" | "whatsNew", sinceVersion?: string) {
  if (kind === "full") return runTour(TOUR, "Tour");
  const seen = sinceVersion ?? readSeen() ?? FIRST_SEEN;
  const fresh = stepsSince(TOUR.filter((s) => !s.frame), seen);
  if (!fresh.length) return markSeen();
  const steps: TourStep[] = [
    { since: APP_VERSION, title: `What's new in ${APP_VERSION}`, text: `Siakap Terminal was updated. Here ${fresh.length === 1 ? "is the 1 new thing" : `are the ${fresh.length} new things`} since you last used it.` },
    ...fresh,
    { since: APP_VERSION, title: "That's everything new", text: "See the full tour any time from Settings > Show the tour again." },
  ];
  await runTour(steps, "What's new");
  showPanel("sessions");
}

let newInstall = false;
let tourChecked = false;
function maybeTour() {
  if (tourChecked) return;
  tourChecked = true;
  const kind = pendingTour(newInstall);
  if (kind) setTimeout(() => void startTour(kind).then(() => showPanel("sessions")), 900);
}

// ------------------------------------------------------------------ welcome screen

/** Shown whenever no tab is open: big, obvious ways to get started. */
function renderWelcome() {
  const sh = sidebar.shells.length ? pickShell() : undefined;
  const card = (ic: string, title: string, text: string, onclick: () => void) =>
    h("button", { class: "welcome-card", onclick }, h("span", { class: "welcome-icon" }, icon(ic, 22)), h("strong", {}, title), h("span", { class: "muted small" }, text));
  const recent = sidebar.sessions.slice(0, 8);
  $("empty").replaceChildren(
    h(
      "div",
      { class: "welcome" },
      h("h1", {}, "What would you like to open?"),
      h(
        "div",
        { class: "welcome-grid" },
        card("terminal", "Terminal on this PC", sh ? `Opens ${sh.label}` : "PowerShell, Command Prompt or WSL", () => void newLocal()),
        card("remote", "Connect to a server", "SSH to a Linux server, switch or router", () => void sidebar.newSession("ssh")),
        card("serial", "Serial console", "Use a console cable (COM port)", () => void sidebar.newSession("serial")),
        card("grid", "Four terminals", "A 2×2 grid of your default terminal", () => void layout("grid")),
      ),
      h("p", { class: "welcome-version muted small" }, `Siakap Terminal ${APP_VERSION}`),
      recent.length
        ? h(
            "div",
            { class: "welcome-recent" },
            h("h4", {}, "Saved sessions"),
            h(
              "div",
              { class: "chips" },
              ...recent.map((x) =>
                h(
                  "button",
                  { class: "chip", title: "Connect", onclick: () => sidebar.connectSession(x) },
                  icon(x.kind === "ssh" ? "remote" : x.kind === "serial" ? "serial" : "terminal", 14),
                  x.name,
                ),
              ),
            ),
          )
        : null,
      h(
        "p",
        { class: "muted small welcome-keys" },
        "Shortcuts: ",
        h("kbd", {}, "Ctrl+Shift+T"), " new terminal · ",
        h("kbd", {}, "Ctrl+Shift+D"), " split · ",
        h("kbd", {}, "Ctrl+Shift+G"), " four panes",
      ),
    ),
  );
}

// ------------------------------------------------------------------ lock screen

// The vault has no master password: locking only hides the window, and
// "Open" unlocks it with the Windows account.
let passwordless = false;
let rememberAvailable = false;

function showLock(mode: "create" | "unlock" | "open", hint = "") {
  screensaver.stop();
  runner.stop("the vault was locked");
  // Wipe what the UI holds from the vault: lists, open dialogs, menus, messages.
  if (tabs.settings?.lockDisconnects) void tabs.closeAll();
  sidebar.clear();
  sftp.clear();
  settingsPanel.el.replaceChildren();
  const settingsTab = tabs.pages.find((p) => p.id === "settings");
  if (settingsTab) tabs.closePage(settingsTab);
  closeAllModals();
  $("toasts").replaceChildren();
  closeMenu();
  $("empty").replaceChildren();
  $("app").classList.add("hidden");
  $("lock").classList.remove("hidden");
  const pass = $("lock-pass") as HTMLInputElement;
  const pass2 = $("lock-pass2") as HTMLInputElement;
  pass.value = pass2.value = "";
  const nopw = $("lock-nopw-box") as HTMLInputElement;
  nopw.checked = false;
  $("lock-nopw").classList.toggle("hidden", mode !== "create" || !rememberAvailable);
  $("lock-nopw-hint").classList.add("hidden");
  pass.classList.toggle("hidden", mode === "open");
  pass2.classList.toggle("hidden", mode !== "create");
  $("lock-note").classList.toggle("hidden", mode === "open");
  $("lock-submit").textContent = submitLabel(mode);
  $("lock-hint").textContent =
    hint ||
    (mode === "create"
      ? "Choose a master password to create your encrypted vault."
      : mode === "open"
        ? "Siakap is locked. It opens with your Windows account."
        : "Enter your master password.");
  $("lock-error").textContent = "";
  ($("lock-form") as HTMLFormElement).dataset.mode = mode;
  setTimeout(() => (mode === "open" ? $("lock-submit") : pass).focus(), 50);
}

function submitLabel(mode: string) {
  return mode === "create" ? "Create vault" : mode === "open" ? "Open" : "Unlock";
}

$("lock-nopw-box").addEventListener("change", () => {
  const on = ($("lock-nopw-box") as HTMLInputElement).checked;
  $("lock-pass").classList.toggle("hidden", on);
  $("lock-pass2").classList.toggle("hidden", on);
  $("lock-nopw-hint").classList.toggle("hidden", !on);
  $("lock-note").classList.toggle("hidden", on);
  $("lock-hint").textContent = on ? "Siakap will create your encrypted vault without a master password." : "Choose a master password to create your encrypted vault.";
  $("lock-error").textContent = "";
});

/** Lock screen for the current vault. */
function lockMode(): "unlock" | "open" {
  return passwordless ? "open" : "unlock";
}

async function refreshVaultStatus() {
  const st = await api.vaultStatus();
  passwordless = st.passwordless;
  rememberAvailable = st.rememberAvailable;
  return st;
}

async function onUnlocked() {
  $("lock").classList.add("hidden");
  $("app").classList.remove("hidden");
  try {
    applySettings(await api.settingsGet());
    await sidebar.reload();
    renderWelcome();
    if (currentPanel === "sftp") sftp.shown();
    void runStartup();
    maybeTour();
  } catch (e) {
    toast(messageOf(e), "error");
  }
  tabs.focusedPane?.term.focus();
}

$("lock-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.currentTarget as HTMLFormElement;
  const pass = $("lock-pass") as HTMLInputElement;
  const pass2 = $("lock-pass2") as HTMLInputElement;
  const err = $("lock-error");
  const btn = $("lock-submit") as HTMLButtonElement;
  err.textContent = "";
  const noPassword = form.dataset.mode === "create" && ($("lock-nopw-box") as HTMLInputElement).checked;
  if (form.dataset.mode === "create" && !noPassword) {
    if (pass.value.length < 12) return void (err.textContent = "Use at least 12 characters. A short sentence works well.");
    if (pass.value !== pass2.value) return void (err.textContent = "The passwords don't match.");
  }
  btn.disabled = true;
  btn.textContent = form.dataset.mode === "create" ? "Creating..." : "Opening...";
  try {
    if (noPassword) await api.vaultCreatePasswordless();
    else if (form.dataset.mode === "create") await api.vaultCreate(pass.value);
    else if (form.dataset.mode === "open") await api.vaultUnlockRemembered();
    else await api.vaultUnlock(pass.value);
    pass.value = pass2.value = "";
    await refreshVaultStatus().catch(() => {});
    await onUnlocked();
  } catch (x) {
    err.textContent = messageOf(x);
    if (form.dataset.mode !== "open") pass.select();
  } finally {
    btn.disabled = false;
    btn.textContent = submitLabel(form.dataset.mode ?? "");
  }
});

async function lockNow(reason = "") {
  await api.vaultLock().catch(() => {});
  showLock(lockMode(), passwordless ? "" : reason);
}

// ------------------------------------------------------------------ rail & panel

/** Bring the terminals back to the front if a page (Settings) is showing. */
function leavePage() {
  if (!tabs.activePage) return;
  if (tabs.active) tabs.activate(tabs.active);
  else tabs.closePage(tabs.activePage);
}

/** For tour steps that ask you to click a rail button: start with the panel closed. */
function railStep() {
  leavePage();
  setCollapsed(true);
}

function showPanel(name: PanelName) {
  leavePage();
  currentPanel = name;
  setCollapsed(false);
  for (const n of ["sessions", "macros", "sftp"] as PanelName[]) {
    $(`panel-${n}`).classList.toggle("hidden", n !== name);
  }
  document.querySelectorAll<HTMLButtonElement>(".rail button[data-panel]").forEach((b) => b.classList.toggle("active", b.dataset.panel === name));
  if (name === "sftp") sftp.shown();
  if (name === "sessions") sidebar.renderSessions();
  if (name === "macros") sidebar.renderMacros();
}

function setCollapsed(c: boolean) {
  collapsed = c;
  $("app").classList.toggle("panel-collapsed", c);
  if (c) document.querySelectorAll(".rail button[data-panel]").forEach((b) => b.classList.remove("active"));
  else document.querySelector(`.rail button[data-panel="${currentPanel}"]`)?.classList.add("active");
}

document.querySelectorAll<HTMLButtonElement>(".rail button[data-panel]").forEach((b) =>
  b.addEventListener("click", () => {
    const name = b.dataset.panel as PanelName;
    if (name === "settings") return openSettings();
    if (tabs.activePage) return showPanel(name); // leave Settings, with this panel open
    if (name === currentPanel && !collapsed) setCollapsed(true);
    else showPanel(name);
  }),
);

(() => {
  const res = $("panel-resizer");
  const app = $("app");
  try {
    const w = Number(localStorage.getItem("panelWidth"));
    if (w >= 180 && w <= 800) app.style.setProperty("--panel-width", `${w}px`);
  } catch {
    /* storage unavailable */
  }
  res.addEventListener("dblclick", () => setCollapsed(!collapsed));
  res.addEventListener("pointerdown", (e) => {
    if (collapsed) return;
    res.setPointerCapture(e.pointerId);
    const left = $("panel").getBoundingClientRect().left;
    const move = (ev: PointerEvent) => {
      const w = Math.min(800, Math.max(180, ev.clientX - left));
      app.style.setProperty("--panel-width", `${w}px`);
      try {
        localStorage.setItem("panelWidth", String(w));
      } catch {
        /* ignore */
      }
    };
    const up = () => {
      res.removeEventListener("pointermove", move);
      res.removeEventListener("pointerup", up);
    };
    res.addEventListener("pointermove", move);
    res.addEventListener("pointerup", up);
  });
})();

$("btn-lock").addEventListener("click", () => void lockNow("Locked."));

let keyBusy = false;

/** Pick a security key and an action. Nothing is pre-selected when there is a choice. */
function chooseKey(devices: KeyDevice[]): Promise<{ action: "attach" | "detach"; device: KeyDevice } | null> {
  return modal<{ action: "attach" | "detach"; device: KeyDevice } | null>(
    "Security key",
    (close) => {
      let chosen: KeyDevice | null = devices.length === 1 ? devices[0] : null;
      const attachBtn = h("button", { class: "primary", onclick: () => chosen && close({ action: "attach", device: chosen }) }, "Attach to WSL");
      const detachBtn = h("button", { onclick: () => chosen && close({ action: "detach", device: chosen }) }, "Detach");
      const sync = () => {
        (attachBtn as HTMLButtonElement).disabled = !chosen || chosen.attached;
        (detachBtn as HTMLButtonElement).disabled = !chosen || !chosen.attached;
      };
      const rows = devices.map((d) => {
        const radio = h("input", { type: "radio", name: "seckey", "aria-label": `BUSID ${d.busId}` }) as HTMLInputElement;
        radio.checked = chosen === d;
        const row = h(
          "label",
          { class: "key-row" },
          radio,
          h("span", { class: "key-bus" }, d.busId ?? ""),
          h("span", { class: `key-state ${d.attached ? "on" : d.shared ? "" : "warn"}` }, d.state),
          h(
            "span",
            { class: "key-name" },
            h("span", {}, d.description || "(no name)", d.recommended ? h("span", { class: "badge" }, "usual key") : null),
            h("span", { class: "muted small key-id" }, d.instanceId),
          ),
        );
        radio.addEventListener("change", () => {
          chosen = d;
          sync();
        });
        return row;
      });
      sync();
      return {
        body: h(
          "div",
          {},
          h(
            "p",
            { class: "muted" },
            devices.length > 1
              ? "More than one security key is connected. Choose the one to move; none is picked for you."
              : "Attach gives the key to WSL (Windows apps lose it until you detach). Detach gives it back to Windows.",
          ),
          h("div", { class: "key-list" }, ...rows),
        ),
        actions: [h("button", { onclick: () => close(null) }, "Cancel"), detachBtn, attachBtn],
        focus: chosen ? (chosen.attached ? detachBtn : attachBtn) : undefined,
      };
    },
    { wide: true, dismissValue: null },
  );
}

$("btn-security-key").addEventListener("click", async () => {
  if (keyBusy) return;
  keyBusy = true;
  const btn = $("btn-security-key");
  btn.classList.add("busy");
  try {
    const live = (await api.securityKeyState()).filter((d) => d.busId);
    if (!live.length) {
      await alertDialog("Security key", "No security key is connected.\n\nPlug it in, wait a moment and try again.");
      return;
    }
    const pick = await chooseKey(live.sort((a, b) => Number(b.recommended) - Number(a.recommended)));
    if (!pick) return;
    toast(pick.action === "attach" ? `Attaching ${pick.device.busId} to WSL…` : `Detaching ${pick.device.busId}…`, "info", 2500);
    const r = await api.securityKeyAction(pick.action, pick.device);
    if (r.kind === "already") await alertDialog(r.title, r.message);
    else toast(`${r.title}. ${r.message}`, "ok", 6000);
  } catch (e) {
    await alertDialog("Security key", messageOf(e));
  } finally {
    keyBusy = false;
    btn.classList.remove("busy");
  }
});

/** A shell by id, falling back to the configured default, then the first one found. */
function pickShell(id = "") {
  const all = sidebar.shells;
  return all.find((x) => x.id === id) ?? all.find((x) => x.id === tabs.settings?.defaultShell) ?? all[0];
}

/** What the + button opens: the default shell, or a saved session chosen in Settings. */
async function newLocal(where: Where = "newtab") {
  const def = tabs.settings?.defaultShell ?? "";
  if (def.startsWith("session:")) {
    const ses = sidebar.sessions.find((x) => x.id === def.slice(8));
    if (ses) return sidebar.connectSession(ses, where);
  }
  const sh = pickShell() ?? (await chooseShell());
  if (sh) await tabs.openLocal(sh.id, sh.label, where);
}

/** The picker inside an empty pane made by Split. */
tabs.slotContent = (slot: Slot) => {
  const pick = (open: () => unknown) => {
    tabs.targetSlot = slot;
    void open();
  };
  const item = (ico: string, label: string, sub: string, run: () => unknown) =>
    h("button", { class: "slot-item", onclick: run }, icon(ico, 15), h("span", { class: "name" }, label), sub ? h("span", { class: "sub" }, sub) : null);
  const open = tabs.allPanes().filter((p) => p.tab !== slot.tab);
  const list = h("div", { class: "slot-list" });
  const search = h("input", { type: "search", placeholder: "Search saved sessions", spellcheck: "false" }) as HTMLInputElement;
  const drawSessions = () => {
    const q = search.value.toLowerCase();
    const hits = sidebar.sessions
      .filter((s) => !q || [s.name, s.host, s.folder].some((x) => x.toLowerCase().includes(q)))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 40);
    list.replaceChildren(
      ...hits.map((s) =>
        item(s.kind === "ssh" ? "remote" : s.kind === "serial" ? "serial" : "terminal", s.name, s.kind === "ssh" ? `${s.user}@${s.host}` : s.folder, () =>
          pick(() => sidebar.connectSession(s)),
        ),
      ),
      ...(hits.length ? [] : [h("p", { class: "muted small" }, sidebar.sessions.length ? "No saved session matches." : "No saved sessions yet.")]),
    );
  };
  search.addEventListener("input", drawSessions);
  drawSessions();
  return h(
    "div",
    { class: "slot-body" },
    h("button", { class: "pane-close", title: "Close this empty pane", onclick: () => tabs.removeSlot(slot) }, icon("x", 13)),
    h("h3", {}, "What should open here?"),
    open.length
      ? h(
          "section",
          {},
          h("h4", {}, "Move an open session here"),
          ...open.map((p) =>
            item(p.kind === "ssh" ? "remote" : p.kind === "serial" ? "serial" : "terminal", p.tab.customTitle ?? p.title, p.status === "connected" ? "open" : p.status, () => tabs.movePane(p, slot)),
          ),
        )
      : null,
    h(
      "section",
      {},
      h("h4", {}, "New terminal on this PC"),
      ...sidebar.shells.map((sh) => item("terminal", sh.label, "", () => pick(() => tabs.openLocal(sh.id, sh.label)))),
      item("serial", "Serial console...", "", () => pick(() => sidebar.quickSerial())),
    ),
    h("section", {}, h("h4", {}, "Saved session"), search, list),
    h("p", { class: "muted small" }, "You can also double-click a session in the Sessions panel: it opens in this pane."),
  );
};

/** Right-click (or long-press) on +: every terminal and saved session. */
function newMenu(e: MouseEvent) {
  showMenu(e, [
    ...sidebar.shells.map((sh) => ({ label: sh.label, action: () => tabs.openLocal(sh.id, sh.label, "newtab") })),
    { label: "Serial console...", action: () => sidebar.quickSerial() },
    ...sidebar.sessions
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 30)
      .map((s) => ({ label: `Session: ${s.name}`, action: () => sidebar.connectSession(s, "newtab") })),
  ]);
}

// Runs once per app start, after the first unlock, if no tab is open yet.
let startupDone = false;
async function runStartup() {
  if (startupDone) return;
  startupDone = true;
  const s = tabs.settings;
  if (s.startMaximized && !(await appWindow.isMaximized().catch(() => true))) void appWindow.toggleMaximize();
  if (tabs.tabs.length) return;
  if (s.startupAction === "shell") {
    const sh = pickShell(s.startupShell);
    if (!sh) return;
    void tabs.openLocal(sh.id, sh.label);
  } else if (s.startupAction === "session") {
    const ses = sidebar.sessions.find((x) => x.id === s.startupSession);
    if (!ses) return toast("The startup session no longer exists. Pick another one in Settings.", "error");
    if (ses.kind === "ssh") void tabs.openSsh(ses);
    else if (ses.kind === "serial") {
      void tabs.openSerial(ses.serial, ses.name, "tab", ses);
      return; // a serial port can only be open once, so no extra panes
    } else {
      const sh = pickShell(ses.shell);
      if (!sh) return;
      void tabs.openLocal(sh.id, ses.name);
    }
  } else return;
  // Panes are placed synchronously; the connections finish in the background.
  if (s.startupPanes === 2) tabs.splitFocused("h");
  else if (s.startupPanes === 4) tabs.splitGrid();
}
$("btn-new-local").addEventListener("click", () => void newLocal());
$("btn-new-local").addEventListener("contextmenu", (e) => newMenu(e));
$("btn-split-h").addEventListener("click", () => void layout("h"));
$("btn-split-v").addEventListener("click", () => void layout("v"));
$("btn-grid").addEventListener("click", () => void layout("grid"));

/** Toolbar layouts: only split a tab that has a single pane. */
async function layout(kind: "h" | "v" | "grid") {
  if (!tabs.focusedPane) {
    await newLocal();
    if (kind === "grid") tabs.layout("grid");
    else if (tabs.focusedPane) tabs.layout(kind);
    return;
  }
  tabs.layout(kind);
}

// ------------------------------------------------------------------ shortcuts & activity

window.addEventListener("keydown", (e) => {
  if (isModalOpen() || !$("lock").classList.contains("hidden")) return;
  const cs = e.ctrlKey && e.shiftKey && !e.altKey;
  if (cs && e.code === "KeyT") (e.preventDefault(), void newLocal());
  else if (cs && e.code === "KeyD") (e.preventDefault(), void layout("h"));
  else if (cs && e.code === "KeyE") (e.preventDefault(), void layout("v"));
  else if (cs && e.code === "KeyG") (e.preventDefault(), void layout("grid"));
  else if (cs && e.code === "KeyW") (e.preventDefault(), tabs.focusedPane && void tabs.closePane(tabs.focusedPane));
  else if (e.ctrlKey && e.code === "Tab") (e.preventDefault(), tabs.cycle(e.shiftKey ? -1 : 1));
  else if (e.key === "Escape" && runner.busy) runner.stop("stopped with Esc");
});

let lastTouch = 0;
const activity = () => {
  const now = Date.now();
  if (now - lastTouch > 15_000) {
    lastTouch = now;
    api.touch().catch(() => {});
  }
};
for (const ev of ["keydown", "mousedown", "wheel"]) window.addEventListener(ev, activity, { capture: true, passive: true });

// Interface sounds: a soft tick for buttons, tabs and menu items.
document.addEventListener(
  "click",
  (e) => {
    const t = e.target as HTMLElement;
    if (t.closest(".xterm")) return;
    if (t.closest("input.switch, input[type=checkbox]")) return play("toggle");
    if (t.closest("button, .tab, .row.item, .folder-row, .menu-item, .theme-card, .slot-item, .welcome-card, .set-nav-item")) play("click");
  },
  true,
);

// Lock when the window is minimised (Settings > Security).
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && tabs.settings?.lockOnMinimize && $("lock").classList.contains("hidden")) void lockNow("Locked when minimised.");
});

// Block the webview's own context menu / reload shortcuts in release builds.
window.addEventListener("contextmenu", (e) => {
  if (!(e.target as HTMLElement).closest("input,textarea")) e.preventDefault();
});
window.addEventListener("keydown", (e) => {
  if (e.key === "F5" || (e.ctrlKey && e.code === "KeyR")) e.preventDefault();
}, true);

// Post-connect macros.
sidebar.onReload = () => {
  renderWelcome();
  tabs.refreshSlots();
};

/** The command that changes folder, quoted for the shell the pane runs. */
function cdCommand(pane: Pane, dir: string): string {
  if (/[\r\n\0]/.test(dir)) throw new Error("The startup folder must be a single path.");
  const shell = pane.kind === "local" ? (pane.shellId ?? "") : "";
  if (shell === "cmd") {
    if (dir.includes('"')) throw new Error("Invalid startup folder.");
    return `cd /d "${dir}"`;
  }
  if (shell === "pwsh" || shell === "powershell") return `Set-Location -LiteralPath '${dir.replaceAll("'", "''")}'`;
  return `cd -- '${dir.replaceAll("'", "'\\''")}'`;
}

// Startup commands: once the session shows a ready prompt, type its startup
// commands (local and SSH sessions, like the Siakap plugin).
tabs.onConnected = async (pane) => {
  const ses = pane.session;
  if (!ses || pane.kind === "serial" || !tabs.settings.startupMacrosEnabled) return;
  let script = ses.startupEnabled !== false ? ses.startupScript ?? "" : "";
  const dir = ses.startupEnabled !== false ? (ses.startupDir ?? "").trim() : "";
  if (!script.trim() && !dir && ses.postConnectMacro) {
    script = sidebar.macros.find((x) => x.id === ses.postConnectMacro)?.script ?? ""; // older sessions
  }
  if (!script.trim() && !dir) return;
  const ok = await tabs.waitForPrompt(pane, tabs.settings.startupTimeoutMs || 10000);
  if (pane.disposed || pane.status !== "connected") return;
  if (!ok) return toast(`Startup commands for "${ses.name}" were skipped: no ready prompt was detected.`, "error");
  try {
    if (dir) script = `${cdCommand(pane, dir)}\n${script}`;
  } catch (e) {
    return toast(messageOf(e), "error");
  }
  await runner.run({ name: `Startup: ${ses.name}`, script }, pane, { quiet: true });
};

void listen("vault-locked", () => showLock(lockMode(), passwordless ? "" : "Locked after inactivity."));

// ------------------------------------------------------------------ boot

preloadLook();
void showSplash();
screensaver.canStart = () => $("lock").classList.contains("hidden") && !isModalOpen() && !tourRunning() && document.visibilityState === "visible";

(async () => {
  try {
    const st = await refreshVaultStatus();
    newInstall = !st.exists;
    if (st.unlocked) await onUnlocked();
    else if (st.exists && st.remembered) {
      // The user turned off "ask for the master password when Siakap opens".
      try {
        await api.vaultUnlockRemembered();
        await onUnlocked();
      } catch (e) {
        await refreshVaultStatus().catch(() => {});
        showLock(lockMode(), messageOf(e));
      }
    } else showLock(st.exists ? "unlock" : "create");
  } catch (e) {
    showLock("unlock", messageOf(e));
  }
  showPanel("sessions");
})();
