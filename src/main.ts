import "./styles.css";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api, messageOf, type Settings } from "./api";
import { hydrateIcons } from "./icons";
import { MacroRunner } from "./runner";
import { SettingsPanel } from "./settings";
import { SftpPanel } from "./sftp";
import { Sidebar } from "./sidebar";
import { TabManager, chooseShell, type Pane } from "./tabs";
import { $, alertDialog, closeAllModals, closeMenu, confirmDialog, h, isModalOpen, toast } from "./ui";
import { icon } from "./icons";
import { APP_VERSION, FIRST_SEEN, markSeen, pendingTour, readSeen, runTour, stepsSince, type TourStep } from "./tour";

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
  if (live && !$("app").classList.contains("hidden")) {
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
const sftp = new SftpPanel(tabs, () => !collapsed && currentPanel === "sftp" && !$("app").classList.contains("hidden"));
const settingsPanel = new SettingsPanel((s) => applySettings(s), (kind) => void startTour(kind, kind === "whatsNew" ? previousMinor() : undefined));

/** For "What's new" from Settings: show what this version added. */
function previousMinor(): string {
  const [maj, min] = APP_VERSION.split(".").map(Number);
  return min > 0 ? `${maj}.${min - 1}.999` : `${maj - 1}.999.999`;
}

function applySettings(s: Settings) {
  tabs.applySettings(s);
  document.documentElement.style.setProperty("--term-bg", s.background);
}

// ------------------------------------------------------------------ guided tour

const TOUR: TourStep[] = [
  { since: "0.1.0", frame: true, title: "Welcome to Siakap Terminal", text: "A quick tour of the main parts. It takes about a minute. You can skip it and replay it any time from Settings." },
  {
    since: "0.1.0",
    title: "Sessions",
    text: "Your saved servers and devices live here, sorted into folders. Use + SSH for a server, + Local for a terminal on this PC and + Serial for a console cable. Double-click a session to connect.",
    target: '.rail button[data-panel="sessions"]',
    before: () => showPanel("sessions"),
  },
  { since: "0.1.0", title: "New terminal", text: "Opens your default terminal: PowerShell, WSL, cmd and so on. Shortcut: Ctrl+Shift+T. You choose the default in Settings.", target: "#btn-new-local" },
  { since: "0.1.0", title: "Split the screen", text: "Split the current terminal side by side or top and bottom. Drag the divider between them to resize.", target: "#btn-split-h" },
  { since: "0.2.0", title: "Four terminals at once", text: "Ctrl+Shift+G (or this button) splits the current terminal into a 2×2 grid of the same terminal or server.", target: "#btn-grid" },
  {
    since: "0.2.0",
    title: "Choose what opens at start",
    text: "In Settings, under When Siakap starts, pick a terminal (for example your WSL distro) or a saved session, in one, two or four panes.",
    target: "#panel-settings form h4",
    before: () => showPanel("settings"),
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
    before: () => showPanel("macros"),
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
    before: () => showPanel("sftp"),
  },
  { since: "0.1.0", title: "Security key", text: "Moves your USB security key between Windows and WSL with one click (needs usbipd-win).", target: "#btn-security-key" },
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
        card("grid", "Four terminals", "A 2×2 grid of your default terminal", () => void splitGrid()),
      ),
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

function showLock(mode: "create" | "unlock", hint = "") {
  runner.stop("the vault was locked");
  // Wipe what the UI holds from the vault: lists, open dialogs, menus, messages.
  if (tabs.settings?.lockDisconnects) void tabs.closeAll();
  sidebar.clear();
  sftp.clear();
  $("panel-settings").replaceChildren();
  closeAllModals();
  $("toasts").replaceChildren();
  closeMenu();
  $("empty").replaceChildren();
  $("app").classList.add("hidden");
  $("lock").classList.remove("hidden");
  const pass = $("lock-pass") as HTMLInputElement;
  const pass2 = $("lock-pass2") as HTMLInputElement;
  pass.value = pass2.value = "";
  pass2.classList.toggle("hidden", mode !== "create");
  $("lock-submit").textContent = mode === "create" ? "Create vault" : "Unlock";
  $("lock-hint").textContent =
    hint || (mode === "create" ? "Choose a master password to create your encrypted vault." : "Enter your master password.");
  $("lock-error").textContent = "";
  ($("lock-form") as HTMLFormElement).dataset.mode = mode;
  setTimeout(() => pass.focus(), 50);
}

async function onUnlocked() {
  $("lock").classList.add("hidden");
  $("app").classList.remove("hidden");
  try {
    applySettings(await api.settingsGet());
    await sidebar.reload();
    renderWelcome();
    if (currentPanel === "settings") await settingsPanel.render();
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
  if (form.dataset.mode === "create") {
    if (pass.value.length < 12) return void (err.textContent = "Use at least 12 characters. A short sentence works well.");
    if (pass.value !== pass2.value) return void (err.textContent = "The passwords don't match.");
  }
  btn.disabled = true;
  btn.textContent = "Unlocking...";
  try {
    if (form.dataset.mode === "create") await api.vaultCreate(pass.value);
    else await api.vaultUnlock(pass.value);
    pass.value = pass2.value = "";
    await onUnlocked();
  } catch (x) {
    err.textContent = messageOf(x);
    pass.select();
  } finally {
    btn.disabled = false;
    btn.textContent = form.dataset.mode === "create" ? "Create vault" : "Unlock";
  }
});

async function lockNow(reason = "") {
  await api.vaultLock().catch(() => {});
  showLock("unlock", reason);
}

// ------------------------------------------------------------------ rail & panel

function showPanel(name: PanelName) {
  currentPanel = name;
  setCollapsed(false);
  for (const n of ["sessions", "macros", "sftp", "settings"] as PanelName[]) {
    $(`panel-${n}`).classList.toggle("hidden", n !== name);
  }
  document.querySelectorAll<HTMLButtonElement>(".rail button[data-panel]").forEach((b) => b.classList.toggle("active", b.dataset.panel === name));
  if (name === "settings") void settingsPanel.render();
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
$("btn-security-key").addEventListener("click", async () => {
  if (keyBusy) return;
  keyBusy = true;
  $("btn-security-key").classList.add("busy");
  try {
    const devices = await api.securityKeyState();
    const live = devices.filter((d) => d.busId);
    const attached = live.length > 0 && live.every((d) => d.attached);
    if (live.length && live.every((d) => d.shared)) {
      const ok = await confirmDialog(
        "Security key",
        `${live.map((d) => `${d.busId}  ${d.description}  (${d.attached ? "attached to WSL" : "on Windows"})`).join("\n")}\n\n${attached ? "Detach from WSL and give it back to Windows?" : "Attach to WSL? Windows apps will lose access until you detach it."}`,
        attached ? "Detach" : "Attach to WSL",
      );
      if (!ok) return;
    }
    const plan = await api.securityKeyToggle();
    const ids = (plan.busIds ?? []).join(", ");
    toast(plan.action === "attach" ? `Security key attached to WSL (${ids}).` : `Security key detached from WSL (${ids}).`, "ok");
  } catch (e) {
    await alertDialog("Security key", messageOf(e));
  } finally {
    keyBusy = false;
    $("btn-security-key").classList.remove("busy");
  }
});

/** A shell by id, falling back to the configured default, then the first one found. */
function pickShell(id = "") {
  const all = sidebar.shells;
  return all.find((x) => x.id === id) ?? all.find((x) => x.id === tabs.settings?.defaultShell) ?? all[0];
}

async function newLocal(where: "tab" | "h" | "v" = "tab") {
  const sh = pickShell() ?? (await chooseShell());
  if (sh) await tabs.openLocal(sh.id, sh.label, where);
}

// Runs once per app start, after the first unlock, if no tab is open yet.
let startupDone = false;
async function runStartup() {
  if (startupDone) return;
  startupDone = true;
  if (tabs.tabs.length) return;
  const s = tabs.settings;
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
$("btn-split-h").addEventListener("click", () => (tabs.focusedPane ? tabs.splitFocused("h") : void newLocal()));
$("btn-split-v").addEventListener("click", () => (tabs.focusedPane ? tabs.splitFocused("v") : void newLocal()));
$("btn-grid").addEventListener("click", () => void splitGrid());

async function splitGrid() {
  if (!tabs.focusedPane) await newLocal();
  tabs.splitGrid();
}

// ------------------------------------------------------------------ shortcuts & activity

window.addEventListener("keydown", (e) => {
  if (isModalOpen() || !$("lock").classList.contains("hidden")) return;
  const cs = e.ctrlKey && e.shiftKey && !e.altKey;
  if (cs && e.code === "KeyT") (e.preventDefault(), void newLocal());
  else if (cs && e.code === "KeyD") (e.preventDefault(), tabs.splitFocused("h"));
  else if (cs && e.code === "KeyE") (e.preventDefault(), tabs.splitFocused("v"));
  else if (cs && e.code === "KeyG") (e.preventDefault(), void splitGrid());
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

// Block the webview's own context menu / reload shortcuts in release builds.
window.addEventListener("contextmenu", (e) => {
  if (!(e.target as HTMLElement).closest("input,textarea")) e.preventDefault();
});
window.addEventListener("keydown", (e) => {
  if (e.key === "F5" || (e.ctrlKey && e.code === "KeyR")) e.preventDefault();
}, true);

// Post-connect macros.
sidebar.onReload = () => renderWelcome();

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

void listen("vault-locked", () => showLock("unlock", "Locked after inactivity."));

// ------------------------------------------------------------------ boot

(async () => {
  try {
    const st = await api.vaultStatus();
    newInstall = !st.exists;
    if (st.unlocked) await onUnlocked();
    else showLock(st.exists ? "unlock" : "create");
  } catch (e) {
    showLock("unlock", messageOf(e));
  }
  showPanel("sessions");
})();
