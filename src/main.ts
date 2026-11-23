import "./styles.css";
import { listen } from "@tauri-apps/api/event";
import { api, messageOf, type Settings } from "./api";
import { hydrateIcons } from "./icons";
import { MacroRunner } from "./runner";
import { SettingsPanel } from "./settings";
import { SftpPanel } from "./sftp";
import { Sidebar } from "./sidebar";
import { TabManager, chooseShell } from "./tabs";
import { $, alertDialog, confirmDialog, isModalOpen, toast } from "./ui";

type PanelName = "sessions" | "macros" | "sftp" | "settings";

hydrateIcons();

const tabs = new TabManager();
const runner = new MacroRunner(tabs);
const sidebar = new Sidebar(tabs, runner);
let currentPanel: PanelName = "sessions";
let collapsed = false;
const sftp = new SftpPanel(tabs, () => !collapsed && currentPanel === "sftp" && !$("app").classList.contains("hidden"));
const settingsPanel = new SettingsPanel((s) => applySettings(s));

function applySettings(s: Settings) {
  tabs.applySettings(s);
  document.documentElement.style.setProperty("--term-bg", s.background);
}

// ------------------------------------------------------------------ lock screen

function showLock(mode: "create" | "unlock", hint = "") {
  runner.stop("the vault was locked");
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
    if (currentPanel === "settings") await settingsPanel.render();
    if (currentPanel === "sftp") sftp.shown();
    void runStartup();
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
    if (pass.value.length < 8) return void (err.textContent = "Use at least 8 characters.");
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
    toast(plan.action === "attach" ? `Security key attached to WSL (${plan.busIds.join(", ")}).` : `Security key detached from WSL (${plan.busIds.join(", ")}).`, "ok");
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
    else {
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
tabs.onConnected = (pane) => {
  const id = pane.session?.postConnectMacro;
  if (!id) return;
  const m = sidebar.macros.find((x) => x.id === id);
  if (m) setTimeout(() => void runner.run(m, pane), 600);
};

void listen("vault-locked", () => showLock("unlock", "Locked after inactivity."));

// ------------------------------------------------------------------ boot

(async () => {
  try {
    const st = await api.vaultStatus();
    if (st.unlocked) await onUnlocked();
    else showLock(st.exists ? "unlock" : "create");
  } catch (e) {
    showLock("unlock", messageOf(e));
  }
  showPanel("sessions");
})();
