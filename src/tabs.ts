// Tabs, each holding a binary split tree of terminal panes.
import { icon } from "./icons";
import { Terminal, type FontWeight, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

import { api, b64ToBytes, Channel, errorOf, messageOf, type RedactedSession, type SerialConfig, type Settings, type TermOut } from "./api";
import { serialSummary } from "./serial";
import { xtermTheme } from "./themes";
import { aggregate, TabCommandStatus } from "./status";
import { $, alertDialog, confirmDialog, h, modal, promptDialog, showMenu, toast, type MenuEntry } from "./ui";

export type PaneStatus = "connecting" | "connected" | "closed";

export interface Pane {
  uid: number;
  termId: number | null;
  term: Terminal;
  fit: FitAddon;
  el: HTMLElement;
  kind: "local" | "ssh" | "serial";
  title: string;
  shellId?: string;
  session?: RedactedSession;
  serial?: SerialConfig;
  status: PaneStatus;
  tab: Tab;
  disposed: boolean;
  /** Command status for the tab dot (null when switched off). */
  cmd: TabCommandStatus | null;
  /** Last ~4 KB of output with escape codes removed (used to spot a prompt). */
  tail: string;
  decoder: TextDecoder;
  /** Input typed before the backend returned the terminal id. */
  pending: string[];
  /** Reconnect in place after the connection ended (R key). */
  reconnect?: () => void;
  /** Automatic reconnect attempts since the last successful connection. */
  retries?: number;
  /** Title set by the program running in the pane (OSC 0/2). */
  programTitle?: string;
  /** File this pane's output is being logged to. */
  logPath?: string;
  /** Size last given to the shell or server ("cols x rows"). */
  sentSize?: string;
}

/** Turn low-level errors into something a non-technical colleague can act on. */
export function friendlyError(kind: Pane["kind"], raw: string, target = ""): string {
  const m = raw.toLowerCase();
  const has = (...xs: string[]) => xs.some((x) => m.includes(x));
  let nice = "";
  if (kind === "serial") {
    if (has("in use", "access is denied", "busy")) nice = `${target} is already open in another program (PuTTY, MobaXterm or another tab). Close it there and try again.`;
    else if (has("not find", "no such file", "not found", "os error 2")) nice = `${target} isn't there. Check the console cable is plugged in, or pick a different port.`;
  } else if (has("refused", "os error 111", "10061")) nice = `${target} refused the connection. Check the address and port, and that the server is running SSH.`;
  else if (has("timed out", "timeout", "10060")) nice = `${target} didn't answer. Check the address, your network or VPN, and that the device is switched on.`;
  else if (has("lookup", "no such host", "name or service not known", "11001", "nodename nor servname")) nice = `Couldn't find a server called ${target}. Check the spelling of the address.`;
  else if (has("unreachable", "10051", "10065")) nice = `This PC can't reach ${target}. Are you connected to the right network or VPN?`;
  else if (has("authentication failed", "password was rejected")) nice = "Sign-in failed: wrong username or password, or the server doesn't accept this sign-in method.";
  else if (has("reset by peer", "10054", "broken pipe")) nice = `The connection to ${target} was dropped.`;
  return nice ? `${nice}\n(Details: ${raw})` : raw;
}

/** An empty pane made by Split: it shows a picker until something opens in it. */
export interface Slot {
  type: "slot";
  id: number;
  el: HTMLElement;
  tab: Tab;
}
type SplitNode = { type: "leaf"; pane: Pane } | Slot | { type: "split"; dir: "h" | "v"; ratio: number; a: SplitNode; b: SplitNode };

export interface Tab {
  uid: number;
  root: SplitNode;
  focused: Pane;
  el: HTMLElement;
  tabEl: HTMLElement;
  /** Name set with "Rename tab" (otherwise the focused pane's title). */
  customTitle?: string;
  /** A bell rang while the tab was in the background. */
  bell?: boolean;
}

/** A non-terminal tab, such as Settings. */
export interface Page {
  id: string;
  title: string;
  icon: string;
  el: HTMLElement;
}

/** Where a new pane goes: "tab" fills an empty pane of the active tab, else a new tab. */
export type Where = "tab" | "newtab" | "h" | "v";

/** Most panes one tab can hold. */
export const MAX_PANES = 4;

type Listener<T> = (v: T) => void;

let uidSeq = 1;

function slotsOf(n: SplitNode): Slot[] {
  return n.type === "slot" ? [n] : n.type === "leaf" ? [] : [...slotsOf(n.a), ...slotsOf(n.b)];
}

/** Panes plus empty slots: what counts toward MAX_PANES. */
function cellsOf(n: SplitNode): number {
  return n.type === "split" ? cellsOf(n.a) + cellsOf(n.b) : 1;
}

function firstPane(n: SplitNode): Pane | null {
  return n.type === "leaf" ? n.pane : n.type === "slot" ? null : (firstPane(n.a) ?? firstPane(n.b));
}

/** Replace one node (by identity) in the tree. */
function replaceNode(n: SplitNode, target: SplitNode, by: SplitNode): SplitNode {
  if (n === target) return by;
  if (n.type !== "split") return n;
  return { ...n, a: replaceNode(n.a, target, by), b: replaceNode(n.b, target, by) };
}

/** Remove the nodes matching `drop`, collapsing their parent splits. */
function removeNode(n: SplitNode, drop: (x: SplitNode) => boolean): SplitNode | null {
  if (n.type !== "split") return drop(n) ? null : n;
  const a = removeNode(n.a, drop);
  const b = removeNode(n.b, drop);
  if (!a) return b;
  if (!b) return a;
  return { ...n, a, b };
}

function leafOf(n: SplitNode, pane: Pane): SplitNode | null {
  if (n.type === "leaf") return n.pane === pane ? n : null;
  if (n.type === "slot") return null;
  return leafOf(n.a, pane) ?? leafOf(n.b, pane);
}

function panesOf(n: SplitNode): Pane[] {
  return n.type === "leaf" ? [n.pane] : n.type === "slot" ? [] : [...panesOf(n.a), ...panesOf(n.b)];
}

export class TabManager {
  tabs: Tab[] = [];
  active: Tab | null = null;
  settings!: Settings;
  private focusListeners: Listener<Pane | null>[] = [];
  private closeListeners: Listener<Pane>[] = [];
  onConnected: (pane: Pane) => void = () => {};

  constructor(private workspace = $("workspace"), private tabbar = $("tabs")) {}

  // ------------------------------------------------------------ page tabs (Settings)

  /** Non-terminal tabs, such as Settings. */
  pages: Page[] = [];
  activePage: Page | null = null;
  /** Called when the page in front changes (null: a terminal tab is in front). */
  onPageChange: (p: Page | null) => void = () => {};

  /** Open (or switch to) a page tab. `build` runs only when it's created. */
  openPage(id: string, title: string, iconName: string, build: () => HTMLElement): Page {
    let p = this.pages.find((x) => x.id === id);
    if (!p) {
      p = { id, title, icon: iconName, el: h("div", { class: "page-content", "data-page": id }) };
      p.el.append(build());
      this.pages.push(p);
      this.workspace.append(p.el);
    }
    this.activatePage(p);
    return p;
  }

  activatePage(p: Page) {
    this.activePage = p;
    for (const t of this.tabs) t.el.classList.add("hidden");
    for (const x of this.pages) x.el.classList.toggle("hidden", x !== p);
    $("empty").classList.add("hidden");
    this.renderTabs();
    this.onPageChange(p);
  }

  closePage(p: Page) {
    p.el.remove();
    this.pages = this.pages.filter((x) => x !== p);
    if (this.activePage !== p) return this.renderTabs();
    this.activePage = null;
    if (this.active) this.activate(this.active);
    else if (this.pages.length) this.activatePage(this.pages[this.pages.length - 1]);
    else {
      $("empty").classList.toggle("hidden", this.tabs.length > 0);
      this.renderTabs();
      this.onPageChange(null);
    }
  }

  onFocus(l: Listener<Pane | null>) {
    this.focusListeners.push(l);
  }
  private connectedListeners: Listener<Pane>[] = [];
  /** A pane finished connecting. */
  onPaneConnected(l: Listener<Pane>) {
    this.connectedListeners.push(l);
  }
  onPaneClosed(l: Listener<Pane>) {
    this.closeListeners.push(l);
  }
  get focusedPane(): Pane | null {
    return this.active?.focused ?? null;
  }
  allPanes(): Pane[] {
    return this.tabs.flatMap((t) => panesOf(t.root));
  }

  private emitFocus() {
    const p = this.focusedPane;
    this.focusListeners.forEach((l) => l(p));
  }

  theme(): ITheme {
    return xtermTheme(this.settings);
  }

  /** xterm options that come from Settings. */
  private termOptions(s: Settings) {
    return {
      fontFamily: s.fontFamily,
      fontSize: s.fontSize,
      scrollback: s.scrollback,
      theme: this.theme(),
      cursorStyle: s.cursorStyle ?? "block",
      cursorBlink: s.cursorBlink ?? true,
      lineHeight: Math.min(2, Math.max(1, (s.lineHeight || 100) / 100)),
      minimumContrastRatio: s.minContrast ? 4.5 : 1,
      wordSeparator: s.wordSeparators ?? " ()[]{}',\"`",
      fontWeight: (s.fontWeight === "300" || s.fontWeight === "500" ? Number(s.fontWeight) : (s.fontWeight ?? "normal")) as FontWeight,
      fontWeightBold: "bold" as FontWeight,
      letterSpacing: s.letterSpacing ?? 0,
      drawBoldTextInBrightColors: s.boldIsBright ?? true,
      cursorInactiveStyle: s.cursorInactive ?? "outline",
      scrollSensitivity: s.scrollSpeed ?? 1,
      scrollOnUserInput: s.scrollOnInput ?? true,
      tabStopWidth: s.tabStopWidth ?? 8,
    } as const;
  }

  applySettings(s: Settings) {
    this.settings = s;
    for (const p of this.allPanes()) {
      if (!s.tabStatus) p.cmd = null;
      else if (!p.cmd) this.attachStatus(p);
      else p.cmd.fallback = s.tabStatusFallback;
      Object.assign(p.term.options, this.termOptions(s));
      this.refit(p);
    }
  }

  // ------------------------------------------------------------ command status & prompts

  private promptWaiters = new Map<Pane, () => void>();
  private clearTimers = new Map<Pane, number>();

  private attachStatus(pane: Pane) {
    if (!this.settings?.tabStatus) return;
    pane.cmd = new TabCommandStatus((state) => {
      // A command finished in a tab you're not looking at.
      if ((state === "success" || state === "error") && this.settings?.notifyBackground && (pane.tab !== this.active || this.activePage)) {
        const name = pane.tab.customTitle ?? pane.title;
        toast(state === "success" ? `Command finished in "${name}".` : `Command failed in "${name}".`, state === "success" ? "ok" : "error", 5000);
      }
      // On the tab you're looking at, show the result briefly; background tabs keep it until opened.
      if ((state === "success" || state === "error") && this.active === pane.tab) {
        window.clearTimeout(this.clearTimers.get(pane));
        this.clearTimers.set(pane, window.setTimeout(() => pane.cmd?.clearNotification(), 4000));
      }
      this.scheduleTabs();
    }, this.settings.tabStatusFallback);
  }

  /** Called for text a macro sends, so the tab dot also tracks macro commands. */
  noteInput(pane: Pane, text: string) {
    pane.cmd?.input(text);
  }

  private observeOutput(pane: Pane, text: string) {
    if (!text) return;
    pane.cmd?.output(text);
    // eslint-disable-next-line no-control-regex
    const clean = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
    pane.tail = (pane.tail + clean).slice(-4096);
    this.promptWaiters.get(pane)?.();
  }

  /** Resolve true once the pane shows a ready prompt ($ # > % ❯), false on timeout or close. */
  waitForPrompt(pane: Pane, timeoutMs: number): Promise<boolean> {
    const ready = () => /[$#>%❯]\s*$/.test(pane.tail);
    if (ready()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (v: boolean) => {
        window.clearTimeout(timer);
        window.clearInterval(poll);
        this.promptWaiters.delete(pane);
        resolve(v);
      };
      const timer = window.setTimeout(() => done(false), timeoutMs);
      const poll = window.setInterval(() => (pane.disposed || pane.status === "closed") && done(false), 250);
      this.promptWaiters.set(pane, () => ready() && done(true));
    });
  }

  private tabsTimer: number | null = null;
  private scheduleTabs() {
    if (this.tabsTimer !== null) return;
    this.tabsTimer = window.setTimeout(() => {
      this.tabsTimer = null;
      this.renderTabs();
    }, 40);
  }

  // ------------------------------------------------------------ pane creation

  private makePane(kind: Pane["kind"], title: string, tab: Tab | null): Pane {
    const s = this.settings;
    const term = new Terminal({
      ...this.termOptions(s),
      allowProposedApi: false,
      macOptionIsMeta: true,
      rightClickSelectsWord: false,
      // Links printed by a program or server (OSC 8) are never opened: Siakap
      // makes no web requests. Show the address so it can be copied instead.
      linkHandler: { activate: (_e: MouseEvent, uri: string) => void showLink(uri), allowNonHttpProtocols: false },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const el = h("div", { class: "pane" });
    const pane: Pane = { uid: uidSeq++, termId: null, term, fit, el, kind, title, status: "connecting", tab: tab as Tab, disposed: false, pending: [], cmd: null, tail: "", decoder: new TextDecoder() };
    this.attachStatus(pane);

    term.open(el);
    term.attachCustomKeyEventHandler((e) => this.keyHandler(pane, e));
    term.onData((d) => {
      if (pane.termId !== null && pane.status === "connected") {
        api.termWrite(pane.termId, d).catch(() => {});
        pane.cmd?.input(d);
      } else if (pane.status === "connecting") {
        // Output can arrive before the open call returns; keep keystrokes.
        if (pane.pending.length < 256) pane.pending.push(d);
      } else if (pane.status === "closed" && d === "\r") {
        this.closePane(pane);
      } else if (pane.status === "closed" && (d === "r" || d === "R") && pane.reconnect) {
        this.reconnectPane(pane);
      }
    });
    term.onBell(() => this.bell(pane));
    term.onTitleChange((t) => {
      pane.programTitle = t.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 80) || undefined;
      if (this.settings?.programTitles) this.scheduleTabs();
    });
    term.onSelectionChange(() => {
      if (this.settings.copyOnSelect && term.hasSelection()) api.clipboardWrite(this.copyText(term.getSelection())).catch(() => {});
    });
    // Paste protection: intercept the browser paste before xterm sees it.
    el.addEventListener(
      "paste",
      (e) => {
        e.preventDefault();
        e.stopImmediatePropagation();
        const text = e.clipboardData?.getData("text/plain") ?? "";
        void this.guardedPaste(pane, text);
      },
      true,
    );
    el.addEventListener("focusin", () => this.focus(pane));
    el.addEventListener("mousedown", () => this.focus(pane));
    el.addEventListener("contextmenu", (e) => this.paneMenu(pane, e), true);
    const closeBtn = h("button", { class: "pane-close", title: "Close this pane (Ctrl+Shift+W)" }, icon("x", 13));
    closeBtn.addEventListener("mousedown", (e) => e.stopPropagation());
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.closePane(pane);
    });
    el.append(closeBtn);
    new ResizeObserver(() => this.refit(pane)).observe(el);
    return pane;
  }

  /** Terminal bell: flash the pane; mark the tab if it isn't in front. */
  private bell(pane: Pane) {
    if (this.settings?.bell === "off") return;
    pane.el.classList.remove("bell");
    void pane.el.offsetWidth; // restart the animation
    pane.el.classList.add("bell");
    window.setTimeout(() => pane.el.classList.remove("bell"), 400);
    if (pane.tab !== this.active || this.activePage) {
      pane.tab.tabEl.classList.add("tab-bell");
      pane.tab.bell = true;
    }
  }

  /** Right-click inside a terminal. */
  private paneMenu(pane: Pane, e: MouseEvent) {
    const sel = pane.term.hasSelection() ? pane.term.getSelection() : "";
    if (this.settings?.rightClickPaste && !e.shiftKey) {
      // Like Windows Terminal and PuTTY: copy a selection, otherwise paste.
      e.preventDefault();
      e.stopPropagation();
      this.focus(pane);
      if (sel) {
        void api.clipboardWrite(this.copyText(sel)).then(() => toast("Copied.", "ok", 1200), () => toast("Clipboard is not available.", "error"));
        pane.term.clearSelection();
      } else if (pane.status !== "closed") {
        api.clipboardRead().then((t) => this.guardedPaste(pane, t), () => toast("Clipboard is not available.", "error"));
      }
      return;
    }
    const count = cellsOf(pane.tab.root);
    const canSplit = count < MAX_PANES;
    const entries: MenuEntry[] = [
      { label: "Copy", disabled: !sel, action: () => api.clipboardWrite(this.copyText(sel)) },
      {
        label: "Paste",
        disabled: pane.status === "closed",
        action: () => api.clipboardRead().then((t) => this.guardedPaste(pane, t), () => toast("Clipboard is not available.", "error")),
      },
      { label: "Select all", action: () => pane.term.selectAll() },
      { label: "Clear screen", action: () => pane.term.clear() },
      { label: "Save output to file...", action: () => this.saveOutput(pane) },
      pane.logPath
        ? { label: "Stop logging to file", action: () => this.stopLog(pane) }
        : { label: "Log to file...", disabled: pane.termId === null || pane.status !== "connected", action: () => this.startLog(pane) },
      { label: "Split side by side", disabled: !canSplit, action: () => this.splitEmpty(pane, "h") },
      { label: "Split top and bottom", disabled: !canSplit, action: () => this.splitEmpty(pane, "v") },
      ...(pane.status === "closed" && pane.reconnect ? [{ label: "Reconnect", action: () => this.reconnectPane(pane) }] : []),
      count > 1
        ? { label: "Close this pane", danger: true, action: () => this.closePane(pane) }
        : { label: "Close tab", danger: true, action: () => this.closeTab(pane.tab) },
    ];
    showMenu(e, entries);
  }

  // ------------------------------------------------------------ saving output and logs

  /** Everything in the terminal (scrollback included) as plain text. */
  private bufferText(pane: Pane): string {
    const b = pane.term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < b.length; i++) {
      const line = b.getLine(i);
      if (!line) continue;
      const text = line.translateToString(true);
      if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
      else lines.push(text);
    }
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    return lines.join("\n") + "\n";
  }

  private fileBase(pane: Pane) {
    const name = (pane.tab.customTitle ?? pane.title).replace(/[^\w.@]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 60) || "session";
    return `${name}_${stamp()}`;
  }

  async saveOutput(pane: Pane) {
    try {
      const path = await api.pickSave("text", `${this.fileBase(pane)}.txt`);
      if (!path) return;
      await api.saveTextFile(path, this.bufferText(pane));
      toast(`Saved to ${path}`, "ok");
    } catch (e) {
      toast(messageOf(e), "error");
    }
  }

  async startLog(pane: Pane) {
    if (pane.termId === null) return;
    try {
      const path = await api.pickSave("log", `${this.fileBase(pane)}.log`);
      if (!path || pane.termId === null) return;
      pane.logPath = await api.termLogStart(pane.termId, path, pane.title);
      this.showLogging(pane);
      toast(`Logging to ${pane.logPath}`, "ok");
    } catch (e) {
      toast(messageOf(e), "error");
    }
  }

  async stopLog(pane: Pane) {
    const path = pane.logPath;
    pane.logPath = undefined;
    this.showLogging(pane);
    if (pane.termId !== null) await api.termLogStop(pane.termId).catch(() => {});
    if (path) toast(`Stopped logging. The log is in ${path}`, "info", 6000);
  }

  /** Automatic logging (Settings): start a log in the chosen folder. */
  private autoLog(pane: Pane) {
    const s = this.settings;
    if (!s?.logAuto || !s.logDir || pane.termId === null) return;
    api
      .termLogAuto(pane.termId, pane.title, stamp())
      .then((p) => {
        pane.logPath = p;
        this.showLogging(pane);
      })
      .catch((e) => toast(`Couldn't start the session log: ${messageOf(e)}`, "error"));
  }

  private showLogging(pane: Pane) {
    pane.el.querySelector(".pane-rec")?.remove();
    if (pane.logPath) pane.el.append(h("span", { class: "pane-rec", title: `Logging to ${pane.logPath}` }, "REC"));
    this.renderTabs();
  }

  private reconnectPane(pane: Pane) {
    if (pane.status !== "closed" || !pane.reconnect || pane.disposed) return;
    pane.status = "connecting";
    pane.termId = null;
    pane.term.write("\r\n");
    this.renderTabs();
    pane.reconnect();
  }

  private keyHandler(pane: Pane, e: KeyboardEvent): boolean {
    if (e.type !== "keydown") return true;
    const ctrlShift = e.ctrlKey && e.shiftKey && !e.altKey;
    if (ctrlShift && e.code === "KeyC") {
      if (pane.term.hasSelection()) api.clipboardWrite(this.copyText(pane.term.getSelection())).catch(() => {});
      e.preventDefault();
      return false;
    }
    if (ctrlShift && e.code === "KeyV") {
      e.preventDefault();
      api.clipboardRead().then((t) => this.guardedPaste(pane, t), () => toast("Clipboard is not available.", "error"));
      return false;
    }
    // Let app shortcuts bubble to the window handler.
    if (ctrlShift && e.code === "KeyB" && pane.kind === "serial") {
      e.preventDefault();
      void this.sendBreak(pane);
      return false;
    }
    if (ctrlShift && ["KeyT", "KeyD", "KeyE", "KeyG", "KeyW"].includes(e.code)) return false;
    if (e.ctrlKey && e.code === "Tab") return false;
    return true;
  }

  /** Selected text as copied: optionally without spaces at line ends. */
  copyText(sel: string): string {
    return this.settings?.trimCopyWhitespace === false ? sel : sel.replace(/[ \t]+$/gm, "");
  }

  async guardedPaste(pane: Pane, text: string) {
    if (!text || pane.status === "closed") return;
    // A single line copied with its line break would run at once: drop the break.
    if (this.settings?.trimPasteNewline !== false && /^[^\r\n]*(\r?\n)+$/.test(text)) text = text.replace(/(\r?\n)+$/, "");
    if (this.settings.confirmMultilinePaste && /[\r\n]/.test(text)) {
      const lines = text.split(/\r\n|\r|\n/);
      const preview = h("pre", { class: "paste-preview" }, lines.slice(0, 30).join("\n") + (lines.length > 30 ? `\n... and ${lines.length - 30} more lines` : ""));
      const ok = await confirmDialog(
        "Paste multiple lines?",
        h("div", {}, h("p", {}, `The clipboard contains ${lines.length} lines. Each line break may run a command.`), preview),
        "Paste",
        { danger: true },
      );
      if (!ok) return;
    }
    pane.term.paste(text);
    pane.term.focus();
  }

  /**
   * Fit the terminal to its pane and tell the shell or server whenever the
   * size differs from what it was last told. Comparing with the size last
   * *sent* (not the size before this fit) matters: a fit that happens while
   * the connection is still opening must still be sent once it is open.
   */
  private refit(p: Pane) {
    if (p.disposed || !p.el.isConnected || p.el.clientWidth === 0) return;
    try {
      p.fit.fit();
    } catch {
      return;
    }
    const size = `${p.term.cols}x${p.term.rows}`;
    if (p.termId !== null && p.sentSize !== size) {
      p.sentSize = size;
      api.termResize(p.termId, p.term.cols, p.term.rows).catch(() => {});
    }
  }

  /** Measure the pane now, so a new shell or server starts at the right size. */
  private sizeForOpen(p: Pane): [number, number] {
    this.refit(p);
    p.sentSize = `${p.term.cols}x${p.term.rows}`;
    return [p.term.cols, p.term.rows];
  }

  private wireChannel(pane: Pane): Channel<TermOut> {
    const ch = new Channel<TermOut>();
    ch.onmessage = (m) => {
      if (pane.disposed) return;
      if (m.kind === "data") {
        const bytes = b64ToBytes(m.b64);
        pane.term.write(bytes);
        this.observeOutput(pane, pane.decoder.decode(bytes, { stream: true }));
      } else {
        pane.status = "closed";
        pane.cmd?.closed();
        pane.term.write(`\r\n\x1b[2m[${pane.kind === "ssh" ? "connection closed" : pane.kind === "serial" ? "port closed" : "process exited"}${m.code !== null ? ` with code ${m.code}` : ""}. Press R to reconnect or Enter to close.]\x1b[0m\r\n`);
        this.renderTabs();
        this.closeListeners.forEach((l) => l(pane));
        // A dropped SSH connection (no exit code, so not a normal "exit"): try again.
        if (pane.kind === "ssh" && m.code === null && this.settings?.autoReconnect && pane.reconnect && (pane.retries ?? 0) < 3) {
          pane.retries = (pane.retries ?? 0) + 1;
          pane.term.write(`\x1b[2m[Reconnecting in 3 seconds (try ${pane.retries} of 3)...]\x1b[0m\r\n`);
          window.setTimeout(() => {
            if (!pane.disposed && pane.status === "closed") this.reconnectPane(pane);
          }, 3000);
        }
      }
    };
    return ch;
  }

  // ------------------------------------------------------------ open

  /** Open a serial console. Each port can only be open once. */
  async openSerial(config: SerialConfig, title?: string, where: Where = "tab", session?: RedactedSession) {
    const pane = this.place(this.makePane("serial", title || config.port, null), where);
    pane.serial = config;
    pane.session = session; // enables its post-connect macro
    pane.reconnect = () => void this.connectSerial(pane);
    await this.connectSerial(pane);
  }

  private async connectSerial(pane: Pane) {
    const config = pane.serial!;
    pane.term.write(`\x1b[2mOpening ${serialSummary(config)}... \x1b[0m\r\n\x1b[2mPress Enter if nothing appears. Ctrl+Shift+B sends a break.\x1b[0m\r\n`);
    try {
      pane.termId = await api.termOpenSerial(config, this.wireChannel(pane));
      this.markConnected(pane);
    } catch (e) {
      this.failPane(pane, friendlyError("serial", errorOf(e).message, config.port));
    }
  }

  async sendBreak(pane = this.focusedPane) {
    if (!pane || pane.kind !== "serial" || pane.termId === null || pane.status !== "connected") return;
    try {
      await api.termSerialBreak(pane.termId);
      toast("Break sent.", "ok", 1500);
    } catch (e) {
      toast(messageOf(e), "error");
    }
  }

  async openLocal(shellId: string, label: string, where: Where = "tab", session?: RedactedSession) {
    const pane = this.place(this.makePane("local", label, null), where);
    pane.shellId = shellId;
    pane.session = session; // enables its startup commands
    pane.reconnect = () => void this.connectLocal(pane);
    await this.connectLocal(pane);
  }

  private async connectLocal(pane: Pane) {
    try {
      const [cols, rows] = this.sizeForOpen(pane);
      pane.termId = await api.termOpenLocal(pane.shellId ?? "", cols, rows, this.wireChannel(pane));
      this.markConnected(pane);
    } catch (e) {
      this.failPane(pane, errorOf(e).message);
    }
  }

  async openSsh(session: RedactedSession, where: Where = "tab") {
    const pane = this.place(this.makePane("ssh", session.name, null), where);
    pane.session = session;
    pane.reconnect = () => void this.connectSsh(pane);
    await this.connectSsh(pane);
  }

  private async connectSsh(pane: Pane) {
    const session = pane.session!;
    const target = session.port && session.port !== 22 ? `${session.host}:${session.port}` : session.host;
    pane.term.write(`\x1b[2mConnecting to ${session.user}@${target}...\x1b[0m\r\n`);
    let password: string | undefined;
    let passphrase: string | undefined;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const [cols, rows] = this.sizeForOpen(pane);
        pane.termId = await api.termOpenSsh(session.id, cols, rows, this.wireChannel(pane), password, passphrase);
        password = passphrase = undefined;
        this.markConnected(pane);
        return;
      } catch (raw) {
        const e = errorOf(raw);
        if (pane.disposed) return;
        if (e.kind === "hostKeyUnknown") {
          if (await this.askTrust(e.host!, e.port!, e.keyType!, e.fingerprint!)) {
            try {
              await api.trustHostKey(e.host!, e.port!, e.fingerprint!, e.publicKey!);
              continue;
            } catch (e2) {
              this.failPane(pane, errorOf(e2).message);
              return;
            }
          }
          this.failPane(pane, "Host key not trusted; connection aborted.");
          return;
        }
        if (e.kind === "hostKeyChanged") {
          this.failPane(pane, e.message, true);
          await modal<void>(
            "Host key changed: possible man-in-the-middle attack",
            (close) => ({
              body: h(
                "div",
                {},
                h("p", {}, h("strong", {}, "Don't continue. This server's identity has changed since you last connected. Contact your IT team before trying again.")),
                h("p", { class: "pre muted small" }, e.message),
                h("dl", { class: "kv" }, h("dt", {}, "Stored"), h("dd", { class: "mono" }, e.knownFingerprint ?? ""), h("dt", {}, "Presented"), h("dd", { class: "mono" }, `${e.fingerprint} (${e.keyType})`)),
              ),
              actions: [h("button", { class: "danger", onclick: () => close() }, "Close")],
            }),
            { danger: true },
          );
          return;
        }
        if (e.kind === "passwordRequired") {
          const pw = await promptDialog("Password", e.message, { password: true });
          if (pw === null) return this.failPane(pane, "Cancelled.");
          password = pw;
          continue;
        }
        if (e.kind === "passphraseRequired") {
          const pp = await promptDialog("Key passphrase", `Passphrase for ${session.keyPath}`, { password: true });
          if (pp === null) return this.failPane(pane, "Cancelled.");
          passphrase = pp;
          continue;
        }
        if (e.kind === "auth" && session.auth !== "key" && session.auth !== "agent") {
          const pw = await promptDialog(
            "Sign-in failed",
            `The username or password wasn't accepted. Enter the password for ${session.user}@${session.host} to try again.`,
            { password: true, okLabel: "Try again" },
          );
          if (pw === null) return this.failPane(pane, "Cancelled.");
          password = pw;
          continue;
        }
        this.failPane(pane, friendlyError("ssh", e.message, target));
        return;
      }
    }
    this.failPane(pane, "Too many attempts.");
  }

  private askTrust(host: string, port: number, keyType: string, fp: string): Promise<boolean> {
    return modal<boolean>(
      "First connection to this server",
      (close) => ({
        body: h(
          "div",
          {},
          h("p", {}, `You haven't connected to ${host}${port !== 22 ? `:${port}` : ""} before, so Siakap can't be sure it's the right server yet.`),
          h("dl", { class: "kv" }, h("dt", {}, "Key type"), h("dd", {}, keyType), h("dt", {}, "Fingerprint"), h("dd", { class: "mono" }, fp)),
          h("p", { class: "muted" }, "If you have the server's fingerprint from your IT team, check it matches. On a trusted network, connecting to a server for the first time is normally fine. Siakap will remember it and warn you loudly if it ever changes."),
        ),
        actions: [h("button", { onclick: () => close(false) }, "Cancel"), h("button", { class: "primary", onclick: () => close(true) }, "Trust and connect")],
      }),
      { dismissValue: false },
    );
  }

  private markConnected(pane: Pane) {
    pane.status = "connected";
    pane.retries = 0;
    const queued = pane.pending.join("");
    pane.pending = [];
    if (queued && pane.termId !== null) api.termWrite(pane.termId, queued).catch(() => {});
    this.refit(pane);
    this.renderTabs();
    // A reconnect is a new terminal: a manual log ended with the old one.
    if (pane.logPath) {
      pane.logPath = undefined;
      this.showLogging(pane);
    }
    this.autoLog(pane);
    this.connectedListeners.forEach((l) => l(pane));
    this.onConnected(pane);
  }

  private failPane(pane: Pane, msg: string, danger = false) {
    pane.status = "closed";
    pane.pending = [];
    const [main, details] = msg.split("\n(Details: ");
    const hint = pane.reconnect && !danger ? "Press R to try again or Enter to close." : "Press Enter to close.";
    pane.term.write(
      `\r\n\x1b[${danger ? "1;31" : "31"}m${main.replace(/\n/g, "\r\n")}\x1b[0m\r\n` +
        (details ? `\x1b[2mDetails: ${details.replace(/\)$/, "").replace(/\n/g, "\r\n")}\x1b[0m\r\n` : "") +
        `\x1b[2m[${hint}]\x1b[0m\r\n`,
    );
    this.renderTabs();
  }

  // ------------------------------------------------------------ layout

  private place(pane: Pane, where: Where): Pane {
    // A split tab with an empty pane: open there instead of in a new tab.
    if (where === "tab" && this.active) {
      const slots = slotsOf(this.active.root);
      const slot = slots.find((s) => s === this.targetSlot) ?? slots[0];
      if (slot) return this.fillSlot(slot, pane);
    }
    if (where === "newtab") where = "tab";
    const target = this.focusedPane;
    if (where !== "tab" && target && cellsOf(target.tab.root) >= MAX_PANES) {
      toast(`A tab holds up to ${MAX_PANES} panes, so this opened in a new tab.`, "info");
      where = "tab";
    }
    if (where === "tab" || !target) {
      const tab: Tab = {
        uid: uidSeq++,
        root: { type: "leaf", pane },
        focused: pane,
        el: h("div", { class: "tab-content" }),
        tabEl: h("div", { class: "tab" }),
      };
      pane.tab = tab;
      const at = this.settings?.newTabPosition === "next" && this.active ? this.tabs.indexOf(this.active) + 1 : this.tabs.length;
      this.tabs.splice(at, 0, tab);
      this.workspace.append(tab.el);
      this.activate(tab);
    } else {
      const tab = target.tab;
      pane.tab = tab;
      const leaf = leafOf(tab.root, target)!;
      tab.root = replaceNode(tab.root, leaf, { type: "split", dir: where, ratio: 0.5, a: leaf, b: { type: "leaf", pane } });
      tab.focused = pane;
      this.renderTab(tab);
    }
    this.renderTabs();
    requestAnimationFrame(() => {
      this.refit(pane);
      pane.term.focus();
    });
    return pane;
  }

  // ------------------------------------------------------------ empty panes

  /** The empty pane that the next opened session fills (if it is in the active tab). */
  targetSlot: Slot | null = null;
  /** Builds the picker shown in an empty pane (set by main.ts). */
  slotContent: (slot: Slot) => HTMLElement = () => h("div");

  private makeSlot(tab: Tab): Slot {
    const slot: Slot = { type: "slot", id: uidSeq++, el: h("div", { class: "pane pane-slot", tabindex: 0 }), tab };
    slot.el.addEventListener("mousedown", () => this.selectSlot(slot));
    slot.el.addEventListener("focusin", () => this.selectSlot(slot));
    return slot;
  }

  private selectSlot(slot: Slot) {
    this.targetSlot = slot;
    slot.tab.el.querySelectorAll(".pane-slot").forEach((el) => el.classList.toggle("target", el === slot.el));
  }

  private refreshSlot(slot: Slot) {
    // Don't rebuild under the user's cursor (e.g. while typing in its search box).
    const a = document.activeElement;
    if (a && a !== slot.el && slot.el.contains(a) && a.tagName === "INPUT") return;
    slot.el.replaceChildren(this.slotContent(slot));
  }

  /** Rebuild every picker (open tabs and sessions may have changed). */
  refreshSlots() {
    for (const t of this.tabs) for (const s of slotsOf(t.root)) this.refreshSlot(s);
  }

  private fillSlot(slot: Slot, pane: Pane): Pane {
    const tab = slot.tab;
    tab.root = replaceNode(tab.root, slot, { type: "leaf", pane });
    pane.tab = tab;
    tab.focused = pane;
    slot.el.remove();
    this.targetSlot = slotsOf(tab.root)[0] ?? null;
    if (this.active !== tab) this.activate(tab);
    this.renderTab(tab);
    this.renderTabs();
    this.emitFocus();
    requestAnimationFrame(() => {
      this.refit(pane);
      pane.term.focus();
    });
    return pane;
  }

  /** Move an open pane (from any tab) into an empty pane. */
  movePane(pane: Pane, slot: Slot) {
    const src = pane.tab;
    const dst = slot.tab;
    const leaf = leafOf(src.root, pane);
    if (!leaf || pane.disposed) return;
    const rest = removeNode(src.root, (n) => n === leaf);
    if (src !== dst) {
      if (!rest || !firstPane(rest)) {
        // The tab it came from is now empty (or only empty panes): drop it.
        this.tabs = this.tabs.filter((t) => t !== src);
        src.el.remove();
      } else {
        src.root = rest;
        if (src.focused === pane) src.focused = firstPane(rest)!;
        this.renderTab(src);
      }
    } else if (rest) {
      dst.root = rest;
    }
    this.fillSlot(slot, pane);
  }

  /** Close an empty pane. */
  removeSlot(slot: Slot) {
    const tab = slot.tab;
    const rest = removeNode(tab.root, (n) => n === slot);
    slot.el.remove();
    if (this.targetSlot === slot) this.targetSlot = null;
    if (!rest || !firstPane(rest)) return;
    tab.root = rest;
    this.renderTab(tab);
    this.renderTabs();
    if (this.active === tab) requestAnimationFrame(() => tab.focused.term.focus());
  }

  /** Put an empty pane next to `pane`. */
  splitEmpty(pane: Pane, dir: "h" | "v") {
    const tab = pane.tab;
    if (cellsOf(tab.root) >= MAX_PANES) return toast(`A tab holds up to ${MAX_PANES} panes.`, "info");
    const leaf = leafOf(tab.root, pane);
    if (!leaf) return;
    const slot = this.makeSlot(tab);
    tab.root = replaceNode(tab.root, leaf, { type: "split", dir, ratio: 0.5, a: leaf, b: slot });
    this.renderTab(tab);
    this.renderTabs();
    this.selectSlot(slot);
  }

  /**
   * The toolbar layouts (side by side, top and bottom, 4 panes). They add
   * empty panes where you pick what to show: an open tab, a terminal or a
   * saved session. They only split a tab that has one pane, so clicking
   * again does nothing.
   */
  layout(kind: "h" | "v" | "grid"): boolean {
    const p = this.focusedPane;
    if (!p) return false;
    const tab = p.tab;
    if (cellsOf(tab.root) > 1) {
      toast("This tab is already split. To change it, close a pane (right-click it, or the x in its corner).", "info");
      return true;
    }
    if (kind !== "grid") {
      this.splitEmpty(p, kind);
      return true;
    }
    const leaf = tab.root;
    const [s1, s2, s3] = [this.makeSlot(tab), this.makeSlot(tab), this.makeSlot(tab)];
    tab.root = {
      type: "split",
      dir: "h",
      ratio: 0.5,
      a: { type: "split", dir: "v", ratio: 0.5, a: leaf, b: s2 },
      b: { type: "split", dir: "v", ratio: 0.5, a: s1, b: s3 },
    };
    this.renderTab(tab);
    this.renderTabs();
    this.selectSlot(s1);
    return true;
  }

  /** Open the focused tab's shell or session again, in a new tab. */
  duplicateTab(tab: Tab) {
    const p = tab.focused;
    if (p.kind === "serial") return toast("A serial port can only be open once.", "error");
    this.activate(tab);
    if (p.kind === "ssh" && p.session) void this.openSsh(p.session, "newtab");
    else void this.openLocal(p.shellId ?? "", p.title, "newtab", p.session);
  }

  splitFocused(dir: "h" | "v") {
    const p = this.focusedPane;
    if (!p) return;
    if (cellsOf(p.tab.root) >= MAX_PANES) {
      toast(`A tab holds up to ${MAX_PANES} panes.`, "info");
      return;
    }
    if (p.kind === "serial") {
      toast("A serial port can only be open in one pane at a time.", "error");
      return;
    }
    if (p.kind === "ssh" && p.session) void this.openSsh(p.session, dir);
    else void this.openLocal(p.shellId ?? "", p.title, dir);
  }

  /** Turn the focused pane into a 2×2 grid of the same shell or session. */
  splitGrid() {
    const topLeft = this.focusedPane;
    if (!topLeft) return;
    if (topLeft.kind === "serial") {
      toast("A serial port can only be open in one pane at a time.", "error");
      return;
    }
    this.splitFocused("h"); // panes are placed synchronously, so focus is already on the new one
    const topRight = this.focusedPane;
    this.focus(topLeft);
    this.splitFocused("v");
    if (topRight && topRight !== topLeft) {
      this.focus(topRight);
      this.splitFocused("v");
    }
    this.focus(topLeft);
    requestAnimationFrame(() => topLeft.term.focus());
  }

  focus(pane: Pane) {
    if (pane.disposed) return;
    const changed = this.active !== pane.tab || pane.tab.focused !== pane;
    pane.tab.focused = pane;
    if (this.active !== pane.tab) this.activate(pane.tab);
    pane.tab.el.querySelectorAll(".pane").forEach((el) => el.classList.toggle("focused", el === pane.el));
    if (changed) {
      this.renderTabs();
      this.emitFocus();
    }
  }

  activate(tab: Tab) {
    // Opening a tab means its command results have been seen.
    for (const p of panesOf(tab.root)) {
      const st = p.cmd?.state;
      if (st === "success" || st === "error") {
        window.clearTimeout(this.clearTimers.get(p));
        this.clearTimers.set(p, window.setTimeout(() => p.cmd?.clearNotification(), 4000));
      }
    }
    this.active = tab;
    tab.bell = false;
    const hadPage = !!this.activePage;
    this.activePage = null;
    if (hadPage) this.onPageChange(null);
    for (const x of this.pages) x.el.classList.add("hidden");
    for (const t of this.tabs) t.el.classList.toggle("hidden", t !== tab);
    $("empty").classList.toggle("hidden", this.tabs.length > 0);
    this.renderTab(tab);
    this.renderTabs();
    requestAnimationFrame(() => tab.focused.term.focus());
    this.emitFocus();
  }

  cycle(delta: number) {
    if (!this.active || this.tabs.length < 2) return;
    const i = this.tabs.indexOf(this.active);
    this.activate(this.tabs[(i + delta + this.tabs.length) % this.tabs.length]);
  }

  async closePane(pane: Pane) {
    if (pane.disposed) return;
    pane.disposed = true;
    if (pane.termId !== null) api.termClose(pane.termId).catch(() => {});
    pane.status = "closed";
    this.closeListeners.forEach((l) => l(pane));
    pane.term.dispose();
    pane.el.remove();
    const tab = pane.tab;
    const root = removeNode(tab.root, (n) => n.type === "leaf" && n.pane === pane);
    if (!root || !firstPane(root)) {
      // Last real pane gone: the tab closes, empty panes included.
      if (this.targetSlot?.tab === tab) this.targetSlot = null;
      this.tabs = this.tabs.filter((t) => t !== tab);
      tab.el.remove();
      if (this.active === tab) {
        this.active = null;
        if (this.activePage) {
          // A page (Settings) is in front: keep it there.
          if (this.tabs.length) this.active = this.tabs[this.tabs.length - 1];
          this.emitFocus();
        } else if (this.tabs.length) this.activate(this.tabs[this.tabs.length - 1]);
        else {
          $("empty").classList.remove("hidden");
          this.emitFocus();
        }
      }
      this.renderTabs();
      return;
    }
    tab.root = root;
    if (tab.focused === pane) tab.focused = firstPane(root)!;
    this.renderTab(tab);
    this.renderTabs();
    if (this.active === tab) {
      this.emitFocus();
      requestAnimationFrame(() => tab.focused.term.focus());
    }
  }

  async closeTab(tab: Tab) {
    const panes = panesOf(tab.root);
    const live = panes.filter((p) => p.status === "connected").length;
    if (live > 1 && this.settings?.confirmCloseTab !== false && !(await confirmDialog("Close tab?", `This tab has ${live} open sessions.`, "Close all"))) return;
    for (const p of panes) await this.closePane(p);
  }

  async closeAll() {
    for (const p of this.allPanes()) await this.closePane(p);
  }

  private renderTab(tab: Tab) {
    const build = (n: SplitNode): HTMLElement => {
      if (n.type === "slot") {
        this.refreshSlot(n);
        return n.el;
      }
      if (n.type === "leaf") {
        n.pane.el.classList.toggle("focused", n.pane === tab.focused);
        return n.pane.el;
      }
      const a = build(n.a);
      const b = build(n.b);
      const wrapA = h("div", { class: "split-child" });
      const wrapB = h("div", { class: "split-child" });
      wrapA.append(a);
      wrapB.append(b);
      wrapA.style.flex = `${n.ratio} 1 0`;
      wrapB.style.flex = `${1 - n.ratio} 1 0`;
      const div = h("div", { class: `divider ${n.dir}` });
      const box = h("div", { class: `split ${n.dir}` }, wrapA, div, wrapB);
      div.addEventListener("pointerdown", (e) => {
        div.setPointerCapture(e.pointerId);
        const rect = box.getBoundingClientRect();
        const move = (ev: PointerEvent) => {
          const r = n.dir === "h" ? (ev.clientX - rect.left) / rect.width : (ev.clientY - rect.top) / rect.height;
          n.ratio = Math.min(0.9, Math.max(0.1, r));
          wrapA.style.flex = `${n.ratio} 1 0`;
          wrapB.style.flex = `${1 - n.ratio} 1 0`;
        };
        const up = () => {
          div.removeEventListener("pointermove", move);
          div.removeEventListener("pointerup", up);
        };
        div.addEventListener("pointermove", move);
        div.addEventListener("pointerup", up);
      });
      return box;
    };
    tab.el.replaceChildren(build(tab.root));
    tab.el.classList.toggle("multi", cellsOf(tab.root) > 1);
  }

  private tabMenu(t: Tab, e: MouseEvent) {
    const i = this.tabs.indexOf(t);
    const others = this.tabs.filter((x) => x !== t);
    const right = this.tabs.slice(i + 1);
    const closed = panesOf(t.root).filter((p) => p.status === "closed" && p.reconnect);
    showMenu(e, [
      { label: "Rename tab...", action: () => this.renameTab(t) },
      { label: "Save output to file...", action: () => this.saveOutput(t.focused) },
      t.focused.logPath
        ? { label: "Stop logging to file", action: () => this.stopLog(t.focused) }
        : { label: "Log to file...", disabled: t.focused.status !== "connected", action: () => this.startLog(t.focused) },
      { label: "Duplicate tab", disabled: t.focused.kind === "serial", action: () => this.duplicateTab(t) },
      ...(closed.length ? [{ label: "Reconnect", action: () => closed.forEach((p) => this.reconnectPane(p)) }] : []),
      { label: "Close tab", danger: true, action: () => this.closeTab(t) },
      { label: "Close other tabs", disabled: !others.length, action: () => this.closeTabs(others) },
      { label: "Close tabs to the right", disabled: !right.length, action: () => this.closeTabs(right) },
    ]);
  }

  private async renameTab(t: Tab) {
    const name = await promptDialog("Rename tab", "Tab name (leave empty to use the session name)", { value: t.customTitle ?? t.focused.title, okLabel: "Rename" });
    if (name === null) return;
    t.customTitle = name.trim().slice(0, 80) || undefined;
    this.renderTabs();
  }

  private async closeTabs(list: Tab[]) {
    const live = list.flatMap((t) => panesOf(t.root)).filter((p) => p.status === "connected").length;
    if (live > 1 && !(await confirmDialog("Close tabs?", `${list.length} tabs with ${live} open sessions will close.`, "Close"))) return;
    for (const t of list) for (const p of panesOf(t.root)) await this.closePane(p);
  }

  /** Drag a tab sideways to move it. */
  private bindTabDrag(el: HTMLElement) {
    el.addEventListener("pointerdown", (down) => {
      if (down.button !== 0 || (down.target as HTMLElement).closest("button")) return;
      const sx = down.clientX;
      const els = ([...this.tabbar.children] as HTMLElement[]).filter((x) => !x.classList.contains("page-tab"));
      const rects = els.map((x) => x.getBoundingClientRect());
      const from = els.indexOf(el);
      let active = false;
      let to = from;
      const move = (e: PointerEvent) => {
        const dx = e.clientX - sx;
        if (!active) {
          if (Math.abs(dx) < 6) return;
          active = true;
          el.setPointerCapture(e.pointerId);
          el.classList.add("tab-dragging");
          document.body.classList.add("is-dragging");
        }
        el.style.transform = `translateX(${dx}px)`;
        to = rects.findIndex((r) => e.clientX < r.left + r.width / 2);
        if (to === -1) to = rects.length - 1;
        else if (to > from) to -= 1;
        els.forEach((x, k) => {
          x.classList.toggle("tab-drop-before", k === to && to < from);
          x.classList.toggle("tab-drop-after", k === to && to > from);
        });
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
        if (!active) return;
        document.body.classList.remove("is-dragging");
        const block = (c: Event) => (c.stopPropagation(), c.preventDefault());
        window.addEventListener("click", block, true);
        setTimeout(() => window.removeEventListener("click", block, true), 0);
        if (to !== from && to >= 0) {
          const [moved] = this.tabs.splice(from, 1);
          this.tabs.splice(to, 0, moved);
        }
        this.renderTabs();
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    });
  }

  renderTabs() {
    this.tabbar.replaceChildren(
      ...this.tabs.map((t) => {
        const panes = panesOf(t.root);
        const status: PaneStatus = panes.some((p) => p.status === "connected")
          ? "connected"
          : panes.some((p) => p.status === "connecting")
            ? "connecting"
            : "closed";
        const cmdState = this.settings?.tabStatus ? aggregate(panes.map((p) => p.cmd?.state ?? "idle")) : null;
        const shown = cmdState && cmdState !== "closed" && status !== "closed" ? `cmd-${cmdState}` : status;
        const detail = panes.map((p) => p.cmd?.detail).find(Boolean);
        const dotTitle =
          shown === "cmd-running" ? "Command running" : shown === "cmd-success" ? `Success: ${detail ?? ""}` : shown === "cmd-error" ? `Failure: ${detail ?? ""}` : status === "connected" ? "Connected" : status === "connecting" ? "Connecting" : "Closed";
        const base = t.customTitle ?? ((this.settings?.programTitles && t.focused.programTitle) || t.focused.title);
        const label = base + (panes.length > 1 ? ` (${panes.length})` : "");
        const el = h(
          "div",
          { class: `tab${t === this.active && !this.activePage ? " active" : ""}${t.bell ? " tab-bell" : ""}`, title: label, onclick: () => this.activate(t) },
          h("span", { class: `dot ${shown}`, title: dotTitle }),
          h("span", { class: "tab-title" }, label),
          panes.some((p) => p.logPath) ? h("span", { class: "tab-rec", title: "Logging to a file" }, "REC") : null,
          h("button", {
            class: "tab-close",
            title: "Close tab",
            onclick: (e: Event) => {
              e.stopPropagation();
              void this.closeTab(t);
            },
          }, icon("x", 13)),
        );
        el.addEventListener("auxclick", (e) => {
          if ((e as MouseEvent).button === 1 && this.settings?.middleClickClose !== false) void this.closeTab(t);
        });
        el.addEventListener("contextmenu", (e) => this.tabMenu(t, e));
        this.bindTabDrag(el);
        t.tabEl = el;
        return el;
      }),
      ...this.pages.map((p) => {
        const el = h(
          "div",
          { class: `tab page-tab${p === this.activePage ? " active" : ""}`, title: p.title, "data-page-tab": p.id, onclick: () => this.activatePage(p) },
          icon(p.icon, 14),
          h("span", { class: "tab-title" }, p.title),
          h("button", { class: "tab-close", title: `Close ${p.title}`, onclick: (e: Event) => (e.stopPropagation(), this.closePage(p)) }, icon("x", 13)),
        );
        el.addEventListener("auxclick", (e) => (e as MouseEvent).button === 1 && this.closePage(p));
        el.addEventListener("contextmenu", (e) => showMenu(e, [{ label: `Close ${p.title}`, action: () => this.closePage(p) }]));
        return el;
      }),
    );
    this.refreshSlots();
  }
}

/** Local date and time for file names: 2026-11-24_14-05-09. */
function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

/** A link in terminal output was clicked: show it as text, offer to copy. */
function showLink(uri: string) {
  return modal<void>("Link in terminal output", (close) => ({
    body: h(
      "div",
      { class: "form" },
      h("p", {}, "The program or server printed this link. Siakap doesn't open web pages; copy it if you want to visit it in your browser."),
      h("p", { class: "mono link-text" }, uri.length > 2000 ? uri.slice(0, 2000) + "..." : uri),
    ),
    actions: [
      h("button", { onclick: () => close() }, "Close"),
      h("button", { class: "primary", onclick: () => (api.clipboardWrite(uri).catch(() => {}), toast("Link copied.", "ok", 1500), close()) }, "Copy link"),
    ],
  }));
}

export async function chooseShell(): Promise<{ id: string; label: string } | null> {
  const shells = await api.shellsList();
  if (!shells.length) {
    await alertDialog("No shells", "No local shell was found.");
    return null;
  }
  return shells[0];
}
